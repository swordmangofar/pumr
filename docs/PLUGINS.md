# Plugin and marketplace security model

pumr can pull MCP server definitions from the official Model Context Protocol
registry and install Agent Skills from Claude-style plugin marketplaces. Both
surfaces are treated as **untrusted input**: pumr shows metadata and copies
files, but never runs code or edits agent configuration on the user's behalf.

## MCP servers (official registry)

- Search queries `https://registry.modelcontextprotocol.io/v0/servers`. Results
  are metadata only: name, description, transport, URL or launch command, and the
  environment variables the server declares.
- Namespaced entries (`io.github.owner/server`) that the registry reports as
  `active` are marked **verified**; everything else is shown as unverified.
- pumr does **not** install or launch a server from a registry result. The user
  copies a config snippet into their own MCP configuration and connects it
  explicitly, after reviewing the command line. pumr never injects a `-y`/force
  flag beyond what the registry entry already declares.
- Environment variables required by a server are surfaced before install,
  including which are secret, so the user knows what credentials a server needs.

## Agent Skills (git marketplaces)

- A marketplace is a git repository with `.claude-plugin/marketplace.json` at its
  root. Adding one clones it into pumr's data directory (shallow, depth 1).
- Marketplace names that Anthropic reserves (`claude-code-plugins`,
  `anthropic-agent-skills`, …) are rejected: a third-party catalog can never
  present itself as an official source. Curated catalogs shipped by pumr are the
  only ones allowed to show as verified.
- pumr reads the manifest to enumerate plugins and their skills. Relative plugin
  sources are resolved inside the marketplace checkout; `github`/`npm`/archive
  sources are not fetched.
- Installing a plugin **copies** its skill directories into
  `<data-dir>/skills/<marketplace>/<plugin>/<skill>`, so skills keep working even
  if the marketplace is later removed. Files are copied verbatim; nothing is
  executed and no skill is silently enabled.
- Installed skills participate in normal skill discovery and are always offered
  to the agent, even when auto-discovery is disabled, because the user opted in.
  They can be revoked per skill in Settings or removed with **Uninstall**.
- Removing a marketplace deletes its checkout but leaves installed skills on
  disk, so the user does not lose skills they rely on.

## Verification and trust

pumr verifies sources by default. The setting `marketplace_verified_only`
(default **on**) controls the strictness:

- **MCP registry** — results are filtered to entries whose namespaced owner the
  registry reports as `active` and verified. Turning the setting off includes
  unverified third-party entries.
- **Skill marketplaces** — a marketplace is only usable when it is either
  **verified** or **trusted**:
  - *Verified*: the URL is on pumr's curated allowlist and the local checkout's
    `HEAD` matches the pinned commit recorded there. Pinning makes a force-push
    or compromised upstream unable to silently change what gets installed.
  - *Trusted*: the user added the URL themselves, which is an explicit opt-in.
  - Anything else is **unverified** and blocked unless the user turns the setting
    off.

The curated allowlist lives in `src-tauri/src/marketplace.rs`
(`CURATED_MARKETPLACES`). It is intentionally empty until a catalog is reviewed
end to end; each entry is a clone URL plus the full 40-character commit SHA that
was reviewed. Adding a reviewed marketplace there upgrades matching checkouts
from *trusted* to *verified*.

## Trust boundary

Everything a marketplace or registry returns is remote content. pumr's
guarantees are:

1. No remote code runs automatically.
2. No command or configuration is added to the agent without the user copying or
   installing it explicitly.
3. Installed skill files are inert data, not executables, and remain subject to
   the normal permission model when the agent later reads them.