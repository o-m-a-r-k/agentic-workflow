// Stream 1 (0.8.1 review fixes): the risk judgement's needs and their evidence. The second seat runs on a model of its
// own; an unmet free-text need is a goal finding; needs stand across rounds and attempts unless dropped with a reason;
// need spellings normalise; the second seat splits by area; a refused shape relaunches the seat; the diff-read comes
// last, carries the merge-base log, and holds nothing with `diffRead: after`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { YAML, ledgerLines, reviewerTranscript } from './helpers/index.mjs';
import doubles, { answer } from './flow-doubles.mjs';
import { HIGH, LOW, attempt, commitWt, flow, read, review, setup, started } from './flow-fixture.mjs';
import { nextStep } from '../engine/flow.mjs';
import { normNeed } from '../engine/risk.mjs';

const ctxOf = (p) => ({ cwd: p.root, root: p.root, env: process.env, actor: null, json: false });
const risk = async (p, id) => (await flow.mergeFacts(p.root, id)).find((f) => f.id === 'merge:risk')?.message ?? '';
const asked = (p, id, kind) => ledgerLines(p.root, id).filter((e) => e.type === 'decision.asked' && e.data.kind === kind);
const editAdapter = (p, fn) => {
  const raw = YAML.parse(fs.readFileSync(p.adapterFile, 'utf8'));
  fn(raw);
  fs.writeFileSync(p.adapterFile, YAML.stringify(raw));
};
const goal = (what, why = 'it matters') => ({ location: 'server/src/core/sum.mjs:1', class: 'goal', severity: 'high', what, why });

test('B1: with no second-reviewer model the second seat runs on the other host, and only a review on a model of its own counts', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 2;\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'a total others rely on', needs: ['second-review'] } } });
    const second = (await flow.bundle(p.root, s.id)).bundles.find((b) => b.seat === 'second');
    assert.equal(second.model, null);
    assert.equal(second.otherHost, true);
    await review(p, s.id);
    const rec = ledgerLines(p.root, s.id).filter((e) => e.type === 'review.recorded').map((e) => [e.data.seat, e.data.session.runtime]);
    assert.deepEqual(rec, [['whole', 'claude'], ['second', 'codex']]);
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    assert.equal(await risk(p, s.id), '');
  } finally {
    p.done();
  }
});

test('B1: a second review on the first seat\'s model does not count; status names the setting, then wf review runs it again', async () => {
  const p = setup();
  try {
    process.env.WF_TEST_ONE_HOST = '1';
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 2;\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'a total others rely on', needs: ['second-review'] } } });
    await review(p, s.id);
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    assert.match(await risk(p, s.id), /a second review on a model of its own \(it ran on claude default model, as the first did\): set `models\.secondReviewer` to a different model/);
    assert.equal((await nextStep(p.root, s.id)).command, 'wf doctor');
    editAdapter(p, (raw) => {
      raw.models = { secondReviewer: 'model-two' };
    });
    assert.match((await nextStep(p.root, s.id)).command, /^wf review --attempt/);
    await flow.cmdReview(ctxOf(p), { _: [], flags: { attempt: s.id } });
    const seconds = ledgerLines(p.root, s.id).filter((e) => e.type === 'handoff' && e.data.seat === 'second');
    assert.equal(seconds.length, 2, 'the second seat is launched again on models.secondReviewer');
    assert.equal(seconds[1].data.model, 'model-two');
  } finally {
    delete process.env.WF_TEST_ONE_HOST;
    p.done();
  }
});

test('B2: an unmet free-text need is a goal finding of the second reviewer; rounds that do not lower the blockers stop for the person', async () => {
  const p = setup();
  try {
    const s = await started(p);
    const need = 'verified against a copy of real data';
    for (let i = 0; i < 2; i++) {
      commitWt(p, s.id, 'server', { 'src/core/sum.mjs': `export const sum = ${i};\n` });
      await review(p, s.id, { whole: { risk: i === 0 ? { level: 'high', why: 'data', needs: [need] } : LOW } });
      await review(p, s.id, { second: { met: [{ need, met: false }], findings: [goal(`not ${need}`)] } });
      assert.match((await nextStep(p.root, s.id)).command, /^wf (handoff implementer|approve)/);
    }
    assert.equal(asked(p, s.id, 'no-progress').length, 1, 'the no-progress stop asks the person');
    // No separate "unmet" branch: the finding is what holds the merge.
    assert.doesNotMatch(await risk(p, s.id), /unmet/);
  } finally {
    p.done();
  }
});

