// Finds every Claude Code and Codex session on the computer, imports the ones the agents cannot see, and
// gives each conversation its own folder ("session folder") next to the user's projects.
//
// Formats (verified):
//  - Codex rollout: rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl; line 1 = { type: 'session_meta', payload: { id, cwd, timestamp } }.
//    codex-cli 0.166 lists, reads and resumes any rollout copied into $CODEX_HOME/sessions/YYYY/MM/DD/, even
//    while the app-server is running (tested with the real binary: thread/list, thread/read, thread/turns/list,
//    thread/resume).
//  - Claude Code transcript: <uuid>.jsonl, one JSON record per line with sessionId, cwd, type user|assistant…;
//    Claude Code keeps them in <config>/projects/<cwd with every non-alphanumeric character replaced by '-'>/.
//    The Claude desktop app keeps the same format under its data folder (e.g. %APPDATA%\Claude).
//
// A session folder holds: session.json (what it is), a copy of the session file (kept up to date),
// TRANSCRIPT.md (readable) and, when the user wants them, CONTEXT.md and INSTRUCTIONS.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { normalizePath, pathKey, isInside } from './paths.mjs';
import { splitUserText } from './items.mjs';

export const SESSION_JSON = 'session.json';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_FILE_RE = new RegExp(`^${UUID}\\.jsonl$`, 'i');
const CODEX_FILE_RE = /^rollout-.*\.jsonl$/i;
const CODEX_ID_RE = new RegExp(`(${UUID})\\.jsonl$`, 'i');
// Folders never worth walking (caches, dependencies, system folders).
const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'cache', 'code cache', 'gpucache', 'dawncache', 'dawnwebgpucache',
  'grshadercache', 'shadercache', 'blob_storage', 'indexeddb', 'local storage', 'session storage', 'service worker', 'crashpad', 'logs', 'vm_bundles',
  'webstorage', 'shared dictionary', 'partitions', '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)', 'programdata',
  'appdata', 'library', '.cache', '.npm', '.cargo', '.rustup', 'steamlibrary', 'snapshots', 'shell-snapshots', 'todos', 'statsig', 'plugins', 'file-history']);

/** Agent homes and other places where sessions are usually kept. */
export function defaultSources({ codexHome, claudeHome, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const out = [];
  const add = (dir, label, deep = false) => { if (dir) out.push({ dir: path.resolve(dir), label, deep }); };
  add(path.join(codexHome, 'sessions'), 'Codex');
  add(path.join(codexHome, 'archived_sessions'), 'Codex (archived)');
  add(path.join(claudeHome, 'projects'), 'Claude Code');
  const desktop = platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
  add(desktop, 'Claude desktop app', true);
  return out;
}

/**
 * Walks the given folders and returns the sessions found (one per agent+id) and the session folders
 * (folders holding a session.json written by this app).
 * Limits: depth, number of folders visited and time, so a whole drive can be scanned safely.
 */
export async function scanSessions(roots, { maxDepth = 12, maxDirs = 50_000, budgetMs = 30_000, cache = new Map() } = {}) {
  const t0 = Date.now();
  const found = new Map(), folders = [], searched = [];
  let dirs = 0, truncated = false;
  const seenDirs = new Set();
  for (const root of roots) {
    const dir = normalizePath(root.dir || root);
    if (!dir || !fs.existsSync(dir)) continue;
    searched.push(dir);
    const queue = [[dir, 0]];
    while (queue.length) {
      if (dirs >= maxDirs || Date.now() - t0 > budgetMs) { truncated = true; break; }
      const [d, depth] = queue.shift();
      const k = pathKey(d);
      if (seenDirs.has(k)) continue;
      seenDirs.add(k); dirs++;
      let entries; try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth < maxDepth && !SKIP.has(e.name.toLowerCase()) && !(e.name.startsWith('.') && depth > 0 && !/^\.(claude|codex|cpm|codex-projects)$/i.test(e.name))) queue.push([p, depth + 1]);
          continue;
        }
        if (!e.isFile()) continue;
        if (e.name === SESSION_JSON) { const j = readSessionJson(d); if (j) folders.push({ dir: d, ...j }); continue; }
        const kind = CODEX_FILE_RE.test(e.name) ? 'codex' : CLAUDE_FILE_RE.test(e.name) ? 'claude' : null;
        if (!kind) continue;
        const s = await sessionHead(p, kind, cache).catch(() => null);
        if (!s) continue;
        const key = `${s.agent}:${s.id}`;
        const prev = found.get(key);
        if (!prev) { found.set(key, { ...s, copies: [] }); continue; }
        // Keep the most recent file as the session; the others are copies (session folders, backups).
        if (s.updatedAt > prev.updatedAt) found.set(key, { ...s, copies: [...prev.copies, prev.file] }); else prev.copies.push(s.file);
      }
    }
    if (truncated) break;
  }
  return { sessions: [...found.values()], folders, searched, truncated, dirs, ms: Date.now() - t0 };
}

