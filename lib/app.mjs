// Application core: owns state, agents, memory and tools. The HTTP layer (server.mjs) only routes to it.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, defaultCodexHome } from './store.mjs';
import { CodexAgent, ACTION_MODES } from './agents/codex.mjs';
import { ClaudeAgent } from './agents/claude.mjs';
import { ApiAgent } from './agents/api.mjs';
import { PRESETS, normalizeProvider } from './providers.mjs';
import { CATALOG, Jobs, npmInstallGlobal, startService, healthy } from './addons.mjs';
import { downloadIcon, saveUploadedIcon, ICON_SOURCES } from './icons.mjs';
import { which, run as runProc, resolveLaunch } from './proc.mjs';
import { Memory, FILES, MEMORY_DIR, canWrite, lineDiff } from './memory.mjs';
import { search as fullTextSearch } from './search.mjs';
import { checkTool } from './checks.mjs';
import { backupState, listBackups, readBackup, versionInfo, checkUpdates, redact, logLines } from './support.mjs';
import { buildTree, effectiveCwd, convKey } from './tree.mjs';
import { normalizePath, pathKey, isInside, rebase, validateName, baseName, parentPath, isRootPath, joinSegments, splitPath } from './paths.mjs';
import { Git, pullRequestUrl, webInfo } from './git.mjs';
import { openInVSCode, findVSCode, launchMatlab, findMatlabInstalls } from './tools.mjs';
import { Secrets, NAME_RE } from './secrets.mjs';
import { parseGitHubSource, fetchGitHub, findSkills, installSkills, detectPluginRepo, skillTargets } from './skills.mjs';
import { profileFromToml, mergeModels, configEditsFor, checkEffort } from './models.mjs';
import { parseToml, findInlineSecrets } from './toml.mjs';
import { itemsToMarkdown } from './items.mjs';
import { openExternal } from './proc.mjs';
import { BRAND } from './brand.mjs';

export class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; Object.assign(this, extra); } }
const bad = (m, extra) => new HttpError(400, m, extra);

export class App extends EventEmitter {
  constructor({ dataDir, codexHome = defaultCodexHome(), env = process.env } = {}) {
    super();
    this.dataDir = dataDir; this.codexHome = codexHome; this.env = env;
    this.store = new Store(dataDir).load();
    this.memory = new Memory(dataDir);
    this.secrets = new Secrets(dataDir);
    this.git = new Git({ executable: this.store.s.tools.git.executable });
    this.agents = {
      codex: new CodexAgent({ codexHome, bin: this.store.s.settings.agentBins.codex, env }),
      claude: new ClaudeAgent({ bin: this.store.s.settings.agentBins.claude, env }),
    };
    this.jobs = new Jobs((e) => this.emit('event', e));
    this.skillPreviews = new Map();
    this.agentModels = {};    // agent id -> models from the agent
    this.sendLocks = new Map();
    this.itemCache = new Map();  // key -> items (for paging older messages)
    this.lastRefresh = 0; this.lastFullRefresh = 0;
    for (const a of Object.values(this.agents)) this.#wire(a);
    this.#syncApiAgents();
  }

  #wire(a) {
    a.on('event', (e) => this.#onAgentEvent(a.id, e));
    a.on('status', (s) => this.emit('event', { type: 'agent.status', agent: a.id, status: s }));
  }

