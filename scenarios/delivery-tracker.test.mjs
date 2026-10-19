// Stream 3: the tracker. Id normalisation and numbering continuity, search, opt-in follow-ups filed once by marker with
// the adapter's team, status and label (never the item's labels), connector operations read back from the transcript,
// and the generic files tracker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseId, search, fileFollowUp, ledgerFile, marker, runStage, TRACKER_OPERATIONS } from '../engine/contract.mjs';
import { trackerOf, wordsFor } from '../engine/tracker.mjs';
import { from07 } from '../engine/migrate.mjs';
import { git } from './helpers/index.mjs';
import { deliveryProject } from './delivery-fixture.mjs';
import { filesTracker } from '../adapters/tracker/files.mjs';

const otherFinding = (id = 'F3', what = 'The list header overlaps the filter row') => ({ id, location: 'client/src/pages/items.mjs:1', what, why: 'people cannot read it', severity: 'low', class: 'other' });

test('normaliseId: different raw ids of one item resolve to one id, checked with the tracker', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  f.doubles();
  for (const raw of ['TK-1', 'tk1', ' tk-1 ', 'TK1']) assert.deepEqual(await normaliseId(f.p.root, raw), { item: 'TK-1', verified: true, canonical: 'TK-1' }, raw);
  await assert.rejects(normaliseId(f.p.root, 'TK-99'), /no item TK-99 in the tracker/);
  await assert.rejects(normaliseId(f.p.root, '../etc'), /not an item id/);
  await assert.rejects(normaliseId(f.p.root, ''), /item id is needed/);
});

test('normaliseId without a tracker: the idPattern, case and an id inside a URL; never verified', async (t) => {
  const f = deliveryProject({ ticketing: { tracker: null, via: 'none', idPattern: '^AB-\\d+$' } });
  t.after(f.cleanup);
  f.doubles();
  for (const raw of ['AB-12', 'ab-12', 'https://tracker.example.test/issue/AB-12/some-title']) assert.deepEqual(await normaliseId(f.p.root, raw), { item: 'AB-12', verified: false, canonical: 'AB-12' }, raw);
  await assert.rejects(normaliseId(f.p.root, 'AB12'), /not an item id of this project \(ticketing.idPattern/);
});

test('normaliseId: an item earlier ledgers or branches spelled differently keeps that spelling, so numbering continues', async (t) => {
  const f = deliveryProject({ ticketing: { tracker: null, via: 'none', idPattern: '^AB-\\d+$' } });
  t.after(f.cleanup);
  f.doubles();
  // A 0.7 ledger under the lower-case spelling.
  fs.mkdirSync(path.dirname(ledgerFile(f.p.root, 'ab-4.1')), { recursive: true });
  fs.writeFileSync(ledgerFile(f.p.root, 'ab-4.1'), '');
  assert.deepEqual(await normaliseId(f.p.root, 'AB-4'), { item: 'ab-4', verified: false, canonical: 'AB-4' });
  // A branch only (its ledger gone).
  git(f.p.repos.client.dir, ['branch', 'wf/ab-5.2']);
  assert.equal((await normaliseId(f.p.root, 'AB-5')).item, 'ab-5');
  assert.equal((await normaliseId(f.p.root, 'ab-6')).item, 'AB-6');
});

test('search: through the module, by text (open issues) and by marker', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  f.doubles();
  const r = await search(f.p.root, { text: 'Second' });
  assert.equal(r.state, 'done');
  assert.deepEqual(r.value.map((i) => i.id), ['TK-2']);
  assert.deepEqual((await search(f.p.root, { marker: 'wf:TK-1.1:x' })).value, []);
});

