import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath, pathKey, splitPath, isInside, rebase, validateName, isRootPath, parentPath, joinSegments } from '../lib/paths.mjs';
import { parseToml, findInlineSecrets } from '../lib/toml.mjs';
import { buildTree } from '../lib/tree.mjs';
import { normalizeChanges, splitUserText, fromCodexItem, CONTEXT_OPEN, CONTEXT_CLOSE } from '../lib/items.mjs';
import { parseGitHubSource, parseFrontmatter, findSkills, installSkills } from '../lib/skills.mjs';
import { webInfo, pullRequestUrl, validRef, Git } from '../lib/git.mjs';
import { profileFromToml, checkEffort, configEditsFor, mergeModels } from '../lib/models.mjs';
import { matlabStartupScript } from '../lib/tools.mjs';
import { codexPolicy, isWriterLockError } from '../lib/agents/codex.mjs';
import { Memory } from '../lib/memory.mjs';
import { quoteCmdArg } from '../lib/proc.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-u-'));

test('paths: Win32 long-path prefix is the same folder (v1 bug #1)', () => {
  assert.equal(normalizePath('\\\\?\\D:\\X1191\\Distance focal'), 'D:\\X1191\\Distance focal');
  assert.equal(pathKey('\\\\?\\d:\\x1191\\Distance Focal\\'), pathKey('D:/X1191/distance focal'));
  assert.equal(normalizePath('\\\\?\\UNC\\srv\\share\\a'), '\\\\srv\\share\\a');
  assert.equal(normalizePath('D:'), 'D:\\');
  assert.equal(normalizePath('/home/jack/'), '/home/jack');
  assert.deepEqual(splitPath('D:\\X1191\\Focal'), ['D:', 'X1191', 'Focal']);
  assert.deepEqual(splitPath('/a/b'), ['/', 'a', 'b']);
  assert.equal(joinSegments(['D:']), 'D:\\');
  assert.ok(isRootPath('D:\\') && isRootPath('/') && !isRootPath('D:\\x'));
  assert.equal(parentPath('D:\\X1191'), 'D:\\');
});

test('paths: isInside / rebase / validateName', () => {
  assert.ok(isInside('D:\\X1191\\Focal', 'd:\\x1191'));
  assert.ok(!isInside('D:\\X11910', 'D:\\X1191'));
  assert.equal(rebase('D:\\X1191\\Focal\\a', 'D:\\X1191\\Focal', 'D:\\X1191\\Focale'), 'D:\\X1191\\Focale\\a');
  assert.equal(validateName('ok name'), null);
  for (const bad of ['a/b', 'CON', 'x.', 'a:b', '', '..']) assert.ok(validateName(bad), bad);
});

test('toml: parses Codex-style config with comments, tables, inline tables and arrays', () => {
  const t = parseToml(`# comment\nmodel = "gpt-5.4" # trailing\nmodel_reasoning_effort = 'high'\nmodel_provider = "azure"\n\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://x.openai.azure.com/openai"\nenv_key = "AZURE_OPENAI_API_KEY"\nquery_params = { api-version = "2025-04-01-preview" }\n\n[mcp_servers.matlab]\ncommand = "C:\\\\x\\\\m.exe"\nargs = [\n  "--a",\n  "--b", # c\n]\nenabled = false\nn = 1_000\n[[profiles]]\nx = 1\n[[profiles]]\nx = 2\n`);
  assert.equal(t.model, 'gpt-5.4');
  assert.equal(t.model_providers.azure.query_params['api-version'], '2025-04-01-preview');
  assert.deepEqual(t.mcp_servers.matlab.args, ['--a', '--b']);
  assert.equal(t.mcp_servers.matlab.command, 'C:\\x\\m.exe');
  assert.equal(t.mcp_servers.matlab.enabled, false);
  assert.equal(t.mcp_servers.matlab.n, 1000);
  assert.equal(t.profiles.length, 2);
  assert.throws(() => parseToml('a = 1\na = 2'), /Duplicate/);
  assert.throws(() => parseToml('a = "unterminated'), /line 1/);
  assert.throws(() => parseToml('[x]\n[x]'), /twice/);
  assert.deepEqual(findInlineSecrets(parseToml('api_key = "sk-123"\nenv_key = "X"')), ['api_key']);
});

test('toml: multi-line strings', () => {
  const t = parseToml('a = """\nline1\nline2"""\nb = \'\'\'\nraw\\n\'\'\'\n');
  assert.equal(t.a, 'line1\nline2');
  assert.equal(t.b, 'raw\\n');
});

