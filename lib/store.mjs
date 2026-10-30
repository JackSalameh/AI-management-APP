// Per-user persistent app state, stored as JSON with atomic writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BRAND } from './brand.mjs';

export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.CPM_DATA_DIR) return path.resolve(env.CPM_DATA_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), BRAND.dataDirName.win32);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', BRAND.dataDirName.darwin);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), BRAND.dataDirName.other);
}

/** Copies the data folder of an earlier version (e.g. Codex Projects Management) on first start. */
export function migrateLegacyDataDir(dataDir, env = process.env, platform = process.platform) {
  if (env.CPM_DATA_DIR || fs.existsSync(path.join(dataDir, 'state.json'))) return null;
  const key = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'other';
  for (const name of BRAND.legacyDataDirNames?.[key] || []) {
    const old = path.join(path.dirname(dataDir), name);
    if (fs.existsSync(path.join(old, 'state.json'))) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.cpSync(old, dataDir, { recursive: true, filter: (src) => !src.endsWith('instance.json') });
      return old;
    }
  }
  return null;
}

export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

export const DEFAULT_STATE = Object.freeze({
  schema: 1,
  settings: {
    theme: 'system', lang: 'en', sidebarHidden: false, gitPanelOpen: false,
    activeConversation: null, activeFolder: null, expanded: {},
    defaultActionMode: 'ask', openMode: 'app', agentBins: {}, uiMode: 'simple', quitOnWindowClose: true,
    defaultAgent: 'codex', prompts: [],
    memoryAskEvery: 7, memoryUpdateMode: 'ask',
    // Sessions (3.5): one folder per conversation in sessionsRoot; sessions found elsewhere are imported.
    sessionsRoot: '', sessionScanRoots: [], sessionImport: true, sessionFolders: true, sessionsRootAsked: false,
  },
  tools: {
    vscode: { enabled: true, command: '' },
    matlab: { enabled: false, release: '', executable: '', initSimulink: false, shareSession: true, mcpServer: 'matlab', connectMcp: true, mcpEntry: null, agents: null },
    git: { enabled: true, executable: '' },
    bitbucket: { enabled: false, flavor: 'cloud', baseUrl: 'https://bitbucket.org', defaultBranch: '', email: '', mcpName: '', mcpMode: '' },
    jira: { enabled: false, mode: 'remote', serverName: 'atlassian', url: '', auth: 'oauth', tokenSecret: '', site: '', email: '', command: '', args: [], mcpName: '', mcpMode: '' },
  },
  folders: {},          // pathKey -> { path, addedAt }
  conversations: {},    // `${agent}:${id}` -> record
  models: [],           // user-managed model entries
  hiddenModels: [],     // ids of agent-reported models the user removed from the list
  trash: [],            // folders moved to the app trash
  drafts: {},           // conversation key -> unsent text (survives restarts)
  providers: [],        // API providers: { id, preset, label, kind, baseUrl, keyName, models: [], headers }
  icons: {},            // tool -> file name of a user-provided or downloaded icon
  iconsUser: {},        // tools whose icon the user uploaded (never overwritten automatically)
  iconsCheckedAt: 0,
});

function deepMerge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra)) out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return extra === undefined ? base : extra;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.state = structuredClone(DEFAULT_STATE);
    this.chain = Promise.resolve();
    this.timer = null;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.state = deepMerge(structuredClone(DEFAULT_STATE), raw);
        return this;
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[store] could not read ${f}: ${e.message}`);
      }
    }
    return this;
  }

  get s() { return this.state; }

  /** Debounced save; returns a promise resolved when written. */
  save(immediate = false) {
    clearTimeout(this.timer);
    return new Promise((resolve) => {
      const run = () => { this.chain = this.chain.then(() => this.#write()).then(resolve, (e) => { console.error('[store] save failed', e); resolve(); }); };
      if (immediate) run(); else this.timer = setTimeout(run, 150);
    });
  }

  async #write() {
    const data = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    try { await fsp.copyFile(this.file, this.file + '.bak'); } catch { /* first save */ }
    await fsp.rename(tmp, this.file);
  }

  flush() { return this.save(true); }
}
