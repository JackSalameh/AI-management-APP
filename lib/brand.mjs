// Single source of truth for product identity (the UI reads it from /api/state; also update <title> in public/index.html).
export const BRAND = Object.freeze({
  name: 'Codex Projects Management',
  shortName: 'CPM',
  slug: 'codex-projects-management',
  dataDirName: { win32: 'CodexProjectsManagement', darwin: 'CodexProjectsManagement', other: 'codex-projects-management' },
  author: 'Jack Salameh',
  copyright: '© 2026 Jack Salameh. All rights reserved.',
  version: '2.0.0',
});