test('fileFollowUp: off and digest file nothing; file searches the marker, then the title, then creates once', async (t) => {
  const f = deliveryProject({ ticketing: { followUps: { mode: 'off' } } });
  t.after(f.cleanup);
  f.doubles();
  const attempt = await f.startAttempt('TK-2');
  assert.deepEqual(await fileFollowUp(f.p.root, attempt, otherFinding()), { state: 'done', value: null });
  f.adapter.ticketing.followUps = { mode: 'digest' };
  assert.deepEqual(await fileFollowUp(f.p.root, attempt, otherFinding()), { state: 'done', value: null });
  assert.deepEqual(f.tracker().log, []);

  f.adapter.ticketing.followUps = { mode: 'file', team: 'T1', status: 'Backlog', label: 'found-in-review' };
  const first = await fileFollowUp(f.p.root, attempt, otherFinding());
  assert.deepEqual(first, { state: 'done', value: { id: 'TK-4', duplicateOf: null } });
  const m = marker(attempt, 'finding:F3');
  const filed = f.tracker().issues.find((i) => i.id === 'TK-4');
  // The adapter's label only: the item TK-2 carries `urgent`, which is never copied.
  assert.deepEqual(filed.labels, ['found-in-review']);
  assert.equal(filed.status, 'Backlog');
  assert.equal(filed.team, 'T1');
  assert.ok(filed.body.includes(m));
  assert.deepEqual(f.tracker().log, [`search marker ${m}`, 'search text The list header overlaps the filter row', `create TK-4 ${m}`]);

  // Again: the marker is found, nothing is created.
  assert.deepEqual(await fileFollowUp(f.p.root, attempt, otherFinding()), { state: 'done', value: { id: 'TK-4', duplicateOf: null } });
  assert.equal(f.tracker().log.filter((l) => l.startsWith('create')).length, 1);

  // Another finding with the same title: a duplicate of the open issue, nothing created.
  assert.deepEqual(await fileFollowUp(f.p.root, attempt, otherFinding('F4')), { state: 'done', value: { id: null, duplicateOf: 'TK-4' } });
  assert.equal(f.tracker().log.filter((l) => l.startsWith('create')).length, 1);
  // A token quoted in a finding is scrubbed from the follow-up's title and body at post.
  const token = ['ghp', 'Q'.repeat(24)].join('_');
  const leaked = await fileFollowUp(f.p.root, attempt, { ...otherFinding('F5', `The sync logs ${token}`), why: `it shows ${token}` });
  const issue = f.tracker().issues.find((i) => i.id === leaked.value.id);
  assert.ok(issue && !issue.title.includes(token) && !issue.body.includes(token) && issue.body.includes('[secret]'), 'the follow-up is scrubbed at post');
});

test('fileFollowUp through a connector: pending in the adapter\'s words, then read back from the owner\'s tool call', async (t) => {
  const words = 'Create an issue in team T1 with the body file; read it back.';
  const f = deliveryProject({ ticketing: { via: 'connector', followUps: { mode: 'file', team: 'T1' }, operations: { fileFollowUp: words } } });
  t.after(f.cleanup);
  const owner = { runtime: 'claude', id: 'owner-1' };
  let calls = [];
  f.doubles({ connectorCalls: async (session) => (session.id === 'owner-1' ? calls : []) });
  const attempt = await f.startAttempt('TK-1', 1, { owner });
  const m = marker(attempt, 'finding:F3');
  const pending = await fileFollowUp(f.p.root, attempt, otherFinding());
  assert.equal(pending.state, 'pending');
  assert.equal(pending.operation, words);
  assert.equal(pending.marker, m);
  assert.ok(fs.readFileSync(pending.details.bodyFile, 'utf8').includes(m));
  assert.equal(pending.details.team, 'T1');
  // The flow records the pending follow-up; its time is the first ask, from the ledger (no side file).
  await f.ledger.append(f.p.root, attempt, 'finding.filed', { finding: 'F3', mode: 'file', state: 'pending', marker: m }, null);
  assert.ok(!fs.readdirSync(path.dirname(pending.details.bodyFile)).some((x) => x.endsWith('.asked')));
  // The engine wrote nothing to the tracker itself.
  assert.deepEqual(f.tracker().log, []);
  const title = 'The list header overlaps the filter row';
  const soon = (min) => new Date(Date.now() + min * 60000).toISOString();
  // Not counted: a call made before the follow-up was asked, one without the title, an error, a result with no new id.
  calls = [
    { tool: 'mcp__tracker__create_issue', input: { title, description: `text ${m}` }, result: 'Created TK-7', at: '2026-01-01T00:00:00.000Z' },
    { tool: 'mcp__tracker__create_issue', input: { title: 'Another', description: `text ${m}` }, result: 'Created TK-8', at: soon(1) },
    { tool: 'mcp__tracker__create_issue', input: { title, description: `text ${m}` }, result: 'Created TK-8', error: true, at: soon(2) },
    { tool: 'mcp__tracker__create_issue', input: { title, description: `text ${m}` }, result: 'Created (for TK-1)', at: soon(3) },
  ];
  const still = await fileFollowUp(f.p.root, attempt, otherFinding());
  assert.equal(still.state, 'pending');
  assert.deepEqual(still.rejected.map((r) => r.why), ['its result is an error', 'its result shows no new issue id']);
  calls.push({ tool: 'mcp__tracker__create_issue', input: { team: 'T1', title, description: `text ${m}` }, result: 'Created TK-9 (for TK-1)', at: soon(4) });
  assert.deepEqual(await fileFollowUp(f.p.root, attempt, otherFinding()), { state: 'done', value: { id: 'TK-9', duplicateOf: null } });
  // Without an id pattern the new id cannot be read back: refused before the owner is asked to create anything.
  f.adapter.ticketing.idPattern = null;
  await assert.rejects(fileFollowUp(f.p.root, attempt, otherFinding('F5', 'Other')), /ticketing\.idPattern is unset/);
});

