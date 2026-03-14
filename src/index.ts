import fs from "node:fs";
import path from "node:path";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";

const VIRTUAL_HELPER_ID = "virtual:build-time-i18n-helper";
const RESOLVED_VIRTUAL_HELPER_ID = `\0${VIRTUAL_HELPER_ID}`;
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCALES_DIR = path.resolve(PLUGIN_DIR, "..", "i18n", "locales");

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type BuildTimeI18nPluginOptions = {
  locale: string;
  localesDir?: string;
  include?: RegExp;
  functionName?: string;
  strictMissing?: boolean;
  failOnDynamicKeys?: boolean;
};

type CompiledCatalogEntry = {
  raw: string;
  compiled: CompiledMessage;
  serializedCompiled: string;
  needsFormatter: boolean;
};

type Replacement = {
  start: number;
  end: number;
  text: string;
};

type CompiledMessage = {
  type: "message";
  parts: CompiledPart[];
};

type CompiledPart =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "number"; name: string; style?: string }
  | { type: "date"; name: string; style?: string }
  | { type: "time"; name: string; style?: string }
  | { type: "pound" }
  | { type: "plural"; name: string; options: Record<string, CompiledMessage> }
  | { type: "select"; name: string; options: Record<string, CompiledMessage> };

type CallExpressionNode = {
  type: "CallExpression";
  start?: number;
  end?: number;
  callee?: unknown;
  arguments?: unknown[];
};

type LiteralNode = {
  type: "Literal";
  value?: unknown;
};

type IdentifierNode = {
  type: "Identifier";
  name?: string;
};

type ProgramNode = {
  type: "Program";
  body?: Array<{
    type?: string;
    start?: number;
    end?: number;
    directive?: string;
  }>;
};

type ParserLang = "js" | "jsx" | "ts" | "tsx" | "dts";

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?$/;

/*
 * Supported compile-time message subset:
 * - Variable: {name}
 * - Number: {value, number[, integer|percent|compact|currency:EUR]}
 * - Date: {value, date[, short|medium|long|full]}
 * - Time: {value, time[, short|medium|long|full]}
 * - Select: {status, select, key {...} other {...}}
 * - Plural: {count, plural, =0 {...} one {...} other {...}}
 *
 * Non-goals for this parser:
 * - Full ICU MessageFormat grammar support
 * - Dynamic key precompilation (non-literal t(arg0, ...))
 */

