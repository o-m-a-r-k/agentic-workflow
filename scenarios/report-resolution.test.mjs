import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, goodClosure, commitIn, ok, ownerSays, planDoc, sh, singleRepoProject, state, wf } from './helpers.mjs';

// Named failure I-42: immutable reports of completed repair rounds and concurrency
// ownership were mistaken for current, unrecorded defects at the next review.
function project(name) {
  const { base, root } = singleRepoProject(name, { gate: { steps: [] } });
  const entry = ok(wf(root, ['entry', '--item', 'ENG-842', '--owner', 'owner', '--json'])).json();
  const id = entry.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'planner', '--attempt', id]));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: 'repair', criteria: [{ id: 'C1', text: 'correct output', uat: 'check output' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'full', why: 'repair' }, { id: 'W2', criteria: ['C1'], repos: ['app'], class: 'light', why: 'fixture' }] })));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-old', '--runtime', 'claude', '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-other', '--runtime', 'claude', '--attempt', id]));
  return { root, id, wt: entry.repos.app.worktree };
}

function report(p, agent, text, at = new Date().toISOString()) {
  const dir = path.join(p.root, '..', '.home', '.claude', 'projects', '-project', 'owner', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent-' + agent + '.jsonl');
  const agentType = state(p.root, p.id).handoffs.find((h) => h.agent === agent).agentType;
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ name: agent, agentType }));
  fs.writeFileSync(file, [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Read the bundle.' } }, { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text }] } }].map((e) => JSON.stringify(e)).join('\n'));
  return file;
}

const review = (p, agent = 'reviewer') => wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--runtime', 'codex', '--attempt', p.id]);

test('I-42: completed historical follow-ups and known concurrency ownership allow a fresh reviewer', () => {
  const p = project('completed-report');
  report(p, 'impl-old', 'Both follow-ups are done and committed.\nFinal integration is done and wf check passed.\nLeft alone: W2\'s files, owned by another active implementer.\nI left it alone because another active implementer was editing it.\nNo deferred work.\nNo out of scope issues.');
  report(p, 'impl-other', 'Both follow-ups are completed.');
  commitIn(p.wt, { 'src/a.txt': 'fixed\n' });
  ok(review(p));
  const s = state(p.root, p.id);
  assert.equal(s.implementers.filter((i) => !i.closedAt).length, 0);
  assert.equal(s.handoffs.at(-1).role, 'reviewer');
});

test('I-42: completed work, negation, ownership and closure do not conceal unresolved defects', () => {
  const p = project('unresolved-report');
  commitIn(p.wt, { 'src/a.txt': 'changed\n' });
  for (const text of [
    'Both follow-ups are done and committed; not fixed: the total is wrong.',
    'Both follow-ups are done and committed, but the total is not fixed.',
    'No follow-ups remain, but the total is not fixed.',
    'Follow-ups are done except the total is still broken.',
    'Left alone: W2\'s files, owned by another active implementer; not fixed: the total is wrong.',
    'Left alone: W9\'s files, owned by another active implementer.',
    'Not fixed, outside the brief: the total is wrong.',
    'Follow-up: the total is wrong.',
    'D999 not fixed: the total is wrong.',
    'No follow-ups but the total is not fixed.',
    'No follow-ups, but deferred: the total is wrong.',
    'No follow-ups but still defer the total fix.',
    'I left it alone because another active implementer was editing it; not fixed: the total is wrong.',
  ]) {
    report(p, 'impl-old', text);
    const r = review(p);
    assert.notEqual(r.code, 0, text);
    assert.match(r.err, /report leaves .* unfixed without a discovered entry/, text);
  }
});

test('I-42: a later ledger fix reconciles the exact historical defect without editing its report', () => {
  const p = project('resolved-ledger-report');
  const file = report(p, 'impl-old', 'Not fixed, outside the brief: the total is wrong.');
  const original = fs.readFileSync(file);
  ok(wf(p.root, ['discovered', 'add', '--summary', 'the total is wrong', '--found-by', 'impl-old', '--attempt', p.id]));
  assert.match(review(p).err, /report leaves .* unfixed without a discovered entry/);
  commitIn(p.wt, { 'src/a.txt': 'correct total\n' });
  const sha = sh(p.wt, 'git rev-parse HEAD');
  ok(wf(p.root, ['discovered', 'close', 'D1', '--fixed', sha, '--repo', 'app', '--attempt', p.id]));
  ok(review(p));
  assert.deepEqual(fs.readFileSync(file), original);
  // A fixed ledger entry cannot excuse a commit removed from the current tree.
  sh(p.wt, 'git reset --hard HEAD^');
  assert.match(review(p, 'reviewer-after-removed-fix').err, /report leaves .* unfixed without a discovered entry/);
});

test('I-42: an unrelated or older fix never suppresses a new or compound unresolved report', () => {
  const p = project('unrelated-ledger-report');
  ok(wf(p.root, ['discovered', 'add', '--summary', 'the total is wrong', '--found-by', 'impl-old', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': 'correct total\n' });
  const sha = sh(p.wt, 'git rev-parse HEAD');
  ok(wf(p.root, ['discovered', 'close', 'D1', '--fixed', sha, '--repo', 'app', '--attempt', p.id]));
  const afterFix = new Date(Date.now() + 1000).toISOString();
  for (const text of ['Not fixed: the total is wrong.', 'Not fixed: the pager is broken.', 'Not fixed: the total is wrong and the pager is broken.']) {
    report(p, 'impl-old', text, afterFix);
    assert.match(review(p).err, /report leaves .* unfixed without a discovered entry/, text);
  }
});

test('I-42: an exact historical issue deferred by the owner is reconciled without inventing authority', () => {
  const p = project('deferred-ledger-report');
  const file = report(p, 'impl-old', 'Follow-up: the total is wrong.');
  const before = fs.readFileSync(file);
  const owner = state(p.root, p.id).owner;
  const home = path.join(p.root, '..', '.home');
  ownerSays(home, owner, 'Continue the repair.');
  ok(wf(p.root, ['discovered', 'add', '--summary', 'the total is wrong', '--found-by', 'impl-old', '--attempt', p.id]));
  assert.match(wf(p.root, ['discovered', 'close', 'D1', '--deferred', '--attempt', p.id]).err, /no owner message/);
  ownerSays(home, owner, 'defer ' + p.id + ':D1: complete the total repair in the next ticket');
  ok(wf(p.root, ['discovered', 'close', 'D1', '--deferred', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': 'other repair\n' });
  ok(review(p));
  assert.deepEqual(fs.readFileSync(file), before);
});

function historicalProject(name) {
  const p = project(name);
  p.oldFile = report(p, 'impl-old', 'Not fixed, outside the brief: the total is wrong.');
  p.original = fs.readFileSync(p.oldFile);
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl-new', '--runtime', 'claude', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': 'correct total\n' });
  p.fix = sh(p.wt, 'git rev-parse HEAD');
  p.base = sh(p.wt, 'git rev-parse HEAD^');
  report(p, 'impl-new', 'Done and committed.');
  return p;
}
function reviewBundle(p, agent) {
  const r = ok(review(p, agent));
  const file = r.out.match(/^Read (\S+)/m)[1];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const record = (p, agent, extra) => wf(p.root, ['review', '--closure', closureFile(path.dirname(p.root), goodClosure(agent, extra)), '--attempt', p.id]);
const fixedReports = (p, b) => b.historicalReports.map((r) => ({ id: r.id, verdict: 'fixed', evidence: 'src/a.txt:1 sums the complete result', fixedIn: p.fix, repo: 'app' }));

test('I-42: historical observations permit review but missing, duplicate, forged and unsupported verdicts refuse', () => {
  const p = historicalProject('historical-verdicts');
  const b = reviewBundle(p, 'historical-reviewer');
  assert.equal(b.historicalReports.length, 1);
  assert.equal(b.historicalReports[0].agent, 'impl-old');
  assert.equal(b.historicalReports[0].supersededBy, 'impl-new');
  const id = b.historicalReports[0].id;
  const v = { id, verdict: 'verified-nonissue', evidence: 'src/a.txt:1', rationale: 'the user needs the filtered result total' };
  for (const entries of [[], [v, v], [{ ...v, id: 'unknown' }], [{ ...v, verdict: 'deferred' }], [{ ...v, evidence: '' }], [{ ...v, rationale: '' }], [{ id, verdict: 'fixed', evidence: 'src/a.txt:1' }], [{ id, verdict: 'fixed', evidence: 'src/a.txt:1', fixedIn: p.base }], [{ id, verdict: 'open', evidence: 'src/a.txt:1' }]]) {
    assert.match(record(p, 'historical-reviewer', { reportedIssues: entries }).err, /historical report observations have no valid verdict/);
  }
  ok(record(p, 'historical-reviewer', { reportedIssues: [v] }));
  assert.deepEqual(fs.readFileSync(p.oldFile), p.original);
});

test('I-42: a historical defect found open blocks the full gate, acceptance and delivery', () => {
  const p = historicalProject('historical-open');
  const b = reviewBundle(p, 'historical-open-reviewer');
  const id = b.historicalReports[0].id;
  const finding = { id: 'F1', severity: 'major', status: 'open', summary: 'the total remains wrong', evidence: 'src/a.txt:1' };
  ok(record(p, 'historical-open-reviewer', { findings: [finding], reportedIssues: [{ id, verdict: 'open', evidence: 'src/a.txt:1', finding: 'F1' }] }));
  assert.match(wf(p.root, ['gate', '--attempt', p.id]).err, /clean code review/);
  assert.match(wf(p.root, ['accept', '--attempt', p.id]).err, /historical report .* reviewer found it open/);
  assert.notEqual(wf(p.root, ['deliver', '--attempt', p.id]).code, 0);
});

test('I-42: an independently judged historical fix survives both reviews and delivers without transcript edits', () => {
  const p = historicalProject('historical-fixed');
  const code = reviewBundle(p, 'historical-code-reviewer');
  ok(record(p, 'historical-code-reviewer', { reportedIssues: fixedReports(p, code) }));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const evidence = reviewBundle(p, 'historical-evidence-reviewer');
  assert.deepEqual(evidence.historicalReports, code.historicalReports);
  ok(record(p, 'historical-evidence-reviewer', { reportedIssues: fixedReports(p, evidence) }));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  ok(wf(p.root, ['deliver', '--attempt', p.id]));
  assert.deepEqual(fs.readFileSync(p.oldFile), p.original);
});

test('I-42: a new unresolved report after acceptance blocks delivery without a code change', () => {
  const p = historicalProject('historical-after-acceptance');
  const code = reviewBundle(p, 'late-code-reviewer');
  ok(record(p, 'late-code-reviewer', { reportedIssues: fixedReports(p, code) }));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const evidence = reviewBundle(p, 'late-evidence-reviewer');
  ok(record(p, 'late-evidence-reviewer', { reportedIssues: fixedReports(p, evidence) }));
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  report(p, 'impl-new', 'Not fixed: a newly discovered defect.');
  assert.match(wf(p.root, ['deliver', '--attempt', p.id]).err, /not delivered: current or historical implementation reports need resolution/);
});

test('I-42: other-scope, stopped and failed implementations do not retire an unresolved current report', () => {
  for (const outcome of ['other-scope', 'stopped', 'failed']) {
    const p = project('scope-' + outcome);
    report(p, 'impl-old', 'Not fixed: the total is wrong.');
    const args = ['handoff', 'implementer', '--agent', 'impl-new', '--runtime', 'claude', '--attempt', p.id];
    if (outcome === 'other-scope') args.push('--work', 'W2');
    ok(wf(p.root, args));
    commitIn(p.wt, { 'src/a.txt': 'another change\n' });
    report(p, 'impl-new', 'Done.');
    if (outcome !== 'other-scope') ok(wf(p.root, ['handoff', 'close', '--agent', 'impl-new', '--outcome', outcome, '--attempt', p.id]));
    assert.match(review(p).err, /report leaves .* unfixed without a discovered entry/, outcome);
  }
});
