# Instructions — Codex Projects Management

Working rules agreed with the owner (Jack Salameh). Refine as preferences stabilise.

## Collaboration style
- Scientific, structured, precise. Explain *why* a design choice was made, not only *what*: the owner is building durable competence in Git, VS Code and AI tooling.
- State clearly what was verified, how, and what remains unverified (e.g. Windows-only paths tested only by code review).
- Never claim a feature works without a test or a reproducible check.

## Product requirements
- Replace the Codex command window entirely: open any existing conversation, create conversations in existing or new folders, on any drive.
- Explorer-style tree derived automatically from each user's conversation folders (e.g. `D:` → `X1191` → `Distance focal` → conversations). New folder and New conversation at folder level.
- ⋯ menu on each folder and conversation: rename (on disk for folders), archive, move to trash, restore, permanent delete (typed confirmation).
- Model and reasoning effort beside Send; effort choices come from the selected model. Changes apply to the next turn and are saved to `config.toml`.
- Users manage their model list (add, remove, import TOML profiles) without deleting source files.
- Show the agent's work like the CLI: commands, output, file diffs, tool calls, approvals. Private reasoning stays hidden.
- Per-conversation action mode: Ask first / Read only / Allow project changes / Codex default.
- CONTEXT.md and INSTRUCTIONS.md for every folder and conversation, linkable across conversations, improved collaboratively; rollout filename as an HTML comment on line 1 of conversation CONTEXT.md.
- Tools with tickbox activation and their own configuration cards: VS Code, MATLAB (preferred release, Agentic Toolkit), Git (full command set incl. fetch/rebase/stash/tags), Bitbucket (Cloud & Server PR links), Jira (remote MCP with OAuth/bearer, or local connector).
- Skills and plugins from a local folder or a GitHub URL, folder or global scope, never destroying existing installs.
- Light/dark themes; English, Français, Español, Deutsch with flags; collapsible sidebar; tooltips on every icon; dialogs close on outside click.
- Works for any OS user: no personal data, paths or credentials in the repository.

## Engineering rules
- No secrets in code, logs, chat or TOML; store them with the OS facility (DPAPI / Keychain / Secret Service) and pass them to agents as environment variables.
- Local server binds to 127.0.0.1, checks Host/Origin and a launch token on every API call.
- Spawn processes with argument arrays; never interpolate user input into a shell string.
- Every bug fix gets a regression test (`npm test`).
- Do not deploy or push anywhere unless the owner explicitly asks.