test('tree: drive roots, collapsed chains, X1191 › Distance focal', () => {
  const tree = buildTree({
    folders: ['D:\\X1191'],
    conversations: [
      { key: 'codex:1', cwd: '\\\\?\\D:\\X1191\\Distance focal' },
      { key: 'codex:2', cwd: 'D:\\X1191\\distance focal' },
      { key: 'codex:3', cwd: 'C:\\Users\\jack\\Projects\\A' },
      { key: 'codex:4', cwd: 'D:\\X1191' },
    ],
  });
  const d = tree.find((n) => n.name === 'D:');
  const x = d.children.find((n) => n.name === 'X1191');
  assert.ok(x, 'X1191 head folder present');
  assert.deepEqual(x.conversations, ['codex:4']);
  assert.equal(x.children[0].name, 'Distance focal');
  assert.equal(x.children[0].conversations.length, 2, 'both path spellings land in one folder');
  const c = tree.find((n) => n.name === 'C:');
  assert.equal(c.children[0].name, 'Users\\jack\\Projects\\A', 'empty single-child chain collapsed');
  assert.equal(d.total, 3);
});

test('items: file changes as array or object (v1 bug #5) and context splitting (bug #9)', () => {
  assert.equal(normalizeChanges([{ path: 'a', kind: { type: 'add' }, diff: '+x' }])[0].kind, 'add');
  const obj = normalizeChanges({ 'b.txt': { type: 'update', unified_diff: '@@' }, 'c.txt': { add: true, content: 'hi' } });
  assert.equal(obj.length, 2);
  assert.equal(obj[0].path, 'b.txt');
  assert.equal(obj[1].diff, '+hi');
  assert.deepEqual(normalizeChanges(null), []);
  const s = splitUserText(`${CONTEXT_OPEN}\nmemory\n${CONTEXT_CLOSE}\n\nhello`);
  assert.equal(s.prompt, 'hello'); assert.equal(s.context, 'memory');
  const legacy = splitUserText('Selected folder and conversation context/instructions. Respect…\n\n## X\nstuff\n\ndoes it work');
  assert.equal(legacy.prompt, 'does it work');
  const item = fromCodexItem({ type: 'fileChange', id: '1', changes: { 'x.m': { type: 'add', content: 'a' } }, status: 'completed' });
  assert.equal(item.changes[0].path, 'x.m');
});

