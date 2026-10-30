// Claude Code adapter: one `claude -p --output-format stream-json` process per turn.
// Conversations are Claude Code sessions (~/.claude/projects/<encoded cwd>/<session>.jsonl), resumed with --resume.
// Flags verified against Claude Code 2.1.314 (`claude --help`).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { which, resolveLaunch, spawnResolved } from '../proc.mjs';
import { normalizePath } from '../paths.mjs';
import { splitUserText } from '../items.mjs';
import { fromAnthropic } from '../usage.mjs';
import { runResolved, openInTerminal } from '../proc.mjs';
import { claudeHead, claudeProjectDir } from '../sessions.mjs';

/** claude-opus-5-5 → Claude Opus 5.5; claude-sonnet-4-5-20250929 → Claude Sonnet 4.5 (date dropped). */
export function claudeLabel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id || ''));
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id;
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODE_MAP = { ask: 'manual', project: 'acceptEdits', readonly: 'plan', full: 'bypassPermissions' };

export class ClaudeAgent extends EventEmitter {
  constructor({ bin, env = process.env, claudeHome } = {}) {
    super();
    this.id = 'claude'; this.label = 'Claude Code';
    this.binSetting = bin; this.baseEnv = env; this.extraEnv = {};
    this.home = claudeHome || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.activeTurns = new Map(); // sessionId -> child
    this.gateway = null;          // { label, env } when Claude Code goes through a gateway (OmniRoute…)
    this.state = 'idle'; this.loaded = new Map();
  }

  findBinary() {
    for (const c of [this.binSetting, this.baseEnv.CPM_CLAUDE_BIN, 'claude', path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')].filter(Boolean)) {
      const p = which(c, this.baseEnv); if (p) return p;
    }
    return null;
  }

  available() { return !!this.findBinary(); }
  status() { const bin = this.findBinary(); return { id: this.id, label: this.label, state: bin ? 'ready' : 'missing', error: bin ? null : 'Claude Code CLI not found', signedIn: this.auth ? this.auth.loggedIn : null, gateway: this.gateway ? { label: this.gateway.label, baseUrl: this.gateway.env.ANTHROPIC_BASE_URL, model: this.gateway.env.ANTHROPIC_MODEL || null } : null, activeTurns: Object.fromEntries([...this.activeTurns.keys()].map((k) => [k, 'running'])) }; }

  #launch() { const bin = this.findBinary(); return bin ? resolveLaunch(bin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' }) : null; }

  /** `claude auth status --json` → { loggedIn, method, provider }. */
  async account() {
    const launch = this.#launch();
    if (!launch) return { installed: false, loggedIn: false };
    const r = await runResolved(launch, ['auth', 'status', '--json'], { timeout: 30_000, env: { ...this.baseEnv, ...this.extraEnv } });
    let j = null; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* old CLI or not signed in */ }
    this.auth = { loggedIn: !!j?.loggedIn, method: j?.authMethod || null, provider: j?.apiProvider || null, checkedAt: Date.now() };
    return { installed: true, ...this.auth, gateway: this.gateway?.label || null, detail: j ? null : (r.stderr || r.stdout).trim().slice(0, 300) };
  }

  /** Opens a terminal window with Claude Code's own sign-in (browser), for a Claude subscription or the Console. */
  async login({ method = 'claudeai' } = {}) {
    const launch = this.#launch();
    if (!launch) throw new Error('Claude Code is not installed. Add-ons › AI agents › Claude Code.');
    await openInTerminal(launch, ['auth', 'login', method === 'console' ? '--console' : '--claudeai'], 'Sign in to Claude');
    return { opened: 'terminal' };
  }
  setEnv(e) { this.extraEnv = { ...e }; }
  /**
   * Claude Code through an Anthropic-compatible gateway (verified variables, OmniRoute wiki "Claude Code Configuration"):
   * ANTHROPIC_BASE_URL = gateway root without /v1 (Claude Code appends /v1/messages), ANTHROPIC_AUTH_TOKEN = Bearer
   * key (takes precedence over ANTHROPIC_API_KEY), ANTHROPIC_MODEL = provider/model, model discovery from /v1/models.
   */
  setGateway(g) { this.gateway = g && g.env?.ANTHROPIC_BASE_URL ? g : null; }
  /** A turn with a gateway model gets the gateway's variables; a Claude model goes to Anthropic (your Claude account). */
  #env(viaGateway) { return { ...this.baseEnv, ...this.extraEnv, ...(viaGateway && this.gateway ? this.gateway.env : {}) }; }
  async start() {}
  async stop() { for (const c of this.activeTurns.values()) { try { c.kill(); } catch { /* */ } } this.activeTurns.clear(); }

