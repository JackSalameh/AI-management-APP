// Direct API chat with any provider account: OpenAI-compatible services and gateways (OpenAI, Mistral,
// OpenRouter, DeepSeek, Groq, xAI, Azure, OmniRoute, Ollama, LM Studio…), Anthropic and Google Gemini.
// Replies are streamed. This agent chats; it does not run commands or edit files (use Codex, Claude Code or
// Gemini CLI for that). Conversations are stored locally by TranscriptStore.
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { TranscriptStore } from './transcripts.mjs';
import { normalizePath } from '../paths.mjs';
import { fromAnthropic, fromOpenAI, fromGemini, add as addUsage } from '../usage.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const EFFORT_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32000 };

/** Parses a server-sent-events body into JSON payloads (ignores comments and [DONE]). */
export async function* sse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
    }
  }
}

export class ApiAgent extends EventEmitter {
  constructor(provider, { dataDir, getKey }) {
    super();
    this.provider = provider;
    this.id = `api-${provider.id}`; this.label = provider.label;
    this.capabilities = { files: false, approvals: false };
    this.store = new TranscriptStore(path.join(dataDir, 'chats', this.id));
    this.getKey = getKey;
    this.activeTurns = new Map(); // id -> AbortController
    this.state = 'ready'; this.loaded = new Map();
  }

  status() { return { id: this.id, label: this.label, kind: 'api', provider: this.provider.preset, state: this.provider.enabled === false ? 'stopped' : 'ready', error: null, activeTurns: Object.fromEntries([...this.activeTurns.keys()].map((k) => [k, 'running'])) }; }
  available() { return this.provider.enabled !== false; }
  setEnv() {}
  async start() {}
  async stop() { for (const c of this.activeTurns.values()) c.abort(); this.activeTurns.clear(); }

