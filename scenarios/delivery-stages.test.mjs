// Stream 3: delivery stages. The snapshot, hold and deploy refusals, idempotent status and comments, pending labels,
// per-repo pushes and merge requests against their own bases in `order:`, patch-id matching, landing, `after:`, a project
// module and `wf deliver`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runStage, commandHandler, attemptDir, marker, worktreeDir } from '../engine/contract.mjs';
import { git, writeFiles } from './helpers/index.mjs';
import { deliveryProject } from './delivery-fixture.mjs';

const writeComment = (f, attempt, kind, text) => {
  const file = path.join(attemptDir(f.p.root, attempt), 'comments', `${kind}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const change = (f, attempt, repo, files, msg = 'change') => {
  const wt = worktreeDir(f.p.root, attempt, repo);
  writeFiles(wt, files);
  git(wt, ['add', '-A']);
  git(wt, ['commit', '--quiet', '-m', msg]);
  return git(wt, ['rev-parse', 'HEAD']);
};

test('the stage list is the snapshot taken at start; a later adapter change does not reach the attempt', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Ready' }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  f.adapter.delivery.stages = [{ do: 'status', to: 'Shipped' }];
  const r = await runStage(f.p.root, attempt, 0);
  assert.equal(r.state, 'done');
  assert.equal(f.tracker().issues.find((i) => i.id === 'TK-1').status, 'Ready');
  await assert.rejects(runStage(f.p.root, attempt, 1), /no delivery stage 1: its stage list \(snapshotted at start\) has 1/);
});

test('hold: no stage runs under a hold, the take included', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Ready' }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  await f.ledger.append(f.p.root, attempt, 'hold', { reason: 'pause', quote: 'stop everything' }, null);
  for (const stage of [0, { status: 'Started' }]) {
    await assert.rejects(runStage(f.p.root, attempt, stage), (e) => e.refusalId === 'hold' && e.code === 75 && /stop everything/.test(e.message));
  }
  assert.deepEqual(f.tracker().log, []);
});

test('status with a comment: the comment waits for the owner\'s words, is posted once with its marker, then the status; a rerun writes nothing', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Ready', comment: 'uat' }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  const first = await runStage(f.p.root, attempt, 0);
  assert.equal(first.state, 'pending');
  assert.match(first.next, /write the uat comment for TK-1 in product words/);
  writeComment(f, attempt, 'uat', 'Open the items page and add an item.');
  const done = await runStage(f.p.root, attempt, 0);
  assert.equal(done.state, 'done');
  const m = `${marker(attempt, 'stage-0')}:comment`;
  const issue = f.tracker().issues.find((i) => i.id === 'TK-1');
  assert.equal(issue.status, 'Ready');
  assert.deepEqual(issue.comments.map((c) => c.marker), [m]);
  assert.ok(issue.comments[0].body.endsWith(m));
  const writes = f.tracker().log.filter((l) => /^(comment|status) /.test(l));
  assert.deepEqual(writes, [`comment TK-1 ${m}`, 'status TK-1 Ready']);
  // The search for the marker came before the comment.
  const log = f.tracker().log;
  assert.ok(log.indexOf(`search marker ${m}`) < log.indexOf(`comment TK-1 ${m}`));
  // Settled: returned as recorded, nothing read or written again.
  const before = f.tracker().log.length;
  assert.equal((await runStage(f.p.root, attempt, 0)).state, 'done');
  assert.equal(f.tracker().log.length, before);
  assert.deepEqual(f.ledger.stageEvents(attempt).map((e) => e.data.state), ['pending', 'done']);
});

test('a lost ledger result does not write twice: the comment marker and the status are found on the tracker', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Ready', comment: 'uat' }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  writeComment(f, attempt, 'uat', 'Check the list.');
  await runStage(f.p.root, attempt, 0);
  // The stage event is gone (a crash after the write): run again.
  const list = f.ledger.ledgers.get(attempt);
  f.ledger.ledgers.set(attempt, list.filter((e) => e.type !== 'stage'));
  const r = await runStage(f.p.root, attempt, 0);
  assert.equal(r.state, 'done');
  assert.equal(r.evidence.written, false);
  assert.equal(r.evidence.comment.written, false);
  assert.equal(f.tracker().log.filter((l) => /^(comment|status) /.test(l)).length, 2);
});

test('when: labels — matched runs, unmatched is skipped, unreadable is pending and waits, never false', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Done', when: { labels: ['URGENT'] } }] } });
  t.after(f.cleanup);
  f.doubles();
  const a1 = await f.startAttempt('TK-1');
  const a2 = await f.startAttempt('TK-2');
  const a3 = await f.startAttempt('TK-3');
  const r1 = await runStage(f.p.root, a1, 0);
  assert.equal(r1.state, 'skipped');
  const r2 = await runStage(f.p.root, a2, 0);
  assert.equal(r2.state, 'done');
  assert.equal(f.tracker().issues.find((i) => i.id === 'TK-2').status, 'Done');
  const r3 = await runStage(f.p.root, a3, 0);
  assert.equal(r3.state, 'waiting');
  assert.equal(r3.evidence.when.read, 'pending');
  assert.equal(f.tracker().issues.find((i) => i.id === 'TK-3').status, 'Todo');
  // Readable later: it runs.
  const s = f.tracker();
  s.unreadable = [];
  fs.writeFileSync(f.trackerFile, JSON.stringify(s));
  assert.equal((await runStage(f.p.root, a3, 0)).state, 'done');
});

test('when: labels through a connector — pending until the owner reports them', async (t) => {
  const f = deliveryProject({ ticketing: { via: 'connector', operations: { read: 'Read the page and its tags.' } }, delivery: { stages: [{ do: 'confirm-deployed', where: 'production', when: { labels: ['hotfix'] } }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  const r = await runStage(f.p.root, attempt, 0);
  assert.equal(r.state, 'pending');
  assert.match(r.next, /^Read the page and its tags\. \(TK-1\), then report its labels: wf deliver TK-1\.1 --labels/);
  assert.equal((await runStage(f.p.root, attempt, 0, { labels: ['other'] })).state, 'skipped');
});

test('the take runs as stage -1: { status } is a status stage, recorded with index -1', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  const r = await runStage(f.p.root, attempt, { status: 'Started' });
  assert.equal(r.state, 'done');
  assert.equal(f.tracker().issues.find((i) => i.id === 'TK-1').status, 'Started');
  assert.deepEqual(f.ledger.stageEvents(attempt).map((e) => [e.data.index, e.data.do, e.data.state]), [[-1, 'status', 'done']]);
});

test('status through a connector: pending in the adapter\'s words, done once the owner\'s call carries the item and status', async (t) => {
  const f = deliveryProject({ ticketing: { via: 'connector', operations: { setStatus: 'Move the page to the status.' } }, delivery: { stages: [{ do: 'status', to: 'In Review' }] } });
  t.after(f.cleanup);
  const owner = { runtime: 'claude', id: 'o-1' };
  let calls = [];
  f.doubles({ connectorCalls: async () => calls });
  const attempt = await f.startAttempt('TK-1', 1, { owner });
  const r = await runStage(f.p.root, attempt, 0);
  assert.equal(r.state, 'pending');
  assert.match(r.next, /^Move the page to the status\. Item TK-1 to "In Review"/);
  calls = [{ tool: 'mcp__t__update', input: { id: 'TK-1', status: 'In Review' }, result: 'ok', at: 'x' }];
  assert.equal((await runStage(f.p.root, attempt, 0)).state, 'done');
  assert.deepEqual(f.tracker().log, []);
});

test('deploy is the person\'s: refused until answered, asked once; a decline stops the delivery', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'deploy', where: 'production' }] } });
  t.after(f.cleanup);
  const asked = [];
  let answer = null;
  f.doubles({ ask: async (root, attempt, q) => (asked.push(q), { id: 'D1', shownAt: 'x', new: asked.length === 1 }), answered: async () => answer });
  const attempt = await f.startAttempt('TK-1');
  await assert.rejects(runStage(f.p.root, attempt, 0), (e) => e.refusalId === 'stage:deploy' && /asked as D1/.test(e.message));
  assert.equal(asked[0].kind, 'deploy');
  assert.equal(asked[0].blocking, true);
  answer = { id: 'D1', choice: 'deploy', quote: 'deploy it', via: 'turn' };
  const p = await runStage(f.p.root, attempt, 0);
  assert.equal(p.state, 'pending');
  const d = await runStage(f.p.root, attempt, 0, { observed: 'version page shows the change' });
  assert.equal(d.state, 'done');
  assert.equal(d.evidence.observed, 'version page shows the change');

  const g = await f.startAttempt('TK-2');
  answer = { id: 'D1', choice: 'not now', quote: 'not now', via: 'turn' };
  assert.equal((await runStage(f.p.root, g, 0)).state, 'waiting');
});

test('push: the person\'s authority waits for the fact; the agent\'s pushes once, per repo, in order, refusing on a merge fact', async (t) => {
  const f = deliveryProject({ delivery: { order: ['client', 'server'], stages: [{ do: 'push' }] } });
  t.after(f.cleanup);
  let facts = [];
  const factCalls = [];
  f.doubles({ mergeFacts: async (root, attempt, o) => (factCalls.push(o), facts) });
  const attempt = await f.startAttempt('TK-1');
  const s1 = change(f, attempt, 'server', { 'src/a.mjs': 'a\n' });
  const c1 = change(f, attempt, 'client', { 'src/b.mjs': 'b\n' });
  const waiting = await runStage(f.p.root, attempt, 0);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.next, /the person pushes wf\/TK-1\.1 .* to origin\/wf\/TK-1\.1 in client/);
  f.adapter.delivery.authority.push = 'agent';
  const done = await runStage(f.p.root, attempt, 0);
  assert.equal(done.state, 'done');
  assert.deepEqual(Object.keys(done.evidence.repos), ['client', 'server']);
  assert.equal(done.evidence.repos.server.accepted, s1);
  assert.equal(done.evidence.repos.client.accepted, c1);
  assert.equal(git(f.p.repos.server.origin, ['rev-parse', 'wf/TK-1.1']), s1);
  // Pushing the attempt branch is not a landing: no merge facts asked.
  assert.equal(factCalls.length, 0);

  // A push onto the base is a landing: the merge facts are checked with the landed tree.
  const g = await f.startAttempt('TK-2', 1, { stages: [{ do: 'push', branch: 'trunk', repos: ['server'] }] });
  change(f, g, 'server', { 'src/c.mjs': 'c\n' });
  facts = [{ id: 'merge:open', message: 'F1 is open' }];
  await assert.rejects(runStage(f.p.root, g, 0), (e) => e.refusalId === 'merge:open');
  assert.ok(factCalls[0].landedTree && factCalls[0].repo === 'server');
  facts = [{ id: 'merge:untested', message: 'no full run' }];
  assert.equal((await runStage(f.p.root, g, 0)).state, 'done');
});

test('merge request per repo against its own base, then wait-merged by ancestry or by patch-id', async (t) => {
  const f = deliveryProject({ delivery: { authority: { push: 'agent', mergeRequest: 'agent', merge: 'person' }, stages: [{ do: 'merge-request' }, { do: 'wait-merged' }] } });
  t.after(f.cleanup);
  const owner = { runtime: 'claude', id: 'o-2' };
  let calls = [];
  f.doubles({ connectorCalls: async () => calls });
  const attempt = await f.startAttempt('TK-1', 1, { owner });
  const s1 = change(f, attempt, 'server', { 'src/a.mjs': 'a\n' }, 'one');
  change(f, attempt, 'server', { 'src/a2.mjs': 'a2\n' }, 'two');
  const s2 = git(worktreeDir(f.p.root, attempt, 'server'), ['rev-parse', 'HEAD']);
  const c1 = change(f, attempt, 'client', { 'src/b.mjs': 'b\n' });
  const mr = await runStage(f.p.root, attempt, 0);
  assert.equal(mr.state, 'pending');
  assert.match(mr.next, /server: wf\/TK-1\.1 into trunk; client: wf\/TK-1\.1 into stable/);
  assert.deepEqual([mr.evidence.repos.server.accepted, mr.evidence.repos.client.accepted], [s2, c1]);
  assert.equal(mr.evidence.repos.client.base, 'stable');
  calls = [{ tool: 'Bash', input: { command: `open request --body "${marker(attempt, 'stage-0')}"` }, result: 'opened', at: 'x' }];
  assert.equal((await runStage(f.p.root, attempt, 0)).state, 'done');

  assert.equal((await runStage(f.p.root, attempt, 1)).state, 'waiting');
  // The server change lands squashed into one commit by someone else; the client branch is merged as it is.
  const other = path.join(f.p.tmp, 'merger');
  git(f.p.tmp, ['clone', '--quiet', f.p.repos.server.origin, other]);
  git(other, ['checkout', '--quiet', 'trunk']);
  git(other, ['merge', '--quiet', '--squash', `origin/wf/${attempt}`]);
  git(other, ['commit', '--quiet', '-m', 'squashed']);
  git(other, ['push', '--quiet', 'origin', 'trunk']);
  const half = await runStage(f.p.root, attempt, 1);
  assert.equal(half.state, 'waiting');
  assert.equal(half.evidence.repos.server.how, 'patch-id');
  assert.equal(half.evidence.repos.client.merged, null);
  git(f.p.repos.client.dir, ['fetch', '--quiet']);
  git(f.p.repos.client.dir, ['push', '--quiet', 'origin', `${c1}:refs/heads/stable`]);
  const done = await runStage(f.p.root, attempt, 1);
  assert.equal(done.state, 'done');
  assert.equal(done.evidence.repos.client.how, 'ancestor');
  assert.equal(typeof done.waitedMin, 'number');
  assert.ok(s1);
});

test('land with the queue waits for this attempt\'s landing event; a merge fact refuses', async (t) => {
  const f = deliveryProject({ delivery: { landing: 'queue', stages: [{ do: 'land' }] } });
  t.after(f.cleanup);
  let facts = [];
  f.doubles({ mergeFacts: async () => facts });
  const attempt = await f.startAttempt('TK-1');
  change(f, attempt, 'server', { 'src/a.mjs': 'a\n' });
  facts = [{ id: 'merge:waiver', message: 'D2 is unanswered' }];
  await assert.rejects(runStage(f.p.root, attempt, 0), (e) => e.refusalId === 'merge:waiver');
  facts = [];
  const w = await runStage(f.p.root, attempt, 0);
  assert.equal(w.state, 'waiting');
  assert.deepEqual(w.evidence.queued, ['server']);
  await f.ledger.append(f.p.root, attempt, 'landing', { batch: 'L1', repo: 'server', attempts: [attempt], result: 'landed', sha: 'abc' }, null);
  const d = await runStage(f.p.root, attempt, 0);
  assert.equal(d.state, 'done');
  assert.equal(d.evidence.repos.server.accepted, 'abc');
});

test('after: <item> waits until that item shipped; a project module stage gets the marker and repos', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  f.doubles();
  writeFiles(f.p.repos.server.dir, { '.workflow/notify.mjs': 'export default async (ctx) => ({ state: "done", evidence: { marker: ctx.marker, repos: Object.keys(ctx.repos) } });\n' });
  const dep = await f.startAttempt('TK-2', 1, { stages: [] });
  const attempt = await f.startAttempt('TK-1', 1, { stages: [{ do: 'module', module: { repo: 'server', path: '.workflow/notify.mjs' }, after: 'TK-2' }] });
  const w = await runStage(f.p.root, attempt, 0);
  assert.equal(w.state, 'waiting');
  assert.match(w.next, /until TK-2 has shipped/);
  await f.ledger.append(f.p.root, dep, 'attempt.closed', { outcome: 'shipped', reason: 'landed' }, null);
  const d = await runStage(f.p.root, attempt, 0);
  assert.equal(d.state, 'done');
  assert.deepEqual(d.evidence, { marker: marker(attempt, 'stage-0'), repos: ['server', 'client'] });
});

test('wf deliver runs the stages in order up to the first unsettled one, and names what is next', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'status', to: 'Ready' }, { do: 'comment', comment: 'uat' }, { do: 'confirm-deployed', where: 'staging' }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  const deliver = commandHandler('deliver');
  const ctx = { cwd: f.p.root, root: f.p.root, env: {}, actor: null, json: false };
  const r1 = await deliver(ctx, { _: [], flags: {} });
  assert.deepEqual(r1.data.results.map((r) => [r.do, r.state]), [['status', 'done'], ['comment', 'pending']]);
  assert.match(r1.text, /write the uat comment/);
  writeComment(f, attempt, 'uat', 'Look at the list.');
  const r2 = await deliver(ctx, { _: [attempt], flags: {} });
  assert.deepEqual(r2.data.results.map((r) => r.state), ['done', 'done', 'pending']);
  const r3 = await deliver(ctx, { _: [attempt], flags: { observed: 'the list shows on staging' } });
  assert.equal(r3.data.delivered, true);
  assert.match(r3.text, /delivered/);
});

test('wait-merged matches a rebase merge: every commit replayed on the base by patch-id', async (t) => {
  const f = deliveryProject({ delivery: { stages: [{ do: 'wait-merged', repos: ['server'] }] } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-1');
  const a = change(f, attempt, 'server', { 'src/a.mjs': 'a\n' }, 'one');
  const b = change(f, attempt, 'server', { 'src/b.mjs': 'b\n' }, 'two');
  assert.equal((await runStage(f.p.root, attempt, 0)).state, 'waiting');
  // Someone else moved the base, then the two commits were replayed onto it.
  f.p.pushElsewhere('server', { 'other.txt': 'x\n' });
  const other = path.join(f.p.tmp, 'elsewhere', 'server');
  git(other, ['fetch', '--quiet', f.p.repos.server.dir, `${a}`, `${b}`]);
  git(other, ['cherry-pick', a, b]);
  git(other, ['push', '--quiet', 'origin', 'HEAD:trunk']);
  const done = await runStage(f.p.root, attempt, 0);
  assert.equal(done.state, 'done');
  assert.equal(done.evidence.repos.server.how, 'patch-id');
});
