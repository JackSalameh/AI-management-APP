// Small, safe Markdown renderer: HTML is escaped first, then a limited syntax is converted.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

export function highlightCode(code, lang = '') {
  const l = lang.toLowerCase();
  if (l === 'diff' || l === 'patch') return diffHtml(code);
  if (['sh', 'bash', 'console', 'shell', 'powershell', 'ps1', 'cmd'].includes(l)) {
    return code.split('\n').map((line) => /^(\$|>|PS [^>]*>)\s?/.test(line) ? `<span class="tk-prompt">${esc(line)}</span>` : esc(line)).join('\n');
  }
  // Generic: strings, comments, numbers and keywords (works acceptably for JS, Python, MATLAB, TOML, JSON).
  const KW = /\b(function|end|if|else|elseif|for|while|return|const|let|var|def|class|import|from|export|async|await|try|catch|switch|case|break|continue|true|false|null|None|True|False|new|in|of)\b/g;
  return esc(code).split('\n').map((line) => {
    const m = /(^|\s)(%|#|\/\/)(?![{!]).*$/.exec(line);
    let head = m ? line.slice(0, m.index + m[1].length) : line;
    const tail = m ? line.slice(m.index + m[1].length) : '';
    head = head.replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="tk-str">$1</span>')
      .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tk-num">$1</span>')
      .replace(KW, '<span class="tk-kw">$1</span>');
    return head + (tail ? `<span class="tk-com">${tail}</span>` : '');
  }).join('\n');
}

export function diffHtml(diff) {
  return String(diff || '').split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') ? 'd-meta' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('\n');
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<div class="codeblock"><div class="codebar"><span>${esc(fence[2] || 'text')}</span><button class="copy" data-copy>copy</button></div><pre><code>${highlightCode(body.join('\n'), fence[2])}</code></pre></div>`);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { const n = line.match(/^#+/)[0].length; out.push(`<h${n + 2}>${inline(line.slice(n).trim())}</h${n + 2}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) { const b = []; while (i < lines.length && /^\s*>/.test(lines[i])) b.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${renderMarkdown(b.join('\n'))}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]); const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x.replace(/^\[( |x)\]\s/, (_, c) => c === 'x' ? '☑ ' : '☐ '))}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,4}\s|>|\|)/.test(lines[i]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
