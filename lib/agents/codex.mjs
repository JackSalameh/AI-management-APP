// Codex adapter: drives `codex app-server` (JSON-RPC over stdio).
// Method names and payloads verified against codex-cli 0.166.0 (`codex app-server generate-ts`).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { JsonRpcPeer } from '../jsonrpc.mjs';
import { which, resolveLaunch, spawnResolved, run } from '../proc.mjs';
import { fromCodexItem, fromCodexTurns } from '../items.mjs';
import { normalizePath } from '../paths.mjs';
import { BRAND } from '../brand.mjs';

export const ACTION_MODES = ['default', 'ask', 'project', 'readonly', 'full'];

/** Maps the app's per-conversation action mode to Codex approval + sandbox settings. */
export function codexPolicy(mode, writableRoots = []) {
  const ws = (roots) => ({ type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  switch (mode) {
    case 'ask': return { approvalPolicy: 'untrusted', sandboxPolicy: ws(writableRoots), sandbox: 'workspace-write' };
    case 'project': return { approvalPolicy: 'on-request', sandboxPolicy: ws(writableRoots), sandbox: 'workspace-write' };
    case 'readonly': return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false }, sandbox: 'read-only' };
    case 'full': return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, sandbox: 'danger-full-access' };
    default: return {};
  }
}

export function isWriterLockError(e) {
  return /active writer|already (has|being) (an )?(active )?writ|locked by another/i.test(String(e?.message || e));
}

export class CodexAgent extends EventEmitter {
  constructor({ codexHome, bin, env = process.env, log = console } = {}) {
    super();
    this.id = 'codex'; this.label = 'Codex';
    this.codexHome = codexHome; this.binSetting = bin; this.baseEnv = env; this.log = log;
    this.peer = null; this.child = null; this.state = 'stopped'; this.lastError = null; this.version = null;
    this.loaded = new Map();      // threadId -> { provider }
    this.activeTurns = new Map(); // threadId -> turnId
    this.pending = new Map();     // approval key -> { rpcId, method, params }
    this.extraEnv = {};
    this.stderrTail = [];
    this.starting = null;
    this.gen = 0;                 // incremented by every start/stop so stale starts cannot win a race
  }

