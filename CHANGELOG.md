# Changelog

## 3.5.0 — 2026-10-30

### Fixed
- **A second folder appeared next to the conversation's folder**: a conversation created in a folder (e.g.
  `D:\Test`) had its session copy, `CONTEXT.md` and `INSTRUCTIONS.md` put in `<sessions folder>\<title>`.
  They now go into the folder you created the conversation in (into a sub-folder of it for a second conversation
  there). Folders already created that way are moved back automatically at start-up, only when they hold nothing
  else and no file would be overwritten. Sessions found on disk, Git repositories, drive roots and your home
  folder still use `<sessions folder>\<title>`, so nothing is written into existing projects.

- **The conversation's model was not shown, and not every model could be chosen**: opening a conversation selected
  the default model instead of the one the conversation uses (e.g. Claude Opus 5.5 recorded in a Claude Code
  session). The picker now selects the conversation's own model (added to the list if the AI no longer lists it),
  and a badge beside the title shows the model and reasoning level for the next message, then the model that
  actually answered (✓). With OmniRoute connected, the picker lists **your account's models and OmniRoute's
  together**, in two groups; each message goes through OmniRoute only when an OmniRoute model is chosen, otherwise
  to Anthropic with your Claude account (both can be used in the same conversation).

### New
- **Every Claude Code and Codex session on the computer is found and loaded.** The app searches Codex's folder
  (`%USERPROFILE%\.codex\sessions` and `archived_sessions`), Claude Code's folder (`%USERPROFILE%\.claude\projects`),
  the Claude desktop app's data folder (`%APPDATA%\Claude`), the sessions folder, and any folder or drive you add
  (Configuration › Sessions › “Search another folder or drive…”). It recognises Codex rollouts
  (`rollout-….jsonl` starting with `session_meta`) and Claude Code transcripts (`<uuid>.jsonl` with `sessionId`),
  wherever they are, skipping caches and `node_modules`. Titles come from the session (rename, AI title, desktop app
  title) or its first message.
- **Sessions found elsewhere are imported** into the agent's own folder (a copy; the original is untouched), so they
  appear in the Explorer and can be read *and continued*: verified with codex-cli 0.166 (a rollout copied into
  `sessions\YYYY\MM\DD\` is listed, read and resumed, even while the app-server runs). Claude Code sessions are
  placed under `projects\<encoded folder>\`, where `claude --resume` looks for them.
- **One folder per conversation** in a sessions folder you choose (asked once at start-up; suggested: the folder
  that holds the app, e.g. `D:\Claude`). Each folder is named after the conversation and holds `session.json`,
  an up-to-date copy of the session file, `TRANSCRIPT.md`, and — when you create them — **`CONTEXT.md` and
  `INSTRUCTIONS.md`, next to the session**. They are loaded with every message, like before.
- A session folder made by hand (or on another computer) is recognised by its `session.json` and linked to its
  conversation, with its title, its project folder and its memory files.
- A conversation recorded in a folder that does not exist on this computer (cloud session, Claude desktop app
  virtual machine) runs in the folder named in `session.json`, else in its session folder.
- **OmniRoute connected to Claude Code** (Configuration › Accounts & providers › Claude Code › “Use OmniRoute for
  Claude Code”): Claude Code started by the app gets `ANTHROPIC_BASE_URL` = the gateway root (no `/v1`),
  `ANTHROPIC_AUTH_TOKEN` = your OmniRoute key (kept in the system keychain, passed only in the process
  environment), `ANTHROPIC_MODEL` (optional, e.g. `glm/glm-5.2`) and model discovery; the gateway's models appear
  beside Send. “Connect and test” checks `/v1/models`. No Claude sign-in is needed while it is on.
- `scripts\move-agent-data-windows.cmd`: moves `%USERPROFILE%\.claude` and `.codex` to another drive (default:
  `AppData` next to the app's folder, e.g. `D:\Claude\AppData`) and leaves a directory junction, so Claude Code,
  Codex and this app write every new session there. No administrator rights; safe to run again.
- Configuration › Sessions: the sessions folder, the places searched, “Find sessions now”, the last search's
  result and the list of imported sessions. The conversation header shows the session folder (click to open it).

## 3.4.1 — 2026-10-30

### New
- **Sign in to your AI accounts from the app** (Configuration › Accounts & providers, the AI menu in the top bar,
  and a banner in any conversation whose AI is not signed in):
  - **Claude Code**: “Sign in with my Claude account” opens a window running Claude Code's own `claude auth login`
    (browser sign-in, Claude subscription) — or the Anthropic Console for API billing; the app follows
    `claude auth status` and shows “Signed in” as soon as it is done.
  - **Codex**: “Sign in with ChatGPT” opens the OpenAI sign-in page (Codex `account/login/start`); the app is told
    when it completes and shows the account e-mail and plan; or use an OpenAI API key.
- A reply that fails because the AI is not signed in now offers the sign-in instead of only showing the error.

## 3.4.0 — 2026-10-30

### Fixed
- **Existing context and instructions were not found**: version 1.x kept them in
  `<drive or parent>\.codex-projects\conversations\<Title>--<id>\CONTEXT.md / INSTRUCTIONS.md` (e.g.
  `D:\.codex-projects\…`), a place the rebuild never searched. They are now found from the conversation folder up
  to the drive root, matched by the thread id or rollout name written on line 1 (else by title), loaded, editable,
  and shown as “CONTEXT.md (from version 1)”. Folder-level 1.x memory (`.codex-projects\folders\`) too.
  Any other `.md` / `.txt` file can be added by hand (Memory workspace › “Use a file as context…”).
- **A new reasoning level seemed ignored**: the level chosen in the composer is now saved with the conversation at
  once (it was lost when switching conversation or reloading before sending); the status chip shows the level
  requested, then the level Codex confirms (✓) from `thread/settings/updated` or from the thread after the reply —
  it used to read the thread too early and show the previous level. A mismatch is flagged.
- Two settings changed within 300 ms could cancel each other (now merged).
- An error inside one agent event could stop the conversation's event stream (now isolated and logged).

### New
- **Tokens: In / Out / Cache**, always the three values, for every AI:
  Codex (live `thread/tokenUsage/updated`, and from the rollout's `token_count` events for older conversations),
  Claude Code (turn result; session files summed once per API message), API services (Anthropic message_start /
  message_delta, OpenAI-compatible `stream_options.include_usage` with cached prompt tokens split out, Gemini
  usageMetadata). Tooltip: cache read vs written, reasoning tokens, last turn, context window used, and a
  cache-weighted input (reads × 0.1, writes × 1.25 — the convention used by Trail-Code's benchmark).
- **Trail (trailhq/Trail-Code)** in Add-ons › Ways of working, and a “Code map & learnings” card in the project
  overview: set up in the folder (`trail init --yes <folder>`), list the repository's learnings, “Save what we learned”.

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
