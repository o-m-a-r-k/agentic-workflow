// 0.7.30 (I-157, D57): a full lease goes to the live run that has waited longest, and every waiting run sees its place.
//
// Named failure (field): a small focused proof waited more than 35 minutes for the Docker lease while other live runs kept
// taking it. Every waiting run polled (gates every 500 ms, `wf run` every second) and whichever asked first after a slot
// freed took it, so a newcomer could start before a run that had waited for half an hour. Nothing durable orders the waiters
// (principle 8: no slot and no place is kept for a process that is gone): each waiting run marks itself beside the lease's
// slots while it asks, and only live, still-asking runs count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WF, commitIn, criteriaFile, ok, OUT_OF_ORDER, ownerSpeaks, singleRepoProject, spawnHome, wf } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leases = (root) => path.join(root, '..', '.wfhome', 'leases');
// A process that is not a child of this test (a zombie child would still count as alive while the test is blocked).
const detached = (seconds) => Number(spawnSync('sh', ['-c', `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).stdout.trim());
function holdDocker(root, seconds = 30) {
  fs.mkdirSync(leases(root), { recursive: true });
  const pid = detached(seconds);
  fs.writeFileSync(path.join(leases(root), 'docker.1'), String(pid));
  return () => {
    try {
      process.kill(pid);
    } catch {}
  };
}
const env = (root) => {
  const e = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete e[k];
  return e;
};
// `wf run --lease docker` in the background: it appends its name to the order file once it holds the slot.
function waiter(root, name, order) {
  const child = spawn(process.execPath, [WF, 'run', '--lease', 'docker', '--', 'sh', '-c', `echo ${name} >> ${JSON.stringify(order)}; sleep 1`], { cwd: root, env: env(root), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => child.once('close', (code) => resolve({ code, err })));
  return { child, done };
}
const project = (name, steps = [{ id: 'unit', repo: 'app', run: 'true' }]) => singleRepoProject(name, { gate: { maxParallelSteps: 2, leases: { docker: 1 }, steps } });

test('I-157: a run that arrives when a slot frees waits behind the live run that waited longer, and says its place', async () => {
  const { root, base } = project('lease-fair-run');
  const order = path.join(base, 'order.txt');
  const release = holdDocker(root);
  const a = waiter(root, 'A', order);
  await sleep(1500); // A is waiting for the held slot
  release(); // the slot is free; A asks again within a second
  const b = spawnSync(process.execPath, [WF, 'run', '--lease', 'docker', '--', 'sh', '-c', `echo B >> ${JSON.stringify(order)}`], { cwd: root, env: env(root), encoding: 'utf8' });
  const ra = await a.done;
  assert.equal(b.status, 0, b.stderr);
  assert.equal(ra.code, 0, ra.err);
  assert.deepEqual(fs.readFileSync(order, 'utf8').trim().split('\n'), ['A', 'B'], 'the run that waited longest went first');
  assert.match(b.stderr, /wf run: waiting for a `docker` lease \(1 slot\(s\)[^)]*\): [^\n]*place 2 of 2 waiting \(the live run waiting longest goes next\)/);
  assert.equal(fs.readdirSync(leases(root)).filter((n) => /\.wait\./.test(n)).length, 0, 'nothing is left behind for a run that went');
});

test('I-157: a gate step waits its turn behind an earlier live waiter, and the gate and `wf status` show its place', async () => {
  const step = { id: 'stack', repo: 'app', lease: 'docker', run: `echo G >> "$WF_ROOT/../order.txt"` };
  const { root, base } = project('lease-fair-gate', [step]);
  const order = path.join(base, 'order.txt');
  const e = ok(wf(root, ['entry', '--item', 'ENG-157', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const release = holdDocker(root);
  const a = waiter(root, 'A', order);
  await sleep(1500);
  const args = ['gate', ...OUT_OF_ORDER, '--attempt', e.id];
  // The decision the out-of-order gate needs, answered first; then the gate itself runs in the background.
  ownerSpeaks(root, args);
  const g = spawn(process.execPath, [WF, ...args], { cwd: root, env: env(root), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  g.stdout.on('data', (d) => (out += d));
  g.stderr.on('data', (d) => (out += d));
  const gDone = new Promise((resolve) => g.once('close', resolve));
  let status = '';
  for (let i = 0; i < 50 && !/place 2 of 2/.test(status); i++) {
    await sleep(200);
    status = wf(root, ['status', '--attempt', e.id]).out;
  }
  assert.match(status, /waiting: stack for lease docker \(1 slot\(s\), all held\) for \d+s: held by pid \d+[^\n]*; place 2 of 2 waiting \(the live run waiting longest goes next\)/);
  release();
  assert.equal(await gDone, 0, out);
  assert.equal((await a.done).code, 0);
  assert.deepEqual(fs.readFileSync(order, 'utf8').trim().split('\n'), ['A', 'G']);
  assert.match(out, /waiting  stack  for lease docker \(1 slot\(s\), all held\): [^\n]*place 2 of 2 waiting/);
});

test('I-157: a waiter whose process is gone, or that stopped asking, holds no place', () => {
  const { root, base } = project('lease-fair-dead');
  fs.mkdirSync(leases(root), { recursive: true });
  // A dead process's mark, waiting since long ago, and a live process's mark it stopped refreshing a minute ago.
  const dead = spawnSync('true').pid;
  const live = detached(30);
  const old = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(path.join(leases(root), `docker.wait.${dead}.aaaaaaaaaaaa`), JSON.stringify({ pid: dead, since: old, tag: 'gone' }));
  const stale = path.join(leases(root), `docker.wait.${live}.bbbbbbbbbbbb`);
  fs.writeFileSync(stale, JSON.stringify({ pid: live, since: old, tag: 'stopped asking' }));
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(stale, t, t);
  const started = Date.now();
  const r = spawnSync(process.execPath, [WF, 'run', '--lease', 'docker', '--', 'sh', '-c', `echo ran > ${JSON.stringify(path.join(base, 'ran.txt'))}`], { cwd: root, env: env(root), encoding: 'utf8' });
  process.kill(live);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 5000, 'it took the free slot at once');
  assert.doesNotMatch(r.stderr, /waiting for a/);
  assert.ok(!fs.existsSync(path.join(leases(root), `docker.wait.${dead}.aaaaaaaaaaaa`)), 'a dead waiter\'s mark is removed');
});
