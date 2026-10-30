// Folder and conversation memory: CONTEXT.md (facts, decisions, progress) and INSTRUCTIONS.md (agreed rules).
// Location: <folder>/.cpm/… when the folder is writable, otherwise <dataDir>/memory/<hash>/… (bug #8: never blocks Send).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePath, pathKey, baseName, parentPath, isRootPath } from './paths.mjs';
import { CONTEXT_OPEN, CONTEXT_CLOSE } from './items.mjs';

export const MEMORY_DIR = '.cpm';
export const FILES = { context: 'CONTEXT.md', instructions: 'INSTRUCTIONS.md' };

/**
 * Context / instruction files the user keeps in a folder (not in .cpm/), any case, any language variant:
 * context.md, CONTEXT.md, Instructions.md, projet_context.md, Context X1191.md, instructions-codex.md,
 * contexte.md, consignes.md, contexto.md, Anweisungen.md… (.md, .markdown or .txt). "contextual.md" does not match.
 */
export const LOOSE_RE = /(^|[^a-z])(context|contexte|contexto|kontext|instructions?|instrucciones|consignes|anweisungen)(?![a-z])[^\\/]*\.(md|markdown|txt)$/i;
/** Sub-folders of the conversation folder that are also searched (one level). */
export const SUBDIRS_RE = /^(docs?|documentation|context|contexte|memory|memoire|mémoire|notes|ai|\.ai|\.codex|\.claude)$/i;
export const kindOf = (name) => (/instruction|instruccion|consigne|anweisung/i.test(name) ? 'instructions' : 'context');
const MAX_ANCESTORS = 6;

function listLoose(dir) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return es.filter((e) => e.isFile() && LOOSE_RE.test(e.name)).map((e) => path.join(dir, e.name))
    .filter((f) => { try { return fs.statSync(f).size < 2_000_000; } catch { return false; } })
    .sort((x, y) => ((kindOf(path.basename(y)) === 'instructions') - (kindOf(path.basename(x)) === 'instructions')) || x.localeCompare(y));
}

/** Loose context/instruction files of one folder (+ its docs/, context/, memory/… sub-folders), instructions first. Never throws. */
export function looseFiles(folder, { sub = true } = {}) {
  if (!folder) return [];
  const out = listLoose(folder);
  if (sub) {
    let es = []; try { es = fs.readdirSync(folder, { withFileTypes: true }); } catch { /* unreadable */ }
    for (const e of es) if (e.isDirectory() && SUBDIRS_RE.test(e.name)) out.push(...listLoose(path.join(folder, e.name)));
  }
  return out;
}

const MAX_FILE_CHARS = 12_000;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const TEMPLATES = {
  folder: {
    context: (t) => `# Context — ${t}\n\nDurable facts, decisions and progress shared by every conversation in this folder.\n`,
    instructions: (t) => `# Instructions — ${t}\n\nAgreed working rules and preferences for this folder.\n`,
  },
  conversation: {
    context: (t) => `# Context — ${t}\n\nDurable facts, decisions and progress for this conversation.\n`,
    instructions: (t) => `# Instructions — ${t}\n\nAgreed working rules and preferences for this conversation.\n`,
  },
};

export class Memory {
  constructor(dataDir) { this.dataDir = dataDir; }

  fallbackDir(key) { return path.join(this.dataDir, 'memory', hash(key)); }

  /** Directory holding a folder's memory. Prefers an existing location, then the folder itself. */
  folderDir(folder) {
    const f = normalizePath(folder);
    const inside = path.join(f, MEMORY_DIR);
    const fb = this.fallbackDir('folder:' + pathKey(f));
    if (fs.existsSync(path.join(inside, FILES.context))) return { dir: inside, local: true, fallback: fb };
    if (fs.existsSync(path.join(fb, FILES.context))) return { dir: fb, local: false, fallback: fb };
    return { dir: canWrite(f) ? inside : fb, local: canWrite(f), fallback: fb };
  }

  conversationDir(folder, agent, id) {
    const f = normalizePath(folder);
    const sub = path.join('conversations', `${agent}-${id}`);
    const inside = path.join(f, MEMORY_DIR, sub);
    const fb = this.fallbackDir('conv:' + agent + ':' + id);
    if (fs.existsSync(path.join(inside, FILES.context))) return { dir: inside, local: true, fallback: fb };
    if (fs.existsSync(path.join(fb, FILES.context))) return { dir: fb, local: false, fallback: fb };
    return { dir: f && canWrite(f) ? inside : fb, local: !!f && canWrite(f), fallback: fb };
  }

