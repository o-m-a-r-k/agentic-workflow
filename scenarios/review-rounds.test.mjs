// 0.7.10: two review-round failures from one real attempt.
// I-132: an evidence reviewer recorded its blind closure, then added `priorFindings` as instructed and recorded it again;
// the second record was refused "record the closure without them first", because the check asked whether earlier
// findings had been revealed (never, on a first evidence review: the order of work verifies them before the gate), not
// whether this round's blind closure was recorded.
// I-133: an evidence review that mapped every criterion and opened every new screenshot wrote caveats under `notReached`
// (a check its criteria exclude); it stopped counting as an audit, so after a one-family repair the next reviewer was
// handed a full round (94 screenshots, 51 inspected before) instead of the documented delta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const CHANGED = LINES.replace('l2', 'L2').replace('l5', 'L5');

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'RR-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': CHANGED }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const hand = (p, agent) => JSON.parse(fs.readFileSync(ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id])).out.match(/^Read (\S+)/m)[1], 'utf8'));
const record = (p, closure) => wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]);
const finding = (id, severity, evidence, extra = {}) => ({ id, severity, summary: `${id} is wrong`, status: 'open', evidence, ...extra });
const repair = (p, files) => {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, files, 'fix');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', p.id]));
};

test('I-132: a recorded blind evidence closure takes its priorFindings in a second record; its own findings stay as recorded', () => {
  const p = project('rr-132');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', 'major', 'src/a.txt:2 wrong', { criterion: 'C1' }), finding('F2', 'low', 'src/old.txt:1 wording')] })));
  repair(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') });
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { criteria: [], priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2' }] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = hand(p, 'r3');
  assert.deepEqual([ev.mode, ev.round], ['full', 'evidence-review']);
  const blind = goodClosure('r3', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'gate log' } }] });
  const priors = [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2' }, { round: 'r1', id: 'F2', status: 'verified-nonissue', evidence: 'src/old.txt:1' }];
  const early = record(p, { ...blind, priorFindings: priors });
  assert.equal(early.code, 75, 'before the blind closure is recorded, priorFindings wait');
  assert.match(early.err, /`priorFindings` are listed only after your own blind closure is recorded/);
  ok(record(p, blind));
  const changed = record(p, { ...blind, findings: [finding('F9', 'low', 'src/a.txt:5 new')], priorFindings: priors });
  assert.equal(changed.code, 75);
  assert.match(changed.err, /your own findings were recorded blind and cannot change once `priorFindings` are added/);
  ok(record(p, { ...blind, priorFindings: priors }));
});

test('I-133: an evidence review that covered every criterion and screenshot stays the audit whatever caveats it names, so the round after a repair is a delta', () => {
  const p = project('rr-133');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { notReached: ['real staging rendering is a separate check after delivery, out of scope by C1'], findings: [finding('F1', 'major', 'src/a.txt:2 wrong', { criterion: 'C1' })] })));
  repair(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') });
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  assert.equal(hand(p, 'r3').mode, 'delta');
});

test('I-133: a code review that names unreached scope is still no audit (I-69 stands)', () => {
  const p = project('rr-133-code');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { criteria: [], notReached: ['src/old.txt was not read'], findings: [finding('F1', 'major', 'src/a.txt:2 wrong', { criterion: 'C1' })] })));
  repair(p, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') });
  assert.equal(hand(p, 'r2').mode, 'full');
});
