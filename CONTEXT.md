# Context — AI Management APP (formerly Codex Projects Management)

Durable facts, decisions and progress. Keep concise; update as the project evolves.

## Ownership
- Author and copyright holder: **Jack Salameh** (jacksalameh@live.com). Not affiliated with, or branded for, any employer.
- Licence: all rights reserved for now (keeps every publishing option open). Choose an open-source or commercial licence before first public release.
- Product name: **AI Management APP** (since 3.0), a single constant in `lib/brand.mjs` (+ `<title>` in public/index.html). Data dir AIManagementApp / ai-management-app; old CodexProjectsManagement data and keychain entries are migrated.

## Origin
- A first version (1.0–1.8.3) was built in a Codex CLI session on 29–30 Oct 2026 (rollout `01a1867c-9ded-7832-bb88-912fe27a45cb`). Its source code was not carried over; this repository is a clean rebuild from that transcript, started 30 Oct 2026.

## Purpose
A local desktop web app that replaces the Codex command window: projects as an Explorer-style folder tree, conversations under their folder, chat with streamed agent work and approvals, model/effort control, per-folder and per-conversation memory (CONTEXT.md / INSTRUCTIONS.md), and developer tools (VS Code, MATLAB, Git, Bitbucket, Jira). Long-term: an all-in-one multi-agent workbench (Codex, Claude Code, Gemini…), possibly with a mobile companion.

## Architecture (decided)
- Node.js ≥ 22, **zero runtime npm dependencies**; `node server.mjs` serves `public/` on 127.0.0.1 with a random per-launch token.
- Agents are adapters (`lib/agents/`). Codex uses the official **`codex app-server`** JSON-RPC over stdio (methods verified against codex-cli 0.166.0 `generate-ts`). Claude Code adapter uses `claude -p --output-format stream-json`.
- App state is per OS user: Windows `%APPDATA%\CodexProjectsManagement`, macOS `~/Library/Application Support/CodexProjectsManagement`, Linux `$XDG_CONFIG_HOME/codex-projects-management`. Override with `CPM_DATA_DIR`.
- Codex home: `CODEX_HOME` or `~/.codex`. Each OS user sees only their own Codex account and conversations.
- Folder memory: `<folder>/.cpm/CONTEXT.md|INSTRUCTIONS.md`; conversation memory: `<folder>/.cpm/conversations/<threadId>/`. If the folder is not writable, memory falls back to the app data dir and sending is never blocked.

## Verified protocol facts (codex-cli 0.166.0)
- Threads: `thread/start|resume|list|read|archive|unarchive|delete|name/set`; turns: `turn/start|interrupt`; config: `config/read|value/write|batchWrite`; `model/list` returns per-model `supportedReasoningEfforts`.
- Supported efforts differ per model (e.g. `ultra` on gpt-6.1-sol, not on gpt-5.5 / gpt-6-luna). `config/value/write` accepts any string, so effort must be validated by the app against `model/list`.
- A new thread has no rollout file until its first message; the app must keep its own record so it stays visible.
- MCP entries `[mcp_servers.<name>]` accept `enabled = false`; remote servers use `url` + `bearer_token_env_var`; stdio servers use `command`, `args`, `env`.
- Approval server requests: `item/commandExecution/requestApproval` (accept / acceptForSession / decline / cancel) and `item/fileChange/requestApproval`.