  /** Creates missing files. Returns { dir, files, warnings }. Never throws. */
  async ensure(kind, dirInfo, title, { rollout } = {}) {
    const warnings = [];
    let { dir } = dirInfo;
    const create = async (d) => {
      await fsp.mkdir(d, { recursive: true });
      for (const [k, name] of Object.entries(FILES)) {
        const p = path.join(d, name);
        if (!fs.existsSync(p)) await fsp.writeFile(p, TEMPLATES[kind][k](title), { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      }
    };
    try { await create(dir); } catch (e) {
      warnings.push(`${dir}: ${e.code || e.message}`);
      const fb = dirInfo.fallback;
      if (!fb || fb === dir) return { dir: null, files: {}, warnings };
      try { await create(fb); dir = fb; } catch (e2) { warnings.push(`${fb}: ${e2.code || e2.message}`); return { dir: null, files: {}, warnings }; }
    }
    if (rollout && kind === 'conversation') {
      try { await this.setRolloutComment(path.join(dir, FILES.context), rollout); } catch (e) { warnings.push(e.message); }
    }
    return { dir, files: { context: path.join(dir, FILES.context), instructions: path.join(dir, FILES.instructions) }, warnings };
  }

  /** Line 1 of a conversation CONTEXT.md holds the rollout file name as an HTML comment. */
  async setRolloutComment(file, rollout) {
    const name = path.basename(String(rollout).replace(/\\/g, '/'));
    const line = `<!-- rollout: ${name} -->`;
    let txt = '';
    try { txt = await fsp.readFile(file, 'utf8'); } catch { /* new */ }
    const lines = txt.split('\n');
    if (/^<!--\s*(codex )?rollout:/i.test(lines[0] || '')) { if (lines[0] === line) return; lines[0] = line; } else lines.unshift(line);
    await fsp.writeFile(file, lines.join('\n'));
  }

  async read(file) {
    const st = await fsp.stat(file);
    return { path: file, content: await fsp.readFile(file, 'utf8'), version: String(st.mtimeMs) };
  }

  /** Optimistic concurrency: stale editor content is rejected instead of overwriting newer agent edits. */
  async write(file, content, expectedVersion) {
    if (expectedVersion) {
      try { const st = await fsp.stat(file); if (String(st.mtimeMs) !== String(expectedVersion)) { const e = new Error('The file changed since you opened it (probably updated by the agent). Reload it, then re-apply your edit.'); e.code = 'CONFLICT'; throw e; } } catch (e) { if (e.code === 'CONFLICT') throw e; }
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    return this.read(file);
  }

  /** Folder chain from the outermost ancestor with memory down to `folder` (up to 6 levels above, never a drive root). */
  folderChain(folder) {
    const chain = [normalizePath(folder)];
    let p = parentPath(folder);
    for (let n = 0; p && n < MAX_ANCESTORS && !isRootPath(p); n++, p = parentPath(p)) {
      const d = this.folderDir(p);
      if (fs.existsSync(path.join(d.dir, FILES.context)) || fs.existsSync(path.join(d.dir, FILES.instructions)) || looseFiles(p, { sub: false }).length) chain.unshift(p);
    }
    return chain;
  }

  /**
   * Where the app looks for context/instructions of a folder, and what it found (shown to the user).
   * found: [{ file, folder, kind, current }] — loose files and .cpm memory, outermost folder first.
   */
  discover(folder) {
    const f = normalizePath(folder);
    if (!f) return { searched: [], found: [] };
    const searched = [];
    let p = f;
    for (let n = 0; p && n <= MAX_ANCESTORS && !isRootPath(p); n++, p = parentPath(p)) searched.push(p);
    const found = [];
    for (const d of this.folderChain(f)) {
      const current = pathKey(d) === pathKey(f);
      for (const lf of looseFiles(d, { sub: current })) found.push({ file: lf, folder: d, kind: kindOf(path.basename(lf)), current });
      const md = this.folderDir(d);
      for (const [k, n] of Object.entries(FILES)) { const x = path.join(md.dir, n); if (fs.existsSync(x)) found.push({ file: x, folder: d, kind: k, current }); }
    }
    return { searched, found };
  }

  /**
   * Creates the context/instructions files where the user expects them: CONTEXT.md and INSTRUCTIONS.md
   * directly in the conversation folder (visible, found again next time). If a file of that kind already
   * exists there, the text is appended to it instead. Folder not writable → app data folder (never blocks).
   */
  async createFolderFiles(folder, { title, context, instructions }, fallbackDir) {
    const f = normalizePath(folder);
    const warnings = [];
    const existing = looseFiles(f, { sub: false });
    const target = (kind) => existing.find((x) => kindOf(path.basename(x)) === kind) || path.join(f, kind === 'context' ? FILES.context : FILES.instructions);
    const head = { context: `# Context — ${title || baseName(f)}\n\nDurable facts, decisions and progress.\n`, instructions: `# Instructions — ${title || baseName(f)}\n\nAgreed working rules and preferences.\n` };
    const write = async (dir) => {
      const files = {};
      for (const [kind, body] of [['instructions', instructions], ['context', context]]) {
        const file = dir === f ? target(kind) : path.join(dir, kind === 'context' ? FILES.context : FILES.instructions);
        const text = String(body ?? '').trim();
        if (fs.existsSync(file)) { if (text) await fsp.appendFile(file, `\n\n${text}\n`); }
        else { await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(file, /^#\s/.test(text) ? `${text}\n` : `${head[kind]}${text ? `\n${text}\n` : ''}`, { flag: 'wx' }); }
        files[kind] = file;
      }
      return files;
    };
    try { return { files: await write(f), dir: f, warnings }; }
    catch (e) {
      warnings.push(`${f}: ${e.code || e.message}`);
      if (!fallbackDir) return { files: {}, dir: null, warnings };
      try { return { files: await write(fallbackDir), dir: fallbackDir, warnings }; } catch (e2) { warnings.push(`${fallbackDir}: ${e2.code || e2.message}`); return { files: {}, dir: null, warnings }; }
    }
  }

  /**
   * Lists every memory part that applies to a conversation, in the order it is sent:
   * pinned notes, then folder chain (outermost first), then the conversation, then linked files.
   */
  async collect({ folder, conversation, links = [], exclude = [], pins = [] }) {
    const parts = [], warnings = [];
    const ex = new Set(exclude);
    const add = async (label, file, editable, group) => {
      try {
        let c = await fsp.readFile(file, 'utf8');
        const chars = c.length;
        if (c.length > MAX_FILE_CHARS) c = c.slice(0, MAX_FILE_CHARS) + '\n…(truncated)';
        parts.push({ label, file, group, editable, content: c, chars, tokens: Math.ceil(chars / 4), included: !ex.has(file), truncated: chars > MAX_FILE_CHARS });
      } catch (e) { if (e.code !== 'ENOENT') warnings.push(`${file}: ${e.code}`); }
    };
    const pinText = pins.filter((p) => typeof p === 'string' && p.trim());
    if (pinText.length) { const c = pinText.map((p) => `- ${p.trim()}`).join('\n'); parts.push({ label: 'Pinned notes', file: null, group: 'pins', editable: false, content: c, chars: c.length, tokens: Math.ceil(c.length / 4), included: true }); }
    if (folder) {
      for (const f of this.folderChain(folder)) {
        const d = this.folderDir(f);
        const current = pathKey(f) === pathKey(folder);
        // The user's own files in the folder come first; they are loaded whether or not the app's memory is enabled.
        for (const lf of looseFiles(f, { sub: current })) await add(`Folder "${baseName(f)}" — ${path.basename(lf)}`, lf, current, 'folder');
        await add(`Folder "${baseName(f)}" instructions`, path.join(d.dir, FILES.instructions), current, 'folder');
        await add(`Folder "${baseName(f)}" context`, path.join(d.dir, FILES.context), current, 'folder');
      }
    }
    if (conversation?.dir) {
      await add('This conversation — instructions', path.join(conversation.dir, FILES.instructions), true, 'conversation');
      await add('This conversation — context', path.join(conversation.dir, FILES.context), true, 'conversation');
    }
    for (const l of links) await add(`Linked (read-only): ${l.label}`, l.file, false, 'link');
    return { parts, warnings };
  }

  /**
   * Builds the shared-context block prepended to a message.
   * Unchanged context (same hash as last sent) is skipped to save tokens.
   */
  async buildContext({ folder, conversation, links = [], lastHash, exclude = [], pins = [], canEdit = true }) {
    const { parts, warnings } = await this.collect({ folder, conversation, links, exclude, pins });
    const inc = parts.filter((p) => p.included);
    const editable = inc.filter((p) => p.editable).map((p) => p.file);
    if (!inc.length) return { text: '', hash: null, skipped: false, warnings, editable, parts };
    const body = inc.map((p) => `## ${p.label}${p.file ? `\nFile: ${p.file}` : ''}\n${p.content.trim()}`).join('\n\n');
    const h = hash(body);
    if (h === lastHash) return { text: '', hash: h, skipped: true, warnings, editable, parts };
    const header = canEdit ? [
      'Shared memory for this workspace. Higher-priority instructions and permissions still apply.',
      'Keep these files useful as we work: put agreed rules and preferences in INSTRUCTIONS.md and durable facts, decisions and progress in CONTEXT.md.',
      'Update the editable files listed below with normal file tools when something new is agreed or learned; stay concise, keep user edits and the first-line rollout comment, never store credentials. Linked files are read-only references.',
      `Editable: ${editable.join(' | ') || 'none'}`,
    ].join('\n') : [
      'Shared memory for this workspace (instructions and context written by the user). Follow the instructions and use the context.',
      'You cannot edit these files: when something new is agreed or learned, end your reply with a short “Suggested memory update” section the user can copy into CONTEXT.md or INSTRUCTIONS.md.',
    ].join('\n');
    return { text: `${CONTEXT_OPEN}\n${header}\n\n${body}\n${CONTEXT_CLOSE}\n\n`, hash: h, skipped: false, warnings, editable, parts };
  }

  // ---- snapshots of what was last sent, for "what changed" diffs
  snapshotFile(key) { return path.join(this.dataDir, 'sent', hash(key) + '.json'); }
  async saveSnapshot(key, parts) {
    const data = Object.fromEntries(parts.filter((p) => p.included && p.file).map((p) => [p.file, p.content]));
    try { await fsp.mkdir(path.join(this.dataDir, 'sent'), { recursive: true }); await fsp.writeFile(this.snapshotFile(key), JSON.stringify({ at: Date.now(), files: data })); } catch { /* best effort */ }
  }
  async loadSnapshot(key) { try { return JSON.parse(await fsp.readFile(this.snapshotFile(key), 'utf8')); } catch { return null; } }

  /** Creates conversation memory with user-provided content (setup window). */
  async writeInitial(dirInfo, { title, context, instructions, rollout }) {
    const r = await this.ensure('conversation', dirInfo, title || 'Conversation', { rollout });
    if (!r.dir) return r;
    const put = async (file, body, tmpl) => {
      const text = String(body ?? '').trim() ? (/^#\s/.test(body.trim()) ? body.trim() + '\n' : `${tmpl}\n\n${body.trim()}\n`) : null;
      if (text) await fsp.writeFile(file, text);
    };
    await put(r.files.instructions, instructions, `# Instructions — ${title || 'Conversation'}`);
    await put(r.files.context, context, `# Context — ${title || 'Conversation'}`);
    if (rollout) await this.setRolloutComment(r.files.context, rollout);
    return r;
  }

  /** Writes a folder-local Markdown transcript copy next to the conversation memory. */
  async writeTranscript(dir, markdown) {
    if (!dir) return;
    try { await fsp.writeFile(path.join(dir, 'TRANSCRIPT.md'), markdown); } catch { /* best effort */ }
  }

  async moveConversation(fromDir, toDir) {
    if (!fromDir || !toDir || fromDir === toDir || !fs.existsSync(fromDir)) return;
    await fsp.mkdir(path.dirname(toDir), { recursive: true });
    try { await fsp.rename(fromDir, toDir); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(fromDir, toDir, { recursive: true }); await fsp.rm(fromDir, { recursive: true, force: true });
    }
  }
}

export function canWrite(dir) {
  if (!dir) return false;
  try { fs.accessSync(dir, fs.constants.W_OK); return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** Line diff (LCS) between two texts: [{ op: '=', '+', '-', line }]. Bounded for memory files. */
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n');
  if (A.length * B.length > 4_000_000) return [{ op: '-', line: '(file too large to diff)' }];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: '=', line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: A[i++] });
    else out.push({ op: '+', line: B[j++] });
  }
  while (i < n) out.push({ op: '-', line: A[i++] });
  while (j < m) out.push({ op: '+', line: B[j++] });
  return out;
}