  findBinary() {
    const candidates = [this.binSetting, this.baseEnv.CPM_CODEX_BIN, 'codex'].filter(Boolean);
    for (const c of candidates) { const p = which(c, this.baseEnv); if (p) return p; }
    if (process.platform === 'win32' && this.baseEnv.APPDATA) {
      const p = path.join(this.baseEnv.APPDATA, 'npm', 'codex.cmd');
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  status() {
    return { id: this.id, label: this.label, state: this.state, error: this.lastError, version: this.version, codexHome: this.codexHome, activeTurns: Object.fromEntries(this.activeTurns) };
  }

  setEnv(extra) { this.extraEnv = { ...extra }; }

  async start() {
    // After the app quits, a late restart (e.g. after an MCP change) must not leave an orphan app-server behind.
    if (this.closed) throw new Error('The app is closing.');
    if (this.state === 'ready' && this.peer) return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    const bin = this.findBinary();
    if (!bin) {
      this.state = 'error'; this.lastError = 'Codex CLI not found. Install it with "npm install -g @openai/codex" or set its path in Configuration.';
      this.emit('status', this.status());
      throw new Error(this.lastError);
    }
    const gen = ++this.gen;
    this.state = 'starting'; this.lastError = null; this.emit('status', this.status());
    const launch = resolveLaunch(bin, { npmPackage: '@openai/codex', jsEntry: 'bin/codex.js' });
    const env = { ...this.baseEnv, ...this.extraEnv };
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    const child = spawnResolved(launch, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.stderrTail.push(d); if (this.stderrTail.length > 40) this.stderrTail.shift(); });
    const peer = new JsonRpcPeer(child, { log: (m) => this.log.warn?.(`[codex] ${m}`) });
    this.peer = peer;
    peer.on('notification', (m) => this.#onNotification(m));
    peer.on('request', (m) => this.#onServerRequest(m));
    peer.on('close', (err) => {
      if (this.peer !== peer) return;
      const wasActive = [...this.activeTurns.keys()];
      this.peer = null; this.child = null; this.loaded.clear(); this.activeTurns.clear();
      for (const [key, p] of this.pending) this.emit('event', { type: 'approval.resolved', threadId: p.params?.threadId, requestKey: key });
      this.pending.clear();
      if (this.state !== 'stopped') {
        this.state = 'error';
        const tail = this.stderrTail.join('').split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
        this.lastError = (err?.message || 'Codex stopped') + (tail ? ` — ${tail.slice(0, 300)}` : '');
      }
      // Report the crash before ending turns: ending a turn may trigger an automatic restart.
      this.emit('status', this.status());
      for (const threadId of wasActive) this.emit('event', { type: 'turn.completed', threadId, status: 'failed', error: this.lastError || 'Codex stopped' });
    });
    try {
      const init = await peer.request('initialize', { clientInfo: { name: BRAND.slug, title: BRAND.name, version: BRAND.version }, capabilities: null }, 30_000);
      if (gen !== this.gen) { try { child.kill(); } catch { /* */ } throw new Error('Start superseded'); }
      peer.notify('initialized');
      this.version = (/\/(\d+\.\d+\.\d+)/.exec(init?.userAgent || '') || [])[1] || null;
      this.platform = init?.platformOs;
      this.state = 'ready';
      this.emit('status', this.status());
    } catch (e) {
      if (gen !== this.gen) throw e;
      this.state = 'error'; this.lastError = `Codex failed to start: ${e.message}`;
      try { child.kill(); } catch { /* ignore */ }
      this.emit('status', this.status());
      throw new Error(this.lastError);
    }
  }

  async stop() {
    this.gen++;
    if (this.starting) await this.starting.catch(() => {});
    this.state = 'stopped';
    const child = this.child;
    this.peer = null; this.child = null; this.loaded.clear(); this.activeTurns.clear(); this.pending.clear();
    if (child) {
      try { child.stdin.end(); } catch { /* ignore */ }
      await new Promise((r) => { const t = setTimeout(() => { try { child.kill(); } catch { /* */ } r(); }, 1500); child.once('exit', () => { clearTimeout(t); r(); }); });
    }
    this.emit('status', this.status());
  }

  async rpc(method, params, timeout) {
    if (this.state !== 'ready' || !this.peer) await this.start();
    if (!this.peer) throw new Error('Codex is not running. Press Reconnect.');
    return this.peer.request(method, params, timeout);
  }

  // ---------- events ----------
  #onNotification({ method, params = {} }) {
    const threadId = params.threadId ?? params.thread?.id;
    const emit = (e) => this.emit('event', { threadId, ...e });
    switch (method) {
      case 'turn/started':
        this.activeTurns.set(threadId, params.turn?.id);
        return emit({ type: 'turn.started', turnId: params.turn?.id });
      case 'turn/completed': {
        this.activeTurns.delete(threadId);
        const t = params.turn || {};
        return emit({ type: 'turn.completed', turnId: t.id, status: t.status, error: t.error?.message ?? null });
      }
      case 'item/started': case 'item/completed': {
        const item = fromCodexItem(params.item);
        if (item) emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', turnId: params.turnId, item });
        return;
      }
      case 'item/agentMessage/delta': return emit({ type: 'item.delta', itemId: params.itemId, field: 'text', delta: params.delta });
      case 'item/commandExecution/outputDelta': return emit({ type: 'item.delta', itemId: params.itemId, field: 'output', delta: params.delta });
      case 'item/plan/delta': return emit({ type: 'item.delta', itemId: params.itemId, field: 'text', delta: params.delta });
      case 'turn/plan/updated': return emit({ type: 'plan', plan: params.plan ?? params });
      case 'thread/tokenUsage/updated': return emit({ type: 'usage', usage: params.tokenUsage ?? params });
      case 'thread/name/updated': return emit({ type: 'thread.renamed', name: params.name ?? params.threadName });
      case 'thread/started': return emit({ type: 'thread.started' });
      case 'serverRequest/resolved': {
        const key = String(params.requestId);
        this.pending.delete(key);
        return emit({ type: 'approval.resolved', requestKey: key });
      }
      case 'error': return emit({ type: 'error', message: params.error?.message || 'Agent error', willRetry: !!params.willRetry });
      case 'warning': case 'configWarning': case 'deprecationNotice': case 'guardianWarning':
        return this.emit('event', { type: 'warning', threadId, message: params.summary || params.message || method });
      case 'mcpServer/startupStatus/updated': return this.emit('event', { type: 'mcp.status', status: params });
      default: return undefined;
    }
  }

  #onServerRequest(msg) {
    const { id, method, params = {} } = msg;
    const key = String(id);
    const kinds = {
      'item/commandExecution/requestApproval': 'command',
      'item/fileChange/requestApproval': 'fileChange',
      'item/permissions/requestApproval': 'permissions',
      'item/tool/requestUserInput': 'question',
      'mcpServer/elicitation/request': 'elicitation',
      execCommandApproval: 'command',
      applyPatchApproval: 'fileChange',
    };
    const kind = kinds[method];
    if (!kind) { this.peer?.respondError(id, `${BRAND.name} does not support ${method}`); return; }
    this.pending.set(key, { rpcId: id, method, params });
    this.emit('event', {
      type: 'approval.request', threadId: params.threadId ?? params.conversationId, requestKey: key, kind,
      itemId: params.itemId ?? params.callId, command: params.command ?? (Array.isArray(params.command) ? params.command.join(' ') : undefined),
      cwd: params.cwd, reason: params.reason ?? null, questions: params.questions ?? null, message: params.message ?? null,
      permissions: params.permissions ?? null, server: params.serverName ?? null,
    });
  }

  /** decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'; answers for questions. */
  respond(key, decision, answers = {}) {
    const p = this.pending.get(String(key));
    if (!p) throw new Error('This request is no longer pending');
    const ok = decision === 'accept' || decision === 'acceptForSession';
    let result;
    switch (p.method) {
      case 'execCommandApproval': case 'applyPatchApproval':
        result = { decision: ok ? (decision === 'acceptForSession' ? 'approved_for_session' : 'approved') : decision === 'cancel' ? 'abort' : { denied: { rejection: 'Declined by the user' } } };
        break;
      case 'item/permissions/requestApproval': {
        const req = p.params.permissions || {};
        const granted = {};
        if (ok && req.network) granted.network = req.network;
        if (ok && req.fileSystem) granted.fileSystem = req.fileSystem;
        result = { permissions: granted, scope: decision === 'acceptForSession' ? 'session' : 'turn' };
        break;
      }
      case 'item/tool/requestUserInput': {
        const out = {};
        for (const [qid, v] of Object.entries(answers || {})) out[qid] = { answers: Array.isArray(v) ? v.map(String) : [String(v)] };
        result = { answers: out };
        break;
      }
      case 'mcpServer/elicitation/request':
        result = { action: ok ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline', content: ok ? (answers || {}) : null, _meta: null };
        break;
      default:
        result = { decision };
    }
    this.peer?.respond(p.rpcId, result);
    this.pending.delete(String(key));
    this.emit('event', { type: 'approval.resolved', threadId: p.params?.threadId, requestKey: String(key) });
  }

  pendingFor(threadId) {
    return [...this.pending.entries()].filter(([, p]) => (p.params?.threadId ?? p.params?.conversationId) === threadId).map(([key, p]) => ({ requestKey: key, method: p.method, params: p.params }));
  }

  // ---------- conversations ----------
  static toMeta(t, archived = false) {
    return {
      agent: 'codex', id: t.id, title: t.name || t.preview?.split('\n').find((l) => l.trim() && !l.startsWith('<')) || '', preview: t.preview || '',
      cwd: normalizePath(t.cwd || ''), createdAt: (t.createdAt || 0) * 1000, updatedAt: (t.updatedAt || t.createdAt || 0) * 1000,
      model: t.model || null, effort: t.reasoningEffort || null, provider: t.modelProvider || null,
      rolloutPath: t.path ? normalizePath(t.path) : null, archived, source: t.source ?? null, parentThreadId: t.parentThreadId ?? null,
    };
  }

  /** Lists threads newest-first; with `since` (ms) paging stops at the first older thread (incremental refresh). */
  async listConversations({ archived = false, max = 5000, since = 0 } = {}) {
    const out = [];
    let cursor = null, older = false;
    do {
      const r = await this.rpc('thread/list', { cursor, limit: since ? 50 : 200, archived, sortKey: 'updated_at', sortDirection: 'desc' });
      for (const t of r.data || []) {
        if (since && (t.updatedAt || 0) * 1000 < since) { older = true; break; }
        if (!t.parentThreadId && !t.ephemeral) out.push(CodexAgent.toMeta(t, archived));
      }
      cursor = r.nextCursor;
    } while (cursor && !older && out.length < max);
    return out;
  }

  /**
   * History is read with thread/turns/list (paged, oldest first) — the API codex-cli 0.166 recommends.
   * thread/read + includeTurns is only a fallback: on 0.166 it fails with "list_turns is not supported yet"
   * for threads that have no message yet (verified against the real app-server).
   */
  async #turns(id) {
    const turns = [];
    let cursor = null;
    do {
      const r = await this.rpc('thread/turns/list', { threadId: id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
      turns.push(...(r.data || []));
      cursor = r.nextCursor;
    } while (cursor && turns.length < 20_000);
    return turns;
  }

  async readConversation(id) {
    const empty = { meta: null, items: [], running: this.activeTurns.has(id), pending: this.pendingFor(id) };
    let meta = null;
    try { meta = (await this.rpc('thread/read', { threadId: id, includeTurns: false })).thread; }
    catch (e) { if (/not found|does not exist|no rollout|unknown thread/i.test(e.message)) return empty; throw e; }
    let turns;
    try { turns = await this.#turns(id); }
    catch (e1) {
      try { turns = (await this.rpc('thread/read', { threadId: id, includeTurns: true })).thread?.turns || []; }
      catch (e2) { if (/not supported|not found|no rollout|not materialized|empty/i.test(`${e1.message} ${e2.message}`)) turns = []; else throw e2; }
    }
    return { meta: CodexAgent.toMeta(meta), items: fromCodexTurns(turns), running: this.activeTurns.has(id), pending: this.pendingFor(id) };
  }

  async createConversation({ cwd, model, provider, effort, mode, writableRoots, developerInstructions }) {
    const pol = codexPolicy(mode, writableRoots);
    const params = { cwd, approvalPolicy: pol.approvalPolicy ?? null, sandbox: pol.sandbox ?? null, serviceName: BRAND.slug };
    if (model) params.model = model;
    if (provider) params.modelProvider = provider;
    if (developerInstructions) params.developerInstructions = developerInstructions;
    if (effort) params.config = { model_reasoning_effort: effort };
    const r = await this.rpc('thread/start', params);
    this.loaded.set(r.thread.id, { provider: r.modelProvider || provider || null });
    return { ...CodexAgent.toMeta(r.thread), model: r.model, provider: r.modelProvider, effort: r.reasoningEffort };
  }

  async #ensureLoaded(id, { cwd, provider, mode, writableRoots }) {
    const cur = this.loaded.get(id);
    if (cur && (!provider || !cur.provider || cur.provider === provider)) return;
    if (cur) { try { await this.rpc('thread/unsubscribe', { threadId: id }); } catch { /* older servers */ } this.loaded.delete(id); }
    const pol = codexPolicy(mode, writableRoots);
    const params = { threadId: id, cwd: cwd || null, excludeTurns: true };
    if (provider) params.modelProvider = provider;
    if (pol.approvalPolicy) { params.approvalPolicy = pol.approvalPolicy; params.sandbox = pol.sandbox; }
    try {
      const r = await this.rpc('thread/resume', params);
      this.loaded.set(id, { provider: r.modelProvider || provider || null });
    } catch (e) {
      if (isWriterLockError(e)) {
        const err = new Error('This conversation is still open in another Codex window (Codex keeps a writer lock even when idle). Close that command window completely, then press Send again. Your draft is kept.');
        err.code = 'WRITER_LOCK'; throw err;
      }
      throw e;
    }
  }

  async send(id, { text, images = [], cwd, model, provider, effort, mode, writableRoots = [] }) {
    if (this.activeTurns.has(id)) {
      const e = new Error('A reply is still running in this conversation. Wait for it or press Stop.'); e.code = 'BUSY'; throw e;
    }
    await this.#ensureLoaded(id, { cwd, provider, mode, writableRoots });
    const pol = codexPolicy(mode, writableRoots);
    const input = [{ type: 'text', text, text_elements: [] }, ...images.map((p) => ({ type: 'localImage', path: p }))];
    const params = { threadId: id, input };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (effort) params.effort = effort;
    if (pol.approvalPolicy) { params.approvalPolicy = pol.approvalPolicy; params.sandboxPolicy = pol.sandboxPolicy; }
    this.activeTurns.set(id, 'pending');
    try {
      const r = await this.rpc('turn/start', params);
      // A fast turn may already have completed before this response arrived (v1 stuck-Send bug).
      if (this.activeTurns.get(id) === 'pending') {
        if (r.turn?.status && r.turn.status !== 'inProgress') this.activeTurns.delete(id);
        else this.activeTurns.set(id, r.turn?.id);
      }
      return { turnId: r.turn?.id };
    } catch (e) {
      this.activeTurns.delete(id);
      if (isWriterLockError(e)) { const err = new Error('This conversation is open in another Codex window. Close it, then press Send again.'); err.code = 'WRITER_LOCK'; throw err; }
      throw e;
    }
  }

  async interrupt(id) {
    const turnId = this.activeTurns.get(id);
    if (!turnId || turnId === 'pending') return false;
    await this.rpc('turn/interrupt', { threadId: id, turnId });
    return true;
  }

  rename(id, name) { return this.rpc('thread/name/set', { threadId: id, name }); }
  archive(id) { this.loaded.delete(id); return this.rpc('thread/archive', { threadId: id }); }
  unarchive(id) { return this.rpc('thread/unarchive', { threadId: id }); }
  remove(id) { this.loaded.delete(id); return this.rpc('thread/delete', { threadId: id }); }

  // ---------- models & configuration ----------
  async listModels() {
    const r = await this.rpc('model/list', {});
    return (r.data || []).filter((m) => !m.hidden).map((m) => ({
      id: m.id, model: m.model, label: m.displayName || m.model, description: m.description || '', isDefault: !!m.isDefault,
      efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort || null, provider: null, source: 'agent',
    }));
  }

  async readConfig() {
    const r = await this.rpc('config/read', { includeLayers: false });
    return r.config || {};
  }

  /** edits: [{ keyPath, value, mergeStrategy? }] — Codex writes TOML itself and keeps comments. */
  async writeConfig(edits, { filePath } = {}) {
    const params = { edits: edits.map((e) => ({ keyPath: e.keyPath, value: e.value, mergeStrategy: e.mergeStrategy || 'replace' })), reloadUserConfig: true };
    if (filePath) params.filePath = filePath;
    return this.rpc('config/batchWrite', params);
  }

  async listSkills(cwds) { const r = await this.rpc('skills/list', { cwds, forceReload: true }); return r.data || []; }
  async mcpStatus() { const r = await this.rpc('mcpServerStatus/list', {}); return r.data || r.servers || r; }
  async mcpLogin(name) { return this.rpc('mcpServer/oauth/login', { name }, 300_000); }
  async reloadMcp() { return this.rpc('config/mcpServer/reload', {}); }

  /** Runs a codex CLI subcommand (e.g. `plugin marketplace add`). */
  async cli(args, { cwd, timeout = 120_000 } = {}) {
    const bin = this.findBinary();
    if (!bin) return { ok: false, stderr: 'Codex CLI not found' };
    const launch = resolveLaunch(bin, { npmPackage: '@openai/codex', jsEntry: 'bin/codex.js' });
    if (launch.shell) return { ok: false, stderr: 'Cannot run the Codex CLI shim safely; set the path to codex.js or codex.exe in Configuration.' };
    const env = { ...this.baseEnv, ...this.extraEnv, ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}) };
    return run(launch.command, [...launch.prefixArgs, ...args], { cwd, env, timeout });
  }
}
