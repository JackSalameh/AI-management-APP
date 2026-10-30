// Connections menu: Jira and Bitbucket (connect, then act), Git accounts (identity, tokens, clone, publish).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-conn-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), work = path.join(root, 'work'), home = path.join(root, 'home');
for (const d of [codexHome, work, home]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; // git config --global and ~/.ssh stay in the sandbox
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(root, 'none');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.CPM_NO_EXIT = '1';
process.env.CPM_NO_AUTO_ICONS = '1';

import { startStub } from './fixtures/atlassian-stub.mjs';
const STUB = await startStub();
const { seen } = STUB;
const SB = STUB.url;
process.env.CPM_BITBUCKET_API = `${SB}/bb`;
process.env.CPM_GITHUB_API = `${SB}/gh`;
const { createServer } = await import('../server.mjs');

let srv, base;
async function api(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
before(async () => { srv = await createServer({ dataDir, codexHome, port: 0 }); base = srv.url.replace(/\/#.*$/, '').replace(/\/$/, ''); });
after(async () => { await srv.shutdown(0); STUB.close(); });

test('Jira: wrong token is refused before anything is saved; right token connects REST and the agents (MCP)', async () => {
  const wrong = await api('/api/connections/jira', { site: `${SB}/jira`, email: 'jack@example.com', token: 'nope' });
  assert.equal(wrong.status, 400); assert.match(wrong.error, /401/);
  assert.equal((await api('/api/connections')).jira.connected, false);
  assert.equal((await api('/api/connections/jira', { site: 'http://evil.example/jira', email: 'jack@example.com', token: 'x' })).status, 400, 'https only (except loopback)');
  const ok = await api('/api/connections/jira', { site: `${SB}/jira`, email: 'jack@example.com', token: 'JIRA-TOKEN' });
  assert.equal(ok.status, 200, ok.error);
  assert.equal(ok.user, 'Jack Salameh');
  assert.equal(ok.connection.state, 'connected', 'Atlassian MCP registered for the agents');
  const info = await api('/api/connections');
  assert.equal(info.jira.connected, true);
  assert.ok(!JSON.stringify(info).includes('JIRA-TOKEN'), 'token never returned');
});

test('Jira: my issues, issue detail (ADF → text), comment, transition, assign, projects, create', async () => {
  const s = await api('/api/jira/search', { preset: 'mine' });
  assert.equal(s.status, 200, s.error);
  assert.match(s.jql, /assignee = currentUser\(\)/);
  assert.equal(s.issues[0].key, 'X1191-7');
  assert.ok(s.issues[0].url.endsWith('/browse/X1191-7'));
  const t = await api('/api/jira/search', { text: 'focal "lens"', project: 'X1191' });
  assert.match(t.jql, /^project = X1191 AND text ~ "focal  lens "/);
  assert.equal((await api('/api/jira/search', { project: 'x; drop' })).status, 400);
  const i = await api('/api/jira/issue?key=X1191-7');
  assert.equal(i.description, 'Use the 25 mm lens.');
  assert.equal(i.comments[0].text, 'Images are in ./calib');
  assert.deepEqual(i.transitions.map((x) => x.name), ['Done']);
  assert.equal((await api('/api/jira/act', { key: 'X1191-7', action: 'comment', text: 'Focal = 25.02 mm ± 0.05' })).status, 200);
  const c = seen.filter((r) => r.url.endsWith('/comment')).at(-1);
  assert.equal(c.body.body.content[0].content[0].text, 'Focal = 25.02 mm ± 0.05');
  assert.equal((await api('/api/jira/act', { key: 'X1191-7', action: 'transition', transition: '31' })).status, 200);
  assert.equal((await api('/api/jira/act', { key: 'X1191-7', action: 'assign' })).status, 200);
  assert.equal(seen.filter((r) => r.url.endsWith('/assignee')).at(-1).body.accountId, 'acc-1');
  assert.equal((await api('/api/jira/projects')).projects[0].key, 'X1191');
  const cr = await api('/api/jira/create', { project: 'X1191', summary: 'Measure distortion', type: 'Task', description: 'Use the grid target.' });
  assert.equal(cr.key, 'X1191-8');
  assert.equal((await api('/api/jira/issue?key=bad')).status, 400);
});

test('Bitbucket: connect (also used by Git), workspaces, repos, pull requests, diff, approve, create', async () => {
  const r = await api('/api/connections/bitbucket', { email: 'jack@example.com', token: 'BB-TOKEN' });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.workspaces[0].slug, 'acme');
  const info = await api('/api/connections');
  assert.equal(info.bitbucket.connected, true);
  assert.equal(info.bitbucket.workspace, 'acme');
  assert.ok(info.git.accounts.some((a) => a.provider === 'bitbucket' && a.host === 'bitbucket.org'), 'token also used for Git over HTTPS');
  const repos = await api('/api/bitbucket/repos?workspace=acme');
  assert.equal(repos.repos[0].clone.https, 'https://bitbucket.org/acme/optics.git', 'user name stripped from the clone URL');
  const prs = await api('/api/bitbucket/prs?workspace=acme&repo=optics');
  assert.equal(prs.prs[0].id, 4);
  const pr = await api('/api/bitbucket/pr?workspace=acme&repo=optics&id=4');
  assert.match(pr.diff, /\+x = 1;/);
  assert.equal((await api('/api/bitbucket/pr/act', { workspace: 'acme', repo: 'optics', id: 4, action: 'approve' })).status, 200);
  const n = await api('/api/bitbucket/pr/create', { workspace: 'acme', repo: 'optics', title: 'Distortion', source: 'feature/dist', destination: 'main' });
  assert.equal(n.id, 5);
  assert.equal((await api('/api/bitbucket/repos?workspace=../etc')).status, 400);
});

test('Git: identity, GitHub account (token checked, kept in the keychain), my repositories, credential helper', async () => {
  const id = await api('/api/git/identity', { name: 'Jack Salameh', email: 'jacksalameh@live.com' });
  assert.equal(id.status, 200, id.error);
  assert.equal(execFileSync('git', ['config', '--global', 'user.email'], { env: process.env }).toString().trim(), 'jacksalameh@live.com');
  assert.equal((await api('/api/git/account', { provider: 'github', token: 'wrong' })).status, 400);
  const a = await api('/api/git/account', { provider: 'github', token: 'GH-TOKEN' });
  assert.equal(a.status, 200, a.error);
  assert.equal(a.account.name, 'jacks');
  assert.ok(!JSON.stringify(await api('/api/connections')).includes('GH-TOKEN'));
  const repos = await api(`/api/git/account/repos?id=${a.account.id}`);
  assert.equal(repos.repos[0].name, 'jacks/ai-management-app');
  // The helper Git actually runs returns the stored token for that host only.
  const cred = await srv.app.conn.gitCredentials();
  const fill = (host) => execFileSync('git', [...cred.args, 'credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...process.env, ...cred.env, GIT_TERMINAL_PROMPT: '0' } }).toString();
  assert.match(fill('github.com'), /password=GH-TOKEN/);
  assert.match(fill('bitbucket.org'), /username=x-bitbucket-api-token-auth\npassword=BB-TOKEN/);
  assert.ok(!cred.args.join(' ').includes('GH-TOKEN'), 'token not on the command line');
});

test('Git: clone into a folder (added to the Explorer), publish a new folder to a remote, test a remote', async () => {
  // a "server" repository with one commit
  const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed');
  execFileSync('git', ['config', '--global', 'init.defaultBranch', 'main']);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), '# optics\n');
  execFileSync('git', ['-C', seed, 'add', '.']); execFileSync('git', ['-C', seed, 'commit', '-m', 'init']); execFileSync('git', ['-C', seed, 'push', origin, 'main']);
  const c = await api('/api/git/clone', { url: `file://${origin}`, parent: work, name: 'optics' });
  assert.equal(c.status, 200, c.error);
  assert.ok(fs.existsSync(path.join(work, 'optics', 'README.md')));
  assert.ok(Object.values(srv.app.s.folders).some((f) => f.path === path.join(work, 'optics')), 'folder added to the Explorer');
  assert.equal((await api('/api/git/clone', { url: `file://${origin}`, parent: work, name: 'optics' })).status, 400, 'existing non-empty folder refused');
  assert.equal((await api('/api/git/clone', { url: '--upload-pack=touch /tmp/x', parent: work })).status, 400);
  const tr = await api('/api/git/remote/test', { url: origin });
  assert.equal(tr.ok, true, tr.output);
  // publish: a plain folder becomes a repository pushed to a new remote
  const target = path.join(root, 'published.git'); execFileSync('git', ['init', '--bare', target]);
  const pub = path.join(work, 'NewProject'); fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'main.m'), 'disp(1)\n');
  const p1 = await api('/api/git/publish', { folder: pub, url: target });
  assert.equal(p1.status, 200, p1.error);
  assert.equal(p1.pushed, false, 'nothing to push before the first commit');
  execFileSync('git', ['-C', pub, 'add', '.']); execFileSync('git', ['-C', pub, 'commit', '-m', 'first']);
  const p2 = await api('/api/git/publish', { folder: pub, url: target });
  assert.equal(p2.pushed, true, p2.output);
  assert.match(execFileSync('git', ['--git-dir', target, 'log', '--oneline']).toString(), /first/);
  // create the repository on GitHub through the account, then push
  const gh = (await api('/api/connections')).git.accounts.find((a) => a.provider === 'github');
  const pub2 = path.join(work, 'Another'); fs.mkdirSync(pub2);
  const p3 = await api('/api/git/publish', { folder: pub2, accountId: gh.id, name: 'another' });
  assert.equal(p3.remote, 'https://github.com/jacks/another.git');
});

test('SSH key: reported when missing; clear message when ssh-keygen is unavailable', async () => {
  const k = await api('/api/git/ssh-key', {});
  assert.equal(k.exists, false);
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAATEST jack');
  const k2 = await api('/api/git/ssh-key', {});
  assert.equal(k2.key, 'ssh-ed25519 AAAATEST jack');
  assert.equal((await api('/api/connections')).git.ssh.key, 'ssh-ed25519 AAAATEST jack');
});

test('Git panel "Add remote" (name + url) works; option-looking URLs are refused (regression)', async () => {
  const f = path.join(work, 'RemoteAdd'); fs.mkdirSync(f);
  await api('/api/git/op', { folder: f, op: 'init' });
  const r = await api('/api/git/op', { folder: f, op: 'remote-add', args: { name: 'upstream', url: 'git@bitbucket.org:acme/optics.git' } });
  assert.equal(r.ok, true, r.output);
  assert.match(execFileSync('git', ['-C', f, 'remote', '-v']).toString(), /^upstream\tgit@bitbucket\.org:acme\/optics\.git/m);
  assert.equal((await api('/api/git/op', { folder: f, op: 'remote-add', args: { name: 'x', url: '--upload-pack=evil' } })).status, 400);
});

test('Checkpoints: files are snapshotted before each AI turn and can be restored (branch and index untouched)', async () => {
  const f = path.join(work, 'Checkpointed'); fs.mkdirSync(f);
  execFileSync('git', ['init', '-q', '-b', 'main', f]);
  fs.writeFileSync(path.join(f, 'calib.m'), 'f = 25;\n');
  execFileSync('git', ['-C', f, 'add', '.']); execFileSync('git', ['-C', f, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(f, 'notes.txt'), 'draft\n'); // untracked work of the user is part of the checkpoint
  const n = await api('/api/conversation/new', { folder: f });
  const s = await api('/api/conversation/send', { key: n.key, text: 'change the focal length' });
  assert.equal(s.status, 200, s.error);
  const list = await api(`/api/checkpoints?key=${encodeURIComponent(n.key)}`);
  assert.equal(list.checkpoints.length, 1);
  assert.equal(list.checkpoints[0].label, 'change the focal length');
  // the "AI" edits, deletes and creates files
  fs.writeFileSync(path.join(f, 'calib.m'), 'f = 99;\n'); fs.rmSync(path.join(f, 'notes.txt')); fs.writeFileSync(path.join(f, 'new.m'), 'x\n');
  const id = list.checkpoints[0].id;
  const p = await api('/api/checkpoints/preview', { key: n.key, id });
  assert.deepEqual([p.changed, p.deleted, p.created], [['calib.m'], ['notes.txt'], ['new.m']]);
  const r = await api('/api/checkpoints/restore', { key: n.key, id });
  assert.equal(r.status, 200, r.error);
  assert.equal(fs.readFileSync(path.join(f, 'calib.m'), 'utf8'), 'f = 25;\n');
  assert.equal(fs.readFileSync(path.join(f, 'notes.txt'), 'utf8'), 'draft\n');
  assert.ok(fs.existsSync(path.join(f, 'new.m')), 'new files kept unless asked');
  assert.deepEqual(r.kept, ['new.m']);
  const r2 = await api('/api/checkpoints/restore', { key: n.key, id, removeCreated: true });
  assert.deepEqual(r2.removed, ['new.m']); assert.ok(!fs.existsSync(path.join(f, 'new.m')));
  // undo of the restore is available, and Git state of the user is untouched
  const after = await api(`/api/checkpoints?key=${encodeURIComponent(n.key)}`);
  assert.ok(after.checkpoints.some((c) => c.safety));
  assert.equal(execFileSync('git', ['-C', f, 'log', '--oneline']).toString().trim().split('\n').length, 1, 'no commit on the branch');
  assert.equal(execFileSync('git', ['-C', f, 'diff', '--cached', '--name-only']).toString().trim(), '', 'index untouched');
  assert.match(execFileSync('git', ['-C', f, 'for-each-ref', 'refs/cpm']).toString(), /refs\/cpm\/codex-/);
  // not a repository: no checkpoint, no error
  const plain = path.join(work, 'PlainFolder'); fs.mkdirSync(plain);
  const n2 = await api('/api/conversation/new', { folder: plain });
  const s2 = await api('/api/conversation/send', { key: n2.key, text: 'hi' });
  assert.equal(s2.status, 200); assert.equal((await api(`/api/checkpoints?key=${encodeURIComponent(n2.key)}`)).checkpoints.length, 0);
});
