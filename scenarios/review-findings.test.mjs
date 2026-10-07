// Regression scenarios for the defects found by the first independent engine review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, toAccepted, WF, wf, ownerSpeaks, spawnHome, ownerSession } from './helpers.mjs';

function admitted(root, base, item, extra = []) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json', ...extra])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
}

test('suite reuse never carries a pass when code under test changed', () => {
  const runner = `
const fs=require('fs');const sel=process.argv.slice(2);const all=['tests/a.test','tests/b.test'];const run=sel.length?sel:all;
const lib=fs.readFileSync('src/lib.txt','utf8');const bOk=!fs.readFileSync('tests/b.test','utf8').includes('bad');
const res=f=>f==='tests/a.test'?lib.includes('good'):bOk;
fs.writeFileSync(process.env.WF_EVIDENCE+'/junit.xml','<testsuites><testsuite name="s">'+run.map(f=>'<testcase name="'+f+'" file="'+f+'">'+(res(f)?'':'<failure/>')+'</testcase>').join('')+'</testsuite></testsuites>');
process.exit(run.every(res)?0:1);`;
  const steps = [{ id: 'unit', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: '{evidence}/junit.xml' }, inputs: ['tests/**', 'src/**', 'runner.cjs'] }];
  const { base, root } = singleRepoProject('stale-suite', { gate: { steps } }, { 'runner.cjs': runner, 'tests/a.test': 'a\n', 'tests/b.test': 'b\n', 'src/lib.txt': 'good\n' });
  const e = admitted(root, base, 'RF-1');
  commitIn(e.repos.app.worktree, { 'tests/b.test': 'bad\n' });
  assert.equal(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).code, 1);
  commitIn(e.repos.app.worktree, { 'tests/b.test': 'b fixed\n', 'src/lib.txt': 'broken\n' });
  const g = JSON.parse(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']).out);
  assert.equal(g.status, 'failed', 'a.test must rerun because src/lib.txt changed');
  assert.equal(g.steps[0].rerunSuites, null, 'non-suite input changed: whole step reran');
});

test('two concurrent gates: exactly one runs and the ledger stays intact', async () => {
  const steps = [{ id: 'slow', repo: 'app', run: 'sleep 1', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('concurrent', { gate: { steps } });
  const e = admitted(root, base, 'RF-2');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'c\n' });
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome') , ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k]; // no agent runtime: the scenario is the owner at a terminal (engine/owner.mjs)
  const runOne = () => new Promise((resolve) => {
    ownerSpeaks(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
    const c = spawn(process.execPath, [WF, 'gate', ...OUT_OF_ORDER, '--attempt', e.id], { cwd: root, env });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([runOne(), runOne()]);
  const codes = results.map((r) => r.code).sort();
  assert.deepEqual(codes, [0, 75], JSON.stringify(results));
  assert.match(results.find((r) => r.code === 75).err, /already (running|starting)/);
  ok(wf(root, ['resume', '--attempt', e.id]));
  assert.equal(state(root, e.id).gates.filter((g) => g.status === 'passed').length, 1);
});

test('batch: a member hold blocks the batch; a member author cannot review it; a member changed after joining is refused', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('batch-guards', { gate: { steps } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'RF-3', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'RF-4', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'ob', '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  const byAuthor = wf(root, ['handoff', 'reviewer', '--agent', 'impl-1', '--attempt', b.id]);
  assert.equal(byAuthor.code, 75, 'a member implementer cannot review the batch');
  assert.equal(wf(root, ['handoff', 'reviewer', '--agent', ownerSession('owner-1'), '--attempt', b.id]).code, 75, 'nor a member owner');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  ok(wf(root, ['hold', '--reason', 'legal says wait', '--attempt', m1.id]));
  const held = wf(root, ['deliver', '--attempt', b.id]);
  assert.equal(held.code, 75);
  assert.match(held.err, /legal says wait/);
  ok(wf(root, ['release', '--attempt', m1.id]));
  commitIn(m2.wt, { 'src/b.txt': 'sneaky\n' });
  assert.match(wf(root, ['deliver', '--attempt', b.id]).err, /changed in app after it joined/);
});

test('a previous owner cannot review after someone adopts the attempt', () => {
  const { base, root } = singleRepoProject('adopt-review', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true' }] } });
  const e = admitted(root, base, 'RF-5');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['adopt', '--attempt', e.id, '--owner', 'new-owner']));
  assert.equal(wf(root, ['handoff', 'reviewer', '--agent', ownerSession('o'), '--attempt', e.id]).code, 75);
});

test('a push that landed before the process died is recognised, not refused', () => {
  const { base, root, remote } = singleRepoProject('crash-push', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const { id, wt } = toAccepted(root, base, { item: 'RF-6' });
  sh(wt, 'git push -q origin HEAD:refs/heads/main'); // simulate: push succeeded, nothing recorded
  ok(wf(root, ['deliver', '--attempt', id]));
  const s = state(root, id);
  assert.equal(s.delivery.repos.app.recovered, true);
  assert.equal(s.phase, 'done');
  assert.equal(sh(base, `git --git-dir=${remote} show main:src/a.txt`), 'b');
});

test('delivery.order never drops a repo that has changes', async () => {
  const { deliveryOrder } = await import('../engine/topology.mjs');
  assert.deepEqual(deliveryOrder({ delivery: { order: ['api'] }, components: [] }, ['web', 'api']), ['api', 'web']);
});

test('JUnit reports can be absolute globs under the evidence folder', () => {
  const steps = [{ id: 'unit', repo: 'app', run: `printf '<testsuites><testsuite name="s"><testcase name="t" file="x.test"/></testsuite></testsuites>' > "$WF_EVIDENCE/junit-1.xml"`, report: { junit: '{evidence}/junit-*.xml' } }];
  const { base, root } = singleRepoProject('abs-glob', { gate: { steps } });
  const e = admitted(root, base, 'RF-7');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'g\n' });
  const g = JSON.parse(ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).out);
  assert.deepEqual(g.steps[0].suites.map((s) => s.id), ['x.test']);
});

test('a secret split across output chunks is still masked', () => {
  const secret = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const steps = [{ id: 'api', repo: 'app', run: `node -e "const v=process.env.API_TOKEN;process.stdout.write(v.slice(0,10));setTimeout(()=>process.stdout.write(v.slice(10)+'\\\\n'),300)"` }];
  const { base, root } = singleRepoProject('split', { gate: { steps } }, { '.workflow/secrets.yaml': JSON.stringify({ keys: [{ key: 'API_TOKEN', kind: 'provided', usedBy: ['api'] }] }) });
  ok(wf(root, ['secrets', 'set', 'API_TOKEN'], { input: secret }));
  const e = admitted(root, base, 'RF-8');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 's\n' });
  const g = JSON.parse(ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).out);
  const log = fs.readFileSync(g.steps[0].log, 'utf8');
  assert.doesNotMatch(log, /ABCDEFGHIJ/);
  assert.match(log, /\[secret\]/);
});

