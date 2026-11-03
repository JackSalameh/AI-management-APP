// Transposed from Codex Projects Management 1.9.5–1.9.6: official Atlassian MCP for Jira and Bitbucket (v2 endpoint,
// browser sign-in for both, per-product tool lists, remote Bitbucket search guidance) and the reconnect fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlassianTools, atlassianSite, atlassianWorkspace, atlassianContext, atlassianAccess, ATLASSIAN_ENDPOINT } from '../lib/atlassianmcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-atl-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), work = path.join(root, 'work');
for (const d of [codexHome, work]) fs.mkdirSync(d, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(root, 'none');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.CPM_NO_EXIT = '1'; process.env.CPM_NO_AUTO_ICONS = '1'; process.env.CPM_NO_BROWSER = '1';
const { createServer, reuseRunning } = await import('../server.mjs');

let srv, base, events = [];
async function api(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const waitFor = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
const fake = () => JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-state.json'), 'utf8'));

before(async () => {
  srv = await createServer({ dataDir, codexHome, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  srv.app.on('event', (e) => events.push(e));
  for (let i = 0; i < 100 && srv.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
});
after(async () => { await srv.shutdown(0); });

test('tool lists, addresses and search guidance', () => {
  const bbRead = atlassianTools('bitbucket', 'read');
  assert.ok(bbRead.includes('searchCode') && bbRead.includes('getBitbucketRepoPullRequestDiff'));
  assert.ok(!bbRead.includes('createBitbucketRepoPullRequest'), 'consultation excludes changes');
  assert.ok(atlassianTools('bitbucket', 'write').includes('mergeBitbucketRepoPullRequest'));
  assert.ok(!atlassianTools('jira', 'write').includes('searchCode'), 'code tools only for Bitbucket');
  assert.equal(atlassianAccess('jira', atlassianTools('jira', 'write')), 'write');
  assert.throws(() => atlassianTools('confluence'));
  assert.equal(atlassianSite('https://acme.atlassian.net/jira/'), 'https://acme.atlassian.net');
  assert.throws(() => atlassianSite('http://acme.atlassian.net'));
  assert.throws(() => atlassianSite('https://evil.example.com'));
  assert.equal(atlassianWorkspace('https://bitbucket.org/acme-team/'), 'https://bitbucket.org/acme-team');
  assert.equal(atlassianWorkspace('acme-team'), 'https://bitbucket.org/acme-team');
  assert.throws(() => atlassianWorkspace('https://bitbucket.org/a/b'));
  const ctx = atlassianContext({ site: 'https://acme.atlassian.net', workspace: 'https://bitbucket.org/acme-team', jira: true, bitbucket: true });
  assert.match(ctx, /Jira site https:\/\/acme\.atlassian\.net; Bitbucket workspace/);
  assert.match(ctx, /namespace set to the workspace slug "acme-team"/);
  assert.match(ctx, /Do not clone repositories/);
  assert.equal(atlassianContext({ site: 'https://acme.atlassian.net', jira: false, bitbucket: false }), '');
});

test('Bitbucket with browser sign-in: v2 endpoint, tool list per access level, guidance sent once to the AI', async () => {
  const r = await api('/api/atlassian/connect', { purpose: 'bitbucket', mode: 'oauth', access: 'read', workspace: 'https://bitbucket.org/acme-team' });
  assert.equal(r.status, 200, r.error);
  let entry = fake().config.mcp_servers['atlassian-bitbucket'];
  assert.equal(entry.url, ATLASSIAN_ENDPOINT);
  assert.ok(entry.enabled_tools.includes('searchCode') && !entry.enabled_tools.includes('createBitbucketRepoPullRequest'));
  assert.equal(entry.env_http_headers, undefined, 'OAuth: no token header');
  // Changes allowed: the list grows; Jira gets its own entry with its own list and the site.
  await api('/api/atlassian/connect', { purpose: 'bitbucket', mode: 'oauth', access: 'write' });
  entry = fake().config.mcp_servers['atlassian-bitbucket'];
  assert.ok(entry.enabled_tools.includes('createBitbucketRepoPullRequest'));
  const j = await api('/api/atlassian/connect', { purpose: 'jira', mode: 'oauth', site: 'https://acme.atlassian.net' });
  assert.equal(j.status, 200, j.error);
  assert.ok(fake().config.mcp_servers.atlassian.enabled_tools.includes('searchJiraIssuesUsingJql'));
  assert.equal((await api('/api/atlassian/connect', { purpose: 'jira', mode: 'oauth', site: 'https://evil.example.com' })).status, 400);

  const n = await api('/api/conversation/new', { agent: 'codex', folder: path.join(work, 'Atl') });
  events = [];
  assert.equal((await api('/api/conversation/send', { key: n.key, text: 'find the motor driver' })).status, 200);
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const first = fake().threads[n.key.split(':')[1]].turns.at(-1).items[0].content.map((c) => c.text).join('');
  assert.match(first, /Jira site https:\/\/acme\.atlassian\.net; Bitbucket workspace https:\/\/bitbucket\.org\/acme-team/);
  assert.match(first, /<cpm-shared-context>/, 'shown as collapsed context, not as the user’s message');
  assert.ok(first.endsWith('find the motor driver'));
  events = [];
  await api('/api/conversation/send', { key: n.key, text: 'and the tests' });
  await waitFor((e) => e.type === 'turn.completed' && e.key === n.key);
  const second = fake().threads[n.key.split(':')[1]].turns.at(-1).items[0].content.map((c) => c.text).join('');
  assert.ok(!second.includes('Atlassian connection targets'), 'not repeated while unchanged');
});

test('bug (reconnect): launching again while Codex is stopped restarts it instead of opening a stopped app', async () => {
  await api('/api/agent/stop', { agent: 'codex' });
  assert.equal(srv.app.agents.codex.state, 'stopped');
  const r = await reuseRunning(dataDir);
  assert.ok(r, 'running instance reused');
  assert.equal(r.restarted, true);
  assert.equal(srv.app.agents.codex.state, 'ready');
  assert.match(r.url, /#t=/);
  // Healthy: reused as is, nothing restarted.
  assert.equal((await reuseRunning(dataDir)).restarted, false);
});
