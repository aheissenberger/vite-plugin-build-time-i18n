import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { buildTimeI18nPlugin } from "./index.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Severity = "error" | "warning";

type Diagnostic = {
  severity: Severity;
  code: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type LocaleData = {
  locale: string;
  filePath: string;
  messages: Map<string, string>;
};

type CliOptions = {
  localesDir?: string;
  srcDir: string;
  functionName: string;
  allowMissingLocales: boolean;
};

const DEFAULT_FUNCTION_NAME = "t";
const SUPPORTED_CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isTestLikeFile(fileName: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const diagnostics: Diagnostic[] = [];

  const localesDir = resolveLocalesDir(options.localesDir);
  if (!localesDir) {
    if (!options.allowMissingLocales) {
      diagnostics.push({
        severity: "warning",
        code: "LOCALES_DIR_NOT_FOUND",
        message:
          "Could not find locales directory. Checked ./locales and ./i18n/locales. Locale-level checks were skipped.",
      });
    }
    validateSourceCalls(options.srcDir, options.functionName, diagnostics);
    printDiagnosticsAndExit(diagnostics);
    return;
  }

  const localeFiles = readLocaleFiles(localesDir, diagnostics);
  const localeData = localeFiles
    .map((filePath) => parseLocaleFile(filePath, diagnostics))
    .filter((entry): entry is LocaleData => entry !== undefined);

  validateLocalePrecompilation(localesDir, localeData, diagnostics);
  validateLocaleKeyParity(localeData, diagnostics);
  validatePlaceholderParity(localeData, diagnostics);

  validateSourceCalls(options.srcDir, options.functionName, diagnostics);

  printDiagnosticsAndExit(diagnostics);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    srcDir: path.resolve(process.cwd(), "src"),
    functionName: DEFAULT_FUNCTION_NAME,
    allowMissingLocales: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (!arg.startsWith("--")) {
      continue;
    }

    if (arg === "--locales-dir" && next) {
      options.localesDir = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (arg === "--src-dir" && next) {
      options.srcDir = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (arg === "--function-name" && next) {
      options.functionName = next;
      index += 1;
      continue;
    }

    if (arg === "--allow-missing-locales") {
      options.allowMissingLocales = true;
      continue;
    }
  }

  return options;
}

function resolveLocalesDir(explicitLocalesDir?: string): string | undefined {
  if (
    explicitLocalesDir &&
    fs.existsSync(explicitLocalesDir) &&
    fs.statSync(explicitLocalesDir).isDirectory()
  ) {
    return explicitLocalesDir;
  }

  const candidates = [
    path.resolve(process.cwd(), "locales"),
    path.resolve(process.cwd(), "i18n", "locales"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return undefined;
}

function readLocaleFiles(localesDir: string, diagnostics: Diagnostic[]): string[] {
  const entries = fs.readdirSync(localesDir, { withFileTypes: true });
  const localeFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(localesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  if (localeFiles.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "LOCALE_FILES_EMPTY",
      message: `No locale JSON files found in ${normalize(localesDir)}.`,
      filePath: localesDir,
    });
  }

  return localeFiles;
}

function parseLocaleFile(filePath: string, diagnostics: Diagnostic[]): LocaleData | undefined {
  const locale = path.basename(filePath, ".json");
  let data: JsonValue;

  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonValue;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "LOCALE_PARSE_ERROR",
      message: `Failed to parse JSON: ${formatError(error)}`,
      filePath,
    });
    return undefined;
  }

  if (!isJsonObject(data)) {
    diagnostics.push({
      severity: "error",
      code: "LOCALE_NOT_OBJECT",
      message: "Locale file must contain a top-level object.",
      filePath,
    });
    return undefined;
  }

  const flattened = new Map<string, string>();
  flattenMessages(data, "", flattened, diagnostics, filePath);

  return {
    locale,
    filePath,
    messages: flattened,
  };
}

function flattenMessages(
  input: JsonObject,
  prefix: string,
  output: Map<string, string>,
  diagnostics: Diagnostic[],
  filePath: string,
) {
  for (const [key, value] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "string") {
      output.set(nextKey, value);
      continue;
    }

    if (isJsonObject(value)) {
      flattenMessages(value, nextKey, output, diagnostics, filePath);
      continue;
    }

    diagnostics.push({
      severity: "error",
      code: "LOCALE_INVALID_LEAF",
      message: `Invalid value type for key '${nextKey}'. Expected string or object, got ${typeof value}.`,
      filePath,
    });
  }
}