## Bugs from v1 that the rebuild must not repeat
1. `\\?\D:\…` and `D:\…` treated as different folders → normalise paths.
2. Empty conversations disappear after refresh → app-side record.
3. Changing effort then clicking Send immediately lost the change → Send awaits pending config writes.
4. MATLAB `-r` command lost its quotes (`version(-release)`) → run a generated startup `.m` file.
5. `(item.changes || []).map is not a function` → accept array or object.
6. "Thread already has an active writer" → explain: close the other Codex window, then retry.
7. Quit killed the server so Reconnect failed → Quit stops only the agent process.
8. `EPERM mkdir D:\` → never create existing drive roots; memory-write failures never block Send.
9. Injected context displayed as the user's message → collapsed "shared context" block.
10. "Ultra" offered for models that do not support it → efforts from `model/list`.
11. Windows `.cmd` shims cannot be spawned without a shell (Node ≥ 20) → resolve the real entry point.

## Decisions added in 2.0
- Memory is opt-in: new conversations open a setup window (title, context, instructions); existing conversations without files are asked once; "No" is remembered and creates nothing. Folder memory is created only when the user opens/edits it.
- Drafts live server-side in state.json (browser storage is per-origin and the port used to change).
- Default port is stable per OS user (47100–47899, derived from user@host); falls back to a free port.
- History is read with `thread/turns/list` (paged); `thread/read includeTurns` fails on 0.166 for empty threads.
- Claude Code sessions are listed from ~/.claude/projects; one `claude -p` process per message.

## Decisions added in 3.0
- Supported AIs: Codex and Claude Code (CLI agents, file access) + API services through three wire formats (OpenAI-compatible, Anthropic, Gemini). Gemini CLI agent removed on the owner's request (not verifiable with a real account).
- API conversations are stored by the app in <dataDir>/chats/api-<provider>/<id>.json; memory is sent as the system prompt with a "suggest memory updates" header (they cannot edit files).
- Add-on catalog contains only names verified on 2026-10-30 (npm registry, GitHub, vendor docs): omniroute 3.8.52 (port 20128, /v1), Atlassian MCP https://mcp.atlassian.com/v1/mcp/authv2 (OAuth), GitHub MCP https://api.githubcopilot.com/mcp/ (Bearer PAT), @playwright/mcp, @upstash/context7-mcp, @modelcontextprotocol/server-memory|sequential-thinking|filesystem, anthropics/skills, openai/skills.
- Official logos are never bundled or drawn: downloaded from vendor sites to the user's data folder on request, or uploaded.
- Closing the app window quits after 20 s without a window (reloads reconnect in time); ⏻ quits immediately.

## Decisions added in 3.1
- Official icons are fetched automatically on the user's computer (never bundled): ICON_DIRECT official files first (code.visualstudio.com/assets/branding/code-stable.png; git-scm.com Git-Icon-1788C), then the vendor page's icon links. VS Code brand rules allow referring to VS Code, not identifying/promoting your own product — check every vendor's rules before a commercial or store release.
- Claude Code has no model-list command (2.1.314): models = aliases + settings default + Anthropic /v1/models (if key) + models seen in sessions; efforts parsed from `claude --help`.
- Conversation Files panel derives files from the transcript (fileChange items, Codex commandActions reads, Claude Read tool) plus recorded attachments and memory files; previews limited to the conversation folder or those files.

## Decisions added in 3.2
- MATLAB MCP: MathWorks' `setupAgenticToolkit("install")` is the source of truth. It writes `[mcp_servers.matlab]` (Codex, global) or the Claude Code user config; the app only asks which agent(s) and copies that entry verbatim (priority: imported JSON > Codex entry > Claude entry > toolkit JSON files > detected binary). Every MATLAB launch runs addpath(simulink toolkit) + `satk_initialize` + `shareMATLABSession`, then waits up to 120 s for the server to list tools. Verified on real codex-cli: the exact entry shape is accepted.
- Atlassian MCP: server names `atlassian` (Jira/Confluence) and `atlassian-bitbucket`; OAuth https://mcp.atlassian.com/v1/mcp/authv2, API token https://mcp.atlassian.com/v2/mcp (Basic base64(email:token) or Bearer service key) stored as ATLASSIAN_<NAME>_AUTH and passed via env_http_headers. Not auto-added to Claude Code when it would need a plain-text token. Bitbucket Server/Data Center: no official MCP.
- User-kept context files: names matching LOOSE_RE (context/instructions and FR/ES/DE variants, .md/.markdown/.txt) directly in the folder and up to 3 ancestors are part of the shared context, independent of the opt-in (opt-in only governs creating .cpm files).

## Decisions added in 3.3
- User context files (LOOSE_RE: context/instructions + FR/ES/DE variants, prefixed names) are discovered in the folder, docs-like sub-folders and ≤ 6 parents; always loaded. memoryState is 'enabled' only when the conversation's own folder has files; created files are visible CONTEXT.md / INSTRUCTIONS.md in the folder (fallback: app data folder).
- Periodic memory update: every N prompts (settings.memoryAskEvery 5–10 or 0), mode ask/auto/manual; API chats return `=== FILE: path ===` blocks, written only for requested files.
- Connections: Jira REST v3 (`/rest/api/3/search/jql`), Bitbucket Cloud REST 2.0, secrets ATLASSIAN_ATLASSIAN_AUTH / ATLASSIAN_ATLASSIAN_BITBUCKET_AUTH shared with the MCP entries; Git tokens GIT_TOKEN_<id> injected through `-c credential.https://HOST.helper=!f(){…}` reading CPM_GIT_U<i>/CPM_GIT_P<i>. Bitbucket Git username for API tokens: x-bitbucket-api-token-auth.
- Checkpoints: private index (GIT_INDEX_FILE) → write-tree → commit-tree → refs/cpm/<agent>-<id>/<cp>; untracked > 200 MB → tracked only; restore = `git restore --source --worktree`; max 30 per conversation.
- Spec Kit 1.2.5 verified: `specify init --here --force --non-interactive --integration codex|claude --ignore-agent-tools --script ps|sh`; skills in .agents/skills/speckit-* (Codex, `$speckit-<phase>`) or .claude/skills (Claude, `/speckit-<phase>`).
- Codex plugins: `marketplace/add {source}` → `{marketplaceName, installedRoot, alreadyAdded}`; path from `plugin/list`; `plugin/install {marketplacePath, pluginName}`. Claude: `claude plugin marketplace add`, `claude plugin install name@marketplace`.

