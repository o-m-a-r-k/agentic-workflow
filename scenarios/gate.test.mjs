import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, sh, singleRepoProject, state, wf, write, yaml } from './helpers.mjs';

function admitted(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
}

const gateJson = (root, id, extra = []) => {
  const r = wf(root, ['gate', '--attempt', id, '--json', ...extra]);
  return { code: r.code, data: r.out ? JSON.parse(r.out) : null, err: r.err };
};
const byId = (steps) => Object.fromEntries(steps.map((s) => [s.id, s]));

test('unchanged inputs are reused; only steps whose inputs changed rerun', () => {
  const steps = [
    { id: 'src-check', repo: 'app', run: 'cat src/a.txt > /dev/null', inputs: ['src/**'], ignores: ['docs/**'] },
    { id: 'docs-check', repo: 'app', run: 'cat docs/d.txt > /dev/null', inputs: ['docs/**'] },
    { id: 'always', repo: 'app', run: 'true' },
  ];
  const { base, root } = singleRepoProject('reuse', { gate: { steps } }, { 'docs/d.txt': 'd\n' });
  const e = admitted(root, base, 'ENG-20');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  const g1 = gateJson(root, e.id);
  assert.equal(g1.code, 0);
  commitIn(e.repos.app.worktree, { 'docs/d.txt': 'changed\n' });
  const g2 = byId(gateJson(root, e.id).data.steps);
  assert.equal(g2['src-check'].status, 'reused');
  assert.equal(g2['docs-check'].status, 'passed');
  assert.equal(g2.always.status, 'passed', 'a step without inputs always runs');
});

test('worker overrides: auto sizing is recorded, invalid override exits 2', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'test "{workers}" -ge 1', inputs: ['src/**'], workers: { auto: true, min: 2, max: 4, perWorkerGiB: 1 } }];
  const { base, root } = singleRepoProject('workers', { gate: { steps } });
  const e = admitted(root, base, 'ENG-21');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'w\n' });
  const g = gateJson(root, e.id).data.steps[0];
  assert.ok(g.workers.n >= 2 && g.workers.n <= 4, `workers ${g.workers.n}`);
  assert.ok(['auto', 'probe-failed'].includes(g.workers.source));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'w2\n' });
  const forced = wf(root, ['gate', '--attempt', e.id, '--json'], { env: { WF_WORKERS_UNIT: '3' } });
  assert.equal(JSON.parse(forced.out).steps[0].workers.n, 3);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'w3\n' });
  const bad = wf(root, ['gate', '--attempt', e.id], { env: { WF_WORKERS_UNIT: 'lots' } });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /WF_WORKERS_UNIT must be an integer/);
});