test('tracker comments may contain UUIDs and links; a stale "Done" capture does not pass a reopen', async () => {
  const { trackerActions } = await import('../engine/tracker.mjs');
  const cfg = { tracker: { kind: 'linear', statuses: { started: 'In Progress', done: 'Done' } } };
  const reopenSet = trackerActions('/', cfg, { item: 'X-1', criteria: [] }, 'reopened').find((a) => a.op === 'setStatus');
  assert.deepEqual(reopenSet.unless, []);
  const admitSet = trackerActions('/', cfg, { item: 'X-1', criteria: [] }, 'admitted').find((a) => a.op === 'setStatus');
  assert.deepEqual(admitSet.unless, ['Done']);
});

test('ids with path characters are refused', () => {
  const { root } = singleRepoProject('ids', { gate: { steps: [] } });
  assert.equal(wf(root, ['entry', '--item', '../../etc', '--owner', 'o']).code, 1);
});

test('a commit pushed by hand after acceptance is not recorded as delivered', () => {
  const { base, root } = singleRepoProject('hand-push', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const { id, wt } = toAccepted(root, base, { item: 'RF-9' });
  commitIn(wt, { 'src/a.txt': 'UNREVIEWED\n' });
  sh(wt, 'git push -q origin HEAD:refs/heads/main');
  const d = wf(root, ['deliver', '--attempt', id]);
  assert.equal(d.code, 75);
  assert.match(d.err, /pushed outside wf/);
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  assert.equal(wf(root, ['deliver', '--attempt', id]).code, 75, 'still refused after a fresh gate');
  assert.equal(state(root, id).delivery.repos.app, undefined);
});

test('the reviewer can write its closure under the guard hook; evidence is read with the Read tool', async () => {
  const { spawnSync } = await import('node:child_process');
  const hook = path.join(path.dirname(WF), '..', 'hooks', 'guard-evidence.mjs');
  const run = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).status;
  const { base, root } = singleRepoProject('closure-path', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true' }] } });
  const e = admitted(root, base, 'RF-10');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'r\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const h = JSON.parse(ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).out);
  const closurePath = JSON.parse(fs.readFileSync(h.bundle, 'utf8')).reviewClosureFile;
  assert.doesNotMatch(closurePath, /\.wf-evidence/);
  assert.equal(run(`cat > ${closurePath} <<'X'\n{}\nX`), 0);
  assert.equal(run(`grep -r FAIL ${root}/.wf-evidence 2>/dev/null`), 2, 'a shell read of evidence is refused: the Read tool reads it');
  assert.equal(run(`echo x >> ${root}/.wf-evidence/attempts/${e.id}/ledger.jsonl`), 2);
  fs.writeFileSync(closurePath, JSON.stringify(goodClosure('r')));
  ok(wf(root, ['review', '--closure', closurePath, '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
});