export function buildTimeI18nPlugin(options: BuildTimeI18nPluginOptions): Plugin[] {
  const include = options.include ?? DEFAULT_INCLUDE;
  const functionName = options.functionName ?? "t";
  const strictMissing = options.strictMissing ?? true;
  const failOnDynamicKeys = options.failOnDynamicKeys ?? true;

  let localeMap = new Map<string, string>();
  let compiledCatalog = new Map<string, CompiledCatalogEntry>();
  let localeFilePath = "";
  const usedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  let dynamicCallCount = 0;
  let auditReported = false;

  return [
    {
      name: "vite-plugin-build-time-i18n",
      enforce: "pre",
      apply: "build",
      buildStart() {
        localeFilePath = resolveLocaleFilePath(options.locale, options.localesDir);
        this.addWatchFile(localeFilePath);
        usedKeys.clear();
        missingKeys.clear();
        dynamicCallCount = 0;
        auditReported = false;

        const catalog = readJsonFile(localeFilePath);
        localeMap = flattenSectionedMessages(catalog);
        compiledCatalog = precompileCatalog(localeMap);

        this.info(
          `[build-time-i18n] loaded ${localeMap.size} messages from ${normalizeForLog(localeFilePath)}`,
        );
      },
      resolveId: {
        filter: {
          id: /^virtual:build-time-i18n-helper$/,
        },
        handler(id: string) {
          if (id === VIRTUAL_HELPER_ID) {
            return RESOLVED_VIRTUAL_HELPER_ID;
          }
          return null;
        },
      },
      load: {
        handler(id: string) {
          if (id !== RESOLVED_VIRTUAL_HELPER_ID) {
            return null;
          }

          return {
            code: createInterpolationHelperSource(),
            map: null,
          };
        },
      },
      transform: {
        filter: {
          id: include,
        },
        handler(
          this: {
            parse: (source: string, options?: { lang?: ParserLang } | null) => unknown;
            warn: (message: string) => void;
            error: (message: string) => never;
          },
          code: string,
          id: string,
        ) {
          if (!mightContainTranslationCalls(code, functionName)) {
            return null;
          }

          const ast = this.parse(code, getParserOptionsForId(id));
          const analysis = analyzeTranslationCalls(ast, functionName);
          dynamicCallCount += analysis.dynamicCalls;

          if (analysis.dynamicCalls > 0) {
            const message = `[build-time-i18n] found ${analysis.dynamicCalls} dynamic translation call(s) in ${normalizeForLog(id)}. Use string literal keys for compile-time replacement.`;
            if (failOnDynamicKeys) {
              this.error(message);
            } else {
              this.warn(message);
            }
          }

          if (analysis.literalCallSites.length === 0) {
            return null;
          }

          const replacements: Replacement[] = [];
          let helperIsNeeded = false;

          for (const callSite of analysis.literalCallSites) {
            usedKeys.add(callSite.key);

            const replacement = buildCallReplacement({
              callSite,
              source: code,
              compiledCatalog,
              strictMissing,
              locale: options.locale,
            });

            if (replacement.missingKey) {
              missingKeys.add(replacement.missingKey);
            }

            replacements.push(replacement.replacement);
            helperIsNeeded ||= replacement.helperIsNeeded;
          }

          const magicString = new MagicString(code);
          applyReplacementsToMagicString(magicString, replacements);

          if (helperIsNeeded) {
            injectImportAfterDirectivePrologue(
              magicString,
              code,
              ast,
              `import { __i18nFormat } from "${VIRTUAL_HELPER_ID}";\n`,
            );
          }

          return {
            code: magicString.toString(),
            map: magicString.generateMap({
              source: id,
              includeContent: true,
              hires: true,
            }),
          };
        },
      },
      generateBundle() {
        const environmentName = (this as { environment?: { name?: string } }).environment?.name;
        if (environmentName && environmentName !== "client") {
          return;
        }

        if (auditReported) {
          return;
        }

        auditReported = true;

        if (missingKeys.size > 0) {
          const missing = [...missingKeys].sort();
          const message = `[build-time-i18n] missing translation keys for locale ${options.locale}: ${missing.join(", ")}`;
          this.warn(message);
        }

        const unusedKeys = [...localeMap.keys()].filter((key) => !usedKeys.has(key)).sort();
        if (unusedKeys.length > 0) {
          const preview = unusedKeys.slice(0, 10).join(", ");
          const suffix = unusedKeys.length > 10 ? ` (+${unusedKeys.length - 10} more)` : "";
          this.warn(
            `[build-time-i18n] ${unusedKeys.length} unused translation keys in ${normalizeForLog(localeFilePath)}: ${preview}${suffix}`,
          );
        }

        if (dynamicCallCount > 0) {
          this.warn(
            `[build-time-i18n] encountered ${dynamicCallCount} dynamic translation call(s) that cannot be precompiled.`,
          );
        }
      },
    },
  ];
}

type BuildCallReplacementInput = {
  callSite: { start: number; end: number; key: string; paramsArg?: { start: number; end: number } };
  source: string;
  compiledCatalog: Map<string, CompiledCatalogEntry>;
  strictMissing: boolean;
  locale: string;
};

function buildCallReplacement(input: BuildCallReplacementInput) {
  const entry = input.compiledCatalog.get(input.callSite.key);

  if (!entry) {
    if (input.strictMissing) {
      throw new Error(`Missing translation key: ${input.callSite.key}`);
    }

    return {
      missingKey: input.callSite.key,
      helperIsNeeded: false,
      replacement: {
        start: input.callSite.start,
        end: input.callSite.end,
        text: JSON.stringify(input.callSite.key),
      },
    };
  }

  if (!input.callSite.paramsArg && !entry.needsFormatter) {
    return {
      missingKey: undefined,
      helperIsNeeded: false,
      replacement: {
        start: input.callSite.start,
        end: input.callSite.end,
        text: JSON.stringify(entry.raw),
      },
    };
  }

  const paramsExpression = input.callSite.paramsArg
    ? input.source.slice(input.callSite.paramsArg.start, input.callSite.paramsArg.end)
    : "undefined";

  return {
    missingKey: undefined,
    helperIsNeeded: true,
    replacement: {
      start: input.callSite.start,
      end: input.callSite.end,
      text: `__i18nFormat(${entry.serializedCompiled}, ${paramsExpression}, ${JSON.stringify(input.locale)})`,
    },
  };
}

