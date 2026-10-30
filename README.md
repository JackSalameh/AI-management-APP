# Codex Projects Management

A desktop workbench for coding agents. It replaces the Codex command window: your projects appear as an
Explorer-style folder tree, every conversation lives under its working folder, and you chat with the agent,
approve its actions, manage shared memory and run Git, VS Code, MATLAB and Jira from one place.

© 2026 Jack Salameh. All rights reserved (see `LICENSE`).

---

## 1. Requirements

| Component | Version | Why |
|---|---|---|
| Node.js | 22 or newer | Runs the local server (no other npm packages are needed) |
| Codex CLI | 0.166 or newer (`npm install -g @openai/codex`) | The agent; sign in once with `codex` in a terminal |
| Optional | Claude Code CLI, Git, VS Code, MATLAB, an MCP server for Jira | Integrations |

Each person runs the app under **their own OS account**: it reads that account's Codex sign-in, conversations
(`~/.codex`) and stores its own settings (Windows `%APPDATA%\CodexProjectsManagement`, macOS
`~/Library/Application Support/CodexProjectsManagement`, Linux `~/.config/codex-projects-management`).
Nothing personal is stored in this folder.

## 2. Start

| System | Double-click |
|---|---|
| Windows | `Launch (Windows).vbs` (no console) — or `Launch (Windows, with console).cmd` to see errors |
| macOS | `launch-macos.command` |
| Linux | `launch-linux.sh` |
| Any | `npm start` in a terminal |

The app opens as its own window (Edge/Chrome app mode) or in your browser. Launching it again re-opens the
running instance. **Try it without touching real data:** `npm run demo` starts a sandbox with sample
projects and a simulated agent.

## 3. What it does

- **Explorer** — conversations grouped by their real folders (`D:` › `X1191` › `Distance focal`); new
  folder / new conversation at any level; ⋯ menu to rename (on disk), archive, trash, restore, erase;
  drag a conversation onto a folder to move it; archived and trash views.
- **Chat** — streamed replies, commands with output and exit code, file diffs, tool calls, approval cards
  (allow / allow for session / decline / cancel). Model, reasoning effort and action mode sit beside Send.
  Effort choices come from the selected model; changes are written to `config.toml` *before* the message
  goes out, and the header shows what Codex actually acknowledged plus token usage.
- **Status** — Queued → Running → Waiting for approval → Completed / Failed / Stopped, per conversation.
- **Memory** — optional `CONTEXT.md` (facts, decisions, progress) and `INSTRUCTIONS.md` (rules,
  preferences) per conversation and per folder, stored in `<folder>/.cpm/`. A setup window asks before
  anything is created. The agent refines these files as you work. The *Memory workspace* shows what will
  be sent, its size in tokens, what changed since the last send (diff), lets you exclude files and pin
  essential notes. Unchanged memory is not re-sent. Files from other folders/conversations can be linked.
- **Search** (Ctrl+K) — across titles, every message of every conversation, and memory files, with folder
  and date filters; a result opens the conversation at the matching message.
- **Git** — status, selective commit, stage/unstage/discard, fetch, pull (ff-only or rebase), push,
  branches, merge, rebase with continue/skip/abort, stash, tags, history/revert, and pull-request links for
  GitHub, GitLab, Bitbucket Cloud, Bitbucket Server and Azure DevOps.
- **Tools** — VS Code, MATLAB (chosen release, generated startup script, Agentic Toolkit setup),
  Bitbucket, Jira (company MCP endpoint with OAuth/bearer, or a local connector with API token). Each has a
  tickbox and a **Test** button that checks installation, sign-in and connectivity and suggests the fix.
- **Models** — the agent's list plus your own entries, imported from TOML profiles (literal secrets are
  removed and must go to *API keys*). Removing a model never deletes its file.
- **API keys** — stored with Windows DPAPI / macOS Keychain / Linux Secret Service, passed to the agent as
  environment variables, never written into TOML.
- **Reliability** — drafts are saved on the server for every conversation; separate recovery messages for
  "app connection lost", "agent stopped" (Reconnect) and "conversation open in another Codex window";
  daily state backups with restore; diagnostic export with secrets and home path removed; update check.
- English, Français, Español, Deutsch; light and dark themes.

## 4. Development

```bash
npm test          # 40 unit + API tests (uses a protocol-faithful fake Codex)
npm run demo      # sandbox UI with sample data
node server.mjs   # server only; prints the URL with its session token
```

Project layout:

```
server.mjs            HTTP server, security checks, routes
lib/app.mjs           application core (conversations, folders, memory, tools, models)
lib/agents/codex.mjs  Codex adapter — codex app-server JSON-RPC (verified on codex-cli 0.166.0)
lib/agents/claude.mjs Claude Code adapter — stream-json
lib/memory.mjs        CONTEXT.md / INSTRUCTIONS.md, preview, snapshots, diff
lib/search.mjs        full-text search      lib/checks.mjs   integration tests
lib/git.mjs           Git operations        lib/support.mjs  backups, diagnostics, updates
public/               interface (no build step)
test/                 node:test suites and the fake Codex app-server
```

Security model: the server listens on 127.0.0.1 only, rejects foreign `Host`/`Origin` headers, requires a
random per-launch token on every API call, spawns processes with argument arrays (no shell), and never
returns secret values.

## 5. Known limits

- A conversation can be written by only one Codex process at a time. Close it in any Codex terminal
  before continuing it here (the app explains this when it happens).
- Windows-specific code paths (DPAPI, `.vbs` launcher, Edge app window, MATLAB under `Program Files`) are
  written for Windows but were validated only by review and on Linux equivalents; test them on your PC.
- Claude Code runs one process per message in print mode, so its approvals follow the action mode rather
  than interactive cards.