  async #headers() {
    const p = this.provider;
    const key = p.keyName ? await this.getKey(p.keyName) : null;
    if (p.keyName && !key && !p.keyOptional && p.preset !== 'custom') {
      const e = new Error(`No API key saved for ${p.label}. Add ${p.keyName} in Configuration › Accounts & providers.`); e.code = 'NO_KEY'; throw e;
    }
    const h = { 'content-type': 'application/json' };
    if (p.kind === 'anthropic') { if (key) h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; }
    else if (p.kind === 'gemini') { if (key) h['x-goog-api-key'] = key; }
    else if (key) h[p.authHeader || 'authorization'] = p.authHeader ? key : `Bearer ${key}`;
    if (p.preset === 'openrouter') { h['HTTP-Referer'] = 'https://github.com/'; h['X-Title'] = 'AI Management APP'; }
    return h;
  }

  async #fetch(url, init, timeoutMs = 20_000) {
    let r;
    try { r = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) }); }
    catch (e) {
      if (e.name === 'AbortError' && init.signal?.aborted) throw e;
      const local = /localhost|127\.0\.0\.1/.test(url);
      throw new Error(local ? `${this.label} is not reachable at ${new URL(url).origin}. Start it first (see Add-ons), then retry.` : `${this.label}: network error (${e.cause?.code || e.message})`);
    }
    if (!r.ok) {
      let msg = ''; try { const j = await r.json(); msg = j.error?.message || j.message || JSON.stringify(j).slice(0, 300); } catch { msg = r.statusText; }
      const e = new Error(`${this.label} ${r.status}: ${msg}${r.status === 401 || r.status === 403 ? ' — check the API key.' : ''}`); e.status = r.status; throw e;
    }
    return r;
  }

  /** Models this account can use, read from the provider; effort levels from the provider's metadata when published. */
  async listModels() {
    const p = this.provider;
    let rows = [];
    try {
      const h = await this.#headers();
      if (p.kind === 'gemini') {
        const r = await (await this.#fetch(`${p.baseUrl}/v1beta/models?pageSize=200`, { headers: h }, 10_000)).json();
        rows = (r.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName, thinking: m.thinking }));
      } else if (p.kind === 'anthropic') {
        const r = await (await this.#fetch(`${p.baseUrl}/v1/models?limit=100`, { headers: h }, 10_000)).json();
        rows = (r.data || []).map((m) => ({ id: m.id, label: m.display_name }));
      } else {
        const r = await (await this.#fetch(`${p.baseUrl}/models`, { headers: h }, 10_000)).json();
        rows = (r.data || r.models || []).map((m) => ({ id: m.id || m.name, label: m.name && m.name !== m.id ? m.name : null, params: m.supported_parameters })).filter((m) => m.id);
      }
    } catch (e) { if (!p.models?.length) throw e; }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of p.models || []) if (!byId.has(id)) byId.set(id, { id, typed: true });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((m) => ({
      id: m.id, model: m.id, label: m.label || m.id, efforts: effortsFor(p, m), defaultEffort: null, provider: p.preset, source: m.typed ? 'typed' : 'account', detected: !m.typed,
    }));
  }

  // ---------- conversations ----------
  static toMeta(m, agentId) { return { agent: agentId, id: m.id, title: m.title || '', cwd: normalizePath(m.cwd || ''), createdAt: m.createdAt, updatedAt: m.updatedAt, model: m.model || null, effort: m.effort || null, provider: m.provider || null, rolloutPath: m.file || null, archived: !!m.archived, usage: m.usage || null }; }

  async listConversations({ archived = false, since = 0 } = {}) {
    return (await this.store.list()).filter((m) => !!m.archived === !!archived && (!since || m.updatedAt >= since)).map((m) => ({ ...ApiAgent.toMeta(m, this.id), rolloutPath: this.store.file(m.id) }));
  }

  async readConversation(id) {
    try { const d = await this.store.read(id); return { meta: { ...ApiAgent.toMeta(d.meta, this.id), rolloutPath: this.store.file(id) }, items: d.items, running: this.activeTurns.has(id), pending: [] }; }
    catch { return { meta: null, items: [], running: this.activeTurns.has(id), pending: [] }; }
  }

  async createConversation({ cwd, model, effort }) {
    const d = await this.store.create({ cwd, model, effort, provider: this.provider.preset });
    return { ...ApiAgent.toMeta(d.meta, this.id), rolloutPath: this.store.file(d.meta.id) };
  }

  async send(id, { text, images = [], model, effort }) {
    if (this.activeTurns.has(id)) { const e = new Error('A reply is still running in this conversation.'); e.code = 'BUSY'; throw e; }
    const d = await this.store.read(id);
    model ||= d.meta.model || this.provider.models?.[0];
    if (!model) throw new Error(`Choose a model for ${this.label}.`);
    const turnId = crypto.randomUUID();
    const emit = (e) => this.emit('event', { threadId: id, turnId, ...e });
    const imgs = [];
    for (const p of images) { try { imgs.push({ mime: MIME[path.extname(p).toLowerCase()] || 'image/png', data: (await fsp.readFile(p)).toString('base64'), path: p }); } catch { /* unreadable image skipped */ } }
    const { context, prompt } = splitContext(text);
    const userItem = { id: crypto.randomUUID(), kind: 'user', text: prompt, context, images: imgs.map((i) => i.path), status: 'completed' };
    d.items.push(userItem);
    d.history.push({ role: 'user', text: prompt, images: imgs.map(({ mime, data }) => ({ mime, data })) });
    if (context) d.system = context; // shared memory is sent as the system prompt (kept until it changes)
    d.meta.model = model; d.meta.effort = effort || null; d.meta.updatedAt = Date.now();
    if (!d.meta.title) d.meta.title = prompt.split('\n')[0].slice(0, 80);
    await this.store.save(id);
    const ctrl = new AbortController();
    this.activeTurns.set(id, ctrl);
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: userItem });
    const reply = { id: crypto.randomUUID(), kind: 'agent', text: '', status: 'inProgress' };
    emit({ type: 'item.started', item: { ...reply } });
    (async () => {
      let status = 'completed', error = null, usage = null;
      try {
        for await (const ev of this.#stream(d, model, effort, ctrl.signal)) {
          if (ev.delta) { reply.text += ev.delta; emit({ type: 'item.delta', itemId: reply.id, field: 'text', delta: ev.delta }); }
          if (ev.usage) usage = ev.usage;
        }
      } catch (e) {
        if (ctrl.signal.aborted) status = 'interrupted';
        else { status = 'failed'; error = e.message; }
      }
      reply.status = status === 'completed' ? 'completed' : status;
      if (reply.text) { d.items.push(reply); d.history.push({ role: 'assistant', text: reply.text }); }
      if (error) d.items.push({ id: crypto.randomUUID(), kind: 'error', text: error });
      d.meta.updatedAt = Date.now();
      await this.store.save(id).catch(() => {});
      this.activeTurns.delete(id);
      emit({ type: 'item.completed', item: { ...reply } });
      if (usage) { d.meta.usage = { total: addUsage(d.meta.usage?.total, usage), last: usage }; await this.store.save(id).catch(() => {}); emit({ type: 'usage', usage: { last: usage, contextWindow: null } }); }
      emit({ type: 'turn.completed', status, error });
    })();
    return { turnId };
  }

  async *#stream(d, model, effort, signal) {
    const p = this.provider, h = await this.#headers();
    const sys = d.system || '';
    if (p.kind === 'anthropic') {
      const body = { model, max_tokens: 16000, stream: true, messages: d.history.map((m) => ({ role: m.role, content: m.role === 'user' && m.images?.length ? [...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.text }] : m.text })) };
      if (sys) body.system = sys;
      if (effort && EFFORT_BUDGET[effort]) body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[effort] };
      const r = await this.#postWithFallback(`${p.baseUrl}/v1/messages`, h, body, signal, (b) => { delete b.thinking; });
      let au = {};
      for await (const ev of sse(r.body)) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield { delta: ev.delta.text };
        // input and cache counts arrive in message_start, output in message_delta
        if (ev.type === 'message_start' && ev.message?.usage) au = { ...au, ...ev.message.usage };
        if (ev.type === 'message_delta' && ev.usage) { au = { ...au, ...Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v != null)) }; yield { usage: fromAnthropic(au) }; }
        if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic stream error');
      }
    } else if (p.kind === 'gemini') {
      const body = { contents: d.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [...(m.images || []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: m.text }] })) };
      if (sys) body.systemInstruction = { parts: [{ text: sys }] };
      if (effort && EFFORT_BUDGET[effort]) body.generationConfig = { thinkingConfig: { thinkingBudget: EFFORT_BUDGET[effort] } };
      const r = await this.#postWithFallback(`${p.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, h, body, signal, (b) => { delete b.generationConfig; });
      for await (const ev of sse(r.body)) {
        const parts = ev.candidates?.[0]?.content?.parts || [];
        for (const part of parts) if (part.text && !part.thought) yield { delta: part.text };
        if (ev.usageMetadata?.totalTokenCount) yield { usage: fromGemini(ev.usageMetadata) };
        if (ev.error) throw new Error(ev.error.message);
      }
    } else {
      const messages = [...(sys ? [{ role: 'system', content: sys }] : []), ...d.history.map((m) => ({ role: m.role, content: m.role === 'user' && m.images?.length ? [{ type: 'text', text: m.text }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : m.text }))];
      const body = { model, messages, stream: true, stream_options: { include_usage: true } };
      if (effort) body.reasoning_effort = effort;
      const r = await this.#postWithFallback(`${p.baseUrl}/chat/completions`, h, body, signal, (b) => { delete b.reasoning_effort; delete b.stream_options; });
      for await (const ev of sse(r.body)) {
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) yield { delta };
        if (ev.usage && (ev.usage.prompt_tokens != null || ev.usage.completion_tokens != null)) yield { usage: fromOpenAI(ev.usage) };
        if (ev.error) throw new Error(ev.error.message || 'stream error');
      }
    }
  }

  /** Some models reject optional parameters (reasoning/thinking): retry once without them. */
  async #postWithFallback(url, headers, body, signal, strip) {
    try { return await this.#fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, 600_000); }
    catch (e) {
      const before = JSON.stringify(body); strip(body);
      if (e.status === 400 && JSON.stringify(body) !== before) return this.#fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, 600_000);
      throw e;
    }
  }

  async interrupt(id) { const c = this.activeTurns.get(id); if (!c) return false; c.abort(); return true; }
  respond() { throw new Error('API chats have no approvals.'); }
  pendingFor() { return []; }
  async rename(id, name) { const d = await this.store.read(id); d.meta.title = name; await this.store.save(id); }
  async archive(id) { const d = await this.store.read(id); d.meta.archived = true; await this.store.save(id); }
  async unarchive(id) { const d = await this.store.read(id); d.meta.archived = false; await this.store.save(id); }
  async remove(id) { await this.store.remove(id); }
  async setCwd(id, cwd) { const d = await this.store.read(id); d.meta.cwd = cwd; await this.store.save(id); }
}

