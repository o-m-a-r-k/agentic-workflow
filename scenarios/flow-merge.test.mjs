// Stream 1: the merge facts. merge:unreviewed (a commit after the review; git's automatic merge of the base is not one; an
// edited merge is), merge:foreign (a merged branch that is not the base, until the person allows it), merge:untested, and
// merge:risk (a risk test that fails on the merge-base, the second review, the diff-read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/index.mjs';
import doubles, { answer } from './flow-doubles.mjs';
import { commitWt, flow, review, setup, started } from './flow-fixture.mjs';

const ids = (facts) => facts.map((f) => f.id);

test('merge:unreviewed: a commit after the review is refused; an automatic base merge is not; an edited merge is', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    assert.ok(ids(await flow.mergeFacts(p.root, s.id)).includes('merge:unreviewed'), 'nothing reviewed yet');
    await review(p, s.id);
    assert.deepEqual(await flow.mergeFacts(p.root, s.id), []);
    // The base moves; git's automatic merge of it changes nothing reviewed.
    p.pushElsewhere('client', { 'src/other.mjs': 'export const other = 1;\n' });
    const wt = p.wt(s.id, 'client');
    git(wt, ['fetch', '--quiet', 'origin']);
    git(wt, ['merge', '--quiet', '--no-edit', 'origin/stable']);
    assert.deepEqual(await flow.mergeFacts(p.root, s.id, { repo: 'client' }), []);
    // A merge whose result differs from git's own is unreviewed.
    p.pushElsewhere('client', { 'src/third.mjs': 'export const third = 1;\n' });
    git(wt, ['fetch', '--quiet', 'origin']);
    git(wt, ['merge', '--quiet', '--no-commit', 'origin/stable']);
    p.commit('client', { 'src/pages/items.mjs': 'export const page = "edited in the merge";\n' }, 'merge with an edit', { cwd: wt });
    const facts = await flow.mergeFacts(p.root, s.id, { repo: 'client' });
    assert.deepEqual(ids(facts), ['merge:unreviewed']);
    assert.match(facts[0].message, /differs from git's automatic merge/);
    // A plain commit after the review is too.
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 9;\n' });
    assert.match((await flow.mergeFacts(p.root, s.id, { repo: 'client' }))[0].message, /a commit after the review/);
  } finally {
    p.done();
  }
});

test('merge:foreign: a merged sibling branch asks the person and refuses until they allow it; merge:untested on a landed tree', async () => {
  const p = setup();
  try {
    const s = await started(p);
    // Someone pushes a sibling branch; the attempt merges it.
    const wt = p.wt(s.id, 'client');
    git(wt, ['checkout', '--quiet', '-b', 'sibling', 'origin/stable']);
    p.commit('client', { 'src/sib.mjs': 'export const sib = 1;\n' }, 'sibling work', { cwd: wt });
    git(wt, ['push', '--quiet', 'origin', 'sibling']);
    git(wt, ['checkout', '--quiet', `wf/${s.id}`]);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    git(wt, ['fetch', '--quiet', 'origin']);
    git(wt, ['merge', '--quiet', '--no-edit', 'origin/sibling']);
    await review(p, s.id);
    let facts = await flow.mergeFacts(p.root, s.id);
    const f = facts.find((x) => x.id === 'merge:foreign');
    assert.ok(f, JSON.stringify(facts));
    assert.match(f.message, /origin\/sibling/);
    const d = (await doubles.readEvents(p.root, s.id)).find((e) => e.type === 'decision.asked' && e.data.kind === 'foreign-merge');
    answer(p.root, s.id, d.data.id, 'allow the merge');
    facts = await flow.mergeFacts(p.root, s.id);
    assert.ok(!ids(facts).includes('merge:foreign'), JSON.stringify(facts));
    const tree = git(wt, ['rev-parse', 'HEAD^{tree}']);
    assert.ok(ids(await flow.mergeFacts(p.root, s.id, { landedTree: tree })).includes('merge:untested'));
    await doubles.append(p.root, s.id, 'test.run', { repo: 'client', kind: 'full', tree, pass: true, exitCode: 0, ms: 1, source: 'landing' }, null);
    assert.ok(!ids(await flow.mergeFacts(p.root, s.id, { landedTree: tree })).includes('merge:untested'));
  } finally {
    p.done();
  }
});

test('merge:risk: a risk test must fail on the merge-base, the second review must exist, the diff-read is required with diffRead: before', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0) || 0;\n' });
    await review(p, s.id);
    let risk = (await flow.mergeFacts(p.root, s.id)).find((f) => f.id === 'merge:risk');
    assert.match(risk.message, /a test added or changed under the risk tests/);
    commitWt(p, s.id, 'server', { 'test/sum.spec.mjs': '// asserts the empty sum\n' });
    process.env.WF_TEST_RISKBASE_PASS = '1';
    await doubles.runTests(p.root, s.id, 'server', 'risk-base');
    await review(p, s.id);
    risk = (await flow.mergeFacts(p.root, s.id)).find((f) => f.id === 'merge:risk');
    assert.match(risk.message, /passed there/);
    delete process.env.WF_TEST_RISKBASE_PASS;
    await doubles.runTests(p.root, s.id, 'server', 'risk-base');
    risk = (await flow.mergeFacts(p.root, s.id)).find((f) => f.id === 'merge:risk');
    assert.doesNotMatch(risk.message, /passed there|second/, 'both seats reviewed; the base run failed');
    assert.match(risk.message, /diff-read/);
    const d = (await doubles.readEvents(p.root, s.id)).filter((e) => e.type === 'decision.asked' && e.data.kind === 'diff-read').pop();
    answer(p.root, s.id, d.data.id, 'approve');
    assert.deepEqual(await flow.mergeFacts(p.root, s.id), []);
  } finally {
    p.done();
  }
});
