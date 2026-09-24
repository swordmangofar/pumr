# Command risk indicator

## Goal
Show a severity chip (low / medium / high / danger) on **command** permission
prompts, with a themed hover tooltip explaining the concrete impact of the
command. Compound lines use the worst segment.

## In scope / Out of scope
- In: `promptKind === 'command'` permission prompts.
- Out: web, websearch, folder and file prompts (risk is `null`); auto-allowed
  commands (no prompt is shown); per-segment risk breakdown; localized impact
  sentences.

## Assumptions
- `risk.detail` is an English backend string, matching the existing English
  `title` / `detail` fields on the prompt.
- Only the level label is localized (all 24 locales).

## Chosen approach (and rejected alternatives + why)
Derive the level from the signals already computed in `evaluate_segment`
(sensitive paths, outside paths, danger reason, shell substitution, redirect).

Rejected:
- Program-category only: would rank deleting outside the project the same as an
  in-project delete.
- Localized impact via reason codes: much larger change; the prompt already
  ships English `detail`.

## Risk levels
| Level | Signals |
|---|---|
| danger | sensitive/credential files; system programs (`sudo`, `su`, `doas`, shutdown/reboot/halt, `mkfs`, `fdisk`, `diskutil`, `launchctl`, `systemctl`, `defaults`, `nvram`, `csrutil`); DB drop/flush (`dropdb`, `drop table`, `flushall`); output piped into an interpreter |
| high | destructive file ops (`rm`, `rmdir`, `unlink`, `shred`, `dd`, `mv`, `truncate`, `chmod`, `chown`, `chgrp`, `find -delete/-exec`, `xargs rm`), git force push / history rewrite / clean / reset --hard / restore / branch -D / stash drop / filter-branch, `docker rm|rmi|prune|system`, `kubectl delete`, package publish; inline shell substitution (backticks, `$(`); unsplittable whole line |
| medium | touches paths outside the project (non-destructive); read-only program writing through a redirect |
| low | unrecognized/state-changing commands that merely need approval |

## Data & contracts
Rust (`permissions.rs`):
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandRiskLevel { Low, Medium, High, Danger }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRisk { pub level: CommandRiskLevel, pub detail: String }

CommandDecision::Ask { reason, suggested_rule, segments, risk: CommandRisk }
```
- `ask(reason, suggested_rule, risk)`; `ask_with_segments(reason, rule, segments, risk)`.
- Unsplittable whole line (`split_segments` → `None`): `CommandRisk { High, "The command could not be safely split and may hide additional commands." }`.
- Compound lines: evaluate every segment, keep the per-segment breakdown,
  and use the **highest-risk asking segment's** `reason`, `suggested_rule` and
  `risk` (ties keep the first).
- Tokenizer failure: medium, "The command could not be parsed, so its effects cannot be verified."
- Segment shell substitution: high, "Inline shell substitution can run hidden commands."
- Outside paths non-destructive: medium, "It touches paths outside the project: {paths}." Destructive + outside: high, "{danger reason}. It also touches paths outside the project."
- Sensitive files: danger, "It touches sensitive files and could expose credentials: {paths}."
- Dangerous ask: danger for system/DB/pipe-to-interpreter programs, else high; detail = danger reason.
- Generic: low, "This command is not recognised as read-only and may change files." Read-only with redirect: medium, "It writes command output to a file."

Plumbing: `PermissionPrompt.risk: Option<CommandRisk>` (`broker.rs`) →
`StreamEvent::PermissionRequest { risk }` (`models.rs`). `tools.rs` `run_bash`
passes `Some(risk)`; every other `PermissionPrompt` literal passes `None`.

TypeScript (`models.ts`):
```ts
export type CommandRiskLevel = 'low' | 'medium' | 'high' | 'danger';
export interface CommandRisk { level: CommandRiskLevel; detail: string }
// permissionRequest event gains: risk: CommandRisk | null;
```

## UI
`permission-overlay.ts`: chip at the right of the header, only when
`request().risk` is set. Colored per level (low sky, medium amber, high orange,
danger rose). Wrapper `relative group`, chip `tabindex="0"`, tooltip
`pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-64 rounded-lg
border border-white/10 bg-navy px-3 py-2 text-xs text-mist shadow-xl
group-hover:block group-focus-within:block`, content `{{ risk.detail }}`.
Label via `permission.risk.<level>`.

New i18n keys under `permission.risk`: `low`, `medium`, `high`, `danger` in all
24 locales.

## Edge cases
| Case | Behavior |
|---|---|
| `risk` null (non-command prompt) | no chip, layout unchanged |
| Single segment | risk still shown (unlike the segment breakdown) |
| Unsplittable whole line | high |
| Destructive command outside the project | high (signal-based, not medium) |
| Multiple asking segments | worst segment's reason/rule/risk |
| Inline substitution alongside sensitive path | high (substitution checked first) |
| Long detail | tooltip wraps at `w-64` |

## Acceptance criteria
- Given `cat .env` → danger.
- Given `rm -rf /etc/hosts` → high.
- Given `echo hi && rm -rf /etc/hosts` → high, detail from the `rm` segment.
- Given `cd /tmp && ls` → medium.
- Given `pnpm build` → low.
- Given a web prompt → `risk` is null and no chip renders.
- Chip label localized; tooltip shows `detail` on hover and keyboard focus.
- `cargo test`, `ng build`, `ng test` and the i18n parity script pass.

## Implementation steps
1. `src-tauri/src/permissions.rs`: add `CommandRiskLevel`, `CommandRisk`,
   severity helper, extend `Ask`, classify each ask branch, compound aggregation,
   unit tests.
2. `src-tauri/src/tools.rs`, `src-tauri/src/broker.rs`, `src-tauri/src/models.rs`:
   add and plumb `risk`; default `None` at all non-command sites.
3. `src/app/core/models.ts`: add `CommandRiskLevel`, `CommandRisk`, event field.
4. `src/app/components/permission-overlay.ts`: chip + tooltip; `riskClass` helper.
5. `public/i18n/*.json` (24 locales): add `permission.risk.*`.
6. `permission-overlay.spec.ts`: chip/tooltip tests. Run verifications.

## Open questions
None.