function applyReplacementsToMagicString(magicString: MagicString, replacements: Replacement[]) {
  const sorted = [...replacements].sort((left, right) => right.start - left.start);

  for (const replacement of sorted) {
    magicString.overwrite(replacement.start, replacement.end, replacement.text);
  }
}

function analyzeTranslationCalls(ast: unknown, functionName: string) {
  const literalCallSites: Array<{
    start: number;
    end: number;
    key: string;
    paramsArg?: { start: number; end: number };
  }> = [];
  let dynamicCalls = 0;

  walkAst(ast, (node) => {
    const callNode = node as Partial<CallExpressionNode>;

    if (callNode.type !== "CallExpression") {
      return;
    }

    const callStart = callNode.start;
    const callEnd = callNode.end;

    if (typeof callStart !== "number" || typeof callEnd !== "number") {
      return;
    }

    if (!isSupportedTranslationCallee(callNode.callee, functionName)) {
      return;
    }

    const args = Array.isArray(callNode.arguments) ? callNode.arguments : [];
    const firstArg = args[0] as Partial<LiteralNode> | undefined;

    if (!firstArg) {
      return;
    }

    if (!isStringLiteral(firstArg)) {
      dynamicCalls += 1;
      return;
    }

    const key = firstArg.value;
    const paramsArg = args[1] as { start?: number; end?: number } | undefined;

    const site: {
      start: number;
      end: number;
      key: string;
      paramsArg?: { start: number; end: number };
    } = {
      start: callStart,
      end: callEnd,
      key,
    };

    if (typeof paramsArg?.start === "number" && typeof paramsArg?.end === "number") {
      site.paramsArg = {
        start: paramsArg.start,
        end: paramsArg.end,
      };
    }

    literalCallSites.push(site);
  });

  return {
    literalCallSites,
    dynamicCalls,
  };
}

function isSupportedTranslationCallee(callee: unknown, functionName: string) {
  const identifier = callee as Partial<IdentifierNode>;
  return identifier.type === "Identifier" && identifier.name === functionName;
}

function isStringLiteral(
  node: Partial<LiteralNode> | undefined,
): node is LiteralNode & { value: string } {
  return node?.type === "Literal" && typeof node.value === "string";
}

function walkAst(node: unknown, visit: (value: unknown) => void) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visit);
    }
    return;
  }

  if (!isAstNode(node)) {
    return;
  }

  visit(node);

  for (const [key, value] of Object.entries(node)) {
    if (
      key === "type" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range" ||
      key === "raw" ||
      key === "name" ||
      key === "value" ||
      key === "operator" ||
      key === "kind" ||
      key === "directive" ||
      key === "sourceType"
    ) {
      continue;
    }

    walkAst(value, visit);
  }
}

