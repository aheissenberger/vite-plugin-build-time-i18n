---
name: build-time-i18n-authoring
description: "Author and review translation keys/placeholders for vite-plugin-build-time-i18n with build-time-safe patterns."
---

# Build-Time I18n Authoring

Use this skill whenever you add or change translatable text.

## Goal

Produce source calls and locale messages that this plugin can precompile safely, and avoid patterns that only runtime translators support.

## Required call shape

- Use direct calls to the configured function name (default: t).
- First argument must be a string literal key.
- Optional second argument may contain values for placeholders.

Valid:

```ts
const title = t("app.page.title");
const count = t("app.page.count", { count: 2 });
```

Invalid for precompile:

```ts
i18n.t("app.page.title");
t(getKey());
t(`app.${section}.title`);
```

## Message syntax supported by this plugin

- Variables: {name}
- Number: {amount, number}, {amount, number, integer|percent|compact|currency:EUR}
- Date: {when, date[, short|medium|long|full]}
- Time: {when, time[, short|medium|long|full]}
- Select: {status, select, open {Open} other {Unknown}}
- Plural: {count, plural, =0 {None} one {# item} other {# items}}

Rules:

- plural/select must contain other.
- # is only meaningful inside plural branches.
- Unsupported styles (for example scientific) are rejected at build time.

## Authoring checklist

- Keep keys stable and dotted.
- Keep placeholder names consistent across locales for the same key.
- Prefer simple, explicit placeholders over nested logic.
- Run npm run validate:i18n before commit.

## Limits compared with runtime i18n tools

- Build-time replacement only; no runtime key lookup.
- Dynamic keys are not precompiled.
- Only direct identifier calls are rewritten.
- Focused ICU subset, not full MessageFormat ecosystem.
- Runtime locale switching/fallback behavior is much more limited than established runtime translators.
