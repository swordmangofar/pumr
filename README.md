# pumr

An agentic coding harness — Angular 22 + Tauri v2, powered by OpenRouter.

pumr is a local desktop app that connects LLMs to your codebase. It keeps provider keys in
the OS keychain, stores sessions in SQLite, and is built so more providers (API key or OAuth)
can be added later.

## Requirements

- Node.js 24+ and pnpm
- Rust (stable) via [rustup](https://rustup.rs)
- Platform toolchain for Tauri v2 (on macOS: Xcode Command Line Tools)

## Getting started

```bash
pnpm install
pnpm dev        # runs Angular dev server + Tauri window
```

First launch: open **Settings**, paste your OpenRouter API key (stored in the OS keychain),
set an optional budget and the default system prompt. Then add a project folder and start a
session.

Production bundle:

```bash
pnpm bundle
```

## What works today (Phase 1 + 2)

- OpenRouter provider: model catalog, per-model endpoint list (provider name, uptime,
  tokens/sec, latency, prices per 1M tokens), SSE streaming chat
- Multi-tab sessions grouped by project folder, persisted history in SQLite
- Model / reasoning effort / provider routing pickers
- Reasoning ("thinking") streamed and collapsed by default in chat
- Cost per message and per session, budget + remaining, cache hit rate from provider usage
- Default system prompt editable in settings, per-session override in the data model
- English / German UI (Transloco), dark IDE-style layout (Tailwind v4)

### Tools & permissions

The agent runs a real tool loop in Rust: `read`, `write`, `edit`, `glob`, `grep`, `ls`, `bash`.
Tool calls and their output stream into the chat as collapsible cards; file-modifying tools show
`path +additions -deletions` chips that open a Monaco diff in the right panel.

- **Command approval**: every command that is not provably read-only asks first (allow once /
  allow always / deny). "Allow always" creates a glob rule (e.g. `pnpm test`, `grep *`) that can
  be managed in Settings.
- **Dangerous commands** (`rm`, `mv`, `chmod`, `git reset --hard`, `git clean`, `sudo`,
  `curl | sh`, database drops, ...) always ask outside the project. Inside the project they are
  allowed, and only ask for sensitive files such as `.env`, keys or databases.
- **Folder access**: tools may only touch the active project plus the extra folders in Settings.
  When the agent needs anything else, the permission dialog can add that folder permanently.
- **Web access**: `webfetch` reads a URL and `websearch` searches the web (DuckDuckGo). The
  user approves every new website (allow once / allow always) and can also deny a site once or
  always. Allow and deny rules are per domain (globs like `*.github.com` are supported, deny
  wins) and are managed in Settings → Agent Configuration.
- **Background processes**: commands that run longer than 10s are moved to the background and
  appear in the running-processes indicator in the header, where they can be stopped.

### Diffs, revert and rules

- Every prompt creates a snapshot in a hidden shadow git repository (in pumr's app data dir).
  Your project's real `.git` is never touched.
- The right panel lists all changed files of the session with `+/-` counts and a Monaco diff
  (inline or full-screen side-by-side).
- Clicking the revert arrow on an older prompt removes later messages, optionally restores the
  files to that point, and puts the prompt back into the composer.
- `AGENTS.md` files are merged into the system prompt: global
  (`~/Library/Application Support/dev.pumr.app/AGENTS.md`, `~/.config/pumr/AGENTS.md` or
  `~/.pumr/AGENTS.md`), project root, then nested files for directories touched in the session.
  The right panel shows every rule that applies and where it came from.

### Context mentions

Type `@` in the composer to add context to your next message:

- `@file` inlines a file's contents, `@directory` inlines a folder listing, and `@website` fetches
  a page (the usual website allow/deny rules apply).
- `@skill` loads a detected skill's `SKILL.md` instructions into the message.
- `@mcp` connects a discovered MCP server for that message and exposes its tools to the agent.
  Local `stdio` servers and remote streamable-HTTP servers are supported.

Mentions are sent as structured data alongside the message; resolved context is stored on the
message so later turns see the same content without refetching.

## Settings

Settings is split into six categories:

- **Providers** — OpenRouter API key (OS keychain), base URL, default model and reasoning
  effort; placeholders for future providers (Anthropic, OpenAI, Google, xAI).
- **Agent Configuration** — default system prompt, budget, context message limit and the
  allow-always command rules.
- **General** — UI language, theme and custom palette, app background (built-in
  abstract/puma backdrops or your own image with opacity/blur), glass opacity,
  notification sounds, keep-awake while agents run, and app info.
- **Skills** — auto-discovery of standard skill locations (`~/.claude/skills`,
  `~/.config/opencode/skill`, `~/.agents/skills`, ...) plus custom folders picked with the file
  explorer; every detected folder can be toggled on/off.
- **MCP Server** — same model as Skills for MCP configs (Claude Desktop, Claude Code, Cursor,
  Windsurf, VS Code, OpenAI Codex, opencode, Devin, Gemini CLI), parsing server names from JSON
  and TOML configs.
- **Workspace** — folders the assistant may access without asking (file explorer picker).

Reference detected skills and MCP servers from the composer with `@skill` and `@mcp` to load
their instructions or connect their tools.

## Architecture

```
src/                     Angular 22 (zoneless, signals, standalone components)
  app/core/              typed IPC wrappers, workspace/session/settings/model stores
  app/components/        sidebar, chat, composer, right panel, diff, permission dialog, settings
  public/i18n/           en.json / de.json

src-tauri/src/           Rust core
  providers/openrouter   model + endpoint APIs, SSE streaming, usage/cost accounting
  agent.rs               multi-iteration tool loop
  tools.rs               read/write/edit/glob/grep/ls/bash with permission gates
  permissions.rs         command glob rules, danger list, path/sensitivity checks
  git.rs                 shadow git repo: snapshots, diffs, restore, branch info
  processes.rs           background process registry
  broker.rs              permission request/response plumbing
  db.rs                  SQLite schema + queries (projects, sessions, messages, costs)
  config.rs              settings.json + OS keychain
  commands.rs            Tauri IPC surface
```

Design decisions:

- The agent loop, provider calls and secrets live in Rust, never in the webview.
- API keys are stored via the `keyring` crate (macOS Keychain, Windows Credential Manager,
  Secret Service on Linux).
- Reverts use a shadow git repository per project so the user's real history is never touched.

## Roadmap

- **Phase 3 — context & integrations:** smart project context + memories, opencode agent import,
  file & image attachments. (`@file` / `@directory` / `@website` / `@skill` / `@mcp` mentions and
  the MCP client are implemented.)
- **Phase 4 — polish:** additional providers (Anthropic, OpenAI, OAuth), context-window
  management, packaging/signing.