  /** One ApiAgent per configured API provider (id "api-<provider>"). */
  #syncApiAgents() {
    const wanted = new Set(this.s.providers.map((p) => `api-${p.id}`));
    for (const id of Object.keys(this.agents)) if (id.startsWith('api-') && !wanted.has(id)) { this.agents[id].stop(); this.agents[id].removeAllListeners(); delete this.agents[id]; delete this.agentModels[id]; }
    for (const p of this.s.providers) {
      const id = `api-${p.id}`;
      if (this.agents[id]) { this.agents[id].provider = p; this.agents[id].label = p.label; continue; }
      const a = new ApiAgent(p, { dataDir: this.dataDir, getKey: (name) => this.secrets.get(name) });
      this.agents[id] = a; this.#wire(a);
    }
  }

  get s() { return this.store.s; }

  // ------------------------------------------------------------------ lifecycle
  async startAgents() {
    const { env, errors } = await this.secrets.env();
    if (errors.length) this.emit('event', { type: 'warning', message: `Some saved keys could not be read: ${errors.join('; ')}` });
    for (const a of Object.values(this.agents)) a.setEnv(env);
    try { await this.agents.codex.start(); } catch (e) { /* surfaced via status */ void e; }
    await this.refresh().catch((e) => this.emit('event', { type: 'warning', message: `Could not list conversations: ${e.message}` }));
  }

  async restartAgent(id = 'codex') {
    const a = this.#agent(id);
    await a.stop();
    const { env } = await this.secrets.env();
    a.setEnv(env);
    await a.start();
    await this.refresh().catch(() => {});
    return a.status();
  }

  async stopAgent(id = 'codex') { await this.#agent(id).stop(); return this.#agent(id).status(); }

  async shutdown() {
    for (const a of Object.values(this.agents)) await a.stop().catch(() => {});
    await this.store.flush();
  }

  #agent(id) { const a = this.agents[id]; if (!a) throw bad(`Unknown agent ${id}`); return a; }

  // ------------------------------------------------------------------ conversations index
  /**
   * Re-reads conversation lists. A full refresh (startup, Refresh button, every 10 min) lists everything and
   * detects deletions; an incremental refresh only fetches threads updated since the last one (rec. 3).
   */
  async refresh({ full = true } = {}) {
    if (!full && Date.now() - this.lastFullRefresh > 10 * 60_000) full = true;
    const seen = new Set();
    const since = full ? 0 : this.lastRefresh - 5000;
    let changed = 0;
    for (const a of Object.values(this.agents)) {
      if (!a.available?.() && a.id !== 'codex') continue;
      let lists = [];
      try {
        lists = full
          ? [...await a.listConversations({ archived: false }), ...(a.id === 'codex' ? await a.listConversations({ archived: true }) : [])]
          : await a.listConversations({ archived: false, since });
      } catch (e) { if (a.id === 'codex') throw e; continue; }
      for (const m of lists) {
        const key = convKey(a.id, m.id);
        seen.add(key);
        const prev = this.s.conversations[key] || {};
        this.s.conversations[key] = {
          ...prev, agent: a.id, id: m.id,
          agentTitle: m.title || prev.agentTitle || '', cwd: m.cwd || prev.cwd || '',
          createdAt: m.createdAt || prev.createdAt || Date.now(), updatedAt: Math.max(m.updatedAt || 0, prev.updatedAt || 0),
          model: prev.model || m.model, effort: prev.effort || m.effort, provider: m.provider || prev.provider,
          rollout: m.rolloutPath || prev.rollout || null, archived: full ? !!m.archived : (m.archived ?? prev.archived ?? false), materialized: true,
        };
        changed++;
      }
      if (full || !this.agentModels[a.id]) { try { this.agentModels[a.id] = await a.listModels(); } catch { /* keep previous */ } }
    }
    if (full) {
      // App-created conversations without a first message are kept (bug #2); others that vanished are marked missing.
      for (const [key, rec] of Object.entries(this.s.conversations)) {
        if (!seen.has(key) && rec.materialized && this.agents[rec.agent]?.state === 'ready') rec.missing = true;
        else if (seen.has(key)) delete rec.missing;
      }
      this.lastFullRefresh = Date.now();
    } else for (const key of seen) delete this.s.conversations[key].missing;
    this.lastRefresh = Date.now();
    this.store.save();
    return { ...this.summary(), changed };
  }

  convList() {
    return Object.entries(this.s.conversations)
      .filter(([, r]) => !r.missing)
      .map(([key, r]) => ({
        key, agent: r.agent, id: r.id, title: r.title || r.agentTitle || 'New conversation', cwd: effectiveCwd(r),
        createdAt: r.createdAt, updatedAt: r.updatedAt, archived: !!r.archived, model: r.modelKey || r.model, effort: r.effort,
        running: !!this.agents[r.agent]?.activeTurns?.has(r.id), rollout: r.rollout ? path.basename(r.rollout.replace(/\\/g, '/')) : null,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  summary() {
    const convs = this.convList();
    const active = convs.filter((c) => !c.archived);
    return {
      brand: BRAND,
      platform: process.platform,
      home: os.homedir(),
      settings: this.s.settings,
      tools: this.s.tools,
      agents: Object.fromEntries(Object.entries(this.agents).map(([k, a]) => [k, a.status()])),
      conversations: convs,
      tree: buildTree({ folders: Object.values(this.s.folders).map((f) => f.path), conversations: active }),
      trash: this.s.trash,
      models: this.models(),
      actionModes: ACTION_MODES,
      secrets: this.secrets.describe(),
      logos: availableLogos(),
      onboarded: !!this.s.settings.onboarded,
      providers: this.s.providers, presets: PRESETS,
      capabilities: Object.fromEntries(Object.entries(this.agents).map(([k, a]) => [k, { files: a.capabilities?.files !== false, approvals: a.capabilities?.approvals !== false && k === 'codex', kind: k.startsWith('api-') ? 'api' : 'cli', label: a.label }])),
      icons: this.s.icons,
    };
  }

  #rec(key) {
    const r = this.s.conversations[key];
    if (!r) throw new HttpError(404, 'Conversation not found. Press Refresh.');
    return r;
  }

  convMemoryDir(rec) { return this.memory.conversationDir(effectiveCwd(rec), rec.agent, rec.id); }

  /** Opens a conversation; only the latest `limit` items are returned, older ones are paged on demand (rec. 3). */
  async openConversation(key, { limit = 120 } = {}) {
    const rec = this.#rec(key);
    const a = this.#agent(rec.agent);
    const data = await a.readConversation(rec.id);
    if (data.meta?.rolloutPath && rec.rollout !== data.meta.rolloutPath) { rec.rollout = data.meta.rolloutPath; this.store.save(); }
    this.s.settings.activeConversation = key; this.store.save();
    this.itemCache.set(key, data.items);
    const cwd = effectiveCwd(rec);
    const lim = Math.max(1, Math.min(+limit || 120, 5000));
    const start = Math.max(0, data.items.length - lim);
    return {
      key, record: { ...rec, cwd, title: rec.title || rec.agentTitle || 'New conversation', rolloutName: rec.rollout ? path.basename(rec.rollout.replace(/\\/g, '/')) : null, memoryState: this.memoryState(rec) },
      items: data.items.slice(start), total: data.items.length, offset: start,
      running: data.running, pending: data.pending.map((p) => ({ requestKey: p.requestKey, kind: kindOf(p.method), ...pickApproval(p.params) })),
      memory: await this.memoryInfo(rec), draft: this.s.drafts?.[key] || '',
    };
  }

  /** Older items for "Show earlier messages". */
  async olderItems(key, before, limit = 120) {
    let items = this.itemCache.get(key);
    if (!items) { const rec = this.#rec(key); items = (await this.#agent(rec.agent).readConversation(rec.id)).items; this.itemCache.set(key, items); }
    const end = Math.max(0, Math.min(+before || 0, items.length));
    const start = Math.max(0, end - Math.max(1, +limit || 120));
    return { items: items.slice(start, end), offset: start };
  }

  /** 'enabled' | 'declined' | 'ask' (first open of a conversation without memory files). */
  memoryState(rec) {
    if (rec.memory === 'enabled' || rec.memory === 'declined') return rec.memory;
    const d = this.convMemoryDir(rec);
    return fs.existsSync(path.join(d.dir, FILES.context)) || fs.existsSync(path.join(d.dir, FILES.instructions)) ? 'enabled' : 'ask';
  }

  /** Setup window: create (with the user's text) or decline conversation memory; optionally rename. */
  async setupMemory(key, { enable, title, context, instructions }) {
    const rec = this.#rec(key);
    if (title && String(title).trim() && String(title).trim() !== (rec.title || rec.agentTitle)) await this.renameConversation(key, title);
    if (!enable) { rec.memory = 'declined'; this.store.save(); return { memoryState: 'declined' }; }
    const r = await this.memory.writeInitial(this.convMemoryDir(rec), { title: rec.title || rec.agentTitle || 'Conversation', context, instructions, rollout: rec.rollout });
    if (!r.dir) throw bad(`Could not create the files: ${r.warnings.join('; ')}`);
    rec.memory = 'enabled'; rec.lastContextHash = null;
    this.store.save();
    return { memoryState: 'enabled', files: r.files, warnings: r.warnings };
  }

  async memoryInfo(rec) {
    const cwd = effectiveCwd(rec);
    const fd = cwd ? this.memory.folderDir(cwd) : null;
    const cd = this.convMemoryDir(rec);
    const exists = (d, f) => d && fs.existsSync(path.join(d.dir, f)) ? path.join(d.dir, f) : null;
    return {
      folder: fd ? { context: exists(fd, FILES.context), instructions: exists(fd, FILES.instructions), dir: fd.dir } : null,
      conversation: { context: exists(cd, FILES.context), instructions: exists(cd, FILES.instructions), dir: cd.dir },
      links: rec.links || [],
    };
  }

  async newConversation({ agent = 'codex', folder, title, modelKey, effort, actionMode }) {
    const cwd = normalizePath(folder);
    if (!cwd) throw bad('Choose a folder for the conversation');
    await this.ensureFolder(cwd, { create: true });
    const a = this.#agent(agent);
    if (a.available && !a.available()) throw bad(`${a.label} is not installed or not enabled. See Configuration › Accounts & providers.`);
    const entry = modelKey ? this.modelByKey(modelKey) : null;
    const mode = actionMode || this.s.settings.defaultActionMode;
    const meta = await a.createConversation({ cwd, model: entry?.model, provider: entry?.provider, effort, mode, writableRoots: this.#writableRoots(cwd) });
    const key = convKey(agent, meta.id);
    this.s.conversations[key] = {
      agent, id: meta.id, title: title?.trim() || '', agentTitle: '', cwd, createdAt: Date.now(), updatedAt: Date.now(),
      modelKey: modelKey || null, model: meta.model || entry?.model || null, effort: effort || meta.effort || null, provider: meta.provider || null,
      actionMode: mode, links: [], rollout: meta.rolloutPath || null, createdByApp: true, materialized: false,
    };
    if (title?.trim() && agent === 'codex') a.rename(meta.id, title.trim()).catch(() => {});
    // Memory files are opt-in: the client shows the setup window and calls setupMemory().
    this.s.settings.activeConversation = key;
    await this.store.flush();
    return { key, warnings: [] };
  }

  #writableRoots(cwd) {
    const roots = [];
    if (cwd) roots.push(cwd);
    const fb = path.join(this.dataDir, 'memory');
    roots.push(fb);
    return roots;
  }

  /** Serialised per conversation so a double click cannot start two turns. */
  async send(key, body) {
    const prev = this.sendLocks.get(key) || Promise.resolve();
    const job = prev.catch(() => {}).then(() => this.#send(key, body));
    this.sendLocks.set(key, job);
    try { return await job; } finally { if (this.sendLocks.get(key) === job) this.sendLocks.delete(key); }
  }

  async #send(key, { text, modelKey, effort, actionMode, images = [], attachments = [] }) {
    const rec = this.#rec(key);
    const a = this.#agent(rec.agent);
    if (!text?.trim() && !images.length) throw bad('Message is empty');
    const warnings = [];
    // 1. Model and effort: validate, persist, and mirror into config.toml before the turn starts (bug #3).
    const entry = modelKey ? this.modelByKey(modelKey) : (rec.modelKey ? this.modelByKey(rec.modelKey, true) : null);
    if (modelKey && !entry) throw bad('That model is no longer in your list. Choose another model.');
    if (entry && entry.agent !== rec.agent) throw bad(`${entry.label} is not a ${this.agents[rec.agent].label} model.`);
    const err = entry && checkEffort(entry, effort);
    if (err) throw bad(err, { code: 'BAD_EFFORT' });
    if (entry && rec.agent === 'codex' && this.s.settings.syncConfig !== false) {
      try { await a.writeConfig(configEditsFor(entry, effort)); } catch (e) { warnings.push(`config.toml was not updated: ${e.message}`); }
    }
    if (modelKey) rec.modelKey = modelKey;
    if (effort) { rec.effort = effort; if (entry) (this.s.settings.modelEfforts ||= {})[entry.key || modelKey] = effort; }
    if (actionMode && ACTION_MODES.includes(actionMode)) rec.actionMode = actionMode;
    const cwd = effectiveCwd(rec);
    // 2. Shared memory: failures are warnings, never blockers (bug #8).
    let prefix = '', parts = [];
    try {
      let convDir = null;
      if (this.memoryState(rec) === 'enabled') {
        const ens = await this.memory.ensure('conversation', this.convMemoryDir(rec), rec.title || rec.agentTitle || 'Conversation', { rollout: rec.rollout });
        warnings.push(...ens.warnings); convDir = ens.dir;
      }
      const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: convDir ? { dir: convDir } : null, lastHash: rec.lastContextHash, canEdit: a.capabilities?.files !== false });
      warnings.push(...ctx.warnings);
      prefix = ctx.text; parts = ctx.parts;
      if (ctx.hash) rec.lastContextHash = ctx.hash;
    } catch (e) { warnings.push(`Memory files skipped: ${e.message}`); }
    // 3. Attachments: images go to the agent as images; text files are inlined; others are referenced by path.
    const att = await this.#prepareAttachments(attachments);
    images = [...images, ...att.images];
    if (att.text) text = `${text}\n\n${att.text}`;
    // 4. Start the turn.
    const r = await a.send(rec.id, {
      text: prefix + text, images, cwd, model: entry?.model, provider: entry?.provider, effort: effort || rec.effort,
      mode: rec.actionMode || this.s.settings.defaultActionMode, writableRoots: this.#writableRoots(cwd),
    });
    rec.updatedAt = Date.now(); rec.materialized = true;
    if (prefix) this.memory.saveSnapshot(key, parts);
    delete this.s.drafts?.[key];
    this.store.save();
    this.#ack(key, rec).catch(() => {});
    return { ...r, warnings, contextSent: !!prefix, contextTokens: prefix ? Math.ceil(prefix.length / 4) : 0 };
  }

  /** Reports the model and effort Codex actually holds for the thread after the turn started (rec. 6). */
  async #ack(key, rec) {
    if (rec.agent !== 'codex') return;
    const r = await this.agents.codex.rpc('thread/read', { threadId: rec.id, includeTurns: false }, 10_000);
    this.emit('event', { type: 'turn.ack', key, model: r.thread?.model || null, effort: r.thread?.reasoningEffort || null, provider: r.thread?.modelProvider || null });
  }

  #memoryArgs(rec) {
    return { folder: effectiveCwd(rec), links: (rec.links || []).filter((l) => fs.existsSync(l.file)), exclude: rec.memoryExclude || [], pins: rec.pins || [] };
  }

  /** Memory workspace: what will be sent next turn, sizes, inclusion and changes since last sent (rec. 5). */
  async memoryPreview(key) {
    const rec = this.#rec(key);
    const state = this.memoryState(rec);
    const cd = this.convMemoryDir(rec);
    const { parts, warnings } = await this.memory.collect({ ...this.#memoryArgs(rec), conversation: state === 'enabled' ? { dir: cd.dir } : null });
    const snap = await this.memory.loadSnapshot(key);
    const out = parts.map((p) => {
      const prev = p.file && snap?.files ? snap.files[p.file] : undefined;
      const changed = p.file ? (prev === undefined ? 'new' : prev === p.content ? 'same' : 'changed') : 'pins';
      return { label: p.label, file: p.file, group: p.group, editable: p.editable, chars: p.chars, tokens: p.tokens, included: p.included, truncated: !!p.truncated, changed,
        diff: changed === 'changed' ? lineDiff(prev, p.content).filter((d, i, arr) => d.op !== '=' || arr[i - 1]?.op !== '=' || arr[i + 1]?.op !== '=') : null };
    });
    const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: state === 'enabled' ? { dir: cd.dir } : null, lastHash: rec.lastContextHash });
    return { memoryState: state, parts: out, pins: rec.pins || [], warnings, lastSentAt: snap?.at || null,
      totalTokens: out.filter((p) => p.included).reduce((n, p) => n + p.tokens, 0), willSend: !!ctx.text };
  }

  async stop(key) { const rec = this.#rec(key); return { stopped: await this.#agent(rec.agent).interrupt(rec.id) }; }

  approve(key, requestKey, decision, answers) {
    const rec = this.#rec(key);
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw bad('Invalid decision');
    this.#agent(rec.agent).respond(requestKey, decision, answers);
    return { ok: true };
  }

  async renameConversation(key, title) {
    const rec = this.#rec(key);
    const t = String(title || '').trim();
    if (!t) throw bad('Title is empty');
    if (t.length > 200) throw bad('Title is too long');
    rec.title = t;
    const ag = this.agents[rec.agent];
    if (ag && (rec.materialized !== false || rec.agent.startsWith('api-'))) await ag.rename(rec.id, t).catch((e) => { rec.renameError = e.message; });
    this.store.save();
    return { ok: true };
  }

  async moveConversation(key, folder) {
    const rec = this.#rec(key);
    const to = normalizePath(folder);
    if (!to) throw bad('Choose a folder');
    await this.ensureFolder(to, { create: false });
    const from = this.convMemoryDir(rec);
    rec.cwdOverride = to; rec.lastContextHash = null;
    const toDir = this.memory.conversationDir(to, rec.agent, rec.id);
    if (from.dir !== toDir.dir) await this.memory.moveConversation(from.dir, toDir.dir).catch(() => {});
    await this.agents[rec.agent]?.setCwd?.(rec.id, to).catch(() => {});
    this.store.save();
    return { ok: true };
  }

  async archiveConversation(key) {
    const rec = this.#rec(key);
    if (rec.materialized === false && !rec.agent.startsWith('api-')) { rec.archived = true; this.store.save(); return { ok: true }; }
    await this.agents[rec.agent]?.archive?.(rec.id);
    rec.archived = true; this.store.save();
    return { ok: true };
  }

  async unarchiveConversation(key) {
    const rec = this.#rec(key);
    if (rec.materialized !== false || rec.agent.startsWith('api-')) await this.agents[rec.agent]?.unarchive?.(rec.id);
    rec.archived = false; this.store.save();
    return { ok: true };
  }

  async deleteConversation(key) {
    const rec = this.#rec(key);
    if (rec.agent === 'codex' && rec.materialized !== false) {
      try { await this.agents.codex.remove(rec.id); } catch (e) { if (!/not found/i.test(e.message)) throw e; }
    } else if (rec.agent !== 'codex') await this.agents[rec.agent]?.remove(rec.id).catch(() => {});
    delete this.s.conversations[key];
    if (this.s.settings.activeConversation === key) this.s.settings.activeConversation = null;
    this.store.save();
    return { ok: true };
  }

  setConversationOptions(key, { actionMode, links, pins, exclude }) {
    const rec = this.#rec(key);
    if (pins !== undefined) { if (!Array.isArray(pins)) throw bad('pins must be a list'); rec.pins = pins.map((p) => String(p).slice(0, 2000)).filter((p) => p.trim()).slice(0, 50); rec.lastContextHash = null; }
    if (exclude !== undefined) { if (!Array.isArray(exclude)) throw bad('exclude must be a list'); rec.memoryExclude = exclude.filter((f) => typeof f === 'string' && this.isMemoryFile(f)); rec.lastContextHash = null; }
    if (actionMode !== undefined) { if (!ACTION_MODES.includes(actionMode)) throw bad('Unknown action mode'); rec.actionMode = actionMode; }
    if (links !== undefined) {
      if (!Array.isArray(links)) throw bad('links must be a list');
      rec.links = links.filter((l) => l && typeof l.file === 'string' && this.isMemoryFile(l.file)).map((l) => ({ label: String(l.label || path.basename(path.dirname(l.file))), file: l.file }));
      rec.lastContextHash = null;
    }
    this.store.save();
    return { ok: true, record: rec };
  }

  // ------------------------------------------------------------------ agent events
  #onAgentEvent(agentId, e) {
    const key = e.threadId ? convKey(agentId, e.threadId) : null;
    this.emit('event', { ...e, agent: agentId, key });
    if (!key || !this.s.conversations[key]) return;
    const rec = this.s.conversations[key];
    if (e.type === 'thread.renamed' && e.name && !rec.title) rec.agentTitle = e.name;
    if (e.type === 'turn.completed') {
      rec.updatedAt = Date.now(); rec.materialized = true;
      this.#afterTurn(key).catch(() => {});
    }
  }

  async #afterTurn(key) {
    const rec = this.s.conversations[key];
    const a = this.agents[rec.agent];
    const data = await a.readConversation(rec.id).catch(() => null);
    if (data?.meta?.rolloutPath) rec.rollout = data.meta.rolloutPath;
    if (!rec.agentTitle && data?.meta?.title) rec.agentTitle = data.meta.title;
    const cd = this.convMemoryDir(rec);
    if (fs.existsSync(cd.dir)) {
      if (rec.rollout) await this.memory.setRolloutComment(path.join(cd.dir, FILES.context), rec.rollout).catch(() => {});
      if (data && this.s.settings.transcriptCopy !== false) await this.memory.writeTranscript(cd.dir, itemsToMarkdown(rec.title || rec.agentTitle || 'Conversation', data.items));
    }
    // Edits made by the agent during the turn are already known to it: do not resend them next turn.
    const cwd = effectiveCwd(rec);
    void cwd;
    const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: this.memoryState(rec) === 'enabled' ? { dir: cd.dir } : null }).catch(() => null);
    if (ctx?.hash) { rec.lastContextHash = ctx.hash; if (ctx.parts) await this.memory.saveSnapshot(key, ctx.parts); }
    this.itemCache.delete(key);
    this.store.save();
    this.emit('event', { type: 'conversation.updated', key });
  }

  // ------------------------------------------------------------------ folders
  async ensureFolder(p, { create }) {
    const n = normalizePath(p);
    if (!n) throw bad('Invalid folder');
    if (fs.existsSync(n)) { if (!fs.statSync(n).isDirectory()) throw bad(`${n} is a file, not a folder`); return n; }
    if (!create) throw bad(`Folder not found: ${n}`);
    if (isRootPath(n)) throw bad(`Drive ${n} is not available`);
    for (const seg of splitPath(n).slice(1)) { const e = validateName(seg); if (e) throw bad(`${seg}: ${e}`); }
    try { await fsp.mkdir(n, { recursive: true }); } catch (e) { throw bad(`Could not create ${n}: ${e.code || e.message}`); }
    return n;
  }

  async addFolder(p, { create = false } = {}) {
    const n = await this.ensureFolder(p, { create });
    this.s.folders[pathKey(n)] = { path: n, addedAt: Date.now() };
    this.s.settings.activeFolder = n;
    this.store.save();
    return { path: n };
  }

  async newFolder(parent, name) {
    const err = validateName(name); if (err) throw bad(err);
    const base = await this.ensureFolder(parent, { create: false });
    const target = joinSegments([...splitPath(base), name.trim()]);
    if (fs.existsSync(target)) throw bad(`"${name}" already exists here`);
    await fsp.mkdir(target);
    return this.addFolder(target);
  }

  forgetFolder(p) { delete this.s.folders[pathKey(p)]; this.store.save(); return { ok: true }; }

  #conversationsUnder(p) { return Object.entries(this.s.conversations).filter(([, r]) => isInside(effectiveCwd(r), p)); }

  #assertNotRunning(p) {
    for (const [, r] of this.#conversationsUnder(p)) if (this.agents[r.agent]?.activeTurns?.has(r.id)) throw new HttpError(409, 'A reply is running in a conversation inside this folder. Stop it first.');
  }

  /** Renames the folder on disk and re-points every conversation, memory link and pinned folder inside it. */
  async renameFolder(p, name) {
    const from = normalizePath(p);
    const err = validateName(name); if (err) throw bad(err);
    if (isRootPath(from)) throw bad('A drive cannot be renamed');
    if (!fs.existsSync(from)) throw bad('Folder not found');
    const to = joinSegments([...splitPath(parentPath(from)), name.trim()]);
    if (pathKey(to) === pathKey(from) && to === from) return { path: to };
    if (fs.existsSync(to) && pathKey(to) !== pathKey(from)) throw bad(`"${name}" already exists here`);
    this.#assertNotRunning(from);
    try { await fsp.rename(from, to); } catch (e) {
      throw bad(e.code === 'EBUSY' || e.code === 'EPERM' ? 'Windows refused the rename: a program (VS Code, MATLAB, Explorer, a terminal) is using this folder. Close it and retry.' : `Rename failed: ${e.code || e.message}`);
    }
    this.#rebaseAll(from, to);
    return { path: to };
  }

  #rebaseAll(from, to) {
    for (const r of Object.values(this.s.conversations)) {
      const cwd = effectiveCwd(r);
      if (isInside(cwd, from)) { r.cwdOverride = rebase(cwd, from, to); r.lastContextHash = null; this.agents[r.agent]?.loaded?.delete(r.id); }
      for (const l of r.links || []) if (isInside(l.file, from)) l.file = rebase(l.file, from, to);
    }
    for (const [k, f] of Object.entries(this.s.folders)) if (isInside(f.path, from)) { delete this.s.folders[k]; const np = rebase(f.path, from, to); this.s.folders[pathKey(np)] = { ...f, path: np }; }
    if (this.s.settings.activeFolder && isInside(this.s.settings.activeFolder, from)) this.s.settings.activeFolder = rebase(this.s.settings.activeFolder, from, to);
    this.store.save();
  }

  /** Moves the folder to the app trash (restorable). Conversations inside are archived, not deleted. */
  async trashFolder(p) {
    const from = normalizePath(p);
    if (isRootPath(from)) throw bad('A drive cannot be moved to the trash');
    if (!fs.existsSync(from)) { this.forgetFolder(from); return { ok: true, forgotten: true }; }
    this.#assertNotRunning(from);
    const id = crypto.randomUUID();
    const sameDrive = path.join(path.parse(from).root, '.cpm-trash', id);
    let dest = canWrite(path.parse(from).root) ? sameDrive : path.join(this.dataDir, 'trash', id);
    await fsp.mkdir(path.dirname(dest), { recursive: true }).catch(() => { dest = path.join(this.dataDir, 'trash', id); });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try { await fsp.rename(from, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw bad(e.code === 'EBUSY' || e.code === 'EPERM' ? 'The folder is in use by another program. Close it and retry.' : `Could not move to trash: ${e.code || e.message}`);
      await fsp.cp(from, dest, { recursive: true }); await fsp.rm(from, { recursive: true, force: true });
    }
    const archived = [];
    for (const [key, r] of this.#conversationsUnder(from)) { if (!r.archived) { r.archived = true; r.archivedByTrash = id; archived.push(key); if (r.agent === 'codex' && r.materialized !== false) await this.agents.codex.archive(r.id).catch(() => {}); } }
    this.s.trash.push({ id, kind: 'folder', originalPath: from, trashPath: dest, deletedAt: Date.now(), conversations: archived });
    for (const [k, f] of Object.entries(this.s.folders)) if (isInside(f.path, from)) delete this.s.folders[k];
    this.store.save();
    return { ok: true, id };
  }

  async restoreFolder(id) {
    const t = this.s.trash.find((x) => x.id === id);
    if (!t) throw bad('Not in trash');
    if (fs.existsSync(t.originalPath)) throw bad(`Cannot restore: ${t.originalPath} exists again. Rename it first.`);
    await fsp.mkdir(parentPath(t.originalPath), { recursive: true });
    try { await fsp.rename(t.trashPath, t.originalPath); } catch (e) {
      if (e.code !== 'EXDEV') throw bad(`Restore failed: ${e.code || e.message}`);
      await fsp.cp(t.trashPath, t.originalPath, { recursive: true }); await fsp.rm(t.trashPath, { recursive: true, force: true });
    }
    for (const key of t.conversations || []) { const r = this.s.conversations[key]; if (r && r.archivedByTrash === id) { r.archived = false; delete r.archivedByTrash; if (r.agent === 'codex' && r.materialized !== false) await this.agents.codex.unarchive(r.id).catch(() => {}); } }
    this.s.trash = this.s.trash.filter((x) => x.id !== id);
    this.s.folders[pathKey(t.originalPath)] = { path: t.originalPath, addedAt: Date.now() };
    this.store.save();
    return { path: t.originalPath };
  }

  /** Permanent deletion requires typing the folder name. */
  async purgeFolder(id, confirmName) {
    const t = this.s.trash.find((x) => x.id === id);
    if (!t) throw bad('Not in trash');
    if (confirmName !== baseName(t.originalPath)) throw bad(`Type the folder name "${baseName(t.originalPath)}" to confirm permanent deletion`);
    await fsp.rm(t.trashPath, { recursive: true, force: true });
    this.s.trash = this.s.trash.filter((x) => x.id !== id);
    this.store.save();
    return { ok: true };
  }

  /** Minimal folder browser for the "Open folder" dialog. */
  async listDir(p) {
    if (!p) {
      if (process.platform === 'win32') {
        const drives = [];
        for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { fs.accessSync(d); drives.push({ name: d, path: d }); } catch { /* absent */ } }
        return { path: '', parent: null, dirs: drives, home: os.homedir() };
      }
      p = os.homedir();
    }
    const n = normalizePath(p);
    let entries;
    try { entries = await fsp.readdir(n, { withFileTypes: true }); } catch (e) { throw bad(`Cannot open ${n}: ${e.code}`); }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== MEMORY_DIR && e.name !== '.cpm-trash')
      .map((e) => ({ name: e.name, path: joinSegments([...splitPath(n), e.name]) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    return { path: n, parent: isRootPath(n) ? (process.platform === 'win32' ? '' : null) : parentPath(n), dirs, home: os.homedir() };
  }

  // ------------------------------------------------------------------ memory files
  isMemoryFile(file) {
    const n = path.resolve(String(file || ''));
    if (![FILES.context, FILES.instructions, 'TRANSCRIPT.md'].includes(path.basename(n))) return false;
    return n.split(path.sep).includes(MEMORY_DIR) || isInside(n, path.join(this.dataDir, 'memory'));
  }

  async readMemory(file) { if (!this.isMemoryFile(file)) throw bad('Not a memory file'); try { return await this.memory.read(file); } catch (e) { throw bad(`Cannot read: ${e.code || e.message}`); } }

  async writeMemory(file, content, version) {
    if (!this.isMemoryFile(file) || path.basename(file) === 'TRANSCRIPT.md') throw bad('Not an editable memory file');
    if (typeof content !== 'string' || content.length > 200_000) throw bad('Content too large');
    try { return await this.memory.write(file, content, version); } catch (e) { throw e.code === 'CONFLICT' ? new HttpError(409, e.message) : bad(`Cannot save: ${e.code || e.message}`); }
  }

  async folderMemory(folder) {
    const f = await this.ensureFolder(folder, { create: false });
    const r = await this.memory.ensure('folder', this.memory.folderDir(f), baseName(f));
    return { ...r.files, warnings: r.warnings };
  }

  /** All memory files that exist, for the "link context" picker. */
  async memoryCatalog() {
    const out = [];
    const base = [...Object.values(this.s.folders).map((f) => f.path), ...Object.values(this.s.conversations).map(effectiveCwd).filter(Boolean)];
    const folders = new Map();
    for (const f of base) for (const c of this.memory.folderChain(f)) folders.set(pathKey(c), c); // includes parents that have memory (e.g. X1191)
    for (const f of folders.values()) {
      const d = this.memory.folderDir(f);
      for (const name of [FILES.context, FILES.instructions]) { const file = path.join(d.dir, name); if (fs.existsSync(file)) out.push({ group: 'folder', label: `${baseName(f)} — ${name}`, folder: f, file }); }
    }
    for (const [key, r] of Object.entries(this.s.conversations)) {
      if (r.missing) continue;
      const d = this.convMemoryDir(r);
      for (const name of [FILES.context, FILES.instructions]) { const file = path.join(d.dir, name); if (fs.existsSync(file)) out.push({ group: 'conversation', key, label: `${r.title || r.agentTitle || 'Conversation'} — ${name}`, folder: effectiveCwd(r), file }); }
    }
    return out;
  }

  // ------------------------------------------------------------------ models & config
  models() { return mergeModels(this.agentModels, this.s.models, this.s.hiddenModels); }

  modelByKey(key, quiet = false) {
    const m = this.models().find((x) => x.key === key);
    if (!m && !quiet) return null;
    return m || null;
  }

  async importModelProfile({ text, label }) {
    let res;
    try { res = profileFromToml(text, label); } catch (e) { throw bad(e.message); }
    if (this.s.models.some((m) => m.model === res.entry.model && m.provider === res.entry.provider && (m.label === res.entry.label))) throw bad('This model is already in your list');
    this.s.models.push(res.entry);
    this.store.save();
    return { entry: res.entry, dropped: res.dropped, envKey: res.envKey, envKeySaved: res.envKey ? (await this.secrets.list()).some((s) => s.name === res.envKey) : null };
  }

  addModel({ label, model, provider, effort, efforts, providerConfig, agent = 'codex' }) {
    if (!model?.trim()) throw bad('Model name is required');
    if (!this.agents[agent]) throw bad('Unknown agent');
    const entry = { id: crypto.randomUUID(), agent, label: label?.trim() || model.trim(), model: model.trim(), provider: provider?.trim() || null, providerConfig: providerConfig || null, effort: effort || null, efforts: Array.isArray(efforts) && efforts.length ? efforts : null, extras: {}, source: 'custom' };
    this.s.models.push(entry); this.store.save();
    return { entry };
  }

  removeModel(key) {
    if (key.startsWith('custom:')) this.s.models = this.s.models.filter((m) => `custom:${m.id}` !== key);
    else if (!this.s.hiddenModels.includes(key)) this.s.hiddenModels.push(key);
    this.store.save();
    return { ok: true };
  }

  restoreAgentModels() { this.s.hiddenModels = []; this.store.save(); return { ok: true }; }

  async configSummary() {
    const cfg = await this.agents.codex.readConfig();
    return {
      file: path.join(this.codexHome, 'config.toml'), model: cfg.model, provider: cfg.model_provider, effort: cfg.model_reasoning_effort,
      approvalPolicy: cfg.approval_policy, sandbox: cfg.sandbox_mode,
      mcpServers: Object.entries(cfg.mcp_servers || {}).map(([name, v]) => ({ name, enabled: v?.enabled !== false, url: v?.url || null, command: v?.command || null })),
      providers: Object.keys(cfg.model_providers || {}),
    };
  }

  /** Replaces config.toml after validation; keeps a timestamped backup and rolls back if Codex rejects it. */
  async loadConfigToml(text) {
    let parsed;
    try { parsed = parseToml(text); } catch (e) { throw bad(`Invalid TOML — nothing was changed. ${e.message}`); }
    const secrets = findInlineSecrets(parsed);
    const file = path.join(this.codexHome, 'config.toml');
    await fsp.mkdir(this.codexHome, { recursive: true });
    const backupDir = path.join(this.dataDir, 'config-backups');
    await fsp.mkdir(backupDir, { recursive: true });
    let backup = null;
    if (fs.existsSync(file)) { backup = path.join(backupDir, `config-${new Date().toISOString().replace(/[:.]/g, '-')}.toml`); await fsp.copyFile(file, backup); }
    await fsp.writeFile(file, text);
    try { await this.restartAgent('codex'); await this.agents.codex.readConfig(); }
    catch (e) {
      if (backup) await fsp.copyFile(backup, file); else await fsp.rm(file, { force: true });
      await this.restartAgent('codex').catch(() => {});
      throw bad(`Codex rejected the file, the previous configuration was restored. ${e.message}`);
    }
    return { ok: true, backup, inlineSecretWarnings: secrets };
  }

  // ------------------------------------------------------------------ tools
  async updateTool(tool, patch) {
    const cfg = this.s.tools[tool];
    if (!cfg) throw bad('Unknown tool');
    const allowed = Object.keys(cfg);
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) cfg[k] = v;
    if (tool === 'git') this.git = new Git({ executable: cfg.executable });
    // Tickboxes for MCP-backed tools map to `enabled` on their Codex MCP entry.
    const warn = [];
    if ('enabled' in (patch || {}) && (tool === 'jira' || tool === 'matlab')) {
      const name = tool === 'jira' ? cfg.serverName : cfg.mcpServer;
      try {
        const sum = await this.configSummary();
        if (sum.mcpServers.some((s) => s.name === name)) { await this.agents.codex.writeConfig([{ keyPath: `mcp_servers.${name}.enabled`, value: !!cfg.enabled }]); await this.agents.codex.reloadMcp().catch(() => {}); }
        else if (cfg.enabled) warn.push(tool === 'jira' ? 'Jira is enabled but not configured yet: complete Configuration › Jira.' : `No "${name}" MCP server in config.toml yet: run the MATLAB Agentic Toolkit setup.`);
      } catch (e) { warn.push(`config.toml not updated: ${e.message}`); }
    }
    this.store.save();
    return { tools: this.s.tools, warnings: warn };
  }

  toolsInfo() {
    return {
      vscode: { found: findVSCode(this.s.tools.vscode.command) },
      matlab: { installs: findMatlabInstalls() },
      git: { available: this.git.available() },
    };
  }

  #folderFor({ key, folder }) {
    if (key) return effectiveCwd(this.#rec(key));
    const f = normalizePath(folder);
    if (!f || !fs.existsSync(f)) throw bad('Folder not found');
    return f;
  }

  async openVSCode(body) {
    if (!this.s.tools.vscode.enabled) throw bad('VS Code is disabled. Tick it in Configuration.');
    const folder = this.#folderFor(body);
    const exe = await openInVSCode(this.s.tools.vscode.command, folder, { file: body.file, line: body.line }).catch((e) => { throw bad(e.message); });
    return { ok: true, exe };
  }

  async openMatlab(body) {
    if (!this.s.tools.matlab.enabled) throw bad('MATLAB is disabled. Tick it in Configuration.');
    const folder = this.#folderFor(body);
    const inst = await launchMatlab(this.s.tools.matlab, folder, this.dataDir, { runSetup: !!body.setup }).catch((e) => { throw bad(e.message); });
    return { ok: true, release: inst.release };
  }

  async reveal(p) {
    const n = normalizePath(p);
    if (!n || !fs.existsSync(n)) throw bad('Path not found');
    const target = fs.statSync(n).isDirectory() ? n : path.dirname(n);
    await openExternal(target).catch((e) => { throw bad(e.message); });
    return { ok: true };
  }

  // ------------------------------------------------------------------ git
  #gitFolder(body) {
    if (!this.s.tools.git.enabled) throw bad('Git is disabled. Tick it in Configuration.');
    return this.#folderFor(body);
  }

  async gitStatus(body) {
    const cwd = this.#gitFolder(body);
    const st = await this.git.status(cwd);
    if (st.repo) { st.remotes = await this.git.remotes(cwd); st.branches = await this.git.branches(cwd); }
    return st;
  }

  async gitOp(body) {
    const cwd = this.#gitFolder(body);
    let r;
    try { r = await this.git.op(cwd, body.op, body.args || {}); } catch (e) { throw bad(e.message); }
    return { ok: r.ok, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim(), hint: r.hint || null };
  }

  async gitDiff(body) { const cwd = this.#gitFolder(body); const r = await this.git.diff(cwd, body.file, body.staged); return { diff: r.stdout }; }
  async gitLog(body) { return { log: await this.git.log(this.#gitFolder(body), body.n) }; }

  async pullRequest(body) {
    const cwd = this.#gitFolder(body);
    const st = await this.git.status(cwd);
    if (!st.repo) throw bad('Not a Git repository');
    const remotes = await this.git.remotes(cwd);
    const rem = remotes.find((r) => r.name === (body.remote || 'origin')) || remotes[0];
    if (!rem) throw bad('This repository has no remote. Add one (e.g. your Bitbucket URL) first.');
    let info = rem.web;
    const bb = this.s.tools.bitbucket;
    if (bb.enabled && bb.flavor === 'server' && bb.baseUrl && info && info.kind === 'generic') info = webInfo(rem.url.replace(/^.*?@([^:/]+)[:/]/, `${bb.baseUrl.replace(/\/$/, '')}/scm/`)) || info;
    const url = pullRequestUrl(info, st.branch, body.target || bb.defaultBranch || null);
    if (!url) throw bad(`Pull requests are not supported for ${rem.url}. Open the repository website to create one.`);
    if (body.open !== false) await openExternal(url).catch(() => {});
    return { url, host: info.kind };
  }

  // ------------------------------------------------------------------ jira
  async configureJira(body) {
    const j = this.s.tools.jira;
    const name = (body.serverName || j.serverName || 'jira').replace(/[^A-Za-z0-9_-]/g, '');
    const edits = [];
    if (body.mode === 'remote') {
      if (!/^https:\/\//.test(body.url || '')) throw bad('The MCP endpoint must start with https://');
      const server = { url: body.url, enabled: true };
      if (body.auth === 'bearer') {
        if (body.token) await this.secrets.set('JIRA_MCP_TOKEN', body.token, 'Jira MCP bearer token');
        server.bearer_token_env_var = 'JIRA_MCP_TOKEN';
      }
      edits.push({ keyPath: `mcp_servers.${name}`, value: server });
    } else if (body.mode === 'local') {
      if (!body.command) throw bad('Enter the command that starts the Jira connector (e.g. uvx)');
      if (!/^https:\/\//.test(body.site || '')) throw bad('Jira site URL must start with https://');
      const env = { JIRA_URL: body.site };
      if (body.email) env.JIRA_USERNAME = body.email;
      if (body.token) await this.secrets.set('JIRA_API_TOKEN', body.token, 'Jira API token');
      edits.push({ keyPath: `mcp_servers.${name}`, value: { command: body.command, args: Array.isArray(body.args) ? body.args : String(body.args || '').split(/\s+/).filter(Boolean), env, env_vars: ['JIRA_API_TOKEN'], enabled: true } });
    } else throw bad('Choose remote or local');
    await this.agents.codex.writeConfig(edits);
    Object.assign(j, { mode: body.mode, serverName: name, url: body.url || '', auth: body.auth || 'oauth', site: body.site || '', email: body.email || '', command: body.command || '', args: body.args || [], enabled: true });
    this.store.save();
    await this.restartAgent('codex').catch(() => {});
    return { ok: true, needsLogin: body.mode === 'remote' && body.auth !== 'bearer' };
  }

  async jiraLogin() {
    const r = await this.agents.codex.mcpLogin(this.s.tools.jira.serverName || 'jira');
    if (r?.authorizationUrl || r?.url) await openExternal(r.authorizationUrl || r.url).catch(() => {});
    return r;
  }

  // ------------------------------------------------------------------ secrets
  async listSecrets() { return { ...this.secrets.describe(), secrets: await this.secrets.list() }; }
  async setSecret(name, value, description) {
    if (!NAME_RE.test(name || '')) throw bad('Use an environment-variable name, e.g. AZURE_OPENAI_API_KEY');
    try { await this.secrets.set(name, value, description); } catch (e) { throw bad(e.message); }
    return { ok: true, restartNeeded: true };
  }
  async removeSecret(name) { await this.secrets.remove(name); return { ok: true }; }

  // ------------------------------------------------------------------ skills & plugins
  async listSkills(folder) {
    const cwds = [normalizePath(folder) || os.homedir()];
    const data = await this.agents.codex.listSkills(cwds).catch(() => []);
    return { skills: (data[0]?.skills || []).map((s) => ({ name: s.name, description: s.description, scope: s.scope, path: s.path, enabled: s.enabled !== false })), targets: skillTargets(this.codexHome, cwds[0]) };
  }

  async installSkill({ source, scope = 'global', folder, replace = false, select }) {
    const targets = skillTargets(this.codexHome, normalizePath(folder));
    const target = scope === 'folder' ? targets.folder : targets.global;
    if (!target) throw bad('Select a conversation or folder for a folder-scoped skill');
    const src = String(source || '').trim();
    if (!src) throw bad('Enter a GitHub link or a local folder');
    let root, cleanup = null, plugin = [];
    const gh = parseGitHubSource(src);
    if (gh) {
      const got = await fetchGitHub(gh, path.join(this.dataDir, 'tmp')).catch((e) => { throw bad(e.message); });
      cleanup = got.dir; root = path.join(got.root, gh.sub || '');
      if (!fs.existsSync(root)) { await fsp.rm(cleanup, { recursive: true, force: true }); throw bad(`Path "${gh.sub}" not found in the repository`); }
      plugin = detectPluginRepo(got.root);
    } else {
      root = normalizePath(src);
      if (!fs.existsSync(root)) throw bad('Not a GitHub link and not an existing folder');
    }
    try {
      let skills = await findSkills(root);
      if (Array.isArray(select) && select.length) skills = skills.filter((s) => select.includes(s.name));
      if (!skills.length) {
        if (plugin.length && gh) return { kind: 'plugin', message: 'This repository is a plugin marketplace. Use “Add marketplace” to install its plugins.', source: `${gh.owner}/${gh.repo}` };
        throw bad('No SKILL.md found at that location');
      }
      const results = await installSkills(skills, target, { replace });
      await this.agents.codex.listSkills([normalizePath(folder) || os.homedir()]).catch(() => {});
      return { kind: 'skills', target, results, plugin: plugin.length > 0 };
    } finally { if (cleanup) await fsp.rm(cleanup, { recursive: true, force: true }).catch(() => {}); }
  }

  async plugins() {
    const r = await this.agents.codex.rpc('plugin/list', { forceRefetch: false });
    return { marketplaces: (r.marketplaces || []).map((m) => ({ name: m.name, path: m.path, plugins: (m.plugins || []).map((p) => ({ id: p.id, name: p.name, installed: p.installed, enabled: p.enabled, version: p.version, description: p.interface?.shortDescription || p.interface?.description || '' })) })), errors: r.marketplaceLoadErrors || [] };
  }

  async addMarketplace(source) {
    const gh = parseGitHubSource(source);
    const s = gh ? `${gh.owner}/${gh.repo}` : normalizePath(source);
    if (!s) throw bad('Enter owner/repo, a GitHub URL or a local folder');
    const r = await this.agents.codex.rpc('marketplace/add', { source: s, refName: gh?.ref || null }, 300_000);
    return r;
  }

  async installPlugin({ marketplacePath, pluginName }) {
    if (!pluginName) throw bad('pluginName is required');
    return this.agents.codex.rpc('plugin/install', { marketplacePath: marketplacePath || null, pluginName }, 300_000);
  }

  // ------------------------------------------------------------------ drafts (rec. 2)
  setDraft(key, text) {
    this.s.drafts ||= {};
    const t = String(text ?? '');
    if (t.length > 200_000) throw bad('Draft too large');
    if (t.trim()) this.s.drafts[key] = t; else delete this.s.drafts[key];
    this.store.save();
    return { ok: true };
  }

  // ------------------------------------------------------------------ search (rec. 4)
  async search({ q, folder, days }) {
    const sinceMs = +days > 0 ? Date.now() - +days * 86_400_000 : 0;
    const f = normalizePath(folder || '');
    const sources = [];
    const folderMem = new Map();
    for (const [key, r] of Object.entries(this.s.conversations)) {
      if (r.missing) continue;
      const cwd = effectiveCwd(r);
      if (f && !isInside(cwd, f)) continue;
      if (sinceMs && (r.updatedAt || 0) < sinceMs) continue;
      const cd = this.convMemoryDir(r);
      const mem = [FILES.context, FILES.instructions].map((n) => path.join(cd.dir, n)).filter((p) => fs.existsSync(p));
      if (cwd && !folderMem.has(pathKey(cwd))) { const fd = this.memory.folderDir(cwd); folderMem.set(pathKey(cwd), 1); for (const n of [FILES.context, FILES.instructions]) { const p = path.join(fd.dir, n); if (fs.existsSync(p)) mem.push(p); } }
      sources.push({ key, title: r.title || r.agentTitle || 'New conversation', cwd, updatedAt: r.updatedAt, rollout: r.rollout && fs.existsSync(r.rollout) ? r.rollout : null, memoryFiles: mem });
    }
    sources.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { results: await fullTextSearch(sources, q) };
  }

  // ------------------------------------------------------------------ integration checks (rec. 7)
  async checkTool(tool, folder) { return { tool, checks: await checkTool(this, tool, { folder: folder ? normalizePath(folder) : null }) }; }

  // ------------------------------------------------------------------ support (rec. 8)
  async about(appRoot) { return { ...(await versionInfo(appRoot, this.agents.codex.version)), dataDir: this.dataDir, codexHome: this.codexHome, backups: await listBackups(this.dataDir) }; }
  checkUpdates(appRoot) { return checkUpdates(appRoot); }
  async backupNow() { await this.store.flush(); return { name: await backupState(this.dataDir, { reason: 'manual' }) }; }
  async restoreBackup(name) {
    const data = await readBackup(this.dataDir, name).catch((e) => { throw bad(e.message); });
    await this.store.flush();
    await backupState(this.dataDir, { reason: 'before-restore' });
    this.store.state = { ...this.store.state, ...data, settings: { ...this.store.state.settings, ...data.settings } };
    await this.store.flush();
    await this.refresh().catch(() => {});
    return { ok: true };
  }
  async diagnostics(appRoot) {
    const tools = {};
    for (const t of ['codex', 'vscode', 'matlab', 'git', 'bitbucket', 'jira']) tools[t] = await checkTool(this, t).catch((e) => [{ name: t, ok: false, detail: e.message }]);
    const cfg = await this.configSummary().catch((e) => ({ error: e.message }));
    const rawState = this.store.state;
    return redact({
      generatedAt: new Date().toISOString(), version: await versionInfo(appRoot, this.agents.codex.version),
      agents: Object.fromEntries(Object.entries(this.agents).map(([k, a]) => [k, a.status()])),
      config: cfg, tools, toolSettings: rawState.tools, settings: { ...rawState.settings, expanded: undefined, modelEfforts: undefined },
      counts: { conversations: Object.keys(rawState.conversations).length, folders: Object.keys(rawState.folders).length, models: rawState.models.length, trash: rawState.trash.length },
      secrets: { ...this.secrets.describe(), names: (await this.secrets.list()).map((s) => s.name) },
      log: logLines().slice(-200),
    });
  }

  // ------------------------------------------------------------------ accounts & providers
  async providersInfo() {
    const keys = new Set((await this.secrets.list()).map((s) => s.name));
    const cli = ['codex', 'claude'].map((id) => ({ id, ...this.agents[id].status(), installed: !!this.agents[id].findBinary() }));
    const api = this.s.providers.map((p) => ({ ...p, keySaved: !p.keyName || keys.has(p.keyName), agent: `api-${p.id}` }));
    return { cli, api, presets: PRESETS };
  }

  async saveProvider(body) {
    const existing = this.s.providers.find((p) => p.id === body.id);
    let p;
    try { p = normalizeProvider({ ...(existing || {}), ...body }, this.s.providers.filter((x) => x.id !== body.id).map((x) => x.id)); } catch (e) { throw bad(e.message); }
    if (body.key) await this.secrets.set(p.keyName || `${p.id.toUpperCase().replace(/-/g, '_')}_API_KEY`, body.key, `${p.label} API key`);
    if (existing) Object.assign(existing, p); else this.s.providers.push(p);
    this.#syncApiAgents();
    this.store.save();
    const test = await this.testProvider(p.id).catch((e) => ({ ok: false, error: e.message }));
    return { provider: p, test };
  }

  async removeProvider(id) {
    this.s.providers = this.s.providers.filter((p) => p.id !== id);
    this.#syncApiAgents(); this.store.save();
    return { ok: true };
  }

  async testProvider(id) {
    const a = this.agents[`api-${id}`];
    if (!a) throw bad('Unknown provider');
    const models = await a.listModels();
    this.agentModels[a.id] = models;
    return { ok: true, models: models.length, sample: models.slice(0, 8).map((m) => m.id) };
  }

  // ------------------------------------------------------------------ add-ons
  async addonsInfo() {
    const out = [];
    for (const e of CATALOG) {
      let installed = null;
      if (e.detect) installed = !!which(e.detect);
      if (e.mcp) { const sum = await this.configSummary().catch(() => null); installed = !!sum?.mcpServers.some((m) => m.name === e.mcp.name); }
      const running = e.start ? await healthy(e.start.health) : null;
      out.push({ ...e, installed, running, providerAdded: e.provider ? this.s.providers.some((p) => p.preset === e.provider) : null });
    }
    return { catalog: out, jobs: this.jobs.list(), npm: !!which('npm') };
  }

  /** Starts an add-on job and returns immediately; progress arrives as job.update events. */
  addonInstall({ id, folder, token, targets = ['codex', 'claude'] }) {
    const e = CATALOG.find((x) => x.id === id);
    if (!e) throw bad('Unknown add-on');
    if (e.external) { openExternal(e.external).catch(() => {}); return { opened: e.external }; }
    const job = this.jobs.create(e.name);
    (async () => {
      try {
        if (e.install?.npm) {
          if (!await npmInstallGlobal(e.install.npm, job, this.jobs)) throw new Error('Installation failed (see the log above).');
          for (const k of ['codex', 'claude']) if (e.detect === k) this.emit('event', { type: 'agent.status', agent: k, status: this.agents[k].status() });
        }
        if (e.start) { if (!await startService(e, job, this.jobs)) throw new Error(`${e.name} is installed but not running. Start it with: ${e.start.command}`); }
        if (e.provider && !this.s.providers.some((p) => p.preset === e.provider)) {
          await this.saveProvider({ preset: e.provider }); this.jobs.log(job, `Added provider “${e.name}”.\n`);
        }
        if (e.mcp) await this.#installMcp(e, { folder, token, targets }, job);
        this.jobs.done(job, true, 'Done.');
        this.emit('event', { type: 'addons.changed' });
      } catch (err) { this.jobs.done(job, false, err.message); }
    })();
    return { job: job.id };
  }

  async #installMcp(e, { folder, token, targets }, job) {
    const m = { ...e.mcp };
    if (m.needsFolder) { const f = normalizePath(folder || ''); if (!f || !fs.existsSync(f)) throw new Error('Choose the folder this connector may access.'); m.args = [...m.args, f]; }
    if (m.tokenName) { if (token) await this.secrets.set(m.tokenName, token, `${e.name} token`); else if (!(await this.secrets.list()).some((s) => s.name === m.tokenName)) throw new Error(`Paste your token first (${m.tokenHelp}).`); }
    if (targets.includes('codex')) {
      const v = m.url ? { url: m.url, enabled: true, ...(m.tokenName ? { bearer_token_env_var: m.tokenName } : {}) } : { command: m.command, args: m.args, enabled: true };
      await this.agents.codex.writeConfig([{ keyPath: `mcp_servers.${m.name}`, value: v }]);
      this.jobs.log(job, `Codex: added [mcp_servers.${m.name}]\n`);
    }
    if (targets.includes('claude') && this.agents.claude.findBinary()) {
      if (m.tokenName) this.jobs.log(job, 'Claude Code: skipped (it would store the token in plain text; add it with “claude mcp add” if you accept that).\n');
      else {
        const args = m.url ? ['mcp', 'add', '-s', 'user', '--transport', 'http', m.name, m.url] : ['mcp', 'add', '-s', 'user', m.name, '--', m.command, ...m.args];
        const launch = resolveLaunch(this.agents.claude.findBinary(), { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
        if (launch.shell) this.jobs.log(job, 'Claude Code: run manually: claude ' + args.join(' ') + '\n');
        else { const r = await runProc(launch.command, [...launch.prefixArgs, ...args], { timeout: 60_000 }); this.jobs.log(job, `Claude Code: ${(r.stdout + r.stderr).trim() || (r.ok ? 'added' : 'failed')}\n`); }
      }
    }
    await this.restartAgent('codex').catch(() => {});
    if (m.oauth) { this.jobs.log(job, 'Opening the sign-in page…\n'); await this.agents.codex.mcpLogin(m.name).then((r) => { if (r?.authorizationUrl || r?.url) openExternal(r.authorizationUrl || r.url); }).catch((err) => this.jobs.log(job, `Sign in later from Configuration › Tools › Jira (${err.message}).\n`)); }
  }

  /** Lists the skills inside a GitHub repository (cached 10 min) so the user can pick. */
  async previewSkills(source) {
    const gh = parseGitHubSource(source);
    if (!gh) throw bad('Enter a GitHub link or owner/repo');
    const k = `${gh.owner}/${gh.repo}@${gh.ref || ''}/${gh.sub}`;
    const hit = this.skillPreviews.get(k);
    if (hit && Date.now() - hit.at < 600_000 && fs.existsSync(hit.root)) return { source, skills: hit.skills.map(({ name, description }) => ({ name, description })) };
    const got = await fetchGitHub(gh, path.join(this.dataDir, 'tmp')).catch((e) => { throw bad(e.message); });
    const root = path.join(got.root, gh.sub || '');
    const skills = await findSkills(root, 6);
    this.skillPreviews.set(k, { at: Date.now(), root, dir: got.dir, skills });
    return { source, skills: skills.map(({ name, description }) => ({ name, description })) };
  }

  // ------------------------------------------------------------------ official icons
  async fetchIcons(tools = Object.keys(ICON_SOURCES)) {
    const results = [];
    for (const t of tools) {
      try { const r = await downloadIcon(t, path.join(this.dataDir, 'icons')); this.s.icons[t] = r.file; results.push({ tool: t, ok: true, from: r.from }); }
      catch (e) { results.push({ tool: t, ok: false, error: e.message }); }
    }
    this.store.save();
    return { results, icons: this.s.icons };
  }
  async uploadIcon(tool, name, data) {
    let r; try { r = await saveUploadedIcon(tool, name, data, path.join(this.dataDir, 'icons')); } catch (e) { throw bad(e.message); }
    this.s.icons[tool] = r.file; this.store.save(); return { icons: this.s.icons };
  }
  async resetIcon(tool) { delete this.s.icons[tool]; this.store.save(); return { icons: this.s.icons }; }
  iconFile(tool) { const f = this.s.icons[tool]; if (!f || !/^[a-z]+\.(svg|png|ico|jpg|webp)$/.test(f)) return null; return path.join(this.dataDir, 'icons', f); }

  // ------------------------------------------------------------------ project hub
  #knownFolder(p) {
    const n = normalizePath(p);
    const roots = [...Object.values(this.s.folders).map((f) => f.path), ...Object.values(this.s.conversations).map(effectiveCwd)].filter(Boolean);
    if (!n || !roots.some((r) => isInside(n, r) || isInside(r, n))) throw new HttpError(403, 'This folder is not one of your projects');
    return n;
  }

  async projectOverview(folder) {
    const f = this.#knownFolder(folder);
    if (!fs.existsSync(f)) throw bad('Folder not found');
    const convs = this.convList().filter((c) => !c.archived && isInside(c.cwd, f));
    const fd = this.memory.folderDir(f);
    const mem = Object.fromEntries(Object.entries(FILES).map(([k, n]) => [k, fs.existsSync(path.join(fd.dir, n)) ? path.join(fd.dir, n) : null]));
    let git = null;
    if (this.s.tools.git.enabled) { const st = await this.git.status(f).catch(() => null); if (st?.repo) git = { branch: st.branch, changes: st.files.length, ahead: st.ahead, behind: st.behind, upstream: st.upstream }; }
    const skillsDir = path.join(f, '.agents', 'skills');
    let skills = []; try { skills = (await fsp.readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
    let readme = null;
    for (const n of ['README.md', 'readme.md', 'README.txt', 'README']) { try { readme = (await fsp.readFile(path.join(f, n), 'utf8')).slice(0, 4000); break; } catch { /* next */ } }
    return { path: f, name: baseName(f), conversations: convs, memory: mem, git, skills, readme, files: await this.listFiles(f) };
  }

  async listFiles(folder, sub = '') {
    const root = this.#knownFolder(folder);
    const dir = sub ? normalizePath(path.join(root, sub)) : root;
    if (!isInside(dir, root)) throw new HttpError(403, 'Outside the project');
    let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { throw bad(`Cannot open: ${e.code}`); }
    const hidden = new Set(['.git', 'node_modules', '.cpm', '.cpm-trash', '__pycache__', '.venv', '.DS_Store']);
    const out = [];
    for (const e of entries) {
      if (hidden.has(e.name)) continue;
      let st = null; try { st = await fsp.stat(path.join(dir, e.name)); } catch { continue; }
      out.push({ name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs, path: path.join(dir, e.name) });
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { root, dir, rel: path.relative(root, dir), entries: out.slice(0, 2000) };
  }

  async readProjectFile(folder, file) {
    const root = this.#knownFolder(folder);
    const p = normalizePath(file);
    if (!isInside(p, root)) throw new HttpError(403, 'Outside the project');
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isFile()) throw bad('Not a file');
    if (st.size > 400_000) return { path: p, size: st.size, tooLarge: true };
    const buf = await fsp.readFile(p);
    if (buf.includes(0)) return { path: p, size: st.size, binary: true };
    return { path: p, size: st.size, text: buf.toString('utf8') };
  }

  // ------------------------------------------------------------------ attachments
  async saveAttachment({ key, name, data }) {
    const rec = this.#rec(key);
    const clean = String(name || 'file').replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw bad('Empty file');
    if (buf.length > 20 * 1024 * 1024) throw bad('Files must be smaller than 20 MB');
    const cwd = effectiveCwd(rec);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let dir = cwd && canWrite(cwd) ? path.join(cwd, MEMORY_DIR, 'attachments') : path.join(this.dataDir, 'attachments', crypto.createHash('sha1').update(key).digest('hex').slice(0, 12));
    await fsp.mkdir(dir, { recursive: true }).catch(async () => { dir = path.join(this.dataDir, 'attachments'); await fsp.mkdir(dir, { recursive: true }); });
    const file = path.join(dir, `${stamp}-${clean}`);
    await fsp.writeFile(file, buf);
    const ext = path.extname(clean).toLowerCase();
    const kind = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? 'image' : buf.includes(0) ? 'binary' : 'text';
    return { path: file, name: clean, kind, size: buf.length };
  }

  async #prepareAttachments(list) {
    const images = [], blocks = [];
    for (const a of (Array.isArray(list) ? list : []).slice(0, 20)) {
      const p = normalizePath(a?.path || '');
      if (!p || !fs.existsSync(p)) continue;
      if (!p.split(/[\\/]/).includes(MEMORY_DIR) && !isInside(p, path.join(this.dataDir, 'attachments'))) continue; // only files saved by saveAttachment
      if (a.kind === 'image') { images.push(p); continue; }
      const st = await fsp.stat(p);
      if (a.kind === 'text' && st.size <= 150_000) blocks.push(`Attached file \`${path.basename(p)}\` (saved at ${p}):\n\`\`\`\n${await fsp.readFile(p, 'utf8')}\n\`\`\``);
      else blocks.push(`Attached file: ${p} (${Math.round(st.size / 1024)} KB)`);
    }
    return { images, text: blocks.join('\n\n') };
  }

  // ------------------------------------------------------------------ settings
  updateSettings(patch) {
    const allowed = ['theme', 'lang', 'sidebarHidden', 'gitPanelOpen', 'activeConversation', 'activeFolder', 'expanded', 'defaultActionMode', 'openMode', 'syncConfig', 'transcriptCopy', 'agentBins', 'lastModelKey', 'modelEfforts', 'onboarded', 'askMemory', 'uiMode', 'quitOnWindowClose', 'defaultAgent', 'prompts'];
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) this.s.settings[k] = v;
    if (patch?.agentBins) for (const k of ['codex', 'claude']) this.agents[k].binSetting = patch.agentBins[k] || '';
    if (patch?.prompts && (!Array.isArray(patch.prompts) || patch.prompts.length > 200)) throw bad('Invalid prompt list');
    this.store.save();
    return this.s.settings;
  }
}

/** Official tool logos are optional files in public/logos/ (not shipped; see README). */
function availableLogos() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'logos');
  try { return fs.readdirSync(dir).filter((f) => /\.(svg|png)$/i.test(f)).map((f) => f); } catch { return []; }
}

function kindOf(method) {
  return { 'item/commandExecution/requestApproval': 'command', execCommandApproval: 'command', 'item/fileChange/requestApproval': 'fileChange', applyPatchApproval: 'fileChange', 'item/permissions/requestApproval': 'permissions', 'item/tool/requestUserInput': 'question', 'mcpServer/elicitation/request': 'elicitation' }[method] || 'other';
}
function pickApproval(p = {}) { return { itemId: p.itemId, command: p.command, cwd: p.cwd, reason: p.reason ?? null, questions: p.questions ?? null, message: p.message ?? null, permissions: p.permissions ?? null }; }
