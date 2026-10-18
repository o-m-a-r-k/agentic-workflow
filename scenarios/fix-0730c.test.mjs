// 0.7.30 (stream c): what a repair handoff is handed, the delta's file lists, an amendment's work items and a plan's
// additions. Each test names the failure it reproduces and fails on 0.7.29.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WF, amendFile, closureFile, commitIn, compileCacheDir, criteriaFile, goodClosure, ok, planDoc, sh, singleRepoProject, state, wf } from './helpers.mjs';
import { runner } from './strategist-fixtures.mjs';

const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const handJson = (root, args) => JSON.parse(fs.readFileSync(ok(wf(root, [...args, '--json'])).json().bundle, 'utf8'));
const planFile = (dir, doc) => {
  const f = path.join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};

function planned(name, { steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }], work = null, files = {}, doc = null } = {}) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, ...files });
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-30', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = ok(wf(p.root, ['plan', '--file', doc ? planFile(p.base, doc) : work ? planFile(p.base, planDoc({ plan: 'change a', criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }], work })) : criteriaFile(p.base), '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree, plan };
}

// The whole environment `wf` runs with in a scenario, for a command run in the background.
function startWf(root, args) {
  const env = { NODE_COMPILE_CACHE: compileCacheDir(), ...process.env, WF_NO_FORWARD: '1', WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, ended: new Promise((resolve) => child.once('close', resolve)), text: () => out };
}
const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

// I-162. Named failure (field): a full gate failed one HTTP step, then the owner stopped it for a tree change the repair
// needed. The next implementer handoff carried no `failedGate` (only a gate whose status is `failed` fed it, and this one was
// `stopped`), so the repair agent was handed nothing of the failure the gate had already shown.
test('I-162: a gate stopped after a step failed hands that failure to the repair, with the stop', async () => {
  const lint = { id: 'lint', repo: 'app', run: 'echo "src/a.txt:2 lint: value never read"; exit 1', inputs: ['src/**'] };
  const slow = { id: 'slow', repo: 'app', tier: 'heavy', run: 'touch "$WF_ROOT/../slow-started"; while [ -f "$WF_ROOT/../hold" ]; do sleep 0.2; done', inputs: ['src/**'] };
  const p = planned('i162', { steps: [lint, slow] });
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r0')), '--attempt', p.id]));
  const hold = path.join(p.base, 'hold');
  fs.writeFileSync(hold, '');
  try {
    const gate = startWf(p.root, ['gate', '--attempt', p.id]);
    await until('the slow step to start', () => fs.existsSync(path.join(p.base, 'slow-started')));
    ok(wf(p.root, ['stop', '--class', 'tree-change', '--reason', 'the lint fix is still to commit', '--attempt', p.id]));
    assert.equal(await gate.ended, 1, gate.text());
  } finally {
    fs.rmSync(hold, { force: true });
  }
  const s = state(p.root, p.id);
  assert.equal(s.lastGate.status, 'stopped');
  assert.deepEqual(s.lastGate.steps.map((x) => [x.id, x.status]), [['lint', 'failed'], ['slow', 'interrupted']]);
  assert.match(s.next, /gate stopped \(tree-change: the lint fix is still to commit\)[\s\S]*its bundle carries `failedGate`: the steps that failed before the stop \(lint\)/);
  const b = handJson(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]);
  assert.ok(b.failedGate, 'the stopped gate\'s failure reaches the repair');
  assert.equal(b.failedGate.status, 'stopped');
  assert.deepEqual(b.failedGate.stop, { class: 'tree-change', reason: 'the lint fix is still to commit' });
  assert.deepEqual(b.failedGate.steps.map((x) => x.id), ['lint'], 'only a step that failed: the interrupted one demonstrated nothing');
  assert.ok(b.failedGate.steps[0].outputTail.some((l) => l.includes('src/a.txt:2 lint: value never read')), JSON.stringify(b.failedGate.steps[0]));
  assert.equal(typeof b.failedGate.steps[0].log, 'string');
  assert.equal(b.failedGate.onCurrentTree, true);
});

