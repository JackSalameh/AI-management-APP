# Feature Specification: Connections, project memory and ways of working (3.3)

**Feature Branch**: `003-connections-memory-workflows` · **Created**: 2026-10-30 · **Status**: Implemented

## User scenarios

### US1 — Connect Jira and Bitbucket once, then work with them (P1)
The user opens **Connections**, enters the Jira site, e-mail and API token (or the Bitbucket e-mail and token).
The app checks the credentials before saving anything, connects the AI agents through the Atlassian MCP server,
and lets the user list, read, comment, transition, assign and create issues, browse repositories, read pull
requests with their diff, approve, merge, decline and create pull requests — and hand an issue or a pull request
to the AI in one click.

**Acceptance**: wrong token → clear 401 message and nothing stored; right token → "Connected as …", agents'
MCP status "connected", tokens never returned by the API.

### US2 — Connect Git accounts and manage remotes (P1)
The user sets the commit identity, adds GitHub / GitLab / Bitbucket / other accounts (HTTPS token kept in the
keychain, or SSH key generated and tested), lists their repositories, clones into a folder (added to the
Explorer), and publishes a local folder (init, create the remote repository, add origin, push).

**Acceptance**: `git credential fill` returns the right token per host; the token never appears on a command line.

### US3 — Existing context and instruction files are loaded (P1)
Any `context.md` / `instructions.md` (any case, prefixed names, FR/ES/DE variants) in the conversation folder,
its docs-like sub-folders and up to six parent folders is sent to the AI and shown as "Loaded: …". If the
conversation's own folder has none, the app asks once whether to create `CONTEXT.md` and `INSTRUCTIONS.md`
there (visible files); "No" creates nothing.

### US4 — Keep the memory files up to date (P2)
Every N prompts (5–10, or never) the app asks: update automatically (the AI edits the files; API chats return
the files and the app writes them) or manually (editor), or later; the choice can be remembered.

### US5 — Ways of working (P2)
One-click installation of Spec Kit, Ponytail, ECC and REA; Spec Kit set up per folder with phase buttons and
feature progress; checkpoints before each AI turn with preview and restore; desktop notifications.

## Requirements
- FR-001 Credentials are verified against the service before they are stored.
- FR-002 Jira REST v3 (search/jql, issue, transitions, comment, assignee, project search, create); Bitbucket
  Cloud REST 2.0 (workspaces, repositories, pull requests, diff, approve, comment, merge, decline, create).
- FR-003 Git network commands receive tokens through a one-command credential helper reading environment variables.
- FR-004 Checkpoints never modify the user's branch, index, stash or history (refs/cpm/… only).
- FR-005 All new texts in EN/FR/ES/DE.

## Success criteria
- SC-001 Every scenario above is covered by an automated API test and a browser test.
- SC-002 No secret value appears in any API response, log or command line (asserted in tests).
