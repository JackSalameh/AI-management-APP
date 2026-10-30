// Path utilities that behave identically for Windows and POSIX paths,
// regardless of the platform the server runs on (so they are testable on Linux).
import path from 'node:path';

const WIN_DRIVE = /^[a-zA-Z]:([\\/]|$)/;
const WIN_UNC = /^[\\/]{2}[^\\/?.]/;

export function isWindowsPath(p) {
  return typeof p === 'string' && (WIN_DRIVE.test(p) || WIN_UNC.test(p) || /^\\\\\?\\/.test(p));
}

/**
 * Canonical display form of a path.
 * - strips the Win32 long-path prefixes `\\?\` and `\\?\UNC\` (bug #1 of v1)
 * - unifies separators, upper-cases the drive letter, removes trailing separators except at a root.
 */
export function normalizePath(input) {
  if (typeof input !== 'string' || !input.trim()) return '';
  let p = input.trim();
  if (p.startsWith('file://')) {
    try { p = decodeURIComponent(new URL(p).pathname); if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); } catch { /* keep */ }
  }
  if (/^\\\\\?\\UNC\\/i.test(p)) p = '\\\\' + p.slice(8);
  else if (/^\\\\\?\\/.test(p) || /^\/\/\?\//.test(p)) p = p.slice(4);
  if (isWindowsPath(p)) {
    p = p.replace(/\//g, '\\');
    const unc = p.startsWith('\\\\');
    if (/^[a-zA-Z]:$/.test(p)) p += '\\';
    p = path.win32.normalize(p);
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    if (/^[A-Z]:$/.test(p)) p += '\\';
    if (p.length > 3 && p.endsWith('\\') && !(unc && p.split('\\').filter(Boolean).length <= 2)) p = p.replace(/\\+$/, '');
    return p;
  }
  p = path.posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Comparison key: Windows paths are case-insensitive. */
export function pathKey(p) {
  const n = normalizePath(p);
  return isWindowsPath(n) ? n.toLowerCase() : n;
}

export function samePath(a, b) { return pathKey(a) === pathKey(b); }

/** Segments: `D:\X1191\Focal` → ['D:', 'X1191', 'Focal']; `/home/a` → ['/', 'home', 'a']; UNC → ['\\\\srv\\share', ...] */
export function splitPath(p) {
  const n = normalizePath(p);
  if (!n) return [];
  if (isWindowsPath(n)) {
    if (n.startsWith('\\\\')) {
      const parts = n.slice(2).split('\\').filter(Boolean);
      return ['\\\\' + parts.slice(0, 2).join('\\'), ...parts.slice(2)];
    }
    const parts = n.split('\\').filter(Boolean);
    return parts;
  }
  return ['/', ...n.split('/').filter(Boolean)];
}

export function joinSegments(segs) {
  if (!segs.length) return '';
  const [head, ...rest] = segs;
  if (head === '/') return '/' + rest.join('/');
  if (/^[A-Za-z]:$/.test(head)) return rest.length ? head + '\\' + rest.join('\\') : head + '\\';
  return rest.length ? head + '\\' + rest.join('\\') : head;
}

export function isRootPath(p) {
  const n = normalizePath(p);
  return n === '/' || /^[A-Z]:\\$/.test(n) || (n.startsWith('\\\\') && splitPath(n).length === 1);
}

export function parentPath(p) {
  const s = splitPath(p);
  return s.length <= 1 ? null : joinSegments(s.slice(0, -1));
}

export function baseName(p) {
  const s = splitPath(p);
  return s.length ? s[s.length - 1] : '';
}

/** True when `child` is `parent` or inside it. */
export function isInside(child, parent) {
  const c = pathKey(child), pa = pathKey(parent);
  if (!c || !pa) return false;
  if (c === pa) return true;
  const sep = isWindowsPath(pa) ? '\\' : '/';
  return c.startsWith(pa.endsWith(sep) ? pa : pa + sep);
}

/** Rebase `p` from `oldRoot` to `newRoot` (used after a folder rename). */
export function rebase(p, oldRoot, newRoot) {
  if (!isInside(p, oldRoot)) return p;
  const tail = splitPath(p).slice(splitPath(oldRoot).length);
  return joinSegments([...splitPath(newRoot), ...tail]);
}

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Validates a single folder/file name portably (Windows rules are the strictest). */
export function validateName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Name is empty';
  if (n.length > 200) return 'Name is too long';
  if (n === '.' || n === '..') return 'Invalid name';
  if (INVALID_NAME.test(n)) return 'Name contains a character not allowed in folder names: < > : " / \\ | ? *';
  if (RESERVED.test(n)) return 'Name is reserved by Windows';
  if (/[. ]$/.test(n)) return 'Name cannot end with a dot or a space';
  return null;
}

/** Converts a normalized path to one usable by the local fs (identity except for `\\?\` already stripped). */
export function toFsPath(p) { return normalizePath(p); }
