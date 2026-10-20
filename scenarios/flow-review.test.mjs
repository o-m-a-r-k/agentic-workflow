// Stream 1: criteria (limit, hash, loosening waiver), the bundle (contents, consumers, the risk guidance, the second seat
// a risk judgement asks for, split by size), and recording a review (tree, independence, coverage from a fixture
// transcript, unverified coverage, the risk judgement's shape).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, setDoubles } from '../engine/contract.mjs';
import { ledgerLines, reviewerTranscript, transcript } from './helpers/index.mjs';
import { sha256 } from '../engine/util.mjs';
import doubles, { answer } from './flow-doubles.mjs';
import { HIGH, LOW, attempt, commitWt, flow, read, review, reviewerWrote, setup, started } from './flow-fixture.mjs';

const finding = (location, cls, severity = 'medium', what = 'wrong') => ({ location, class: cls, severity, what, why: 'it matters' });

test('criteria: at most 6, hashed, edits recorded with the previous hash; texts keep their ids', async () => {
  const p = setup();
  try {
    const s = await started(p, 'TK-1', null);
    await assert.rejects(flow.setCriteria(p.root, s.id, { criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], areas: [] }), (e) => e.refusalId === 'criteria:max');
    const r1 = await flow.setCriteria(p.root, s.id, { criteria: ['one', 'two'], areas: ['server'] });
    assert.equal(r1.hash, sha256(canonicalJson([{ id: 'C1', text: 'one' }, { id: 'C2', text: 'two' }])));
    const r2 = await flow.setCriteria(p.root, s.id, { criteria: ['two', 'three'], areas: ['server'] });
    assert.deepEqual(r2.criteria.map((c) => c.id), ['C2', 'C3']);
    const set = ledgerLines(p.root, s.id).filter((e) => e.type === 'criteria.set');
    assert.equal(set[1].data.previous, r1.hash);
    assert.deepEqual(set[1].data.diff.dropped, [{ id: 'C1', text: 'one' }]);
    assert.equal(r2.decision, null, 'no blocker open: an edit is free');
  } finally {
    p.done();
  }
});

test('criteria: an edit that changes a criterion an open blocker cites asks the person and holds the merge (merge:waiver)', async () => {
  const p = setup();
  try {
    const s = await started(p, 'TK-1', ['empty lists sum to zero', 'negative numbers are kept']);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    await review(p, s.id, { all: { findings: [finding('client/src/pages/items.mjs:1', 'goal', 'low', 'C2 is not met')] } });
    const r = await flow.setCriteria(p.root, s.id, { criteria: [{ id: 'C1', text: 'empty lists sum to zero' }, { id: 'C2', text: 'negative numbers may be dropped' }], areas: [] });
    assert.deepEqual(r.loosened, ['C2']);
    assert.ok(r.decision);
    const facts = await flow.mergeFacts(p.root, s.id);
    assert.ok(facts.some((f) => f.id === 'merge:waiver'));
    answer(p.root, s.id, r.decision, 'keep the criteria');
    assert.ok((await flow.mergeFacts(p.root, s.id)).some((f) => f.id === 'merge:waiver' && /kept the criteria/.test(f.message)));
    await flow.setCriteria(p.root, s.id, { criteria: [{ id: 'C1', text: 'empty lists sum to zero' }, { id: 'C2', text: 'negative numbers are kept' }], areas: [] });
    assert.ok(!(await flow.mergeFacts(p.root, s.id)).some((f) => f.id === 'merge:waiver'), 'restored');
  } finally {
    p.done();
  }
});