function isAstNode(value: unknown): value is { type: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function precompileCatalog(catalog: Map<string, string>) {
  const compiled = new Map<string, CompiledCatalogEntry>();

  for (const [key, raw] of catalog.entries()) {
    const compiledMessage = compileMessage(raw, false, `key ${key}`);
    validateCompiledMessage(compiledMessage, key);
    compiled.set(key, {
      raw,
      compiled: compiledMessage,
      serializedCompiled: JSON.stringify(compiledMessage),
      needsFormatter: messageNeedsFormatter(compiledMessage),
    });
  }

  return compiled;
}

function injectImportAfterDirectivePrologue(
  magicString: MagicString,
  code: string,
  ast: unknown,
  importStatement: string,
) {
  if (hasHelperImport(ast, code, VIRTUAL_HELPER_ID)) {
    return;
  }

  const insertionIndex = findDirectiveAwareInsertionIndex(code, ast);
  magicString.appendLeft(insertionIndex, importStatement);
}

function hasHelperImport(ast: unknown, code: string, helperId: string): boolean {
  const program = ast as Partial<ProgramNode>;
  const body = Array.isArray(program.body) ? program.body : [];

  for (const node of body) {
    const importNode = node as {
      type?: string;
      source?: { type?: string; value?: unknown };
      specifiers?: Array<{
        type?: string;
        imported?: { type?: string; name?: string };
        local?: { type?: string; name?: string };
      }>;
      start?: number;
      end?: number;
    };
    if (importNode.type !== "ImportDeclaration") {
      continue;
    }

    const sourceValue = importNode.source?.value;
    if (typeof sourceValue !== "string" || sourceValue !== helperId) {
      continue;
    }

    const specifiers = Array.isArray(importNode.specifiers) ? importNode.specifiers : [];
    for (const specifier of specifiers) {
      if (specifier.local?.type === "Identifier" && specifier.local.name === "__i18nFormat") {
        return true;
      }
    }
  }

  return false;
}

function findDirectiveAwareInsertionIndex(code: string, ast: unknown): number {
  const program = ast as Partial<ProgramNode>;
  const body = Array.isArray(program.body) ? program.body : [];
  let insertionIndex = 0;

  for (const node of body) {
    if (node.type !== "ExpressionStatement" || typeof node.directive !== "string") {
      break;
    }

    if (typeof node.end === "number") {
      insertionIndex = node.end;
      continue;
    }

    break;
  }

  if (insertionIndex === 0) {
    return 0;
  }

  while (insertionIndex < code.length) {
    const char = code[insertionIndex];
    if (char !== "\n" && char !== "\r") {
      break;
    }
    insertionIndex += 1;
  }

  return insertionIndex;
}

function resolveLocaleFilePath(locale: string, localesDir: string | undefined) {
  const baseDir = localesDir ?? DEFAULT_LOCALES_DIR;
  return path.join(baseDir, `${locale}.json`);
}

function readJsonFile(filePath: string): JsonObject {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as JsonValue;

  if (!isJsonObject(data)) {
    throw new Error(`Expected top-level JSON object in ${normalizeForLog(filePath)}`);
  }

  return data;
}

function flattenSectionedMessages(
  input: JsonObject,
  prefix = "",
  out: Map<string, string> = new Map(),
): Map<string, string> {
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      out.set(nextKey, value);
      continue;
    }

    if (isJsonObject(value)) {
      flattenSectionedMessages(value, nextKey, out);
      continue;
    }

    throw new Error(
      `Invalid message value for key ${nextKey}. Expected string or object section, got ${typeof value}.`,
    );
  }

  return out;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mightContainTranslationCalls(source: string, functionName: string) {
  return source.includes(`${functionName}(`) || source.includes(`.${functionName}(`);
}

function getParserOptionsForId(id: string): { lang: ParserLang } {
  if (id.endsWith(".tsx")) {
    return { lang: "tsx" };
  }

  if (id.endsWith(".ts")) {
    return { lang: "ts" };
  }

  if (id.endsWith(".jsx")) {
    return { lang: "jsx" };
  }

  return { lang: "js" };
}

function normalizeForLog(inputPath: string) {
  return inputPath.split(path.sep).join("/");
}

