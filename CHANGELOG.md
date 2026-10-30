# Changelog

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
