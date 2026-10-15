// Named failure (I-128): `wf handoff stop` reported a launched role stopped while the role's process tree kept running.
// It sent one SIGTERM to the role's process group, ignored a signal that did not arrive, did not look again and recorded
// `stopped`. The interrupt and error paths of a foreground `wf handoff run` (follow in engine/launch.mjs) had the same flaw:
// one SIGTERM to the group, then a wait for the role itself. The fake runtime below starts a long-running child of its own, as a real runtime does for each command: one in
// the role's process group, one that left it (a group of its own, with a child of its own). The same fake runs as the Codex
// and as the Claude binary: both are launched the same way (engine/launch.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ok, singleRepoProject, state, wf, write, WF } from './helpers.mjs';
import { endProcessTree, processSeams } from '../engine/process-tree.mjs';
import { stopRole, waitRole } from '../engine/launch.mjs';

const KID = `import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const [name, dir, stubborn, grandchild] = process.argv.slice(2);
if (stubborn === 'yes') process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(dir, 'pid-' + name), String(process.pid));
if (grandchild) spawn(process.execPath, [fileURLToPath(import.meta.url), grandchild, dir, stubborn], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`;

function fakeRuntime(runtime, bin, dir, { stubborn = false } = {}) {
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  write(bin, 'kid.mjs', KID);
  write(bin, runtime, `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const runtime = ${JSON.stringify(runtime)}, dir = ${JSON.stringify(dir)}, stubborn = ${JSON.stringify(stubborn ? 'yes' : 'no')};
const args = process.argv.slice(2);
fs.readFileSync(0, 'utf8');
if (stubborn === 'yes') process.on('SIGTERM', () => {});
const sid = runtime === 'claude' ? args[args.indexOf('--session-id') + 1] : '01a110b4-1637-7a42-b353-d0ad25e60300';
const kid = path.join(${JSON.stringify(bin)}, 'kid.mjs');
spawn(process.execPath, [kid, 'same', dir, stubborn], { stdio: 'ignore' });
spawn(process.execPath, [kid, 'own', dir, stubborn, 'grand'], { stdio: 'ignore', detached: true });
fs.writeFileSync(path.join(dir, 'pid-role'), String(process.pid));
console.log(JSON.stringify(runtime === 'claude' ? { type: 'system', subtype: 'init', session_id: sid } : { type: 'thread.started', thread_id: sid }));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(path.join(bin, runtime), 0o755);
}

const NAMES = ['role', 'same', 'own', 'grand'];

function prepared(runtime, options = {}) {
  const p = singleRepoProject('stop-tree', { classes: { review: { [runtime]: { model: 'future-model', effort: 'high' } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const id = ok(wf(p.root, ['entry', '--item', 'ENG-91', '--owner', `${runtime}:stop-owner`, '--json'])).json().id;
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', id, '--runtime', runtime]));
  const bin = path.join(p.base, 'bin'), dir = path.join(p.base, 'pids');
  fakeRuntime(runtime, bin, dir, options);
  const env = { [runtime === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID']: state(p.root, id).owner.split(':').slice(1).join(':'), WF_HOME: path.join(p.base, '.home'), PATH: bin + path.delimiter + process.env.PATH };
  return { ...p, id, env, dir };
}

const pidOf = (dir, name) => { try { return Number(fs.readFileSync(path.join(dir, 'pid-' + name), 'utf8')); } catch { return 0; } };
async function running(dir) {
  for (let n = 0; n < 200; n++) {
    if (NAMES.every((name) => pidOf(dir, name) > 0)) return Object.fromEntries(NAMES.map((name) => [name, pidOf(dir, name)]));
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the fake runtime did not start its tree');
}
// Gone: no such process, or one that has died and waits only for its parent to collect it.
const gone = (pid) => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat === '' || stat.startsWith('Z');
};
const survivors = (pids) => Object.entries(pids).filter(([, pid]) => !gone(pid)).map(([name]) => name);
const endAll = (pids) => { for (const pid of Object.values(pids)) try { process.kill(pid, 'SIGKILL'); } catch {} };

for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: wf handoff stop ends the role, its child in the group and the descendants that left it, and they are gone when it reports`, { timeout: 30_000 }, async () => {
    const p = prepared(runtime);
    const run = wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env });
    assert.equal(run.code, 0, run.err);
    assert.equal(run.json().status, 'running');
    const pids = await running(p.dir);
    try {
      assert.deepEqual(survivors(pids), NAMES, 'the whole tree is running before the stop');
      const stop = wf(p.root, ['handoff', 'stop', '--agent', 'p', '--reason', 'owner asked', '--attempt', p.id, '--json'], { env: p.env });
      assert.equal(stop.code, 0, stop.err);
      assert.deepEqual(survivors(pids), [], 'no process of the launched tree survives the stop it reported');
      const launch = state(p.root, p.id).handoffs.at(-1).launch;
      assert.deepEqual([launch.status, launch.exitCode, launch.failure.kind], ['failed', 143, 'stopped']);
      assert.match(launch.failure.detail, /stopped by the owner: owner asked/);
    } finally { endAll(pids); }
  });
}

