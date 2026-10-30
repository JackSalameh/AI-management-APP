// Skill installation from a local folder or a GitHub link (folder or global scope).
// Codex discovers skills in  $CODEX_HOME/skills/<name>/SKILL.md (global, "user" scope)
// and <folder>/.agents/skills/<name>/SKILL.md (folder, "repo" scope) — verified with codex-cli 0.166.0.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from './proc.mjs';

/** Accepts owner/repo, https://github.com/owner/repo(.git), …/tree/<ref>/<sub/path>, …/blob/<ref>/<path>/SKILL.md */
export function parseGitHubSource(input) {
  const s = String(input || '').trim();
  let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), ref: null, sub: '' };
  m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[?#].*)?$/.exec(s);
  if (!m) return null;
  let sub = (m[5] || '').replace(/\/+$/, '');
  if (m[3] === 'blob' && /(^|\/)SKILL\.md$/i.test(sub)) sub = sub.replace(/\/?SKILL\.md$/i, '');
  if (sub.split('/').includes('..')) return null;
  return { owner: m[1], repo: m[2], ref: m[4] || null, sub };
}

export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** Finds skill folders (containing SKILL.md) under root, ignoring VCS and dependency folders. */
export async function findSkills(root, depth = 5) {
  const found = [];
  const walk = async (dir, d) => {
    let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const md = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(md);
      found.push({ dir, name: safeName(fm.name || path.basename(dir)), description: fm.description || '' });
      return;
    }
    if (d <= 0) return;
    for (const e of entries) if (e.isDirectory() && !['.git', 'node_modules', '.venv', '__pycache__'].includes(e.name)) await walk(path.join(dir, e.name), d - 1);
  };
  await walk(root, depth);
  return found;
}

export function detectPluginRepo(root) {
  const markers = ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json'];
  return markers.filter((m) => fs.existsSync(path.join(root, m)));
}

function safeName(n) { return String(n).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'skill'; }

/** Downloads a GitHub repository into a fresh temp dir. Uses git (supports private repos) then falls back to the public tarball. */
export async function fetchGitHub(src, tmpRoot = os.tmpdir()) {
  const dir = path.join(tmpRoot, `cpm-gh-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  const url = `https://github.com/${src.owner}/${src.repo}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const args = ['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), '--', url, path.join(dir, 'repo')];
  let r = await run('git', args, { env, timeout: 180_000 });
  if (r.ok) return { dir, root: path.join(dir, 'repo') };
  const gitErr = (r.stderr || r.error || '').trim();
  try {
    const res = await fetch(`https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${encodeURIComponent(src.ref || 'HEAD')}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tgz = path.join(dir, 'repo.tgz');
    await fsp.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
    await fsp.mkdir(path.join(dir, 'x'));
    r = await run('tar', ['-xzf', tgz, '-C', path.join(dir, 'x')]);
    if (!r.ok) throw new Error(r.stderr.trim());
    const [top] = await fsp.readdir(path.join(dir, 'x'));
    return { dir, root: path.join(dir, 'x', top) };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error(`Could not download ${src.owner}/${src.repo}. git: ${gitErr.split('\n').pop() || 'failed'}; archive: ${e.message}`);
  }
}

/**
 * Copies skills into targetDir/<name>. Existing skills are kept unless `replace` is set,
 * in which case they are moved aside to <name>.backup-<timestamp> first (never deleted).
 */
export async function installSkills(skills, targetDir, { replace = false } = {}) {
  await fsp.mkdir(targetDir, { recursive: true });
  const results = [];
  for (const s of skills) {
    const dest = path.join(targetDir, s.name);
    if (fs.existsSync(dest)) {
      if (!replace) { results.push({ name: s.name, status: 'exists', path: dest }); continue; }
      const bak = `${dest}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fsp.rename(dest, bak);
    }
    await fsp.cp(s.dir, dest, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') });
    results.push({ name: s.name, status: 'installed', path: dest });
  }
  return results;
}

export function skillTargets(codexHome, folder) {
  return { global: path.join(codexHome, 'skills'), folder: folder ? path.join(folder, '.agents', 'skills') : null };
}
