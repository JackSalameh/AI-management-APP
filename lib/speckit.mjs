// Spec Kit (github/spec-kit, specify-cli ≥ 1.2): spec-driven development inside a project folder.
// Verified with specify-cli 1.2.5: `specify init --here --force --non-interactive --integration codex|claude`
// installs skills in .agents/skills/speckit-<phase>/SKILL.md (Codex) or .claude/skills/… (Claude Code) and the
// shared .specify/ folder; features live in specs/<NNN-name>/{spec,plan,tasks}.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PHASES = ['constitution', 'specify', 'clarify', 'plan', 'tasks', 'analyze', 'checklist', 'implement', 'converge'];
const SKILL_DIRS = { codex: '.agents/skills', claude: '.claude/skills' };

export function integrationOf(folder) {
  try { const j = JSON.parse(fs.readFileSync(path.join(folder, '.specify', 'integration.json'), 'utf8')); return j.integration || j.key || j.name || null; } catch { /* not set */ }
  for (const [k, d] of Object.entries(SKILL_DIRS)) if (fs.existsSync(path.join(folder, d, 'speckit-specify', 'SKILL.md'))) return k;
  return null;
}

const countTasks = (txt) => {
  const all = txt.match(/^\s*[-*] \[[ xX]\]/gm) || [];
  return { total: all.length, done: all.filter((l) => /\[[xX]\]/.test(l)).length };
};

/** What exists in the folder: set up or not, constitution, features with their documents and task progress. */
export async function specStatus(folder) {
  const initialized = fs.existsSync(path.join(folder, '.specify'));
  const out = { initialized, integration: initialized ? integrationOf(folder) : null, constitution: null, features: [], current: null };
  if (!initialized) return out;
  const con = path.join(folder, '.specify', 'memory', 'constitution.md');
  if (fs.existsSync(con)) { const t = await fsp.readFile(con, 'utf8'); out.constitution = { path: con, filled: !/\[PROJECT_NAME\]|\[PRINCIPLE_1_NAME\]/.test(t) }; }
  try { out.current = JSON.parse(await fsp.readFile(path.join(folder, '.specify', 'feature.json'), 'utf8')).feature_directory || null; } catch { /* none yet */ }
  const specs = path.join(folder, 'specs');
  let dirs = []; try { dirs = (await fsp.readdir(specs, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* no feature yet */ }
  for (const d of dirs.slice(-50)) {
    const dir = path.join(specs, d);
    const doc = (n) => (fs.existsSync(path.join(dir, n)) ? path.join(dir, n) : null);
    const f = { name: d, dir, spec: doc('spec.md'), plan: doc('plan.md'), tasks: doc('tasks.md'), checklists: fs.existsSync(path.join(dir, 'checklists')) };
    if (f.tasks) f.progress = countTasks(await fsp.readFile(f.tasks, 'utf8'));
    f.next = !f.spec ? 'specify' : !f.plan ? 'plan' : !f.tasks ? 'tasks' : f.progress && f.progress.done < f.progress.total ? 'implement' : 'done';
    out.features.push(f);
  }
  return out;
}

/** specify init arguments for this folder and agent (no shell, fixed strings). */
export function initArgs(agent, platform = process.platform) {
  const integration = agent === 'claude' ? 'claude' : 'codex';
  return ['init', '--here', '--force', '--non-interactive', '--integration', integration, '--ignore-agent-tools', '--script', platform === 'win32' ? 'ps' : 'sh'];
}

/**
 * The message that runs one phase with the conversation's AI. Codex and Claude Code call the installed skill
 * natively ($speckit-<phase> / /speckit-<phase>); any other AI receives the phase instructions themselves.
 */
export async function phaseMessage(folder, phase, args, agent) {
  if (!PHASES.includes(phase)) throw new Error('Unknown Spec Kit phase');
  const input = String(args || '').trim();
  for (const [k, d] of Object.entries(SKILL_DIRS)) {
    const file = path.join(folder, d, `speckit-${phase}`, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    if (agent === k) return `${k === 'codex' ? '$' : '/'}speckit-${phase}${input ? ' ' + input : ''}`;
  }
  for (const d of Object.values(SKILL_DIRS)) {
    const file = path.join(folder, d, `speckit-${phase}`, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const body = (await fsp.readFile(file, 'utf8')).replace(/^---[\s\S]*?\n---\n/, '').replace(/\$ARGUMENTS/g, input || '(none)');
    return `Spec Kit — ${phase} phase. Follow these instructions in this folder.\n\n${body.trim()}`;
  }
  throw new Error('Spec Kit is not set up in this folder yet.');
}
