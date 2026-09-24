# Command scopes and rule lists

## Goal
1. At command prompts, let the user pick an allow-always / deny-always scope:
   program (`ls *`), program+flags (`ls -la *`) or exact (`ls -la /test`), with a
   rule preview.
2. Add "Allow in this chat" (session, per conversation).
3. Add a command denylist and redesign the command + website rule sections in
   settings.

## In scope / Out of scope
- In: command prompts scope options; per-chat session command allow rules;
  command deny rules; settings command/website allow+deny redesign.
- Out: session rules for websites (unchanged); changing built-in dangerous/path
  checks; schema migration of existing rule strings.

## Assumptions
- `denied_command_rules` is a new settings field with `#[serde(default)]`, so old
  config files load unchanged.
- Scope badges in settings are inferred from the rule pattern, not stored.
- Deny rules only ever restrict; they never bypass built-in safety checks.

## Chosen approach (and rejected alternatives + why)
Backend computes the concrete scope options for the failing segment and the
renderer picks one; the backend validates the choice against the options it
proposed. Rejected: trusting a free-text renderer rule (a renderer could widen
access).

## Data & contracts
Rust (`permissions.rs`):
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandScopeKind { Program, ProgramFlags, Exact }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandScopeOption { pub kind: CommandScopeKind, pub rule: String }

CommandDecision::Ask { reason, suggested_rule, segments, risk, scope_options: Vec<CommandScopeOption> }
CommandDecision::Deny { reason }
```
- `scope_options` derived from the failing (trimmed) segment:
  - program: `{program} *`
  - program+flags: `{program} {leading -flags} *` when it differs from program
  - exact: the trimmed segment
  Dedupe by rule, preserve order program → program+flags → exact.
- Empty-command / allow paths return `scope_options: vec![]`.
- `evaluate_command(command, project_root, extra_folders, allowed, denied)`:
  deny match on any segment → `CommandDecision::Deny`. Compound lines evaluate
  every segment; any `Deny` wins, else highest-risk `Ask`, else `Allow`.
- `evaluate_segment` checks `matches_rules(trimmed, denied)` right after parsing
  and before the dangerous/path checks.

`config.rs`:
```rust
pub denied_command_rules: Vec<String>, // PermissionSettings, #[serde(default)]
```

`LivePermissions`: add `denied_command_rules: RwLock<Vec<String>>`,
`session_command_rules: RwLock<HashMap<String, Vec<String>>>`. Methods:
`denied_command_rules()`, `add_session_command_rule(session_id, rule)`,
`session_command_rules(session_id)`, `clear_session(session_id)`. `replace()`
keeps denied/session (session survives a settings save, like session folders).

`broker.rs`: `PermissionPrompt` gains `scope_options: Vec<CommandScopeOption>`
and `session_id: String`. `PendingPermission`/`PendingPrompt` store
`scope_options` and `session_id`. `StreamEvent::PermissionRequest` gains
`scope_options`.

`commands.rs` `resolve_permission`:
- command prompt: `rule` = renderer rule if it equals one of
  `pending.scope_options[i].rule`, else `pending.suggested_rule`.
- `allow_session` + command → `add_session_command_rule(session_id, rule)`.
- `allow_always` + command → push to `command_rules` (existing behaviour).
- `deny_always` + command → push to `denied_command_rules`.
- `deny`/`allow_once` → this prompt only. Web/folder/file unchanged.
`delete_session` → `state.permissions.clear_session(&session_id)`.

`tools.rs` `run_bash`:
```rust
let allowed = [persistent_allow, session_allow].concat();
let denied = [persistent_deny, session_deny].concat();
```
Handle `CommandDecision::Deny { reason }` → `ToolOutcome::denied` with reason.
Set `scope_options` and `session_id` on the `PermissionPrompt`.

TypeScript:
```ts
export type CommandScopeKind = 'program' | 'programFlags' | 'exact';
export interface CommandScopeOption { kind: CommandScopeKind; rule: string }
// permissionRequest event gains: scopeOptions: CommandScopeOption[];
```

## UI
`permission-overlay.ts`, command prompts (`scopeOptions.length > 0`):
- "Scope" label + three radio rows (program / program + flags / exact), each
  showing the rule in mono. Default: exact.
- Footer actions: Deny, Deny always, Allow once, Allow in this chat, Allow
  always. Always/deny-always resolve with the selected scope rule.
- Remove the free-text rule input. Non-command prompts keep current actions.

`agent-rules-settings.ts`:
- Commands section: separate Allow (emerald) and Deny (rose) lists with counts,
  delete buttons, empty states, and a shared add input with `Allow command` /
  `Deny command` buttons. Scope badge inferred: rule ends ` *` and body has no
  space → program; ends ` *` and body has a space → program+flags; else exact.
- Websites section: keep allow+deny, add counts and a domain/glob badge
  (contains `*` → glob, else domain).

## Edge cases
| Case | Behavior |
|---|---|
| No flag token | program+flags omitted (dedup) |
| Unsplittable whole line | `scope_options` empty; keep suggested rule |
| Deny rule matches dangerous command | denied outright, no prompt |
| Compound with a denied segment | whole line denied |
| Session rule after `delete_session` | cleared |
| Rule chosen not in options | fall back to `suggested_rule` |
| Website session action | unchanged (no session website rules) |

## Acceptance criteria
- Given `ls -la /test` with program scope, allow-always saves `ls *`.
- Program+flags saves `ls -la *`; exact saves `ls -la /test`.
- "Allow in this chat" auto-approves in the same chat, not another, and is
  gone after restart or `delete_session`.
- Deny-always saves to the denylist; a matching command is denied with no prompt.
- Settings shows separate command allow/deny lists with badges and counts.
- `cargo test`, `ng build`, `ng test`, i18n parity pass.

## Implementation steps
1. `src-tauri/src/config.rs`: `denied_command_rules` field + default.
2. `src-tauri/src/permissions.rs`: scope options, deny eval, session rules,
   `Deny` decision, unit tests.
3. `src-tauri/src/broker.rs`, `models.rs`, `tools.rs`, `commands.rs`:
   plumb scope options + session id + deny handling + resolve logic.
4. `src/app/core/models.ts`, `api.ts`, `workspace.service.ts`: types + rule pass.
5. `src/app/components/permission-overlay.ts` + spec: scope picker + actions.
6. `src/app/components/settings/agent-rules-settings.ts`: redesigned lists.
7. `public/i18n/*.json` (24 locales): new keys.
8. Run `cargo test`, `ng build`, `ng test`, parity script.

## Open questions
None.