test('bundle: the diff, criteria, base copies of rules and invariants, consumers, the risk guidance; a judgement that needs it adds a second seat', async () => {
  const p = setup({ overrides: { invariants: 'server/INVARIANTS.md', rules: [{ paths: ['server/src/**'], read: ['server/RULES.md'] }] } });
  try {
    p.commit('server', { 'INVARIANTS.md': 'base invariants\n', 'RULES.md': 'base rules\n' }, 'docs', { push: true });
    const s = await started(p);
    // The ticket edits the rules it is judged by: the bundle still carries the base's.
    commitWt(p, s.id, 'server', { 'RULES.md': 'anything goes\n', 'src/routes/items.controller.mjs': 'export const routes = ["/items", "/items/:id"];\n', 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n// edge\n', 'test/sum.spec.mjs': '// spec 2\n' });
    const { tree, bundles } = await flow.bundle(p.root, s.id);
    // No path makes a change risky: one whole seat, which judges the risk itself.
    assert.deepEqual(bundles.map((b) => b.seat), ['whole']);
    const b = bundles[0];
    assert.equal(b.tree, tree);
    assert.match(read(b.files.diff), /items\/:id/);
    assert.match(read(b.files.diff), /spec 2/, 'tests are in the diff');
    assert.equal(read(b.files.rules[0]), 'base rules\n');
    assert.equal(read(b.files.invariants), 'base invariants\n');
    assert.match(read(b.files.criteria), /C1: the sum of an empty list is zero/);
    assert.ok(b.files.consumers.some((f) => f.endsWith(path.join('client', 'src', 'pages', 'items.mjs'))), b.files.consumers.join(','));
    assert.ok(b.files.risk.endsWith(path.join('templates', 'risk.md')));
    assert.ok(b.prompt.includes(b.files.risk) && b.prompt.includes('"risk"'), 'the prompt names the risk guidance and asks for `risk`');
    assert.deepEqual(b.productFiles.sort(), ['server/src/core/sum.mjs', 'server/src/routes/items.controller.mjs']);
    assert.ok(b.prompt.includes(b.output), 'the prompt names the output file');
    // The whole seat judges it high-risk and names a scenario: the second seat is launched to verify it.
    const scenario = 'an empty list after a filter sums to zero';
    await review(p, s.id, { whole: { risk: { ...HIGH, needs: ['second-review', scenario] } } });
    const again = (await flow.bundle(p.root, s.id)).bundles;
    assert.deepEqual(again.map((x) => x.seat), ['whole', 'second']);
    const second = again[1];
    assert.equal(second.files.risk, null);
    assert.deepEqual(second.needs, [scenario]);
    assert.ok(second.prompt.includes('Needs to verify') && second.prompt.includes(scenario) && second.prompt.includes('"met"'));
    assert.match(second.prompt, new RegExp(`high-risk: ${HIGH.why}`));
  } finally {
    p.done();
  }
});

test('bundle: above the split size the review splits by area; a change is never refused for its size', async () => {
  const p = setup();
  try {
    const s = await started(p);
    const big = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    commitWt(p, s.id, 'client', { 'src/pages/a.mjs': big(900), 'src/common/b.mjs': big(900) });
    const { bundles } = await flow.bundle(p.root, s.id);
    assert.deepEqual(bundles.map((b) => b.seat), ['area:client/src/common', 'area:client/src/pages']);
    assert.ok(bundles[0].files.sharedFiles.some((f) => f.endsWith('a.mjs')));
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': big(10) });
    assert.ok((await flow.bundle(p.root, s.id)).bundles.some((b) => b.productFiles.includes('server/src/core/sum.mjs')));
  } finally {
    p.done();
  }
});

test('record: review:independent (not launched; implementer), review:coverage from the transcript; unverified without one', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n', 'src/common/button.mjs': 'export const button = 2;\n' });
    const { tree, bundles } = await flow.bundle(p.root, s.id);
    const b = bundles[0];
    const { session } = await doubles.launchReviewer(p.root, s.id, b);
    const files = b.productFiles.map((f) => path.join(p.wt(s.id, 'client'), f.slice('client/'.length)));
    reviewerTranscript({ home: p.home, cwd: p.root, files, skip: [files[0]], session: session.id });
    const input = { session, seat: 'whole', tree, findings: [], verified: [], risk: LOW };
    await assert.rejects(flow.recordReview(p.root, s.id, { ...input, session: { runtime: 'claude', id: 'self' } }), (e) => e.refusalId === 'review:independent');
    await assert.rejects(flow.recordReview(p.root, s.id, input), (e) => e.refusalId === 'review:coverage' && /1 of 2/.test(e.message));
    reviewerTranscript({ home: p.home, cwd: p.root, files, session: session.id });
    // A first seat always judges the risk; a high one names what it needs.
    await assert.rejects(flow.recordReview(p.root, s.id, { ...input, risk: undefined }), /gives no risk judgement/);
    await assert.rejects(flow.recordReview(p.root, s.id, { ...input, risk: { level: 'medium', why: 'x', needs: [] } }), /not low or high/);
    await assert.rejects(flow.recordReview(p.root, s.id, { ...input, risk: { level: 'high', why: 'it moves stock', needs: [] } }), /names no needs/);
    const r = await flow.recordReview(p.root, s.id, input);
    assert.equal(r.coverage, 'complete');
    assert.deepEqual(ledgerLines(p.root, s.id).find((e) => e.type === 'review.recorded').data.risk, LOW);
    // The review records the heads it stands for, in the ledger.
    assert.deepEqual(ledgerLines(p.root, s.id).find((e) => e.type === 'review.recorded').data.heads, b.heads);
    // An implementer's session cannot review.
    const ctx = { cwd: p.root, root: p.root, env: process.env, actor: null, json: false };
    await flow.cmdHandoff(ctx, { _: ['implementer'], flags: { attempt: s.id, session: 'claude:impl-1' } });
    await doubles.append(p.root, s.id, 'handoff', { role: 'reviewer', session: { runtime: 'claude', id: 'impl-1' }, launchedBy: 'wf', seat: 'second', tree, round: 1 }, null);
    await assert.rejects(flow.recordReview(p.root, s.id, { ...input, seat: 'second', session: { runtime: 'claude', id: 'impl-1' } }), (e) => e.refusalId === 'review:independent' && /implementer/.test(e.message));
    await assert.rejects(flow.cmdHandoff(ctx, { _: ['reviewer'], flags: { attempt: s.id, session: 'x' } }), (e) => e.refusalId === 'review:independent');
    // No readable transcript: coverage is recorded as unverified.
    process.env.WF_TEST_NO_TRANSCRIPT = '1';
    const { session: s3 } = await doubles.launchReviewer(p.root, s.id, b);
    const r3 = await flow.recordReview(p.root, s.id, { ...input, session: s3 });
    assert.equal(r3.coverage, 'unverified');
  } finally {
    p.done();
  }
});