test('the gate trusts the adapter at base: a ticket cannot remove its own checks', () => {
  const steps = [{ id: 'guard', repo: 'app', run: '! grep -q forbidden src/a.txt', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('trust', { gate: { steps } });
  const e = admitted(root, base, 'ENG-22');
  const weakened = { version: 1, enabled: true, name: 'trust', repos: [{ name: 'app', path: '.', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [] } };
  commitIn(e.repos.app.worktree, { '.workflow/project.yaml': yaml(weakened), 'src/a.txt': 'forbidden\n' });
  const g = gateJson(root, e.id);
  assert.equal(g.code, 1, 'base adapter still runs `guard`');
  assert.equal(g.data.full, true, 'touching .workflow forces the full gate');
  assert.equal(g.data.steps[0].status, 'failed');
});

test('JUnit suites are recorded per suite, and `select` reruns only failed or changed suites', () => {
  const script = `
const fs=require('fs');const sel=process.argv.slice(2);
const fail=fs.readFileSync('tests/b.test','utf8').includes('bad');
const all=['tests/a.test','tests/b.test'];const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const cases=run.map(f=>'<testcase classname="x" name="'+f+'" file="'+f+'">'+(f==='tests/b.test'&&fail?'<failure/>':'')+'</testcase>').join('');
fs.writeFileSync(process.env.WF_EVIDENCE+'/junit.xml','<testsuites><testsuite name="s">'+cases+'</testsuite></testsuites>');
process.exit(run.includes('tests/b.test')&&fail?1:0);`;
  const steps = [{ id: 'unit', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: '{evidence}/junit.xml' }, inputs: ['tests/**', 'runner.cjs'] }];
  const { base, root } = singleRepoProject('junit', { gate: { steps } }, { 'runner.cjs': script, 'tests/a.test': 'a\n', 'tests/b.test': 'b\n' });
  const e = admitted(root, base, 'ENG-23');
  commitIn(e.repos.app.worktree, { 'tests/b.test': 'bad\n' });
  const g1 = gateJson(root, e.id);
  assert.equal(g1.code, 1);
  assert.deepEqual(g1.data.steps[0].suites.map((s) => `${s.id}:${s.status}`).sort(), ['tests/a.test:passed', 'tests/b.test:failed']);
  commitIn(e.repos.app.worktree, { 'tests/b.test': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 0);
  const ran = fs.readFileSync(path.join(path.dirname(g2.data.steps[0].log), '..', 'ran.txt'), 'utf8').trim();
  assert.equal(ran, 'tests/b.test', 'only the failed/changed suite reran');
  assert.ok(g2.data.steps[0].suites.find((s) => s.id === 'tests/a.test').carried, 'the passing suite is carried');
});

test('steps run in parallel up to the limit and leases keep heavy steps apart', () => {
  const stamp = (n) => `node -e "require('fs').appendFileSync(process.env.WF_ROOT+'/../times.txt','${n} '+Date.now()+' start\\n');setTimeout(()=>require('fs').appendFileSync(process.env.WF_ROOT+'/../times.txt','${n} '+Date.now()+' end\\n'),400)"`;
  const steps = [
    { id: 'a', repo: 'app', run: stamp('a') },
    { id: 'b', repo: 'app', run: stamp('b') },
    { id: 'c', repo: 'app', run: stamp('c'), lease: 'docker' },
    { id: 'd', repo: 'app', run: stamp('d'), lease: 'docker' },
  ];
  const { base, root } = singleRepoProject('parallel', { gate: { maxParallelSteps: 2, leases: { docker: 1 }, steps } });
  const e = admitted(root, base, 'ENG-24');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'p\n' });
  assert.equal(gateJson(root, e.id).code, 0);
  const lines = fs.readFileSync(path.join(root, '..', 'times.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const t = {};
  for (const [n, ts, kind] of lines) (t[n] ??= {})[kind] = Number(ts);
  const overlap = (x, y) => t[x].start < t[y].end && t[y].start < t[x].end;
  assert.ok(overlap('a', 'b'), 'two unleased steps overlap');
  assert.ok(!overlap('c', 'd'), 'two docker steps never overlap');
  let maxConcurrent = 0;
  for (const n of Object.keys(t)) maxConcurrent = Math.max(maxConcurrent, Object.keys(t).filter((m) => t[m].start <= t[n].start && t[n].start < t[m].end).length);
  assert.ok(maxConcurrent <= 2, `at most 2 at once, saw ${maxConcurrent}`);
});

test('a runner killed mid-gate is recovered: finished steps carried, the rest rerun', async () => {
  const steps = [
    { id: 'fast', repo: 'app', run: 'cat src/a.txt >/dev/null', inputs: ['src/**'] },
    { id: 'slow', repo: 'app', run: 'if [ -f "$WF_ROOT/../slow.marker" ]; then sleep 30; fi', inputs: ['src/**'] },
  ];
  const { base, root } = singleRepoProject('harvest', { gate: { steps } });
  fs.writeFileSync(path.join(root, '..', 'slow.marker'), '');
  const e = admitted(root, base, 'ENG-25');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'h\n' });
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', e.id], { cwd: root, env, stdio: 'ignore' });
  const lock = path.join(root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  const deadline = Date.now() + 30000;
  let progress = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(lock)) continue;
    let runId = null;
    try {
      runId = JSON.parse(fs.readFileSync(lock, 'utf8')).runId;
    } catch {}
    if (!runId) continue;
    const pf = path.join(root, '.wf-evidence', 'attempts', e.id, 'gate', runId, 'progress.json');
    if (fs.existsSync(pf) && JSON.parse(fs.readFileSync(pf, 'utf8')).steps.some((s) => s.id === 'fast')) {
      progress = pf;
      break;
    }
  }
  assert.ok(progress, 'fast step finished before the kill');
  assert.equal(wf(root, ['gate', '--attempt', e.id]).code, 75, 'a live runner is never duplicated');
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  fs.rmSync(path.join(root, '..', 'slow.marker'));
  const g = wf(root, ['gate', '--attempt', e.id]);
  assert.match(g.out, /recovered 1 finished step/);
  let alive = 'alive';
  for (let i = 0; i < 100 && alive === 'alive'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    alive = sh(root, "pgrep -f 'slee[p] 30' >/dev/null && echo alive || echo gone");
  }
  assert.equal(alive, 'gone', 'the dead runner\'s step process was stopped');
  const s = state(root, e.id);
  assert.equal(s.gates.at(-2).status, 'recovered');
  assert.equal(byId(s.lastGate.steps).fast.status, 'reused');
});

