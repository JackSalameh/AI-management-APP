#!/usr/bin/env node
// Demo / UI-development mode: runs the real server against the fake Codex in a throwaway sandbox,
// so the interface can be explored or tested without touching real conversations, config or accounts.
// Usage: node scripts/demo.mjs [--open] [--port N] [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-demo-'));
const dataDir = path.join(sandbox, 'data'), codexHome = path.join(sandbox, 'codex'), work = path.join(sandbox, 'Projects');
for (const d of [dataDir, codexHome]) fs.mkdirSync(d, { recursive: true });
process.env.CPM_CODEX_BIN = path.join(root, 'test', 'fixtures', 'fake-codex.mjs');
process.env.CPM_CLAUDE_BIN = path.join(sandbox, 'no-claude');
process.env.CPM_DATA_DIR = dataDir;
process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, 'claude'); // keep the demo away from real Claude Code sessions

// Seed: X1191 › Distance focal (2 conversations), X1191 › Optics, a Git repo, and one MATLAB-like file.
const now = Math.floor(Date.now() / 1000);
const mk = (rel) => { const p = path.join(work, rel); fs.mkdirSync(p, { recursive: true }); return p; };
const focal = mk('X1191/Distance focal'), optics = mk('X1191/Optics'), head = mk('X1191'), repo = mk('Apps/signal-toolbox');
fs.writeFileSync(path.join(repo, 'filter_design.m'), "function y = filter_design(x)\n% Low-pass FIR\nb = fir1(48, 0.35);\ny = filter(b, 1, x);\nend\n");
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=demo@example.com', '-c', 'user.name=Demo', 'commit', '-qm', 'Initial filter'], { cwd: repo });
  fs.appendFileSync(path.join(repo, 'filter_design.m'), '% TODO: window choice\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Signal toolbox\n');
} catch { /* git missing */ }
const turn = (user, agent, extra = []) => ({ id: crypto.randomUUID(), status: 'completed', error: null, items: [
  { type: 'userMessage', id: crypto.randomUUID(), clientId: null, content: [{ type: 'text', text: user, text_elements: [] }] },
  ...extra,
  { type: 'agentMessage', id: crypto.randomUUID(), text: agent, phase: null, memoryCitation: null, delivery: null, questions: null },
] });
const threads = {};
const add = (cwd, name, turns, ago) => { const id = crypto.randomUUID(); threads[id] = { id, cwd, name, preview: turns[0].items[0].content[0].text, model: 'gpt-6.1-sol', effort: 'medium', createdAt: now - ago - 3600, updatedAt: now - ago, turns, archived: false }; };
add(focal, 'Focal length estimation', [turn('Estimate the focal length from the calibration images in ./calib and explain the method.',
  'I used **Zhang\'s method** on the 14 checkerboard images.\n\n| Parameter | Value | Std. dev. |\n|---|---|---|\n| fx | 1432.6 px | 2.1 |\n| fy | 1429.8 px | 2.3 |\n\n```matlab\n% Calibration\n[params, used] = estimateCameraParameters(points, worldPts);\nf_mm = params.FocalLength * pixelSize;\n```\nThe residual reprojection error is 0.21 px.',
  [{ type: 'commandExecution', id: crypto.randomUUID(), command: 'matlab -batch "calib_run"', cwd: focal, status: 'completed', commandActions: [], aggregatedOutput: 'Detected 14 boards\nMean reprojection error: 0.21 px\n', exitCode: 0, durationMs: 8400, source: 'agent', processId: null, pluginId: null, scriptPath: null },
   { type: 'fileChange', id: crypto.randomUUID(), status: 'completed', changes: { 'calib_run.m': { type: 'add', content: 'images = imageDatastore("calib");\n[points, boardSize] = detectCheckerboardPoints(images.Files);' } } }])], 600);
add(focal, 'Lens distortion report', [turn('Write a short report on radial distortion.', 'Radial distortion coefficients k1 = −0.112, k2 = 0.031. The barrel distortion is visible at the corners.')], 7200);
add(optics, 'MTF measurement plan', [turn('Plan the MTF measurement.', '1. Slanted-edge target at 5°\n2. ISO 12233 analysis\n3. Compare centre vs. corners')], 86400);
add(repo, 'FIR filter review', [turn('Review filter_design.m', 'The filter order (48) is fine for a 0.35 normalised cut-off. Consider a Kaiser window for tighter stop-band control.')], 3000);
fs.writeFileSync(path.join(codexHome, 'fake-state.json'), JSON.stringify({ threads, config: { model: 'gpt-6.1-sol', model_reasoning_effort: 'medium', mcp_servers: {} }, writes: [], locked: [] }, null, 2));
fs.mkdirSync(path.join(head, '.cpm'), { recursive: true });
fs.writeFileSync(path.join(head, '.cpm', 'CONTEXT.md'), '# Context — X1191\n\nOptical bench project. Camera: 5 MP, pixel 3.45 µm.\n');

const args = process.argv.slice(2);
const { createServer, openUi } = await import('../server.mjs');
const portArg = args.indexOf('--port');
const srv = await createServer({ dataDir, codexHome, port: portArg >= 0 ? +args[portArg + 1] : 0 });
console.log(`DEMO ${srv.url}`);
console.log(`Sandbox: ${sandbox}`);
if (args.includes('--open')) await openUi(srv.url, 'browser');
const cleanup = () => { if (!args.includes('--keep')) fs.rmSync(sandbox, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
