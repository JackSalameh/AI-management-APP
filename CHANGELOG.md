# Changelog

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