// I-173. Named failure (field): a combined `wf check` failed on two lint lines; the owner recorded them as a bookkeeping issue
// blocked by the work item and handed that item again. Its bundle held neither the issue (bookkeeping was left out of
// `discovered` and of `alsoFix`) nor the failed check (`failedGate` read gates only), so the implementer reran the whole check
// instead of fixing the two lines, and the owner stopped it and sent the failure by hand.
test('I-173: a repair handoff carries the failed check and the open bookkeeping issue blocked by its work item', () => {
  const lint = { id: 'lint', repo: 'app', run: 'if grep -q bad src/a.txt; then echo "src/a.txt:1 lint: no bad words"; exit 1; fi', inputs: ['src/**'] };
  const p = planned('i173', { steps: [lint], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], why: 'the change' }] });
  ok(wf(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': 'bad\n' });
  assert.equal(wf(p.root, ['check', '--attempt', p.id]).code, 1);
  ok(wf(p.root, ['discovered', 'add', '--summary', 'lint: src/a.txt:1 no bad words', '--kind', 'bookkeeping', '--severity', 'low', '--blocked-by', 'W1', '--found-by', 'i', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--outcome', 'stopped', '--attempt', p.id]));

  const b = handJson(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i2', '--attempt', p.id]);
  assert.ok(b.failedCheck, 'the failed check reaches the next implementer');
  assert.deepEqual(b.failedCheck.steps.map((x) => x.id), ['lint']);
  assert.ok(b.failedCheck.steps[0].outputTail.some((l) => l.includes('src/a.txt:1 lint: no bad words')));
  assert.equal(b.failedGate, undefined, 'no gate ran');
  assert.deepEqual(b.discovered.filter((d) => d.kind === 'bookkeeping').map((d) => [d.id, d.blockedBy]), [['D1', 'W1']], 'the bookkeeping issue is the implementer\'s to fix');
  assert.match(b.instructions, /`failedCheck`/);
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--outcome', 'stopped', '--attempt', p.id]));

  // A fix round (a finding that blocks) lists it in `alsoFix` as well.
  const r = handJson(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]);
  assert.ok(!(r.discovered ?? []).some((d) => d.kind === 'bookkeeping'), 'never a reviewer\'s verdict item');
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { findings: [{ id: 'F1', severity: 'high', summary: 'a shows the old text', status: 'open', evidence: 'src/a.txt:1', criterion: 'C1' }] })), '--attempt', p.id]));
  const fix = handJson(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i3', '--attempt', p.id]);
  assert.ok(fix.repair);
  assert.deepEqual(fix.alsoFix.map((x) => [x.ref, x.kind, x.blockedBy]), [['D1', 'discovered', 'W1']]);
  // The course is unchanged: a bookkeeping issue opens no planned pass of its own.
  assert.doesNotMatch(state(p.root, p.id).next, /item\(s\) that do not block/);
});

// I-166. Named failure (field): a delta round kept an earlier high finding open with a newly reproduced failure as its evidence
// (`priorFindings`). The next fix round was handed the finding as first raised, about a case already fixed, and not that
// latest reproduction, so the implementer read it as fixed and asked for context.
test('I-166: a finding a later round kept open is handed with that round\'s evidence, beside the finding as raised', () => {
  const p = planned('i166');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { findings: [{ id: 'F1', severity: 'high', summary: 'the historical date is wrong', status: 'open', evidence: 'src/a.txt:2 historical date', criterion: 'C1' }] })), '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2').replace('l3', 'L3') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'open', evidence: 'src/a.txt:3 a cold caller still gets the old lifecycle' }] })), '--attempt', p.id]));
  const b = handJson(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]);
  const f = b.repair.flatMap((g) => g.findings).find((x) => x.ref === 'r1:F1');
  assert.equal(f.summary, 'the historical date is wrong', 'the finding keeps its identity and its words');
  assert.equal(f.evidence, 'src/a.txt:2 historical date');
  assert.equal(f.stillOpen?.by, 'r2');
  assert.equal(f.stillOpen?.evidence, 'src/a.txt:3 a cold caller still gets the old lifecycle');
  const h = b.findingHistory.find((x) => x.ref === 'r1:F1');
  assert.equal(h.status, 'open');
  assert.deepEqual([h.stillOpen?.by, h.stillOpen?.evidence], ['r2', 'src/a.txt:3 a cold caller still gets the old lifecycle']);
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--outcome', 'stopped', '--attempt', p.id]));
  // The delta reviewer after it sees it too.
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2').replace('l3', 'L3').replace('l4', 'L4') });
  const r = handJson(p.root, ['handoff', 'reviewer', '--agent', 'r3', '--attempt', p.id]);
  assert.equal(r.openFindings.find((x) => `${x.round}:${x.id}` === 'r1:F1').stillOpen.by, 'r2');
});

