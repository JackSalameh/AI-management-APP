// Connections menu: connect Jira, Bitbucket and Git accounts once, then work with them from the app
// (issues, repositories, pull requests, clone, publish) and through the agents (Atlassian MCP).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JiraClient, BitbucketClient, HttpApiError, checkBaseUrl } from './atlassian.mjs';
import { GIT_HOSTS, HOST_RE, secretNameFor, credentialArgs, whoAmI, listRepos, parseRemote } from './gitaccounts.mjs';
import { run as runProc, which } from './proc.mjs';
import { normalizePath, isInside } from './paths.mjs';
import { validateName } from './paths.mjs';

const bad = (m) => new HttpApiError(400, m);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const JIRA_SECRET = 'ATLASSIAN_ATLASSIAN_AUTH';
const BB_SECRET = 'ATLASSIAN_ATLASSIAN_BITBUCKET_AUTH';
const PRESET_JQL = {
  mine: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  reported: 'reporter = currentUser() ORDER BY updated DESC',
  recent: 'updated >= -14d ORDER BY updated DESC',
  watching: 'watcher = currentUser() AND statusCategory != Done ORDER BY updated DESC',
};

export class Connections {
  constructor(app) {
    this.app = app;
    app.s.connections ||= { jira: {}, bitbucket: {}, git: { accounts: [] } };
    app.s.connections.git ||= { accounts: [] };
    // Network Git commands (fetch, pull, push, clone) use the connected accounts' tokens.
    app.git.credentials = () => this.gitCredentials();
  }
  get c() { return this.app.s.connections; }
  save() { this.app.store.save(); }

  async #hasSecret(name) { return (await this.app.secrets.list()).some((x) => x.name === name); }