test('missing secrets refuse the gate; values are masked in logs', () => {
  const steps = [{ id: 'api', repo: 'app', run: 'echo "token is $API_TOKEN"', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('secrets', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'API_TOKEN', kind: 'provided', usedBy: ['api'], format: { prefix: 'tok_' } }] }) });
  const e = admitted(root, base, 'ENG-26');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 's\n' });
  const g = wf(root, ['gate', '--attempt', e.id]);
  assert.equal(g.code, 75);
  assert.match(g.err, /api needs API_TOKEN/);
  assert.equal(wf(root, ['secrets', 'set', 'API_TOKEN'], { input: 'wrong_123456' }).code, 75, 'format checked');
  ok(wf(root, ['secrets', 'set', 'API_TOKEN'], { input: 'tok_supersecretvalue' }));
  assert.equal((fs.statSync(path.join(root, '.env.local')).mode & 0o777).toString(8), '600');
  const r = gateJson(root, e.id);
  assert.equal(r.code, 0);
  const log = fs.readFileSync(r.data.steps[0].log, 'utf8');
  assert.match(log, /token is \[secret\]/);
  assert.doesNotMatch(log, /supersecretvalue/);
  assert.doesNotMatch(wf(root, ['secrets', 'status']).out, /supersecretvalue/);
});

test('a stored secret reaches only the steps that list it in usedBy', () => {
  const steps = [{ id: 'api', repo: 'app', run: 'echo "own=$OWN_KEY other=$OTHER_KEY"', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('scoped-secrets', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'OWN_KEY', kind: 'provided', usedBy: ['api'] }, { key: 'OTHER_KEY', kind: 'provided', usedBy: [] }] }) });
  const e = admitted(root, base, 'ENG-26b');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 's\n' });
  ok(wf(root, ['secrets', 'set', 'OWN_KEY'], { input: 'own-value-123456' }));
  ok(wf(root, ['secrets', 'set', 'OTHER_KEY'], { input: 'other-value-123456' }));
  const r = gateJson(root, e.id);
  assert.equal(r.code, 0);
  const log = fs.readFileSync(r.data.steps[0].log, 'utf8');
  assert.match(log, /own=\[secret\]/, 'the listed step receives its key');
  assert.match(log, /other=\s*$/m, 'a key no step lists is not injected, so the project\'s own test configuration is not overridden');
});

