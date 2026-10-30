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
import { CATALOG, Jobs, npmInstallGlobal, startService, healthy, pythonToolInstall, runJob } from './addons.mjs';
import { downloadIcon, saveUploadedIcon, ICON_SOURCES, ICON_SET_VERSION } from './icons.mjs';
import { which, run as runProc, resolveLaunch } from './proc.mjs';
import { Memory, FILES, MEMORY_DIR, LEGACY_DIR, canWrite, lineDiff, looseFiles, LOOSE_RE } from './memory.mjs';
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
import { parseMcpJson, toCodexEntry, safeName } from './mcpjson.mjs';
import { itemsToMarkdown } from './items.mjs';
import { Connections } from './connections.mjs';
import { specStatus, initArgs, phaseMessage, PHASES } from './speckit.mjs';
import { Checkpoints, MAX_CHECKPOINTS } from './checkpoints.mjs';
import { usageFromFile, add as addUsage } from './usage.mjs';
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
    this.conn = new Connections(this);
  }

  #wire(a) {
    // One faulty event must never stop the conversation's stream (it is logged instead).
    a.on('event', (e) => { try { this.#onAgentEvent(a.id, e); } catch (err) { console.error(`[event ${e?.type}]`, err); } });
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
    this.autoFetchIcons();
    try { await this.agents.codex.start(); } catch (e) { /* surfaced via status */ void e; }
    await this.refresh().catch((e) => this.emit('event', { type: 'warning', message: `Could not list conversations: ${e.message}` }));
  }

  async restartAgent(id = 'codex') {
    if (this.closing) return { id, state: 'stopped' };
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
    this.closing = true;
    for (const a of Object.values(this.agents)) { a.closed = true; await a.stop().catch(() => {}); }
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
      key, record: { ...rec, cwd, title: rec.title || rec.agentTitle || 'New conversation', rolloutName: rec.rollout ? path.basename(rec.rollout.replace(/\\/g, '/')) : null, memoryState: this.memoryState(rec), folderFiles: looseFiles(cwd), memoryFound: this.memoryFound(rec) },
      items: data.items.slice(start), total: data.items.length, offset: start,
      running: data.running, pending: data.pending.map((p) => ({ requestKey: p.requestKey, kind: kindOf(p.method), ...pickApproval(p.params) })),
      memory: await this.memoryInfo(rec), draft: this.s.drafts?.[key] || '', usage: await this.usageOf(rec, data),
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

  /** Conversation-specific memory files of earlier versions (<folder>/.cpm/conversations/<agent>-<id>/). */
  #convFilesDir(rec) {
    const d = this.convMemoryDir(rec);
    return fs.existsSync(path.join(d.dir, FILES.context)) || fs.existsSync(path.join(d.dir, FILES.instructions)) ? d.dir : null;
  }

  /** Every context/instructions file that applies to this conversation, and the folders searched. */
  memoryFound(rec) {
    const cwd = effectiveCwd(rec);
    const { searched, found } = this.memory.discover(cwd);
    found.push(...this.#legacy(rec));
    const cd = this.#convFilesDir(rec);
    if (cd) for (const [k, n] of Object.entries(FILES)) { const f = path.join(cd, n); if (fs.existsSync(f)) found.push({ file: f, folder: cwd, kind: k, current: true, conversation: true }); }
    return { searched, files: found };
  }

  /** Context/instructions files that a new conversation in `folder` would load (names and paths only). */
  discoverMemory(folder) {
    const f = normalizePath(folder);
    if (!f) throw bad('Folder missing');
    const { searched, found } = this.memory.discover(f);
    return { searched, files: found.map(({ file, kind, current, folder: d }) => ({ file, kind, current, folder: d })) };
  }

  /**
   * 'enabled' when the conversation's folder (or its own memory) has context/instructions files; otherwise
   * 'declined' if the user said no, else 'ask' (the app offers to create them). Files found in parent folders
   * are loaded in every case.
   */
  memoryState(rec) {
    // Files of parent folders are always loaded, but the question is about this conversation's own folder.
    if (this.memoryFound(rec).files.some((f) => f.current)) return 'enabled';
    return rec.memory === 'declined' ? 'declined' : 'ask';
  }

  /** Setup window: create (with the user's text) or decline conversation memory; optionally rename. */
  async setupMemory(key, { enable, title, context, instructions }) {
    const rec = this.#rec(key);
    if (title && String(title).trim() && String(title).trim() !== (rec.title || rec.agentTitle)) await this.renameConversation(key, title);
    if (!enable) { rec.memory = 'declined'; this.store.save(); return { memoryState: this.memoryState(rec) }; }
    const cwd = effectiveCwd(rec);
    const r = await this.memory.createFolderFiles(cwd, { title: rec.title || rec.agentTitle || baseName(cwd), context, instructions }, this.convMemoryDir(rec).fallback);
    if (!r.dir) throw bad(`Could not create the files: ${r.warnings.join('; ')}`);
    // Folder not writable: the files live in the app data folder, where convMemoryDir() finds them as this conversation's memory.
    rec.memory = 'enabled'; rec.lastContextHash = null; rec.promptsSinceMemoryAsk = 0;
    this.store.save();
    return { memoryState: 'enabled', files: r.files, warnings: r.warnings, found: this.memoryFound(rec) };
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

  async #send(key, { text, modelKey, effort, actionMode, images = [], attachments = [], memoryUpdate = false }) {
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
      const convDir = this.#convFilesDir(rec);
      const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: convDir ? { dir: convDir } : null, lastHash: rec.lastContextHash, canEdit: a.capabilities?.files !== false });
      warnings.push(...ctx.warnings);
      prefix = ctx.text; parts = ctx.parts;
      if (ctx.hash) rec.lastContextHash = ctx.hash;
    } catch (e) { warnings.push(`Memory files skipped: ${e.message}`); }
    // 3. Attachments: images go to the agent as images; text files are inlined; others are referenced by path.
    const att = await this.#prepareAttachments(attachments);
    images = [...images, ...att.images];
    if (att.text) text = `${text}\n\n${att.text}`;
    // 4. Checkpoint: the folder's files as they are before the AI acts (Git repositories, file-editing agents).
    if (a.capabilities?.files !== false && this.s.settings.checkpoints !== false && this.s.tools.git.enabled !== false) {
      try {
        const cp = await new Checkpoints(this.git).create(cwd, `${rec.agent}-${rec.id}`, memoryUpdate ? 'memory update' : text.split('\n')[0]);
        if (cp) {
          rec.checkpoints = [...(rec.checkpoints || []), cp];
          for (const old of rec.checkpoints.splice(0, Math.max(0, rec.checkpoints.length - MAX_CHECKPOINTS))) new Checkpoints(this.git).drop(cwd, `${rec.agent}-${rec.id}`, old.id).catch(() => {});
          if (cp.partial) warnings.push('Checkpoint: large new files (over 200 MB in total) are not included.');
        }
      } catch (e) { warnings.push(`Checkpoint not taken: ${e.message}`); }
    }
    // 5. Start the turn.
    const r = await a.send(rec.id, {
      text: prefix + text, images, cwd, model: entry?.model, provider: entry?.provider, effort: effort || rec.effort,
      mode: rec.actionMode || this.s.settings.defaultActionMode, writableRoots: this.#writableRoots(cwd),
    });
    rec.updatedAt = Date.now(); rec.materialized = true;
    if (prefix) this.memory.saveSnapshot(key, parts);
    delete this.s.drafts?.[key];
    // Every N prompts (5–10, setting) ask whether to update the context and instructions files.
    let askMemoryUpdate = false;
    if (!memoryUpdate && this.memoryState(rec) === 'enabled') {
      rec.promptsSinceMemoryAsk = (rec.promptsSinceMemoryAsk || 0) + 1;
      const every = +this.s.settings.memoryAskEvery || 0;
      if (every > 0 && rec.promptsSinceMemoryAsk >= every) {
        if (this.s.settings.memoryUpdateMode === 'auto') { rec.promptsSinceMemoryAsk = 0; rec.autoMemoryAfterTurn = true; }
        else askMemoryUpdate = true;
      }
    }
    this.store.save();
    // What was asked for, at once; what Codex confirms replaces it (thread/settings/updated, or thread/read after the turn).
    this.emit('event', { type: 'turn.ack', key, model: entry?.model || null, effort: effort || rec.effort || null, provider: entry?.provider || null, requested: true });
    return { ...r, effort: effort || rec.effort || null, model: entry?.model || null, warnings, contextSent: !!prefix, contextTokens: prefix ? Math.ceil(prefix.length / 4) : 0, askMemoryUpdate, promptsSinceMemoryAsk: rec.promptsSinceMemoryAsk || 0 };
  }

  /**
   * Updates the context/instructions files from the conversation. CLI agents (Codex, Claude Code) edit the
   * files themselves; API chats return each file between markers and the app writes them (editable files only).
   */
  async updateMemory(key, { choice = 'auto', remember = false } = {}) {
    const rec = this.#rec(key);
    if (!['auto', 'manual', 'later'].includes(choice)) throw bad('Unknown choice');
    rec.promptsSinceMemoryAsk = 0;
    if (remember) this.s.settings.memoryUpdateMode = choice === 'later' ? 'ask' : choice;
    this.store.save();
    if (choice !== 'auto') return { ok: true, choice };
    if (this.#agent(rec.agent).activeTurns?.has?.(rec.id)) { rec.autoMemoryAfterTurn = true; this.store.save(); return { ok: true, choice, queued: true }; }
    return { ok: true, choice, ...(await this.#autoMemoryTurn(key)) };
  }

  async #autoMemoryTurn(key) {
    const rec = this.#rec(key);
    const a = this.#agent(rec.agent);
    const cdir = this.#convFilesDir(rec);
    const { parts } = await this.memory.collect({ ...this.#memoryArgs(rec), conversation: cdir ? { dir: cdir } : null });
    const files = parts.filter((p) => p.editable && p.file && p.included).map((p) => p.file);
    if (!files.length) throw bad('No editable context or instructions file in this conversation folder. Create them first.');
    const canEdit = a.capabilities?.files !== false;
    rec.lastContextHash = null; // send the current content with this request
    const text = canEdit
      ? ['Memory update (requested from AI Management APP):', 'Update these files now with what we agreed and learned in this conversation since they were last updated:', ...files.map((f) => `- ${f}`),
        '- Context files: durable facts, decisions, results and progress.', '- Instructions files: agreed working rules and preferences.',
        'Keep what the user wrote, stay concise, never store credentials. Then reply with a short list of what you changed.'].join('\n')
      : ['Memory update (requested from AI Management APP):', 'Rewrite these files with what we agreed and learned in this conversation. Keep what the user wrote, stay concise, never store credentials.',
        'Return each complete file exactly in this form, one block per file, and nothing else after the blocks:', '=== FILE: <full path> ===', '<complete new content>', '=== END FILE ===', 'Files:', ...files.map((f) => `- ${f}`)].join('\n');
    if (!canEdit) rec.pendingMemoryWrite = { files, at: Date.now() };
    this.store.save();
    const r = await this.#send(key, { text, memoryUpdate: true });
    return { turnId: r.turnId, files, mode: canEdit ? 'agent-edits' : 'app-writes' };
  }

  /** API chats: writes the files returned between markers (only the files that were asked for). */
  async #applyMemoryBlocks(key, text) {
    const rec = this.s.conversations[key];
    const pend = rec?.pendingMemoryWrite;
    if (!pend) return;
    delete rec.pendingMemoryWrite;
    const allowed = new Map(pend.files.map((f) => [pathKey(f), f]));
    const written = [];
    for (const m of String(text || '').matchAll(/=== FILE: (.+?) ===\r?\n([\s\S]*?)\r?\n=== END FILE ===/g)) {
      const target = allowed.get(pathKey(normalizePath(m[1].trim())));
      if (!target) continue;
      try { await fsp.writeFile(target, m[2].replace(/\s+$/, '') + '\n'); written.push(target); } catch { /* read-only file: skipped */ }
    }
    this.store.save();
    this.emit('event', { type: 'memory.updated', key, files: written });
  }

  /** Reports the model and effort Codex actually holds for the thread after the turn started (rec. 6). */
  async #ack(key, rec) {
    if (rec.agent !== 'codex') return;
    const r = await this.agents.codex.rpc('thread/read', { threadId: rec.id, includeTurns: false }, 10_000);
    this.emit('event', { type: 'turn.ack', key, model: r.thread?.model || null, effort: r.thread?.reasoningEffort || null, provider: r.thread?.modelProvider || null, confirmed: true });
  }

  /** Memory files of version 1.x for this conversation (see Memory.legacyConversation). */
  #legacy(rec) {
    if (!effectiveCwd(rec)) return [];
    return this.memory.legacyConversation(effectiveCwd(rec), { threadId: rec.agent === 'codex' ? rec.id : null, rollout: rec.rollout, title: rec.title || rec.agentTitle });
  }

  #memoryArgs(rec) {
    return { folder: effectiveCwd(rec), links: (rec.links || []).filter((l) => fs.existsSync(l.file)), exclude: rec.memoryExclude || [], pins: rec.pins || [], extra: this.#legacy(rec) };
  }

  /** Memory workspace: what will be sent next turn, sizes, inclusion and changes since last sent (rec. 5). */
  async memoryPreview(key) {
    const rec = this.#rec(key);
    const state = this.memoryState(rec);
    const cdir = this.#convFilesDir(rec);
    const { parts, warnings } = await this.memory.collect({ ...this.#memoryArgs(rec), conversation: cdir ? { dir: cdir } : null });
    const snap = await this.memory.loadSnapshot(key);
    const out = parts.map((p) => {
      const prev = p.file && snap?.files ? snap.files[p.file] : undefined;
      const changed = p.file ? (prev === undefined ? 'new' : prev === p.content ? 'same' : 'changed') : 'pins';
      return { label: p.label, file: p.file, group: p.group, editable: p.editable, chars: p.chars, tokens: p.tokens, included: p.included, truncated: !!p.truncated, changed,
        diff: changed === 'changed' ? lineDiff(prev, p.content).filter((d, i, arr) => d.op !== '=' || arr[i - 1]?.op !== '=' || arr[i + 1]?.op !== '=') : null };
    });
    const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: cdir ? { dir: cdir } : null, lastHash: rec.lastContextHash });
    return { memoryState: state, found: this.memoryFound(rec), parts: out, pins: rec.pins || [], warnings, lastSentAt: snap?.at || null,
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

  setConversationOptions(key, { actionMode, links, pins, exclude, modelKey, effort }) {
    const rec = this.#rec(key);
    // Model / effort chosen in the composer are kept with the conversation at once (not only when a message is sent).
    if (modelKey !== undefined || effort !== undefined) {
      const entry = this.modelByKey(modelKey ?? rec.modelKey, true);
      if (modelKey !== undefined) { if (!entry) throw bad('That model is no longer in your list.'); if (entry.agent !== rec.agent) throw bad(`${entry.label} is not a ${this.agents[rec.agent].label} model.`); rec.modelKey = modelKey; }
      if (effort !== undefined && effort !== null) { const err = entry && checkEffort(entry, effort); if (err) throw bad(err, { code: 'BAD_EFFORT' }); rec.effort = effort; if (entry) (this.s.settings.modelEfforts ||= {})[entry.key] = effort; }
    }
    if (pins !== undefined) { if (!Array.isArray(pins)) throw bad('pins must be a list'); rec.pins = pins.map((p) => String(p).slice(0, 2000)).filter((p) => p.trim()).slice(0, 50); rec.lastContextHash = null; }
    if (exclude !== undefined) { if (!Array.isArray(exclude)) throw bad('exclude must be a list'); rec.memoryExclude = exclude.filter((f) => typeof f === 'string' && this.isMemoryFile(f)); rec.lastContextHash = null; }
    if (actionMode !== undefined) { if (!ACTION_MODES.includes(actionMode)) throw bad('Unknown action mode'); rec.actionMode = actionMode; }
    if (links !== undefined) {
      if (!Array.isArray(links)) throw bad('links must be a list');
      rec.links = links.filter((l) => l && typeof l.file === 'string' && (this.isMemoryFile(l.file) || this.#isLinkable(l.file))).map((l) => ({ label: String(l.label || path.basename(path.dirname(l.file))), file: normalizePath(l.file) }));
      rec.lastContextHash = null;
    }
    this.store.save();
    return { ok: true, record: rec };
  }

  // ------------------------------------------------------------------ agent events
  #onAgentEvent(agentId, e) {
    const key = e.threadId ? convKey(agentId, e.threadId) : null;
    if (e.type === 'usage' && key && this.s.conversations[key]) e = { ...e, usage: this.#accumulateUsage(this.s.conversations[key], e) };
    this.emit('event', { ...e, agent: agentId, key });
    if (!key || !this.s.conversations[key]) return;
    const rec = this.s.conversations[key];
    if (e.type === 'thread.renamed' && e.name && !rec.title) rec.agentTitle = e.name;
    if (e.type === 'settings') this.emit('event', { type: 'turn.ack', key, model: e.model, effort: e.effort, provider: e.provider, confirmed: true });
    if (e.type === 'item.completed' && e.item?.kind === 'agent' && rec.pendingMemoryWrite && e.item.status === 'completed') this.#applyMemoryBlocks(key, e.item.text).catch(() => {});
    if (e.type === 'turn.completed') {
      rec.updatedAt = Date.now(); rec.materialized = true;
      this.#afterTurn(key).catch(() => {});
      this.#ack(key, rec).catch(() => {});
      if (rec.autoMemoryAfterTurn && e.status === 'completed') { rec.autoMemoryAfterTurn = false; setTimeout(() => this.#autoMemoryTurn(key).catch((err) => this.emit('event', { type: 'memory.updated', key, files: [], error: err.message })), 300); }
      else if (rec.autoMemoryAfterTurn) rec.autoMemoryAfterTurn = false;
    }
  }

  /** Conversation totals: Codex reports its own running total; Claude Code and API chats are summed per turn. */
  #accumulateUsage(rec, e) {
    const u = e.usage || {};
    const prev = rec.usage || null;
    const next = e.cumulative && u.total
      ? { total: u.total, last: u.last, contextWindow: u.contextWindow ?? prev?.contextWindow ?? null, contextUsed: u.contextUsed ?? null }
      : { total: addUsage(prev?.total, u.last), last: u.last, contextWindow: u.contextWindow ?? prev?.contextWindow ?? null, contextUsed: u.last ? u.last.input + u.last.cacheRead + u.last.cacheWrite : null };
    next.turns = (prev?.turns || 0) + (e.cumulative ? 0 : 1);
    next.updatedAt = Date.now();
    rec.usage = next;
    this.store.save();
    return next;
  }

  /** Usage of a conversation, read from the agent's own files when the app has not seen it yet. */
  async usageOf(rec, data) {
    if (rec.usage) return rec.usage;
    let u = null;
    if (rec.agent === 'codex' || rec.agent === 'claude') u = await usageFromFile(data?.meta?.rolloutPath || rec.rollout, rec.agent).catch(() => null);
    else if (data?.meta?.usage) u = { ...data.meta.usage, contextWindow: null };
    if (u) { rec.usage = u; this.store.save(); }
    return u;
  }

  async #afterTurn(key) {
    const rec = this.s.conversations[key];
    const a = this.agents[rec.agent];
    const data = await a.readConversation(rec.id).catch(() => null);
    if (data?.meta?.rolloutPath) rec.rollout = data.meta.rolloutPath;
    if (!rec.agentTitle && data?.meta?.title) rec.agentTitle = data.meta.title;
    const cd = this.convMemoryDir(rec);
    if (this.#convFilesDir(rec) && rec.rollout) await this.memory.setRolloutComment(path.join(cd.dir, FILES.context), rec.rollout).catch(() => {});
    if (data && this.s.settings.transcriptCopy !== false && this.memoryState(rec) === 'enabled') {
      const dir = fs.existsSync(cd.dir) || canWrite(effectiveCwd(rec)) ? cd.dir : cd.fallback;
      await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      const head = rec.rollout ? `<!-- rollout: ${path.basename(rec.rollout.replace(/\\/g, '/'))} -->\n` : '';
      await this.memory.writeTranscript(dir, head + itemsToMarkdown(rec.title || rec.agentTitle || 'Conversation', data.items));
    }
    // Edits made by the agent during the turn are already known to it: do not resend them next turn.
    const cwd = effectiveCwd(rec);
    void cwd;
    const cdir = this.#convFilesDir(rec);
    const ctx = await this.memory.buildContext({ ...this.#memoryArgs(rec), conversation: cdir ? { dir: cdir } : null }).catch(() => null);
    if (ctx?.hash) { rec.lastContextHash = ctx.hash; if (ctx.parts) await this.memory.saveSnapshot(key, ctx.parts); }
    this.itemCache.delete(key);
    this.emit('event', { type: 'files.changed', key });
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
  /** Any Markdown/text file the user chooses as context, inside (or above) one of their project folders. */
  #isLinkable(file) {
    const n = normalizePath(file);
    if (!n || !/\.(md|markdown|txt)$/i.test(n)) return false;
    try { if (!fs.statSync(n).isFile()) return false; this.#knownFolder(path.dirname(n)); return true; } catch { return false; }
  }

  isMemoryFile(file) {
    const n = path.resolve(String(file || ''));
    // The user's own context/instruction files, in (or above) one of their project folders.
    if (LOOSE_RE.test(path.basename(n)) && !n.split(path.sep).includes(MEMORY_DIR)) { try { this.#knownFolder(path.dirname(n)); return true; } catch { return false; } }
    if (![FILES.context, FILES.instructions, 'TRANSCRIPT.md'].includes(path.basename(n))) return false;
    return n.split(path.sep).includes(MEMORY_DIR) || n.split(path.sep).includes(LEGACY_DIR) || isInside(n, path.join(this.dataDir, 'memory'));
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
      // The user's own files (CONTEXT.md / instructions.md… directly in the folder); key = a conversation of that folder.
      const conv = Object.entries(this.s.conversations).find(([, r]) => !r.missing && pathKey(effectiveCwd(r) || '') === pathKey(f));
      for (const file of looseFiles(f, { sub: true })) out.push({ group: 'folder', key: conv?.[0], label: `${baseName(f)} — ${path.basename(file)}`, folder: f, file });
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

  /** Asks one agent (or all) for the models available to the signed-in account right now. */
  async refreshModels(agentId) {
    const ids = agentId ? [agentId] : Object.keys(this.agents);
    const out = {};
    for (const id of ids) {
      const a = this.agents[id];
      if (!a || (a.available && !a.available())) continue;
      try { this.agentModels[id] = await a.listModels(); out[id] = { ok: true, count: this.agentModels[id].length }; }
      catch (e) { out[id] = { ok: false, error: e.message }; }
    }
    return { results: out, models: this.models() };
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
    if (tool === 'git') { const cred = this.git.credentials; this.git = new Git({ executable: cfg.executable }); this.git.credentials = cred; }
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
      matlab: { installs: findMatlabInstalls(), mcp: this.matlabMcpCandidates() },
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
    const cfg = this.s.tools.matlab;
    // The startup script runs shareMATLABSession so the MATLAB MCP server can attach to this session.
    const inst = await launchMatlab({ ...cfg, shareSession: cfg.shareSession !== false || cfg.connectMcp !== false }, folder, this.dataDir, { runSetup: !!body.setup }).catch((e) => { throw bad(e.message); });
    if (cfg.connectMcp !== false && !body.setup) this.connectMatlab({ waitMs: 120_000 }).catch(() => {});
    return { ok: true, release: inst.release, connecting: cfg.connectMcp !== false };
  }

  // ------------------------------------------------------------------ MCP connections (MATLAB, Jira, Bitbucket)
  /** Registers one MCP server in Codex (and Claude Code when possible), keeping every credential in the keychain. */
  async registerMcp(entry, { claude = true } = {}) {
    const { value, secrets } = toCodexEntry(entry);
    for (const sct of secrets) await this.secrets.set(sct.name, sct.value, `MCP ${entry.name}`);
    await this.agents.codex.writeConfig([{ keyPath: `mcp_servers.${entry.name}`, value, mergeStrategy: 'replace' }]);
    const notes = [`Codex: [mcp_servers.${entry.name}] written${secrets.length ? ` (${secrets.map((x) => x.name).join(', ')} kept in the keychain)` : ''}`];
    const cbin = claude && this.agents.claude.findBinary();
    if (cbin) {
      if (secrets.length && !entry.claudeEnvRefs) notes.push('Claude Code: not added automatically because it would store the credential in plain text (~/.claude.json).');
      else {
        const launch = resolveLaunch(cbin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
        const json = JSON.stringify(entry.original || (entry.url ? { type: 'http', url: entry.url } : { command: entry.command, args: entry.args, env: entry.env }));
        if (launch.shell) notes.push(`Claude Code: run once in a terminal: claude mcp add-json -s user ${entry.name} '${json}'`);
        else {
          await runProc(launch.command, [...launch.prefixArgs, 'mcp', 'remove', '-s', 'user', entry.name], { timeout: 30_000 });
          const r = await runProc(launch.command, [...launch.prefixArgs, 'mcp', 'add-json', '-s', 'user', entry.name, json], { timeout: 30_000 });
          notes.push(`Claude Code: ${r.ok ? 'added' : (r.stderr || r.stdout).trim().slice(0, 200)}`);
        }
      }
    }
    const env = await this.secrets.env();
    this.agents.codex.setEnv(env.env);
    await this.restartAgent('codex').catch(() => {});
    return { name: entry.name, notes };
  }

  /** Live state of one MCP server as seen by Codex. Polls until connected or waitMs elapses. */
  async mcpConnection(name, { waitMs = 0 } = {}) {
    const t0 = Date.now();
    let last = { name, ok: false, state: 'missing', detail: 'Not configured' };
    do {
      try {
        const sum = await this.configSummary();
        const cfg = sum.mcpServers.find((m) => m.name === name);
        if (!cfg) return last;
        if (!cfg.enabled) return { name, ok: false, state: 'disabled', detail: 'Disabled (tick the tool to enable it)' };
        await this.agents.codex.reloadMcp().catch(() => {});
        const st = (await this.agents.codex.mcpStatus().catch(() => [])) || [];
        const s0 = (Array.isArray(st) ? st : []).find((x) => x.name === name);
        const tools = s0 ? Object.keys(s0.tools || {}).length : 0;
        const auth = s0?.authStatus?.type || s0?.authStatus || null;
        if (s0 && tools > 0) return { name, ok: true, state: 'connected', tools, auth, detail: `${tools} tools available` };
        last = { name, ok: false, state: /notLoggedIn|not_logged_in|unauth/i.test(String(auth)) ? 'needs-login' : 'waiting', auth, detail: s0?.toolsError || (s0 ? `Waiting for the server (auth: ${auth ?? '?'})` : 'Starting…') };
      } catch (e) { last = { name, ok: false, state: 'error', detail: e.message }; }
      if (Date.now() - t0 >= waitMs) break;
      await new Promise((r) => setTimeout(r, 4000));
    } while (true);
    return last;
  }

  // ---- MATLAB
  matlabMcpCandidates() {
    const home = os.homedir();
    const exe = path.join(home, '.matlab', 'agentic-toolkits', 'bin', process.platform === 'win32' ? 'matlab-mcp-server.exe' : 'matlab-mcp-server');
    const jsons = [];
    const walk = (d, depth) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth > 0 && !/node_modules|\.git/.test(e.name)) walk(p, depth - 1); else if (e.isFile() && /\.json$/i.test(e.name)) { try { const t = fs.readFileSync(p, 'utf8'); if (t.length < 200_000 && /matlab-mcp-server|"matlab"/.test(t) && /mcpServers|"servers"|"command"/.test(t)) jsons.push(p); } catch { /* unreadable */ } } } };
    walk(path.join(home, '.matlab', 'agentic-toolkits'), 3);
    return { exe: fs.existsSync(exe) ? exe : null, jsons: jsons.slice(0, 20) };
  }

  /** ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json): user-scope and project-scope MCP servers of Claude Code. */
  #claudeMcpServers() {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const file = dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    const out = Object.entries(j.mcpServers || {}).map(([name, v]) => ({ name, scope: 'user', value: v }));
    for (const [proj, pv] of Object.entries(j.projects || {})) for (const [name, v] of Object.entries(pv?.mcpServers || {})) out.push({ name, scope: 'project', project: proj, value: v });
    return out;
  }

  /**
   * Every MATLAB MCP definition already on this computer, in the order they are trusted:
   * the JSON the user imported, the entry MathWorks' setupAgenticToolkit wrote into Codex (config.toml)
   * or Claude Code (~/.claude.json), MCP JSON files of the toolkit, and finally the bare server binary.
   */
  async #matlabSources() {
    const cfg = this.s.tools.matlab;
    const isMatlab = (name, v) => /matlab-mcp-server/i.test(String(v?.command || '')) || (/^matlab/i.test(name) && (v?.command || v?.url));
    const out = [];
    if (cfg.mcpEntry) out.push({ from: 'imported', name: cfg.mcpEntry.name, entry: cfg.mcpEntry.original || { command: cfg.mcpEntry.command, args: cfg.mcpEntry.args, env: cfg.mcpEntry.env } });
    const codex = await this.agents.codex.readConfig().catch(() => ({}));
    for (const [name, v] of Object.entries(codex.mcp_servers || {})) if (isMatlab(name, v)) out.push({ from: 'codex', name, entry: v, enabled: v.enabled !== false });
    for (const c of this.#claudeMcpServers()) if (isMatlab(c.name, c.value) && !out.some((o) => o.from === 'claude' && o.name === c.name)) out.push({ from: 'claude', name: c.name, entry: c.value, scope: c.scope });
    const cand = this.matlabMcpCandidates();
    for (const f of cand.jsons) { try { const e = parseMcpJson(fs.readFileSync(f, 'utf8'), 'matlab').find((x) => /matlab/i.test(x.name) || /matlab-mcp-server/i.test(x.command || '')); if (e) out.push({ from: 'json', file: f, name: e.name, entry: e.original || { command: e.command, args: e.args, env: e.env } }); } catch { /* not an MCP JSON */ } }
    if (cand.exe) out.push({ from: 'binary', name: 'matlab', entry: { command: cand.exe, args: [] } });
    return out;
  }

  /** Copies one MCP definition, field for field, into Codex (config.toml) or Claude Code (claude mcp add-json -s user). */
  async #copyMcp(target, name, entry) {
    // Keep exactly what the source declares; only drop keys that belong to the other agent's format.
    const fields = Object.fromEntries(Object.entries(entry || {}).filter(([k, v]) => v !== undefined && v !== null && !['type', 'enabled', 'scope'].includes(k)));
    if (target === 'codex') {
      if (fields.url) delete fields.args;
      await this.agents.codex.writeConfig([{ keyPath: `mcp_servers.${name}`, value: { ...fields, enabled: true }, mergeStrategy: 'replace' }]);
      return `Codex: [mcp_servers.${name}] copied to config.toml`;
    }
    const cbin = this.agents.claude.findBinary();
    if (!cbin) return 'Claude Code: not installed on this computer';
    const json = JSON.stringify(fields.url ? { type: 'http', ...fields } : { type: 'stdio', ...fields });
    const launch = resolveLaunch(cbin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
    if (launch.shell) return `Claude Code: run once in a terminal: claude mcp add-json -s user ${name} '${json}'`;
    await runProc(launch.command, [...launch.prefixArgs, 'mcp', 'remove', '-s', 'user', name], { timeout: 30_000 });
    const r = await runProc(launch.command, [...launch.prefixArgs, 'mcp', 'add-json', '-s', 'user', name, json], { timeout: 30_000 });
    return `Claude Code: ${r.ok ? `${name} copied (user scope)` : (r.stderr || r.stdout).trim().slice(0, 200)}`;
  }

  /** Claude Code's own health check for one server (claude mcp get <name>). */
  async #claudeMcpState(name) {
    const cbin = this.agents.claude.findBinary();
    if (!cbin) return { agent: 'claude', ok: false, state: 'missing', detail: 'Claude Code not installed' };
    if (!this.#claudeMcpServers().some((c) => c.name === name)) return { agent: 'claude', ok: false, state: 'missing', detail: 'Not configured in Claude Code' };
    const launch = resolveLaunch(cbin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
    if (launch.shell) return { agent: 'claude', ok: true, state: 'connected', detail: 'Configured (Claude Code connects it when a conversation starts)' };
    const r = await runProc(launch.command, [...launch.prefixArgs, 'mcp', 'get', name], { timeout: 45_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    if (/✓|connected/i.test(out) && !/failed|✗/i.test(out)) return { agent: 'claude', ok: true, state: 'connected', detail: 'Connected' };
    if (/needs auth|authenticat/i.test(out)) return { agent: 'claude', ok: false, state: 'needs-login', detail: 'Sign-in needed' };
    return { agent: 'claude', ok: false, state: 'waiting', detail: (out.match(/Status:\s*(.+)/i)?.[1] || 'Not answering yet (is MATLAB running with shareMATLABSession?)').trim().slice(0, 160) };
  }

  matlabAgents() {
    const a = this.s.tools.matlab.agents;
    return Array.isArray(a) && a.length ? a.filter((x) => x === 'codex' || x === 'claude') : null;
  }

  async matlabMcpInfo() {
    const cfg = this.s.tools.matlab;
    const sources = await this.#matlabSources();
    const name = sources[0]?.name || cfg.mcpServer || 'matlab';
    const inCodex = sources.find((x) => x.from === 'codex') || null;
    const inClaude = sources.find((x) => x.from === 'claude') || null;
    const agents = this.matlabAgents() || [inCodex && 'codex', inClaude && 'claude'].filter(Boolean);
    return {
      name, agents, askAgent: !this.matlabAgents(), sources: sources.map(({ from, name: n, file, entry, scope }) => ({ from, name: n, file, scope, command: entry.command || entry.url, args: entry.args || [] })),
      inCodex: inCodex ? { name: inCodex.name, command: inCodex.entry.command, url: inCodex.entry.url } : null,
      inClaude: inClaude ? { name: inClaude.name, command: inClaude.entry.command, url: inClaude.entry.url } : null,
      imported: cfg.mcpEntry || null, claudeInstalled: !!this.agents.claude.findBinary(), ...this.matlabMcpCandidates(),
      connection: await this.mcpConnection(inCodex?.name || name),
    };
  }

  /** Imports the MATLAB MCP definition exactly as written in a JSON file (or pasted JSON) and copies it to the chosen agents. */
  async importMatlabMcp({ text, file, agents }) {
    let src = text;
    if (!src && file) { const f = normalizePath(file); if (!this.matlabMcpCandidates().jsons.includes(f)) throw bad('Choose one of the detected files or paste the JSON'); src = await fsp.readFile(f, 'utf8'); }
    let entries; try { entries = parseMcpJson(src, 'matlab'); } catch (e) { throw bad(e.message); }
    const entry = entries.find((e) => /matlab/i.test(e.name) || /matlab-mcp-server/i.test(e.command || '')) || entries[0];
    this.s.tools.matlab.mcpEntry = entry; this.s.tools.matlab.mcpServer = entry.name; this.store.save();
    return this.connectMatlab({ agents, waitMs: 15_000, force: true });
  }

  /**
   * The only question asked is which agent(s) MATLAB is for; the server definition is copied as is from
   * where MathWorks' setup (or the user) put it. Then waits until the server answers (MATLAB may still be starting).
   */
  async connectMatlab({ waitMs = 30_000, agents, force = false } = {}) {
    const cfg = this.s.tools.matlab;
    if (Array.isArray(agents)) {
      const a = agents.filter((x) => x === 'codex' || x === 'claude');
      if (!a.length) throw bad('Choose Codex, Claude Code or both');
      cfg.agents = a; this.store.save();
    }
    const sources = await this.#matlabSources();
    // Not chosen yet: use the agent(s) MathWorks' setup already configured, else Codex.
    const configured = ['codex', 'claude'].filter((a) => sources.some((x) => x.from === a));
    const targets = this.matlabAgents() || (configured.length ? configured : ['codex']);
    const notes = [];
    if (!sources.length) {
      const r = { name: cfg.mcpServer || 'matlab', ok: false, state: 'missing', detail: 'MATLAB MCP server not found. In MATLAB run setupAgenticToolkit("install") (MathWorks Agentic Toolkit), or import your MCP JSON.', agents: targets };
      this.emit('event', { type: 'mcp.connection', ...r, label: 'MATLAB' });
      return r;
    }
    const best = sources[0];
    const name = best.name;
    for (const target of targets) {
      const present = sources.find((x) => x.from === target && x.name === name);
      if (present && !force) {
        if (target === 'codex' && present.enabled === false) { await this.agents.codex.writeConfig([{ keyPath: `mcp_servers.${name}.enabled`, value: true }]); notes.push(`Codex: [mcp_servers.${name}] enabled`); }
        else notes.push(`${target === 'codex' ? 'Codex' : 'Claude Code'}: already configured (${present.from === 'codex' ? 'config.toml' : '~/.claude.json'})`);
        continue;
      }
      if (best.from === 'imported' && toCodexEntry(cfg.mcpEntry).secrets.length) {
        // Credentials in the imported JSON go to the keychain, never into a config file in plain text.
        if (target === 'codex') notes.push(...(await this.registerMcp(cfg.mcpEntry, { claude: false })).notes);
        else notes.push('Claude Code: not copied because the JSON contains a credential that Claude Code would store in plain text (~/.claude.json).');
        continue;
      }
      notes.push(await this.#copyMcp(target, name, best.entry));
    }
    cfg.mcpServer = name; this.store.save();
    const states = [];
    if (targets.includes('codex')) {
      await this.agents.codex.reloadMcp().catch(() => {});
      states.push({ agent: 'codex', ...(await this.mcpConnection(name, { waitMs })) });
    }
    if (targets.includes('claude')) states.push(await this.#claudeMcpState(name));
    const ok = states.every((x) => x.ok);
    const r = { name, ok, state: ok ? 'connected' : (states.find((x) => !x.ok)?.state || 'waiting'), detail: states.map((x) => `${x.agent === 'codex' ? 'Codex' : 'Claude Code'}: ${x.detail}`).join(' · '), agents: targets, states, source: best.from, notes };
    this.emit('event', { type: 'mcp.connection', ...r, label: 'MATLAB' });
    return r;
  }

  // ---- Atlassian (Jira, Confluence, Bitbucket Cloud) — official Rovo MCP server
  // OAuth: https://mcp.atlassian.com/v1/mcp/authv2 · API token: https://mcp.atlassian.com/v2/mcp with
  // "Authorization: Basic base64(email:token)" (service account: "Bearer <key>"). Bitbucket Cloud tools need a token.
  async connectAtlassian({ purpose = 'jira', mode = 'oauth', email, token }) {
    const tool = purpose === 'bitbucket' ? 'bitbucket' : 'jira';
    const name = purpose === 'bitbucket' ? 'atlassian-bitbucket' : safeName(this.s.tools.jira.serverName || 'atlassian');
    if (purpose === 'bitbucket' && mode === 'oauth') throw bad('Bitbucket Cloud tools of the Atlassian MCP server work only with an API token.');
    let entry;
    if (mode === 'oauth') entry = { name, type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2', headers: {}, original: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp/authv2' } };
    else {
      if (!token) { if (!(await this.secrets.list()).some((x) => x.name === `ATLASSIAN_${name.toUpperCase().replace(/-/g, '_')}_AUTH`)) throw bad('Paste the API token'); }
      if (mode === 'token' && !/^[^@\s]+@[^@\s]+$/.test(email || '')) throw bad('Enter the e-mail address of the Atlassian account that owns the token');
      const secretName = `ATLASSIAN_${name.toUpperCase().replace(/-/g, '_')}_AUTH`;
      if (token) await this.secrets.set(secretName, mode === 'service' ? `Bearer ${token}` : `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, `Atlassian MCP (${purpose})`);
      entry = { name, type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', headers: { Authorization: `\${${secretName}}` }, original: null };
    }
    const r = await this.registerMcp(entry, { claude: mode === 'oauth' });
    if (mode !== 'oauth') r.notes.push('Claude Code: add it yourself if you accept a token stored in ~/.claude.json (claude mcp add --transport http …).');
    Object.assign(this.s.tools[tool], { enabled: true, mcpName: name, mcpMode: mode, ...(email ? { email } : {}) });
    if (tool === 'jira') Object.assign(this.s.tools.jira, { mode: 'remote', serverName: name, url: entry.url, auth: mode === 'oauth' ? 'oauth' : 'bearer' });
    this.store.save();
    if (mode === 'oauth') { try { const lg = await this.agents.codex.mcpLogin(name); if (lg?.authorizationUrl || lg?.url) await openExternal(lg.authorizationUrl || lg.url); r.notes.push('Sign-in page opened in your browser.'); } catch (e) { r.notes.push(`Sign in from the card later (${e.message}).`); } }
    const connection = await this.mcpConnection(name, { waitMs: mode === 'oauth' ? 0 : 20_000 });
    this.emit('event', { type: 'mcp.connection', ...connection, label: purpose === 'bitbucket' ? 'Bitbucket' : 'Jira' });
    return { ...r, connection };
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

  // ------------------------------------------------------------------ checkpoints (restore files to before a message)
  listCheckpoints(key) { const rec = this.#rec(key); return { checkpoints: [...(rec.checkpoints || [])].reverse(), enabled: this.s.settings.checkpoints !== false }; }
  #checkpoint(key, id) {
    const rec = this.#rec(key);
    const cp = (rec.checkpoints || []).find((c) => c.id === id);
    if (!cp) throw bad('Checkpoint not found');
    return { rec, cp, cwd: effectiveCwd(rec) };
  }
  async previewCheckpoint(key, id) {
    const { cp, cwd } = this.#checkpoint(key, id);
    try { return { ...(await new Checkpoints(this.git).preview(cwd, cp.commit)), checkpoint: cp }; } catch (e) { throw bad(e.message); }
  }
  async restoreCheckpoint(key, id, { removeCreated = false } = {}) {
    const { rec, cp, cwd } = this.#checkpoint(key, id);
    if (this.#agent(rec.agent).activeTurns?.has?.(rec.id)) throw bad('Stop the running reply first.');
    const C = new Checkpoints(this.git);
    // Undo for the undo: the current files are kept as a checkpoint first.
    const safety = await C.create(cwd, `${rec.agent}-${rec.id}`, `before restoring “${cp.label}”`).catch(() => null);
    if (safety) rec.checkpoints = [...(rec.checkpoints || []), { ...safety, safety: true }];
    try {
      const r = await C.restore(cwd, cp.commit, { removeCreated });
      this.store.save();
      this.emit('event', { type: 'files.changed', key });
      return { ...r, safety: safety?.id || null };
    } catch (e) { throw bad(e.message); }
  }

  // ------------------------------------------------------------------ Trail (code map + team learnings, trailhq/Trail-Code)
  async #trailStatus(f) {
    const dir = path.join(f, '.trail', 'learnings');
    let learnings = [];
    try { learnings = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md')).sort().reverse().slice(0, 30).map((n) => ({ file: path.join(dir, n), name: n.replace(/\.md$/, '') })); } catch { /* none */ }
    return { installed: !!which('trail'), initialized: fs.existsSync(path.join(f, '.trail')), learnings };
  }
  trailInit({ folder }) {
    const f = this.#knownFolder(folder);
    if (!which('trail')) throw bad('Install Trail first: Add-ons › Ways of working › Trail.');
    const job = this.jobs.create(`Trail — ${baseName(f)}`);
    (async () => {
      const r = await runJob('trail', ['init', '--yes', f], job, this.jobs, { cwd: f, env: { NO_COLOR: '1' } });
      this.jobs.done(job, r.ok, r.ok ? 'Trail is wired into your agents for this folder.' : 'trail init failed (see the log above).');
      this.emit('event', { type: 'spec.changed', folder: f });
    })();
    return { job: job.id };
  }

  // ------------------------------------------------------------------ Spec Kit (spec-driven development)
  async specStatus(folder) { const f = this.#knownFolder(folder); return { ...(await specStatus(f)), specifyInstalled: !!which('specify'), phases: PHASES }; }

  /** specify init in the folder for Codex or Claude Code; streamed as a job. */
  specInit({ folder, agent = 'codex' }) {
    const f = this.#knownFolder(folder);
    if (!which('specify')) throw bad('Install Spec Kit first: Add-ons › Ways of working › Spec Kit.');
    const job = this.jobs.create(`Spec Kit — ${baseName(f)}`);
    (async () => {
      const r = await runJob('specify', initArgs(agent), job, this.jobs, { cwd: f, env: { NO_COLOR: '1' } });
      this.jobs.done(job, r.ok, r.ok ? 'Spec Kit is ready in this folder.' : 'specify init failed (see the log above).');
      this.emit('event', { type: 'spec.changed', folder: f });
    })();
    return { job: job.id };
  }

  /** Text that runs one phase in a conversation (native skill call for Codex / Claude Code, instructions otherwise). */
  async specPhase({ key, folder, phase, args }) {
    const rec = key ? this.#rec(key) : null;
    const f = rec ? effectiveCwd(rec) : this.#knownFolder(folder);
    let agent = rec?.agent || null;
    if (agent && !['codex', 'claude'].includes(agent)) agent = 'api';
    try { return { text: await phaseMessage(f, phase, args, agent) }; } catch (e) { throw bad(e.message); }
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
      // Every context/instructions file that applies (user files in the folder, .cpm memory); each file once.
      const mem = this.memoryFound(r).files.map((x) => x.file).filter((p) => !folderMem.has(pathKey(p)));
      for (const p of mem) folderMem.set(pathKey(p), 1);
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
      if (e.plugin) installed = !!(this.s.pluginsInstalled || {})[e.id];
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
        if (e.install?.python && !await pythonToolInstall(e.install.python, job, this.jobs)) throw new Error('Installation failed (see the log above).');
        if (e.mcp) await this.#installMcp(e, { folder, token, targets }, job);
        if (e.plugin) await this.#installPluginBoth(e, targets, job);
        this.jobs.done(job, true, 'Done.');
        this.emit('event', { type: 'addons.changed' });
      } catch (err) { this.jobs.done(job, false, err.message); }
    })();
    return { job: job.id };
  }

  /** Plugin from a GitHub marketplace, installed natively in Codex (app-server) and Claude Code (claude plugin …). */
  async #installPluginBoth(e, targets, job) {
    const { repo, name, marketplace } = e.plugin;
    const done = [];
    if (targets.includes('codex')) {
      try {
        const add = await this.agents.codex.rpc('marketplace/add', { source: repo, refName: null }, 300_000);
        this.jobs.log(job, `Codex: marketplace “${add.marketplaceName}” ${add.alreadyAdded ? 'already added' : 'added'}\n`);
        const mk = (await this.plugins()).marketplaces.find((m) => m.name === add.marketplaceName);
        await this.agents.codex.rpc('plugin/install', { marketplacePath: mk?.path || null, pluginName: name }, 300_000);
        this.jobs.log(job, `Codex: plugin “${name}” installed\n`); done.push('codex');
      } catch (err) { this.jobs.log(job, `Codex: ${err.message}\n`); }
    }
    const cbin = targets.includes('claude') && this.agents.claude.findBinary();
    if (cbin) {
      const launch = resolveLaunch(cbin, { npmPackage: '@anthropic-ai/claude-code', jsEntry: 'cli-wrapper.cjs' });
      if (launch.shell) this.jobs.log(job, `Claude Code: run once in a terminal:\n  claude plugin marketplace add ${repo}\n  claude plugin install ${name}@${marketplace}\n`);
      else {
        for (const args of [['plugin', 'marketplace', 'add', repo], ['plugin', 'install', `${name}@${marketplace}`]]) {
          const r = await runProc(launch.command, [...launch.prefixArgs, ...args], { timeout: 300_000 });
          this.jobs.log(job, `Claude Code: claude ${args.join(' ')} → ${(r.stdout + r.stderr).trim().slice(0, 400) || (r.ok ? 'ok' : 'failed')}\n`);
          if (!r.ok && !/already/i.test(r.stdout + r.stderr)) break;
          if (args[1] === 'install') done.push('claude');
        }
      }
    }
    if (!done.length) throw new Error('The plugin could not be installed in any agent (see the log above).');
    (this.s.pluginsInstalled ||= {})[e.id] = { agents: done, at: Date.now() };
    this.store.save();
    await this.restartAgent('codex').catch(() => {});
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
  async fetchIcons(tools = Object.keys(ICON_SOURCES), { onlyMissing = false } = {}) {
    const results = [];
    for (const t of tools) {
      if (onlyMissing && (this.s.icons[t] || this.s.iconsUser?.[t])) continue;
      const jiraSite = t === 'jira' && /^https:\/\//.test(this.s.tools.jira.site || '') ? this.s.tools.jira.site : null;
      try {
        let r;
        try { r = await downloadIcon(t, path.join(this.dataDir, 'icons')); }
        catch (e) { if (!jiraSite) throw e; r = await downloadIcon(t, path.join(this.dataDir, 'icons'), { page: jiraSite }); }
        this.s.icons[t] = r.file; results.push({ tool: t, ok: true, from: r.from });
      } catch (e) { results.push({ tool: t, ok: false, error: e.message }); }
    }
    this.s.iconsCheckedAt = Date.now();
    this.store.save();
    if (results.some((r) => r.ok)) this.emit('event', { type: 'icons.updated', icons: this.s.icons });
    return { results, icons: this.s.icons };
  }

  /** First start (and once a day while some are missing): fetch the official icons in the background. */
  autoFetchIcons() {
    if (this.s.settings.autoIcons === false || this.env.CPM_NO_AUTO_ICONS === '1') return;
    // New official sources (ICON_SET_VERSION): re-fetch every icon the user did not upload, once.
    if ((this.s.iconsVersion || 1) < ICON_SET_VERSION) {
      for (const t of Object.keys(this.s.icons)) if (!this.s.iconsUser?.[t]) delete this.s.icons[t];
      this.s.iconsVersion = ICON_SET_VERSION; this.s.iconsCheckedAt = 0;
    }
    const missing = Object.keys(ICON_SOURCES).filter((t) => !this.s.icons[t]);
    if (!missing.length || Date.now() - (this.s.iconsCheckedAt || 0) < 86_400_000 && this.s.iconsCheckedAt) return;
    this.fetchIcons(missing, { onlyMissing: true }).catch(() => {});
  }
  async uploadIcon(tool, name, data) {
    let r; try { r = await saveUploadedIcon(tool, name, data, path.join(this.dataDir, 'icons')); } catch (e) { throw bad(e.message); }
    this.s.icons[tool] = r.file; (this.s.iconsUser ||= {})[tool] = true; this.store.save(); return { icons: this.s.icons };
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
    return { path: f, name: baseName(f), conversations: convs, memory: mem, git, skills, readme, files: await this.listFiles(f), spec: await specStatus(f).catch(() => null), specifyInstalled: !!which('specify'), trail: await this.#trailStatus(f) };
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

  // ------------------------------------------------------------------ files of one conversation
  /** Files this conversation touched: changed or read by the agent, attached by the user, and its memory files. */
  async conversationFiles(key) {
    const rec = this.#rec(key);
    const cwd = effectiveCwd(rec);
    let items = this.itemCache.get(key);
    if (!items) { items = (await this.#agent(rec.agent).readConversation(rec.id)).items; this.itemCache.set(key, items); }
    const abs = (p) => { if (!p) return null; const n = normalizePath(p); return path.isAbsolute(n) || /^[A-Za-z]:\\/.test(n) ? n : normalizePath(path.join(cwd, p)); };
    const changed = new Map(), read = new Map();
    for (const it of items) {
      if (it.kind === 'fileChange') for (const c of it.changes || []) {
        const p = abs(c.movePath || c.path); if (!p) continue;
        const e = changed.get(p) || { path: p, kinds: new Set(), edits: 0, diffs: [] };
        e.kinds.add(c.kind); e.edits++; if (c.diff) e.diffs.push(c.diff.slice(0, 20000)); changed.set(p, e);
      }
      for (const r of it.reads || []) { const p = abs(r); if (p) read.set(p, (read.get(p) || 0) + 1); }
      if (it.kind === 'tool' && /^(Read|NotebookRead|read_file|view)$/i.test(it.tool || '')) { const p = abs(it.args?.file_path || it.args?.path); if (p) read.set(p, (read.get(p) || 0) + 1); }
    }
    const stat = async (p) => { try { const st = await fsp.stat(p); return { exists: true, size: st.size, mtime: st.mtimeMs }; } catch { return { exists: false }; } };
    const out = { cwd, changed: [], read: [], attachments: [], memory: [] };
    for (const e of changed.values()) out.changed.push({ path: e.path, kinds: [...e.kinds], edits: e.edits, lastDiff: e.diffs.at(-1) || '', ...(await stat(e.path)) });
    for (const [p, n] of read) if (!changed.has(p)) out.read.push({ path: p, times: n, ...(await stat(p)) });
    for (const a of rec.attachments || []) out.attachments.push({ ...a, ...(await stat(a.path)) });
    const cd = this.convMemoryDir(rec);
    const found = this.memoryFound(rec);
    for (const m of found.files) {
      const rel = path.relative(cwd || path.dirname(m.file), m.file);
      out.memory.push({ label: rel.startsWith('..') ? `${baseName(m.folder)}/${path.basename(m.file)}` : rel, kind: m.kind, loaded: true, path: m.file, ...(await stat(m.file)) });
    }
    for (const dir of [cd.dir, cd.fallback]) { const p = path.join(dir, 'TRANSCRIPT.md'); const st = await stat(p); if (st.exists) { out.memory.push({ label: 'TRANSCRIPT.md', path: p, ...st }); break; } }
    out.searched = found.searched;
    // The folder itself: what the user sees in Explorer (2 levels, hidden and heavy folders skipped).
    out.folder = cwd ? await this.#folderListing(cwd) : [];
    out.changed.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return out;
  }

  async #folderListing(root, { depth = 2, max = 400 } = {}) {
    const out = [];
    const walk = async (dir, d) => {
      let es; try { es = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      es.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of es) {
        if (out.length >= max) return;
        if (e.name.startsWith('.') || /^(node_modules|__pycache__|slprj|codegen)$/.test(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { out.push({ path: p, rel: path.relative(root, p), dir: true, depth: depth - d }); if (d > 1) await walk(p, d - 1); }
        else if (e.isFile()) { let st = null; try { st = await fsp.stat(p); } catch { /* vanished */ } out.push({ path: p, rel: path.relative(root, p), dir: false, depth: depth - d, size: st?.size || 0, mtime: st?.mtimeMs || 0, memory: LOOSE_RE.test(e.name) }); }
      }
    };
    await walk(root, depth);
    return out;
  }

  /** Reads a file that belongs to this conversation (in its folder, or one it changed/read/attached). */
  async conversationFile(key, file) {
    const rec = this.#rec(key);
    const p = normalizePath(file);
    const cwd = effectiveCwd(rec);
    const files = await this.conversationFiles(key);
    const allowed = (cwd && isInside(p, cwd)) || [...files.changed, ...files.read, ...files.attachments, ...files.memory].some((f) => pathKey(f.path) === pathKey(p));
    if (!allowed) throw new HttpError(403, 'This file is not part of the conversation');
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isFile()) throw bad('File not found (it may have been moved or deleted)');
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
    (rec.attachments ||= []).push({ path: file, name: clean, kind, at: Date.now() });
    if (rec.attachments.length > 200) rec.attachments.splice(0, rec.attachments.length - 200);
    this.store.save();
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
    const allowed = ['theme', 'lang', 'sidebarHidden', 'gitPanelOpen', 'activeConversation', 'activeFolder', 'expanded', 'defaultActionMode', 'openMode', 'syncConfig', 'transcriptCopy', 'agentBins', 'lastModelKey', 'modelEfforts', 'onboarded', 'askMemory', 'uiMode', 'quitOnWindowClose', 'defaultAgent', 'prompts', 'autoIcons', 'memoryAskEvery', 'memoryUpdateMode', 'checkpoints', 'notify'];
    if (patch && 'memoryAskEvery' in patch && !(+patch.memoryAskEvery === 0 || (+patch.memoryAskEvery >= 5 && +patch.memoryAskEvery <= 10))) throw bad('Ask every 5 to 10 messages, or never (0)');
    if (patch && 'memoryUpdateMode' in patch && !['ask', 'auto', 'manual'].includes(patch.memoryUpdateMode)) throw bad('Unknown update mode');
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