test('record: the reviewed tree is the one wf launched the reviewer on; a review file or --session cannot name HEAD instead (review:tree)', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    const { bundles } = await flow.bundle(p.root, s.id);
    const b = bundles[0];
    const { session } = await doubles.launchReviewer(p.root, s.id, b);
    // The implementer commits after the launch: the reviewer saw the old tree.
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "unreviewed";\n' });
    const { tree: now } = await flow.bundle(p.root, s.id);
    const file = path.join(p.tmp, 'claims-head.json');
    reviewerWrote(p, session.id, { files: [path.join(p.wt(s.id, 'client'), 'src/pages/items.mjs')], output: file, review: { tree: now, seat: 'whole', findings: [], verified: [] } });
    const ctx = { cwd: p.root, root: p.root, env: process.env, actor: null, json: false };
    await assert.rejects(flow.cmdReview(ctx, { _: [], flags: { attempt: s.id, record: file, session: `claude:${session.id}` } }), (e) => e.refusalId === 'review:tree' && e.message.includes(`launched on tree ${b.tree}`));
    await assert.rejects(flow.recordReview(p.root, s.id, { session, seat: 'whole', tree: now, findings: [], verified: [] }), (e) => e.refusalId === 'review:tree');
    assert.equal(ledgerLines(p.root, s.id).filter((e) => e.type === 'review.recorded').length, 0);
  } finally {
    p.done();
  }
});