test('a newer schema is refused with the version to use', () => {
  const { root } = singleRepoProject('schema', { gate: { steps: [] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-27', '--owner', 'o', '--json'])).json();
  const file = path.join(root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl');
  // Rebuild a valid chain that claims a future schema.
  const { canonical, sha256 } = awaitUtil();
  const [first] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  first.data.schemaVersion = 99;
  first.data.engineVersion = '9.0.0';
  delete first.hash;
  first.hash = sha256(canonical(first));
  fs.writeFileSync(file, `${JSON.stringify(first)}\n`);
  const r = wf(root, ['resume', '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /9\.0\.0/);
});

import * as util from '../engine/util.mjs';
function awaitUtil() {
  return util;
}

test('a focused gate is repair proof only: review, accept and delivery need a gate that ran the heavy steps', () => {
  const steps = [
    { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'], tier: 'light' },
    { id: 'e2e', repo: 'app', run: 'true', inputs: ['src/**'], tier: 'heavy' },
  ];
  const { base, root } = singleRepoProject('focused', { focused: ['src/**'], gate: { steps } });
  const e = admitted(root, base, 'ENG-28');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'f\n' });
  const g1 = gateJson(root, e.id, ['--focused']);
  assert.equal(g1.code, 0);
  assert.equal(g1.data.focused, true, 'the run records that it was focused');
  assert.equal(byId(g1.data.steps).e2e.skippedBy, 'focused');
  const refused = wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /focused and skipped e2e/);
  assert.match(state(root, e.id).next, /without --focused/);
  const g2 = byId(gateJson(root, e.id).data.steps);
  assert.equal(g2.unit.status, 'reused', 'light steps that passed in the focused run are reused');
  assert.equal(g2.e2e.status, 'passed');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  assert.equal(gateJson(root, e.id, ['--focused']).code, 0);
  const accept = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(accept.code, 75, 'a newer focused gate is not the full proof of the tree');
  assert.match(accept.err, /focused and skipped e2e/);
});

test('a running gate shows progress: wf gate prints each step as it starts and finishes, wf status shows running and finished steps', async () => {
  const steps = [
    { id: 'fast', repo: 'app', run: 'echo fast-ok' },
    { id: 'slow', repo: 'app', run: 'while [ ! -f "$WF_ROOT/../go" ]; do sleep 0.1; done' },
    { id: 'bad', repo: 'app', run: 'for i in 1 2 3 4 5 6 7; do echo "line$i"; done; exit 1' },
  ];
  const { base, root } = singleRepoProject('live', { gate: { maxParallelSteps: 3, steps } });
  const e = admitted(root, base, 'ENG-29');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'l\n' });
  const outFile = path.join(base, 'gate.out');
  const fd = fs.openSync(outFile, 'w');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome') };
  delete env.CLAUDE_CODE_SESSION_ID;
  const child = spawn(process.execPath, [WF, 'gate', '--attempt', e.id], { cwd: root, env, stdio: ['ignore', fd, fd] });
  const exited = new Promise((r) => child.on('exit', r));
  const read = () => fs.readFileSync(outFile, 'utf8');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(/passed\s+fast/.test(read()) && /failed\s+bad/.test(read()))) await new Promise((r) => setTimeout(r, 100));
  const midway = read();
  assert.match(midway, /start\s+slow/, 'a step start is printed when it starts');
  assert.match(midway, /passed\s+fast\s+\d+\.\ds/, 'a finished step is printed before the gate ends');
  assert.match(midway, /bad \| line7/);
  assert.match(midway, /bad \| line3/);
  assert.doesNotMatch(midway, /bad \| line2/, 'only the last 5 lines of a failing log are printed');
  const status = ok(wf(root, ['status'])).out;
  assert.match(status, /gate running/);
  assert.match(status, /running: slow \(\d+s\)/);
  assert.match(status, /finished: .*fast passed/);
  assert.match(status, /bad failed/);
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /a gate is running/);
  fs.writeFileSync(path.join(root, '..', 'go'), '');
  assert.equal(await exited, 1);
  fs.closeSync(fd);
  assert.match(read(), /passed\s+slow/, 'a failing step does not stop the others');
  assert.equal(byId(state(root, e.id).lastGate.steps).slow.status, 'passed');
  assert.doesNotMatch(ok(wf(root, ['status'])).out, /gate running/);
});
