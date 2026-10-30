# AI Management APP

One workbench for working with AI on real projects — for beginners and professionals alike.
Pick the AI you have an account with, open a project folder, and find everything about that project in one
window: conversations, files, shared memory, skills, connectors, Git, VS Code, MATLAB and Jira.

© 2026 Jack Salameh. All rights reserved (see `LICENSE`).

---

## 1. Which AIs it works with

| Type | Examples | What they can do |
|---|---|---|
| **AI agents on your computer** | Codex (OpenAI / ChatGPT account), Claude Code (Anthropic account) | Read your files, run commands, edit code — with approvals |
| **AI services by API key** | OpenAI, Anthropic, Google Gemini, Mistral, OpenRouter, DeepSeek, Groq, xAI, Azure OpenAI | Chat with streaming replies, images, shared memory |
| **Gateways & local models** | OmniRoute, Ollama, LM Studio, any OpenAI-compatible service | Same as API services, routed through one endpoint or run locally |

Add them in **Configuration › Accounts & providers**, or install them in one click from **Add-ons**.
API keys are stored with the operating system's protection (Windows DPAPI, macOS Keychain, Linux Secret
Service) and never written into configuration files.

## 2. Requirements and start

- **Node.js 22+** (https://nodejs.org). Nothing else is required to start the app.
- At least one AI: install Codex or Claude Code from *Add-ons* and sign in once in a terminal
  (`codex` / `claude`), **or** add an API service with its key.

| System | Double-click |
|---|---|
| Windows | `Launch (Windows).vbs` — or `Launch (Windows, with console).cmd` to see errors |
| macOS | `launch-macos.command` |
| Linux | `launch-linux.sh` |
| Any | `npm start` |

The app opens in its own window. **Closing the window (or the ⏻ button) quits the app and disconnects
every agent.** A first-time wizard sets language, Simple/Pro mode, accounts, a first folder and tools.

Try it safely first: `npm run demo` opens a sandbox with sample projects and simulated AIs.

Settings from *Codex Projects Management* (earlier name) are imported automatically on first start.

## 3. Everything in one place

- **Explorer** — your folders as on disk (`D:` › `X1191` › `Distance focal`) with their conversations.
  Click a folder to open its **project overview**: conversations, files with preview, shared memory, skills,
  Git status and README, plus *New conversation*, VS Code, MATLAB and Explorer buttons.
- **New conversation** — one window: choose the AI, give a title, and (optionally) a starting context and
  instructions, saved as `CONTEXT.md` / `INSTRUCTIONS.md` and refined as you work.
- **Chat** — streamed replies, commands with output, file diffs, approvals, model and reasoning effort beside
  Send, quick-start prompts and your own saved prompts, attachments (button, drag & drop, paste).
- **Memory workspace** — what will be sent, its size, what changed, pinned notes, linked files.
- **Search (Ctrl+K)** — every message, title and memory file, with folder and date filters.
- **Add-ons** — one-click: AI agents, OmniRoute (installs, starts and adds itself as a provider), Ollama,
  connectors (Jira & Confluence, GitHub, Playwright browser, Context7 docs, memory, sequential thinking,
  folder access) added to Codex and Claude Code together, and skill packs where you tick the skills you want.
- **Git** — full panel (selective commit, branches, merge, rebase, stash, tags, history) and pull-request
  links for GitHub, GitLab, Bitbucket Cloud/Server and Azure DevOps.
- **Simple / Pro** — Simple shows only what is needed to chat; Pro adds Git, action modes and advanced memory.
- **Reliability** — server-side drafts, clear recovery messages, backups with restore, redacted diagnostics,
  integration tests with suggested fixes in every tool card. English, Français, Español, Deutsch; light/dark.
- **Official tool icons** — *Configuration › Appearance › Download official icons* fetches each vendor's own
  website icon onto your computer (they are not shipped with the app), or upload your own.

## 4. Development

```bash
npm test          # 50 unit + API tests (protocol-faithful fake Codex, stub API providers)
npm run demo      # sandbox UI with sample data and simulated providers
node server.mjs   # server only; prints the URL with its session token
```

```
server.mjs              HTTP server, security checks, routes, quit-on-close
lib/app.mjs             application core
lib/agents/codex.mjs    Codex — codex app-server JSON-RPC (verified on codex-cli 0.166.0)
lib/agents/claude.mjs   Claude Code — stream-json
lib/agents/api.mjs      API services — OpenAI-compatible, Anthropic and Gemini wire formats
lib/providers.mjs       provider presets           lib/addons.mjs    one-click add-on catalog
lib/memory.mjs          CONTEXT/INSTRUCTIONS        lib/search.mjs    full-text search
lib/git.mjs  lib/tools.mjs  lib/checks.mjs  lib/support.mjs  lib/icons.mjs  lib/secrets.mjs
public/                 interface (no build step)   test/            node:test suites and fakes
```

Security: listens on 127.0.0.1 only, rejects foreign Host/Origin, random per-launch token on every API call,
processes spawned with argument arrays, secrets never returned by the API, downloaded SVG icons served sandboxed,
project-file access limited to your project folders.

## 5. Known limits

- A Codex conversation can be written by one Codex process at a time; close it in any terminal first.
- API services chat but do not run commands or edit files; use Codex or Claude Code for that.
- Windows-specific paths (DPAPI, `.vbs`, Edge app window, MATLAB, `npm.cmd`) were reviewed but not run on
  Windows here; real accounts (Jira, Bitbucket, paid models, OmniRoute) were not available for testing.
