import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildTimeI18nPlugin } from "./index.ts";

function createLocalesDir(messages: object | string): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-coverage-"));
  const content = typeof messages === "string" ? messages : JSON.stringify(messages);
  fs.writeFileSync(path.join(fixtureDir, "de.json"), content, "utf8");
  return fixtureDir;
}

function getPlugin(options: Parameters<typeof buildTimeI18nPlugin>[0]) {
  const [plugin] = buildTimeI18nPlugin(options);
  if (!plugin) {
    throw new Error("Plugin instance is required for test");
  }
  return plugin;
}

function getBuildStart(plugin: ReturnType<typeof getPlugin>) {
  if (typeof plugin.buildStart !== "function") {
    throw new Error("buildStart hook is required for test");
  }
  return plugin.buildStart;
}

function getGenerateBundle(plugin: ReturnType<typeof getPlugin>) {
  if (typeof plugin.generateBundle !== "function") {
    throw new Error("generateBundle hook is required for test");
  }
  return plugin.generateBundle;
}

function getTransformHandler(plugin: ReturnType<typeof getPlugin>) {
  const transformHook = plugin.transform;
  if (
    !transformHook ||
    typeof transformHook !== "object" ||
    typeof transformHook.handler !== "function"
  ) {
    throw new Error("transform handler hook is required for test");
  }
  return transformHook.handler;
}

function getResolveIdHandler(plugin: ReturnType<typeof getPlugin>) {
  const resolveIdHook = plugin.resolveId;
  if (
    !resolveIdHook ||
    typeof resolveIdHook !== "object" ||
    typeof resolveIdHook.handler !== "function"
  ) {
    throw new Error("resolveId handler hook is required for test");
  }
  return resolveIdHook.handler;
}

function getLoadHandler(plugin: ReturnType<typeof getPlugin>) {
  const loadHook = plugin.load;
  if (!loadHook || typeof loadHook !== "object" || typeof loadHook.handler !== "function") {
    throw new Error("load handler hook is required for test");
  }
  return loadHook.handler;
}

function runBuildStart(buildStart: Function, context: object): void {
  Reflect.apply(buildStart, context, []);
}

function runResolveId(resolveId: Function, source: string) {
  return Reflect.apply(resolveId, {}, [source, undefined, {}]);
}

function runLoad(load: Function, id: string) {
  return Reflect.apply(load, {}, [id]);
}

function runGenerateBundle(generateBundle: Function, context: object) {
  Reflect.apply(generateBundle, context, [{}, {}, false]);
}

function createBuildContext() {
  return {
    watchedFiles: [] as string[],
    infos: [] as string[],
    warnings: [] as string[],
    addWatchFile(filePath: string) {
      this.watchedFiles.push(filePath);
    },
    info(message: string) {
      this.infos.push(message);
    },
    warn(message: string) {
      this.warnings.push(message);
    },
    error(message: string) {
      throw new Error(message);
    },
  };
}

