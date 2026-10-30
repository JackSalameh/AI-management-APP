// 3.5: Claude Code through OmniRoute — ANTHROPIC_BASE_URL (gateway root, no /v1), ANTHROPIC_AUTH_TOKEN (the
// OmniRoute key kept as a secret), ANTHROPIC_MODEL, model discovery; only in the environment of Claude Code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-gw-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), work = path.join(root, 'work');
for (const d of [codexHome, work]) fs.mkdirSync(d, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.CPM_NO_EXIT = '1'; process.env.CPM_NO_AUTO_ICONS = '1'; process.env.CPM_NO_BROWSER = '1';
const { createServer } = await import('../server.mjs');

// Stub OmniRoute: /v1/models needs the Bearer key.
const seen = [];
const omni = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (req.url === '/v1/models') {
    if (req.headers.authorization !== 'Bearer oma_test_key') { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'invalid key' } })); }
    return res.end(JSON.stringify({ data: [{ id: 'glm/glm-5.2' }, { id: 'kmc/kimi-k2.6' }] }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => omni.listen(0, '127.0.0.1', r));
const OMNI = `http://127.0.0.1:${omni.address().port}`;

let srv, base, events = [];
async function api(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

before(async () => {
  srv = await createServer({ dataDir, codexHome, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  srv.app.on('event', (e) => events.push(e));
  for (let i = 0; i < 100 && srv.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
});
after(async () => { await srv.shutdown(0); omni.close(); });

test('connect OmniRoute to Claude Code: switch, test, models, environment of each turn, switch off', async () => {
  // Without OmniRoute the switch explains what to do.
  assert.equal((await api('/api/claude/gateway')).candidates.length, 0);
  assert.equal((await api('/api/claude/gateway', { enabled: true, provider: 'x' })).status, 400);

  const p = await api('/api/providers/save', { preset: 'omniroute', baseUrl: `${OMNI}/v1`, key: 'oma_test_key' });
  assert.equal(p.status, 200, p.error);
  const g0 = await api('/api/claude/gateway');
  assert.equal(g0.candidates[0].baseUrl, OMNI, 'gateway root without /v1');

  const g = await api('/api/claude/gateway', { enabled: true, provider: p.provider.id, model: 'glm/glm-5.2' });
  assert.equal(g.status, 200, g.error);
  assert.deepEqual(g.test, { ok: true, models: 2 });
  assert.equal(g.enabled, true);
  assert.deepEqual(g.models.sort(), ['glm/glm-5.2', 'kmc/kimi-k2.6']);
  assert.equal(seen.at(-1).auth, 'Bearer oma_test_key');

  // No Claude sign-in needed; the key never appears in the state file or the settings.
  const acc = await api('/api/agent/account?agent=claude');
  assert.equal(acc.loggedIn, true); assert.equal(acc.method, 'gateway');
  await srv.app.store.flush();
  const state = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  assert.ok(!state.includes('oma_test_key'), 'key kept as a secret only');

  // A turn: Claude Code receives the gateway variables in its environment, and the model chosen beside Send.
  const n = await api('/api/conversation/new', { agent: 'claude', folder: path.join(work, 'GW'), modelKey: 'claude:kmc/kimi-k2.6' });
  assert.equal(n.status, 200, n.error);
  events = [];
  const s = await api('/api/conversation/send', { key: n.key, text: 'hello gateway', modelKey: 'claude:kmc/kimi-k2.6' });
  assert.equal(s.status, 200, s.error);
  const done = await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  assert.equal(done.status, 'completed', done.error);
  const reply = events.find((e) => e.type === 'item.completed' && e.key === n.key && e.item.kind === 'agent').item.text;
  assert.match(reply, new RegExp(`BASE=${OMNI} TOKEN=oma_test_key MODEL=glm/glm-5.2 ARG=kmc/kimi-k2.6 DISCOVERY=1 IN=hello gateway`));

  // Off: the next turn goes to Anthropic again (no gateway variables).
  const off = await api('/api/claude/gateway', { enabled: false });
  assert.equal(off.enabled, false);
  events = [];
  await api('/api/conversation/send', { key: n.key, text: 'again' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const reply2 = events.find((e) => e.type === 'item.completed' && e.key === n.key && e.item.kind === 'agent').item.text;
  assert.ok(!reply2.includes(OMNI) && reply2.includes('TOKEN=- MODEL=- ') && reply2.includes('DISCOVERY=-'), reply2);
});