function validateLocalePrecompilation(
  localesDir: string,
  locales: LocaleData[],
  diagnostics: Diagnostic[],
) {
  for (const locale of locales) {
    try {
      const [plugin] = buildTimeI18nPlugin({ locale: locale.locale, localesDir });
      if (!plugin || typeof plugin.buildStart !== "function") {
        throw new Error("buildStart hook is not available");
      }

      Reflect.apply(
        plugin.buildStart as Function,
        {
          addWatchFile() {
            // no-op
          },
          info() {
            // no-op
          },
        },
        [],
      );
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "LOCALE_PRECOMPILE_ERROR",
        message: formatError(error),
        filePath: locale.filePath,
      });
    }
  }
}

function validateLocaleKeyParity(locales: LocaleData[], diagnostics: Diagnostic[]) {
  if (locales.length <= 1) {
    return;
  }

  const baseline = locales[0];
  if (!baseline) {
    return;
  }

  const baselineKeys = new Set(baseline.messages.keys());

  for (const locale of locales.slice(1)) {
    const currentKeys = new Set(locale.messages.keys());

    for (const key of baselineKeys) {
      if (!currentKeys.has(key)) {
        diagnostics.push({
          severity: "error",
          code: "LOCALE_KEY_MISSING",
          message: `Missing key '${key}' in locale '${locale.locale}'.`,
          filePath: locale.filePath,
        });
      }
    }

    for (const key of currentKeys) {
      if (!baselineKeys.has(key)) {
        diagnostics.push({
          severity: "warning",
          code: "LOCALE_EXTRA_KEY",
          message: `Extra key '${key}' in locale '${locale.locale}' not present in '${baseline.locale}'.`,
          filePath: locale.filePath,
        });
      }
    }
  }
}

function validatePlaceholderParity(locales: LocaleData[], diagnostics: Diagnostic[]) {
  if (locales.length <= 1) {
    return;
  }

  const baseline = locales[0];
  if (!baseline) {
    return;
  }

  for (const [key, baselineMessage] of baseline.messages.entries()) {
    const baselinePlaceholders = extractPlaceholderNames(baselineMessage);

    for (const locale of locales.slice(1)) {
      const localizedMessage = locale.messages.get(key);
      if (typeof localizedMessage !== "string") {
        continue;
      }

      const localizedPlaceholders = extractPlaceholderNames(localizedMessage);
      const base = sortSet(baselinePlaceholders);
      const current = sortSet(localizedPlaceholders);

      if (base.join("|") !== current.join("|")) {
        diagnostics.push({
          severity: "warning",
          code: "PLACEHOLDER_MISMATCH",
          message: `Placeholder mismatch for key '${key}'. Baseline '${baseline.locale}' has [${base.join(", ")}], locale '${locale.locale}' has [${current.join(", ")}].`,
          filePath: locale.filePath,
        });
      }
    }
  }
}

function extractPlaceholderNames(message: string): Set<string> {
  const placeholders = new Set<string>();
  collectPlaceholderNames(message, placeholders);
  return placeholders;
}

function collectPlaceholderNames(message: string, output: Set<string>) {
  let index = 0;

  while (index < message.length) {
    if (message[index] !== "{") {
      index += 1;
      continue;
    }

    const end = findMatchingBrace(message, index);
    if (end < 0) {
      index += 1;
      continue;
    }

    const inner = message.slice(index + 1, end).trim();
    const head = splitTopLevel(inner, ",").map((part) => part.trim());

    if (head.length > 0 && head[0]) {
      const name = head[0] ?? "";
      if (isPlaceholderName(name)) {
        output.add(name);
      }

      const kind = head[1];
      if (kind === "plural" || kind === "select") {
        const branchesPart = inner.slice(inner.indexOf(kind) + kind.length + 1);
        collectBranchPlaceholders(branchesPart, output);
      }
    }

    index = end + 1;
  }
}