/** Title, folder, dates and id of one session file (only the beginning is read; cached by size and date). */
export async function sessionHead(file, kind, cache) {
  const st = await fsp.stat(file);
  const ck = `${file}|${st.size}|${st.mtimeMs}`;
  if (cache?.has(ck)) return cache.get(ck);
  const r = kind === 'codex' ? await codexHead(file, st) : await claudeHead(file, st);
  if (r) r.size = st.size;
  cache?.set(ck, r);
  return r;
}

async function lines(file, fn, max = 256 * 1024) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', end: max }), crlfDelay: Infinity });
  try { for await (const line of rl) { let o; try { o = JSON.parse(line); } catch { continue; } if (fn(o) === false) break; } } finally { rl.close(); }
}

const firstLine = (raw) => splitUserText(String(raw || '')).prompt.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('<')) || '';

export async function codexHead(file, st) {
  st ||= await fsp.stat(file);
  const m = { agent: 'codex', id: (CODEX_ID_RE.exec(path.basename(file)) || [])[1] || '', cwd: '', title: '', firstPrompt: '', createdAt: 0, updatedAt: st.mtimeMs, file, archived: /[\\/]archived_sessions[\\/]/i.test(file) };
  let meta = false, n = 0;
  await lines(file, (o) => {
    n++;
    if (o.type === 'session_meta' && o.payload) { meta = true; m.id = o.payload.id || m.id; m.cwd = normalizePath(o.payload.cwd || '') || ''; m.createdAt = Date.parse(o.payload.timestamp || o.timestamp) || 0; m.originator = o.payload.originator || null; }
    if (!m.firstPrompt && o.type === 'event_msg' && o.payload?.type === 'user_message') m.firstPrompt = firstLine(o.payload.message).slice(0, 120);
    if (!m.firstPrompt && o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') m.firstPrompt = firstLine((o.payload.content || []).map((c) => c.text || '').join('\n')).slice(0, 120);
    if (o.type === 'event_msg' && o.payload?.type === 'thread_name_updated' && o.payload.thread_name) m.title = o.payload.thread_name;
    return !(meta && m.firstPrompt && n > 400);
  });
  if (!meta || !m.id) return null;
  m.title ||= m.firstPrompt;
  return m;
}

export async function claudeHead(file, st) {
  st ||= await fsp.stat(file);
  const m = { agent: 'claude', id: path.basename(file, '.jsonl'), cwd: '', title: '', firstPrompt: '', createdAt: 0, updatedAt: st.mtimeMs, file, model: null };
  let valid = false;
  await lines(file, (o) => {
    if (o.sessionId) valid = true;
    if (o.cwd && !m.cwd) m.cwd = normalizePath(o.cwd) || '';
    if (o.timestamp && !m.createdAt) m.createdAt = Date.parse(o.timestamp) || 0;
    if (o.type === 'custom-title' && o.customTitle) m.title = o.customTitle;
    if (o.type === 'summary' && o.summary && !m.title) m.title = o.summary;
    if (o.type === 'ai-title' && o.aiTitle) m.aiTitle = o.aiTitle; // Claude Code 2.x: title it generated itself
    if (o.type === 'user' && !m.firstPrompt && !o.isMeta) {
      const c = o.message?.content;
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      const l = firstLine(raw); if (l) m.firstPrompt = l.slice(0, 120);
    }
    if (o.type === 'assistant' && o.message?.model) m.model = o.message.model;
  });
  if (!valid || (!m.cwd && !m.firstPrompt)) return null;
  // Claude desktop app: <dir>/local_<x>/…/<uuid>.jsonl with the session's title in <dir>/local_<x>.json.
  if (!m.title) m.title = desktopTitle(file) || m.aiTitle || '';
  delete m.aiTitle;
  m.title ||= m.firstPrompt;
  return m;
}

function desktopTitle(file) {
  const parts = path.resolve(file).split(path.sep);
  for (let i = parts.length - 2; i > 0; i--) {
    if (!/^local_/.test(parts[i])) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(parts.slice(0, i).join(path.sep) || path.sep, `${parts[i]}.json`), 'utf8')); return typeof j.title === 'string' ? j.title : null; } catch { return null; }
  }
  return null;
}

