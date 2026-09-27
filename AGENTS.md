# Agent Guidelines

## Internationalization (i18n) — always add every language

pumr is fully localised. Any user-facing string **must** go through Transloco and
**must be added to every locale file** — never only to `en.json` or `en.json` + `de.json`.

Rules:

1. **Never hardcode UI text.** Templates use the `transloco` pipe
   (`{{ 'chat.send' | transloco }}`, `[attr.title]="'chat.send' | transloco"`), and
   TypeScript uses `TranslocoService`. Adding a literal string to a template is a bug.
2. **Add the key to `public/i18n/en.json` first.** It is the reference/source of truth.
3. **Add the same key to all 23 other locale files** in the same commit:
   `bg, cs, da, de, el, es, et, fi, fr, ga, hr, hu, it, lt, lv, mt, nl, pl, pt, ro, sk, sl, sv`.
   A key that exists in only some languages is considered incomplete.
4. **Keep key parity.** Every locale must have exactly the same set of flat keys as
   `en.json`. The language JSON files are flat-namespaced with
   identical nesting and ordering; insert new keys next to their English siblings.
5. **Preserve interpolations exactly.** Placeholders such as `{{ count }}`,
   `{{ current }}`, `{{ total }}`, `{{ version }}`, `{{ progress }}` and `{{ names }}`
   must survive translation verbatim (spacing inside the braces may differ, but the
   token must not be translated, renamed or dropped).
6. **Do not translate language names** in the language picker
   (`general-settings.ts`) — they stay in their own language.

Before finishing any change that touches copy, verify parity and placeholders
(this also runs as the `i18n` gate of `pnpm verify`):

```bash
pnpm check:i18n
```

## Build & test

```bash
export PATH="/opt/homebrew/bin:$PWD/node_modules/.bin:$PATH"
cargo test --manifest-path src-tauri/Cargo.toml   # Rust backend
ng build                                           # frontend typecheck/build
ng test                                            # Vitest unit/component specs
pnpm e2e                                           # Playwright end-to-end
pnpm verify                                        # every gate, as CI runs them
```

### End-to-end tests (`e2e/`)

Playwright drives the real Angular app in Chromium (`ng serve` on port 4310).
The Rust backend is replaced by an in-page fake of Tauri's IPC,
`e2e/support/fake-backend.ts`: it keeps projects, sessions, messages and
settings in memory, streams scripted agent turns over real `Channel`s and can
raise permission and question prompts (see `FakeStep`). First run needs
`pnpm exec playwright install chromium`.

- Seed data with the builders in `e2e/support/fixtures.ts` and start the app
  with `app.start(seed({...}))`; assert on backend traffic with `app.backend`.
- A test fails if the app calls a Tauri command the fake does not handle. When
  you add a command to `api.ts`, add a handler to the fake's `handlers` table
  that mirrors the Rust command.
- `installFakeBackend` is serialised into the page, so it must stay
  self-contained (no runtime imports; types are fine).