  async info() {
    const c = this.c;
    const [jiraKey, bbKey] = await Promise.all([this.#hasSecret(JIRA_SECRET), this.#hasSecret(BB_SECRET)]);
    const identity = await this.gitIdentity();
    const sshPub = ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub'].map((n) => path.join(os.homedir(), '.ssh', n)).find((f) => fs.existsSync(f));
    const tools = this.app.s.tools;
    return {
      jira: { connected: !!(c.jira.site && jiraKey), site: c.jira.site || '', email: c.jira.email || tools.jira.email || '', user: c.jira.user || null, mcp: tools.jira.mcpName ? { name: tools.jira.mcpName, mode: tools.jira.mcpMode } : null, aiOnly: tools.jira.mcpMode === 'oauth' && !jiraKey },
      bitbucket: { connected: !!bbKey && !!c.bitbucket.email, email: c.bitbucket.email || tools.bitbucket.email || '', user: c.bitbucket.user || null, workspace: c.bitbucket.workspace || '', mcp: tools.bitbucket.mcpName ? { name: tools.bitbucket.mcpName, mode: tools.bitbucket.mcpMode } : null },
      git: { available: this.app.git.available(), identity, accounts: c.git.accounts.map(({ id, provider, host, apiBase, username, email, auth, name, verified }) => ({ id, provider, label: GIT_HOSTS[provider]?.label || provider, host, apiBase, username, email, auth, name, verified })), ssh: sshPub ? { file: sshPub, key: fs.readFileSync(sshPub, 'utf8').trim() } : null, hosts: GIT_HOSTS },
      matlab: { enabled: tools.matlab.enabled, agents: tools.matlab.agents || null },
    };
  }

  // ------------------------------------------------------------------ Jira
  async jiraConnect({ site, email, token, mcp = true }) {
    const base = checkBaseUrl(site);
    if (!EMAIL.test(email || '')) throw bad('Enter the e-mail address of your Atlassian account');
    const auth = token ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : await this.app.secrets.get(JIRA_SECRET);
    if (!auth) throw bad('Paste your Atlassian API token');
    const me = await new JiraClient(base, auth).myself(); // proves site + e-mail + token before anything is saved
    Object.assign(this.c.jira, { site: base, email, user: me.name, accountId: me.accountId, at: Date.now() });
    this.app.s.tools.jira.email = email;
    let connection = null, notes = [];
    if (mcp && token) ({ connection, notes } = await this.app.connectAtlassian({ purpose: 'jira', mode: 'token', email, token }));
    else if (token) await this.app.secrets.set(JIRA_SECRET, auth, 'Atlassian (Jira)');
    this.save();
    return { ok: true, user: me.name, site: base, connection, notes };
  }
  async #jira() {
    const { site } = this.c.jira;
    const auth = await this.app.secrets.get(JIRA_SECRET);
    if (!site || !auth || !/^Basic /.test(auth)) throw bad('Connect Jira first (Connections › Jira) with your e-mail and API token.');
    return new JiraClient(site, auth);
  }
  async jiraSearch({ preset, jql, text, project, max }) {
    let q = jql?.trim();
    if (!q) {
      const parts = [];
      if (project) { if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw bad('Invalid project'); parts.push(`project = ${project}`); }
      if (text?.trim()) {
        const t = text.trim();
        if (/^[A-Z][A-Z0-9_]+-\d+$/.test(t)) parts.push(`key = ${t}`); else parts.push(`text ~ "${t.replace(/["\\]/g, ' ')}"`);
        q = `${parts.join(' AND ')} ORDER BY updated DESC`;
      } else q = parts.length ? `${parts.join(' AND ')} AND ${PRESET_JQL[preset] || PRESET_JQL.mine}` : (PRESET_JQL[preset] || PRESET_JQL.mine);
    }
    return { jql: q, issues: await (await this.#jira()).search(q, max) };
  }
  async jiraIssue(key) { return (await this.#jira()).issue(key); }
  async jiraAct({ key, action, text, transition }) {
    const j = await this.#jira();
    if (action === 'comment') return j.comment(key, text);
    if (action === 'transition') return j.transition(key, transition);
    if (action === 'assign') return j.assignToMe(key);
    throw bad('Unknown action');
  }
  async jiraProjects() { return { projects: await (await this.#jira()).projects() }; }
  async jiraCreate(b) { return (await this.#jira()).create(b); }

  // ------------------------------------------------------------------ Bitbucket Cloud
  async bitbucketConnect({ email, token, mcp = true, useForGit = true }) {
    if (!EMAIL.test(email || '')) throw bad('Enter the e-mail address of your Atlassian account');
    if (!token) throw bad('Paste a Bitbucket API token (with scopes for repositories and pull requests)');
    const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    const bb = new BitbucketClient(auth);
    const me = await bb.user();
    const ws = await bb.workspaces().catch(() => []);
    Object.assign(this.c.bitbucket, { email, user: me.name, username: me.username, workspace: this.c.bitbucket.workspace || ws[0]?.slug || '', at: Date.now() });
    this.app.s.tools.bitbucket.email = email;
    let connection = null, notes = [];
    if (mcp) ({ connection, notes } = await this.app.connectAtlassian({ purpose: 'bitbucket', mode: 'token', email, token }));
    else await this.app.secrets.set(BB_SECRET, auth, 'Atlassian (Bitbucket)');
    if (useForGit) {
      await this.gitAccountSave({ provider: 'bitbucket', email, token, auth: 'token', quiet: true });
      notes.push('Git: clone, pull and push to bitbucket.org use this token.');
    }
    this.save();
    return { ok: true, user: me.name, workspaces: ws, connection, notes };
  }
  async #bb() {
    const auth = await this.app.secrets.get(BB_SECRET);
    if (!auth || !/^Basic /.test(auth)) throw bad('Connect Bitbucket first (Connections › Bitbucket) with your e-mail and API token.');
    return new BitbucketClient(auth);
  }
  async bbWorkspaces() { return { workspaces: await (await this.#bb()).workspaces(), current: this.c.bitbucket.workspace || '' }; }
  async bbRepos({ workspace, q }) {
    const ws = workspace || this.c.bitbucket.workspace;
    if (!ws) throw bad('Choose a workspace');
    if (workspace && workspace !== this.c.bitbucket.workspace) { this.c.bitbucket.workspace = workspace; this.save(); }
    return { workspace: ws, repos: await (await this.#bb()).repos(ws, q) };
  }
  async bbPullRequests({ workspace, repo, state }) { return { prs: await (await this.#bb()).pullRequests(workspace, repo, state) }; }
  async bbPullRequest({ workspace, repo, id }) { return (await this.#bb()).pullRequest(workspace, repo, id); }
  async bbCreatePr({ workspace, repo, title, source, destination, description }) { return (await this.#bb()).createPullRequest(workspace, repo, { title, source, destination, description }); }
  async bbPrAction({ workspace, repo, id, action, text }) { return (await this.#bb()).prAction(workspace, repo, id, action, text); }

  /** Pull request from the current folder's branch, via the API when the remote is on bitbucket.org. */
  async bbPrFromFolder({ folder, title, destination, description }) {
    const cwd = normalizePath(folder);
    const st = await this.app.git.status(cwd);
    if (!st.repo) throw bad('Not a Git repository');
    const remotes = await this.app.git.remotes(cwd);
    const m = remotes.map((r) => /bitbucket\.org[:/]([^/]+)\/([^/.\s]+)(\.git)?$/.exec(r.url)).find(Boolean);
    if (!m) throw bad('No bitbucket.org remote in this repository');
    if (st.ahead || !st.upstream) { const p = await this.app.git.op(cwd, 'push', {}); if (!p.ok) throw bad(`Push failed before creating the pull request: ${(p.stderr || '').trim().slice(0, 300)}`); }
    return this.bbCreatePr({ workspace: m[1], repo: m[2], title: title || st.branch, source: st.branch, destination, description });
  }

  // ------------------------------------------------------------------ Git accounts
  async gitIdentity() {
    const g = async (k) => { const r = await this.app.git.git(os.homedir(), ['config', '--global', '--get', k]).catch(() => null); return r?.ok ? r.stdout.trim() : ''; };
    return { name: await g('user.name'), email: await g('user.email'), helper: await g('credential.helper') };
  }
  async setGitIdentity({ name, email }) {
    if (!String(name || '').trim()) throw bad('Enter your name (shown in commits)');
    if (!EMAIL.test(email || '')) throw bad('Enter a valid e-mail (shown in commits)');
    for (const [k, v] of [['user.name', String(name).trim()], ['user.email', String(email).trim()]]) {
      const r = await this.app.git.git(os.homedir(), ['config', '--global', k, v]);
      if (!r.ok) throw bad(r.stderr.trim() || 'git config failed');
    }
    return this.gitIdentity();
  }

  async gitAccountSave({ id, provider, host, apiBase, username, email, token, auth = 'token', quiet = false }) {
    const p = GIT_HOSTS[provider];
    if (!p) throw bad('Choose GitHub, GitLab, Bitbucket, Azure DevOps or another server');
    const h = (host || p.host || '').trim().toLowerCase();
    if (!HOST_RE.test(h)) throw bad('Enter the server name, e.g. git.mycompany.com');
    if (apiBase) checkBaseUrl(apiBase);
    if (!['token', 'ssh', 'system'].includes(auth)) throw bad('Unknown sign-in method');
    const accs = this.c.git.accounts;
    const existing = accs.find((a) => a.id === id) || accs.find((a) => a.provider === provider && a.host === h);
    const acc = existing || { id: crypto.randomUUID().slice(0, 8) };
    Object.assign(acc, { provider, host: h, apiBase: apiBase || null, auth, email: email || acc.email || null, username: username || (provider === 'bitbucket' ? p.user : acc.username || p.user || null) });
    if (auth === 'token') {
      const secret = secretNameFor(acc.id);
      if (token) {
        if (provider === 'bitbucket' && !EMAIL.test(acc.email || '')) throw bad('Bitbucket API tokens need your Atlassian e-mail');
        const who = await whoAmI({ ...acc, token }).catch((e) => { if (quiet) return { name: '', verified: false }; throw e; });
        Object.assign(acc, { name: who.name, verified: who.verified });
        await this.app.secrets.set(secret, token, `Git token (${p.label} ${h})`);
      } else if (!(await this.#hasSecret(secret))) throw bad('Paste the access token');
      if (!acc.username) throw bad('Enter the user name for this server');
    }
    if (!existing) accs.push(acc);
    this.save();
    return { account: acc };
  }
  async gitAccountRemove(id) {
    const i = this.c.git.accounts.findIndex((a) => a.id === id);
    if (i < 0) throw bad('Unknown account');
    await this.app.secrets.remove(secretNameFor(id)).catch(() => {});
    this.c.git.accounts.splice(i, 1); this.save();
    return { ok: true };
  }
  async #withToken(id) {
    const acc = this.c.git.accounts.find((a) => a.id === id);
    if (!acc) throw bad('Unknown account');
    return { ...acc, token: acc.auth === 'token' ? await this.app.secrets.get(secretNameFor(id)) : null };
  }
  async gitRepos({ id, q }) { return { repos: await listRepos(await this.#withToken(id), q) }; }

  async gitCredentials() {
    const list = [];
    for (const a of this.c.git.accounts) if (a.auth === 'token') { const token = await this.app.secrets.get(secretNameFor(a.id)).catch(() => null); if (token) list.push({ host: a.host, username: a.username, token }); }
    return credentialArgs(list);
  }

  async testRemote({ url }) {
    const r = parseRemote(url);
    const res = await this.app.git.git(os.homedir(), ['ls-remote', '--heads', '--', r.url], { timeout: 60_000 });
    return { ok: res.ok, host: r.host, output: (res.ok ? `${res.stdout.split('\n').filter(Boolean).length} branches` : res.stderr.trim()).slice(0, 500), hint: res.hint || null };
  }

  /** Clones into <parent>/<name>, adds the folder to the Explorer, returns it. */
  async clone({ url, parent, name }) {
    const r = parseRemote(url);
    const dir = normalizePath(parent);
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw bad('Choose an existing parent folder');
    const n = String(name || r.url.split(/[/:]/).pop().replace(/\.git$/, '')).trim();
    const err = validateName(n); if (err) throw bad(err);
    const target = path.join(dir, n);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw bad(`${target} already exists and is not empty`);
    const res = await this.app.git.clone(r.url, dir, n);
    if (!res.ok) throw bad(`${(res.stderr || res.error || '').trim().slice(0, 500)}${res.hint ? `\n${res.hint}` : ''}`);
    await this.app.addFolder(target).catch(() => {});
    return { ok: true, folder: target };
  }

  /** Publishes a local folder: git init if needed, creates the repository on the host (optional), adds origin, pushes. */
  async publish({ folder, url, accountId, name, isPrivate = true, workspace }) {
    const cwd = normalizePath(folder);
    if (!cwd || !fs.existsSync(cwd)) throw bad('Folder not found');
    const git = this.app.git;
    let st = await git.status(cwd);
    if (!st.repo || !isInside(cwd, st.root)) { const r = await git.op(cwd, 'init', { branch: 'main' }); if (!r.ok) throw bad(r.stderr.trim()); st = await git.status(cwd); }
    let remoteUrl = url;
    if (!remoteUrl) {
      if (!accountId) throw bad('Paste the repository address, or choose an account to create it');
      const acc = await this.#withToken(accountId);
      remoteUrl = await createRemoteRepo(acc, { name: name || path.basename(cwd), isPrivate, workspace: workspace || this.c.bitbucket.workspace });
    }
    parseRemote(remoteUrl);
    const remotes = await git.remotes(cwd);
    const op = remotes.some((r) => r.name === 'origin') ? 'remote-set-url' : 'remote-add';
    const rr = await git.op(cwd, op, { url: remoteUrl }); if (!rr.ok) throw bad(rr.stderr.trim());
    const log = await git.git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (!log.ok) return { ok: true, remote: remoteUrl, pushed: false, note: 'Remote added. Make a first commit, then Push.' };
    const push = await git.op(cwd, 'push', {});
    return { ok: push.ok, remote: remoteUrl, pushed: push.ok, output: (push.stdout + push.stderr).trim().slice(0, 800), hint: push.hint || null };
  }

  // ------------------------------------------------------------------ SSH
  async sshKey({ create = false, email }) {
    const dir = path.join(os.homedir(), '.ssh');
    const key = path.join(dir, 'id_ed25519');
    if (!fs.existsSync(`${key}.pub`)) {
      if (!create) return { exists: false };
      if (!which('ssh-keygen')) throw bad('ssh-keygen was not found (it comes with Git for Windows / OpenSSH).');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const r = await runProc('ssh-keygen', ['-t', 'ed25519', '-C', String(email || os.userInfo().username).slice(0, 100), '-f', key, '-N', ''], { timeout: 30_000 });
      if (!r.ok) throw bad(r.stderr.trim() || 'ssh-keygen failed');
    }
    return { exists: true, file: `${key}.pub`, key: fs.readFileSync(`${key}.pub`, 'utf8').trim() };
  }
  async sshTest({ host }) {
    const h = String(host || '').toLowerCase();
    if (!HOST_RE.test(h)) throw bad('Invalid host');
    if (!which('ssh')) throw bad('ssh was not found (it comes with Git for Windows / OpenSSH).');
    const r = await runProc('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', `git@${h}`], { timeout: 30_000 });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const ok = /successfully authenticated|welcome to gitlab|authenticated via|logged in as|shell access is not supported/i.test(out);
    return { ok, output: out.slice(0, 400) };
  }
}

/** Creates an empty repository on the account's host and returns its HTTPS clone URL. */
async function createRemoteRepo(acc, { name, isPrivate, workspace }) {
  const n = String(name || '').trim().replace(/\s+/g, '-');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(n)) throw bad('Repository name: letters, digits, - _ . only');
  const post = async (url, headers, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ai-management-app', ...headers }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw bad(`${r.status} ${j.message || j.error?.message || JSON.stringify(j).slice(0, 200)}`);
    return j;
  };
  const p = GIT_HOSTS[acc.provider];
  const api = acc.apiBase ? checkBaseUrl(acc.apiBase) : p.api;
  if (acc.provider === 'github') return (await post(`${api}/user/repos`, { Authorization: `Bearer ${acc.token}` }, { name: n, private: !!isPrivate })).clone_url;
  if (acc.provider === 'gitlab') return (await post(`${api}/projects`, { 'PRIVATE-TOKEN': acc.token }, { name: n, visibility: isPrivate ? 'private' : 'public' })).http_url_to_repo;
  if (acc.provider === 'bitbucket') {
    if (!workspace) throw bad('Choose a Bitbucket workspace');
    const j = await post(`${api}/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(n.toLowerCase())}`, { Authorization: `Basic ${Buffer.from(`${acc.email}:${acc.token}`).toString('base64')}` }, { scm: 'git', is_private: !!isPrivate });
    return (j.links?.clone || []).find((c) => c.name === 'https')?.href.replace(/^https:\/\/[^@/]+@/, 'https://');
  }
  throw bad(`Creating repositories is not available for ${p.label}; create it on the website and paste its address.`);
}