test('a role and its children that ignore SIGTERM are ended by force; the stop reports only once they are gone', { timeout: 30_000 }, async () => {
  const p = prepared('codex', { stubborn: true });
  ok(wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env }));
  const pids = await running(p.dir);
  try {
    const stop = wf(p.root, ['handoff', 'stop', '--agent', 'p', '--attempt', p.id], { env: p.env });
    assert.equal(stop.code, 0, stop.err);
    assert.deepEqual(survivors(pids), []);
    assert.equal(state(p.root, p.id).handoffs.at(-1).launch.failure.kind, 'stopped');
  } finally { endAll(pids); }
});

// The wrapper of the report: `wf handoff run` was still in the foreground, following the role, when the stop came from
// another process. Both had to end, the wrapper by itself once the role it follows is gone.
// A foreground `wf handoff run` in its own process, following the role until something ends it.
function foreground(p) {
  const env = { ...process.env, ...p.env, WF_CONFIG_HOME: path.join(p.base, '.wfhome'), WF_EVIDENCE_FLAGS: '0' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[key];
  const wrapper = spawn(process.execPath, [WF, 'handoff', 'run', '--agent', 'p', '--attempt', p.id, '--json'], { cwd: p.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  wrapper.stdout.on('data', (b) => { out += b; });
  wrapper.stderr.on('data', (b) => { err += b; });
  const closed = new Promise((resolve) => wrapper.once('close', (code) => resolve(code)));
  const within = (ms) => Promise.race([closed, new Promise((r) => setTimeout(() => r('still running'), ms))]);
  return { wrapper, within, out: () => out, err: () => err };
}

test('a stop from another process ends the role under a foreground wf handoff run, which then returns', { timeout: 30_000 }, async () => {
  const p = prepared('codex');
  const run = foreground(p);
  const pids = await running(p.dir);
  try {
    assert.equal(run.wrapper.exitCode, null, 'the wrapper is following the role');
    ok(wf(p.root, ['handoff', 'stop', '--agent', 'p', '--attempt', p.id], { env: p.env }));
    assert.deepEqual(survivors(pids), []);
    assert.equal(await run.within(10_000), 1, 'the wrapper returned, failed');
    assert.equal(state(p.root, p.id).handoffs.at(-1).launch.status, 'failed');
  } finally { endAll(pids); if (run.wrapper.exitCode === null) run.wrapper.kill('SIGKILL'); }
});

// Named failure (I-128, interrupt path): an interrupted foreground run sent one SIGTERM to the role's group; the child that
// had left the group (and its own child) outlived the command that reported the role cancelled.
for (const runtime of ['codex', 'claude']) {
  test(`${runtime}: an interrupted foreground wf handoff run has ended the whole tree, the child that left the group included, when it returns`, { timeout: 30_000 }, async () => {
    const p = prepared(runtime);
    const run = foreground(p);
    const pids = await running(p.dir);
    try {
      run.wrapper.kill('SIGTERM');
      assert.equal(await run.within(10_000), 1, run.err());
      assert.deepEqual(survivors(pids), [], 'nothing of the launched tree is left once the command has returned');
      assert.equal(JSON.parse(run.out()).status, 'failed');
      assert.match(run.err(), /the role launch was interrupted/);
      assert.equal(state(p.root, p.id).handoffs.at(-1).launch.status, 'failed');
    } finally { endAll(pids); if (run.wrapper.exitCode === null) run.wrapper.kill('SIGKILL'); }
  });
}

// Named failure (I-128, interrupt path): after the one SIGTERM the command waited for the role itself to exit, so a role that
// ignored it held the interrupted command for as long as the role chose.
test('an interrupted foreground wf handoff run does not hang on a role that ignores SIGTERM: the tree is killed and it returns', { timeout: 30_000 }, async () => {
  const p = prepared('codex', { stubborn: true });
  const run = foreground(p);
  const pids = await running(p.dir);
  try {
    run.wrapper.kill('SIGINT');
    assert.equal(await run.within(20_000), 1, run.err());
    assert.deepEqual(survivors(pids), []);
    assert.equal(state(p.root, p.id).handoffs.at(-1).launch.status, 'failed');
  } finally { endAll(pids); if (run.wrapper.exitCode === null) run.wrapper.kill('SIGKILL'); }
});

// A stop that cannot end the tree says so and records nothing: this process is not permitted to signal it (a sandbox, or
// another user's process), so no signal is delivered and the role runs on.
test('a tree that cannot be signalled is reported as still running, with no stopped record', { timeout: 30_000 }, async () => {
  const p = prepared('codex');
  ok(wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env }));
  const pids = await running(p.dir);
  const real = processSeams.kill;
  process.env.WF_EVIDENCE_FLAGS = '0';
  try {
    processSeams.kill = (target, signal) => {
      if (signal === 0) return real(target, 0);
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    const before = state(p.root, p.id).handoffs.at(-1).launch;
    await assert.rejects(stopRole(p.root, { attempt: p.id, agent: 'p', owner: 'o' }), (e) => {
      assert.match(e.message, /^p was not stopped, still running: not permitted to signal pid \d+/);
      assert.match(e.message, new RegExp(`pid ${pids.role}\\b`));
      assert.match(e.hint, /^nothing was recorded as stopped\./);
      return true;
    });
    assert.deepEqual(state(p.root, p.id).handoffs.at(-1).launch, before, 'no stopped record');
    assert.deepEqual(survivors(pids), NAMES, 'the role kept running, and the stop said so');
  } finally { processSeams.kill = real; endAll(pids); }
});

test('without a process listing the role\'s own group is still ended and verified', { timeout: 30_000 }, async () => {
  const p = prepared('codex');
  ok(wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env }));
  const pids = await running(p.dir);
  const table = processSeams.table;
  try {
    processSeams.table = () => null;
    const ended = await endProcessTree(pids.role);
    assert.deepEqual(ended.left, []);
    assert.equal(gone(pids.role), true);
    assert.equal(gone(pids.same), true, 'a member of the role\'s group');
  } finally { processSeams.table = table; endAll(pids); }
});

