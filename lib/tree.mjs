// Builds the Explorer tree from every conversation folder and every folder the user added.
// Roots are drives (D:, C:, /, \\server\share). Below a root, chains of folders that hold nothing
// themselves are collapsed (C: › Users › jack › Projects becomes one node "Users\jack\Projects").
import { splitPath, joinSegments, pathKey, normalizePath } from './paths.mjs';

export function buildTree({ folders = [], conversations = [] }) {
  const roots = new Map();
  const nodeFor = (segs) => {
    let level = roots, node = null;
    const win = /^[A-Za-z]:$/.test(segs[0]) || segs[0].startsWith('\\\\');
    for (let i = 0; i < segs.length; i++) {
      const k = win ? segs[i].toLowerCase() : segs[i];
      if (!level.has(k)) level.set(k, { name: segs[i], path: joinSegments(segs.slice(0, i + 1)), children: new Map(), conversations: [], pinned: false });
      node = level.get(k); level = node.children;
    }
    return node;
  };
  for (const f of folders) { const s = splitPath(f); if (s.length) nodeFor(s).pinned = true; }
  for (const c of conversations) {
    const s = splitPath(c.cwd || '');
    if (!s.length) continue;
    nodeFor(s).conversations.push(c.key);
  }

  const finish = (n, isRoot) => {
    let kids = [...n.children.values()].map((c) => finish(c, false));
    let name = n.name;
    let node = { name, path: n.path, pinned: n.pinned, conversations: n.conversations, children: kids };
    // Collapse empty single-child chains (never the drive root itself).
    while (!isRoot && !node.pinned && node.conversations.length === 0 && node.children.length === 1) {
      const only = node.children[0];
      node = { ...only, name: `${node.name}${sepOf(node.path)}${only.name}` };
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    node.total = node.conversations.length + node.children.reduce((s, c) => s + c.total, 0);
    return node;
  };
  return [...roots.values()].map((r) => finish(r, true)).sort((a, b) => a.name.localeCompare(b.name));
}

function sepOf(p) { return /^[A-Za-z]:|^\\\\/.test(p) ? '\\' : '/'; }

/** Effective working folder of a conversation (user override wins over the folder recorded by the agent). */
export function effectiveCwd(rec) { return normalizePath(rec.cwdOverride || rec.cwd || ''); }

export function convKey(agent, id) { return `${agent}:${id}`; }

export function sameFolder(a, b) { return pathKey(a) === pathKey(b); }