test('B2: waiving the finding that cites an unmet need lets it go', async () => {
  const p = setup();
  try {
    const s = await started(p);
    const need = 'an empty filter sums to zero';
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'a total', needs: [need] } } });
    await review(p, s.id, { second: { met: [{ need, met: false }], findings: [goal(`unmet: ${need}`)] } });
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    const w = await flow.cmdReview(ctxOf(p), { _: [], flags: { attempt: s.id, waive: 'F1' } });
    answer(p.root, s.id, w.data.decision, 'waive');
    assert.deepEqual(await flow.mergeFacts(p.root, s.id), []);
  } finally {
    p.done();
  }
});

test('B3/M4: needs stand across rounds and attempts; later first seats see them; only a visible drop with its reason lowers one', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'a total others rely on', needs: ['second-review', 'diff-read'] } } });
    // Abandon and restart: the needs come with the item.
    await attempt.cmdAbandon(ctxOf(p), { _: [], flags: { attempt: s.id, reason: 'restart on a fresh base' } });
    const s2 = await attempt.start(p.root, 'TK-1', { actor: { runtime: 'claude', id: 'owner-1' } });
    await flow.setCriteria(p.root, s2.id, { criteria: ['the sum of an empty list is zero'], areas: [] }, { actor: null });
    commitWt(p, s2.id, 'server', { 'src/core/sum.mjs': 'export const sum = 2;\n' });
    const first = (await flow.bundle(p.root, s2.id)).bundles[0];
    assert.match(first.prompt, /Risk needs standing from earlier reviews[^\n]*\n- second-review \(a total others rely on\)\n- diff-read \(a total others rely on\)/);
    // A drop of a need nobody asked for, and a drop with no reason, are refused.
    await assert.rejects(review(p, s2.id, { whole: { risk: { ...LOW, drop: [{ need: 'failing-test', why: 'x' }] } } }), /no earlier review asked for/);
    await assert.rejects(review(p, s2.id, { whole: { risk: { ...LOW, drop: [{ need: 'diff-read' }] } } }), /risk.drop must be a list of \{ need, why \}/);
    const r = await review(p, s2.id, { whole: { risk: { ...LOW, drop: [{ need: 'the person\'s diff read', why: 'a one-line constant, covered by the second review' }] } } });
    assert.deepEqual(r.out.whole.risk.drop, [{ need: 'diff-read', why: 'a one-line constant, covered by the second review' }]);
    await review(p, s2.id);
    await doubles.runTests(p.root, s2.id, 'server', 'fast');
    // second-review still stands; the diff-read was dropped, visibly.
    assert.equal(ledgerLines(p.root, s2.id).filter((e) => e.type === 'review.recorded' && e.data.seat === 'second').length, 1);
    assert.deepEqual(await flow.mergeFacts(p.root, s2.id), []);
    assert.equal(asked(p, s2.id, 'diff-read').length, 0);
  } finally {
    p.done();
  }
});

test('B3: failing-test is refused for a change whose repos have no fast tests', async () => {
  const p = setup();
  try {
    editAdapter(p, (raw) => {
      for (const r of raw.repos) delete r.tests.fast;
    });
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n', 'test/sum.spec.mjs': '// t\n' });
    await assert.rejects(review(p, s.id, { whole: { risk: { level: 'high', why: 'x', needs: ['failing-test'] } } }), /no changed repo has `fast` tests/);
  } finally {
    p.done();
  }
});

test('B4: need spellings normalise to the three known needs, so "diff read" reaches the person', async () => {
  for (const [w, n] of [['diff read', 'diff-read'], ["The person's diff-read", 'diff-read'], ['Second Review', 'second-review'], ['failing_test', 'failing-test'], ['an empty list sums to zero', 'an empty list sums to zero']]) assert.equal(normNeed(w), n, w);
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    const r = await review(p, s.id, { whole: { risk: { level: 'high', why: 'money', needs: ['diff read'] } } });
    assert.deepEqual(r.out.whole.risk.needs, ['diff-read']);
    assert.deepEqual((await flow.bundle(p.root, s.id)).bundles.map((b) => b.seat), ['whole'], 'no second seat for a known need');
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    await flow.mergeFacts(p.root, s.id);
    assert.equal(asked(p, s.id, 'diff-read').length, 1, 'the person is asked to read the diff');
  } finally {
    p.done();
  }
});

test('M1/L2: above the split size the second review splits by area too, and the diff-read gets the whole diff', async () => {
  const p = setup();
  try {
    const s = await started(p);
    const big = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    commitWt(p, s.id, 'client', { 'src/pages/a.mjs': big(900), 'src/common/b.mjs': big(900) });
    await review(p, s.id, { all: { risk: { level: 'high', why: 'every page', needs: ['second-review', 'diff-read'] } } });
    const seats = (await flow.bundle(p.root, s.id)).bundles.map((b) => b.seat);
    assert.deepEqual(seats, ['area:client/src/common', 'area:client/src/pages', 'second:client/src/common', 'second:client/src/pages']);
    await review(p, s.id);
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    await flow.mergeFacts(p.root, s.id);
    const [d] = asked(p, s.id, 'diff-read');
    const file = /Read it \(([^)]+\.patch)\)/.exec(d.data.question)[1];
    assert.ok(file.endsWith('diff-whole.patch') && fs.existsSync(file) && read(file).includes('src/pages/a.mjs') && read(file).includes('src/common/b.mjs'));
  } finally {
    p.done();
  }
});

