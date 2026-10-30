// Support workflow: in-memory log, restorable state backups, version/update info and a redacted diagnostic export.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.mjs';
import { BRAND } from './brand.mjs';

// ---- log ring (console output is mirrored here for diagnostics)
const RING = []; const MAX = 400;
let installed = false;
export function installLogRing() {
  if (installed) return; installed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { RING.push(`${new Date().toISOString()} ${level.toUpperCase()} ${a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : safeJson(x))).join(' ')}`); if (RING.length > MAX) RING.shift(); orig(...a); };
  }
}
export function logLines() { return [...RING]; }
function safeJson(x) { try { return JSON.stringify(x); } catch { return String(x); } }

// ---- redaction
const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|bearer|cookie)/i;
const SECRET_VAL = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|ATATT[A-Za-z0-9_=-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;
export function redact(v, home = os.homedir()) {
  const homeRe = home ? new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'gi') : null;
  const s = (str) => { let r = String(str).replace(SECRET_VAL, '[REDACTED]'); if (homeRe) r = r.replace(homeRe, '~'); return r; };
  if (typeof v === 'string') return s(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, home));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === 'string' && !/env_var|env_key|_name$/i.test(k) ? '[REDACTED]' : redact(x, home)]));
  return v;
}

// ---- backups of the app state (conversation organisation, settings, models)
export async function backupState(dataDir, { reason = 'auto', keep = 15 } = {}) {
  const src = path.join(dataDir, 'state.json');
  if (!fs.existsSync(src)) return null;
  const dir = path.join(dataDir, 'backups');
  await fsp.mkdir(dir, { recursive: true });
  const name = `state-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.json`;
  await fsp.copyFile(src, path.join(dir, name));
  const all = (await fsp.readdir(dir)).filter((f) => f.startsWith('state-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(path.join(dir, old), { force: true });
  return name;
}
export async function listBackups(dataDir) {
  const dir = path.join(dataDir, 'backups');
  try {
    const files = (await fsp.readdir(dir)).filter((f) => /^state-.*\.json$/.test(f)).sort().reverse();
    return Promise.all(files.map(async (f) => { const st = await fsp.stat(path.join(dir, f)); return { name: f, size: st.size, at: st.mtimeMs }; }));
  } catch { return []; }
}
export async function readBackup(dataDir, name) {
  if (!/^state-[\w.-]+\.json$/.test(name)) throw new Error('Invalid backup name');
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'backups', name), 'utf8'));
}

// ---- version & update information
export async function versionInfo(appRoot, codexVersion) {
  const info = { app: BRAND.version, node: process.version, platform: `${process.platform} ${os.release()} ${process.arch}`, codex: codexVersion || null, git: null };
  if (fs.existsSync(path.join(appRoot, '.git'))) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const head = await run('git', ['log', '-1', '--format=%h %cs %s'], { cwd: appRoot, env });
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: appRoot, env });
    info.git = { head: head.stdout.trim(), branch: branch.stdout.trim() };
  }
  return info;
}
export async function checkUpdates(appRoot) {
  if (!fs.existsSync(path.join(appRoot, '.git'))) return { supported: false, message: 'This copy was not installed with git clone; download the new version from your repository.' };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const f = await run('git', ['fetch', '--quiet'], { cwd: appRoot, env, timeout: 30_000 });
  if (!f.ok) return { supported: true, error: (f.stderr || '').trim().split('\n').pop() };
  const c = await run('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: appRoot, env });
  const n = parseInt(c.stdout, 10) || 0;
  const log = n ? (await run('git', ['log', '--format=%h %s', 'HEAD..@{u}', '-n', '20'], { cwd: appRoot, env })).stdout.trim().split('\n') : [];
  return { supported: true, behind: n, commits: log, command: n ? `git -C "${appRoot.replace(/\\/g, '/')}" pull --ff-only` : null };
}