  // ---------- sessions on disk ----------
  #projectsDir() { return path.join(this.home, 'projects'); }

  async #files() {
    const out = [];
    let dirs; try { dirs = await fsp.readdir(this.#projectsDir(), { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files; try { files = await fsp.readdir(path.join(this.#projectsDir(), d.name)); } catch { continue; }
      for (const f of files) if (/^[0-9a-f-]{36}\.jsonl$/.test(f)) out.push(path.join(this.#projectsDir(), d.name, f));
    }
    return out;
  }

  async #head(file) {
    const m = await claudeHead(file);
    if (!m) return { id: path.basename(file, '.jsonl'), cwd: '', title: '', createdAt: 0, updatedAt: 0, model: null };
    return { ...m, title: m.title === m.firstPrompt ? '' : m.title };
  }

  /**
   * Claude Code resumes a session only from <config>/projects/<encoded cwd>/<id>.jsonl. When the conversation's
   * folder changed (moved in the app, imported from another computer or from the Claude desktop app), the file is
   * moved there first (copied when it lives outside Claude Code's folder).
   */
  async #placeFor(id, cwd) {
    const file = await this.#fileOf(id);
    if (!file || !cwd) return;
    const to = path.join(this.#projectsDir(), claudeProjectDir(cwd), `${id}.jsonl`);
    if (path.resolve(file) === path.resolve(to)) return;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) return;
    await fsp.rename(file, to).catch(() => fsp.copyFile(file, to));
  }

  async listConversations({ since = 0 } = {}) {
    const out = [];
    for (const f of await this.#files()) {
      try {
        if (since) { const st = await fsp.stat(f); if (st.mtimeMs < since) continue; }
        const m = await this.#head(f);
        if (!m.cwd) continue;
        out.push({ agent: 'claude', id: m.id, title: m.title || m.firstPrompt || '', cwd: m.cwd, createdAt: m.createdAt, updatedAt: m.updatedAt, model: m.model, effort: null, provider: 'anthropic', rolloutPath: f, archived: false });
      } catch { /* unreadable */ }
    }
    return out;
  }

  async #fileOf(id) { return (await this.#files()).find((f) => path.basename(f, '.jsonl') === id) || null; }

