// One-click add-ons. Every package, repository and endpoint below was checked on 2026-10-30
// (npm registry, GitHub, vendor documentation). Jobs stream their log to the UI.
import crypto from 'node:crypto';
import { which, resolveLaunch, spawnResolved, launchDetached } from './proc.mjs';

export const CATALOG = [
  // ---- AI agents (command-line) — each uses the account the user signs in with
  { id: 'codex-cli', category: 'agents', name: 'Codex CLI', vendor: 'OpenAI', description: 'Coding agent for ChatGPT/OpenAI accounts. After installing, sign in once by typing “codex” in a terminal.', install: { npm: '@openai/codex' }, detect: 'codex', site: 'https://developers.openai.com/codex' },
  { id: 'claude-code', category: 'agents', name: 'Claude Code', vendor: 'Anthropic', description: 'Coding agent for Claude accounts. After installing, sign in once by typing “claude” in a terminal.', install: { npm: '@anthropic-ai/claude-code' }, detect: 'claude', site: 'https://docs.claude.com/claude-code' },
  // ---- Gateways and local models
  { id: 'omniroute', category: 'gateways', name: 'OmniRoute', vendor: 'open source', description: 'Local AI gateway: one OpenAI-compatible endpoint (http://localhost:20128/v1) routing to many providers, with a dashboard to add accounts. Installs with npm, then the app starts it and adds it as a provider.', install: { npm: 'omniroute' }, detect: 'omniroute', start: { command: 'omniroute', health: 'http://localhost:20128/v1/models' }, provider: 'omniroute', site: 'https://github.com/diegosouzapw/OmniRoute' },
  { id: 'ollama', category: 'gateways', name: 'Ollama', vendor: 'open source', description: 'Run open models on your own computer. Install it from its website, then add the “Ollama” provider.', external: 'https://ollama.com/download', detect: 'ollama', provider: 'ollama', site: 'https://ollama.com' },
  // ---- Connectors (MCP servers) — added to Codex and Claude Code in one step
  { id: 'mcp-atlassian', category: 'connectors', name: 'Jira & Confluence (Atlassian)', vendor: 'Atlassian', description: 'Official Atlassian Rovo MCP server. Sign in with your Atlassian account in the browser (OAuth).', mcp: { name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp/authv2', oauth: true }, site: 'https://github.com/atlassian/atlassian-mcp-server' },
  { id: 'mcp-github', category: 'connectors', name: 'GitHub', vendor: 'GitHub', description: 'Official GitHub MCP server (issues, pull requests, code). Needs a GitHub personal access token.', mcp: { name: 'github', url: 'https://api.githubcopilot.com/mcp/', tokenName: 'GITHUB_PAT', tokenHelp: 'https://github.com/settings/tokens' }, site: 'https://github.com/github/github-mcp-server' },
  { id: 'mcp-playwright', category: 'connectors', name: 'Browser automation (Playwright)', vendor: 'Microsoft', description: 'Lets agents open web pages, click and read them.', mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, site: 'https://github.com/microsoft/playwright-mcp' },
  { id: 'mcp-context7', category: 'connectors', name: 'Up-to-date library docs (Context7)', vendor: 'Upstash', description: 'Gives agents current documentation for programming libraries.', mcp: { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, site: 'https://github.com/upstash/context7' },
  { id: 'mcp-memory', category: 'connectors', name: 'Knowledge graph memory', vendor: 'MCP reference', description: 'A persistent memory store the agent can read and update.', mcp: { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, site: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'mcp-thinking', category: 'connectors', name: 'Sequential thinking', vendor: 'MCP reference', description: 'Structured step-by-step reasoning tool.', mcp: { name: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }, site: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'mcp-filesystem', category: 'connectors', name: 'Files of a chosen folder', vendor: 'MCP reference', description: 'Read/write access to one folder you choose (useful for API-only agents).', mcp: { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], needsFolder: true }, site: 'https://github.com/modelcontextprotocol/servers' },
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

export async function startService(entry, job, jobs) {
  const exe = which(entry.start.command);
  if (!exe) { jobs.log(job, `${entry.start.command} is not installed yet.\n`); return false; }
  if (await healthy(entry.start.health)) { jobs.log(job, `${entry.name} is already running.\n`); return true; }
  jobs.log(job, `Starting ${entry.name}…\n`);
  await launchDetached(resolveLaunch(exe), []);
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1000)); if (await healthy(entry.start.health)) { jobs.log(job, `${entry.name} is running.\n`); return true; } }
  jobs.log(job, `${entry.name} did not answer on ${entry.start.health} within 30 s.\n`);
  return false;
}

export async function healthy(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.status < 500; } catch { return false; }
}
