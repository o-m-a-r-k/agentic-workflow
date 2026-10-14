import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { approveAsOwner, closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.7, D17, named failure (field): under D10 a medium finding was the owner agent's call and a low one left freely, so
// an owner deferred 14 of 15 findings on its own judgement, among them a behaviour the person had asked for (called "a
// product decision") and two money and customer-data defects rated low. The person's rule now: medium and high are fixed
// in the delivery; a low item leaves only with the person's yes, every low item in one question.

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'DR-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': LINES.replace('l2', 'L2') });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const finding = (id, severity, evidence) => ({ id, severity, summary: `${id}: ${evidence}`, status: 'open', evidence });
  const closure = goodClosure('r1', { findings: [finding('F1', 'medium', 'src/old.txt:2 the export sums one page only'), finding('F2', 'low', 'src/old.txt:3 a tooltip typo')] });
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', e.id]));
  const add = (summary, severity) => ok(wf(p.root, ['discovered', 'add', '--summary', summary, ...(severity ? ['--severity', severity] : []), '--attempt', e.id]));
  add('customer invoice reads carry admin-only fields', 'medium');
  add('a stale screenshot in the ignored folder', 'medium');
  add('a pager resets on refresh', null);
  return { ...p, id: e.id };
}
const silent = { ownerSilent: true };
const run = (p, args) => wf(p.root, [...args, '--attempt', p.id], silent);
const capture = (p) => {
  const f = path.join(p.base, 'ticket.json');
  fs.writeFileSync(f, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'follow-up', url: 'https://tracker.example.test/ENG-9' } }));
  return f;
};

test('medium and high stay in the delivery: no command defers or tickets them, with a reason or without', () => {
  const p = project('d17-kept');
  const [d1, , d3] = state(p.root, p.id).discovered.map((d) => d.id);
  for (const args of [
    ['scope', 'defer', '--finding', 'r1:F1', '--reason', 'the export page is rebuilt next'],
    ['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture(p), '--reason', 'later'],
    ['discovered', 'close', d1, '--deferred', '--reason', 'a product decision'],
    ['discovered', 'close', d3, '--deferred', '--reason', 'unrated'],
    ['scope', 'defer', '--finding', `r1:F2,${d1}`],
  ]) {
    const r = run(p, args);
    assert.notEqual(r.code, 0, `refused: ${args.join(' ')}`);
    assert.match(r.err, /stays? in this delivery: medium and high are fixed in this delivery/, args.join(' '));
    assert.doesNotMatch(r.err, /wf approve A\d+/, 'nothing to ask: no answer lets a medium or high item leave');
  }
  const s = state(p.root, p.id);
  assert.deepEqual(s.discovered.map((d) => d.status), ['open', 'open', 'open']);
  assert.deepEqual(s.decisions ?? [], [], 'no decision was put to the person');
});

test('low items leave only with the person\'s yes, review findings and discovered issues in one question that shows a down-rating', () => {
  const p = project('d17-low');
  const [, d2] = state(p.root, p.id).discovered.map((d) => d.id);
  ok(run(p, ['discovered', 'rate', d2, '--severity', 'low', '--reason', 'an ignored folder']));
  const asked = run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`, '--reason', 'polish']);
  assert.equal(asked.code, 75);
  const id = asked.err.match(/wf approve (A\d+)/)[1];
  const d = state(p.root, p.id).decisions.find((x) => x.id === id);
  assert.match(d.summary, /r1:F2 \(low\): F2: src\/old\.txt:3 a tooltip typo/);
  assert.match(d.summary, new RegExp(`${d2} \\(low, rated down from medium\\): a stale screenshot`));
  assert.equal(state(p.root, p.id).decisions.length, 1, 'one question for both kinds');
  approveAsOwner(p.root, p.id, id, 'no');
  assert.notEqual(run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`]).code, 0, 'a no lets nothing leave');
  assert.equal(state(p.root, p.id).discovered.find((x) => x.id === d2).status, 'open');
  const again = state(p.root, p.id).decisions.at(-1).id;
  approveAsOwner(p.root, p.id, again, 'yes');
  ok(run(p, ['scope', 'defer', '--finding', `r1:F2,${d2}`]));
  const s = state(p.root, p.id);
  const closed = s.discovered.find((x) => x.id === d2);
  assert.equal(closed.status, 'deferred');
  assert.deepEqual([closed.deferred.source.provenance, closed.deferred.source.decision], ['approved-decision', again]);
  assert.equal(s.scopeDecisions.at(-1).decision, again);
  assert.deepEqual(s.scopeDecisions.at(-1).keys, ['r1:F2']);
});
