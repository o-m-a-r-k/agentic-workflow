// 0.7.16, named failure: an owner waiting on a 27-minute end-to-end gate step could see only that it ran, not how far it
// was or how long it took last time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OUT_OF_ORDER, WF, commitIn, criteriaFile, ok, ownerSpeaks, singleRepoProject, spawnHome, wf } from './helpers.mjs';

test('wf status shows a running step\'s time against its last run and the latest line of its live log', { timeout: 60_000 }, async () => {
  const steps = [{ id: 'e2e', repo: 'app', run: 'sh src/run.sh', inputs: ['src/**'] }];
  const f = singleRepoProject('live-progress', { gate: { steps } });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/run.sh': 'echo quick\n' });
  ok(wf(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/run.sh': 'echo starting\necho "test 412 of 1211"\nsleep 20\n' });
  const env = { ...process.env, WF_CONFIG_HOME: path.join(f.root, '..', '.wfhome'), ...spawnHome(f.root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  ownerSpeaks(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
  const child = spawn(process.execPath, [WF, 'gate', ...OUT_OF_ORDER, '--attempt', e.id], { cwd: f.root, env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  let view = '';
  for (let i = 0; i < 60 && child.exitCode === null && !/latest: test 412 of 1211/.test(view); i++) {
    await new Promise((r) => setTimeout(r, 200));
    view = wf(f.root, ['status', '--attempt', e.id]).out;
  }
  try {
    assert.match(view, /running: e2e \(\d+s of ~\d+s last time\)/);
    assert.match(view, /latest: test 412 of 1211/);
  } finally {
    wf(f.root, ['stop', '--class', 'owner-decision', '--reason', 'scenario', '--attempt', e.id]);
    await exited;
  }
});

// Independent review of 0.7.16: the gate holds back the tail of a step's output until it can redact it, so the log usually
// ends mid-line; and a link, a FIFO or a file with another name at the log's path must neither show nor block.
test('the latest log line is the last complete one, and the log is read like any evidence file', async () => {
  const { latestLogLine } = await import('../engine/gate.mjs');
  const { tmp } = await import('./helpers.mjs');
  const { spawnSync } = await import('node:child_process');
  const dir = tmp('latest-line');
  const log = path.join(dir, 'output.log');
  fs.writeFileSync(log, 'starting\ntest 412 of 1211\ntest 413 of 12');
  assert.deepEqual(latestLogLine(log), { latest: 'test 412 of 1211' }, 'a partial last line is not shown');
  fs.writeFileSync(log, `${'x'.repeat(300)}\n`);
  assert.equal(latestLogLine(log).latest.length, 160, 'a long line shows its end');
  const fifo = path.join(dir, 'fifo.log');
  spawnSync('mkfifo', [fifo]);
  assert.deepEqual(latestLogLine(fifo), {}, 'a FIFO shows nothing and does not block');
  const secret = path.join(dir, '.env.local');
  fs.writeFileSync(secret, 'TOKEN=abc\n');
  const linked = path.join(dir, 'linked.log');
  fs.linkSync(secret, linked);
  assert.deepEqual(latestLogLine(linked), {}, 'a file with another name shows nothing');
});