// An interrupted run that cannot end the tree says so, returns at once (it does not wait for a role it cannot signal) and
// records nothing: the launch stays running, which is what is true. The handler follow() installs is called as the signal
// would call it.
test('an interrupted run that cannot signal the tree returns, says what is still running and records nothing', { timeout: 30_000 }, async () => {
  const p = prepared('codex');
  ok(wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env }));
  const pids = await running(p.dir);
  const real = processSeams.kill, write = process.stderr.write;
  process.env.WF_EVIDENCE_FLAGS = '0';
  let said = '';
  try {
    processSeams.kill = (target, signal) => {
      if (signal === 0) return real(target, 0);
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    process.stderr.write = (chunk, ...rest) => { said += chunk; return write.call(process.stderr, chunk, ...rest); };
    const before = state(p.root, p.id).handoffs.at(-1).launch;
    const known = new Set(process.listeners('SIGTERM'));
    const following = waitRole(p.root, { attempt: p.id, agent: 'p' });
    await new Promise((r) => setTimeout(r, 400));
    const handler = process.listeners('SIGTERM').find((l) => !known.has(l));
    assert.ok(handler, 'the run is following the role');
    handler();
    const result = await Promise.race([following, new Promise((r) => setTimeout(() => r('hung'), 10_000))]);
    assert.deepEqual([result.status, result.exitCode, result.pid], ['running', 1, pids.role]);
    assert.match(said, new RegExp(`the role launch was interrupted, and it is still running: not permitted to signal pid ${pids.role}\\b`));
    assert.match(said, /Nothing was recorded as finished\./);
    assert.deepEqual(state(p.root, p.id).handoffs.at(-1).launch, before, 'no finished record');
    assert.deepEqual(survivors(pids), NAMES);
  } finally { processSeams.kill = real; process.stderr.write = write; endAll(pids); }
});

