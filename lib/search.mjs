// Full-text search across conversation titles, transcripts (agent rollout files) and memory files.
// Each file's extracted text is cached by (path, mtime, size) so repeated searches are fast.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { splitUserText } from './items.mjs';

const cache = new Map(); // file -> { mtimeMs, size, messages: [{ role, text }] }
const MAX_FILE = 64 * 1024 * 1024;

/** Extracts readable messages from a Codex rollout (.jsonl) or Claude Code session file. */
export async function extractMessages(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.messages;
  if (st.size > MAX_FILE) return [];
  const raw = await fsp.readFile(file, 'utf8');
  const messages = [];
  const seen = new Set();
  const push = (role, text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const clean = role === 'user' ? splitUserText(text).prompt : text;
    const k = role + '\u0000' + clean.slice(0, 200);
    if (!clean.trim() || seen.has(k)) return;
    seen.add(k); messages.push({ role, text: clean });
  };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || o;
    if (p.type === 'message' && Array.isArray(p.content)) {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'agent' : null;
      if (role) push(role, p.content.map((c) => c.text || '').join('\n'));
    } else if (p.type === 'user_message') push('user', p.message);
    else if (p.type === 'agent_message') push('agent', p.message);
    else if (o.type === 'user' && o.message) push('user', typeof o.message.content === 'string' ? o.message.content : (o.message.content || []).map((c) => c.text || '').join('\n'));
    else if (o.type === 'assistant' && o.message) push('agent', (o.message.content || []).map((c) => c.text || '').join('\n'));
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, messages });
  return messages;
}

function snippet(text, idx, len) {
  const a = Math.max(0, idx - 60), b = Math.min(text.length, idx + len + 100);
  return (a ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

/**
 * sources: [{ key, title, cwd, updatedAt, rollout, memoryFiles: [path] }]
 * Terms are AND-ed; matching is case- and accent-insensitive.
 */
export async function search(sources, query, { limit = 80 } = {}) {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const terms = norm(String(query || '')).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matchAt = (text) => { const n = norm(text); if (!terms.every((t) => n.includes(t))) return -1; return n.indexOf(terms[0]); };
  const results = [];
  for (const s of sources) {
    let i = matchAt(s.title || '');
    if (i >= 0) results.push({ key: s.key, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt, kind: 'title', snippet: s.title, score: 3 });
    if (s.rollout && fs.existsSync(s.rollout)) {
      const msgs = await extractMessages(s.rollout);
      let count = 0;
      for (let m = msgs.length - 1; m >= 0 && count < 3; m--) {
        i = matchAt(msgs[m].text);
        if (i >= 0) { results.push({ key: s.key, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt, kind: msgs[m].role, snippet: snippet(msgs[m].text, i, terms[0].length), match: terms[0], score: 2 }); count++; }
      }
    }
    for (const f of s.memoryFiles || []) {
      let txt; try { txt = await fsp.readFile(f, 'utf8'); } catch { continue; }
      i = matchAt(txt);
      if (i >= 0) results.push({ key: s.key || null, title: s.title, cwd: s.cwd, updatedAt: s.updatedAt, kind: 'memory', file: f, fileName: path.basename(f), snippet: snippet(txt, i, terms[0].length), score: 1 });
    }
    if (results.length > limit * 3) break;
  }
  // Same memory file can be reached from several conversations: keep the first.
  const seenFiles = new Set();
  return results.filter((r) => !r.file || (!seenFiles.has(r.file) && seenFiles.add(r.file)))
    .sort((a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
}