test('M2/L4/L5: a review refused for its shape marks its launch failed so wf review relaunches it; risk is asked only of a bundle that carried the guidance; met needs how', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    const { tree, bundles } = await flow.bundle(p.root, s.id);
    const b = bundles[0];
    const { session } = await doubles.launchReviewer(p.root, s.id, b);
    reviewerTranscript({ home: p.home, cwd: p.root, files: [path.join(p.wt(s.id, 'server'), 'src/core/sum.mjs')], session: session.id });
    const dir = path.join(p.root, '.wf-evidence', 'attempts', s.id, 'reviews', `launch-${session.id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ host: session.runtime, closure: b.output }));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ session: session.id, state: 'done' }));
    await assert.rejects(flow.recordReview(p.root, s.id, { session, tree, findings: [], verified: [] }), /gives no risk judgement/);
    assert.equal(JSON.parse(read(path.join(dir, 'status.json'))).state, 'failed');
    const step = await nextStep(p.root, s.id);
    assert.match(step.command, /^wf review --attempt/);
    assert.match(step.why, /failed \(its review was refused: the review gives no risk judgement/);
    // A bundle without the risk guidance (written before 0.8.1) does not ask for it.
    const saved = path.join(path.dirname(b.output), 'bundle-whole.json');
    const old = JSON.parse(read(saved));
    delete old.files.risk;
    fs.writeFileSync(saved, JSON.stringify(old));
    const r = await flow.recordReview(p.root, s.id, { session, tree, findings: [], verified: [] });
    assert.equal(r.risk, undefined);
  } finally {
    p.done();
  }
  const q = setup();
  try {
    const s = await started(q);
    commitWt(q, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    await review(q, s.id, { whole: { risk: { level: 'high', why: 'x', needs: ['a filtered empty list sums to zero'] } } });
    await assert.rejects(review(q, s.id, { second: { met: [{ need: 'a filtered empty list sums to zero', met: true }] } }), /`met: true` needs `how`/);
  } finally {
    q.done();
  }
});

test('M3/L1: the second seat and the diff-read carry the merge-base log; the diff-read waits until nothing else refuses the merge', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n', 'test/sum.spec.mjs': '// asserts one\n' });
    await review(p, s.id, { whole: { risk: HIGH } });
    await doubles.runTests(p.root, s.id, 'server', 'risk-base');
    const second = (await flow.bundle(p.root, s.id)).bundles.find((b) => b.seat === 'second');
    assert.match(second.prompt, /Merge-base test runs[^\n]*\n- server: failed on the merge-base, log \S+risk-base-server\.log/);
    await review(p, s.id);
    // The fast tests fail on HEAD: merge:untested is pushed, so the diff-read is not asked yet.
    process.env.WF_TEST_FAST_FAIL = '1';
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    delete process.env.WF_TEST_FAST_FAIL;
    await flow.mergeFacts(p.root, s.id);
    assert.equal(asked(p, s.id, 'diff-read').length, 0);
    await doubles.runTests(p.root, s.id, 'server', 'fast');
    await flow.mergeFacts(p.root, s.id);
    const [d] = asked(p, s.id, 'diff-read');
    assert.match(d.data.question, /with the merge-base test log \(server \S+risk-base-server\.log\)/);
  } finally {
    p.done();
  }
});

test('L6: with diffRead: after, the diff-read is asked but status does not stop on it', async () => {
  const p = setup({ overrides: { review: { diffRead: 'after' }, screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 1;\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'x', needs: ['diff-read'] } } });
    const step = await nextStep(p.root, s.id);
    assert.equal(asked(p, s.id, 'diff-read').length, 1);
    assert.doesNotMatch(step.command, /wf approve/);
    assert.match(step.command, /^wf deliver/);
  } finally {
    p.done();
  }
});

test('P4: a test the repo\'s kinds.tests does not class leaves failing-test unmet, and status says why', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = 3;\n', 'src/core/newmod/__tests__/sum.check.mjs': '// a test in a new folder\n' });
    await review(p, s.id, { whole: { risk: { level: 'high', why: 'x', needs: ['failing-test'] } } });
    const st = await nextStep(p.root, s.id);
    assert.match(st.command, /^wf handoff implementer/);
    assert.match(st.why, /no file its repo's `kinds\.tests` classes as a test/);
  } finally {
    p.done();
  }
});
