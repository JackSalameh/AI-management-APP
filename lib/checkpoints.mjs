// Checkpoints: before each AI turn the app snapshots the conversation folder (tracked + new files, .gitignore
// respected) as a Git commit object under refs/cpm/… — the user's branch, index and stash are never touched.
// "Restore" puts the files back as they were before that message; a safety checkpoint is taken first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;
export const MAX_CHECKPOINTS = 30;

export class Checkpoints {
  constructor(git) { this.git = git; }

  async #repo(folder) {
    const top = await this.git.git(folder, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return null;
    const root = top.stdout.trim();
    const scope = path.relative(root, folder).split(path.sep).join('/') || '.';
    return { root, scope: scope.startsWith('..') ? '.' : scope };
  }

  /** Commit object holding the folder's current files (in a private index). */
  async #snapshot(repo, message) {
    const idx = path.join(os.tmpdir(), `cpm-index-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: idx };
    const g = (args, input) => this.git.git(repo.root, args, { env, input });
    try {
      const head = await this.git.git(repo.root, ['rev-parse', '--verify', '-q', 'HEAD']);
      if (head.ok) await g(['read-tree', 'HEAD']);
      // New files too, unless they are huge (data sets): then only files Git already tracks.
      const others = await this.git.git(repo.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', repo.scope]);
      let bytes = 0;
      for (const f of others.stdout.split('\0').filter(Boolean)) { try { bytes += fs.statSync(path.join(repo.root, f)).size; } catch { /* vanished */ } }
      const partial = bytes > MAX_UNTRACKED_BYTES;
      const add = await g(['add', partial ? '-u' : '-A', '--', repo.scope]);
      if (!add.ok) throw new Error(add.stderr.trim() || 'git add failed');
      const tree = (await g(['write-tree'])).stdout.trim();
      const args = ['commit-tree', tree, ...(head.ok ? ['-p', head.stdout.trim()] : []), '-F', '-'];
      const c = await this.git.git(repo.root, args, { input: message, env: { GIT_AUTHOR_NAME: 'AI Management APP', GIT_AUTHOR_EMAIL: 'checkpoint@local', GIT_COMMITTER_NAME: 'AI Management APP', GIT_COMMITTER_EMAIL: 'checkpoint@local' } });
      if (!c.ok) throw new Error(c.stderr.trim() || 'git commit-tree failed');
      return { commit: c.stdout.trim(), tree, partial };
    } finally { fs.rmSync(idx, { force: true }); }
  }

  /** Takes a checkpoint; returns null when the folder is not in a Git repository. */
  async create(folder, ns, label) {
    const repo = await this.#repo(folder);
    if (!repo) return null;
    const snap = await this.#snapshot(repo, `checkpoint: ${label}`.slice(0, 200));
    const id = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    await this.git.git(repo.root, ['update-ref', `refs/cpm/${ns}/${id}`, snap.commit]);
    return { id, commit: snap.commit, at: Date.now(), partial: snap.partial, label: String(label || '').slice(0, 120) };
  }

  async drop(folder, ns, id) {
    const repo = await this.#repo(folder);
    if (repo) await this.git.git(repo.root, ['update-ref', '-d', `refs/cpm/${ns}/${id}`]);
  }

  /** Files that differ between the checkpoint and now (within the folder). */
  async preview(folder, commit) {
    const repo = await this.#repo(folder);
    if (!repo) throw new Error('This folder is not in a Git repository.');
    const now = await this.#snapshot(repo, 'preview');
    const d = await this.git.git(repo.root, ['diff', '--name-status', '--no-renames', commit, now.commit, '--', repo.scope]);
    const changed = [], created = [], deleted = [];
    for (const line of d.stdout.split('\n').filter(Boolean)) {
      const [st, f] = line.split('\t');
      (st === 'A' ? created : st === 'D' ? deleted : changed).push(f);
    }
    return { root: repo.root, changed, created, deleted };
  }

  /** Puts files back as in the checkpoint. Files created since are deleted only when `removeCreated`. */
  async restore(folder, commit, { removeCreated = false } = {}) {
    const repo = await this.#repo(folder);
    if (!repo) throw new Error('This folder is not in a Git repository.');
    const p = await this.preview(folder, commit);
    const back = [...p.changed, ...p.deleted];
    if (back.length) {
      const r = await this.git.git(repo.root, ['restore', `--source=${commit}`, '--worktree', '--', ...back]);
      if (!r.ok) throw new Error(r.stderr.trim() || 'git restore failed');
    }
    const removed = [];
    if (removeCreated) for (const f of p.created) { const abs = path.join(repo.root, f); if (abs.startsWith(repo.root)) { fs.rmSync(abs, { force: true }); removed.push(f); } }
    return { restored: back, removed, kept: removeCreated ? [] : p.created };
  }
}
