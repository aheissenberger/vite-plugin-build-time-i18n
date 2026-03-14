# vite-plugin-build-time-i18n

Build-time i18n for Vite. This plugin replaces string-literal
translation calls during build so your app ships translated output
instead of doing key lookup at runtime.

It is designed for projects that want:

- static replacement for simple messages
- precompiled formatting for plural, select, number, date, and time messages
- build-time diagnostics for missing, unused, or non-precompilable translation keys
- zero runtime translation catalog lookup in application code

License: [LICENCE](LICENCE)

## Why use it

Instead of shipping a message catalog and resolving keys in the
browser, this plugin rewrites calls such as:

```ts
const title = t("app.page.title");
const countLabel = t("app.page.priorityCount", { count: 2 });
```

into either:

- a plain string literal for static messages
- a generated formatter call for messages that need interpolation or ICU-style branching

That keeps translated output close to the final bundle and catches
catalog problems during the build.

## Requirements

- Node.js 25+
- Vite 8+

## Install

```bash
npm install vite-plugin-build-time-i18n
```

`vite` is a peer dependency and must already exist in the consuming project.

## Quick start

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { buildTimeI18nPlugin } from "vite-plugin-build-time-i18n";

export default defineConfig({
  plugins: [
    ...buildTimeI18nPlugin({
      locale: "de",
      localesDir: "src/i18n/locales",
    }),
  ],
});
```

```json
// src/i18n/locales/de.json
{
  "app": {
    "page": {
      "title": "Startseite",
      "priorityCount": "{count, plural, one {# Prioritaet} other {# Prioritaeten}}"
    }
  }
}
```

```ts
// application code
function t(key: string, values?: Record<string, unknown>) {
  return key;
}

const title = t("app.page.title");
const countLabel = t("app.page.priorityCount", { count: 2 });
```

Build output shape:

```ts
const title = "Startseite";

import { __i18nFormat } from "virtual:build-time-i18n-helper";

const countLabel = __i18nFormat(
  {
    type: "message",
    parts: [
      /* compiled parts */
    ],
  },
  { count: 2 },
  "de",
);
```

## How it works

During build, the plugin:

1. reads `<localesDir>/<locale>.json`
2. flattens nested message objects into dotted keys
3. precompiles supported message syntax
4. scans matching source files for direct calls to the configured translation function
5. rewrites supported calls in the final bundle

## Locale file format

Locale files must be top-level JSON objects. Nested objects are
flattened into dotted keys.

```json
{
  "app": {
    "route": {
      "modeLabel": "Routenmodus"
    },
    "stats": {
      "participants": "Teilnehmende: {count, number, compact}"
    }
  }
}
```

This becomes:

- `app.route.modeLabel`
- `app.stats.participants`

Message values must be either strings or nested objects.

## Options

```ts
type BuildTimeI18nPluginOptions = {
  locale: string;
  localesDir?: string;
  include?: RegExp;
  functionName?: string;
  strictMissing?: boolean;
  failOnDynamicKeys?: boolean;
};
```

### `locale`

Active locale code. The plugin reads `<localesDir>/<locale>.json`.

### `localesDir`

Directory containing locale JSON files.

Default: the package's bundled `i18n/locales` directory.

### `include`

Regular expression used to choose which files run through the transform hook.

Default:

```ts
/\.[cm]?[jt]sx?$/
```

### `functionName`

Identifier name to rewrite.

Default: `"t"`

Only direct identifier calls are rewritten:

```ts
t("app.page.title");
```

These are not rewritten:

```ts
i18n.t("app.page.title");
translations[fn]("app.page.title");
```

### `strictMissing`

Controls how missing keys are handled.

- `true` (default): fail the build
- `false`: warn and replace with the key string

### `failOnDynamicKeys`

Controls how non-literal translation keys are handled.

- `true` (default): fail the build
- `false`: warn and leave the call non-precompiled

## Supported message syntax

This plugin supports a focused subset of ICU-style message formatting.

### Variables

```txt
{name}
```

### Numbers

```txt
{amount, number}
{amount, number, integer}
{amount, number, percent}
{amount, number, compact}
{amount, number, currency:EUR}
```

### Dates and times

```txt
{when, date}
{when, date, short}
{when, date, medium}
{when, date, long}
{when, date, full}

{when, time}
{when, time, short}
{when, time, medium}
{when, time, long}
{when, time, full}
```

### Select

```txt
{status, select, open {Open} closed {Closed} other {Unknown}}
```

### Plural

```txt
{count, plural, =0 {No items} one {# item} other {# items}}
```

Rules:

- `plural` and `select` must include `other`
- `#` is only meaningful inside plural branches
- invalid styles fail during catalog precompile

## Diagnostics

The plugin reports diagnostics with the prefix `[build-time-i18n]`.

It can report:

- missing translation keys
- unused translation keys
- dynamic translation calls that cannot be precompiled
- invalid message syntax or unsupported formatting styles

## Caveats

- This is not a full ICU MessageFormat implementation.
- Only direct calls to the configured function name are rewritten.
- The first argument must be a string literal to be precompiled.
- The plugin applies only to Vite build mode.
- Locale files must be valid JSON and must contain a top-level object.

## Advanced

When a message needs runtime formatting, the plugin injects a virtual helper import:

```ts
import { __i18nFormat } from "virtual:build-time-i18n-helper";
```

That helper uses native `Intl.PluralRules`, `Intl.NumberFormat`, and
`Intl.DateTimeFormat` under the hood.

## Development

```bash
npm install
npm run typecheck
npm test
```
