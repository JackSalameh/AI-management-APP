// A compact TOML 1.0 reader covering what Codex configuration files use:
// comments, bare/quoted/dotted keys, tables, arrays of tables, basic/literal/multi-line strings,
// integers, floats, booleans, dates (kept as strings), arrays and inline tables.
// It is used to read user-supplied model profiles and to validate files before Codex loads them.
// Writing is delegated to Codex itself (config/value/write), which preserves comments.

export class TomlError extends Error {
  constructor(msg, line) { super(`TOML line ${line}: ${msg}`); this.line = line; }
}

export function parseToml(src) {
  const root = {};
  let cur = root;
  let i = 0, line = 1;
  const s = String(src).replace(/^﻿/, '');
  const defined = new Set();

  const peek = () => s[i];
  const err = (m) => { throw new TomlError(m, line); };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const comment = () => { if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++; };
  const eol = () => {
    ws(); comment();
    if (s[i] === '\r') i++;
    if (i < s.length && s[i] !== '\n') err(`Unexpected "${s[i]}"`);
    if (s[i] === '\n') { i++; line++; }
  };
  const wsnl = () => {
    for (;;) {
      ws(); comment();
      if (s[i] === '\r') i++;
      if (s[i] === '\n') { i++; line++; continue; }
      break;
    }
  };

  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (s[i] === '"') parts.push(basicString());
      else if (s[i] === "'") parts.push(literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) err('Expected a key');
        parts.push(m[0]); i += m[0].length;
      }
      ws();
      if (s[i] === '.') { i++; continue; }
      return parts;
    }
  }

  function escape() {
    const c = s[i++];
    const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (c in map) return map[c];
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = s.slice(i, i + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) err('Bad unicode escape');
      i += len; return String.fromCodePoint(parseInt(hex, 16));
    }
    err(`Bad escape \\${c}`);
  }

  function basicString() {
    if (s.startsWith('"""', i)) {
      i += 3; if (s[i] === '\r') i++; if (s[i] === '\n') { i++; line++; }
      let out = '';
      for (;;) {
        if (i >= s.length) err('Unterminated string');
        if (s.startsWith('"""', i)) {
          let q = 3; while (s[i + q] === '"' && q < 5) q++;
          out += '"'.repeat(q - 3); i += q; return out;
        }
        const c = s[i];
        if (c === '\\') {
          i++;
          if (/[ \t\r\n]/.test(s[i])) {
            while (/[ \t\r\n]/.test(s[i])) { if (s[i] === '\n') line++; i++; }
            continue;
          }
          out += escape(); continue;
        }
        if (c === '\n') line++;
        out += c; i++;
      }
    }
    i++;
    let out = '';
    for (;;) {
      const c = s[i];
      if (c === undefined || c === '\n') err('Unterminated string');
      if (c === '"') { i++; return out; }
      if (c === '\\') { i++; out += escape(); continue; }
      out += c; i++;
    }
  }

  function literalString() {
    if (s.startsWith("'''", i)) {
      i += 3; if (s[i] === '\r') i++; if (s[i] === '\n') { i++; line++; }
      const end = s.indexOf("'''", i);
      if (end < 0) err('Unterminated string');
      let e = end; while (s[e + 3] === "'" && e - end < 2) e++;
      const out = s.slice(i, e); line += (out.match(/\n/g) || []).length; i = e + 3; return out;
    }
    i++;
    const end = s.indexOf("'", i);
    const nl = s.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) err('Unterminated string');
    const out = s.slice(i, end); i = end + 1; return out;
  }

  function value() {
    ws();
    const c = s[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++; const arr = [];
      for (;;) {
        wsnl();
        if (s[i] === ']') { i++; return arr; }
        arr.push(value());
        wsnl();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        err('Expected , or ] in array');
      }
    }
    if (c === '{') {
      i++; const obj = {};
      ws();
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        const k = key(); ws();
        if (s[i] !== '=') err('Expected =');
        i++; assign(obj, k, value(), true); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        err('Expected , or } in inline table');
      }
    }
    const rest = s.slice(i);
    let m;
    if ((m = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest))) { i += m[0].length; return m[0] === 'true'; }
    if ((m = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([Zz]|[+-]\d{2}:\d{2})?/.exec(rest)) && !/^\d{4}-\d{2}-\d{2} [^0-9]/.test(rest.slice(0, 12))) { i += m[0].length; return m[0]; }
    if ((m = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?/.exec(rest))) { i += m[0].length; return m[0]; }
    if ((m = /^[+-]?(inf|nan)/.exec(rest))) { i += m[0].length; return m[1] === 'inf' ? (m[0][0] === '-' ? -Infinity : Infinity) : NaN; }
    if ((m = /^0x[0-9A-Fa-f_]+|^0o[0-7_]+|^0b[01_]+/.exec(rest))) { i += m[0].length; return Number(m[0].replace(/_/g, '')); }
    if ((m = /^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?/.exec(rest))) { i += m[0].length; return Number(m[0].replace(/_/g, '')); }
    err(`Invalid value starting with "${rest.slice(0, 12)}"`);
  }

  function assign(obj, keys, val, inline = false) {
    let o = obj;
    for (let k = 0; k < keys.length - 1; k++) {
      if (!(keys[k] in o)) o[keys[k]] = {};
      else if (typeof o[keys[k]] !== 'object' || Array.isArray(o[keys[k]])) err(`Key "${keys[k]}" is not a table`);
      o = o[keys[k]];
    }
    const last = keys[keys.length - 1];
    if (Object.prototype.hasOwnProperty.call(o, last)) err(`Duplicate key "${keys.join('.')}"`);
    o[last] = val;
    void inline;
  }

  function tablePath(keys, isArray) {
    let o = root;
    for (let k = 0; k < keys.length; k++) {
      const name = keys[k];
      const lastKey = k === keys.length - 1;
      if (lastKey && isArray) {
        if (!(name in o)) o[name] = [];
        if (!Array.isArray(o[name])) err(`"${keys.join('.')}" is not an array of tables`);
        const t = {}; o[name].push(t); return t;
      }
      if (!(name in o)) o[name] = {};
      let next = o[name];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== 'object' || next === null) err(`"${keys.slice(0, k + 1).join('.')}" is not a table`);
      o = next;
    }
    const id = keys.join('\u0000');
    if (defined.has(id)) err(`Table [${keys.join('.')}] defined twice`);
    defined.add(id);
    return o;
  }

  while (i < s.length) {
    wsnl();
    if (i >= s.length) break;
    if (s[i] === '[') {
      const isArray = s[i + 1] === '[';
      i += isArray ? 2 : 1;
      const k = key();
      if (isArray ? !s.startsWith(']]', i) : s[i] !== ']') err('Unclosed table header');
      i += isArray ? 2 : 1;
      cur = tablePath(k, isArray);
      eol();
      continue;
    }
    const k = key(); ws();
    if (s[i] !== '=') err('Expected = after key');
    i++;
    assign(cur, k, value());
    eol();
  }
  return root;
}

