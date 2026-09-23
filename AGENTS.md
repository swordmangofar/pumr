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
   `en.json` (currently 741 keys). The language JSON files are flat-namespaced with
   identical nesting and ordering; insert new keys next to their English siblings.
5. **Preserve interpolations exactly.** Placeholders such as `{{ count }}`,
   `{{ current }}`, `{{ total }}`, `{{ version }}`, `{{ progress }}` and `{{ names }}`
   must survive translation verbatim (spacing inside the braces may differ, but the
   token must not be translated, renamed or dropped).
6. **Do not translate language names** in the language picker
   (`general-settings.ts`) — they stay in their own language.

Before finishing any change that touches copy, verify parity. A quick check:

```bash
node -e '
const fs=require("fs");const d="public/i18n";
const fl=o=>{const r={};(function f(x,p){for(const[k,v]of Object.entries(x)){const kk=p?p+"."+k:k;v&&typeof v==="object"?f(v,kk):r[kk]=v;}})(o,"");return r;};
const en=Object.keys(fl(JSON.parse(fs.readFileSync(d+"/en.json"))));
for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".json")&&f!=="en.json")){
  const k=Object.keys(fl(JSON.parse(fs.readFileSync(d+"/"+f))));
  const miss=en.filter(x=>!k.includes(x)),extra=k.filter(x=>!en.includes(x));
  console.log(f, miss.length||extra.length?"MISSING "+miss.length+" EXTRA "+extra.length:"OK");
}'
```

## Build & test

```bash
export PATH="/opt/homebrew/bin:$PWD/node_modules/.bin:$PATH"
cargo test --manifest-path src-tauri/Cargo.toml   # Rust backend
ng build                                           # frontend typecheck/build
ng test                                            # Vitest
```