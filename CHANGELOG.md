# Changelog

## 3.3.0 — 2026-10-30

### New
- **Connections menu** (plug icon in the top bar), one place to connect everything once:
  - **Jira**: site + e-mail + API token, checked before anything is saved; the AI agents get the same access
    (Atlassian MCP). **Jira panel**: my open issues / reported / watching / recent, project filter, text or key
    search, issue detail (description, comments, sub-tasks), comment, change status, assign to me, create issue,
    and **“Work on it with the AI”** (the issue goes to the conversation).
  - **Bitbucket Cloud**: e-mail + scoped API token (also used by Git over HTTPS and by the agents). **Bitbucket
    panel**: workspaces, repositories, pull requests (open / merged / declined) with their diff, approve, comment,
    merge, decline, **“Review with the AI”**, clone in one click, pull request from the current folder.
  - **Git**: commit identity (user.name / user.email), accounts for GitHub, GitLab, Bitbucket, Azure DevOps or a
    company server with an HTTPS token (kept in the keychain, given to Git per command, never on a command line),
    an SSH key (create, copy, test) or the computer's credential manager; **my repositories** with one-click
    clone into a folder (added to the Explorer); **publish a folder** (init, create the repository on
    GitHub/GitLab/Bitbucket or paste an address, push). Git panel: Publish… and Accounts buttons; pull requests
    to bitbucket.org are created through the API when Bitbucket is connected.
  - **MATLAB**: the MCP connection card (which agent, copied configuration, live state).
- **Your context files are found and loaded**: any `context.md` / `instructions.md` (any case, also
  `projet_context.md`, `Context X1191.md`, `contexte.md`, `consignes.md`…) in the conversation folder, its
  `docs/`, `context/`, `memory/`… sub-folders and up to six parent folders. A **“Loaded: …”** bar under the title
  shows them (click to edit); the memory workspace lists the folders searched.
- **Asked only when needed**: when the conversation's folder has no such file, the app asks once whether to
  create `CONTEXT.md` and `INSTRUCTIONS.md` — now as visible files in that folder; “No” creates nothing. The new
  conversation window shows the files already found and can append to them.
- **Keep the files up to date**: every 5–10 prompts (Configuration › General, or never) the app asks whether to
  update them **automatically** (Codex / Claude Code edit the files; for API chats the AI returns the new content
  and the app writes only the expected files) or **manually** (editor), or later; the choice can be remembered.
- **Files panel**: new “In this folder” section (folder contents, two levels) with the loaded files marked.
- **Ways of working** (Add-ons): **Spec Kit** (GitHub; installed with uv or pipx), **Ponytail** (write less code)
  and **ECC** (agents, skills, hooks) installed as plugins in Codex and Claude Code, **REA** (reverse engineering,
  MCP server pinned to rea-agents 6.8.0).
- **Spec-driven development card** in the project overview: set up Spec Kit in the folder for Codex or Claude
  Code, run each phase (principles, specify, clarify, plan, tasks, analyze, implement) — natively as a skill for
  Codex/Claude Code, as instructions for API chats — and follow each feature's documents and task progress.
- **Checkpoints**: before each message, the files of a Git folder are snapshotted (private refs, branch/index/
  history untouched); preview what changed and restore, with an automatic safety checkpoint to undo.
- **Desktop notifications** (opt-in) when a reply ends or needs approval while the window is in the background.
- This repository now uses Spec Kit itself: `.specify/memory/constitution.md` (from INSTRUCTIONS.md) and
  `specs/003-connections-memory-workflows/` (spec, plan, tasks of this release).