function createInterpolationHelperSource() {
  return `
const __i18nPluralRulesCache = new Map();
const __i18nNumberFormatCache = new Map();
const __i18nDateTimeFormatCache = new Map();

export function __i18nFormat(compiledMessage, values, locale) {
  return formatMessage(compiledMessage, values, locale || "en", undefined);
}

function formatMessage(compiledMessage, values, locale, pluralCount) {
  if (!compiledMessage || !Array.isArray(compiledMessage.parts)) {
    return "";
  }

  let output = "";
  for (const part of compiledMessage.parts) {
    if (part.type === "text") {
      output += part.value;
      continue;
    }

    if (part.type === "var") {
      const value = readPath(values, part.name);
      output += value == null ? "" : String(value);
      continue;
    }

    if (part.type === "number") {
      const value = readPath(values, part.name);
      output += formatNumber(value, locale, part.style);
      continue;
    }

    if (part.type === "date") {
      const value = readPath(values, part.name);
      output += formatDate(value, locale, part.style);
      continue;
    }

    if (part.type === "time") {
      const value = readPath(values, part.name);
      output += formatTime(value, locale, part.style);
      continue;
    }

    if (part.type === "pound") {
      output += pluralCount == null ? "#" : String(pluralCount);
      continue;
    }

    if (part.type === "select") {
      const raw = readPath(values, part.name);
      const key = raw == null ? "other" : String(raw);
      const selected = part.options[key] ?? part.options.other;
      output += selected ? formatMessage(selected, values, locale, pluralCount) : "";
      continue;
    }

    if (part.type === "plural") {
      const raw = readPath(values, part.name);
      const count = Number(raw);
      const explicitKey = Number.isFinite(count) ? "=" + String(count) : "";
      const optionKey = explicitKey && part.options[explicitKey] ? explicitKey : getPluralCategory(count, locale);
      const selected = part.options[optionKey] ?? part.options.other;
      output += selected
        ? formatMessage(selected, values, locale, Number.isFinite(count) ? count : 0)
        : "";
    }
  }

  return output;
}

function readPath(values, dotPath) {
  const segments = String(dotPath).split(".");
  let current = values;

  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function getPluralCategory(count, locale) {
  if (!Number.isFinite(count)) {
    return "other";
  }

  const key = locale;
  let pluralRules = __i18nPluralRulesCache.get(key);
  if (!pluralRules) {
    pluralRules = new Intl.PluralRules(locale, { type: "cardinal" });
    __i18nPluralRulesCache.set(key, pluralRules);
  }

  return pluralRules.select(count);
}

function formatNumber(value, locale, style) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value == null ? "" : String(value);
  }

  const key = locale + "|number|" + String(style || "default");
  let formatter = __i18nNumberFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, toNumberFormatOptions(style));
    __i18nNumberFormatCache.set(key, formatter);
  }

  return formatter.format(numeric);
}

function formatDate(value, locale, style) {
  const date = toDate(value);
  if (!date) {
    return value == null ? "" : String(value);
  }

  const finalStyle = normalizeDateTimeStyle(style);
  const key = locale + "|date|" + finalStyle;
  let formatter = __i18nDateTimeFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: finalStyle });
    __i18nDateTimeFormatCache.set(key, formatter);
  }

  return formatter.format(date);
}

function formatTime(value, locale, style) {
  const date = toDate(value);
  if (!date) {
    return value == null ? "" : String(value);
  }

  const finalStyle = normalizeDateTimeStyle(style);
  const key = locale + "|time|" + finalStyle;
  let formatter = __i18nDateTimeFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { timeStyle: finalStyle });
    __i18nDateTimeFormatCache.set(key, formatter);
  }

  return formatter.format(date);
}

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" || typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function toNumberFormatOptions(style) {
  if (style === "integer") {
    return { maximumFractionDigits: 0 };
  }

  if (style === "percent") {
    return { style: "percent" };
  }

  if (style && style.startsWith("currency:")) {
    const currency = style.slice("currency:".length).toUpperCase();
    return { style: "currency", currency };
  }

  if (style === "compact") {
    return { notation: "compact" };
  }

  return {};
}

function normalizeDateTimeStyle(style) {
  if (style === "full" || style === "long" || style === "medium" || style === "short") {
    return style;
  }

  return "medium";
}
`;
}

function messageNeedsFormatter(compiledMessage: CompiledMessage): boolean {
  return compiledMessage.parts.some((part) => part.type !== "text");
}

function compileMessage(
  input: string,
  allowPound = false,
  contextLabel = "message",
): CompiledMessage {
  const parts: CompiledPart[] = [];
  let cursor = 0;
  let textBuffer = "";

  const flushText = () => {
    if (!textBuffer) {
      return;
    }
    parts.push({ type: "text", value: textBuffer });
    textBuffer = "";
  };

  while (cursor < input.length) {
    const char = input[cursor];

    if (char === "#" && allowPound) {
      flushText();
      parts.push({ type: "pound" });
      cursor += 1;
      continue;
    }

    if (char !== "{") {
      textBuffer += char;
      cursor += 1;
      continue;
    }

    const end = findMatchingBrace(input, cursor);
    if (end < 0) {
      textBuffer += char;
      cursor += 1;
      continue;
    }

    const inside = input.slice(cursor + 1, end);
    const placeholder = parsePlaceholder(inside, contextLabel);
    if (!placeholder) {
      textBuffer += input.slice(cursor, end + 1);
      cursor = end + 1;
      continue;
    }

    flushText();
    parts.push(placeholder);
    cursor = end + 1;
  }

  flushText();
  return { type: "message", parts };
}

