// v3 features: API providers (3 wire formats), Gemini CLI, add-ons, icons, project hub, attachments, quit-on-close.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { pickIconLinks, downloadIcon } from '../lib/icons.mjs';
import { effortsFor } from '../lib/agents/api.mjs';
import { normalizeProvider } from '../lib/providers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-v3-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), work = path.join(root, 'work'), ghome = path.join(root, 'ghome');
for (const d of [codexHome, work, ghome]) fs.mkdirSync(d, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(root, 'none');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.FAKE_NPM_LOG = path.join(root, 'npm.log');
process.env.PATH = `${path.join(here, 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`;
process.env.CPM_NO_EXIT = '1';
process.env.CPM_NO_AUTO_ICONS = '1';
const { createServer } = await import('../server.mjs');

// ---- stub provider endpoints (OpenAI-compatible, Anthropic, Gemini), recording requests
const seen = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : null;
    seen.push({ url: req.url, headers: req.headers, body: j });
    const sse = (events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end(); };
    if (req.url === '/oa/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'mistral-y' }] }));
    if (req.url === '/oa/v1/chat/completions') {
      if (j.reasoning_effort && j.model === 'mistral-y') { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'reasoning_effort not supported' } })); }
      const last = j.messages.at(-1).content;
      const text = Array.isArray(last) ? last.find((c) => c.type === 'text').text : last;
      return sse([{ choices: [{ delta: { content: 'Hello ' } }] }, { choices: [{ delta: { content: `OA:${text}` } }] }, { choices: [], usage: { total_tokens: 12 } }]);
    }
    if (req.url.startsWith('/an/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-z' }] }));
    if (req.url === '/an/v1/messages') return sse([{ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'text_delta', text: `AN:${j.messages.at(-1).content}` } }, { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 4 } }]);
    if (req.url.startsWith('/ge/v1beta/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-q', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }));
    if (req.url.startsWith('/ge/v1beta/models/gemini-q:streamGenerateContent')) return sse([{ candidates: [{ content: { parts: [{ text: `GE:${j.contents.at(-1).parts.at(-1).text}` }] } }], usageMetadata: { totalTokenCount: 9 } }]);
    if (req.url === '/mem/v1/chat/completions') {
      // Answers a memory-update request with one block per listed file (and one file it was not asked for).
      const text = j.messages.at(-1).content;
      const files = text.includes('=== FILE:') ? [...text.split('Files:')[1].matchAll(/^- (.+)$/gm)].map((m) => m[1]) : [];
      const out = files.length ? [...files, '/etc/evil.md'].map((f) => `=== FILE: ${f} ===\nUPDATED ${path.basename(f)}\n=== END FILE ===`).join('\n') : `MEM:${text}`;
      return sse([{ choices: [{ delta: { content: out } }] }]);
    }
    if (req.url === '/slow/v1/chat/completions') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`); return; }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const SB = `http://127.0.0.1:${stub.address().port}`;

let srv, base, events = [];
async function api(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (Array.isArray(j)) { j.status = r.status; return j; }
  return { status: r.status, ...j };
}
const waitFor = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
const fake = () => JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-state.json'), 'utf8'));

