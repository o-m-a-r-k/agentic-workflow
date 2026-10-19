// Stream 1, the 0.8 review fixes: start from another base (--base) or with no tracker, the role text handoff prints,
// `wf review` waiting for its reviewers, status naming a running reviewer and the open questions, close by patch-id
// (no commits, outside the stages, a squashed landing), risk-base runs by tree, screens with no routes, and fast tests
// green on HEAD as a merge fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, ledgerLines, reviewerTranscript, runWf } from './helpers/index.mjs';
import doubles from './flow-doubles.mjs';
import { spawnSync } from 'node:child_process';
import { attempt, commitWt, flow, review, reviewerWrote, setup, started } from './flow-fixture.mjs';
import { attemptState } from '../engine/contract.mjs';

const ctxOf = (p) => ({ cwd: p.root, root: p.root, env: { ...process.env }, actor: { runtime: 'claude', id: 'owner-1' }, json: false });
const args = (_ = [], flags = {}) => ({ _, flags });
const template = (role) => fs.readFileSync(new URL(`../templates/agents/${role}.md`, import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();

// A launch record as wf's launch supervisor writes it.
function launchRecord(p, id, session, status) {
  const dir = path.join(p.root, '.wf-evidence', 'attempts', id, 'reviews', `launch-${session.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ host: session.runtime, closure: path.join(dir, 'review.json') }));
  const write = (s) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ session: session.id, ...s }));
  write(status);
  return write;
}

test('start --base: refused while the stages hold a `land` (it lands on the adapter base), naming the kinds that deliver another base', async () => {
  const p = setup();
  try {
    const dir = p.repos.server.dir;
    git(dir, ['checkout', '--quiet', '-b', 'side']);
    git(dir, ['push', '--quiet', 'origin', 'side']);
    git(dir, ['checkout', '--quiet', 'trunk']);
    await assert.rejects(attempt.cmdStart(ctxOf(p), args(['TK-4'], { base: 'server=side' })), (e) => /stages land on the adapter's base, so work started from side in server would land on trunk/.test(e.message) && /merge-request, push \(with its branch\) or module/.test(e.hint));
    assert.ok(!fs.existsSync(path.join(p.root, '.wf-worktrees', 'TK-4.1')), 'nothing was created');
    // The adapter's own base is no other base.
    assert.equal((await attempt.cmdStart(ctxOf(p), args(['TK-4'], { base: 'server=trunk' }))).data.attempt, 'TK-4.1');
  } finally {
    p.done();
  }
});

test('start --base: the attempt starts from that branch, records it, and every base read of the attempt uses it', async () => {
  const p = setup({ overrides: { delivery: { landing: 'direct', order: ['server', 'client'], stages: [{ do: 'merge-request' }, { do: 'wait-merged' }] } } });
  try {
    const dir = p.repos.server.dir;
    git(dir, ['checkout', '--quiet', '-b', 'side']);
    const side = p.commit('server', { 'src/side.mjs': 'export const side = 1;\n' }, 'side work');
    git(dir, ['push', '--quiet', 'origin', 'side']);
    git(dir, ['checkout', '--quiet', 'trunk']);
    const r = await attempt.cmdStart(ctxOf(p), args(['TK-4'], { base: 'server=side' }));
    const s = await attemptState(p.root, r.data.attempt);
    assert.equal(s.repos.server.base, 'side');
    assert.equal(s.repos.client.base, 'stable', 'other repos keep the adapter base');
    assert.equal(git(p.wt(s.id, 'server'), ['rev-parse', 'HEAD']), side);
    await flow.setCriteria(p.root, s.id, { criteria: ['x'], areas: [] }, { actor: null });
    commitWt(p, s.id, 'server', { 'src/routes/items.controller.mjs': 'export const routes = ["/items", "/x"];\n' });
    const { bundles } = await flow.bundle(p.root, s.id);
    assert.deepEqual(bundles[0].productFiles, ['server/src/routes/items.controller.mjs'], 'the diff is against the attempt base, not the adapter base');
    await assert.rejects(attempt.cmdStart(ctxOf(p), args(['TK-5'], { base: 'nowhere=side' })), /unknown repo `nowhere`/);
  } finally {
    p.done();
  }
});

test('start --no-tracker <id>: no tracker id, no take status, no tracker stages; recorded as ticketing none; --repos in help', async () => {
  const p = setup();
  try {
    const r = await attempt.cmdStart(ctxOf(p), args([], { 'no-tracker': 'cleanup-1', repos: 'client' }));
    assert.equal(r.data.attempt, 'cleanup-1.1');
    const [first, ...rest] = ledgerLines(p.root, 'cleanup-1.1');
    assert.equal(first.data.ticketing, 'none');
    assert.deepEqual(Object.keys(first.data.repos), ['client']);
    assert.deepEqual(first.data.stages, [{ do: 'land' }]);
    assert.ok(!rest.some((e) => e.type === 'stage'), 'no tracker status at start');
    const h = runWf(p, ['help']);
    for (const flag of ['--repos', '--base', '--no-tracker', '--no-wait']) assert.ok(h.out.includes(flag), flag);
  } finally {
    p.done();
  }
});

test('handoff prints the role text the plugin ships (frontmatter stripped) as the agent\'s instructions; no tester role', async () => {
  const p = setup();
  try {
    const s = await started(p);
    for (const role of ['implementer', 'planner']) {
      const r = await flow.cmdHandoff(ctxOf(p), args([role], { attempt: s.id, session: `claude:${role}-1` }));
      assert.ok(r.data.prompt.startsWith(template(role)), role);
      assert.ok(r.text.includes(template(role)), role);
      assert.ok(r.data.prompt.includes(p.wt(s.id, 'server')), 'it names the worktrees');
    }
    await assert.rejects(flow.cmdHandoff(ctxOf(p), args(['tester'], { attempt: s.id, session: 'claude:t' })), /planner\|implementer/);
  } finally {
    p.done();
  }
});

test('wf review waits until its reviewers are done; status names a running reviewer and ends with the open questions', async () => {
  const p = setup({ overrides: { screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    const { bundles } = await flow.bundle(p.root, s.id);
    const { session } = await doubles.launchReviewer(p.root, s.id, bundles[0]);
    const write = launchRecord(p, s.id, session, { state: 'running', startedAt: new Date(Date.now() - 5 * 60000).toISOString() });
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    const st = await flow.cmdStatus(ctxOf(p), args([], {}));
    assert.match(st.text, new RegExp(`next: wf review --attempt ${s.id.replace('.', '\\.')}\\n  why: reviewer whole running since 5 min`));
    assert.match(st.text, /open questions for the person: 0$/);
    // Waits for the run, then names the record step.
    setTimeout(() => write({ state: 'done', startedAt: new Date().toISOString() }), 400);
    const t0 = Date.now();
    const prev = process.env.WF_TEST;
    process.env.WF_TEST = '1';
    const r = await flow.cmdReview(ctxOf(p), args([], { attempt: s.id }));
    process.env.WF_TEST = prev;
    assert.ok(Date.now() - t0 >= 350, 'it waited');
    assert.match(r.text, /reviewer whole: done; record it: wf review --record/);
    // An open question is counted, with the digest hint, in status and resume.
    await doubles.ask(p.root, s.id, { kind: 'priority-other', question: 'Schedule it?', options: ['schedule it', 'leave it'], refs: ['F9'], blocking: false });
    for (const cmd of [flow.cmdStatus, flow.cmdResume]) {
      const out = await cmd(ctxOf(p), args([], {}));
      assert.match(out.text, /open questions for the person: 1; `wf digest` lists them$/);
      assert.equal(out.data.openQuestions, 1);
    }
  } finally {
    p.done();
  }
});

test('close: no commits is refused; by patch-id outside the stages records outsideStages; a squashed landing counts', async () => {
  const p = setup();
  try {
    const empty = await started(p, 'TK-6');
    await assert.rejects(attempt.cmdClose(ctxOf(p), args([], { attempt: empty.id })), /has no commits/);
    await attempt.cmdAbandon(ctxOf(p), args([], { attempt: empty.id, reason: 'nothing to do' }));

    const s = await started(p, 'TK-7');
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0) || 0;\n' }, 'one');
    commitWt(p, s.id, 'server', { 'src/core/extra.mjs': 'export const extra = 1;\n' }, 'two');
    // Landed as one squashed commit on the base.
    const dir = p.repos.server.dir;
    git(dir, ['merge', '--quiet', '--squash', `wf/${s.id}`]);
    git(dir, ['commit', '--quiet', '-m', 'squashed']);
    git(dir, ['push', '--quiet', 'origin', 'trunk']);
    const c = await attempt.cmdClose(ctxOf(p), args([], { attempt: s.id }));
    assert.equal(c.data.outcome, 'shipped');
    assert.equal(c.data.outsideStages, true);
    const closed = ledgerLines(p.root, s.id).find((e) => e.type === 'attempt.closed');
    assert.equal(closed.data.outsideStages, true);
    assert.equal(closed.data.row.outsideStages, true);
  } finally {
    p.done();
  }
});

test('risk-base runs count for the tree they ran on, not by time', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = () => 0;\n', 'test/sum.spec.mjs': '// asserts\n' });
    await doubles.runTests(p.root, s.id, 'server', 'risk-base');
    const missing = async () => (await flow.mergeFacts(p.root, s.id)).find((f) => f.id === 'merge:risk')?.message ?? '';
    assert.doesNotMatch(await missing(), /run on the merge-base/);
    // A later commit dated in the past: the earlier run is not on this tree.
    const wt = p.wt(s.id, 'server');
    fs.writeFileSync(path.join(wt, 'test/sum.spec.mjs'), '// asserts nothing now\n');
    git(wt, ['commit', '--quiet', '-am', 'old date'], { env: { GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z' } });
    assert.match(await missing(), /risk tests of server run on the merge-base/);
  } finally {
    p.done();
  }
});

test('screens are due with no routes when a shared file changes and a sentinel set exists', async () => {
  const p = setup({ overrides: { screens: { shared: ['client/src/common/**'], sentinel: ['/'], langs: [{ lang: 'l1', dir: 'ltr' }], viewports: [400], capture: 'node capture.mjs --out {out}' } } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/common/button.mjs': 'export const button = 3;\n' });
    assert.match((await flow.cmdStatus(ctxOf(p), args([], {}))).text, /next: wf screens/);
  } finally {
    p.done();
  }
});

test('merge facts: fast tests green on HEAD in each changed repo (merge:untested); status names the fast run', async () => {
  const p = setup({ overrides: { screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    // Reviewed, but no fast run on this tree.
    const { tree, bundles } = await flow.bundle(p.root, s.id);
    const { session } = await doubles.launchReviewer(p.root, s.id, bundles[0]);
    reviewerTranscript({ home: p.home, cwd: p.root, files: [path.join(p.wt(s.id, 'client'), 'src/pages/items.mjs')], session: session.id });
    await flow.recordReview(p.root, s.id, { session, tree, findings: [], verified: [] });
    let facts = await flow.mergeFacts(p.root, s.id);
    assert.deepEqual(facts.map((f) => [f.id, f.fact]), [['merge:untested', 'fast']]);
    assert.match((await flow.cmdStatus(ctxOf(p), args([], {}))).text, /next: wf test fast --repo client/);
    process.env.WF_TEST_FAST_FAIL = '1';
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    delete process.env.WF_TEST_FAST_FAIL;
    assert.match((await flow.mergeFacts(p.root, s.id))[0].message, /not green on HEAD \(they fail\)/);
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    facts = await flow.mergeFacts(p.root, s.id);
    assert.deepEqual(facts, []);
  } finally {
    p.done();
  }
});

test('a reviewer whose launch supervisor died is failed: status says so, and wf review launches it again instead of waiting', async () => {
  const p = setup({ overrides: { screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = "/items/";\n' });
    const { bundles } = await flow.bundle(p.root, s.id);
    const { session } = await doubles.launchReviewer(p.root, s.id, bundles[0]);
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    // A live supervisor: still running.
    launchRecord(p, s.id, session, { state: 'running', startedAt: new Date().toISOString(), pid: process.pid });
    assert.match((await flow.cmdStatus(ctxOf(p), args([], {}))).text, /reviewer whole running since/);
    // Its supervisor is gone (a pid that exited), the run never ended.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    launchRecord(p, s.id, session, { state: 'running', startedAt: new Date().toISOString(), pid: dead, pidAt: new Date().toISOString() });
    const st = await flow.cmdStatus(ctxOf(p), args([], {}));
    assert.match(st.text, new RegExp(`reviewer whole failed \\(its launch supervisor \\(pid ${dead}\\) is no longer running`));
    const prev = process.env.WF_TEST;
    process.env.WF_TEST = '1';
    const r = await Promise.race([flow.cmdReview(ctxOf(p), args([], { attempt: s.id })), new Promise((_, no) => setTimeout(() => no(new Error('wf review waited for a dead reviewer')), 5000))]);
    process.env.WF_TEST = prev;
    assert.match(r.text, /reviewer whole: launched claude:rev-/);
  } finally {
    p.done();
  }
});

test('the fast fact is the run on the worktree\'s files; files HEAD lacks are named, with what to do', async () => {
  const p = setup({ overrides: { screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'client', { 'src/pages/items.mjs': 'export const page = 1;\n' });
    const { tree, bundles } = await flow.bundle(p.root, s.id);
    const { session } = await doubles.launchReviewer(p.root, s.id, bundles[0]);
    reviewerTranscript({ home: p.home, cwd: p.root, files: [path.join(p.wt(s.id, 'client'), 'src/pages/items.mjs')], session: session.id });
    await flow.recordReview(p.root, s.id, { session, tree, findings: [], verified: [] });
    // An untracked file the tests ran with: the run (as `wf test` records it) is on the worktree's files.
    const wt = p.wt(s.id, 'client');
    fs.writeFileSync(path.join(wt, 'scratch.log'), 'left over\n');
    const { workingTree } = await import('../engine/tests.mjs');
    await doubles.append(p.root, s.id, 'test.run', { repo: 'client', kind: 'fast', tree: workingTree(wt), pass: true, exitCode: 0, ms: 1, source: 'attempt' }, null);
    const [fact] = await flow.mergeFacts(p.root, s.id);
    assert.equal(fact.id, 'merge:untested');
    assert.match(fact.message, /they passed on the worktree's files, not on HEAD's\); the worktree has files HEAD lacks: scratch\.log/);
    assert.match(fact.hint, /commit scratch\.log or ignore them \(\.gitignore\)/);
    const { nextStep } = await import('../engine/flow.mjs');
    const step = await nextStep(p.root, s.id);
    assert.match(step.command, /^wf handoff implementer/);
    assert.match(step.why, /scratch\.log/);
    // Clean again: the run on HEAD's tree is the fact.
    fs.rmSync(path.join(wt, 'scratch.log'));
    await doubles.runTests(p.root, s.id, 'client', 'fast');
    assert.deepEqual(await flow.mergeFacts(p.root, s.id), []);
  } finally {
    p.done();
  }
});

test('provenance: with no readable transcript the review is recorded unverified, shown at the diff-read and in the digest', async () => {
  const p = setup();
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n// edge\n', 'test/sum.spec.mjs': '// asserts\n' });
    const { bundles } = await flow.bundle(p.root, s.id);
    assert.deepEqual(bundles.map((b) => b.seat), ['whole', 'second']);
    process.env.WF_TEST_NO_TRANSCRIPT = '1';
    for (const b of bundles) {
      const { session } = await doubles.launchReviewer(p.root, s.id, b);
      fs.writeFileSync(b.output, JSON.stringify({ findings: [], verified: [] }));
      const r = await flow.cmdReview(ctxOf(p), args([], { attempt: s.id, record: b.output, session: `${session.runtime}:${session.id}` }));
      assert.match(r.text, /coverage unverified, provenance unverified\)/);
    }
    const recorded = ledgerLines(p.root, s.id).filter((e) => e.type === 'review.recorded');
    assert.deepEqual(recorded.map((e) => e.data.provenance), ['unverified', 'unverified']);
    await flow.mergeFacts(p.root, s.id);
    const ask = ledgerLines(p.root, s.id).find((e) => e.type === 'decision.asked' && e.data.kind === 'diff-read');
    assert.match(ask.data.question, /The review files could not be traced to their reviewers from transcripts\./);
    const { digest } = await import('../engine/digest.mjs');
    const d = await digest(p.root);
    assert.match(d.text, /Reviews not traced to their reviewer \(no readable transcript\) \(2\):/);
    // A readable transcript that contradicts the file is still refused.
    delete process.env.WF_TEST_NO_TRANSCRIPT;
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n// edge 2\n' });
    const next = await flow.bundle(p.root, s.id);
    const { session } = await doubles.launchReviewer(p.root, s.id, next.bundles[0]);
    reviewerWrote(p, session.id, { files: next.bundles[0].productFiles.map((f) => path.join(p.wt(s.id, 'server'), f.slice('server/'.length))), output: next.bundles[0].output, review: { findings: [], verified: [] } });
    fs.writeFileSync(next.bundles[0].output, JSON.stringify({ findings: [{ location: 'server/src/core/sum.mjs:1', class: 'goal', severity: 'low', what: 'added later', why: 'by someone else' }], verified: [] }));
    await assert.rejects(flow.cmdReview(ctxOf(p), args([], { attempt: s.id, record: next.bundles[0].output, session: `${session.runtime}:${session.id}` })), (e) => e.refusalId === 'review:independent');
  } finally {
    delete process.env.WF_TEST_NO_TRANSCRIPT;
    p.done();
  }
});

test('resume loads the attempt once and lists a question its next step just asked (the diff-read) among those waiting', async () => {
  const p = setup({ overrides: { screens: undefined } });
  try {
    const s = await started(p);
    commitWt(p, s.id, 'server', { 'src/core/sum.mjs': 'export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n// edge\n', 'test/sum.spec.mjs': '// asserts\n' });
    await review(p, s.id);
    await doubles.runTests(p.root, s.id, 'server', 'risk-base');
    const r = await flow.cmdResume(ctxOf(p), args([], { attempt: s.id }));
    assert.match(r.text, /next: wf approve D1 /);
    assert.match(r.text, /questions waiting for the person: D1 "TK-1\.1 touches risk path\(s\) sums\. Read the diff/);
    assert.deepEqual(r.data.attempts[0].decisions, ['D1']);
  } finally {
    p.done();
  }
});

test('deliver asks the tracker status set at start again while it is pending, and runs no stage before it is done', async () => {
  const p = setup({ overrides: { screens: undefined, ticketing: { via: 'connector', tracker: 'board', idPattern: '^TK-\\d+$', take: { status: 'Started' }, followUps: { mode: 'off' } }, delivery: { landing: 'direct', order: ['server', 'client'], stages: [{ do: 'status', to: 'Ready' }] } } });
  try {
    const s = await started(p);
    // The take was asked at start and is pending: the owner has not set the status yet.
    await doubles.append(p.root, s.id, 'stage', { index: -1, do: 'status', state: 'pending', next: 'Set the status' }, null);
    const calls = [];
    const { setDoubles } = await import('../engine/contract.mjs');
    setDoubles({ connectorCalls: async (session) => (session?.id === 'owner-1' ? calls : []) });
    const { cmdDeliver } = await import('../engine/delivery.mjs');
    const stages = () => ledgerLines(p.root, s.id).filter((e) => e.type === 'stage').map((e) => [e.data.index, e.data.state]);
    const first = await cmdDeliver(ctxOf(p), args([s.id], {}));
    assert.match(first.text, /^-1 status: pending — .*Item TK-1 to "Started"/m);
    assert.equal(first.data.delivered, false);
    assert.ok(!stages().some(([i]) => i === 0), 'no stage ran before the take is done');
    calls.push({ tool: 'mcp__board__update_issue', input: { id: 'TK-1', status: 'Started' }, result: 'TK-1 is now Started', at: new Date(Date.now() + 1000).toISOString() });
    const second = await cmdDeliver(ctxOf(p), args([s.id], {}));
    assert.match(second.text, /^-1 status: done$/m);
    assert.deepEqual(stages().slice(-2), [[-1, 'done'], [0, 'pending']]);
  } finally {
    p.done();
  }
});
