import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTimeI18nPlugin } from "./index.ts";

function runBuildStart(buildStart: Function, context: object): void {
  Reflect.apply(buildStart, context, []);
}

function createLocalesDir(messages: object): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-plugin-"));
  fs.writeFileSync(path.join(fixtureDir, "de.json"), JSON.stringify(messages), "utf8");
  return fixtureDir;
}

describe("vite-plugin-build-time-i18n internals", () => {
  it("validates ICU plural blocks include other option during buildStart", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-plugin-"));
    fs.writeFileSync(
      path.join(fixtureDir, "de.json"),
      JSON.stringify({ app: { badPlural: "{count, plural, one {# item}}" } }),
      "utf8",
    );

    const [plugin] = buildTimeI18nPlugin({ locale: "de", localesDir: fixtureDir });
    const buildStart = plugin?.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    expect(() =>
      runBuildStart(buildStart, {
        addWatchFile() {
          // noop
        },
        info() {
          // noop
        },
      }),
    ).toThrowError(/missing required 'other' option/i);
  });

  it("validates unsupported number style during buildStart", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-plugin-"));
    fs.writeFileSync(
      path.join(fixtureDir, "de.json"),
      JSON.stringify({ app: { badNumber: "{amount, number, scientific}" } }),
      "utf8",
    );

    const [plugin] = buildTimeI18nPlugin({ locale: "de", localesDir: fixtureDir });
    const buildStart = plugin?.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    expect(() =>
      runBuildStart(buildStart, {
        addWatchFile() {
          // noop
        },
        info() {
          // noop
        },
      }),
    ).toThrowError(/invalid number style/i);
  });

  it("returns key fallback for missing translation in non-strict mode", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-plugin-"));
    fs.writeFileSync(
      path.join(fixtureDir, "de.json"),
      JSON.stringify({ app: { known: "Known" } }),
      "utf8",
    );

    const [plugin] = buildTimeI18nPlugin({
      locale: "de",
      localesDir: fixtureDir,
      strictMissing: false,
      failOnDynamicKeys: false,
    });
    if (!plugin) {
      throw new Error("Plugin instance is required for test");
    }

    const buildStart = plugin.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    const transformHook = plugin.transform;
    if (
      !transformHook ||
      typeof transformHook !== "object" ||
      typeof transformHook.handler !== "function"
    ) {
      throw new Error("transform handler hook is required for test");
    }

    runBuildStart(buildStart, {
      addWatchFile() {
        // noop
      },
      info() {
        // noop
      },
    });

    const source = `const message = t("app.unknown");\n`;
    const callStart = source.indexOf('t("app.unknown")');
    const callEnd = callStart + 't("app.unknown")'.length;

    const transformed = transformHook.handler.call(
      {
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: callStart,
                  end: callEnd,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [{ type: "Literal", value: "app.unknown" }],
                },
              },
            ],
          };
        },
        warn() {
          // noop
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      source,
      "src/example.ts",
    ) as { code: string } | null;

    expect(transformed?.code.trim()).toBe('const message = "app.unknown";');
  });

  it("rewrites translation calls via plugin hooks and preserves directive prologue", () => {
    const fixtureDir = createLocalesDir({
      app: {
        page: {
          priorityCount: "{count, plural, one {# Prioritaet} other {# Prioritaeten}}",
        },
      },
    });

    const [plugin] = buildTimeI18nPlugin({ locale: "de", localesDir: fixtureDir });
    if (!plugin) {
      throw new Error("Plugin instance is required for test");
    }

    const buildStart = plugin.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    const transformHook = plugin.transform;
    if (
      !transformHook ||
      typeof transformHook !== "object" ||
      typeof transformHook.handler !== "function"
    ) {
      throw new Error("transform handler hook is required for test");
    }

    const watchedFiles: string[] = [];
    const buildContext = {
      addWatchFile(filePath: string) {
        watchedFiles.push(filePath);
      },
      info(_message: string) {
        // Intentionally ignored in tests.
      },
    };

    runBuildStart(buildStart, buildContext);
    expect(watchedFiles.length).toBe(1);

    const source = `"use client";\nconst message = t("app.page.priorityCount", { count: 2 });\n`;
    const directiveEnd = source.indexOf("\n");
    const callStart = source.indexOf('t("app.page.priorityCount", { count: 2 })');
    const callEnd = callStart + 't("app.page.priorityCount", { count: 2 })'.length;
    const paramsStart = source.indexOf("{ count: 2 }");
    const paramsEnd = paramsStart + "{ count: 2 }".length;

    const ast = {
      type: "Program",
      body: [
        {
          type: "ExpressionStatement",
          start: 0,
          end: directiveEnd,
          directive: "use client",
          expression: {
            type: "Literal",
            value: "use client",
          },
        },
        {
          type: "ExpressionStatement",
          expression: {
            type: "CallExpression",
            start: callStart,
            end: callEnd,
            callee: {
              type: "Identifier",
              name: "t",
            },
            arguments: [
              {
                type: "Literal",
                value: "app.page.priorityCount",
              },
              {
                type: "ObjectExpression",
                start: paramsStart,
                end: paramsEnd,
              },
            ],
          },
        },
      ],
    };

    const transformContext = {
      parse() {
        return ast;
      },
      warn(_message: string) {
        // Intentionally ignored in tests.
      },
    };

    const transformed = transformHook.handler.call(
      transformContext as any,
      source,
      "src/example.tsx",
    ) as { code: string } | null;

    expect(transformed).not.toBeNull();
    expect(/^[\s\n]*["']use client["'];/.test(transformed?.code ?? "")).toBe(true);
    expect(transformed?.code.includes("__i18nFormat(")).toBe(true);
    expect(transformed?.code.includes("{ count: 2 }")).toBe(true);
    expect(transformed?.code.includes('"de"')).toBe(true);
  });

  it("does not rewrite member expression calls like i18n.t(...)", () => {
    const fixtureDir = createLocalesDir({
      app: {
        route: {
          modeLabel: "Routenmodus",
        },
      },
    });

    const [plugin] = buildTimeI18nPlugin({ locale: "de", localesDir: fixtureDir });
    if (!plugin) {
      throw new Error("Plugin instance is required for test");
    }

    const buildStart = plugin.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    const transformHook = plugin.transform;
    if (
      !transformHook ||
      typeof transformHook !== "object" ||
      typeof transformHook.handler !== "function"
    ) {
      throw new Error("transform handler hook is required for test");
    }

    runBuildStart(buildStart, {
      addWatchFile() {
        // noop
      },
      info() {
        // noop
      },
    });

    const source = `const message = i18n.t("app.route.modeLabel");\n`;
    const callStart = source.indexOf('i18n.t("app.route.modeLabel")');
    const callEnd = callStart + 'i18n.t("app.route.modeLabel")'.length;

    const transformed = transformHook.handler.call(
      {
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: callStart,
                  end: callEnd,
                  callee: {
                    type: "MemberExpression",
                    object: { type: "Identifier", name: "i18n" },
                    property: { type: "Identifier", name: "t" },
                    computed: false,
                  },
                  arguments: [{ type: "Literal", value: "app.route.modeLabel" }],
                },
              },
            ],
          };
        },
        warn() {
          // noop
        },
      } as any,
      source,
      "src/example.ts",
    ) as { code: string } | null;

    expect(transformed).toBeNull();
  });

  it("does not inject duplicate helper import when already present", () => {
    const fixtureDir = createLocalesDir({
      app: {
        page: {
          priorityCount: "{count, plural, one {# Prioritaet} other {# Prioritaeten}}",
        },
      },
    });

    const [plugin] = buildTimeI18nPlugin({ locale: "de", localesDir: fixtureDir });
    if (!plugin) {
      throw new Error("Plugin instance is required for test");
    }

    const buildStart = plugin.buildStart;
    if (typeof buildStart !== "function") {
      throw new Error("buildStart hook is required for test");
    }

    const transformHook = plugin.transform;
    if (
      !transformHook ||
      typeof transformHook !== "object" ||
      typeof transformHook.handler !== "function"
    ) {
      throw new Error("transform handler hook is required for test");
    }

    runBuildStart(buildStart, {
      addWatchFile() {
        // noop
      },
      info() {
        // noop
      },
    });

    const source =
      'import { __i18nFormat } from "virtual:build-time-i18n-helper";\nconst message = t("app.page.priorityCount", { count: 2 });\n';
    const callStart = source.indexOf('t("app.page.priorityCount", { count: 2 })');
    const callEnd = callStart + 't("app.page.priorityCount", { count: 2 })'.length;
    const paramsStart = source.indexOf("{ count: 2 }");
    const paramsEnd = paramsStart + "{ count: 2 }".length;

    const transformed = transformHook.handler.call(
      {
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ImportDeclaration",
                start: 0,
                end: source.indexOf("\n"),
                source: { type: "Literal", value: "virtual:build-time-i18n-helper" },
                specifiers: [
                  {
                    type: "ImportSpecifier",
                    imported: { type: "Identifier", name: "__i18nFormat" },
                    local: { type: "Identifier", name: "__i18nFormat" },
                  },
                ],
              },
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: callStart,
                  end: callEnd,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [
                    { type: "Literal", value: "app.page.priorityCount" },
                    { type: "ObjectExpression", start: paramsStart, end: paramsEnd },
                  ],
                },
              },
            ],
          };
        },
        warn() {
          // noop
        },
      } as any,
      source,
      "src/example.ts",
    ) as { code: string } | null;

    expect(transformed).not.toBeNull();
    const helperImportMatches =
      transformed?.code.match(/virtual:build-time-i18n-helper/g)?.length ?? 0;
    expect(helperImportMatches).toBe(1);
  });
});