// Named failure (independent review of 0.7.9): a stale launch record's pid, given by the system to another process that
// leads its own group, would have made that group "the role" and killed it. Here the recorded pid is said to have started
// an hour after the launch: the stop records the launch stopped and signals nothing.
test('a recorded pid that is another process now is left alone, and the launch is recorded stopped', { timeout: 30_000 }, async () => {
  const p = prepared('codex');
  ok(wf(p.root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', p.id, '--json'], { env: p.env }));
  const pids = await running(p.dir);
  const startedAt = processSeams.startedAt, kill = processSeams.kill;
  process.env.WF_EVIDENCE_FLAGS = '0';
  const signalled = [];
  try {
    const launch = state(p.root, p.id).handoffs.at(-1).launch;
    assert.ok(launch.spawnedAt, 'the spawn time is recorded with the pid');
    processSeams.startedAt = () => Date.parse(launch.spawnedAt) + 3_600_000;
    processSeams.kill = (target, signal) => { if (signal !== 0) signalled.push(target); return kill(target, signal); };
    const r = await stopRole(p.root, { attempt: p.id, agent: 'p', owner: 'o' });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(signalled, [], 'nothing was signalled');
    assert.deepEqual(survivors(pids), NAMES, 'the process holding the pid runs on');
    assert.match(state(p.root, p.id).handoffs.at(-1).launch.failure.detail, /its process had already ended; pid \d+ is another process now, left alone/);
  } finally { processSeams.startedAt = startedAt; processSeams.kill = kill; endAll(pids); }
});

// A pid seen in the tree that the system gave to a process of another group meanwhile is not the tree's any more.
test('a pid seen in the tree that changed group is not ended', { timeout: 10_000 }, async () => {
  const table = processSeams.table, kill = processSeams.kill;
  let call = 0;
  const signalled = [];
  try {
    // First look: the leader 900 and its member 901. Then the leader is gone and 901 is a new process in group 950.
    processSeams.table = () => (call++ === 0 ? new Map([[900, { ppid: 1, pgid: 900, zombie: false }], [901, { ppid: 900, pgid: 900, zombie: false }]]) : new Map([[901, { ppid: 1, pgid: 950, zombie: false }]]));
    processSeams.kill = (target, signal) => { signalled.push([target, signal]); };
    const ended = await endProcessTree(900, { graceMs: 200, killMs: 200 });
    assert.deepEqual(ended.left, []);
    assert.equal(signalled.filter(([target]) => target === 901).length, 1, 'one SIGTERM while it was a member, nothing after');
  } finally { processSeams.table = table; processSeams.kill = kill; }
});
