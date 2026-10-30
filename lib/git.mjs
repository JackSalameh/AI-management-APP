// Git operations for the selected conversation folder. Every call uses an argument array (no shell).
import { run, which } from './proc.mjs';

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*[\\])(?!.*@\{)(?!.*\/\/)(?!.*\.lock$)[^\x00-\x1f\x7f]+(?<![./])$/;
export function validRef(name) { return typeof name === 'string' && name.length < 250 && BRANCH_RE.test(name); }

const NETWORK = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote']);

export class Git {
  constructor({ executable } = {}) { this.exe = executable || 'git'; this.credentials = null; }

  available() { return !!which(this.exe); }

  async git(cwd, args, opts = {}) {
    let env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...opts.env };
    // Network commands get the connected accounts' tokens through a one-command credential helper (lib/gitaccounts.mjs).
    if (this.credentials && NETWORK.has(args[0])) { const c = await this.credentials(); if (c?.args?.length) { args = [...c.args, ...args]; env = { ...env, ...c.env }; } }
    const r = await run(this.exe, args, { cwd, env, timeout: opts.timeout ?? 120_000, input: opts.input });
    if (!r.ok && /dubious ownership/.test(r.stderr)) {
      r.hint = `Git refuses this folder because it belongs to another Windows account. If you trust it, run: git config --global --add safe.directory "${cwd.replace(/\\/g, '/')}"`;
    }
    if (!r.ok && /(could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled)/i.test(r.stderr)) {
      r.hint = 'Git could not authenticate. Sign in once from a terminal (git fetch) or configure an SSH key / credential manager, then retry.';
    }
    return r;
  }

  async status(cwd) {
    const top = await this.git(cwd, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return { repo: false, error: top.stderr.trim() || top.error, hint: top.hint };
    const st = await this.git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (!st.ok) return { repo: true, error: st.stderr.trim(), hint: st.hint };
    const res = { repo: true, root: top.stdout.trim(), branch: null, upstream: null, ahead: 0, behind: 0, files: [], state: null };
    const parts = st.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const l = parts[i];
      if (!l) continue;
      if (l.startsWith('# branch.head ')) res.branch = l.slice(14);
      else if (l.startsWith('# branch.upstream ')) res.upstream = l.slice(18);
      else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { res.ahead = +m[1]; res.behind = +m[2]; } }
      else if (l[0] === '1') { const f = l.split(' '); res.files.push(entry(f[1], f.slice(8).join(' '))); }
      else if (l[0] === '2') { const f = l.split(' '); const e = entry(f[1], f.slice(9).join(' ')); e.from = parts[++i]; res.files.push(e); }
      else if (l[0] === 'u') { const f = l.split(' '); res.files.push({ ...entry(f[1], f.slice(10).join(' ')), conflict: true }); }
      else if (l[0] === '?') res.files.push({ path: l.slice(2), index: '?', worktree: '?', staged: false, untracked: true });
    }
    const gitDir = (await this.git(cwd, ['rev-parse', '--git-dir'])).stdout.trim();
    const probe = async (p) => (await this.git(cwd, ['rev-parse', '--git-path', p])).stdout.trim();
    const fs = await import('node:fs'); const path = await import('node:path');
    const exists = async (p) => { const r = await probe(p); return r && fs.existsSync(path.isAbsolute(r) ? r : path.join(cwd, r)); };
    if (gitDir) {
      if (await exists('rebase-merge') || await exists('rebase-apply')) res.state = 'rebase';
      else if (await exists('MERGE_HEAD')) res.state = 'merge';
      else if (await exists('CHERRY_PICK_HEAD')) res.state = 'cherry-pick';
    }
    return res;
  }

  async branches(cwd) {
    const r = await this.git(cwd, ['for-each-ref', '--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(committerdate:iso8601)', 'refs/heads', 'refs/remotes']);
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [full, name, head, upstream, date] = l.split('\t'); return { name, current: head === '*', upstream, date, remote: full.startsWith('refs/remotes/') }; }).filter((b) => !b.name.endsWith('/HEAD'));
  }

  async log(cwd, n = 30) {
    const r = await this.git(cwd, ['log', `-n${Math.min(+n || 30, 200)}`, '--date=iso', '--pretty=format:%h%x09%an%x09%ad%x09%s%x09%D']);
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, author, date, subject, refs] = l.split('\t'); return { hash, author, date, subject, refs }; });
  }

  async remotes(cwd) {
    const r = await this.git(cwd, ['remote', '-v']);
    const map = new Map();
    for (const l of r.stdout.split('\n')) { const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l); if (m) map.set(m[1], m[2]); }
    return [...map].map(([name, url]) => ({ name, url, web: webInfo(url) }));
  }

  diff(cwd, file, staged) { return this.git(cwd, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', ...(file ? [file] : [])]); }

  /** High-level operations exposed to the UI. `a` holds validated arguments. */
  /** git clone <url> <parent>/<name>; returns the new folder. */
  async clone(url, parent, name) {
    const r = await this.git(parent, ['clone', '--', remoteUrl(url), name], { timeout: 15 * 60_000 });
    return r;
  }

  async op(cwd, name, a = {}) {
    const files = (a.files || []).map(String).filter((f) => f && !f.startsWith('-'));
    const ref = (v) => { if (!validRef(v)) throw new Error(`Invalid branch or ref name: ${v}`); return v; };
    const remote = a.remote ? ref(a.remote) : 'origin';
    switch (name) {
      case 'init': return this.git(cwd, ['init', ...(a.branch ? ['-b', ref(a.branch)] : [])]);
      case 'remote-add': return this.git(cwd, ['remote', 'add', a.name ? ref(a.name) : remote, remoteUrl(a.url)]);
      case 'remote-set-url': return this.git(cwd, ['remote', 'set-url', remote, remoteUrl(a.url)]);
      case 'remote-remove': return this.git(cwd, ['remote', 'remove', remote]);
      case 'remote-list': return this.git(cwd, ['remote', '-v']);
      case 'stage': return this.git(cwd, ['add', '--', ...(files.length ? files : ['.'])]);
      case 'unstage': return this.git(cwd, ['restore', '--staged', '--', ...(files.length ? files : ['.'])]);
      case 'discard': if (!files.length) throw new Error('Select files to discard'); return this.git(cwd, ['restore', '--worktree', '--', ...files]);
      case 'commit': {
        if (!a.message?.trim()) throw new Error('Commit message is required');
        if (files.length) { const add = await this.git(cwd, ['add', '--', ...files]); if (!add.ok) return add; }
        const args = ['commit', '-F', '-'];
        if (a.amend) args.push('--amend');
        if (files.length && !a.includeStaged) args.push('--', ...files);
        return this.git(cwd, args, { input: a.message });
      }
      case 'fetch': return this.git(cwd, ['fetch', '--prune', a.all ? '--all' : remote]);
      case 'pull': return this.git(cwd, ['pull', a.rebase ? '--rebase' : '--ff-only', remote, ...(a.branch ? [ref(a.branch)] : [])]);
      case 'push': {
        const st = await this.status(cwd);
        const args = ['push'];
        if (a.forceWithLease) args.push('--force-with-lease');
        if (!st.upstream && st.branch) args.push('--set-upstream', remote, st.branch); else args.push(remote);
        if (a.tags) args.push('--tags');
        return this.git(cwd, args);
      }
      case 'branch-create': return this.git(cwd, ['switch', '-c', ref(a.branch), ...(a.from ? [ref(a.from)] : [])]);
      case 'switch': return this.git(cwd, ['switch', ref(a.branch)]);
      case 'branch-delete': return this.git(cwd, ['branch', a.force ? '-D' : '-d', ref(a.branch)]);
      case 'merge': return this.git(cwd, ['merge', '--no-edit', ...(a.noFf ? ['--no-ff'] : []), ref(a.branch)]);
      case 'merge-abort': return this.git(cwd, ['merge', '--abort']);
      case 'rebase': return this.git(cwd, ['rebase', ref(a.branch)]);
      case 'rebase-continue': return this.git(cwd, ['-c', 'core.editor=true', 'rebase', '--continue']);
      case 'rebase-abort': return this.git(cwd, ['rebase', '--abort']);
      case 'rebase-skip': return this.git(cwd, ['rebase', '--skip']);
      case 'cherry-pick': if (!/^[0-9a-f]{4,40}$/i.test(a.commit || '')) throw new Error('Invalid commit hash'); return this.git(cwd, ['cherry-pick', a.commit]);
      case 'stash': return this.git(cwd, ['stash', 'push', '--include-untracked', ...(a.message ? ['-m', String(a.message)] : [])]);
      case 'stash-pop': return this.git(cwd, ['stash', 'pop']);
      case 'stash-list': return this.git(cwd, ['stash', 'list']);
      case 'tag': return this.git(cwd, ['tag', ...(a.message ? ['-a', ref(a.tag), '-m', String(a.message)] : [ref(a.tag)])]);
      case 'remote-add': { if (!/^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(a.url || '')) throw new Error('Invalid remote URL'); return this.git(cwd, ['remote', 'add', ref(a.name || 'origin'), a.url]); }
      case 'revert': if (!/^[0-9a-f]{4,40}$/i.test(a.commit || '')) throw new Error('Invalid commit hash'); return this.git(cwd, ['revert', '--no-edit', a.commit]);
      default: throw new Error(`Unknown Git operation: ${name}`);
    }
  }
}

function entry(xy, p) {
  return { path: p, index: xy[0], worktree: xy[1], staged: xy[0] !== '.', untracked: false };
}

/** Parses a remote URL into the hosting service and a web base URL (GitHub, GitLab, Bitbucket Cloud/Server, Azure DevOps). */
/** Remote URLs: https://…, ssh://…, git@host:path, or a local path; never an option-looking value. */
export function remoteUrl(u) {
  const v = String(u || '').trim();
  if (!v || v.startsWith('-') || /\s/.test(v) || !/^(https:\/\/|ssh:\/\/|git@[^:\s]+:|file:\/\/|[A-Za-z]:[\\/]|\/|\\\\)/.test(v)) throw new Error('Use an https://… or git@host:… repository address');
  return v;
}

export function webInfo(url) {
  if (!url) return null;
  let host, repoPath, m;
  if ((m = /^git@([^:]+):(.+?)(\.git)?$/.exec(url))) { host = m[1]; repoPath = m[2]; }
  else if ((m = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?$/.exec(url))) { host = m[1]; repoPath = m[2]; }
  else if ((m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?\/?$/.exec(url))) { host = m[1]; repoPath = m[2]; }
  else return null;
  host = host.replace(/^ssh\./, '').replace(/^altssh\./, '');
  let kind = 'generic';
  if (/github\.com$/i.test(host)) kind = 'github';
  else if (/gitlab/i.test(host)) kind = 'gitlab';
  else if (/bitbucket\.org$/i.test(host)) kind = 'bitbucket-cloud';
  else if (/dev\.azure\.com$|visualstudio\.com$/i.test(host)) kind = 'azure';
  else if (/^scm\/|\/scm\//.test(repoPath) || /bitbucket/i.test(host)) kind = 'bitbucket-server';
  let base = `https://${host}/${repoPath}`;
  if (kind === 'bitbucket-server') {
    const parts = repoPath.replace(/^scm\//, '').split('/');
    if (parts.length >= 2) base = `https://${host}/projects/${parts[0].toUpperCase()}/repos/${parts[1]}`;
  }
  return { host, path: repoPath, kind, base };
}

/** Browser URL that opens a new pull/merge request from `source` into `target`. */
export function pullRequestUrl(info, source, target) {
  if (!info) return null;
  const s = encodeURIComponent(source || ''), t = encodeURIComponent(target || '');
  switch (info.kind) {
    case 'github': return `${info.base}/compare/${target ? t + '...' : ''}${s}?expand=1`;
    case 'gitlab': return `${info.base}/-/merge_requests/new?merge_request[source_branch]=${s}${target ? `&merge_request[target_branch]=${t}` : ''}`;
    case 'bitbucket-cloud': return `${info.base}/pull-requests/new?source=${s}${target ? `&dest=${t}` : ''}`;
    case 'bitbucket-server': return `${info.base}/pull-requests?create&sourceBranch=refs/heads/${s}${target ? `&targetBranch=refs/heads/${t}` : ''}`;
    case 'azure': return `${info.base}/pullrequestcreate?sourceRef=${s}${target ? `&targetRef=${t}` : ''}`;
    default: return null;
  }
}
