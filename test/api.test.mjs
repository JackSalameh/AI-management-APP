// End-to-end tests: the real server + app core, driving a protocol-faithful fake `codex app-server`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-api-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), work = path.join(root, 'work');
fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(work, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(root, 'no-claude');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude'); // never read the real ~/.claude sessions of the machine running the tests
process.env.CPM_NO_EXIT = '1';
process.env.CPM_NO_AUTO_ICONS = '1';
const { createServer } = await import('../server.mjs');

let srv, base, events = [];
const fake = () => JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-state.json'), 'utf8'));
async function api(p, body, { token = srv.token, host } = {}) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-cpm-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(host ? { host } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (Array.isArray(j)) { j.status = r.status; return j; }
  return { status: r.status, ...j };
}
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout waiting for event');
};

before(async () => {
  srv = await createServer({ dataDir, codexHome, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  const res = await fetch(`${base}/api/events?token=${srv.token}`);
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6))); }
    }
  })().catch(() => {});
  for (let i = 0; i < 100 && srv.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
});
after(async () => { await srv.shutdown(0); });

test('security: token, Host and Origin checks', async () => {
  assert.equal((await api('/api/state', undefined, { token: 'nope' })).status, 401);
  const r = await fetch(`${base}/api/state`, { headers: { 'x-cpm-token': srv.token, origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const ok = await fetch(`${base}/api/health`, { headers: { 'x-cpm-token': srv.token } });
  assert.equal(ok.status, 200);
  const page = await fetch(`${base}/../server.mjs`);
  assert.notEqual(page.status, 200);
});

let key;
test('new conversation in a new nested folder stays visible before its first message (bug #2)', async () => {
  const folder = path.join(work, 'X1191', 'Distance focal');
  const r = await api('/api/conversation/new', { folder, title: 'Focal study', modelKey: 'codex:gpt-6.1-sol', effort: 'medium' });
  assert.equal(r.status, 200, r.error);
  key = r.key;
  assert.ok(fs.existsSync(folder), 'folder created');
  await api('/api/refresh', {});
  const st = await api('/api/state');
  const c = st.conversations.find((x) => x.key === key);
  assert.ok(c, 'listed after refresh');
  assert.equal(c.title, 'Focal study');
  const memDir = path.join(folder, '.cpm', 'conversations', `codex-${key.split(':')[1]}`);
  assert.ok(!fs.existsSync(memDir), 'no memory files until the user agrees');
  const open = await api(`/api/conversation?key=${encodeURIComponent(key)}`);
  assert.equal(open.record.memoryState, 'ask');
  // Setup window: rename + context + instructions in separate boxes.
  const setup = await api('/api/conversation/memory-setup', { key, enable: true, title: 'Focal study v2', context: 'Lens: 25 mm C-mount.', instructions: 'Answer in French. Use SI units.' });
  assert.equal(setup.status, 200, setup.error);
  assert.match(fs.readFileSync(path.join(memDir, 'CONTEXT.md'), 'utf8'), /25 mm C-mount/);
  assert.match(fs.readFileSync(path.join(memDir, 'INSTRUCTIONS.md'), 'utf8'), /^# Instructions — Focal study v2[\s\S]*SI units/);
  assert.ok(!fs.existsSync(path.join(folder, '.cpm', 'CONTEXT.md')), 'folder memory is not created implicitly');
  assert.equal((await api('/api/state')).conversations.find((x) => x.key === key).title, 'Focal study v2');
});

test('effort is validated per model; Send waits for config write (bugs #3, #10)', async () => {
  const bad = await api('/api/conversation/send', { key, text: 'hello', modelKey: 'codex:gpt-5.5', effort: 'ultra' });
  assert.equal(bad.status, 400); assert.match(bad.error, /not available/);
  events = [];
  const r = await api('/api/conversation/send', { key, text: 'hello there', modelKey: 'codex:gpt-5.5', effort: 'high' });
  assert.equal(r.status, 200, r.error);
  assert.ok(r.contextSent, 'first turn carries shared memory');
  const done = await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.equal(done.status, 'completed');
  const st = fake();
  const writes = st.writes.flat();
  assert.ok(writes.some((w) => w.keyPath === 'model_reasoning_effort' && w.value === 'high'));
  assert.ok(writes.some((w) => w.keyPath === 'model' && w.value === 'gpt-5.5'));
  const t = st.threads[key.split(':')[1]];
  assert.equal(t.lastTurnParams.effort, 'high');
  assert.equal(t.lastTurnParams.model, 'gpt-5.5');
  assert.match(t.lastTurnParams.text, /<cpm-shared-context>/);
  assert.ok(events.some((e) => e.type === 'item.delta' && e.field === 'text'), 'streamed reply');
  // Second turn: memory unchanged → not re-sent (token saving).
  await new Promise((r) => setTimeout(r, 100));
  events = [];
  const r2 = await api('/api/conversation/send', { key, text: 'again', modelKey: 'codex:gpt-5.5', effort: 'high' });
  assert.equal(r2.contextSent, false);
  await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.doesNotMatch(fake().threads[key.split(':')[1]].lastTurnParams.text, /cpm-shared-context/);
});

test('conversation view: user prompt shown without injected context, rollout name, transcript copy', async () => {
  await new Promise((r) => setTimeout(r, 150));
  const c = await api(`/api/conversation?key=${encodeURIComponent(key)}`);
  const users = c.items.filter((i) => i.kind === 'user');
  assert.equal(users[0].text, 'hello there');
  assert.ok(users[0].context.length > 0);
  assert.ok(c.record.rolloutName?.startsWith('rollout-'));
  const ctx = fs.readFileSync(c.memory.conversation.context, 'utf8');
  assert.match(ctx.split('\n')[0], /^<!-- rollout: rollout-/);
  assert.ok(fs.existsSync(path.join(path.dirname(c.memory.conversation.context), 'TRANSCRIPT.md')));
});

test('approvals: command and file change requests reach the UI and the decision reaches Codex', async () => {
  events = [];
  await api('/api/conversation/send', { key, text: 'please run and edit', actionMode: 'ask' });
  const req = await waitFor((e) => e.type === 'approval.request' && e.kind === 'command');
  const pending = await api(`/api/conversation?key=${encodeURIComponent(key)}`);
  assert.equal(pending.pending.length, 1, 'pending approval visible after reload');
  assert.equal((await api('/api/conversation/approve', { key, requestKey: req.requestKey, decision: 'accept' })).status, 200);
  const fc = await waitFor((e) => e.type === 'approval.request' && e.kind === 'fileChange');
  await api('/api/conversation/approve', { key, requestKey: fc.requestKey, decision: 'decline' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  assert.equal(items.find((i) => i.kind === 'command').output, 'hello\n');
  assert.equal(items.find((i) => i.kind === 'fileChange').status, 'declined');
  assert.equal(fake().threads[key.split(':')[1]].lastTurnParams.approvalPolicy, 'untrusted');
});

test('Stop interrupts a running turn; a second Send while busy is refused', async () => {
  events = [];
  await api('/api/conversation/send', { key, text: 'slow job' });
  await waitFor((e) => e.type === 'turn.started' && e.key === key);
  const busy = await api('/api/conversation/send', { key, text: 'second' });
  assert.equal(busy.status, 409);
  assert.equal(busy.code, 'BUSY');
  assert.ok((await api('/api/conversation/stop', { key })).stopped);
  const done = await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.equal(done.status, 'interrupted');
});

test('writer lock gives an actionable 409 (bug #6)', async () => {
  const s = fake(); const id = key.split(':')[1];
  s.locked = [id]; fs.writeFileSync(path.join(codexHome, 'fake-state.json'), JSON.stringify(s));
  srv.app.agents.codex.loaded.delete(id);
  const r = await api('/api/conversation/send', { key, text: 'x' });
  assert.equal(r.status, 409); assert.equal(r.code, 'WRITER_LOCK'); assert.match(r.error, /another Codex window/);
  const s2 = fake(); s2.locked = []; fs.writeFileSync(path.join(codexHome, 'fake-state.json'), JSON.stringify(s2));
});

test('folder rename on disk re-points conversations and memory; next turn uses the new folder', async () => {
  const from = path.join(work, 'X1191', 'Distance focal');
  const r = await api('/api/folder/rename', { path: from, name: 'Focal length' });
  assert.equal(r.status, 200, r.error);
  const to = path.join(work, 'X1191', 'Focal length');
  assert.ok(fs.existsSync(path.join(to, '.cpm', 'conversations')) && !fs.existsSync(from), 'conversation memory moved with the folder');
  const st = await api('/api/state');
  assert.equal(st.conversations.find((c) => c.key === key).cwd, to);
  events = [];
  await api('/api/conversation/send', { key, text: 'where am I' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.equal(fake().threads[key.split(':')[1]].lastTurnParams.cwd, to);
  assert.equal((await api('/api/folder/rename', { path: to, name: 'bad/name' })).status, 400);
});

test('memory files: link another conversation context, conflicts and path safety', async () => {
  const other = await api('/api/conversation/new', { folder: path.join(work, 'X1191', 'Optics') });
  const cat = await api('/api/memory/catalog');
  const focalCtx = cat.find((m) => m.key === key && m.label.endsWith('CONTEXT.md'));
  assert.ok(focalCtx);
  const head = await api('/api/conversation/new', { folder: path.join(work, 'X1191') });
  const opt = await api('/api/conversation/options', { key: head.key, links: [{ label: 'Focal', file: focalCtx.file }, { label: 'evil', file: '/etc/passwd' }] });
  assert.equal(opt.record.links.length, 1, 'non-memory files rejected');
  events = [];
  await api('/api/conversation/send', { key: head.key, text: 'combine' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === head.key);
  assert.match(fake().threads[head.key.split(':')[1]].lastTurnParams.text, /Linked \(read-only\): Focal/);
  const mem = await api(`/api/memory?file=${encodeURIComponent(focalCtx.file)}`);
  await new Promise((r) => setTimeout(r, 20));
  fs.appendFileSync(focalCtx.file, '\nagent wrote this');
  const conflict = await api('/api/memory', { file: focalCtx.file, content: 'user', version: mem.version });
  assert.equal(conflict.status, 409);
  assert.equal((await api('/api/memory?file=%2Fetc%2Fpasswd')).status, 400);
  assert.ok(other.key);
});

test('folder trash → restore → trash → purge with typed confirmation', async () => {
  const f = path.join(work, 'X1191', 'Optics');
  const t = await api('/api/folder/trash', { path: f });
  assert.equal(t.status, 200, t.error);
  assert.ok(!fs.existsSync(f));
  let st = await api('/api/state');
  assert.ok(!st.tree.flatMap(function walk(n) { return [n.path, ...n.children.flatMap(walk)]; }).includes(f));
  assert.equal((await api('/api/folder/restore', { id: t.id })).status, 200);
  assert.ok(fs.existsSync(f));
  const t2 = await api('/api/folder/trash', { path: f });
  assert.equal((await api('/api/folder/purge', { id: t2.id, confirm: 'wrong' })).status, 400);
  assert.equal((await api('/api/folder/purge', { id: t2.id, confirm: 'Optics' })).status, 200);
  st = await api('/api/state');
  assert.equal(st.trash.length, 0);
});

test('models: import a TOML profile, use it (provider table written), remove it', async () => {
  const toml = 'model = "gpt-5.4"\nmodel_provider = "azure"\nmodel_reasoning_effort = "medium"\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://example.openai.azure.com/openai"\nenv_key = "AZURE_OPENAI_API_KEY"\nwire_api = "responses"\n';
  const r = await api('/api/models/import', { text: toml, label: 'GPT-5.4 Azure' });
  assert.equal(r.status, 200, r.error);
  assert.equal(r.envKey, 'AZURE_OPENAI_API_KEY');
  const mk = `custom:${r.entry.id}`;
  events = [];
  await api('/api/conversation/send', { key, text: 'azure please', modelKey: mk, effort: 'medium' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  const cfg = fake().config;
  assert.equal(cfg.model, 'gpt-5.4'); assert.equal(cfg.model_provider, 'azure');
  assert.equal(cfg.model_providers.azure.env_key, 'AZURE_OPENAI_API_KEY');
  assert.equal(fake().threads[key.split(':')[1]].resumeParams.modelProvider, 'azure', 'thread re-resumed with the new provider');
  assert.equal((await api('/api/models/import', { text: 'nonsense = [' })).status, 400);
  await api('/api/models/remove', { key: mk });
  assert.ok(!(await api('/api/models')).some((m) => m.key === mk));
  await api('/api/models/remove', { key: 'codex:gpt-5.5' });
  assert.ok(!(await api('/api/state')).models.some((m) => m.key === 'codex:gpt-5.5'));
  await api('/api/models/restore', {});
});

test('agent crash mid-turn ends the turn; Reconnect restores service (bug #7)', async () => {
  events = [];
  await api('/api/conversation/send', { key, text: 'crash now' });
  const done = await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.equal(done.status, 'failed');
  await waitFor((e) => e.type === 'agent.status' && e.status.state === 'error');
  const r = await api('/api/agent/restart', { agent: 'codex' });
  assert.equal(r.state, 'ready');
  events = [];
  await api('/api/conversation/send', { key, text: 'back again' });
  assert.equal((await waitFor((e) => e.type === 'turn.completed' && e.key === key)).status, 'completed');
  // Quit stops only the agent: the server keeps answering.
  await api('/api/agent/stop', { agent: 'codex' });
  assert.equal((await api('/api/health')).agents.codex, 'stopped');
  assert.equal((await api('/api/agent/restart', {})).state, 'ready');
});

test('skills: local folder install, global and folder scope', async () => {
  const src = path.join(root, 'skillsrc', 'review-helper');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: review-helper\ndescription: Helps review\n---\nDo reviews.');
  const g = await api('/api/skills/install', { source: path.dirname(src), scope: 'global' });
  assert.equal(g.results[0].status, 'installed');
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'review-helper', 'SKILL.md')));
  const folder = path.join(work, 'X1191');
  const f = await api('/api/skills/install', { source: src, scope: 'folder', folder });
  assert.ok(fs.existsSync(path.join(folder, '.agents', 'skills', 'review-helper', 'SKILL.md')));
  assert.equal(f.results[0].status, 'installed');
  const list = await api(`/api/skills?folder=${encodeURIComponent(folder)}`);
  assert.deepEqual(list.skills.map((s) => s.scope).sort(), ['repo', 'user']);
  assert.equal((await api('/api/skills/install', { source: '/nowhere/x' })).status, 400);
});

test('tools: tickboxes persist; disabled tools refuse to run; git panel on a real repo', async () => {
  await api('/api/tools', { tool: 'vscode', patch: { enabled: false } });
  assert.equal((await api('/api/tools/vscode', { key })).status, 400);
  const j = await api('/api/tools', { tool: 'jira', patch: { enabled: true } });
  assert.match(j.warnings[0], /not configured/);
  const repo = path.join(work, 'X1191');
  const init = await api('/api/git/op', { folder: repo, op: 'init' });
  assert.ok(init.ok);
  const st = await api('/api/git/status', { folder: repo });
  assert.equal(st.repo, true);
  const pr = await api('/api/git/pr', { folder: repo, open: false });
  assert.equal(pr.status, 400); assert.match(pr.error, /no remote/);
  await api('/api/git/op', { folder: repo, op: 'remote-add', args: { name: 'origin', url: 'git@bitbucket.org:jack/cpm.git' } });
  const pr2 = await api('/api/git/pr', { folder: repo, open: false, target: 'main' });
  assert.match(pr2.url, /^https:\/\/bitbucket\.org\/jack\/cpm\/pull-requests\/new\?source=/);
});

test('jira: remote MCP with bearer token keeps the secret out of config', async () => {
  const r = await api('/api/jira/configure', { mode: 'remote', url: 'https://mcp.example.com/v1/mcp', auth: 'bearer', token: 'tok-123' });
  assert.equal(r.status, 200, r.error);
  const cfg = fake().config;
  assert.equal(cfg.mcp_servers.atlassian.bearer_token_env_var, 'JIRA_MCP_TOKEN');
  assert.ok(!JSON.stringify(cfg).includes('tok-123'), 'token not written to config');
  const sec = await api('/api/secrets');
  assert.ok(sec.secrets.some((s) => s.name === 'JIRA_MCP_TOKEN'));
  assert.ok(!JSON.stringify(sec).includes('tok-123'), 'API never returns secret values');
  assert.equal(srv.app.agents.codex.extraEnv.JIRA_MCP_TOKEN, 'tok-123', 'token injected into the agent environment');
  await api('/api/tools', { tool: 'jira', patch: { enabled: false } });
  assert.equal(fake().config.mcp_servers.atlassian.enabled, false, 'tickbox maps to the MCP entry enabled flag');
});

test('archive, unarchive and delete a conversation', async () => {
  assert.equal((await api('/api/conversation/archive', { key })).status, 200);
  let st = await api('/api/state');
  assert.ok(st.conversations.find((c) => c.key === key).archived);
  assert.ok(!JSON.stringify(st.tree).includes(key), 'archived conversations leave the tree');
  await api('/api/conversation/unarchive', { key });
  assert.equal((await api('/api/conversation/delete', { key })).status, 200);
  st = await api('/api/state');
  assert.ok(!st.conversations.some((c) => c.key === key));
});

test('folders: browse, add existing root without mkdir (bug #8), reject invalid names', async () => {
  const l = await api(`/api/fs/list?path=${encodeURIComponent(work)}`);
  assert.ok(l.dirs.some((d) => d.name === 'X1191'));
  assert.ok(!l.dirs.some((d) => d.name === '.cpm'));
  assert.equal((await api('/api/folder/add', { path: '/' })).status, 200);
  assert.equal((await api('/api/folder/new', { parent: work, name: 'CON' })).status, 400);
  assert.equal((await api('/api/folder/new', { parent: work, name: 'New topic' })).status, 200);
  assert.equal((await api('/api/folder/add', { path: path.join(work, 'nope') })).status, 400);
});

test('memory setup can be declined: nothing is created and nothing is asked again', async () => {
  const folder = path.join(work, 'Decline');
  const r = await api('/api/conversation/new', { folder });
  assert.equal((await api('/api/conversation/memory-setup', { key: r.key, enable: false })).memoryState, 'declined');
  events = [];
  await api('/api/conversation/send', { key: r.key, text: 'hi' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === r.key);
  assert.ok(!fs.existsSync(path.join(folder, '.cpm')), 'declined → no .cpm folder at all');
  assert.equal((await api(`/api/conversation?key=${encodeURIComponent(r.key)}`)).record.memoryState, 'declined');
});

test('drafts persist server-side and are cleared by Send (rec. 2)', async () => {
  const r = await api('/api/conversation/new', { folder: path.join(work, 'Drafts') });
  await api('/api/drafts', { key: r.key, text: 'half-written idea' });
  await srv.app.store.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).drafts[r.key], 'half-written idea', 'written to disk');
  assert.equal((await api(`/api/conversation?key=${encodeURIComponent(r.key)}`)).draft, 'half-written idea');
  events = [];
  await api('/api/conversation/send', { key: r.key, text: 'half-written idea' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === r.key);
  assert.equal((await api(`/api/conversation?key=${encodeURIComponent(r.key)}`)).draft, '');
});

test('paged history and incremental refresh (rec. 3)', async () => {
  const r = await api('/api/conversation/new', { folder: path.join(work, 'Paging') });
  for (let i = 0; i < 4; i++) { events = []; await api('/api/conversation/send', { key: r.key, text: `msg ${i}` }); await waitFor((e) => e.type === 'turn.completed' && e.key === r.key); }
  await new Promise((res) => setTimeout(res, 200));
  const c = await api(`/api/conversation?key=${encodeURIComponent(r.key)}&limit=3`);
  assert.equal(c.items.length, 3); assert.equal(c.total, 8); assert.equal(c.offset, 5);
  const older = await api(`/api/conversation/older?key=${encodeURIComponent(r.key)}&before=5&limit=3`);
  assert.equal(older.items.length, 3); assert.equal(older.offset, 2);
  const st = fake(); for (const t of Object.values(st.threads)) if (t.id !== r.key.split(':')[1]) t.updatedAt -= 3600;
  fs.writeFileSync(path.join(codexHome, 'fake-state.json'), JSON.stringify(st));
  const total = (await api('/api/refresh', { full: true })).changed;
  await new Promise((res) => setTimeout(res, 50));
  st.threads[r.key.split(':')[1]].updatedAt = Math.floor(Date.now() / 1000) + 1; fs.writeFileSync(path.join(codexHome, 'fake-state.json'), JSON.stringify(st));
  const inc = await api('/api/refresh', { full: false });
  assert.ok(inc.changed < total, `incremental refresh fetched ${inc.changed} of ${total} threads`);
  assert.ok(inc.conversations.some((x) => x.key === r.key));
});

test('full-text search over messages and memory with folder filter (rec. 4)', async () => {
  const r = await api('/api/conversation/new', { folder: path.join(work, 'Search', 'Thermal') });
  await api('/api/conversation/memory-setup', { key: r.key, enable: true, context: 'Decision: use NTC thermistor 10k Beta 3950.' });
  // the fake writes no rollout file, so give it one in Codex format
  const rollout = path.join(codexHome, 'rollout-search.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<cpm-shared-context>secret memory</cpm-shared-context>\n\nWhich sensor for the oven?' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Prefer a PT100 class A for the oven; résistance stable.' } }),
  ].join('\n'));
  srv.app.s.conversations[r.key].rollout = rollout;
  let res = (await api(`/api/search?q=${encodeURIComponent('pt100 oven')}`)).results;
  assert.ok(res.some((x) => x.key === r.key && x.kind === 'agent' && /PT100/.test(x.snippet)));
  res = (await api(`/api/search?q=${encodeURIComponent('resistance')}`)).results;
  assert.ok(res.some((x) => x.kind === 'agent'), 'accent-insensitive');
  res = (await api(`/api/search?q=${encodeURIComponent('secret memory')}`)).results;
  assert.ok(!res.some((x) => x.kind === 'user'), 'injected context is not searched as a user message ');
  res = (await api(`/api/search?q=thermistor`)).results;
  assert.equal(res[0].kind, 'memory');
  res = (await api(`/api/search?q=thermistor&folder=${encodeURIComponent(path.join(work, 'X1191'))}`)).results;
  assert.equal(res.length, 0, 'folder filter applies');
});

test('context.md / instructions.md already in the folder are loaded, even when app memory is declined', async () => {
  const proj = path.join(work, 'Loose'), sub = path.join(proj, 'Bench');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(proj, 'Context.md'), 'Project: X1191 optical bench.');
  fs.writeFileSync(path.join(sub, 'instructions.md'), 'Always answer with SI units.');
  fs.writeFileSync(path.join(sub, 'bench_context.md'), 'Camera pixel pitch 3.45 um.');
  fs.writeFileSync(path.join(sub, 'notes.md'), 'not a context file');
  const r = await api('/api/conversation/new', { folder: sub });
  await api('/api/conversation/memory-setup', { key: r.key, enable: false });
  const open = await api('/api/conversation?key=' + encodeURIComponent(r.key));
  assert.deepEqual(open.record.folderFiles.map((f) => path.basename(f)), ['instructions.md', 'bench_context.md']);
  const prev = await api('/api/memory/preview?key=' + encodeURIComponent(r.key));
  assert.equal(prev.memoryState, 'declined');
  const s = await api('/api/conversation/send', { key: r.key, text: 'hello bench' });
  assert.equal(s.status, 200, s.error);
  assert.ok(s.contextSent);
  const sent = fake().threads[r.key.split(':')[1]].lastTurnParams.text;
  assert.match(sent, /Always answer with SI units/);
  assert.match(sent, /pixel pitch 3\.45/);
  assert.match(sent, /X1191 optical bench/, 'parent folder file loaded too');
  assert.ok(sent.indexOf('X1191 optical bench') < sent.indexOf('SI units'), 'outermost folder first');
  assert.doesNotMatch(sent, /not a context file/);
  assert.ok(!fs.existsSync(path.join(sub, '.cpm', 'conversations')), 'declined: no conversation files created');
  await waitFor((e) => e.type === 'turn.completed' && e.key === r.key).catch(() => {});
});

test('memory workspace: preview, pins, exclusion and diff since last send (rec. 5)', async () => {
  const folder = path.join(work, 'Mem');
  const r = await api('/api/conversation/new', { folder });
  await api('/api/conversation/memory-setup', { key: r.key, enable: true, context: 'Line A', instructions: 'Be brief.' });
  await api('/api/conversation/options', { key: r.key, pins: ['Budget: 12 k€'] });
  let p = await api(`/api/memory/preview?key=${encodeURIComponent(r.key)}`);
  assert.equal(p.parts[0].group, 'pins');
  assert.ok(p.parts.every((x) => x.changed === 'new' || x.changed === 'pins'));
  assert.ok(p.totalTokens > 0 && p.willSend);
  events = [];
  await api('/api/conversation/send', { key: r.key, text: 'go' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === r.key);
  assert.match(fake().threads[r.key.split(':')[1]].lastTurnParams.text, /Budget: 12 k€/);
  await new Promise((res) => setTimeout(res, 150));
  const ctxFile = p.parts.find((x) => x.label.includes('context') && x.group === 'conversation').file;
  fs.appendFileSync(ctxFile, '\nLine B');
  p = await api(`/api/memory/preview?key=${encodeURIComponent(r.key)}`);
  const changed = p.parts.find((x) => x.file === ctxFile);
  assert.equal(changed.changed, 'changed');
  assert.ok(changed.diff.some((d) => d.op === '+' && d.line === 'Line B'));
  await api('/api/conversation/options', { key: r.key, exclude: [ctxFile] });
  events = [];
  await api('/api/conversation/send', { key: r.key, text: 'again' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === r.key);
  assert.doesNotMatch(fake().threads[r.key.split(':')[1]].lastTurnParams.text, /Line B/, 'excluded file not sent');
});

test('turn acknowledgement reports the model and effort Codex holds (rec. 6)', async () => {
  const r = await api('/api/conversation/new', { folder: path.join(work, 'Ack') });
  events = [];
  await api('/api/conversation/send', { key: r.key, text: 'x', modelKey: 'codex:gpt-5.5', effort: 'high' });
  const ack = await waitFor((e) => e.type === 'turn.ack' && e.key === r.key);
  assert.ok(ack.model);
});

test('integration checks return actionable results (rec. 7)', async () => {
  const g = await api('/api/tools/check?tool=git');
  assert.ok(g.checks.length >= 1 && g.checks[0].name === 'Git');
  const c = await api('/api/tools/check?tool=codex');
  assert.ok(c.checks.some((x) => x.name === 'app-server' && x.ok));
  const j = await api('/api/tools/check?tool=jira');
  assert.ok(j.checks.length);
  for (const t of ['vscode', 'matlab', 'bitbucket']) assert.ok((await api(`/api/tools/check?tool=${t}`)).checks.length, t);
});

test('support: about, backups, restore, redacted diagnostics (rec. 8)', async () => {
  await api('/api/secrets/set', { name: 'TEST_API_KEY', value: 'sk-test-SUPERSECRET-123456' });
  const a = await api('/api/about');
  assert.ok(a.app && a.node);
  const b = await api('/api/backups/create', {});
  assert.match(b.name, /^state-.*-manual\.json$/);
  assert.ok((await api('/api/about')).backups.some((x) => x.name === b.name));
  await api('/api/settings', { theme: 'dark' });
  assert.equal((await api('/api/backups/restore', { name: b.name })).ok, true);
  const d = await api('/api/diagnostics');
  const txt = JSON.stringify(d);
  assert.ok(!txt.includes('SUPERSECRET'), 'secret values never exported');
  assert.ok(d.secrets.names.includes('TEST_API_KEY'), 'names only');
  assert.ok(!txt.includes(os.homedir() + path.sep + 'x') && d.tools.git);
  assert.equal((await api('/api/backups/restore', { name: '../state.json' })).status, 400);
});