async function loadHelperFormatter() {
  const plugin = getPlugin({ locale: "de" });
  const resolveId = getResolveIdHandler(plugin);
  const load = getLoadHandler(plugin);
  const resolved = runResolveId(resolveId, "virtual:build-time-i18n-helper");

  if (typeof resolved !== "string") {
    throw new Error("Expected virtual helper id to resolve to a string");
  }

  const loaded = runLoad(load, resolved);
  const code = typeof loaded === "string" ? loaded : loaded?.code;
  if (typeof code !== "string") {
    throw new Error("Expected virtual helper module source");
  }

  const encoded = Buffer.from(code, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  return module.__i18nFormat as (
    compiledMessage: unknown,
    values: Record<string, unknown> | undefined,
    locale: string,
  ) => string;
}

function createLiteralAst(source: string, expression: Record<string, unknown>) {
  return {
    type: "Program",
    body: [
      {
        type: "ExpressionStatement",
        expression,
      },
    ],
  };
}

describe("vite-plugin-build-time-i18n coverage", () => {
  it("resolves and loads the virtual helper module", () => {
    const plugin = getPlugin({ locale: "de" });
    const resolveId = getResolveIdHandler(plugin);
    const load = getLoadHandler(plugin);

    expect(runResolveId(resolveId, "virtual:build-time-i18n-helper")).toBe(
      "\0virtual:build-time-i18n-helper",
    );
    expect(runResolveId(resolveId, "virtual:other")).toBeNull();
    expect(runLoad(load, "virtual:other")).toBeNull();
    expect(runLoad(load, "\0virtual:build-time-i18n-helper")).toMatchObject({
      code: expect.stringContaining("export function __i18nFormat"),
    });
  });

  it("formats helper output across runtime branches", async () => {
    const format = await loadHelperFormatter();

    expect(
      format(
        {
          type: "message",
          parts: [
            { type: "text", value: "Hello " },
            { type: "var", name: "user.name" },
          ],
        },
        { user: { name: "Ada" } },
        "en",
      ),
    ).toBe("Hello Ada");

    expect(
      format(
        {
          type: "message",
          parts: [{ type: "var", name: "missing.path" }],
        },
        {},
        "en",
      ),
    ).toBe("");

    expect(
      format(
        { type: "message", parts: [{ type: "number", name: "value", style: "integer" }] },
        { value: 2.8 },
        "en",
      ),
    ).toBe("3");
    expect(
      format(
        { type: "message", parts: [{ type: "number", name: "value", style: "percent" }] },
        { value: 0.25 },
        "en",
      ),
    ).toContain("25");
    expect(
      format(
        { type: "message", parts: [{ type: "number", name: "value", style: "currency:eur" }] },
        { value: 12 },
        "en",
      ),
    ).toMatch(/12/);
    expect(
      format(
        { type: "message", parts: [{ type: "number", name: "value", style: "compact" }] },
        { value: 1200 },
        "en",
      ),
    ).not.toBe("");
    expect(
      format(
        { type: "message", parts: [{ type: "number", name: "value" }] },
        { value: "bad-number" },
        "en",
      ),
    ).toBe("bad-number");

    expect(
      format(
        { type: "message", parts: [{ type: "date", name: "when", style: "short" }] },
        { when: "2024-01-02T03:04:05Z" },
        "en",
      ),
    ).not.toBe("");
    expect(
      format(
        { type: "message", parts: [{ type: "time", name: "when", style: "full" }] },
        { when: 1704164645000 },
        "en",
      ),
    ).not.toBe("");
    expect(
      format(
        { type: "message", parts: [{ type: "date", name: "when" }] },
        { when: "not-a-date" },
        "en",
      ),
    ).toBe("not-a-date");
    expect(
      format(
        { type: "message", parts: [{ type: "time", name: "when" }] },
        { when: new Date("invalid") },
        "en",
      ),
    ).toBe("Invalid Date");

    expect(
      format(
        {
          type: "message",
          parts: [
            {
              type: "select",
              name: "status",
              options: {
                open: { type: "message", parts: [{ type: "text", value: "Open" }] },
                other: { type: "message", parts: [{ type: "text", value: "Other" }] },
              },
            },
          ],
        },
        { status: "closed" },
        "en",
      ),
    ).toBe("Other");

    const pluralMessage = {
      type: "message",
      parts: [
        {
          type: "plural",
          name: "count",
          options: {
            "=0": { type: "message", parts: [{ type: "text", value: "none" }] },
            one: {
              type: "message",
              parts: [{ type: "pound" }, { type: "text", value: " item" }],
            },
            other: {
              type: "message",
              parts: [{ type: "pound" }, { type: "text", value: " items" }],
            },
          },
        },
      ],
    };

    expect(format(pluralMessage, { count: 0 }, "en")).toBe("none");
    expect(format(pluralMessage, { count: 1 }, "en")).toBe("1 item");
    expect(format(pluralMessage, { count: 2 }, "en")).toBe("2 items");
    expect(format(pluralMessage, { count: "oops" }, "en")).toBe("0 items");
    expect(format({ parts: [] }, undefined, "en")).toBe("");
  });

  it("precompiles supported ICU styles and parser edge cases during buildStart", () => {
    const fixtureDir = createLocalesDir({
      app: {
        plain: "Hello world",
        variable: "Hello {user.name}",
        integer: "{value, number, integer}",
        percent: "{value, number, percent}",
        compact: "{value, number, compact}",
        currency: "{value, number, currency:eur}",
        bareNumber: "{value, number}",
        bareDate: "{when, date}",
        shortDate: "{when, date, short}",
        bareTime: "{when, time}",
        longTime: "{when, time, long}",
        select: "{status, select, open {Open} other {Other}}",
        plural: "{count, plural, =0 {None} one {# item} other {# items}}",
        invalidPlaceholder: "literal {, number}",
        unmatchedBrace: "literal {value",
      },
    });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir });
    const buildStart = getBuildStart(plugin);
    const context = createBuildContext();

    runBuildStart(buildStart, context);

    expect(context.watchedFiles).toHaveLength(1);
    expect(context.infos[0]).toContain("loaded");
  });

  it("rejects invalid top-level JSON and non-string leaf values", () => {
    const invalidJsonPlugin = getPlugin({ locale: "de", localesDir: createLocalesDir('{"app":') });
    expect(() =>
      runBuildStart(getBuildStart(invalidJsonPlugin), createBuildContext()),
    ).toThrowError(/failed to parse JSON in .*\/de\.json/i);

    const scalarPlugin = getPlugin({ locale: "de", localesDir: createLocalesDir('"bad"') });
    expect(() => runBuildStart(getBuildStart(scalarPlugin), createBuildContext())).toThrowError(
      /Expected top-level JSON object/i,
    );

    const invalidLeafPlugin = getPlugin({
      locale: "de",
      localesDir: createLocalesDir({ app: { count: 42 } }),
    });
    expect(() =>
      runBuildStart(getBuildStart(invalidLeafPlugin), createBuildContext()),
    ).toThrowError(/Expected string or object section/i);
  });

  it("returns null when transform is not applicable", () => {
    const fixtureDir = createLocalesDir({ app: { plain: "Hello" } });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const transformed = transform.call(
      {
        parse() {
          throw new Error("parse should not be called");
        },
        warn() {
          // noop
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      "const value = 1;",
      "src/no-translation.ts",
    );

    expect(transformed).toBeNull();
  });

  it("does not parse member-expression-only prefilter matches", () => {
    const fixtureDir = createLocalesDir({ app: { plain: "Hello" } });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const transformed = transform.call(
      {
        parse() {
          throw new Error("parse should not be called");
        },
        warn() {
          // noop
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      'const message = i18n.t("app.plain");',
      "src/member-only.ts",
    );

    expect(transformed).toBeNull();
  });

  it("rewrites static and formatted calls, uses undefined params, and selects parser languages", () => {
    const fixtureDir = createLocalesDir({
      app: {
        static: "Plain text",
        formatted: "Hello {name}",
      },
    });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const source =
      'import { something } from "virtual:other";\nconst a = t("app.static");\nconst b = t("app.formatted");\n';
    const staticStart = source.indexOf('t("app.static")');
    const staticEnd = staticStart + 't("app.static")'.length;
    const formattedStart = source.indexOf('t("app.formatted")');
    const formattedEnd = formattedStart + 't("app.formatted")'.length;
    const ast = {
      type: "Program",
      body: [
        {
          type: "ImportDeclaration",
          source: { type: "Literal", value: "virtual:other" },
          specifiers: [],
        },
        {
          type: "ExpressionStatement",
          expression: {
            type: "CallExpression",
            start: staticStart,
            end: staticEnd,
            callee: { type: "Identifier", name: "t" },
            arguments: [{ type: "Literal", value: "app.static" }],
          },
        },
        {
          type: "ExpressionStatement",
          expression: {
            type: "CallExpression",
            start: formattedStart,
            end: formattedEnd,
            callee: { type: "Identifier", name: "t" },
            arguments: [{ type: "Literal", value: "app.formatted" }],
          },
        },
      ],
    };
    const seenLangs: string[] = [];

    const transformedJsx = transform.call(
      {
        parse(_input: string, options?: { lang?: string } | null) {
          if (options?.lang) {
            seenLangs.push(options.lang);
          }
          return ast;
        },
        warn() {
          // noop
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      source,
      "src/example.jsx",
    ) as { code: string } | null;

    const transformedJs = transform.call(
      {
        parse(_input: string, options?: { lang?: string } | null) {
          if (options?.lang) {
            seenLangs.push(options.lang);
          }
          return ast;
        },
        warn() {
          // noop
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      source,
      "src/example.js",
    ) as { code: string } | null;

    expect(seenLangs).toEqual(["jsx", "js"]);
    expect(transformedJsx?.code).toContain('const a = "Plain text";');
    expect(transformedJsx?.code).toContain("__i18nFormat(");
    expect(transformedJsx?.code).toContain(', undefined, "de")');
    expect(transformedJs?.code).toContain("__i18nFormat(");
  });

  it("ignores malformed call nodes during analysis", () => {
    const fixtureDir = createLocalesDir({ app: { static: "Plain text" } });
    const plugin = getPlugin({
      locale: "de",
      localesDir: fixtureDir,
      failOnDynamicKeys: false,
    });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const source = 'const a = t("app.static");';
    const transformed = transform.call(
      {
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ExpressionStatement",
                meta: { foo: "bar" },
                expression: {
                  type: "CallExpression",
                  callee: { type: "Identifier", name: "t" },
                  arguments: [],
                },
              },
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: 0,
                  end: 10,
                  callee: { type: "Identifier", name: "t" },
                },
              },
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: 0,
                  end: 10,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [],
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
      "src/ignore.ts",
    );

    expect(transformed).toBeNull();
  });

  it("fails on dynamic translation keys when configured", () => {
    const fixtureDir = createLocalesDir({ app: { plain: "Hello" } });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const source = "const key = getKey(); const message = t(key);";
    const dynamicStart = source.indexOf("t(key)");
    const dynamicEnd = dynamicStart + "t(key)".length;

    expect(() =>
      transform.call(
        {
          parse() {
            return createLiteralAst(source, {
              type: "CallExpression",
              start: dynamicStart,
              end: dynamicEnd,
              callee: { type: "Identifier", name: "t" },
              arguments: [{ type: "Identifier", name: "key" }],
            });
          },
          warn() {
            // noop
          },
          error(message: string) {
            throw new Error(message);
          },
        } as any,
        source,
        "src/dynamic.ts",
      ),
    ).toThrowError(/dynamic translation call/i);
  });

  it("reports missing, unused, and dynamic diagnostics during generateBundle", () => {
    const fixtureDir = createLocalesDir({
      app: {
        known: "Known",
        unused1: "Unused 1",
        unused2: "Unused 2",
        unused3: "Unused 3",
        unused4: "Unused 4",
        unused5: "Unused 5",
        unused6: "Unused 6",
        unused7: "Unused 7",
        unused8: "Unused 8",
        unused9: "Unused 9",
        unused10: "Unused 10",
        unused11: "Unused 11",
      },
    });
    const plugin = getPlugin({
      locale: "de",
      localesDir: fixtureDir,
      strictMissing: false,
      failOnDynamicKeys: false,
    });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const source = 'const a = t("app.missing"); const k = getKey(); const b = t(k);';
    const literalStart = source.indexOf('t("app.missing")');
    const literalEnd = literalStart + 't("app.missing")'.length;
    const dynamicStart = source.indexOf("t(k)");
    const dynamicEnd = dynamicStart + "t(k)".length;
    const warnings: string[] = [];

    transform.call(
      {
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: literalStart,
                  end: literalEnd,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [{ type: "Literal", value: "app.missing" }],
                },
              },
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: dynamicStart,
                  end: dynamicEnd,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [{ type: "Identifier", name: "k" }],
                },
              },
            ],
          };
        },
        warn(message: string) {
          warnings.push(message);
        },
        error(message: string) {
          throw new Error(message);
        },
      } as any,
      source,
      "src/diagnostics.ts",
    );

    const generateBundle = getGenerateBundle(plugin);
    runGenerateBundle(generateBundle, {
      warn(message: string) {
        warnings.push(message);
      },
    });

    expect(warnings.some((message) => message.includes("missing translation keys"))).toBe(true);
    expect(warnings.some((message) => message.includes("unused translation keys"))).toBe(true);
    expect(warnings.some((message) => message.includes("dynamic translation call"))).toBe(true);
    expect(warnings.some((message) => /\(\+\d+ more\)/.test(message))).toBe(true);

    const repeatedWarnings = warnings.length;
    runGenerateBundle(generateBundle, {
      warn(message: string) {
        warnings.push(message);
      },
    });
    expect(warnings).toHaveLength(repeatedWarnings);
  });

  it("labels bundle audit warnings with the current environment", () => {
    const fixtureDir = createLocalesDir({ app: { known: "Known", unused: "Unused" } });
    const plugin = getPlugin({ locale: "de", localesDir: fixtureDir, strictMissing: false });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const warnings: string[] = [];
    runGenerateBundle(getGenerateBundle(plugin), {
      environment: { name: "ssr" },
      warn(message: string) {
        warnings.push(message);
      },
    });

    expect(warnings.some((message) => message.includes("[ssr]"))).toBe(true);
    expect(warnings.some((message) => message.includes("environment-scoped audit"))).toBe(true);
  });

  it("can disable environment labels in diagnostics", () => {
    const fixtureDir = createLocalesDir({ app: { known: "Known", unused: "Unused" } });
    const plugin = getPlugin({
      locale: "de",
      localesDir: fixtureDir,
      strictMissing: false,
      includeEnvironmentLabelInWarnings: false,
    });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const warnings: string[] = [];
    runGenerateBundle(getGenerateBundle(plugin), {
      environment: { name: "ssr" },
      warn(message: string) {
        warnings.push(message);
      },
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((message) => message.startsWith("[build-time-i18n]"))).toBe(true);
    expect(warnings.some((message) => message.includes("[ssr]"))).toBe(false);
  });

  it("tracks used keys per environment for unused-key diagnostics", () => {
    const fixtureDir = createLocalesDir({ app: { known: "Known" } });
    const plugin = getPlugin({
      locale: "de",
      localesDir: fixtureDir,
      strictMissing: false,
      failOnDynamicKeys: false,
    });
    runBuildStart(getBuildStart(plugin), createBuildContext());

    const transform = getTransformHandler(plugin);
    const source = 'const message = t("app.known");';
    const literalStart = source.indexOf('t("app.known")');
    const literalEnd = literalStart + 't("app.known")'.length;

    transform.call(
      {
        environment: { name: "client" },
        parse() {
          return {
            type: "Program",
            body: [
              {
                type: "ExpressionStatement",
                expression: {
                  type: "CallExpression",
                  start: literalStart,
                  end: literalEnd,
                  callee: { type: "Identifier", name: "t" },
                  arguments: [{ type: "Literal", value: "app.known" }],
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
      "src/per-env.ts",
    );

    const warnings: string[] = [];
    const generateBundle = getGenerateBundle(plugin);
    runGenerateBundle(generateBundle, {
      environment: { name: "client" },
      warn(message: string) {
        warnings.push(message);
      },
    });

    runGenerateBundle(generateBundle, {
      environment: { name: "ssr" },
      warn(message: string) {
        warnings.push(message);
      },
    });

    const clientWarnings = warnings.filter((message) => message.includes("[client]"));
    const ssrWarnings = warnings.filter((message) => message.includes("[ssr]"));

    expect(clientWarnings.some((message) => message.includes("unused translation keys"))).toBe(
      false,
    );
    expect(ssrWarnings.some((message) => message.includes("unused translation keys"))).toBe(true);
  });

  it("resolves default locale files from local candidates and reports checked paths when missing", () => {
    const originalCwd = process.cwd();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-defaults-"));

    try {
      const localesDir = path.join(fixtureRoot, "locales");
      fs.mkdirSync(localesDir, { recursive: true });
      fs.writeFileSync(path.join(localesDir, "de.json"), JSON.stringify({ app: { ok: "OK" } }));

      process.chdir(fixtureRoot);

      const plugin = getPlugin({ locale: "de" });
      const context = createBuildContext();
      runBuildStart(getBuildStart(plugin), context);

      expect(fs.realpathSync(context.watchedFiles[0])).toBe(
        fs.realpathSync(path.join(localesDir, "de.json")),
      );

      const missingPlugin = getPlugin({ locale: "fr" });
      expect(() => runBuildStart(getBuildStart(missingPlugin), createBuildContext())).toThrowError(
        /Checked: .*\/locales\/fr\.json, .*\/i18n\/locales\/fr\.json/i,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("handles malformed ICU control options and invalid date styles", () => {
    const malformedPlugin = getPlugin({
      locale: "de",
      localesDir: createLocalesDir({
        app: {
          malformedSelect: "{status, select, {Other}}",
        },
      }),
    });
    expect(() => runBuildStart(getBuildStart(malformedPlugin), createBuildContext())).toThrowError(
      /missing required 'other' option/i,
    );

    const emptyStylePlugin = getPlugin({
      locale: "de",
      localesDir: createLocalesDir({
        app: {
          emptyStyle: "{value, number, }",
          unknownKind: "{value, unknown}",
        },
      }),
    });
    expect(() =>
      runBuildStart(getBuildStart(emptyStylePlugin), createBuildContext()),
    ).not.toThrow();

    const invalidDatePlugin = getPlugin({
      locale: "de",
      localesDir: createLocalesDir({
        app: {
          invalidDate: "{when, date, tiny}",
        },
      }),
    });
    expect(() =>
      runBuildStart(getBuildStart(invalidDatePlugin), createBuildContext()),
    ).toThrowError(/Invalid date style/i);
  });
});