### Fixed
- Context/instruction files kept directly in a folder were never read (only the app's hidden `.cpm/` files).
- Git panel “Add remote” called an operation the server did not implement.
- Jira/Bitbucket buttons required ticking the tool first; they now open the panel or the Connections menu.

## 3.2.0 — 2026-10-30

### New
- **MATLAB ↔ agents (MCP)**: the app asks one question — which agent uses MATLAB (Codex, Claude Code or both) —
  then copies, field for field, the MATLAB MCP configuration that MathWorks' `setupAgenticToolkit("install")`
  already wrote (Codex `config.toml` or Claude Code `~/.claude.json`), or an MCP JSON you import, or the detected
  `~/.matlab/agentic-toolkits/bin/matlab-mcp-server`. When MATLAB is launched from the app, its session is shared
  (`satk_initialize`, `shareMATLABSession`) and the MCP connection is established and reported live.
- **Jira and Bitbucket ↔ agents (MCP)**: official Atlassian MCP server, with browser sign-in (Jira/Confluence),
  personal API token (e-mail + token, Basic auth) or service-account key. Tokens stay in the OS keychain and
  reach Codex through environment variables (`env_http_headers`); the card shows the live connection state.
- **Your own context.md / instructions.md are loaded**: any `context.md`, `instructions.md` (any case, also
  `projet_context.md`, `contexte.md`, `consignes.md`…) in the conversation folder and up to three parent folders
  are sent with the conversation, whether or not the app's own memory files were created. The first-open
  question lists them.
- Official Atlassian logomarks for Jira and Bitbucket are taken from Atlassian's logo packs (ZIP); icons are
  refetched once after this update.

### Fixed
- VS Code, MATLAB and Git buttons appeared twice (top bar and project header) — now only in the top bar.
- Buttons with a slow action (Connect, Install, Test, Fetch icons) stayed disabled or threw an error, because
  `e.currentTarget` is `null` after an `await`; the button is now captured first (regression test added).
- Tests read the real Claude Code sessions of the machine running them (`CLAUDE_CONFIG_DIR` not isolated).

## 3.1.0 — 2026-10-30

### New
- Official tool icons appear automatically: on first start the app downloads each vendor's official image
  (VS Code brand icon, Git logo, MATLAB, Jira — from your own Jira site when configured — Bitbucket, OpenAI,
  Claude) to your data folder; retried daily while any is missing; uploads are never overwritten.
- Models and reasoning levels come from your account: Codex `model/list`; Claude Code effort levels read from
  the installed CLI, models from aliases, your default, your Anthropic key and your past sessions; API services
  from their `/models` endpoints with reasoning levels from provider metadata (OpenRouter, Gemini) or documented
  model families. "↻ Detect my models again" in the model list; ★ marks your default.
- Files panel per conversation: files changed (with this conversation's diff) and read by the agent,
  attachments, memory files; preview, open in VS Code or the file explorer.

### Fixed (found by tests)
- Code highlighter broke on the word "class" inside its own markup (previews showed `class="tk-num">`).


## 3.0.0 — 2026-10-30 — renamed **AI Management APP**

### New
- Any provider: Codex and Claude Code agents, plus API services (OpenAI, Anthropic, Google Gemini, Mistral,
  OpenRouter, DeepSeek, Groq, xAI, Azure OpenAI) and gateways/local models (OmniRoute, Ollama, LM Studio,
  any OpenAI-compatible URL). Streaming, images, shared memory as system prompt, Stop.
- Accounts & providers screen; status pill for all AIs; provider choice in the new-conversation window.
- Project overview per folder: conversations, files with preview, memory, skills, Git, README.
- Add-ons: one-click install of agents, OmniRoute (install + start + provider), connectors for Codex and
  Claude Code (Atlassian, GitHub, Playwright, Context7, memory, sequential thinking, filesystem), skill packs
  with a picker. Progress logs.
- New conversation in one window: AI, title, optional context and instructions.
- Attachments (button, drag & drop, paste), quick-start and saved prompts, Simple/Pro mode.
- Official tool icons downloaded from vendor sites on request, or uploaded; served sandboxed.
- Closing the window or ⏻ stops all agents (ends account connections) and quits; window closes.
- Automatic import of settings and keys from Codex Projects Management.

### Removed
- Gemini CLI agent (could not be validated with a real account; Google Gemini remains available by API key).

### Fixed during this build (found by tests)
Add-ons button passed its click event as the category · server kept keep-alive connections on quit ·
keychain entries saved under the old product name would have been lost after the rename.


## 2.0.0 — 2026-10-30 (clean rebuild, signed by Jack Salameh)

Rebuilt from scratch from the v1.x transcript. Zero runtime dependencies; Windows, macOS, Linux.

### New
- Explorer derived from real folders, folder/conversation actions, drag-to-move, archive and trash.
- Codex adapter on `codex app-server` (verified on 0.166.0) and a Claude Code adapter.
- Opt-in memory: setup window (title + context + instructions) for new conversations; one-time question
  for existing ones; nothing is created if declined.
- Memory workspace: preview, token estimate, per-file inclusion, pinned notes, diff since last send.
- Full-text search (Ctrl+K) over messages, titles and memory with folder/date filters.
- Turn status, Codex-acknowledged model/effort, token usage.
- Integration tests per tool with suggested fixes; onboarding wizard; About with update check,
  backups/restore and redacted diagnostics.
- Server-side drafts; stable per-user port; incremental refresh; paged history.
- Full Git panel and pull-request links for 5 hosting services.

### Fixed (from v1.x)
`\\?\` paths split folders · empty conversations vanished · effort change lost when clicking Send quickly ·
MATLAB `-r` quoting · `changes.map is not a function` · writer-lock message · Quit/Reconnect ·
`EPERM mkdir D:\` blocking Send · injected context shown as the user's message · unsupported efforts
offered · Windows `.cmd` spawn failure.

### Fixed during this build (found by tests)
`D:` normalised to `D:.` · approval key overwritten by conversation key · crash status hidden by
auto-restart · start/stop race · `thread/read` history unsupported on 0.166 for empty threads (now
`thread/turns/list`) · drafts lost on restart (random port) · `"null"` text in DOM · stuck "Running"
after fast replies · stacked Configuration dialogs · Windows paths with spaces in logo lookup.
