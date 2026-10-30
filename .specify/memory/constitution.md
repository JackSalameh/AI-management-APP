# AI Management APP Constitution

Owner: Jack Salameh. Derived from INSTRUCTIONS.md (the working rules agreed with the owner); when the two differ,
update both in the same change.

## Core Principles

### I. One place per project
Everything a user needs for a project (conversations, files, context and instructions, Git, Jira, Bitbucket,
MATLAB, add-ons) is reachable from the app without opening another window. A new capability is added to the
project overview, the conversation or the Connections menu — not as a separate tool.

### II. Universal and honest about accounts
The app works with whichever AI the user has an account with (Codex, Claude Code, API services). Only agents and
integrations that can be verified are supported; models and reasoning levels come from the user's own account.

### III. Secrets never leave the OS keychain (NON-NEGOTIABLE)
No token, password or key in code, logs, chat, config files or command lines. Secrets are stored with DPAPI /
Keychain / Secret Service and handed to child processes through environment variables or a per-command
credential helper. API answers never echo a secret.

### IV. Verified before claimed (NON-NEGOTIABLE)
No feature is reported as working without an automated test or a reproducible check. Every bug fix gets a
regression test. Platform-specific behaviour that could not be executed is reported as unverified.

### V. Write only what the task needs
Zero runtime npm dependencies. Before writing code: reuse existing code, then the Node.js standard library,
then a platform feature (Git, the OS), and only then new code — the smallest that works, without dropping
validation, error handling, security or accessibility.

## Security constraints
- Local server on 127.0.0.1 only; Host/Origin checks and a per-launch token on every API call; strict CSP.
- Processes are spawned with argument arrays; user input is never interpolated into a shell string.
- File access is limited to the user's project folders; remote addresses are validated (https, or loopback for tests).

## Development workflow
- Spec-driven: a change starts as `specs/NNN-name/spec.md` (what and why), then `plan.md` (how), then
  `tasks.md` (checklist), then the implementation task by task.
- Gates before a version is validated: `npm test` green, browser suites green, CHANGELOG/README/CONTEXT updated.
- Interface texts exist in English, French, Spanish and German.
- Nothing is deployed or pushed unless the owner asks; commits are authored by the owner.

## Governance
This constitution guides every specification, plan and review. Amendments are made in the same commit as the
corresponding INSTRUCTIONS.md change, with a version bump below.

**Version**: 1.0.0 | **Ratified**: 2026-10-30 | **Last Amended**: 2026-10-30