function parsePlaceholder(input: string, contextLabel: string): CompiledPart | null {
  const firstComma = input.indexOf(",");
  if (firstComma < 0) {
    const name = input.trim();
    return name ? { type: "var", name } : null;
  }

  const name = input.slice(0, firstComma).trim();
  const rest = input.slice(firstComma + 1).trim();
  if (!name || !rest) {
    return null;
  }

  if (rest.startsWith("plural,")) {
    const options = parseControlOptions(
      rest.slice("plural,".length),
      `${contextLabel} plural ${name}`,
    );
    return { type: "plural", name, options };
  }

  if (rest.startsWith("select,")) {
    const options = parseControlOptions(
      rest.slice("select,".length),
      `${contextLabel} select ${name}`,
    );
    return { type: "select", name, options };
  }

  if (rest.startsWith("number")) {
    const style = parseSimpleStyle(rest, "number", contextLabel);
    return { type: "number", name, style };
  }

  if (rest.startsWith("date")) {
    const style = parseSimpleStyle(rest, "date", contextLabel);
    return { type: "date", name, style };
  }

  if (rest.startsWith("time")) {
    const style = parseSimpleStyle(rest, "time", contextLabel);
    return { type: "time", name, style };
  }

  return null;
}

function parseSimpleStyle(input: string, kind: "number" | "date" | "time", contextLabel: string) {
  if (input === kind) {
    return undefined;
  }

  if (input.startsWith(`${kind},`)) {
    const raw = input.slice(kind.length + 1).trim();
    validateSimpleStyle(kind, raw, contextLabel);
    return raw || undefined;
  }

  return undefined;
}

function parseControlOptions(input: string, contextLabel: string): Record<string, CompiledMessage> {
  const options: Record<string, CompiledMessage> = {};
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
      cursor += 1;
    }

    if (cursor >= input.length) {
      break;
    }

    let key = "";
    while (cursor < input.length) {
      const char = input[cursor] ?? "";
      if (char === "{" || /\s/.test(char)) {
        break;
      }
      key += char;
      cursor += 1;
    }

    while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
      cursor += 1;
    }

    if (!key || input[cursor] !== "{") {
      break;
    }

    const end = findMatchingBrace(input, cursor);
    if (end < 0) {
      break;
    }

    const messageValue = input.slice(cursor + 1, end);
    options[key] = compileMessage(messageValue, true, `${contextLabel} option ${key}`);
    cursor = end + 1;
  }

  return options;
}

function validateCompiledMessage(message: CompiledMessage, key: string) {
  for (const part of message.parts) {
    if (part.type === "plural" || part.type === "select") {
      if (!part.options.other) {
        throw new Error(`Invalid ICU message for key ${key}: missing required 'other' option.`);
      }

      for (const option of Object.values(part.options)) {
        validateCompiledMessage(option, key);
      }
    }
  }
}

function validateSimpleStyle(kind: "number" | "date" | "time", raw: string, contextLabel: string) {
  if (!raw) {
    return;
  }

  if (kind === "number") {
    if (
      raw === "integer" ||
      raw === "percent" ||
      raw === "compact" ||
      /^currency:[A-Za-z]{3}$/.test(raw)
    ) {
      return;
    }

    throw new Error(
      `Invalid number style '${raw}' in ${contextLabel}. Allowed: integer, percent, compact, currency:EUR.`,
    );
  }

  if (raw === "full" || raw === "long" || raw === "medium" || raw === "short") {
    return;
  }

  throw new Error(
    `Invalid ${kind} style '${raw}' in ${contextLabel}. Allowed: full, long, medium, short.`,
  );
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index];
    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return -1;
}