// I-165. Named failure (field): an amendment added a criterion while the work item that would build it kept its older list;
// the implementer handed that item built only the finding it was handed and reported nothing left, with the amended
// criterion named by no work item. The owner caught it before the review.
test('I-165: an amendment that adds a criterion no work item names is refused with the way on (admitted from 0.7.30)', () => {
  const work = [{ id: 'W1', criteria: ['C1'], repos: ['app'], why: 'the change' }];
  const C2 = { id: 'C2', text: 'dates show in the calendar\'s locale', uat: 'the calendar shows local dates' };
  const C1 = { id: 'C1', text: 'a changes', uat: 'a shows the new text' };
  const admit = (run, name) => {
    const p = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
    const e = ok(run(p.root, ['entry', '--item', 'ENG-31', '--owner', 'o', '--json'])).json();
    ok(run(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
    ok(run(p.root, ['plan', '--file', planFile(p.base, planDoc({ plan: 'change a', criteria: [C1], work })), '--attempt', e.id]));
    ok(run(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i', '--attempt', e.id]));
    return { ...p, id: e.id };
  };
  const { run } = runner('0.7.30');
  const p = admit(run, 'i165');
  const refused = run(p.root, ['criteria', 'amend', '--file', amendFile(p.base, [C1, C2]), '--reason', 'the person asked for local dates', '--attempt', p.id]);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /the amendment adds C2, which no work item names \(work items: W1 \[C1\]\)/);
  assert.match(refused.err, /restate `work` in the amendment file with C2 in the work item that builds it/);
  const restated = run(p.root, ['criteria', 'amend', '--file', amendFile(p.base, [C1, C2], { work }), '--reason', 'the person asked for local dates', '--attempt', p.id]);
  assert.equal(restated.code, 75, 'work restated without the new criterion is refused the same way');
  assert.match(restated.err, /the amendment adds C2, which no work item names/);
  ok(run(p.root, ['criteria', 'amend', '--file', amendFile(p.base, [C1, C2], { work: [{ ...work[0], criteria: ['C1', 'C2'] }] }), '--reason', 'the person asked for local dates', '--attempt', p.id]));
  assert.deepEqual(JSON.parse(fs.readFileSync(ok(run(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i2', '--attempt', p.id, '--json'])).json().bundle, 'utf8')).work.criteria, ['C1', 'C2']);
  // D7: an attempt admitted earlier keeps amending as before.
  const old = runner('0.7.29');
  const q = admit(old.run, 'i165-old');
  ok(old.run(q.root, ['criteria', 'amend', '--file', amendFile(q.base, [C1, C2], { work }), '--reason', 'the person asked for local dates', '--attempt', q.id]));
});

// I-168. Named failure (field): a code-review closure named a native verification it did not reach; `wf base merge` then made
// the next round a fresh review, and the implementer handed after it had no word of the unreached scope (only reviewers
// were handed `unreachedBefore`), so it reran checks that already passed. The owner stopped it and restated the gap by hand.
test('I-168: scope an earlier round did not reach is handed to the implementer too, across a base merge', () => {
  const p = planned('i168');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1', { notReached: ['the native share sheet on a device'] })), '--attempt', p.id]));
  commitIn(p.root, { 'src/other.txt': 'main\n' }, 'another ticket on main');
  sh(p.root, 'git push -q origin main');
  ok(wf(p.root, ['base', 'merge', '--attempt', p.id]));
  const b = handJson(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]);
  assert.deepEqual(b.unreachedBefore?.rounds.map((r) => [r.reviewer, r.notReached]), [['r1', ['the native share sheet on a device']]]);
  assert.match(b.unreachedBefore.note, /not verified by any review/);
  assert.equal(b.reviewClosureFile, null);
});

// I-167. Named failure (field): after a base merge a delta reviewer's bundle listed six changed files while `delta.diff`, the
// command it was handed, showed forty-one: the files the base merge brought in were in the diff and in no list, and the
// reviewer recorded the discrepancy instead of reviewing.
test('I-167: a delta after a base merge lists the files the merge brought in apart from the attempt\'s own, and says which is which', () => {
  const p = planned('i167');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('r1')), '--attempt', p.id]));
  commitIn(p.root, { 'src/other.txt': 'main\n', 'src/third.txt': 'main\n' }, 'another ticket on main');
  sh(p.root, 'git push -q origin main');
  ok(wf(p.root, ['base', 'merge', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2').replace('l5', 'L5') });
  const b = handJson(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id]);
  assert.equal(b.mode, 'delta');
  assert.deepEqual(b.delta.changed.app, ['src/a.txt'], 'the attempt\'s own files');
  assert.deepEqual(b.delta.baseMerged?.app, ['src/other.txt', 'src/third.txt'], 'the files in the diff that only the base merge brought in');
  const inDiff = sh(p.wt, b.delta.diff.app.replace(/^git -C \S+ diff /, 'git diff --name-only ')).split('\n').filter(Boolean).sort();
  assert.deepEqual(inDiff, [...b.delta.changed.app, ...b.delta.baseMerged.app].sort(), 'the two lists are every file of the diff');
  assert.match(b.instructions, /`delta\.baseMerged`/);
});

// I-159. Named failure (field): a hotfix asked as "fast, with the existing inbox" was planned with a new ledger, a migration,
// revision updates, retry backoff and retention: 180 minutes nobody asked for, seen only when the person read the plan. The
// planner was told never to plan narrower than asked, and nothing asked it to name what it planned beyond.
test('I-159: a plan names what it adds beyond the request and why; `wf plan` prints it and reviewers see it', () => {
  const beyondAsked = [{ what: 'a retry with backoff for the alert', why: 'the inbox write can fail under load and the alert would be lost' }];
  const p = planned('i159', { doc: planDoc({ plan: 'add the completion alert to the existing inbox', criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }], beyondAsked }) });
  assert.match(p.plan.out, /beyond what was asked \(tell the person\): a retry with backoff for the alert \(the inbox write can fail under load and the alert would be lost\)/);
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') });
  const r = handJson(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]);
  assert.deepEqual(r.plan.beyondAsked, beyondAsked);
});
