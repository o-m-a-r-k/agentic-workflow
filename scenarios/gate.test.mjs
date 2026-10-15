import { test } from 'node:test';
import { globsCovered } from '../engine/gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ENGINE_VERSION, semverLt } from '../engine/util.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, WF, wf, write, yaml, ownerSpeaks, spawnHome } from './helpers.mjs';

function admitted(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
}

const gateJson = (root, id, extra = []) => {
  const r = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id, '--json', ...extra]);
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

// I-150, named failure (audit of 51 attempts): 163 reruns had a key another attempt had already passed; reuse read only the
// attempt's own runs.
test('a pass another attempt recorded under the same key is reused; a step that keeps evidence, or a file outside its inputs that differs, reruns', () => {
  const steps = [
    { id: 'unit', repo: 'app', run: 'echo x >> ../ran-unit.txt', inputs: ['src/**'] },
    { id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/a.png && echo x >> ../ran-ui.txt', inputs: ['src/**'], artifacts: ['shots/*.png'] },
  ];
  const { base, root } = singleRepoProject('reuse-across', { gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const counts = (wt) => Object.fromEntries(['unit', 'ui'].map((k) => [k, fs.existsSync(`${wt}/../ran-${k}.txt`) ? fs.readFileSync(`${wt}/../ran-${k}.txt`, 'utf8').trim().split('\n').length : 0]));
  const a = admitted(root, base, 'ENG-30');
  commitIn(a.repos.app.worktree, { 'src/a.txt': 'same\n' });
  assert.equal(gateJson(root, a.id).code, 0);
  assert.deepEqual(counts(a.repos.app.worktree), { unit: 1, ui: 1 });
  const b = admitted(root, base, 'ENG-31');
  commitIn(b.repos.app.worktree, { 'src/a.txt': 'same\n' });
  const gb = gateJson(root, b.id);
  assert.equal(gb.code, 0, gb.err);
  const sb = byId(gb.data.steps);
  assert.equal(sb.unit.status, 'reused');
  assert.equal(sb.unit.reusedFromAttempt, a.id);
  assert.match(sb.unit.reason, new RegExp(`in ${a.id}`));
  assert.equal(sb.ui.status, 'passed', 'a step that keeps evidence files runs for its own ticket');
  assert.deepEqual(counts(b.repos.app.worktree), { unit: 0, ui: 1 }, "the reused step did not run here");
  // Its log is copied into this attempt's evidence, so releasing the attempt it came from loses no proof.
  assert.ok(sb.unit.log.includes(`${path.sep}${b.id}${path.sep}`) && fs.existsSync(sb.unit.log), sb.unit.log);
  ok(wf(root, ['abandon', '--reason', 'scenario', '--attempt', a.id]));
  ok(wf(root, ['evidence', 'release', '--attempt', a.id, '--reason', 'scenario']));
  assert.ok(fs.existsSync(sb.unit.log));
  assert.match(ok(wf(root, ['verify', '--attempt', b.id])).out, /verified|match/);
  const c = admitted(root, base, 'ENG-32');
  commitIn(c.repos.app.worktree, { 'src/a.txt': 'same\n', 'lib/b.txt': 'outside the inputs\n' });
  const sc = byId(gateJson(root, c.id).data.steps);
  assert.equal(sc.unit.status, 'passed', 'a file the inputs leave out differs from the run it would reuse');
});

// The person's rule (2026-10-15): "hotfixes should be quick fixes, not ones that take hours"; the review stays. A quick fix's
// gate runs the light steps, and it counts for acceptance and delivery.
test('a quick fix runs light steps only, and that gate counts; --full runs the heavy ones too', async () => {
  const { gatePassedForCurrentTree } = await import('../engine/gate.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  const steps = [
    { id: 'unit', repo: 'app', run: 'echo x >> ../ran-unit.txt', inputs: ['src/**'] },
    { id: 'e2e', repo: 'app', tier: 'heavy', run: 'echo x >> ../ran-e2e.txt', inputs: ['src/**'] },
  ];
  const { base, root } = singleRepoProject('quick-light', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fix\n' });
  const g = gateJson(root, e.id);
  assert.equal(g.code, 0, g.err);
  const s = byId(g.data.steps);
  assert.equal(s.unit.status, 'passed');
  assert.equal(s.e2e.status, 'skipped');
  assert.equal(s.e2e.skippedBy, 'quick-lane');
  assert.ok(!fs.existsSync(`${e.repos.app.worktree}/../ran-e2e.txt`), 'the heavy step did not run');
  assert.equal(gatePassedForCurrentTree(loadState(root, e.id)).ok, true, 'the quick fix gate counts');
  const full = byId(gateJson(root, e.id, ['--full']).data.steps);
  assert.equal(full.e2e.status, 'passed');
  // Independent review of 0.7.13: the evidence reviewer is told what did not run, and a known failure is never skipped.
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'fix 2\n' });
  const fresh = byId(gateJson(root, e.id).data.steps);
  assert.equal(fresh.e2e.skippedBy, 'quick-lane');
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  const handed = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(handed.bundle, 'utf8'));
  assert.deepEqual(bundle.gate.notRun.map((x) => x.step), ['e2e']);
  const broken = singleRepoProject('quick-known-failure', { gate: { steps: [steps[0], { ...steps[1], run: 'exit 1' }] } });
  const k = ok(wf(broken.root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(broken.root, ['plan', '--file', criteriaFile(broken.base), '--attempt', k.id]));
  ok(wf(broken.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', k.id]));
  commitIn(k.repos.app.worktree, { 'src/a.txt': 'fix\n' });
  assert.equal(byId(gateJson(broken.root, k.id, ['--full']).data.steps).e2e.status, 'failed');
  const again = gateJson(broken.root, k.id);
  assert.notEqual(again.code, 0, 'a heavy step that failed on these inputs runs again and fails, not skipped into a pass');
  assert.equal(byId(again.data.steps).e2e.status, 'failed');
  // A project may run every step in its quick fixes.
  const own = singleRepoProject('quick-full', { gate: { quickLane: 'full', steps } });
  const q = ok(wf(own.root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(own.root, ['plan', '--file', criteriaFile(own.base), '--attempt', q.id]));
  ok(wf(own.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', q.id]));
  commitIn(q.repos.app.worktree, { 'src/a.txt': 'fix\n' });
  assert.equal(byId(gateJson(own.root, q.id).data.steps).e2e.status, 'passed');
  const bad = singleRepoProject('quick-bad', { gate: { quickLane: 'none', steps } });
  assert.match(wf(bad.root, ['doctor']).err + wf(bad.root, ['doctor']).out, /`gate.quickLane` is `light`/);
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
  const forced = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'], { env: { WF_WORKERS_UNIT: '3' } });
  assert.equal(JSON.parse(forced.out).steps[0].workers.n, 3);
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'w3\n' });
  const bad = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id], { env: { WF_WORKERS_UNIT: 'lots' } });
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
  // 0.7.11: the adapter folder no longer forces a full run: the gate reads its steps at the pin, never the worktree copy.
  assert.equal(g.data.full, false);
  assert.equal(g.data.steps[0].status, 'failed');
});

test('JUnit suites are recorded per suite, and `select` reruns only failed or changed suites', () => {
  const script = `
const fs=require('fs');const sel=process.argv.slice(2);
const fail=fs.readFileSync('tests/b.test.js','utf8').includes('bad');
const all=['tests/a.test.js','tests/b.test.js'];const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const cases=run.map(f=>'<testcase classname="x" name="'+f+'" file="'+f+'">'+(f==='tests/b.test.js'&&fail?'<failure/>':'')+'</testcase>').join('');
fs.writeFileSync(process.env.WF_EVIDENCE+'/junit.xml','<testsuites><testsuite name="s">'+cases+'</testsuite></testsuites>');
process.exit(run.includes('tests/b.test.js')&&fail?1:0);`;
  // Suite files named with an infix (`.test.js`): from a JUnit report, which names only the suites that ran, the gate
  // can tell which other inputs are suites (0.7.6); a file named by its extension alone reruns the step whole.
  const steps = [{ id: 'unit', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: '{evidence}/junit.xml' }, inputs: ['tests/**', 'runner.cjs'] }];
  const { base, root } = singleRepoProject('junit', { gate: { steps } }, { 'runner.cjs': script, 'tests/a.test.js': 'a\n', 'tests/b.test.js': 'b\n' });
  const e = admitted(root, base, 'ENG-23');
  commitIn(e.repos.app.worktree, { 'tests/b.test.js': 'bad\n' });
  const g1 = gateJson(root, e.id);
  assert.equal(g1.code, 1);
  assert.deepEqual(g1.data.steps[0].suites.map((s) => `${s.id}:${s.status}`).sort(), ['tests/a.test.js:passed', 'tests/b.test.js:failed']);
  commitIn(e.repos.app.worktree, { 'tests/b.test.js': 'good\n' });
  const g2 = gateJson(root, e.id);
  assert.equal(g2.code, 0);
  // Steps write into their scratch folder (WF_EVIDENCE), outside the evidence; its parent is the run's scratch folder.
  const ran = fs.readFileSync(path.join(root, '.wf-worktrees', '_gate', e.id, g2.data.runId, 'ran.txt'), 'utf8').trim();
  assert.equal(ran, 'tests/b.test.js', 'only the failed/changed suite reran');
  assert.ok(g2.data.steps[0].suites.find((s) => s.id === 'tests/a.test.js').carried, 'the passing suite is carried');
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

// Named failure: a machine-wide sleep probe blamed an unrelated parallel scenario for a surviving gate child.
// Inspect the recorded gate process groups, and keep an unrelated sleeper alive as the regression witness.
test('a runner killed mid-gate is recovered: finished steps carried, the rest rerun', async (t) => {
  const steps = [
    { id: 'fast', repo: 'app', run: 'cat src/a.txt >/dev/null', inputs: ['src/**'] },
    { id: 'slow', repo: 'app', run: 'if [ -f "$WF_ROOT/../slow.marker" ]; then sleep 30 & fixture_sleep_pid=$!; echo "$fixture_sleep_pid" > "$WF_ROOT/../slow.pid"; wait "$fixture_sleep_pid"; fi', inputs: ['src/**'] },
  ];
  const { base, root } = singleRepoProject('harvest', { gate: { steps } });
  let gateChild = null, gateEnded = null, attemptId = null;
  const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' });
  const unrelatedEnded = new Promise((resolve) => unrelated.once('close', resolve));
  t.after(async () => {
    if (gateChild) {
      if (gateChild.exitCode === null && gateChild.signalCode === null) gateChild.kill('SIGTERM');
      await gateEnded;
    }
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGTERM');
    await unrelatedEnded;
    if (attemptId) {
      ok(wf(root, ['abandon', '--attempt', attemptId, '--reason', 'scenario cleanup']));
      ok(wf(root, ['evidence', 'release', '--attempt', attemptId, '--reason', 'scenario cleanup']));
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, '..', 'slow.marker'), '');
  const e = admitted(root, base, 'ENG-25');
  attemptId = e.id;
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'h\n' });
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k]; // no agent runtime: the scenario is the owner at a terminal (engine/owner.mjs)
  ownerSpeaks(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
  const child = spawn(process.execPath, [WF, 'gate', ...OUT_OF_ORDER, '--attempt', e.id], { cwd: root, env, stdio: 'ignore' });
  gateChild = child;
  gateEnded = new Promise((resolve) => child.once('close', resolve));
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
    if (fs.existsSync(pf) && JSON.parse(fs.readFileSync(pf, 'utf8')).steps.some((s) => s.id === 'fast') && fs.existsSync(path.join(base, 'slow.pid'))) {
      progress = pf;
      break;
    }
  }
  assert.ok(progress, 'fast step finished before the kill');
  assert.equal(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).code, 75, 'a live runner is never duplicated');
  const groups = new Set(JSON.parse(fs.readFileSync(lock, 'utf8')).children);
  const slowPid = Number(fs.readFileSync(path.join(base, 'slow.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(slowPid) && slowPid > 0);
  const slowGroup = Number(sh(root, `ps -o pgid= -p ${slowPid}`).trim());
  assert.ok(groups.has(slowGroup), 'the live sleeper belongs to a recorded gate process group');
  child.kill('SIGKILL');
  await gateEnded;
  fs.rmSync(path.join(root, '..', 'slow.marker'));
  const g = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
  // The first command to take the lock recovers the dead runner's finished step. The out-of-order run is a new run, and an
  // approval is used once (the dead one's was spent), so that command asks again and the scripted owner re-runs it: the
  // recovery line is printed by the refused attempt, and the ledger below is what proves it.
  assert.equal(g.code, 0, g.err);
  let running = true;
  for (let i = 0; i < 100 && running; i++) {
    await new Promise((r) => setTimeout(r, 100));
    running = sh(root, 'ps -axo pgid=,stat=').trim().split('\n').some((line) => {
      const [group, status] = line.trim().split(/\s+/);
      // A zombie is stopped; it cannot execute while waiting for the platform's reaper.
      return groups.has(Number(group)) && status && !status.startsWith('Z');
    });
  }
  assert.equal(running, false, 'the dead runner\'s entire step process group was stopped');
  assert.equal(unrelated.exitCode, null, 'an unrelated sleeper remains running');
  assert.equal(unrelated.signalCode, null, 'recovery never signals an unrelated process');
  const s = state(root, e.id);
  assert.equal(s.gates.at(-2).status, 'recovered');
  assert.equal(byId(s.lastGate.steps).fast.status, 'reused');
});

test('missing secrets refuse the gate; values are masked in logs', () => {
  const steps = [{ id: 'api', repo: 'app', run: 'echo "token is $API_TOKEN"', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('secrets', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'API_TOKEN', kind: 'provided', usedBy: ['api'], format: { prefix: 'tok_' } }] }) });
  const e = admitted(root, base, 'ENG-26');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 's\n' });
  const g = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
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
  // As a future engine would, it also moves the chain-head anchor (without that, the rewrite is refused as tampering).
  const anchor = path.join(root, '.wf-worktrees', '_anchor', `${e.id}.json`);
  fs.chmodSync(anchor, 0o644);
  fs.writeFileSync(anchor, JSON.stringify({ attempt: e.id, seq: first.seq, hash: first.hash }));
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
  const h = JSON.parse(ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).out);
  assert.equal(JSON.parse(fs.readFileSync(h.bundle, 'utf8')).gate.passedOnThisTree, false, 'a focused gate is not gate evidence for the reviewer');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  assert.match(state(root, e.id).next, /^clean code review on this tree: the last gate was focused \(skipped e2e\): run one `wf gate` without --focused/);
  const early = wf(root, ['accept', '--attempt', e.id]);
  assert.equal(early.code, 75);
  assert.match(early.err, /focused and skipped e2e/);
  const g2 = byId(gateJson(root, e.id).data.steps);
  assert.equal(g2.unit.status, 'reused', 'light steps that passed in the focused run are reused');
  assert.equal(g2.e2e.status, 'passed');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', e.id]));
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
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k]; // no agent runtime: the scenario is the owner at a terminal (engine/owner.mjs)
  ownerSpeaks(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
  const child = spawn(process.execPath, [WF, 'gate', ...OUT_OF_ORDER, '--attempt', e.id], { cwd: root, env, stdio: ['ignore', fd, fd] });
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

// Named failure (I-88): lease capacity was pinned with the admission adapter, so raising `gate.leases` in the project could not
// unblock a check queued behind another stack; the attempt had to be superseded. Capacity is read from the project's
// current config while the step waits, and the capacity used is recorded when it differs from the pinned one.
test('a check queued on a full lease starts when the project raises the lease capacity', async () => {
  const steps = [{ id: 'stack', repo: 'app', run: 'true', lease: 'docker', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('lease-raise', { gate: { leases: { docker: 1 }, steps } });
  const e = admitted(root, base, 'ENG-26');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'l\n' });
  const home = path.join(root, '..', '.wfhome');
  const leases = path.join(home, 'leases');
  fs.mkdirSync(leases, { recursive: true });
  fs.writeFileSync(path.join(leases, 'docker.1'), String(process.pid));
  const env = { ...process.env, WF_CONFIG_HOME: home, ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, 'check', '--attempt', e.id], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => child.once('close', resolve));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(child.exitCode, null, 'the check waits while the only docker slot is held');
  const file = path.join(root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, yaml({ ...cfg, gate: { ...cfg.gate, leases: { docker: 2 } } }));
  const code = await Promise.race([ended, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
  if (code === 'timeout') child.kill('SIGKILL');
  fs.rmSync(path.join(leases, 'docker.1'), { force: true });
  assert.equal(code, 0, out);
  assert.match(out, /lease docker: capacity 2 from the project config \(the admission adapter pinned 1\)/);
  assert.deepEqual(state(root, e.id).checks.at(-1).leaseCapacity, { docker: { capacity: 2, pinned: 1 } });
});

// Named failure (I-73): a step's dependencies needed a registry token only the gate injects, while `wf check` refuses a dirty
// worktree and the project asks for lint and tests before the first commit. `wf run --step` runs a preparation command with
// that step's secrets, masked, and leaves no gate evidence.
test('wf run --step runs a command in the step\'s package with only that step\'s secrets, masked, and records no gate', () => {
  const prepare = 'echo "token=$REGISTRY_TOKEN other=$OTHER_KEY dir=$(pwd)"; echo "err $REGISTRY_TOKEN" >&2';
  const steps = [{ id: 'api', repo: 'app', run: 'true', inputs: ['src/**'], prepare }, { id: 'other', repo: 'app', run: 'true', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('prepare-step', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'REGISTRY_TOKEN', kind: 'provided', usedBy: ['api'] }, { key: 'OTHER_KEY', kind: 'provided', usedBy: ['other'] }] }) });
  const e = admitted(root, base, 'ENG-27b');
  // Security review of 0.7.0: a command typed here never receives the step's secrets; only the declared `prepare` runs.
  const typed = wf(root, ['run', '--step', 'api', '--attempt', e.id, '--', 'sh', '-c', 'printenv']);
  assert.equal(typed.code, 75);
  assert.match(typed.err, /runs only the step's declared `prepare` command/);
  assert.match(wf(root, ['run', '--step', 'other', '--attempt', e.id]).err, /declares no `prepare` command/);
  const missing = wf(root, ['run', '--step', 'api', '--attempt', e.id]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /secrets missing for step api: REGISTRY_TOKEN/);
  ok(wf(root, ['secrets', 'set', 'REGISTRY_TOKEN'], { input: 'registry-value-123456' }));
  ok(wf(root, ['secrets', 'set', 'OTHER_KEY'], { input: 'other-value-123456' }));
  write(e.repos.app.worktree, 'src/dirty.txt', 'uncommitted\n');
  const r = ok(wf(root, ['run', '--step', 'api', '--attempt', e.id]));
  assert.match(r.out, /token=\[secret\] other= dir=/, 'only the step\'s own key, masked');
  assert.match(r.out, new RegExp(`dir=${fs.realpathSync(e.repos.app.worktree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'in the step\'s package directory of the worktree');
  assert.match(r.err, /err \[secret\]/);
  assert.doesNotMatch(`${r.out}${r.err}`, /registry-value/);
  const s = state(root, e.id);
  assert.deepEqual([s.gates.length, s.checks.length], [0, 0], 'preparation is never gate or check evidence');
  assert.match(wf(root, ['run', '--step', 'nope', '--attempt', e.id]).err, /no gate step `nope`/);
});

// Named failure (I-92): a check stopped by the owner because the tree is about to change ended as `stopped` with no reason, and
// the implementer ran the same check again on the unchanged tree, queued behind an unrelated stack. The stop class and
// reason now appear in the check's own output; from 0.7.0 a retry waits for a new commit.
test('a check stopped for a tree change says why, and is not retried on the unchanged tree', async () => {
  const steps = [{ id: 'slow', repo: 'app', run: 'if [ -f "$WF_ROOT/../slow.marker" ]; then sleep 30; fi', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('stopped-check', { gate: { steps } });
  const e = admitted(root, base, 'ENG-28');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'c1\n' });
  fs.writeFileSync(path.join(root, '..', 'slow.marker'), '');
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, 'check', '--attempt', e.id], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => child.once('close', resolve));
  const lock = path.join(root, '.wf-evidence', 'attempts', e.id, 'gate', 'gate.lock');
  for (let i = 0; i < 100; i++) {
    try {
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).children.length >= 1) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(wf(root, ['stop', '--class', 'tree-change', '--reason', 'D61 still to fix', '--attempt', e.id]));
  assert.equal(await ended, 1);
  assert.match(out, /check stopped — stopped by the owner \(tree-change: D61 still to fix\)/);
  assert.deepEqual(state(root, e.id).checks.at(-1).stop, { class: 'tree-change', reason: 'D61 still to fix' });
  fs.rmSync(path.join(root, '..', 'slow.marker'));
  const retry = wf(root, ['check', '--attempt', e.id]);
  if (semverLt(ENGINE_VERSION, '0.7.0')) assert.equal(retry.code, 0, 'before 0.7.0 the retry runs');
  else {
    assert.equal(retry.code, 75);
    assert.match(retry.err, /the last check was stopped by the owner \(tree-change: D61 still to fix\) and the tree has not changed since/);
    commitIn(e.repos.app.worktree, { 'src/a.txt': 'c2\n' });
    assert.equal(wf(root, ['check', '--attempt', e.id]).code, 0, 'a new commit lifts it');
  }
});

// 0.7.11, named failure (audit of 51 attempts): gates started while an implementer was still committing were stopped or
// thrown away. A gate says so when an implementer is open: a warning, never a refusal (its own `wf check` runs then).
test('a gate started while an implementer is open warns that the tree may still change', () => {
  const { base, root } = singleRepoProject('gate-open-impl', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const e = admitted(root, base, 'ENG-77');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  assert.match(g.out, /wf gate: warning: implementer i is still open; if it may still commit, this gate runs on a tree that will change: close it first/);
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  assert.doesNotMatch(ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id])).out, /is still open/);
});

// Independent review of 0.7.11: a step that runs a script in the workflow folder depends on it, though the folder is not the
// project's code; and a widened evidence glob is never read as a narrowed one.
test('a step that runs a script in the workflow folder reruns when it changes; widened globs are not covered', () => {
  const steps = [{ id: 'wfscript', repo: 'app', run: 'bash .workflow/check.sh', inputs: ['**'] }];
  const { base, root } = singleRepoProject('gate-own-script', { gate: { steps } }, { '.workflow/check.sh': 'exit 0\n' });
  const e = admitted(root, base, 'ENG-78');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  assert.equal(gateJson(root, e.id, OUT_OF_ORDER).data.steps[0].status, 'passed');
  commitIn(e.repos.app.worktree, { '.workflow/check.sh': 'exit 1\n' });
  const g = gateJson(root, e.id, OUT_OF_ORDER);
  assert.equal(g.data.steps[0].status, 'failed', 'the changed script ran');
  assert.equal(globsCovered(['shots/t-1/**/*.png'], ['shots/**/*.png']), true, 'narrowed');
  assert.equal(globsCovered(['shots/**/x/*.png'], ['shots/*/x/*.png']), false, 'widened: deeper files were never collected');
  assert.equal(globsCovered(['shots/**/*.png'], ['shots/t-1/**/*.png']), false);
});
