import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const VALIDATOR_PATH = path.resolve(process.cwd(), "src", "validate-i18n-authoring.ts");

type ValidatorRun = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function createFixtureProject(options?: { withLocalesDir?: boolean }): {
  rootDir: string;
  srcDir: string;
  localesDir: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-validator-"));
  const srcDir = path.join(rootDir, "src");
  const localesDir = path.join(rootDir, "i18n", "locales");

  fs.mkdirSync(srcDir, { recursive: true });
  if (options?.withLocalesDir ?? true) {
    fs.mkdirSync(localesDir, { recursive: true });
  }

  return {
    rootDir,
    srcDir,
    localesDir,
  };
}

function writeLocales(localesDir: string) {
  fs.writeFileSync(
    path.join(localesDir, "en.json"),
    JSON.stringify(
      {
        app: {
          page: {
            title: "Home",
            count: "{count, plural, one {# item} other {# items}}",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    path.join(localesDir, "de.json"),
    JSON.stringify(
      {
        app: {
          page: {
            title: "Startseite",
            count: "{count, plural, one {# Eintrag} other {# Eintraege}}",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runValidator(args: string[], cwd: string): ValidatorRun {
  const result = spawnSync(process.execPath, [VALIDATOR_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("validate-i18n-authoring cli", () => {
  it("returns success for valid source and locale inputs", () => {
    const fixture = createFixtureProject();
    writeLocales(fixture.localesDir);

    fs.writeFileSync(
      path.join(fixture.srcDir, "main.ts"),
      'const title = t("app.page.title");\nconst count = t("app.page.count", { count: 2 });\n',
      "utf8",
    );

    const result = runValidator(
      ["--src-dir", fixture.srcDir, "--locales-dir", fixture.localesDir],
      fixture.rootDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK no issues found");
    expect(result.stderr).toBe("");
  });

  it("fails when source contains dynamic translation keys", () => {
    const fixture = createFixtureProject();
    writeLocales(fixture.localesDir);

    fs.writeFileSync(
      path.join(fixture.srcDir, "dynamic.ts"),
      'const key = "app.page.title";\nconst title = t(key);\n',
      "utf8",
    );

    const result = runValidator(
      ["--src-dir", fixture.srcDir, "--locales-dir", fixture.localesDir],
      fixture.rootDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DYNAMIC_TRANSLATION_KEY");
  });

  it("warns but succeeds when locale directory is missing", () => {
    const fixture = createFixtureProject({ withLocalesDir: false });

    fs.writeFileSync(
      path.join(fixture.srcDir, "main.ts"),
      'const title = t("app.page.title");\n',
      "utf8",
    );

    const missingLocalesDir = path.join(fixture.rootDir, "does-not-exist");

    const result = runValidator(
      ["--src-dir", fixture.srcDir, "--locales-dir", missingLocalesDir],
      fixture.rootDir,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("LOCALES_DIR_NOT_FOUND");
    expect(result.stdout).toContain("completed with 0 error(s) and 1 warning(s)");
  });
});