function collectBranchPlaceholders(content: string, output: Set<string>) {
  let cursor = 0;

  while (cursor < content.length) {
    while (cursor < content.length && /\s/.test(content[cursor] ?? "")) {
      cursor += 1;
    }

    let keyEnd = cursor;
    while (keyEnd < content.length && !/\s|\{/.test(content[keyEnd] ?? "")) {
      keyEnd += 1;
    }

    if (keyEnd === cursor) {
      cursor += 1;
      continue;
    }

    cursor = keyEnd;
    while (cursor < content.length && /\s/.test(content[cursor] ?? "")) {
      cursor += 1;
    }

    if (content[cursor] !== "{") {
      continue;
    }

    const end = findMatchingBrace(content, cursor);
    if (end < 0) {
      break;
    }

    const branchMessage = content.slice(cursor + 1, end);
    collectPlaceholderNames(branchMessage, output);
    cursor = end + 1;
  }
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === separator && depth === 0) {
      result.push(value.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }

  result.push(value.slice(segmentStart));
  return result;
}

function findMatchingBrace(value: string, openIndex: number): number {
  let depth = 0;

  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function validateSourceCalls(srcDir: string, functionName: string, diagnostics: Diagnostic[]) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    diagnostics.push({
      severity: "warning",
      code: "SRC_DIR_NOT_FOUND",
      message: `Source directory ${normalize(srcDir)} was not found. Skipping call-site checks.`,
      filePath: srcDir,
    });
    return;
  }

  const files = collectCodeFiles(srcDir);

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }

      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === functionName) {
        const firstArg = node.arguments[0];
        if (!firstArg) {
          return;
        }

        const isStaticLiteral =
          ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg);

        if (!isStaticLiteral) {
          pushNodeDiagnostic(
            diagnostics,
            sourceFile,
            firstArg,
            "error",
            "DYNAMIC_TRANSLATION_KEY",
            `Dynamic key in ${functionName}(...) cannot be precompiled. Use a string literal key.`,
          );
        }

        return;
      }

      if (ts.isPropertyAccessExpression(expression) && expression.name.text === functionName) {
        pushNodeDiagnostic(
          diagnostics,
          sourceFile,
          expression,
          "warning",
          "MEMBER_TRANSLATION_CALL",
          `Call shape '${expression.getText(sourceFile)}(...)' is not rewritten by this plugin; use direct ${functionName}(...) calls.`,
        );
      }

      if (ts.isElementAccessExpression(expression)) {
        const argumentExpression = expression.argumentExpression;
        if (
          argumentExpression &&
          ts.isStringLiteral(argumentExpression) &&
          argumentExpression.text === functionName
        ) {
          pushNodeDiagnostic(
            diagnostics,
            sourceFile,
            expression,
            "warning",
            "ELEMENT_TRANSLATION_CALL",
            `Computed translation calls are not rewritten by this plugin; use direct ${functionName}(...) calls.`,
          );
        }
      }
    });
  }
}

function collectCodeFiles(rootDir: string): string[] {
  const files: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile() && SUPPORTED_CODE_EXTENSIONS.has(path.extname(entry.name))) {
        if (isTestLikeFile(entry.name)) {
          continue;
        }

        files.push(entryPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function pushNodeDiagnostic(
  diagnostics: Diagnostic[],
  sourceFile: ts.SourceFile,
  node: ts.Node,
  severity: Severity,
  code: string,
  message: string,
) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));

  diagnostics.push({
    severity,
    code,
    message,
    filePath: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlaceholderName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function sortSet(values: Set<string>): string[] {
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalize(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

function printDiagnosticsAndExit(diagnostics: Diagnostic[]) {
  const errors = diagnostics.filter((item) => item.severity === "error");
  const warnings = diagnostics.filter((item) => item.severity === "warning");

  const ordered = [...errors, ...warnings];
  for (const diagnostic of ordered) {
    const location = formatLocation(diagnostic);
    const prefix = diagnostic.severity === "error" ? "ERROR" : "WARN";
    console.error(
      `[build-time-i18n:validate] ${prefix} ${diagnostic.code}${location} ${diagnostic.message}`,
    );
  }

  if (ordered.length === 0) {
    console.log("[build-time-i18n:validate] OK no issues found.");
  } else {
    console.log(
      `[build-time-i18n:validate] completed with ${errors.length} error(s) and ${warnings.length} warning(s).`,
    );
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

function formatLocation(diagnostic: Diagnostic): string {
  if (!diagnostic.filePath) {
    return "";
  }

  const location = normalize(path.relative(process.cwd(), diagnostic.filePath));
  if (diagnostic.line && diagnostic.column) {
    return ` [${location}:${diagnostic.line}:${diagnostic.column}]`;
  }

  return ` [${location}]`;
}

main();
