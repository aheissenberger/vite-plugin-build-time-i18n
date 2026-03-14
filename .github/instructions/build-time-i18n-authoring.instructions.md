---
applyTo: "src/**/*.{ts,tsx,js,jsx},**/locales/**/*.json,**/i18n/locales/**/*.json"
---

Use build-time-safe i18n patterns for this repository.

- Always call translations via direct identifier calls: t("literal.key", values?).
- Never use dynamic keys (variables, expressions, template expressions).
- Do not use member calls (i18n.t(...)) when precompilation is expected.
- Keep keys dotted and stable.
- Keep placeholder names aligned across locale files for the same key.
- Use only supported syntax: variable, number, date/time, plural/select with required other branch.
- Before finishing i18n-related work, run npm run validate:i18n and fix diagnostics.