before(async () => {
  srv = await createServer({ dataDir, codexHome, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  srv.app.on('event', (e) => events.push(e));
  for (let i = 0; i < 100 && srv.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
});
after(async () => { await srv.shutdown(0); stub.close(); });

test('provider validation', () => {
  assert.throws(() => normalizeProvider({ preset: 'custom', baseUrl: 'http://example.com/v1' }), /https/);
  assert.equal(normalizeProvider({ preset: 'ollama' }).baseUrl, 'http://localhost:11434/v1');
  assert.throws(() => normalizeProvider({ preset: 'azure' }), /service URL/);
  assert.equal(normalizeProvider({ preset: 'omniroute' }, []).id, 'omniroute-local-gateway');
});

async function chat(providerBody, model, text, effort) {
  const p = await api('/api/providers/save', providerBody);
  assert.equal(p.status, 200, p.error);
  assert.ok(p.test.ok, JSON.stringify(p.test));
  const agent = `api-${p.provider.id}`;
  await api('/api/refresh', {});
  const n = await api('/api/conversation/new', { agent, folder: path.join(work, 'Chat', p.provider.id), modelKey: `${agent}:${model}`, effort });
  assert.equal(n.status, 200, n.error);
  events = [];
  const s = await api('/api/conversation/send', { key: n.key, text, modelKey: `${agent}:${model}`, effort });
  assert.equal(s.status, 200, s.error);
  const done = await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  return { key: n.key, done, agent, provider: p.provider };
}

test('OpenAI-compatible provider: key stored as secret, streamed reply, history kept, retry without unsupported effort', async () => {
  const { key, done, provider } = await chat({ preset: 'custom', label: 'Stub OA', baseUrl: `${SB}/oa/v1`, keyName: 'STUB_OA_KEY', key: 'sk-stub-oa' }, 'mistral-y', 'ping', 'high');
  assert.equal(done.status, 'completed');
  const req = seen.filter((r) => r.url === '/oa/v1/chat/completions').at(-1);
  assert.equal(req.headers.authorization, 'Bearer sk-stub-oa');
  assert.equal(req.body.reasoning_effort, undefined, 'retried without reasoning_effort after a 400');
  assert.ok(events.some((e) => e.type === 'item.delta' && e.key === key));
  const c = await api(`/api/conversation?key=${encodeURIComponent(key)}`);
  assert.deepEqual(c.items.map((i) => i.kind), ['user', 'agent']);
  assert.equal(c.items[1].text, 'Hello OA:ping');
  assert.ok(!JSON.stringify(await api('/api/state')).includes('sk-stub-oa'), 'key never exposed');
  assert.equal(provider.keyName, 'STUB_OA_KEY');
  events = [];
  await api('/api/conversation/send', { key, text: 'second' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === key);
  assert.equal(seen.filter((r) => r.url === '/oa/v1/chat/completions').at(-1).body.messages.filter((m) => m.role !== 'system').length, 3, 'history sent');
});

test('Anthropic and Gemini API wire formats', async () => {
  const a = await chat({ preset: 'anthropic', label: 'Stub AN', baseUrl: `${SB}/an`, key: 'ak' }, 'claude-z', 'hi there');
  assert.equal(a.done.status, 'completed');
  const ar = seen.filter((r) => r.url === '/an/v1/messages').at(-1);
  assert.equal(ar.headers['x-api-key'], 'ak'); assert.equal(ar.headers['anthropic-version'], '2023-06-01');
  assert.equal((await api(`/api/conversation?key=${encodeURIComponent(a.key)}`)).items[1].text, 'AN:hi there');
  const g = await chat({ preset: 'google', label: 'Stub GE', baseUrl: `${SB}/ge`, key: 'gk' }, 'gemini-q', 'bonjour');
  assert.equal(g.done.status, 'completed');
  assert.equal(seen.filter((r) => r.url.includes(':streamGenerateContent')).at(-1).headers['x-goog-api-key'], 'gk');
  const models = (await api('/api/state')).models.filter((m) => m.agent === g.agent).map((m) => m.id);
  assert.deepEqual(models, ['gemini-q'], 'only generateContent models listed');
});

test('API chat: shared memory becomes the system prompt with a non-editing header; Stop aborts the stream', async () => {
  const p = await api('/api/providers/save', { preset: 'custom', label: 'Stub Mem', baseUrl: `${SB}/oa/v1`, keyName: '' });
  const agent = `api-${p.provider.id}`;
  const n = await api('/api/conversation/new', { agent, folder: path.join(work, 'Mem3'), modelKey: `${agent}:gpt-x` });
  await api('/api/conversation/memory-setup', { key: n.key, enable: true, instructions: 'Reply in French.' });
  events = [];
  await api('/api/conversation/send', { key: n.key, text: 'go', modelKey: `${agent}:gpt-x` });
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const req = seen.filter((r) => r.url === '/oa/v1/chat/completions').at(-1);
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[0].content, /Reply in French[\s\S]*/);
  assert.match(req.body.messages[0].content, /Suggested memory update/);
  assert.equal(req.body.messages.at(-1).content, 'go', 'user text without the memory block');
  const slow = await api('/api/providers/save', { preset: 'custom', label: 'Slow', baseUrl: `${SB}/slow/v1`, keyName: '', models: ['m'] });
  assert.ok(slow.provider);
  const sa = `api-${slow.provider.id}`;
  const n2 = await api('/api/conversation/new', { agent: sa, folder: path.join(work, 'Slow'), modelKey: `${sa}:m` });
  events = [];
  await api('/api/conversation/send', { key: n2.key, text: 'wait', modelKey: `${sa}:m` });
  await waitFor((e) => e.type === 'item.delta' && e.key === n2.key);
  assert.ok((await api('/api/conversation/stop', { key: n2.key })).stopped);
  assert.equal((await waitFor((e) => e.type === 'turn.completed' && e.key === n2.key)).status, 'interrupted');
});

test('local provider not running gives an actionable message', async () => {
  const r = await api('/api/providers/save', { preset: 'custom', label: 'Down', baseUrl: 'http://127.0.0.1:9/v1', keyName: '' });
  assert.equal(r.test.ok, false);
  assert.match(r.test.error, /not reachable[\s\S]*Start it first/);
});

test('add-ons: catalog, npm install job, MCP connector to Codex, token kept out of files', async () => {
  const cat = await api('/api/addons');
  assert.ok(cat.catalog.find((c) => c.id === 'omniroute').install.npm === 'omniroute');
  assert.ok(!cat.catalog.some((c) => /gemini/i.test(c.id)), 'no Gemini CLI agent');
  events = [];
  const j = await api('/api/addons/install', { id: 'claude-code' });
  const done = await waitFor((e) => e.type === 'job.update' && e.job.id === j.job && e.job.status !== 'running');
  assert.equal(done.job.status, 'done', done.job.log);
  assert.match(fs.readFileSync(process.env.FAKE_NPM_LOG, 'utf8'), /install -g @anthropic-ai\/claude-code/);
  events = [];
  const g = await api('/api/addons/install', { id: 'mcp-github', token: 'ghp_secretTOKEN1234567890' });
  const gd = await waitFor((e) => e.type === 'job.update' && e.job.id === g.job && e.job.status !== 'running');
  assert.equal(gd.job.status, 'done', gd.job.log);
  assert.equal(fake().config.mcp_servers.github.bearer_token_env_var, 'GITHUB_PAT');
  assert.ok(!JSON.stringify(fake().config).includes('ghp_'), 'token not written to config');
  events = [];
  const fsys = await api('/api/addons/install', { id: 'mcp-filesystem' });
  const fd = await waitFor((e) => e.type === 'job.update' && e.job.id === fsys.job && e.job.status !== 'running');
  assert.equal(fd.job.status, 'failed', 'folder required');
  events = [];
  const fs2 = await api('/api/addons/install', { id: 'mcp-filesystem', folder: work });
  await waitFor((e) => e.type === 'job.update' && e.job.id === fs2.job && e.job.status === 'done');
  assert.deepEqual(fake().config.mcp_servers.filesystem.args.at(-1), work);
});

test('icons: link picking, upload, served sandboxed', async () => {
  const links = pickIconLinks('<link rel="icon" href="/a.png" sizes="32x32"><link rel="apple-touch-icon" href="/t.png"><link rel="icon" type="image/svg+xml" href="/i.svg">', 'https://x.test/p');
  assert.deepEqual(links.slice(0, 3), ['https://x.test/i.svg', 'https://x.test/t.png', 'https://x.test/a.png']);
  assert.equal(links.at(-1), 'https://x.test/favicon.ico');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal((await api('/api/icons/upload', { tool: 'git', name: 'git.svg', data: svg })).icons.git, 'git.svg');
  const r = await fetch(`${base}/api/icons/git?token=${srv.token}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await api('/api/icons/upload', { tool: 'git', name: 'x.exe', data: svg })).status, 400);
  assert.equal((await fetch(`${base}/api/icons/git`)).status, 401);
});

test('project hub: overview, files, file preview, and folder boundary', async () => {
  const folder = path.join(work, 'Hub');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# Hub project\nMeasures things.');
  fs.writeFileSync(path.join(folder, 'src', 'main.m'), 'disp(1)');
  await api('/api/conversation/new', { folder });
  const o = await api(`/api/project?folder=${encodeURIComponent(folder)}`);
  assert.equal(o.name, 'Hub'); assert.match(o.readme, /Hub project/); assert.equal(o.conversations.length, 1);
  assert.deepEqual(o.files.entries.map((e) => e.name), ['src', 'README.md']);
  const sub = await api(`/api/project/files?folder=${encodeURIComponent(folder)}&sub=src`);
  assert.equal(sub.entries[0].name, 'main.m');
  assert.equal((await api(`/api/project/file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(path.join(folder, 'src', 'main.m'))}`)).text, 'disp(1)');
  assert.equal((await api(`/api/project/file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent('/etc/passwd')}`)).status, 403);
  assert.equal((await api(`/api/project/files?folder=${encodeURIComponent(folder)}&sub=${encodeURIComponent('../..')}`)).status, 403);
  assert.equal((await api(`/api/project?folder=${encodeURIComponent('/etc')}`)).status, 403);
});

test('attachments: text inlined, image passed as image, arbitrary paths refused', async () => {
  const n = await api('/api/conversation/new', { folder: path.join(work, 'Attach') });
  const t = await api('/api/attachments', { key: n.key, name: 'notes.txt', data: Buffer.from('measured 12.5 mm').toString('base64') });
  const i = await api('/api/attachments', { key: n.key, name: 'shot.png', data: Buffer.from([137, 80, 78, 71, 0, 1]).toString('base64') });
  assert.equal(t.kind, 'text'); assert.equal(i.kind, 'image');
  events = [];
  await api('/api/conversation/send', { key: n.key, text: 'see files', attachments: [t, i, { path: '/etc/passwd', kind: 'text' }] });
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const sent = fake().threads[n.key.split(':')[1]].lastTurnParams.text;
  assert.match(sent, /measured 12\.5 mm/);
  assert.doesNotMatch(sent, /root:/);
});

test('closing the window stops the agents and exits (auto-quit)', async () => {
  process.env.CPM_AUTOQUIT_MS = '300';
  const s2 = await createServer({ dataDir: path.join(root, 'd2'), codexHome: path.join(root, 'c2'), port: 0, autoQuit: true });
  for (let i = 0; i < 100 && s2.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s2.port}/api/events?token=${s2.token}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(s2.app.agents.codex.state, 'stopped', 'agent connection closed');
  await assert.rejects(fetch(`http://127.0.0.1:${s2.port}/api/health`, { headers: { 'x-cpm-token': s2.token } }), 'server exited');
  delete process.env.CPM_AUTOQUIT_MS;
});

test('conversation files: changed, read, attached and memory files; preview limited to the conversation', async () => {
  const folder = path.join(work, 'FilesConv');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes.md'), '# notes');
  fs.writeFileSync(path.join(folder, 'a.txt'), 'hi');
  const n = await api('/api/conversation/new', { folder });
  await api('/api/conversation/memory-setup', { key: n.key, enable: true, context: 'ctx' });
  const att = await api('/api/attachments', { key: n.key, name: 'data.csv', data: Buffer.from('x,y\n1,2').toString('base64') });
  events = [];
  await api('/api/conversation/send', { key: n.key, text: 'please run and edit', attachments: [att] });
  for (const kind of ['command', 'fileChange']) { const r = await waitFor((e) => e.type === 'approval.request' && e.kind === kind && e.key === n.key); await api('/api/conversation/approve', { key: n.key, requestKey: r.requestKey, decision: 'accept' }); }
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  await new Promise((r) => setTimeout(r, 200));
  const f = await api(`/api/conversation/files?key=${encodeURIComponent(n.key)}`);
  assert.deepEqual(f.changed.map((x) => x.path), [path.join(folder, 'a.txt')]);
  assert.ok(f.changed[0].lastDiff.includes('+hi'));
  assert.deepEqual(f.read.map((x) => x.path), [path.join(folder, 'notes.md')]);
  assert.equal(f.attachments[0].name, 'data.csv');
  assert.ok(f.memory.some((m) => m.label === 'CONTEXT.md' && m.loaded));
  assert.ok(['notes.md', 'a.txt', 'CONTEXT.md'].every((n) => f.folder.some((x) => x.rel === n)), 'folder contents listed');
  assert.ok(f.folder.find((x) => x.rel === 'CONTEXT.md').memory);
  assert.equal((await api(`/api/conversation/file?key=${encodeURIComponent(n.key)}&file=${encodeURIComponent(path.join(folder, 'notes.md'))}`)).text, '# notes');
  assert.equal((await api(`/api/conversation/file?key=${encodeURIComponent(n.key)}&file=${encodeURIComponent(att.path)}`)).text, 'x,y\n1,2');
  assert.equal((await api(`/api/conversation/file?key=${encodeURIComponent(n.key)}&file=${encodeURIComponent('/etc/hostname')}`)).status, 403);
});

test('models: refresh asks each account; reasoning levels from provider metadata', async () => {
  const r = await api('/api/models/refresh', {});
  assert.equal(r.results.codex.ok, true);
  assert.deepEqual(r.models.find((m) => m.key === 'codex:gpt-5.5').efforts, ['low', 'medium', 'high', 'xhigh'], 'efforts reported by the Codex account');
  assert.deepEqual(effortsFor({ kind: 'openai' }, { id: 'anthropic/claude-x', params: ['tools', 'reasoning'] }), ['low', 'medium', 'high'], 'OpenRouter metadata');
  assert.deepEqual(effortsFor({ kind: 'openai' }, { id: 'meta/llama', params: ['tools'] }), []);
  assert.deepEqual(effortsFor({ kind: 'gemini' }, { id: 'gemini-x', thinking: true }), ['low', 'medium', 'high']);
  assert.deepEqual(effortsFor({ kind: 'openai' }, { id: 'gpt-5-mini' }), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(effortsFor({ kind: 'openai' }, { id: 'gpt-4o' }), []);
  assert.deepEqual(effortsFor({ kind: 'anthropic' }, { id: 'claude-sonnet-4-6' }), ['low', 'medium', 'high']);
});

test('official icon download prefers the page icon (SVG) and saves it locally', async () => {
  const site = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<html><head><link rel="icon" href="/fav.png" sizes="32x32"><link rel="icon" type="image/svg+xml" href="/logo.svg"></head></html>'); }
    if (req.url === '/logo.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const dir = path.join(root, 'icons-test');
  const r = await downloadIcon('jira', dir, { page: `http://127.0.0.1:${site.address().port}/` });
  assert.equal(r.file, 'jira.svg');
  assert.ok(fs.readFileSync(path.join(dir, 'jira.svg'), 'utf8').startsWith('<svg'));
  site.close();
});


test('Atlassian MCP: Jira OAuth, Bitbucket API token kept in the keychain, live status', async () => {
  const bad = await api('/api/atlassian/connect', { purpose: 'bitbucket', mode: 'oauth' });
  assert.equal(bad.status, 400);
  const bb = await api('/api/atlassian/connect', { purpose: 'bitbucket', mode: 'token', email: 'jack@example.com', token: 'ATATT-secret-123' });
  assert.equal(bb.status, 200, bb.error);
  const cfg = fake().config.mcp_servers['atlassian-bitbucket'];
  assert.equal(cfg.url, 'https://mcp.atlassian.com/v2/mcp');
  assert.deepEqual(cfg.env_http_headers, { Authorization: 'ATLASSIAN_ATLASSIAN_BITBUCKET_AUTH' });
  assert.ok(!JSON.stringify(fake().config).includes('ATATT'), 'token not in config');
  assert.equal(srv.app.agents.codex.extraEnv.ATLASSIAN_ATLASSIAN_BITBUCKET_AUTH, `Basic ${Buffer.from('jack@example.com:ATATT-secret-123').toString('base64')}`);
  assert.equal(bb.connection.state, 'connected');
  const j = await api('/api/atlassian/connect', { purpose: 'jira', mode: 'oauth' });
  assert.equal(j.status, 200, j.error);
  assert.equal(fake().config.mcp_servers.atlassian.url, 'https://mcp.atlassian.com/v1/mcp/authv2');
  const st = await api('/api/mcp/connection?name=atlassian');
  assert.equal(st.ok, true);
});

test('MATLAB MCP: JSON imported as written and connected', async () => {
  const json = JSON.stringify({ mcpServers: { 'matlab': { command: '/opt/mw/matlab-mcp-server', args: ['--matlab-session-mode=existing'] } } });
  const r = await api('/api/matlab/mcp/import', { text: json });
  assert.equal(r.status, 200, r.error);
  assert.deepEqual(fake().config.mcp_servers.matlab, { command: '/opt/mw/matlab-mcp-server', args: ['--matlab-session-mode=existing'], enabled: true });
  assert.equal(r.state, 'connected');
  const c = await api('/api/matlab/mcp/connect', {});
  assert.equal(c.ok, true);
  const info = await api('/api/matlab/mcp');
  assert.equal(info.imported.command, '/opt/mw/matlab-mcp-server');
});

test('MATLAB MCP: entry written by MathWorks setup in Codex is copied as is to Claude Code when the user picks it', async () => {
  // Same shape as setupAgenticToolkit("install") → Codex → Globally: [mcp_servers.matlab] in config.toml.
  const app = srv.app;
  app.s.tools.matlab.mcpEntry = null; app.s.tools.matlab.agents = null;
  const exe = 'C:\\Users\\jack\\.matlab\\agentic-toolkits\\bin\\matlab-mcp-server.exe';
  await app.agents.codex.writeConfig([{ keyPath: 'mcp_servers.matlab', value: { command: exe, args: ['--matlab-session-mode=existing'], env: { MW_X: '1' } }, mergeStrategy: 'replace' }]);
  const before = await api('/api/matlab/mcp');
  assert.equal(before.askAgent, true, 'the agent question is asked until answered');
  assert.deepEqual(before.agents, ['codex']);
  assert.equal(before.sources[0].from, 'codex');
  app.agents.claude.binSetting = path.join(here, 'fixtures', 'fake-claude.mjs');
  try {
    const r = await api('/api/matlab/mcp/connect', { agents: ['codex', 'claude'] });
    assert.equal(r.status, 200, r.error);
    assert.deepEqual(r.agents, ['codex', 'claude']);
    const cj = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
    assert.deepEqual(cj.mcpServers.matlab, { type: 'stdio', command: exe, args: ['--matlab-session-mode=existing'], env: { MW_X: '1' } });
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.notes.some((n) => /Codex: already configured/.test(n)), r.notes.join(' | '));
    assert.equal(fake().config.mcp_servers.matlab.command, exe, 'Codex entry left as MathWorks wrote it');
    const after = await api('/api/matlab/mcp');
    assert.equal(after.askAgent, false);
    assert.ok(after.inClaude && after.inCodex);
    const bad = await api('/api/matlab/mcp/connect', { agents: ['gemini'] });
    assert.equal(bad.status, 400);
  } finally { app.agents.claude.binSetting = null; }
});


test('every N prompts the app asks to update context/instructions; auto update by Codex and by an API chat', async () => {
  await api('/api/settings', { memoryAskEvery: 5, memoryUpdateMode: 'ask' });
  assert.equal((await api('/api/settings', { memoryAskEvery: 3 })).status, 400, 'only 5–10 or never');
  const folder = path.join(work, 'Periodic');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'context.md'), '# Context\nBench A');
  const n = await api('/api/conversation/new', { folder });
  const asks = [];
  for (let i = 1; i <= 5; i++) { events = []; const r = await api('/api/conversation/send', { key: n.key, text: `step ${i}` }); asks.push(r.askMemoryUpdate); await waitFor((e) => e.type === 'turn.completed' && e.key === n.key); }
  assert.deepEqual(asks, [false, false, false, false, true]);
  events = [];
  const u = await api('/api/memory/update', { key: n.key, choice: 'auto' });
  assert.equal(u.status, 200, u.error);
  assert.equal(u.mode, 'agent-edits');
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const sent = fake().threads[n.key.split(':')[1]].lastTurnParams.text;
  assert.match(sent, /Memory update/); assert.ok(sent.includes(path.join(folder, 'context.md')));
  assert.match(sent, /<cpm-shared-context>/, 'current content sent with the request');
  events = []; const after = await api('/api/conversation/send', { key: n.key, text: 'next' });
  assert.equal(after.askMemoryUpdate, false, 'counter restarted'); await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  // API chat: the AI returns the files, the app writes only the requested ones.
  const p = await api('/api/providers/save', { preset: 'custom', label: 'Mem writer', baseUrl: `${SB}/mem/v1`, keyName: '', models: ['m'] });
  const agent = `api-${p.provider.id}`;
  const f2 = path.join(work, 'PeriodicApi'); fs.mkdirSync(f2, { recursive: true });
  const c = await api('/api/conversation/new', { agent, folder: f2, modelKey: `${agent}:m` });
  await api('/api/conversation/memory-setup', { key: c.key, enable: true, context: 'x', instructions: 'y' });
  events = [];
  const u2 = await api('/api/memory/update', { key: c.key, choice: 'auto' });
  assert.equal(u2.mode, 'app-writes');
  const done = await waitFor((e) => e.type === 'memory.updated' && e.key === c.key);
  assert.deepEqual(done.files.map((f) => path.basename(f)).sort(), ['CONTEXT.md', 'INSTRUCTIONS.md']);
  assert.equal(fs.readFileSync(path.join(f2, 'CONTEXT.md'), 'utf8'), 'UPDATED CONTEXT.md\n');
  assert.ok(!fs.existsSync('/etc/evil.md'));
  const r3 = await api('/api/memory/update', { key: c.key, choice: 'later', remember: true });
  assert.equal(r3.choice, 'later');
  await api('/api/settings', { memoryAskEvery: 7 });
});

test('Spec Kit: set up a folder (specify init), phases run natively in Codex, as instructions for API chats, progress from tasks.md', async () => {
  process.env.FAKE_SPECIFY_LOG = path.join(root, 'specify.log');
  const folder = path.join(work, 'SpecProj'); fs.mkdirSync(folder, { recursive: true });
  const conv = await api('/api/conversation/new', { folder });
  let st = await api(`/api/spec?folder=${encodeURIComponent(folder)}`);
  assert.equal(st.initialized, false); assert.equal(st.specifyInstalled, true);
  events = [];
  const j = await api('/api/spec/init', { folder, agent: 'codex' });
  assert.equal(j.status, 200, j.error);
  await waitFor((e) => e.type === 'job.update' && e.job.id === j.job && e.job.status !== 'running');
  assert.match(fs.readFileSync(process.env.FAKE_SPECIFY_LOG, 'utf8'), /^init --here --force --non-interactive --integration codex --ignore-agent-tools --script (sh|ps)$/m);
  st = await api(`/api/spec?folder=${encodeURIComponent(folder)}`);
  assert.equal(st.initialized, true); assert.equal(st.integration, 'codex');
  assert.equal(st.constitution.filled, false, 'template constitution not yet written');
  // Codex conversation: native skill call
  let ph = await api('/api/spec/phase', { key: conv.key, phase: 'specify', args: 'Measure MTF with a slanted edge' });
  assert.equal(ph.text, '$speckit-specify Measure MTF with a slanted edge');
  // API chat in the same folder: the phase instructions themselves, with the input filled in
  const p = await api('/api/providers/save', { preset: 'custom', label: 'Spec API', baseUrl: `${SB}/oa/v1`, keyName: '', models: ['gpt-x'] });
  const apiConv = await api('/api/conversation/new', { agent: `api-${p.provider.id}`, folder, modelKey: `api-${p.provider.id}:gpt-x` });
  ph = await api('/api/spec/phase', { key: apiConv.key, phase: 'specify', args: 'Measure MTF' });
  assert.match(ph.text, /^Spec Kit — specify phase/); assert.match(ph.text, /Measure MTF\n/); assert.doesNotMatch(ph.text, /name: "speckit-specify"/, 'front matter removed');
  assert.equal((await api('/api/spec/phase', { key: conv.key, phase: 'rm -rf' })).status, 400);
  // a feature with tasks: progress and next step
  const feat = path.join(folder, 'specs', '001-mtf'); fs.mkdirSync(feat, { recursive: true });
  fs.writeFileSync(path.join(feat, 'spec.md'), '# Spec'); fs.writeFileSync(path.join(feat, 'plan.md'), '# Plan');
  fs.writeFileSync(path.join(feat, 'tasks.md'), '- [x] T001 a\n- [X] T002 b\n- [ ] T003 c\n');
  st = await api(`/api/spec?folder=${encodeURIComponent(folder)}`);
  assert.deepEqual(st.features[0].progress, { total: 3, done: 2 });
  assert.equal(st.features[0].next, 'implement');
  const hub = await api(`/api/project?folder=${encodeURIComponent(folder)}`);
  assert.equal(hub.spec.features.length, 1);
});

test('Ways of working: Ponytail plugin installed in Codex from its marketplace; REA added as an MCP server', async () => {
  events = [];
  const r = await api('/api/addons/install', { id: 'ponytail', targets: ['codex'] });
  const done = await waitFor((e) => e.type === 'job.update' && e.job.id === r.job && e.job.status !== 'running', 10_000);
  assert.equal(done.job.status, 'done', done.job.log);
  assert.match(done.job.log, /marketplace “ponytail” added/);
  assert.deepEqual(fake().pluginInstalls.at(-1), { marketplacePath: '/plugins/ponytail/marketplace.json', pluginName: 'ponytail' });
  assert.equal((await api('/api/addons')).catalog.find((c) => c.id === 'ponytail').installed, true);
  events = [];
  const r2 = await api('/api/addons/install', { id: 'rea', targets: ['codex'] });
  await waitFor((e) => e.type === 'job.update' && e.job.id === r2.job && e.job.status !== 'running', 10_000);
  assert.deepEqual(fake().config.mcp_servers.rea, { command: 'npx', args: ['-y', 'rea-agents@6.8.0', 'mcp'], enabled: true });
});
