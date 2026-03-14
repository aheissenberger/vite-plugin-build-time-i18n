# Project Guidelines

## Code Style

- Use TypeScript only in `src/`.
- Keep ESM syntax (`type: module`) and explicit `.ts` relative imports.
- Prefer Node built-ins before adding third-party dependencies.

## Architecture

- This repository is a single-package npm project.
- Source of truth is `src/index.ts`; tests live next to source as `*.test.ts`.
- Runtime is Node 25+ native TypeScript execution (no ts-node, no tsx, no transpile step).

## Build and Test

- Install: `npm install`
- Run entrypoint: `npm run dev`
- Typecheck: `npm run typecheck`
- Test: `npm test`

## Conventions

- Keep the package TypeScript-only: export `.ts` sources in `package.json`.
- Maintain Node engine constraint at `>=25`.
- For new tests, use Vitest 4 and colocate tests as `*.test.ts` next to source files.

## Agent I18n Guidance

- For translatable text changes, use [./.github/skills/build-time-i18n-authoring/SKILL.md](./skills/build-time-i18n-authoring/SKILL.md).
- Follow [./.github/instructions/build-time-i18n-authoring.instructions.md](./instructions/build-time-i18n-authoring.instructions.md) when editing source calls or locale JSON.
- Run `npm run validate:i18n` before finalizing i18n-related changes.