/** Claude Code's folder name for a working directory. */
export const claudeProjectDir = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

/** Where an imported session goes so its own agent can list, read and continue it. */
export function importTarget(s, { codexHome, claudeHome }) {
  if (s.agent === 'codex') {
    const name = path.basename(s.file);
    if (s.archived) return path.join(codexHome, 'archived_sessions', name);
    const m = /rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
    const d = new Date(s.createdAt || s.updatedAt || Date.now());
    const [y, mo, da] = m ? [m[1], m[2], m[3]] : [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
    return path.join(codexHome, 'sessions', y, mo, da, name);
  }
  return path.join(claudeHome, 'projects', claudeProjectDir(s.cwd || 'imported') || 'imported', `${s.id}.jsonl`);
}

/** Copies a session into its agent's own folder (the original is never modified). */
export async function importSession(s, homes) {
  const to = importTarget(s, homes);
  if (fs.existsSync(to)) return { file: to, imported: false };
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(s.file, to, fs.constants.COPYFILE_EXCL).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  return { file: to, imported: true };
}

/** Is this file inside the agent's own store (so the agent already sees it)? */
export function inAgentHome(s, { codexHome, claudeHome }) {
  return s.agent === 'codex' ? isInside(s.file, path.join(codexHome, 'sessions')) || isInside(s.file, path.join(codexHome, 'archived_sessions')) : isInside(s.file, path.join(claudeHome, 'projects'));
}

// ------------------------------------------------------------------ session folders
/** A folder name that is valid on Windows, macOS and Linux. */
export function safeFolderName(title, fallback = 'Session') {
  let s = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s} session`;
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/, '');
  return s || fallback;
}

export function readSessionJson(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, SESSION_JSON), 'utf8'));
    return j && typeof j.agent === 'string' && typeof j.id === 'string' ? j : null;
  } catch { return null; }
}

/** Creates (or finds) the folder of one conversation in `root`: <root>/<title>[ (2)]/session.json. */
export async function ensureSessionFolder(root, { agent, id, title, cwd, sessionFile }) {
  const base = safeFolderName(title, `${agent}-${String(id).slice(0, 8)}`);
  for (let i = 1; i < 100; i++) {
    const dir = path.join(root, i === 1 ? base : `${base} (${i})`);
    const j = readSessionJson(dir);
    if (j && (j.agent !== agent || j.id !== id)) continue; // another session's folder
    if (!j && fs.existsSync(dir) && fs.readdirSync(dir).length) continue; // a folder the user made for something else
    await fsp.mkdir(dir, { recursive: true });
    if (!j) await writeSessionJson(dir, { agent, id, title, cwd, sessionFile });
    return dir;
  }
  throw new Error(`Could not create a folder for "${title}" in ${root}`);
}

export async function writeSessionJson(dir, { agent, id, title, cwd, sessionFile }) {
  const prev = readSessionJson(dir) || {};
  const j = { app: 'AI Management APP', about: 'Folder of one AI conversation: the session file copy, TRANSCRIPT.md and its CONTEXT.md / INSTRUCTIONS.md.', ...prev, agent, id, title: title || prev.title || '', cwd: cwd || prev.cwd || '', sessionFile: sessionFile || prev.sessionFile || '' };
  if (JSON.stringify(j) === JSON.stringify(prev)) return;
  await fsp.writeFile(path.join(dir, SESSION_JSON), JSON.stringify(j, null, 2) + '\n');
}

/** Keeps a copy of the session file in its folder (copied again only when it changed). */
export async function mirrorSessionFile(dir, file) {
  if (!dir || !file || !fs.existsSync(file)) return false;
  const to = path.join(dir, path.basename(file));
  if (pathKey(to) === pathKey(file)) return false;
  const [a, b] = await Promise.all([fsp.stat(file), fsp.stat(to).catch(() => null)]);
  if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) return false;
  const tmp = `${to}.${process.pid}.tmp`;
  await fsp.copyFile(file, tmp);
  await fsp.rename(tmp, to);
  return true;
}
