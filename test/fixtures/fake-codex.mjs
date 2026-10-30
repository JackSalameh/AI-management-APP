#!/usr/bin/env node
// Scriptable stand-in for `codex app-server`, following the codex-cli 0.166.0 JSON-RPC protocol.
// State lives in $CODEX_HOME/fake-state.json so tests can inspect config writes and threads.
// Message keywords drive behaviour: "run" → command approval, "edit" → file-change approval,
// "fail" → failed turn, "slow" → long turn (for Stop), "crash" → process exits mid-turn.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

if (process.argv[2] !== 'app-server') { console.log('codex-cli 0.166.0 (fake)'); process.exit(0); }
const HOME = process.env.CODEX_HOME;
const stateFile = path.join(HOME, 'fake-state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { threads: {}, config: {}, writes: [], locked: [] }; } };
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => out({ method, params });
let nextServerReq = 1000; const waiting = new Map();
let lastReq = 0;
const ask = (method, params) => new Promise((r) => { const id = nextServerReq++; lastReq = id; waiting.set(id, r); out({ id, method, params }); });
const now = () => Math.floor(Date.now() / 1000);
const MODELS = [
  { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], def: 'low', isDefault: true },
  { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], def: 'medium', isDefault: false },
];
const threadView = (t, turns = false) => ({ id: t.id, sessionId: t.id, forkedFromId: null, parentThreadId: null, preview: t.preview || '', ephemeral: false, modelProvider: t.provider || 'openai', model: t.model || 'gpt-6.1-sol', reasoningEffort: t.effort || null, createdAt: t.createdAt, updatedAt: t.updatedAt, status: { type: 'idle' }, path: t.turns.length ? path.join(HOME, 'sessions', `rollout-${t.id}.jsonl`) : null, cwd: t.cwd, cliVersion: '0.166.0', source: 'appServer', name: t.name || null, turns: turns ? t.turns : [] });
const active = new Map();
function writeRollout(t) {
  if (!t.turns.length) return;
  const dir = path.join(HOME, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const turn of t.turns) for (const it of turn.items) {
    if (it.type === 'userMessage') lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: it.content.map((c) => ({ type: 'input_text', text: c.text })) } });
    if (it.type === 'agentMessage') lines.push({ type: 'event_msg', payload: { type: 'agent_message', message: it.text } });
  }
  fs.writeFileSync(path.join(dir, `rollout-${t.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function runTurn(threadId, params) {
  const s = load(); const t = s.threads[threadId];
  const full = params.input.map((i) => i.text || '').join('');
  const text = full.replace(/<cpm-shared-context>[\s\S]*<\/cpm-shared-context>\s*/, '');
  const turnId = crypto.randomUUID();
  const turn = { id: turnId, items: [], status: 'inProgress', error: null };
  active.set(threadId, { turnId, interrupted: false });
  notify('turn/started', { threadId, turn: { ...turn } });
  const user = { type: 'userMessage', id: crypto.randomUUID(), clientId: null, content: params.input };
  turn.items.push(user);
  notify('item/completed', { threadId, turnId, item: user });
  if (!t.preview) t.preview = text.slice(0, 80);
  t.lastTurnParams = { cwd: params.cwd, model: params.model, effort: params.effort, approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy, text: full };
  if (/crash/.test(text)) { process.exit(3); }
  if (/run/.test(text)) {
    const cmd = { type: 'commandExecution', id: crypto.randomUUID(), command: 'echo hello', cwd: params.cwd || t.cwd, status: 'inProgress', commandActions: [{ type: 'read', command: 'cat notes.md', name: 'notes.md', path: 'notes.md' }], aggregatedOutput: null, exitCode: null, durationMs: null, source: 'agent', processId: null, pluginId: null, scriptPath: null };
    notify('item/started', { threadId, turnId, item: cmd, startedAtMs: Date.now() });
    const r = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId, turnId, itemId: cmd.id, startedAtMs: Date.now(), command: 'echo hello', cwd: cmd.cwd, reason: 'test' });
    const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
    notify('serverRequest/resolved', { threadId, requestId: lastReq });
    if (ok) notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: cmd.id, delta: 'hello\n' });
    Object.assign(cmd, { status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'hello\n' : '', exitCode: ok ? 0 : null });
    turn.items.push(cmd); notify('item/completed', { threadId, turnId, item: cmd });
  }
  if (/edit/.test(text)) {
    const fc = { type: 'fileChange', id: crypto.randomUUID(), changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+hi' }], status: 'inProgress' };
    notify('item/started', { threadId, turnId, item: fc, startedAtMs: Date.now() });
    const r = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: fc.id, startedAtMs: Date.now(), reason: null });
    fc.status = r.decision === 'accept' ? 'completed' : 'declined';
    turn.items.push(fc); notify('item/completed', { threadId, turnId, item: fc });
  }
  if (/slow/.test(text)) {
    await new Promise((r) => { const iv = setInterval(() => { if (active.get(threadId)?.interrupted) { clearInterval(iv); r(); } }, 20); setTimeout(() => { clearInterval(iv); r(); }, 5000); });
  }
  const msg = { type: 'agentMessage', id: crypto.randomUUID(), text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
  notify('item/started', { threadId, turnId, item: { ...msg }, startedAtMs: Date.now() });
  const reply = `Echo: ${text.slice(-40)}`;
  for (const part of [reply.slice(0, 6), reply.slice(6)]) notify('item/agentMessage/delta', { threadId, turnId, itemId: msg.id, delta: part });
  msg.text = reply; turn.items.push(msg); notify('item/completed', { threadId, turnId, item: msg });
  const interrupted = active.get(threadId)?.interrupted;
  turn.status = /fail/.test(text) ? 'failed' : interrupted ? 'interrupted' : 'completed';
  if (turn.status === 'failed') turn.error = { message: 'Simulated failure', codexErrorInfo: null, additionalDetails: null, misalignment: null };
  active.delete(threadId);
  const s2 = load(); const t2 = s2.threads[threadId];
  t2.turns.push(turn); t2.updatedAt = now(); t2.preview = t.preview; t2.lastTurnParams = t.lastTurnParams;
  save(s2); writeRollout(t2);
  notify('turn/completed', { threadId, turn });
}

const handlers = {
  initialize: () => { for (const t of Object.values(load().threads)) writeRollout(t); return { userAgent: 'cpm/0.166.0 (fake)', codexHome: HOME, platformFamily: 'unix', platformOs: 'linux' }; },
  'thread/start': (p) => { const s = load(); const id = crypto.randomUUID(); s.threads[id] = { id, cwd: p.cwd, model: p.model, provider: p.modelProvider, effort: p.config?.model_reasoning_effort, createdAt: now(), updatedAt: now(), turns: [], archived: false, startParams: p }; save(s); return { thread: threadView(s.threads[id]), model: p.model || 'gpt-6.1-sol', modelProvider: p.modelProvider || 'openai', reasoningEffort: p.config?.model_reasoning_effort || 'low', cwd: p.cwd, approvalPolicy: p.approvalPolicy || 'on-request', sandbox: { type: 'readOnly' }, serviceTier: null, disabledPluginIds: [], instructionSources: [], approvalsReviewer: 'user' }; },
  'thread/list': (p) => { const s = load(); const data = Object.values(s.threads).filter((t) => t.turns.length && !!t.archived === !!p.archived).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => threadView(t)); return { data, nextCursor: null, backwardsCursor: null }; },
  // Mirrors codex-cli 0.166: metadata reads work for empty threads, includeTurns does not.
  'thread/read': (p) => { const t = load().threads[p.threadId]; if (!t) throw { code: -32600, message: `thread ${p.threadId} not found` }; if (p.includeTurns && !t.turns.length) throw { code: -32601, message: 'list_turns is not supported yet' }; return { thread: threadView(t, p.includeTurns) }; },
  'thread/turns/list': (p) => { const t = load().threads[p.threadId]; if (!t) throw { code: -32600, message: 'thread not found' }; const all = p.sortDirection === 'asc' ? t.turns : [...t.turns].reverse(); const start = +(p.cursor || 0); const lim = p.limit || 50; return { data: all.slice(start, start + lim), nextCursor: start + lim < all.length ? String(start + lim) : null, backwardsCursor: null }; },
  'thread/resume': (p) => { const s = load(); if (s.locked.includes(p.threadId)) throw { code: -32600, message: `thread ${p.threadId} already has an active writer` }; const t = s.threads[p.threadId]; if (!t) throw { code: -32600, message: 'thread not found' }; t.resumeParams = p; save(s); return { thread: threadView(t), model: t.model || 'gpt-6.1-sol', modelProvider: p.modelProvider || 'openai', cwd: p.cwd || t.cwd }; },
  'thread/unsubscribe': () => ({}),
  'turn/start': (p) => { const s = load(); if (!s.threads[p.threadId]) throw { code: -32600, message: 'thread not found' }; setImmediate(() => runTurn(p.threadId, p)); return { turn: { id: 'x', items: [], status: 'inProgress', error: null } }; },
  'turn/interrupt': (p) => { const a = active.get(p.threadId); if (a) a.interrupted = true; return {}; },
  'thread/name/set': (p) => { const s = load(); s.threads[p.threadId].name = p.name; save(s); return {}; },
  'thread/archive': (p) => { const s = load(); s.threads[p.threadId].archived = true; save(s); return {}; },
  'thread/unarchive': (p) => { const s = load(); s.threads[p.threadId].archived = false; save(s); return {}; },
  'thread/delete': (p) => { const s = load(); delete s.threads[p.threadId]; save(s); return {}; },
  'model/list': () => ({ data: MODELS.map((m) => ({ id: m.id, model: m.id, displayName: m.id.toUpperCase(), description: '', hidden: false, isDefault: m.isDefault, supportedReasoningEfforts: m.efforts.map((e) => ({ reasoningEffort: e, description: e })), defaultReasoningEffort: m.def })), nextCursor: null }),
  'config/read': () => ({ config: load().config, origins: {}, layers: null }),
  'config/batchWrite': (p) => { const s = load(); for (const e of p.edits) { setPath(s.config, e.keyPath, e.value, e.mergeStrategy); } s.writes.push(p.edits); save(s); return { status: 'ok', version: 'sha256:x', filePath: path.join(HOME, 'config.toml'), overriddenMetadata: null }; },
  'config/value/write': (p) => handlers['config/batchWrite']({ edits: [p] }),
  'config/mcpServer/reload': () => ({}),
  'skills/list': (p) => ({ data: p.cwds.map((cwd) => ({ cwd, skills: listSkills(cwd), errors: [] })) }),
  'mcpServerStatus/list': () => ({ data: [] }),
  'plugin/list': () => ({ marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }),
};

function setPath(obj, keyPath, value, strategy) {
  const keys = keyPath.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) { o[k] ??= {}; o = o[k]; }
  const last = keys.at(-1);
  if (strategy === 'upsert' && value && typeof value === 'object' && o[last] && typeof o[last] === 'object') Object.assign(o[last], value); else o[last] = value;
}
function listSkills(cwd) {
  const out = [];
  for (const [dir, scope] of [[path.join(HOME, 'skills'), 'user'], [path.join(cwd, '.agents', 'skills'), 'repo']]) {
    try { for (const n of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, n, 'SKILL.md'))) out.push({ name: n, description: '', scope, path: path.join(dir, n, 'SKILL.md'), enabled: true }); } catch { /* none */ }
  }
  return out;
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m.result); } return; }
  if (m.id == null) return; // notification (initialized)
  const h = handlers[m.method];
  if (!h) { out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } }); return; }
  try { out({ id: m.id, result: await h(m.params || {}) }); } catch (e) { out({ id: m.id, error: { code: e.code || -32000, message: e.message || String(e) } }); }
});