test('skills: GitHub source parsing and frontmatter', () => {
  assert.deepEqual(parseGitHubSource('anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: null, sub: '' });
  assert.deepEqual(parseGitHubSource('https://github.com/o/r/tree/main/skills/pdf'), { owner: 'o', repo: 'r', ref: 'main', sub: 'skills/pdf' });
  assert.deepEqual(parseGitHubSource('https://github.com/o/r/blob/v2/a/SKILL.md'), { owner: 'o', repo: 'r', ref: 'v2', sub: 'a' });
  assert.equal(parseGitHubSource('https://github.com/o/r/tree/main/../../etc'), null);
  assert.equal(parseGitHubSource('https://evil.com/o/r'), null);
  assert.deepEqual(parseFrontmatter('---\nname: pdf\ndescription: "Read PDFs"\n---\nbody'), { name: 'pdf', description: 'Read PDFs' });
});

test('skills: install keeps existing skill unless replace, and backs it up', async () => {
  const src = tmp(), dst = tmp();
  fs.mkdirSync(path.join(src, 'nested', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(src, 'nested', 'my-skill', 'SKILL.md'), '---\nname: my skill\n---\nv2');
  const found = await findSkills(src);
  assert.equal(found[0].name, 'my-skill');
  fs.mkdirSync(path.join(dst, 'my-skill')); fs.writeFileSync(path.join(dst, 'my-skill', 'SKILL.md'), 'v1');
  assert.equal((await installSkills(found, dst))[0].status, 'exists');
  assert.equal(fs.readFileSync(path.join(dst, 'my-skill', 'SKILL.md'), 'utf8'), 'v1');
  await installSkills(found, dst, { replace: true });
  assert.match(fs.readFileSync(path.join(dst, 'my-skill', 'SKILL.md'), 'utf8'), /v2/);
  assert.ok(fs.readdirSync(dst).some((n) => n.startsWith('my-skill.backup-')));
});

test('git: remote parsing and pull-request URLs (GitHub, Bitbucket Cloud/Server, GitLab)', () => {
  const bb = webInfo('git@bitbucket.org:jack/app.git');
  assert.equal(bb.kind, 'bitbucket-cloud');
  assert.equal(pullRequestUrl(bb, 'feature/x', 'main'), 'https://bitbucket.org/jack/app/pull-requests/new?source=feature%2Fx&dest=main');
  assert.equal(webInfo('git@ssh.bitbucket.org:jack/app.git').kind, 'bitbucket-cloud');
  const srv = webInfo('https://bitbucket.company.com/scm/proj/repo.git');
  assert.equal(srv.kind, 'bitbucket-server');
  assert.equal(srv.base, 'https://bitbucket.company.com/projects/PROJ/repos/repo');
  assert.match(pullRequestUrl(webInfo('https://github.com/a/b.git'), 'dev', 'main'), /compare\/main\.\.\.dev/);
  assert.match(pullRequestUrl(webInfo('https://gitlab.com/a/b.git'), 'dev'), /merge_requests\/new/);
  assert.ok(validRef('feature/x-1') && !validRef('-x') && !validRef('a..b') && !validRef('a b'));
});

test('git: real repository operations (commit selected files, branch, merge, stash, rebase abort)', async () => {
  const g = new Git();
  if (!g.available()) return;
  const d = tmp();
  await g.op(d, 'init');
  await g.git(d, ['config', 'user.email', 't@t']); await g.git(d, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(d, 'a.txt'), 'a'); fs.writeFileSync(path.join(d, 'b.txt'), 'b');
  let r = await g.op(d, 'commit', { message: 'only a', files: ['a.txt'] });
  assert.ok(r.ok, r.stderr);
  let st = await g.status(d);
  assert.ok(st.files.some((f) => f.path === 'b.txt' && f.untracked), 'b.txt left uncommitted');
  await g.op(d, 'commit', { message: 'b', files: ['b.txt'] });
  assert.ok((await g.op(d, 'branch-create', { branch: 'feature/x' })).ok);
  fs.writeFileSync(path.join(d, 'a.txt'), 'feature'); await g.op(d, 'commit', { message: 'f', files: ['a.txt'] });
  await g.op(d, 'switch', { branch: (await g.branches(d)).find((b) => !b.remote && b.name !== 'feature/x').name });
  fs.writeFileSync(path.join(d, 'a.txt'), 'main'); await g.op(d, 'commit', { message: 'm', files: ['a.txt'] });
  r = await g.op(d, 'rebase', { branch: 'feature/x' });
  assert.ok(!r.ok, 'conflict expected');
  assert.equal((await g.status(d)).state, 'rebase');
  assert.ok((await g.op(d, 'rebase-abort')).ok);
  assert.equal((await g.status(d)).state, null);
  fs.writeFileSync(path.join(d, 'c.txt'), 'c');
  assert.ok((await g.op(d, 'stash', { message: 'wip' })).ok);
  assert.match((await g.op(d, 'stash-list')).stdout, /wip/);
  assert.ok((await g.op(d, 'stash-pop')).ok);
  await assert.rejects(() => g.op(d, 'switch', { branch: '--evil' }), /Invalid/);
  await assert.rejects(() => g.op(d, 'commit', { message: ' ' }), /required/);
  assert.equal((await g.log(d)).length, 3, 'a, b, m on the main branch');
});

test('models: TOML profile import drops literal secrets; effort validation (bug #10)', () => {
  const r = profileFromToml('model = "gpt-5.4"\nmodel_provider = "azure"\nmodel_reasoning_effort = "high"\n[model_providers.azure]\nbase_url = "https://x"\nenv_key = "AZ_KEY"\nexperimental_bearer_token = "secret"\n', 'GPT 5.4 Azure');
  assert.equal(r.entry.model, 'gpt-5.4');
  assert.equal(r.envKey, 'AZ_KEY');
  assert.deepEqual(r.dropped, ['model_providers.azure.experimental_bearer_token']);
  assert.ok(!('experimental_bearer_token' in r.entry.providerConfig));
  assert.throws(() => profileFromToml('x = 1'), /model/);
  const list = mergeModels({ codex: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }] }, [r.entry]);
  assert.equal(checkEffort(list[0], 'ultra').includes('not available'), true);
  assert.equal(checkEffort(list[0], 'high'), null);
  const edits = configEditsFor(r.entry, 'high');
  assert.deepEqual(edits.map((e) => e.keyPath), ['model', 'model_provider', 'model_providers.azure', 'model_reasoning_effort']);
});

test('matlab: startup script keeps quotes intact (v1 bug #4)', () => {
  const s = matlabStartupScript({ folder: "D:\\X1191\\Jack's model", initSimulink: true, shareSession: true });
  assert.match(s, /version\('-release'\)/);
  assert.match(s, /cd\('D:\\X1191\\Jack''s model'\)/);
  assert.match(s, /satk_initialize/);
});

test('codex: action modes map to approval policy and sandbox', () => {
  assert.equal(codexPolicy('readonly').sandboxPolicy.type, 'readOnly');
  assert.equal(codexPolicy('ask').approvalPolicy, 'untrusted');
  assert.deepEqual(codexPolicy('project', ['/w']).sandboxPolicy.writableRoots, ['/w']);
  assert.deepEqual(codexPolicy('default'), {});
  assert.ok(isWriterLockError(new Error('thread 01a1 already has an active writer')));
});

test('memory: rollout comment on line 1, conflict detection, permission fallback (bug #8)', async () => {
  const data = tmp(), folder = tmp();
  const m = new Memory(data);
  const d = m.conversationDir(folder, 'codex', 't1');
  const r = await m.ensure('conversation', d, 'Conv', { rollout: 'C:\\Users\\x\\.codex\\sessions\\rollout-2026-a.jsonl' });
  const txt = fs.readFileSync(r.files.context, 'utf8');
  assert.equal(txt.split('\n')[0], '<!-- rollout: rollout-2026-a.jsonl -->');
  await m.setRolloutComment(r.files.context, 'rollout-b.jsonl');
  assert.equal(fs.readFileSync(r.files.context, 'utf8').split('\n').filter((l) => l.includes('rollout')).length, 1);
  const cur = await m.read(r.files.context);
  await new Promise((res) => setTimeout(res, 15));
  fs.appendFileSync(r.files.context, '\nagent edit');
  await assert.rejects(() => m.write(r.files.context, 'stale', cur.version), /changed/);
  // Read-only folder → memory goes to the data dir, never throws.
  if (process.getuid?.() !== 0) {
    const ro = tmp(); fs.chmodSync(ro, 0o555);
    const fd = m.folderDir(ro);
    assert.ok(!fd.local);
    const e = await m.ensure('folder', fd, 'RO');
    assert.ok(e.dir.startsWith(data));
    fs.chmodSync(ro, 0o755);
  }
  const ctx = await m.buildContext({ folder, conversation: { dir: r.dir } });
  assert.ok(ctx.text.startsWith('<cpm-shared-context>'));
  const again = await m.buildContext({ folder, conversation: { dir: r.dir }, lastHash: ctx.hash });
  assert.equal(again.text, '', 'unchanged context is not re-sent');
  assert.ok(again.skipped);
});

test('proc: Windows shell quoting rejects metacharacters', () => {
  assert.equal(quoteCmdArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.throws(() => quoteCmdArg('a&calc'));
});

test('rename: settings of Codex Projects Management are imported once', async () => {
  const { migrateLegacyDataDir } = await import('../lib/store.mjs');
  const base = tmp();
  const old = path.join(base, 'codex-projects-management'), neu = path.join(base, 'ai-management-app');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'state.json'), '{"folders":{"x":1}}'); fs.writeFileSync(path.join(old, 'instance.json'), '{}');
  assert.equal(migrateLegacyDataDir(neu, {}, 'linux'), old);
  assert.equal(fs.readFileSync(path.join(neu, 'state.json'), 'utf8'), '{"folders":{"x":1}}');
  assert.ok(!fs.existsSync(path.join(neu, 'instance.json')), 'running-instance lock not copied');
  assert.equal(migrateLegacyDataDir(neu, {}, 'linux'), null, 'only once');
});

test('code highlighter never re-matches its own markup and escapes HTML', async () => {
  const { highlightCode } = await import('../public/markdown.js');
  assert.equal(highlightCode('Pixel pitch 3.45 um', 'txt'), 'Pixel pitch <span class="tk-num">3.45</span> um');
  const h = highlightCode('class A: s = "x" # 3 in class', 'py');
  assert.equal((h.match(/<span/g) || []).length, 3, h);
  assert.ok(!highlightCode('<img src=x onerror=alert(1)>', 'js').includes('<img'));
});