/**
 * Reasoning levels per model. Uses the provider's own metadata when it publishes it
 * (OpenRouter supported_parameters, Gemini "thinking"); otherwise the documented model families.
 */
export function effortsFor(p, m) {
  const id = String(m.id).toLowerCase();
  if (Array.isArray(m.params)) return m.params.some((x) => /reasoning/.test(x)) ? ['low', 'medium', 'high'] : [];
  if (p.kind === 'gemini') return m.thinking === true || /gemini-(2\.5|[3-9])/.test(id) ? ['low', 'medium', 'high'] : [];
  if (p.kind === 'anthropic') return /claude-(3-7|(opus|sonnet|haiku)-[4-9]|[4-9])/.test(id) ? ['low', 'medium', 'high'] : [];
  if (/(^|\/)(gpt-5|o\d)/.test(id)) return /gpt-5/.test(id) ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high'];
  if (/deepseek-reasoner|magistral|grok-3-mini|qwq|reason/.test(id)) return ['low', 'medium', 'high'];
  return [];
}

function splitContext(text) {
  const a = text.indexOf('<cpm-shared-context>'), b = text.indexOf('</cpm-shared-context>');
  if (a === 0 && b > 0) return { context: text.slice(a + 20, b).trim(), prompt: text.slice(b + 21).trim() };
  return { context: null, prompt: text };
}
