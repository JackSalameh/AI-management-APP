// Single source of truth for product identity (the UI reads it from /api/state; also update <title> in public/index.html).
export const BRAND = Object.freeze({
  name: 'AI Management APP',
  shortName: 'AIM',
  slug: 'ai-management-app',
  dataDirName: { win32: 'AIManagementApp', darwin: 'AIManagementApp', other: 'ai-management-app' },
  // Data folders of earlier versions, migrated automatically on first start.
  legacyDataDirNames: { win32: ['CodexProjectsManagement'], darwin: ['CodexProjectsManagement'], other: ['codex-projects-management'] },
  author: 'Jack Salameh',
  copyright: '© 2026 Jack Salameh. All rights reserved.',
  version: '3.0.0',
});