## Decisions added in 3.4
- Version 1.x memory layout (from the original transcript): `<dir>\.codex-projects\conversations\<Title>--<hash12>\{CONTEXT,INSTRUCTIONS}.md`, line 1 `<!-- Codex rollout: rollout-<ts>-<threadId>.jsonl -->`; searched from the conversation folder up to the drive root; match thread id > rollout name > title.
- Effort: composer choice persisted via /api/conversation/options; chip = requested, then confirmed by `thread/settings/updated` (ThreadSettings.effort) or `thread/read` after turn completion. Verified on real codex-cli 0.166: a `turn/start` effort override is applied (thread/read → requested level).
- Token model (lib/usage.mjs): { input (uncached), output, cacheRead, cacheWrite, reasoning }; Codex totals are the thread's running total, Claude/API totals are summed per turn and kept in the conversation record.
- Trail-Code 0.28.0: `trail init --yes <dir>` non-interactive; native tree-sitter build may need build tools.

## Progress
- 2026-10-30: 3.4.0 — 79 automated tests, 57 browser flows (8 suites).
- 2026-10-30: 3.3.0 — 73 automated tests, 54 browser flows (7 suites), Spec Kit init verified with the real CLI.
- 2026-10-30: 3.2.0 — 62 automated tests, 42 browser flows (5 suites), real codex-cli check of the MathWorks MCP entry.
- 2026-10-30: 3.1.0 — 55 automated tests, 36 browser flows (4 suites), Claude detection checked on a real install.
- 2026-10-30: 3.0.0 — 50 automated tests, 32 browser flows (3 suites), real codex-cli 0.166.0 smoke test.
- 2026-10-30: rebuild completed as 2.0.0 in a cloud workspace (not deployed). Validation: 40 automated tests, 23 browser flows, smoke test against real codex-cli 0.166.0 (no account), Claude adapter read of a real session. Not verified: Windows-only paths (DPAPI, .vbs, Edge app window, MATLAB launch), real Jira/Bitbucket accounts, paid model replies. See CHANGELOG.md.
