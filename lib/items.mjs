// Converts agent-specific transcript items into one display model used by the UI.

export const CONTEXT_OPEN = '<cpm-shared-context>';
export const CONTEXT_CLOSE = '</cpm-shared-context>';
const LEGACY_PREFIX = 'Selected folder and conversation context/instructions.';

/** Splits a user message into the injected shared context and what the user actually typed (bug #9). */
export function splitUserText(text) {
  const t = String(text ?? '');
  const a = t.indexOf(CONTEXT_OPEN), b = t.indexOf(CONTEXT_CLOSE);
  if (a === 0 && b > a) {
    return { context: t.slice(a + CONTEXT_OPEN.length, b).trim(), prompt: t.slice(b + CONTEXT_CLOSE.length).trim() };
  }
  if (t.startsWith(LEGACY_PREFIX)) {
    const cut = t.lastIndexOf('\n\n');
    return cut > 0 ? { context: t.slice(0, cut).trim(), prompt: t.slice(cut).trim() } : { context: t, prompt: '' };
  }
  return { context: null, prompt: t };
}

/** File changes arrive as an array (protocol v2) or as an object keyed by path (older rollouts) — bug #5. */
export function normalizeChanges(changes) {
  if (!changes) return [];
  const one = (p, c) => {
    const kindRaw = c?.kind?.type ?? c?.kind ?? c?.type ?? 'update';
    return {
      path: c?.path ?? p ?? '',
      kind: String(kindRaw),
      movePath: c?.kind?.move_path ?? c?.move_path ?? null,
      diff: c?.diff ?? c?.unified_diff ?? (typeof c?.content === 'string' ? c.content.split('\n').map((l) => '+' + l).join('\n') : ''),
    };
  };
  if (Array.isArray(changes)) return changes.map((c) => one(c?.path, c));
  if (typeof changes === 'object') return Object.entries(changes).map(([p, c]) => one(p, c));
  return [];
}

function userText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'mention' ? `@${c.name}` : c?.type === 'skill' ? `$${c.name}` : '')).filter(Boolean).join('\n');
}

function mcpResultText(result) {
  if (!result) return '';
  const content = result.content || result.structuredContent;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (c?.type ? `[${c.type}]` : JSON.stringify(c))).join('\n');
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

/** Codex `ThreadItem` → display item. */
export function fromCodexItem(it) {
  if (!it || typeof it !== 'object') return null;
  const base = { id: it.id, status: it.status ?? 'completed' };
  switch (it.type) {
    case 'userMessage': {
      const { context, prompt } = splitUserText(userText(it.content));
      const images = (it.content || []).filter((c) => c?.type === 'localImage' || c?.type === 'image').map((c) => c.path || c.url);
      return { ...base, kind: 'user', text: prompt, context, images };
    }
    case 'agentMessage': return { ...base, kind: 'agent', text: it.text ?? '' };
    case 'plan': return { ...base, kind: 'plan', text: it.text ?? '' };
    case 'reasoning': return { ...base, kind: 'reasoning', text: (it.summary || []).join('\n') };
    case 'commandExecution': return {
      ...base, kind: 'command', command: it.command ?? '', cwd: it.cwd ?? '', output: it.aggregatedOutput ?? '',
      exitCode: it.exitCode ?? null, durationMs: it.durationMs ?? null,
      reads: (it.commandActions || []).filter((a) => a?.type === 'read' && a.path).map((a) => a.path),
    };
    case 'fileChange': return { ...base, kind: 'fileChange', changes: normalizeChanges(it.changes) };
    case 'mcpToolCall': return {
      ...base, kind: 'tool', server: it.server, tool: it.tool, args: it.arguments ?? null,
      output: it.error ? (it.error.message || JSON.stringify(it.error)) : mcpResultText(it.result), failed: !!it.error, durationMs: it.durationMs ?? null,
    };
    case 'dynamicToolCall': return {
      ...base, kind: 'tool', server: it.namespace || 'tool', tool: it.tool, args: it.arguments ?? null,
      output: (it.contentItems || []).map((c) => c?.text ?? '').join('\n'), failed: it.success === false,
    };
    case 'webSearch': return { ...base, kind: 'tool', server: 'web', tool: 'search', args: { query: it.query }, output: '' };
    case 'imageView': return { ...base, kind: 'tool', server: 'image', tool: 'view', args: { path: it.path }, output: '' };
    case 'contextCompaction': return { ...base, kind: 'notice', text: 'Conversation history was compacted.' };
    case 'enteredReviewMode': case 'exitedReviewMode': return { ...base, kind: 'notice', text: it.review ?? it.type };
    default: return { ...base, kind: 'other', text: it.type ? `${it.type}` : '' };
  }
}

/** Codex `Turn[]` → flat display list with turn boundaries. */
export function fromCodexTurns(turns) {
  const out = [];
  for (const t of turns || []) {
    for (const it of t.items || []) { const d = fromCodexItem(it); if (d) out.push({ ...d, turnId: t.id }); }
    if (t.status === 'failed' && t.error) out.push({ id: `${t.id}-error`, kind: 'error', text: t.error.message, turnId: t.id });
    if (t.status === 'interrupted') out.push({ id: `${t.id}-int`, kind: 'notice', text: 'Turn interrupted.', turnId: t.id });
  }
  return out;
}

/** Plain-text transcript (for the folder-local transcript copy). */
export function itemsToMarkdown(title, items) {
  const lines = [`# ${title}`, ''];
  for (const it of items) {
    if (it.kind === 'user') lines.push('## You', '', it.text, '');
    else if (it.kind === 'agent') lines.push('## Agent', '', it.text, '');
    else if (it.kind === 'command') lines.push('```console', `$ ${it.command}`, (it.output || '').slice(0, 4000), '```', '');
    else if (it.kind === 'fileChange') lines.push(...it.changes.map((c) => `- ${c.kind}: \`${c.path}\``), '');
    else if (it.kind === 'tool') lines.push(`- tool \`${it.server}.${it.tool}\``, '');
    else if (it.kind === 'error') lines.push(`> Error: ${it.text}`, '');
  }
  return lines.join('\n');
}
