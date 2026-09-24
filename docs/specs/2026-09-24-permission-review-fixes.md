# Permission Review: First Three Fixes

## Goal

Fix the three review findings approved by the user: exact rules becoming globs,
unrelated operations sharing an approval, and project executables inheriting
read-only exemptions from their basename.

## In Scope / Out of Scope

In scope: typed command rules, migration, settings and prompt integration,
permission identity, executable auto-approval checks, and regression tests.
Other review findings require separate user approval. Do not change unrelated
working-tree edits, including the concurrent shell-redirection parser changes.

## Decisions and Assumptions

- The user approved all three fixes.
- The user chose to require reapproval of legacy command allow rules. Drop old
  string allow entries during settings deserialization; preserve old deny
  strings as glob rules. Built-in automatic allowances remain independent.
- ASSUMPTION: deduplication should remain for genuinely identical requests in
  the same session, not across independent chats or subagents.
- ASSUMPTION: explicit executable paths should ask unless an explicit saved rule
  permits them; they must not inherit the basename's automatic exemption.

## Chosen Approach

Use typed exact/glob rules rather than escaping strings or adding string-prefix
encodings. This preserves matching intent, supports literal glob characters,
and makes saved rules understandable in Settings. Keep scoped deduplication
rather than removing it and creating repeated prompts for identical requests.

## UI

Preserve the existing layout and copy-button changes. Scope selection must
distinguish exact and glob rules even when their text is identical. Settings
shows the actual matching kind and provides an exact/glob choice for manual
rules, defaulting to exact. Reuse existing translated labels where correct;
any changed or new copy must be translated in all 24 locales.

## Data and Contracts

- Rust CommandRule: tagged exact/glob enum with string value, serialized as
  {"kind":"exact"|"glob","value":"..."}.
- TypeScript CommandRule: corresponding discriminated union.
- Use typed rules for persistent allow/deny lists and session grants. Preserve
  top-level settings keys commandRules and deniedCommandRules.
- Scope options contain typed rules. Compare, select, deduplicate, and delete
  using kind plus value, not display text or object identity.
- Exact matching compares the trimmed command literally. Glob matching keeps
  intentional pattern behavior. Neither bypasses existing safety checks.
- The backend validates submitted command rules against backend-owned options;
  missing selections must not fall back to a broad suggested string.
- For shell prompts without scope options, deny always saves an exact rule for
  the original backend-owned command, not its display suggestion. These prompts
  still create no persistent/session allow grants. MCP prompts (which carry no
  shell rule suggestion) have no remembered-rule fallback.
- Website rule strings stay separate from typed command rules.
- Permission deduplication uses a structured key containing session, prompt
  kind, operation identity, absolute resource, and command working directory.
  Never use ambiguous delimiter-concatenated keys. File read and write requests
  are distinct. Command working directories are captured by the backend.
- Auto-read-only exemptions never apply to path-qualified executables. Bare
  executables resolving inside the project must also ask; shell builtins retain
  their existing treatment. Explicit saved rules remain explicit approvals.
- Unix execution uses /bin/sh rather than resolving the shell itself through
  potentially project-controlled PATH entries. Relative PATH entries fail
  closed for automatic executable trust. On Windows, unmodeled external
  executable resolution prompts rather than assuming POSIX lookup semantics.

## Edge Cases and Acceptance Criteria

- An exact Python command containing a quoted star cannot approve different
  Python source. Question marks, brackets, braces, and backslashes are literal.
- A deliberate glob still matches. Exact/glob rules with identical values
  coexist and can be independently selected and deleted.
- Mixed legacy/typed settings retain typed rules, discard legacy allows, and
  preserve legacy denies and unrelated settings. Typed settings round-trip.
- Allow always, allow in this chat, and deny always retain matching kind.
- Deny always on an unscoped substitution command such as `echo "$(whoami)"`
  blocks the identical command without turning its suggestion into a glob.
- Identical command text in two sessions or working directories prompts
  independently. Sensitive-file reads and writes do not share an approval.
- Equivalent same-session operations can share an approval.
- A project executable named ls cannot inherit system ls auto-approval.
- Ordinary system read-only tools retain automatic approval where executable
  identity can be checked. Unknown identity fails closed to a prompt.

## Implementation Steps

1. Define CommandRule in src-tauri/src/models.rs and migration in
   src-tauri/src/config.rs. Test through flattened Settings.
2. Propagate typed rules through src-tauri/src/permissions.rs,
   src-tauri/src/commands.rs, src-tauri/src/agent.rs, and broker metadata.
3. Update src/app/core/models.ts, api.ts, settings.service.ts,
   workspace.service.ts, components/permission-overlay.ts, and
   components/settings/agent-rules-settings.ts. Update tests and locale copy.
4. Add structured permission identity in src-tauri/src/broker.rs and populate
   resource/operation/working-directory context at tools.rs and commands.rs
   prompt call sites. Add broker concurrency regression tests.
5. Guard executable auto-approval in src-tauri/src/permissions.rs and pass the
   necessary execution context from src-tauri/src/tools.rs. Do not modify the
   concurrently edited shell parser.
6. Run cargo test --manifest-path src-tauri/Cargo.toml, ng build, ng test
   --watch=false, and locale parity checks if copy changes.

## Open Questions

None after approval of this specification. Remaining review findings will be
presented individually and are not authorized by this specification.