test('record: the review file must be the reviewer\'s own output: its transcript\'s write of these bytes, or its final message\'s JSON', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    const ctx = { cwd: p.root, root: p.root, env: process.env, actor: null, json: false };
    await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id } });
    const h = ledgerLines(p.root, s.id).find((e) => e.type === 'handoff');
    const dir = path.join(p.root, '.wf-evidence', 'attempts', s.id, 'reviews');
    const b = JSON.parse(read(path.join(dir, fs.readdirSync(dir).find((d) => d.startsWith('r1-')), 'bundle-whole.json')));
    const files = [path.join(p.wt(s.id, 'client'), 'src/pages/items.mjs')];
    const blocker = { findings: [finding('client/src/pages/items.mjs:1', 'goal', 'low')], verified: [], risk: LOW };
    // Someone else writes the file: the reviewer's transcript shows no write of it.
    reviewerTranscript({ home: p.home, cwd: p.root, files, session: h.data.session.id });
    fs.writeFileSync(b.output, JSON.stringify({ findings: [], verified: [] }));
    const rec = (extra = {}) => flow.cmdReview(ctx, { _: [], flags: { attempt: s.id, record: b.output, ...extra } });
    await assert.rejects(rec(), (e) => e.refusalId === 'review:independent' && /own output/.test(e.message));
    // The reviewer wrote a blocker; the file was then edited to drop it.
    reviewerWrote(p, h.data.session.id, { files, output: b.output, review: blocker });
    fs.writeFileSync(b.output, JSON.stringify({ findings: [], verified: [] }));
    await assert.rejects(rec(), (e) => e.refusalId === 'review:independent');
    // A reviewer that gives its JSON as its final message: the file holding that JSON is its own.
    const t = transcript({ home: p.home, cwd: p.root, session: h.data.session.id });
    for (const f of files) t.read(f);
    t.say(`Here is my review:\n${JSON.stringify(blocker)}`).write();
    fs.writeFileSync(b.output, JSON.stringify(blocker, null, 2));
    const r = await rec();
    assert.equal(r.data.blockers, 1);
  } finally {
    p.done();
  }
});

test('cmdReview launches every seat and the fast tests in parallel on one tree, then names the record step', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': '// a change\n', 'test/sum.spec.mjs': '// new test\n' });
    const ctx = { cwd: p.root, root: p.root, env: process.env, actor: null, json: false };
    const r = await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id } });
    const ev = ledgerLines(p.root, s.id);
    assert.deepEqual(ev.filter((e) => e.type === 'handoff').map((e) => e.data.seat), ['whole']);
    assert.deepEqual(ev.filter((e) => e.type === 'test.run').map((e) => e.data.kind), ['fast']);
    assert.match(r.text, /wf review --record/);
    const again = await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id } });
    assert.match(again.text, /already launched/);
    // The whole seat judges it high-risk, needing a second review and a failing test: the next `wf review` launches the
    // second seat and the merge-base run together.
    const h = ledgerLines(p.root, s.id).find((e) => e.type === 'handoff');
    reviewerTranscript({ home: p.home, cwd: p.root, files: [path.join(p.wt(s.id, 'server'), 'src/core/sum.mjs')], session: h.data.session.id });
    await flow.recordReview(p.root, s.id, { session: h.data.session, findings: [], verified: [], risk: { level: 'high', why: 'a total others rely on', needs: ['second-review', 'failing-test'] } });
    await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id } });
    const ev2 = ledgerLines(p.root, s.id);
    assert.deepEqual(ev2.filter((e) => e.type === 'handoff').map((e) => e.data.seat), ['whole', 'second']);
    assert.deepEqual(ev2.filter((e) => e.type === 'test.run').map((e) => e.data.kind).sort(), ['fast', 'risk-base']);
    setDoubles(doubles);
  } finally {
    p.done();
  }
});

test('the reviewer writes findings and verified where its prompt says; --record reads seat and tree from its bundle', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    const ctx = { cwd: p.root, root: p.root, env: process.env, actor: null, json: false };
    await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id } });
    const h = ledgerLines(p.root, s.id).find((e) => e.type === 'handoff');
    const bundleFile = fs.readdirSync(path.join(p.root, '.wf-evidence', 'attempts', s.id, 'reviews')).map((d) => path.join(p.root, '.wf-evidence', 'attempts', s.id, 'reviews', d, 'bundle-whole.json'))[0];
    const b = JSON.parse(read(bundleFile));
    reviewerWrote(p, h.data.session.id, { files: [path.join(p.wt(s.id, 'client'), 'src/pages/items.mjs')], output: b.output, review: { findings: [finding('client/src/pages/items.mjs:1', 'goal', 'low')], verified: [], risk: LOW } });
    const r = await flow.cmdReview(ctx, { _: [], flags: { attempt: s.id, record: b.output } });
    assert.equal(r.data.blockers, 1);
    assert.equal(r.data.findings[0].id, 'F1');
  } finally {
    p.done();
  }
});

void attempt;
