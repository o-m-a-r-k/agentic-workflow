import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, ok, singleRepoProject, state, wf } from './helpers.mjs';

// I-12: investigate anomalies seen in evidence before calling them cosmetic. Named failure: a cross-locale difference in
// screenshot numbers was dismissed as cosmetic without checking; it came from shared test data and hid vacuous
// assertions. A reviewer handed screenshots accounts for what it saw in `anomalies`: "none seen", or each anomaly with
// the screenshots, what differs and either a finding, or the cause with its evidence and the assertion that pins the value.

const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf en > shots/en.png && printf fr > shots/fr.png', artifacts: ['shots/*.png'] }];

test('I-12: the reviewer closure accounts for anomalies in the screenshots; cosmetic without investigation is refused', () => {
  const { base, root } = singleRepoProject('review-anomalies', { gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-120', '--owner', 'o', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  // Reviewed before any gate on the tree: no screenshots were handed, so nothing is owed.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'r0', findings: [], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'diff' } }], screenshotsInspected: [] }), '--attempt', id]));
  const shas = JSON.parse(ok(wf(root, ['gate', '--attempt', id, '--json'])).out).steps[0].artifacts.map((a) => a.sha256);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', id]));
  const bundle = JSON.parse(fs.readFileSync(state(root, id).handoffs.at(-1).bundle, 'utf8'));
  assert.match(JSON.stringify(bundle), /fill `anomalies`: \\"none seen\\", or per anomaly the screenshots, what differs, and either your `finding` id, or the `cause` you found with its `evidence`/, 'the reviewer is told how to record anomalies');
  const closure = (reviewer, extra) => closureFile(base, { reviewer, findings: [], criteria: [{ id: 'C1', evidence: { kind: 'screenshot', ref: shas[0] } }], screenshotsInspected: shas, ...extra });
  const review = (reviewer, extra) => wf(root, ['review', '--closure', closure(reviewer, extra), '--attempt', id]);
  const seen = { screenshots: [shas[0], shas[1]], observation: 'the English capture shows 3 active items, the French one 1' };
  const refusals = [
    [{}, /no `anomalies` key: compare the captures of the same state/],
    [{ anomalies: 'looked fine' }, /`anomalies` must be "none seen" or a list/],
    [{ anomalies: [{ ...seen, cause: 'cosmetic' }] }, /anomaly 1: `evidence` says what you checked[\s\S]*anomaly 1: `assertions` names the test assertion \(file:line\) that pins this value/],
    [{ anomalies: [{ ...seen, cause: 'shared test data between the two locale runs', evidence: 'seed.ts:12 creates the items once for both runs' }] }, /anomaly 1: `assertions` names the test assertion[\s\S]*when none does, the value is unchecked: raise a `finding`/],
    [{ anomalies: [{ observation: 'x', cause: 'c', evidence: 'e', assertions: 'a' }] }, /anomaly 1: name the screenshot\(s\) it was seen in/],
    [{ anomalies: [{ ...seen, screenshots: ['f'.repeat(64)], cause: 'c', evidence: 'e', assertions: 'a' }] }, /anomaly 1: f{64} is not a screenshot of this gate/],
    [{ anomalies: [{ ...seen, finding: 'F9' }] }, /anomaly 1: finding F9 is not among your findings/],
    [{ anomalies: [{ screenshots: [shas[0]], cause: 'c', evidence: 'e', assertions: 'a' }] }, /anomaly 1: `observation` says what differs/],
  ];
  for (const [extra, re] of refusals) {
    const r = review('r1', extra);
    assert.equal(r.code, 75, String(re));
    assert.match(r.err, re);
  }
  assert.equal(state(root, id).reviews.length, 1, 'no refused closure was recorded');
  // Investigated to a cause, with its evidence and the assertion that pins the value: recorded.
  const investigated = [{ ...seen, cause: 'each locale run seeds its own items; the French run deletes two', evidence: 'e2e/seed.ts:12, e2e/locale.spec.ts:30', assertions: 'e2e/locale.spec.ts:41 expects the count the run seeded' }];
  ok(review('r1', { anomalies: investigated }));
  assert.deepEqual(state(root, id).review.closure.anomalies, investigated);
  // Raised as a finding instead (a value no test pins): recorded, and acceptance then waits for the fix.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
  ok(review('r2', { findings: [{ id: 'F1', severity: 'major', summary: 'no test pins the item count per locale', status: 'open', evidence: 'e2e/locale.spec.ts:41 asserts only that a number shows' }], anomalies: [{ ...seen, finding: 'F1' }] }));
  assert.match(wf(root, ['accept', '--attempt', id]).err, /F1/);
  // "none seen" after comparing: recorded.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r3', '--attempt', id]));
  ok(review('r3', { anomalies: 'none seen' }));
});