/** Flattens a parsed TOML object into [keyPath, value] pairs, stopping at arrays and at `stopAt` prefixes. */
export function flattenToml(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const kp = prefix ? `${prefix}.${tomlKey(k)}` : tomlKey(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenToml(v, kp, out);
    else out.push([kp, v]);
  }
  return out;
}

export function tomlKey(k) { return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k); }

/** Serialises a flat-ish object as TOML (used only for exports and tests). */
export function stringifyToml(obj) {
  const lines = [];
  const scalar = (v) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return '[' + v.map(scalar).join(', ') + ']';
    if (v && typeof v === 'object') return '{ ' + Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${scalar(x)}`).join(', ') + ' }';
    return '""';
  };
  const walk = (o, pfx) => {
    const tables = [];
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) tables.push([k, v]);
      else lines.push(`${tomlKey(k)} = ${scalar(v)}`);
    }
    for (const [k, v] of tables) {
      const name = pfx ? `${pfx}.${tomlKey(k)}` : tomlKey(k);
      lines.push('', `[${name}]`);
      walk(v, name);
    }
  };
  walk(obj, '');
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}

/** Detects literal secrets in a parsed config so the UI can warn before importing. */
export function findInlineSecrets(obj) {
  const hits = [];
  for (const [k, v] of flattenToml(obj)) {
    if (typeof v !== 'string') continue;
    if (/(api[_-]?key|token|secret|password)$/i.test(k) && !/env/i.test(k)) hits.push(k);
    else if (/^(sk-|xox[abp]-|ghp_|github_pat_|ATATT)/.test(v)) hits.push(k);
  }
  return hits;
}
