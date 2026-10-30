// Original stroke icons (24×24 grid). Tool icons are generic glyphs, not vendor logos:
// to show official logos, place vscode.svg, matlab.svg, git.svg, bitbucket.svg, jira.svg in public/logos/ (see README).
const P = {
  logo: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m8.5 10 2.5 2-2.5 2"/><path d="M13 14.5h3"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  folderOpen: '<path d="M3 17.5v-11A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10"/><path d="M3 17.5 5.6 11h16l-2.8 7H4.5A1.5 1.5 0 0 1 3 17.5z"/>',
  folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 10.5v5M9.5 13h5"/>',
  drive: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01M11 12h6"/>',
  chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/>',
  chatPlus: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z"/><path d="M12 8.5v5M9.5 11h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  send: '<path d="M4 12 20 4l-5.5 16-3-6.5z"/><path d="m11.5 13.5 3-3"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/><circle cx="12" cy="12" r="7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sidebarOpen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m13 10 2 2-2 2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5h6V7"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V8"/><path d="M10 12h4"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
  file: '<path d="M6 3h8l4 4v13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V3.5A.5.5 0 0 1 6 3z"/><path d="M14 3v4h4"/>',
  fileText: '<path d="M6 3h8l4 4v13.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V3.5A.5.5 0 0 1 6 3z"/><path d="M14 3v4h4M9 12h6M9 15.5h6"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  tool: '<path d="M14.5 6.5a4 4 0 0 0 5 5L15 16l-7 4-4-4 4-7z"/><path d="m8.5 15.5 3-3"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2"/>',
  puzzle: '<path d="M10 4h4v2.5a1.5 1.5 0 0 0 3 0V4h3v6h-2.5a1.5 1.5 0 0 0 0 3H20v7h-6v-2.5a1.5 1.5 0 0 0-3 0V20H4v-6h2.5a1.5 1.5 0 0 0 0-3H4V4h6z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.5 2.8 15.5 0 18M12 3c-2.8 2.5-2.8 15.5 0 18"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3.5A.5.5 0 0 0 4.5 20h15a.5.5 0 0 0 .5-.5V16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3.5a.5.5 0 0 0 .5.5h15a.5.5 0 0 0 .5-.5V16"/>',
  // Git operations
  branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6 3.5-11 7"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  push: '<path d="M12 19V7M7 12l5-5 5 5"/><path d="M5 4h14"/>',
  pull: '<path d="M12 5v12M7 12l5 5 5-5"/><path d="M5 20h14"/>',
  fetch: '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 18h14"/><path d="M5 18v2M19 18v2"/>',
  merge: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7.5v9M6 7.5c0 3 3.5 4.5 10 4.5"/>',
  pr: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="18.5" r="2"/><path d="M6 7.5v9M18 16.5V9a2 2 0 0 0-2-2h-4"/><path d="m14 4.5-2.5 2.5L14 9.5"/>',
  rebase: '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="17" cy="18.5" r="2"/><path d="M7 7.5v2.5M9 12c5 0 8 2 8 4.5"/>',
  stash: '<rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 13V9h8v4M12 3v7M9.5 7.5 12 10l2.5-2.5"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8L21 12l-8.5 8.5z"/><circle cx="8" cy="8" r="1.5"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  // Tool glyphs (generic, not vendor marks)
  vscode: '<path d="m16.5 3.5 4 2v13l-4 2L6 11.5"/><path d="M16.5 3.5 6 13.5l-2.5-2 13-8z"/><path d="M16.5 20.5v-17"/>',
  matlab: '<path d="M3 17c3-1 5-8 8-11 2 3 4 10 10 12"/><path d="M3 17c2 1 4 0 6-3"/>',
  git: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2" transform="rotate(45 12 12)"/><circle cx="12" cy="8" r="1.4"/><circle cx="12" cy="16" r="1.4"/><circle cx="15.5" cy="12" r="1.4"/><path d="M12 9.4v5.2M13.1 9.1l1.6 1.8"/>',
  bitbucket: '<path d="M3.5 4.5h17l-2.5 15h-12z"/><path d="m9.5 10 1 5h3l1-5z"/>',
  jira: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M12 8.5 15.5 12 12 15.5 8.5 12z"/>',
  bot: '<rect x="4.5" y="7.5" width="15" height="11" rx="3"/><path d="M12 4v3.5M9 12.5h.01M15 12.5h.01M9.5 15.5h5"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.info}</svg>`;
}

/** Official logos are optional: `public/logos/<tool>.svg` replaces the generic glyph when present. */
let logoFiles = [];
export function setLogos(list) { logoFiles = Array.isArray(list) ? list : []; }
export async function toolIcon(tool) {
  const f = logoFiles.find((x) => x.replace(/\.(svg|png)$/i, '').toLowerCase() === tool);
  return f ? `<img class="ic logo" src="logos/${encodeURIComponent(f)}" alt="">` : icon(tool);
}

export const FLAGS = {
  en: '<svg viewBox="0 0 30 20" class="flag"><rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0 0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0 0 20" stroke="#C8102E" stroke-width="1.6"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#C8102E" stroke-width="3.4"/></svg>',
  fr: '<svg viewBox="0 0 30 20" class="flag"><rect width="10" height="20" fill="#0055A4"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#EF4135"/></svg>',
  es: '<svg viewBox="0 0 30 20" class="flag"><rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/></svg>',
  de: '<svg viewBox="0 0 30 20" class="flag"><rect width="30" height="7" fill="#000"/><rect y="6.6" width="30" height="6.8" fill="#DD0000"/><rect y="13.3" width="30" height="6.7" fill="#FFCE00"/></svg>',
};
