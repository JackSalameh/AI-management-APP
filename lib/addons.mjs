// One-click add-ons. Every package, repository and endpoint below was checked on 2026-10-30
// (npm registry, GitHub, vendor documentation). Jobs stream their log to the UI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { which, resolveLaunch, spawnResolved, launchDetached } from './proc.mjs';

export const CATALOG = [
  // ---- AI agents (command-line) — each uses the account the user signs in with
  { id: 'codex-cli', category: 'agents', name: 'Codex CLI', vendor: 'OpenAI', description: 'Coding agent for ChatGPT/OpenAI accounts. After installing, sign in once by typing “codex” in a terminal.', install: { npm: '@openai/codex' }, detect: 'codex', site: 'https://developers.openai.com/codex' },
  { id: 'claude-code', category: 'agents', name: 'Claude Code', vendor: 'Anthropic', description: 'Coding agent for Claude accounts. After installing, sign in once by typing “claude” in a terminal.', install: { npm: '@anthropic-ai/claude-code' }, detect: 'claude', site: 'https://docs.claude.com/claude-code' },
  // ---- Gateways and local models
  { id: 'omniroute', category: 'gateways', name: 'OmniRoute', vendor: 'open source', description: 'Local AI gateway: one OpenAI-compatible endpoint (http://localhost:20128/v1) routing to many providers, with a dashboard to add accounts. Installs with npm, then the app starts it and adds it as a provider; Claude Code can also use it (Configuration › Accounts › Claude Code › Use OmniRoute).', install: { npm: 'omniroute' }, detect: 'omniroute', start: { command: 'omniroute', args: ['--no-open'], health: 'http://localhost:20128/v1/models', wait: 120 }, provider: 'omniroute', site: 'https://github.com/diegosouzapw/OmniRoute' },
  { id: 'ollama', category: 'gateways', name: 'Ollama', vendor: 'open source', description: 'Run open models on your own computer. Install it from its website, then add the “Ollama” provider.', external: 'https://ollama.com/download', detect: 'ollama', provider: 'ollama', site: 'https://ollama.com' },
  // ---- Connectors (MCP servers) — added to Codex and Claude Code in one step
  { id: 'mcp-atlassian', category: 'connectors', name: 'Jira & Confluence (Atlassian)', vendor: 'Atlassian', description: 'Official Atlassian Rovo MCP server. Sign in with your Atlassian account in the browser (OAuth).', mcp: { name: 'atlassian', url: 'https://mcp.atlassian.com/v2/mcp?tools=all', oauth: true }, site: 'https://github.com/atlassian/atlassian-mcp-server' },
  { id: 'mcp-github', category: 'connectors', name: 'GitHub', vendor: 'GitHub', description: 'Official GitHub MCP server (issues, pull requests, code). Needs a GitHub personal access token.', mcp: { name: 'github', url: 'https://api.githubcopilot.com/mcp/', tokenName: 'GITHUB_PAT', tokenHelp: 'https://github.com/settings/tokens' }, site: 'https://github.com/github/github-mcp-server' },
  { id: 'mcp-playwright', category: 'connectors', name: 'Browser automation (Playwright)', vendor: 'Microsoft', description: 'Lets agents open web pages, click and read them.', mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, site: 'https://github.com/microsoft/playwright-mcp' },
  { id: 'mcp-context7', category: 'connectors', name: 'Up-to-date library docs (Context7)', vendor: 'Upstash', description: 'Gives agents current documentation for programming libraries.', mcp: { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, site: 'https://github.com/upstash/context7' },
  { id: 'mcp-memory', category: 'connectors', name: 'Knowledge graph memory', vendor: 'MCP reference', description: 'A persistent memory store the agent can read and update.', mcp: { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, site: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'mcp-thinking', category: 'connectors', name: 'Sequential thinking', vendor: 'MCP reference', description: 'Structured step-by-step reasoning tool.', mcp: { name: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }, site: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'mcp-filesystem', category: 'connectors', name: 'Files of a chosen folder', vendor: 'MCP reference', description: 'Read/write access to one folder you choose (useful for API-only agents).', mcp: { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], needsFolder: true }, site: 'https://github.com/modelcontextprotocol/servers' },
  // ---- Ways of working (checked 2026-10-30 against each project's README and package registry)
  { id: 'spec-kit', category: 'workflows', name: 'Spec Kit — spec-driven development', vendor: 'GitHub (MIT)', description: 'Write the specification first, then the plan, the tasks, and only then the code. Installs the “specify” command; the project overview then sets it up per folder and runs each phase with your AI.', install: { python: 'specify-cli' }, detect: 'specify', site: 'https://github.com/github/spec-kit' },
  { id: 'ponytail', category: 'workflows', name: 'Ponytail — write less code', vendor: 'open source', description: 'A rule set that makes the agent reuse existing code, the standard library and installed packages before writing anything new. Installed as a plugin in Codex and Claude Code.', plugin: { repo: 'DietrichGebert/ponytail', name: 'ponytail', marketplace: 'ponytail' }, site: 'https://github.com/DietrichGebert/ponytail' },
  { id: 'ecc', category: 'workflows', name: 'ECC — Everything Claude Code', vendor: 'open source (MIT)', description: 'Large collection of agents, skills, hooks and rules (planning, code review, security scan, TDD, session memory). Installed as a plugin in Codex and Claude Code; install only one ECC method per agent.', plugin: { repo: 'affaan-m/ECC', name: 'ecc', marketplace: 'ecc' }, site: 'https://github.com/affaan-m/everything-claude-code' },
  { id: 'trail', category: 'workflows', name: 'Trail — code map and team learnings', vendor: 'trailhq (MIT)', description: 'Gives Codex and Claude Code a map of your code (functions, callers) and keeps the decisions each session works out as short “learnings” in the repository, so agents read less and repeat less. Installs with npm (it compiles code parsers: on Windows this may need the Visual Studio Build Tools); then “Set up” per folder in the project overview.', install: { npm: '@trailhq/trail-code' }, detect: 'trail', site: 'https://github.com/trailhq/Trail-Code' },
  { id: 'rea', category: 'workflows', name: 'REA — Reverse Engineer Anything', vendor: 'open source (MIT)', description: 'Lets agents open an application, recover readable code and trace how a feature works, then rebuild it in your stack. Needs Ghidra 12.1.2 with JDK 21 (or Hopper on macOS); Windows support is experimental. Use it only on software you are allowed to analyse.', mcp: { name: 'rea', command: 'npx', args: ['-y', 'rea-agents@6.8.0', 'mcp'] }, site: 'https://github.com/morluto/rea' },
  // ---- Skill packs
  { id: 'skills-anthropic', category: 'skills', name: 'Anthropic skills', vendor: 'Anthropic', description: 'Document, spreadsheet, presentation, PDF and design skills. Pick the ones you want.', skills: 'anthropics/skills', site: 'https://github.com/anthropics/skills' },
  { id: 'skills-openai', category: 'skills', name: 'OpenAI skills', vendor: 'OpenAI', description: 'Skills catalog for Codex. Pick the ones you want.', skills: 'openai/skills', site: 'https://github.com/openai/skills' },
];

export class Jobs {
  constructor(emit) { this.emit = emit; this.jobs = new Map(); }
  create(title) {
    const job = { id: crypto.randomUUID(), title, status: 'running', log: '', startedAt: Date.now() };
    this.jobs.set(job.id, job); this.emit({ type: 'job.update', job }); return job;
  }
  log(job, text) { job.log = (job.log + text).slice(-20000); this.emit({ type: 'job.update', job: { ...job } }); }
  done(job, ok, message) { job.status = ok ? 'done' : 'failed'; if (message) job.log += `\n${message}`; this.emit({ type: 'job.update', job: { ...job } }); }
  list() { return [...this.jobs.values()].slice(-20); }
}

/** npm install -g with a streamed log. On Windows npm is npm.cmd and needs a shell; the arguments are fixed strings. */
export function npmInstallGlobal(pkg, job, jobs) {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(pkg)) return Promise.reject(new Error('Invalid package name'));
  const npm = which('npm');
  if (!npm) return Promise.reject(new Error('npm was not found. Install Node.js from https://nodejs.org (npm is included).'));
  return new Promise((resolve) => {
    jobs.log(job, `$ npm install -g ${pkg}\n`);
    const child = spawnResolved(resolveLaunch(npm), ['install', '-g', pkg], { env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => jobs.log(job, d.toString()));
    child.stderr.on('data', (d) => jobs.log(job, d.toString()));
    child.on('error', (e) => { jobs.log(job, e.message); resolve(false); });
    child.on('close', (code) => {
      if (code !== 0 && process.platform !== 'win32') jobs.log(job, '\nIf this is a permission error, configure npm to use a folder in your home: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally');
      resolve(code === 0);
    });
  });
}

/** Runs one fixed command (no shell) and streams its output into the job log. */
export function runJob(command, args, job, jobs, { cwd, env } = {}) {
  const exe = which(command);
  if (!exe) return Promise.resolve({ ok: false, missing: true });
  return new Promise((resolve) => {
    jobs.log(job, `$ ${command} ${args.join(' ')}\n`);
    const child = spawnResolved(resolveLaunch(exe), args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => jobs.log(job, d.toString()));
    child.stderr.on('data', (d) => jobs.log(job, d.toString()));
    child.on('error', (e) => { jobs.log(job, e.message + '\n'); resolve({ ok: false }); });
    child.on('close', (code) => resolve({ ok: code === 0 }));
  });
}

/** Python command-line tools: uv (recommended by Spec Kit), else pipx. */
export async function pythonToolInstall(pkg, job, jobs) {
  if (!/^[a-z0-9._-]+$/i.test(pkg)) throw new Error('Invalid package name');
  if (which('uv')) return (await runJob('uv', ['tool', 'install', '--upgrade', pkg], job, jobs)).ok;
  if (which('pipx')) return (await runJob('pipx', ['install', '--force', pkg], job, jobs)).ok;
  jobs.log(job, 'Neither uv nor pipx was found. Install uv first: https://docs.astral.sh/uv/getting-started/installation/ (one command), then click Install again.\n');
  return false;
}

/**
 * Starts a local service in the background (no window) and waits until it answers. What it prints goes to
 * `logFile`; when it does not come up, the end of that log is shown in the job so the cause is visible.
 */
export async function startService(entry, job, jobs, { logFile } = {}) {
  const exe = which(entry.start.command);
  if (!exe) { jobs.log(job, `${entry.start.command} is not installed yet (Add-ons › ${entry.name} › Install).\n`); return false; }
  if (await healthy(entry.start.health)) { jobs.log(job, `${entry.name} is already running.\n`); return true; }
  jobs.log(job, `Starting ${entry.name}: ${exe} ${(entry.start.args || []).join(' ')}\n`);
  let fd = 'ignore';
  if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fd = fs.openSync(logFile, 'w'); } catch { fd = 'ignore'; } }
  let exited = null;
  try {
    const child = spawnResolved(resolveLaunch(exe), entry.start.args || [], { detached: true, stdio: ['ignore', fd, fd] });
    child.once('exit', (code) => { exited = code; });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref();
  } catch (e) { jobs.log(job, `Could not start ${exe}: ${e.message}\n`); return false; }
  finally { if (typeof fd === 'number') fs.closeSync(fd); }
  const wait = entry.start.wait || 30;
  for (let i = 0; i < wait; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthy(entry.start.health)) { jobs.log(job, `${entry.name} is running.\n`); return true; }
    if (exited !== null) break;
  }
  jobs.log(job, exited !== null ? `${entry.name} stopped (exit code ${exited}).\n` : `${entry.name} did not answer on ${entry.start.health} within ${wait} s.\n`);
  if (logFile) { try { jobs.log(job, `Last lines it printed (${logFile}):\n${fs.readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-30).join('\n')}\n`); } catch { /* no log */ } }
  return false;
}

export async function healthy(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.status < 500; } catch { return false; }
}
