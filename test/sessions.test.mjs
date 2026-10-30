// 3.5: every Claude Code / Codex session on the computer is found, imported and given its own folder;
// CONTEXT.md / INSTRUCTIONS.md are created next to the session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSessions, safeFolderName, claudeProjectDir, importTarget } from '../lib/sessions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-sessions-'));
const dataDir = path.join(root, 'data'), codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude'), work = path.join(root, 'work');
const xdg = path.join(root, 'xdg'), sessionsRoot = path.join(root, 'D-Claude'), old = path.join(root, 'old');
for (const d of [codexHome, claudeHome, work, xdg, path.join(work, 'App'), path.join(work, 'Old')]) fs.mkdirSync(d, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(here, 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(root, 'none');
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.env.XDG_CONFIG_HOME = xdg; // the Claude desktop app's data folder on Linux: $XDG_CONFIG_HOME/Claude
process.env.CPM_NO_EXIT = '1'; process.env.CPM_NO_AUTO_ICONS = '1'; process.env.CPM_NO_BROWSER = '1';
const { createServer } = await import('../server.mjs');

const U1 = '11111111-aaaa-4bbb-8ccc-000000000001', U2 = '22222222-aaaa-4bbb-8ccc-000000000002', C1 = '019a0000-1111-7222-8333-000000000003';
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const claudeRows = (id, cwd, prompt, answer) => [
  { type: 'user', sessionId: id, cwd, uuid: `${id}-u`, timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: prompt } },
  { type: 'assistant', sessionId: id, cwd, uuid: `${id}-a`, timestamp: '2026-10-01T09:00:05Z', message: { id: `${id}-m`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
];
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// 1. A session of the Claude desktop app (recorded in its virtual machine: the folder does not exist here).
const desk = path.join(xdg, 'Claude', 'local-agent-mode-sessions', 'acc', 'org');
write(path.join(desk, 'local_abc', '.claude', 'projects', '-sessions-vm', `${U1}.jsonl`), jsonl(claudeRows(U1, '/sessions/vm-only', 'Plan the release', 'Here is the plan.')));
write(path.join(desk, 'local_abc.json'), JSON.stringify({ title: 'Release planning' }));
// 2. A session folder made by hand in the sessions folder (like D:\Claude\AImanagementAPPDevelopment), with its memory.
const devDir = path.join(sessionsRoot, 'AImanagementAPPDevelopment');
write(path.join(devDir, `${U2}.jsonl`), jsonl(claudeRows(U2, '/cloud-session/home', 'Build the app', 'Done.')));
write(path.join(devDir, 'session.json'), JSON.stringify({ agent: 'claude', id: U2, title: 'AImanagementAPPDevelopment', cwd: path.join(work, 'App') }));
write(path.join(devDir, 'CONTEXT.md'), '# Context\nThe app lives next to this folder.\n');
write(path.join(devDir, 'INSTRUCTIONS.md'), '# Instructions\nAnswer in a structured way.\n');
// 3. A Codex rollout in a backup folder the user adds, and a decoy inside node_modules.
const rollout = (id, cwd, prompt) => jsonl([
  { timestamp: '2026-09-01T10:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-09-01T10:00:00Z', cwd, originator: 'codex_cli_rs', cli_version: '0.166.0' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'Old answer.' } },
]);
write(path.join(old, 'backup', `rollout-2026-09-01T10-00-00-${C1}.jsonl`), rollout(C1, path.join(work, 'Old'), 'Analyse the MATLAB results'));
write(path.join(old, 'node_modules', 'x', 'rollout-2026-09-01T10-00-00-019a0000-1111-7222-8333-00000000dead.jsonl'), rollout('019a0000-1111-7222-8333-00000000dead', work, 'decoy'));

let srv, base, events = [];
async function api(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-cpm-token': srv.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const waitFor = async (pred, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
const conv = (s, key) => s.conversations.find((c) => c.key === key);

before(async () => {
  srv = await createServer({ dataDir, codexHome, port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  srv.app.on('event', (e) => events.push(e));
  for (let i = 0; i < 100 && srv.app.agents.codex.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 30));
});
after(async () => { await srv.shutdown(0); });

test('folder names, Claude Code project folders and import targets', () => {
  assert.equal(safeFolderName('Plan: v2 / "final"?'), 'Plan v2 final');
  assert.equal(safeFolderName('  ...  '), 'Session');
  assert.equal(safeFolderName('CON'), 'CON session');
  assert.equal(claudeProjectDir('D:\\Claude\\AI Management APP'), 'D--Claude-AI-Management-APP');
  assert.equal(importTarget({ agent: 'codex', file: `/x/rollout-2026-09-01T10-00-00-${C1}.jsonl` }, { codexHome: '/h', claudeHome: '/c' }), path.join('/h', 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${C1}.jsonl`));
});

test('scan: finds Codex and Claude sessions anywhere, skips dependencies, reads titles and session folders', async () => {
  const r = await scanSessions([path.join(xdg, 'Claude'), sessionsRoot, old]);
  const ids = r.sessions.map((s) => `${s.agent}:${s.id}`).sort();
  assert.deepEqual(ids, [`claude:${U1}`, `claude:${U2}`, `codex:${C1}`].sort());
  assert.equal(r.sessions.find((s) => s.id === U1).title, 'Release planning', 'title from the desktop app');
  assert.equal(r.sessions.find((s) => s.id === C1).title, 'Analyse the MATLAB results', 'injected context skipped');
  assert.equal(r.folders.length, 1);
  assert.equal(r.folders[0].dir, devDir);
});

test('sessions folder: import, list, one folder per session, memory next to the session, transcript and copy kept up to date', async () => {
  const info = await api('/api/sessions');
  assert.equal(info.root, '');
  assert.ok(info.sources.some((s) => s.label === 'Claude desktop app'));
  assert.equal((await api('/api/sessions', { root: sessionsRoot, scanRoots: [old] })).root, sessionsRoot);
  const r = await api('/api/sessions/scan', {});
  assert.equal(r.status, 200, r.error);
  // The desktop app's folder is searched at start-up already; the sessions folder and the added folder now.
  assert.deepEqual(r.last.imported.map((i) => i.id).sort(), [U2, C1].sort());
  assert.ok(fs.existsSync(path.join(claudeHome, 'projects', '-sessions-vm-only', `${U1}.jsonl`)), 'desktop-app session copied where Claude Code finds it');
  assert.ok(fs.existsSync(path.join(codexHome, 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${C1}.jsonl`)), 'rollout copied where Codex finds it');
  assert.ok(fs.existsSync(path.join(old, 'backup', `rollout-2026-09-01T10-00-00-${C1}.jsonl`)), 'original untouched');
  const s = r.summary;
  assert.equal(conv(s, `claude:${U1}`).title, 'Release planning');
  assert.equal(conv(s, `codex:${C1}`).title, 'Analyse the MATLAB results');
  assert.ok(!s.conversations.some((c) => c.id.endsWith('dead')), 'node_modules skipped');

  // The hand-made folder is linked to its session: title, folder of the app and its memory files.
  const dev = await api(`/api/conversation?key=${encodeURIComponent(`claude:${U2}`)}`);
  assert.equal(dev.record.sessionDir, devDir);
  assert.equal(dev.record.title, 'AImanagementAPPDevelopment');
  assert.equal(dev.record.cwd, path.join(work, 'App'), 'folder of session.json used: the cloud folder does not exist here');
  assert.equal(dev.record.memoryState, 'enabled');
  assert.ok(dev.record.memoryFound.files.some((f) => f.file === path.join(devDir, 'CONTEXT.md')));
  assert.deepEqual(dev.items.map((i) => i.kind), ['user', 'agent']);

  // The desktop-app session gets its own folder, a copy of its file, and runs there (its VM folder does not exist).
  const rel = path.join(sessionsRoot, 'Release planning');
  assert.ok(fs.existsSync(path.join(rel, `${U1}.jsonl`)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(rel, 'session.json'), 'utf8')).id, U1);
  assert.equal(conv(s, `claude:${U1}`).cwd, rel);

  // Codex: one folder; CONTEXT.md / INSTRUCTIONS.md are created next to the session, not in the project folder.
  const cdir = path.join(sessionsRoot, 'Analyse the MATLAB results');
  assert.ok(fs.existsSync(path.join(cdir, 'session.json')));
  const m = await api('/api/conversation/memory-setup', { key: `codex:${C1}`, enable: true, context: 'Results of the test bench.', instructions: 'Use SI units.' });
  assert.equal(m.status, 200, m.error);
  assert.ok(fs.readFileSync(path.join(cdir, 'CONTEXT.md'), 'utf8').includes('Results of the test bench.'));
  assert.ok(fs.existsSync(path.join(cdir, 'INSTRUCTIONS.md')));
  assert.ok(!fs.existsSync(path.join(work, 'Old', 'CONTEXT.md')));
  const open = await api(`/api/conversation?key=${encodeURIComponent(`codex:${C1}`)}`);
  assert.equal(open.record.memoryState, 'enabled');
  assert.deepEqual(open.items.map((i) => i.kind), ['user', 'agent'], 'imported Codex history readable');

  // A new message: the agent receives the memory; afterwards the transcript and the session copy are in the folder.
  events = [];
  const send = await api('/api/conversation/send', { key: `codex:${C1}`, text: 'continue please' });
  assert.equal(send.status, 200, send.error);
  await waitFor((e) => e.type === 'turn.completed' && e.key === `codex:${C1}`);
  await waitFor((e) => e.type === 'conversation.updated' && e.key === `codex:${C1}`);
  const fake = JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-state.json'), 'utf8'));
  const sent = fake.threads[C1].turns.at(-1).items[0].content.map((c) => c.text).join('');
  assert.ok(sent.includes('Results of the test bench.') && sent.includes('Use SI units.'), 'memory of the session folder sent');
  assert.ok(fs.readFileSync(path.join(cdir, 'TRANSCRIPT.md'), 'utf8').includes('continue please'));

  // Scanning again imports nothing and makes no second folder.
  const again = await api('/api/sessions/scan', {});
  assert.deepEqual(again.last.imported, []);
  assert.deepEqual(fs.readdirSync(sessionsRoot).sort(), ['AImanagementAPPDevelopment', 'Analyse the MATLAB results', 'Release planning']);
  assert.equal(again.withFolder, again.total);
});

test('memory files of a session folder can be edited from the app; other files cannot', async () => {
  const f = path.join(devDir, 'CONTEXT.md');
  const r = await api(`/api/memory?file=${encodeURIComponent(f)}`);
  assert.equal(r.status, 200, r.error);
  assert.ok(r.content.includes('next to this folder'));
  const bad = await api(`/api/memory?file=${encodeURIComponent(path.join(devDir, `${U2}.jsonl`))}`);
  assert.equal(bad.status, 400);
});