test('a 0.7 tracker `kind` migrated to a connector is only its name: every tracker call works through the connector', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  const { seed } = await from07(f.p.root, { name: 'neutral', repos: [{ name: 'server', path: 'server', base: 'trunk' }], tracker: { kind: 'acme', idPrefix: 'TK', statuses: { started: 'Started' } } });
  assert.equal(seed.ticketing.tracker, 'acme');
  assert.equal(seed.ticketing.via, 'connector');
  Object.assign(f.adapter.ticketing, seed.ticketing);
  const owner = { runtime: 'claude', id: 'o-07' };
  let calls = [];
  f.doubles({ connectorCalls: async () => calls });
  const tr = await trackerOf(f.p.root, f.adapter);
  assert.deepEqual([tr.via, tr.driver], ['connector', null]);
  assert.deepEqual(await normaliseId(f.p.root, 'tk-3'), { item: 'TK-3', verified: false, canonical: 'TK-3' });
  const attempt = await f.startAttempt('TK-3', 1, { owner });
  assert.equal((await runStage(f.p.root, attempt, seed.ticketing.take)).state, 'pending');
  calls = [{ tool: 'mcp__acme__update', input: { id: 'TK-3', status: 'Started' }, result: 'TK-3 is now Started', at: '2026-02-01T00:00:00.000Z' }];
  assert.equal((await runStage(f.p.root, attempt, seed.ticketing.take)).state, 'done');
  assert.deepEqual(f.tracker().log, []);
  // A string tracker that is not a connector's still names a built-in one.
  f.adapter.ticketing.via = 'module';
  await assert.rejects(trackerOf(f.p.root, f.adapter), /ticketing\.tracker `acme` is not a built-in tracker/);
});

test('one operations list: the engine has words for every operation an adapter may name, and the adapter\'s come first', async (t) => {
  const f = deliveryProject({ ticketing: { via: 'connector', operations: Object.fromEntries(TRACKER_OPERATIONS.map((op) => [op, `Own words for ${op}.`])) } });
  t.after(f.cleanup);
  f.doubles();
  assert.deepEqual([...TRACKER_OPERATIONS].sort(), ['comment', 'fileFollowUp', 'mergeRequest', 'read', 'search', 'setStatus']);
  const tr = await trackerOf(f.p.root, f.adapter);
  for (const op of TRACKER_OPERATIONS) {
    assert.equal(wordsFor(tr, op), `Own words for ${op}.`);
    assert.ok(wordsFor({ operations: {} }, op), op);
  }
});

test('files tracker: tickets as files; create, search, status and comments by marker; ids never name a path', async (t) => {
  const f = deliveryProject();
  t.after(f.cleanup);
  const dir = path.join(f.p.root, 'tickets');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'AB-1.md'), '---\nid: AB-1\ntitle: First\nstatus: Todo\n---\nBody one.\n');
  const d = filesTracker(f.p.root);
  assert.equal(await d.normalise('ab-1'), 'AB-1');
  assert.deepEqual((await d.read('AB-1')).labels, []);
  const { id } = await d.create({ title: 'Found', body: 'details wf:AB-1.1:finding:F1', label: 'found', status: 'Backlog', marker: 'wf:AB-1.1:finding:F1' });
  assert.equal(id, 'AB-2');
  assert.deepEqual((await d.search({ marker: 'wf:AB-1.1:finding:F1' })).map((i) => i.id), ['AB-2']);
  assert.deepEqual((await d.search({ text: 'First' })).map((i) => i.id), ['AB-1']);
  await d.setStatus('AB-1', 'Ready');
  assert.equal((await d.read('AB-1')).status, 'Ready');
  await d.comment('AB-1', { body: 'Try it. wf:AB-1.1:stage-1', marker: 'wf:AB-1.1:stage-1' });
  await d.comment('AB-1', { body: 'Try it. wf:AB-1.1:stage-1', marker: 'wf:AB-1.1:stage-1' });
  assert.equal((await d.comments('AB-1')).length, 1);
  await assert.rejects(d.read('../x'), /invalid ticket id/);
  fs.symlinkSync(path.join(dir, 'AB-1.md'), path.join(dir, 'AB-3.md'));
  await assert.rejects(d.read('AB-3'), /not a regular file/);
});