  async readConversation(id) {
    const file = await this.#fileOf(id);
    if (!file) return { meta: null, items: [], running: this.activeTurns.has(id), pending: [] };
    const items = [], tools = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }) });
    for await (const line of rl) { let o; try { o = JSON.parse(line); } catch { continue; } this.#ingest(o, items, tools); }
    const head = await this.#head(file);
    return { meta: { id, title: head.title || head.firstPrompt, cwd: head.cwd, rolloutPath: file }, items, running: this.activeTurns.has(id), pending: [] };
  }

  /** Converts one stream-json / transcript record into display items. */
  #ingest(o, items, tools, emit) {
    const push = (it) => { items.push(it); emit?.({ type: 'item.completed', item: it }); };
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') { const { context, prompt } = splitUserText(c); if (!o.isMeta) push({ id: o.uuid || crypto.randomUUID(), kind: 'user', text: prompt, context }); return; }
      for (const b of c || []) {
        if (b.type === 'text' && !o.isMeta) { const { context, prompt } = splitUserText(b.text); push({ id: o.uuid || crypto.randomUUID(), kind: 'user', text: prompt, context }); }
        if (b.type === 'tool_result') {
          const t = tools.get(b.tool_use_id);
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n');
          if (t) { t.output = text; t.status = b.is_error ? 'failed' : 'completed'; if (t.kind === 'command') t.exitCode = b.is_error ? 1 : 0; emit?.({ type: 'item.completed', item: t }); }
        }
      }
    } else if (o.type === 'assistant' && o.message) {
      (o.message.content || []).forEach((b, i) => {
        if (b.type === 'text' && b.text?.trim()) push({ id: `${o.message.id || o.uuid}-${i}`, kind: 'agent', text: b.text });
        if (b.type === 'tool_use') {
          const inp = b.input || {};
          let it;
          if (b.name === 'Bash') it = { id: b.id, kind: 'command', command: inp.command || '', output: '', status: 'inProgress', exitCode: null };
          else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) it = { id: b.id, kind: 'fileChange', status: 'inProgress', changes: [{ path: inp.file_path || inp.notebook_path || '', kind: b.name === 'Write' ? 'add' : 'update', diff: diffOf(b.name, inp) }] };
          else it = { id: b.id, kind: 'tool', server: 'claude', tool: b.name, args: inp, output: '', status: 'inProgress' };
          tools.set(b.id, it); push(it);
        }
      });
    } else if (o.type === 'result') {
      if (o.is_error && o.result) push({ id: crypto.randomUUID(), kind: 'error', text: o.result });
      for (const d of o.permission_denials || []) push({ id: crypto.randomUUID(), kind: 'notice', text: `Permission denied for ${d.tool_name}. Change the action mode to allow it.` });
    }
  }

  async createConversation({ cwd, model, effort, mode }) {
    const id = crypto.randomUUID();
    this.loaded.set(id, { fresh: true, cwd, model, effort, mode });
    return { agent: 'claude', id, title: '', cwd: normalizePath(cwd), createdAt: Date.now(), updatedAt: Date.now(), model: model || null, effort: effort || null, provider: 'anthropic', rolloutPath: null };
  }

  async send(id, { text, cwd, model, effort, mode, writableRoots = [], gateway = false }) {
    if (this.activeTurns.has(id)) { const e = new Error('A reply is still running in this conversation.'); e.code = 'BUSY'; throw e; }
    const bin = this.findBinary();
    if (!bin) throw new Error('Claude Code CLI not found. Install it from https://docs.claude.com/claude-code or set its path in Configuration.');
    const fresh = !(await this.#fileOf(id));
    if (!fresh) await this.#placeFor(id, cwd).catch(() => {});
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(fresh ? ['--session-id', id] : ['--resume', id])];
    if (model) args.push('--model', model);
    if (effort && CLAUDE_EFFORTS.includes(effort) && !(gateway && this.gateway)) args.push('--effort', effort);
    if (MODE_MAP[mode]) args.push('--permission-mode', MODE_MAP[mode]);
    for (const r of writableRoots) if (r && normalizePath(r) !== normalizePath(cwd)) args.push('--add-dir', r);
    const launch = resolveLaunch(bin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
    const child = spawnResolved(launch, args, { cwd, env: this.#env(gateway), stdio: ['pipe', 'pipe', 'pipe'] });
    this.activeTurns.set(id, child);
    const turnId = crypto.randomUUID();
    const emit = (e) => this.emit('event', { threadId: id, turnId, ...e });
    emit({ type: 'turn.started' });
    const items = [], tools = new Map();
    let errText = '', failed = false, acked = false;
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'result' && o.is_error) failed = true;
      // The model that actually answered (Claude Code writes it on every assistant message): confirms the choice.
      if (o.type === 'assistant' && o.message?.model && !acked) { acked = true; emit({ type: 'settings', model: o.message.model, effort: effort && !(gateway && this.gateway) ? effort : null, provider: gateway && this.gateway ? this.gateway.label : 'anthropic' }); }
      // The result line carries the turn's usage (all requests of the turn): input, cache read/write, output.
      if (o.type === 'result' && o.usage) emit({ type: 'usage', usage: { last: fromAnthropic(o.usage), contextWindow: null } });
      this.#ingest(o, items, tools, emit);
    });
    child.on('error', (e) => { errText = e.message; });
    child.on('close', (code) => {
      this.activeTurns.delete(id);
      emit({ type: 'turn.completed', status: code === 0 && !failed ? 'completed' : 'failed', error: code === 0 ? null : (errText.trim().split('\n').pop() || `claude exited with ${code}`) });
    });
    child.stdin.end(text);
    return { turnId };
  }

  async interrupt(id) { const c = this.activeTurns.get(id); if (!c) return false; c.kill('SIGINT'); return true; }
  respond() { throw new Error('Claude Code approvals are controlled by the action mode in print mode.'); }
  pendingFor() { return []; }
  async rename() {}
  async remove(id) { const f = await this.#fileOf(id); if (f) await fsp.rm(f, { force: true }); }
  /**
   * Models this account can use, without guessing:
   *  - the aliases Claude Code always accepts (opus, sonnet, haiku → latest of each family),
   *  - every model actually used in this user's sessions,
   *  - the full list from the Anthropic API when an ANTHROPIC_API_KEY is available,
   *  - the default model from ~/.claude/settings.json.
   * Effort levels are read from the installed CLI's --help (2.1.314: low, medium, high, xhigh, max).
   */
  async listModels() {
    const efforts = await this.#efforts();
    const seen = new Map();
    const add = (id, label, source) => { if (id && !seen.has(id)) seen.set(id, { id, model: id, label: label || id, efforts, defaultEffort: null, provider: 'anthropic', source, detected: source !== 'alias' }); };
    let def = null;
    try { def = JSON.parse(await fsp.readFile(path.join(this.home, 'settings.json'), 'utf8')).model || null; } catch { /* none */ }
    for (const m of ['opus', 'sonnet', 'haiku']) add(m, `Claude ${m[0].toUpperCase()}${m.slice(1)} (latest)`, 'alias');
    if (def) add(def, `${def} (your default)`, 'settings');
    const key = this.extraEnv.ANTHROPIC_API_KEY || this.baseEnv.ANTHROPIC_API_KEY;
    if (key) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
        if (r.ok) for (const m of (await r.json()).data || []) add(m.id, m.display_name || m.id, 'account');
      } catch { /* offline */ }
    }
    for (const f of (await this.#files()).slice(-200)) {
      try {
        const txt = await fsp.readFile(f, 'utf8');
        for (const m of txt.matchAll(/"model":"(claude-[a-z0-9.-]+)"/g)) add(m[1], claudeLabel(m[1]), 'history');
      } catch { /* unreadable */ }
    }
    const list = [...seen.values()];
    if (def && seen.has(def)) seen.get(def).isDefault = true; else if (list[0]) list[0].isDefault = true;
    // Models of the gateway (OmniRoute: provider/model ids), listed after Claude's own; a turn with one of them is
    // sent through the gateway (see send). Their ids are prefixed so they never clash with Anthropic's.
    if (this.gateway) {
      const g = this.gateway.env, label = this.gateway.label.replace(/\s*\(.*\)$/, '');
      const gw = new Map();
      const addGw = (mid) => { if (mid && !gw.has(mid)) gw.set(mid, { id: `gateway:${mid}`, model: mid, label: `${mid} · ${label}`, efforts: [], defaultEffort: null, provider: label, source: 'gateway', gateway: true, detected: true }); };
      if (g.ANTHROPIC_MODEL) addGw(g.ANTHROPIC_MODEL);
      try {
        const r = await fetch(`${g.ANTHROPIC_BASE_URL}/v1/models`, { headers: { authorization: `Bearer ${g.ANTHROPIC_AUTH_TOKEN}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) for (const m of (await r.json()).data || []) addGw(m.id);
      } catch { /* gateway not running */ }
      list.push(...gw.values());
    }
    return list;
  }

  async #efforts() {
    if (this.effortCache) return this.effortCache;
    const bin = this.findBinary();
    let list = CLAUDE_EFFORTS;
    if (bin) {
      const launch = resolveLaunch(bin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
      if (!launch.shell) {
        const { run } = await import('../proc.mjs');
        const r = await run(launch.command, [...launch.prefixArgs, '--help'], { timeout: 15_000 });
        const m = /--effort <level>[\s\S]{0,200}?\(([a-z, ]+)\)/.exec(r.stdout || '');
        if (m) list = m[1].split(',').map((x) => x.trim()).filter(Boolean);
      }
    }
    this.effortCache = list;
    return list;
  }
}

function diffOf(tool, inp) {
  const minus = (s) => String(s || '').split('\n').map((l) => '-' + l).join('\n');
  const plus = (s) => String(s || '').split('\n').map((l) => '+' + l).join('\n');
  if (tool === 'Write') return plus(inp.content).slice(0, 20000);
  if (tool === 'Edit') return `${minus(inp.old_string)}\n${plus(inp.new_string)}`.slice(0, 20000);
  if (tool === 'MultiEdit') return (inp.edits || []).map((e) => `${minus(e.old_string)}\n${plus(e.new_string)}`).join('\n@@\n').slice(0, 20000);
  return '';
}
