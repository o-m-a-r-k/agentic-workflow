// Stream 1: the three classes, finding:other-own, filing `other`, the priority question, fix rounds counted per item
// across abandon and restart, and the no-progress stop (fix:no-progress until the person decides).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerLines } from './helpers/index.mjs';
import { answer, attempt, commitWt, flow, review, setup, started } from './flow-fixture.mjs';

const finding = (location, cls, severity = 'medium', what = 'wrong') => ({ location, class: cls, severity, what, why: 'it matters' });
const ctx = (p) => ({ cwd: p.root, root: p.root, env: process.env, actor: null, json: false });
const handoff = (p, id, session = 'claude:impl') => flow.cmdHandoff(ctx(p), { _: ['implementer'], flags: { attempt: id, session } });

test('classes: `other` on a line this attempt wrote is refused; on an older line it is filed; goal and regression block at any severity', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\nexport const extra = 1;\n' });
    await assert.rejects(review(p, s.id, { all: { findings: [finding('client/src/pages/items.mjs:2', 'other', 'low')] } }), (e) => e.refusalId === 'finding:other-own');
    await assert.rejects(review(p, s.id, { all: { findings: [{ ...finding('client/src/pages/items.mjs:2', 'goal'), class: 'nice-to-have' }] } }), /class `nice-to-have`/);
    const { out } = await review(p, s.id, { all: { findings: [finding('client/src/common/button.mjs:1', 'other', 'high', 'old button bug'), finding('client/src/pages/items.mjs:2', 'goal', 'low'), finding('client/src/common/button.mjs:1', 'regression', 'low')] } });
    assert.equal(out.whole.blockers, 2);
    const ev = ledgerLines(p.root, s.id);
    const filed = ev.find((e) => e.type === 'finding.filed');
    assert.equal(filed.data.finding, 'F1');
    assert.equal(filed.data.ticket, 'TK-101');
    assert.equal(filed.data.priority, true);
    assert.equal(filed.data.marker, `wf:${s.id}:finding:F1`);
    assert.ok(ev.some((e) => e.type === 'decision.asked' && e.data.kind === 'priority-other' && e.data.blocking === false));
    const facts = await flow.mergeFacts(p.root, s.id);
    assert.ok(facts.some((f) => f.id === 'merge:open' && /F2/.test(f.message) && /F3/.test(f.message) && !/F1/.test(f.message)));
  } finally {
    p.done();
  }
});

test('no progress: a flat blocker count stops the fix rounds until the person decides; rounds count across abandon and restart', async () => {
  const p = setup();
  try {
    const s = await started(p, 'TK-5');
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    await review(p, s.id, { all: { findings: [finding('client/src/pages/items.mjs:1', 'goal')] } });
    await handoff(p, s.id);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 2;\n' });
    // Restart the item: the round count and the open blocker carry over.
    await attempt.cmdAbandon(ctx(p), { _: [], flags: { attempt: s.id, reason: 'start over' } });
    const s2 = await started(p, 'TK-5');
    commitWt(p, s2.id, 'client', { 'src/pages/items.mjs': 'export const page = 3;\n' });
    const { bundles } = await flow.bundle(p.root, s2.id);
    assert.equal(bundles[0].round, 2);
    assert.deepEqual(bundles[0].verify, ['F1']);
    await review(p, s2.id, { all: { verified: [{ id: 'F1', status: 'open' }] } });
    const np = await flow.noProgress(p.root, 'TK-5');
    assert.equal(np.stop, true);
    assert.match(np.reason, /no fewer than the 1/);
    assert.ok(np.decision, 'asked at once');
    await assert.rejects(handoff(p, s2.id), (e) => e.refusalId === 'fix:no-progress');
    answer(p.root, s2.id, np.decision, 'continue');
    await handoff(p, s2.id);
  } finally {
    p.done();
  }
});

test('no progress: a fixed finding that reopens stops the next fix round', async () => {
  const p = setup();
  try {
    const s = await started(p, 'TK-6');
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    await review(p, s.id, { all: { findings: [finding('client/src/pages/items.mjs:1', 'goal'), finding('client/src/pages/items.mjs:1', 'goal', 'low', 'second')] } });
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 2;\n' });
    await review(p, s.id, { all: { verified: [{ id: 'F1', status: 'fixed' }, { id: 'F2', status: 'open' }] } });
    assert.equal((await flow.noProgress(p.root, 'TK-6')).stop, false, '2 -> 1 is progress');
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 3;\n' });
    await review(p, s.id, { all: { verified: [{ id: 'F1', status: 'open' }, { id: 'F2', status: 'fixed' }] } });
    const np = await flow.noProgress(p.root, 'TK-6');
    assert.equal(np.stop, true);
    assert.deepEqual(np.findings, ['F1']);
    assert.match(np.reason, /reopened/);
    await assert.rejects(handoff(p, s.id), (e) => e.refusalId === 'fix:no-progress');
    answer(p.root, s.id, np.decision, 'stop');
    await assert.rejects(handoff(p, s.id), (e) => e.refusalId === 'fix:no-progress' && /chose "stop"/.test(e.message));
  } finally {
    p.done();
  }
});

test('a waiver of a blocking finding goes to the person; waived, it no longer blocks', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    await review(p, s.id, { all: { findings: [finding('client/src/pages/items.mjs:1', 'goal', 'low')] } });
    const r = await flow.cmdReview(ctx(p), { _: [], flags: { attempt: s.id, waive: 'F1', why: 'cosmetic' } });
    let facts = await flow.mergeFacts(p.root, s.id);
    assert.ok(facts.some((f) => f.id === 'merge:waiver'));
    assert.ok(facts.some((f) => f.id === 'merge:open'));
    answer(p.root, s.id, r.data.decision, 'waive');
    facts = await flow.mergeFacts(p.root, s.id);
    assert.ok(!facts.some((f) => ['merge:waiver', 'merge:open'].includes(f.id)), JSON.stringify(facts));
  } finally {
    p.done();
  }
});
