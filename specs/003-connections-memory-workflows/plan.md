# Implementation Plan: 003 Connections, project memory and ways of working

## Technical context
Node.js ≥ 22, zero runtime dependencies, global `fetch`; Git ≥ 2.23 (`git restore`); Spec Kit 1.2.5 verified
locally (`specify init --here --force --non-interactive --integration codex|claude`); Codex app-server
`marketplace/add` → `{ marketplaceName, installedRoot, alreadyAdded }`, `plugin/install { marketplacePath, pluginName }`.

## Constitution check
I one place (Connections menu, project overview card) ✓ · III secrets in keychain, credential helper via env ✓ ·
IV tests for every scenario ✓ · V no new dependency; reuse Git for checkpoints instead of a file copier ✓.

## Structure
- `lib/atlassian.mjs` — Jira and Bitbucket REST clients, ADF ↔ text.
- `lib/gitaccounts.mjs` — hosts, credential helper arguments, repository listing, remote parsing.
- `lib/connections.mjs` — Connections service (connect, act, clone, publish, SSH).
- `lib/checkpoints.mjs` — snapshots with a private index, preview, restore.
- `lib/speckit.mjs` — folder status, init arguments, phase messages.
- `lib/memory.mjs` — discovery of user context files; creation in the folder.
- UI in `public/app.js` (Connections dialog, Jira/Bitbucket panels, Spec card, checkpoints dialog).
