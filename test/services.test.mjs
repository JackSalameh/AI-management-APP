// Local services started by the app (OmniRoute): run in the background, wait until they answer, and when they do
// not start, show the end of what they printed (the cause) instead of a bare "did not answer".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startService, Jobs, healthy } from '../lib/addons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-svc-'));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('a service that starts: launched with its arguments, reported running once it answers', async () => {
  const port = await freePort(); process.env.FAKE_SVC_PORT = String(port);
  const jobs = new Jobs(() => {}); const job = jobs.create('svc');
  const log = path.join(root, 'good.log');
  const ok = await startService({ name: 'Good', start: { command: path.join(here, 'fixtures', 'svc', 'good-svc'), args: ['--no-open'], health: `http://127.0.0.1:${port}/v1/models`, wait: 20 } }, job, jobs, { logFile: log });
  assert.equal(ok, true, job.log);
  assert.ok(await healthy(`http://127.0.0.1:${port}/v1/models`));
  assert.match(fs.readFileSync(log, 'utf8'), /starting fake service --no-open/);
});

test('a service that fails: stops waiting as soon as it exits and shows why', async () => {
  const jobs = new Jobs(() => {}); const job = jobs.create('svc');
  const t0 = Date.now();
  const ok = await startService({ name: 'Bad', start: { command: path.join(here, 'fixtures', 'svc', 'bad-svc'), health: `http://127.0.0.1:${await freePort()}/`, wait: 60 } }, job, jobs, { logFile: path.join(root, 'bad.log') });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 10_000, 'did not wait the full minute');
  assert.match(job.log, /stopped \(exit code 3\)/);
  assert.match(job.log, /Cannot find module better-sqlite3/);
});
