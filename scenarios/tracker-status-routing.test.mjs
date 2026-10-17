import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from '../engine/ledger.mjs';
import crypto from 'node:crypto';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, summaryFile, toAccepted, wf, yaml } from './helpers.mjs';

// 0.7.27 (I-190), named failure (field): a project's tickets of one kind (those labelled "Self-serve") are finished once they are
// delivered, so the person wants them in Done, not Ready for UAT, while every other ticket still ends in Ready for UAT. A step
// mapped to one status, the engine never set Done and the texts said an agent never does, so the project hardcoded the status in
// its own adapter. `tracker.statusByLabel` is the person's routing, in the adapter: a step's status by the ticket's labels, as
// its readback showed them. Nothing sets Done unless the adapter routes a ticket there.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const ticket = (id, labels) => `---\n${yaml({ id, title: 'Show the new text', status: 'Todo', labels }).trim()}\n---\nThe home screen shows the new text.\n`;
const ROUTED = { delivered: { 'Self-serve': 'Done' } };

function project(name, route) {
  return singleRepoProject(name, { tracker: { kind: 'files', statuses, deliveredComment: 'uat.md', ...(route ? { statusByLabel: route } : {}) }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, {
    '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n',
    'tickets/ENG-400.md': ticket('ENG-400', ['ui', 'Self-serve']),
    'tickets/ENG-401.md': ticket('ENG-401', ['ui']),
    'tickets/ENG-402.md': ticket('ENG-402', ['self-serve']),
  });
}
const statusOf = (root, item) => /^status: (.*)$/m.exec(fs.readFileSync(path.join(root, 'tickets', `${item}.md`), 'utf8'))?.[1];
function delivered(p, item, change) {
  const { id } = toAccepted(p.root, p.base, { item, change });
  ok(wf(p.root, ['deliver', '--attempt', id, '--summary-file', summaryFile(p.base)]));
  return id;
}
const delivery = (root, id) => readLedger(root, id).find((e) => e.type === 'tracker.pending' && e.data.event === 'delivered').data.actions.find((a) => a.op === 'setStatus');

test('0.7.27 (I-190): a ticket with a routed label is delivered to the routed status, every other ticket to the default', () => {
  const p = project('tracker-route', ROUTED);
  const ts = delivered(p, 'ENG-400', { 'src/a.txt': 'ts\n' });
  const plain = delivered(p, 'ENG-401', { 'src/b.txt': 'plain\n' });
  const folded = delivered(p, 'ENG-402', { 'src/c.txt': 'folded\n' });
  assert.equal(statusOf(p.root, 'ENG-400'), 'Done', 'the labelled ticket goes where the project routed it');
  assert.equal(statusOf(p.root, 'ENG-401'), 'Ready for UAT', 'an unlabelled ticket keeps the default');
  assert.equal(statusOf(p.root, 'ENG-402'), 'Done', 'labels are matched without regard to case');
  assert.equal(state(p.root, ts).phase, 'done', 'the readback accepted the routed status');
  const action = delivery(p.root, ts);
  assert.deepEqual([action.status, action.route], ['Done', { label: 'Self-serve', default: 'Ready for UAT' }], 'the pending action says why');
  assert.equal(delivery(p.root, plain).route, undefined);
  assert.equal(delivery(p.root, folded).status, 'Done');
  // The start of the work was not routed: a routed delivery does not touch the other steps.
  assert.match(fs.readFileSync(path.join(p.root, '.workflow', 'project.yaml'), 'utf8'), /statusByLabel/);
  assert.equal(readLedger(p.root, ts).find((e) => e.type === 'tracker.recorded' && e.data.event === 'admitted').data.labels.includes('Self-serve'), true, 'the labels are those of the readback');
});

test('0.7.27 (I-190): without a routing rule nothing sets Done: a labelled ticket goes to the default status', () => {
  const p = project('tracker-route-default');
  delivered(p, 'ENG-400', { 'src/a.txt': 'ts\n' });
  assert.equal(statusOf(p.root, 'ENG-400'), 'Ready for UAT');
  assert.doesNotMatch(ok(wf(p.root, ['doctor', '--no-steps'])).out, /tracker status routing/);
});

test('0.7.27 (I-190): an invalid routing rule is refused by the configuration, and doctor says what a valid one does', () => {
  const bad = (route, re, extra = {}) => {
    const { root } = singleRepoProject(`tracker-route-bad-${Math.random().toString(36).slice(2, 6)}`, { tracker: { kind: 'files', statuses, ...extra, statusByLabel: route } });
    const r = wf(root, ['doctor', '--no-steps']);
    assert.notEqual(r.code, 0, JSON.stringify(route));
    assert.match(`${r.out}${r.err}`, re, JSON.stringify(route));
  };
  bad(['delivered'], /`tracker\.statusByLabel` maps a step to the labels that route it/);
  bad({ shipped: { 'Self-serve': 'Done' } }, /`tracker\.statusByLabel\.shipped`: shipped is not a step with a status in `tracker\.statuses`/);
  bad({ delivered: ['Self-serve'] }, /`tracker\.statusByLabel\.delivered` lists the labels that route it, each to a status/);
  bad({ delivered: {} }, /`tracker\.statusByLabel\.delivered` lists the labels that route it, each to a status/);
  bad({ delivered: { 'Self-serve': 5 } }, /`tracker\.statusByLabel\.delivered\["Self-serve"\]` names the status the label routes to, as text/);
  bad({ delivered: { 'Self-serve': ' ' } }, /names the status the label routes to, as text/);
  bad({ delivered: { '': 'Done' } }, /`tracker\.statusByLabel\.delivered`: a label is empty/);
  bad({ delivered: { 'Self-serve': 'Done', 'self-serve': 'Closed' } }, /"self-serve" and "Self-serve" are the same label/);
  bad({ inReview: { Urgent: 'Escalated' } }, /`tracker\.statusByLabel\.inReview`: inReview is not a step with a status/);
  const { root } = project('tracker-route-doctor', ROUTED);
  const good = ok(wf(root, ['doctor', '--no-steps']));
  assert.match(good.out, /tracker status routing\n {4}delivered goes to "Done" for a ticket labelled "Self-serve" \(otherwise "Ready for UAT"\)/);
});

test('0.7.27 (I-190): the built-in trackers hand the engine their issue\'s labels', async () => {
  const linear = (await import('../adapters/tracker/linear.mjs')).default;
  const github = (await import('../adapters/tracker/github.mjs')).default;
  const files = (await import('../adapters/tracker/files.mjs')).default;
  assert.deepEqual(linear.normalize({ id: 'ENG-1', title: 't', status: 'Todo', labels: ['Self-serve', 'Bug'] }).labels, ['Self-serve', 'Bug']);
  assert.deepEqual(linear.normalize({ issue: { identifier: 'ENG-1', title: 't', state: { name: 'Todo' }, labels: { nodes: [{ name: 'Self-serve' }] } } }).labels, ['Self-serve'], 'the API\'s connection of labels');
  assert.equal('labels' in linear.normalize({ id: 'ENG-1', title: 't', status: 'Todo' }), false, 'a readback that gives none says none, not an empty list');
  assert.deepEqual(github.normalize({ issue: { identifier: '12', title: 't', labels: [{ name: 'Self-serve' }, 'bug'] } }).labels, ['Self-serve', 'bug']);
  assert.deepEqual(files.normalize({ issue: { identifier: 'ENG-1', title: 't', status: 'Todo', labels: ['Self-serve'] } }).labels, ['Self-serve']);
});

// A project whose tracker is worked through a connector: the agent reports each readback (`--agent-reported`), the engine checks it.
function connector(name) {
  const { base, root } = singleRepoProject(name, { tracker: { kind: 'linear', via: 'connector', statuses, deliveredComment: 'uat.md', statusByLabel: ROUTED }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n' });
  let n = 0;
  const at = () => new Date(Date.now() + 1000 * ++n).toISOString();
  const report = (r) => {
    const f = path.join(base, `reported-${++n}.json`);
    fs.writeFileSync(f, JSON.stringify(r));
    return f;
  };
  const run = (item, labels) => {
    const e = ok(wf(root, ['entry', '--item', item, '--json'])).json();
    const id = e.id;
    const rec = (event, r, extra = []) => wf(root, ['tracker', 'record', '--event', event, '--agent-reported', '--file', report(r), '--attempt', id, ...extra]);
    ok(rec('admitted', { issue: item, title: 'Show a', description: 'Show the new text.', status: 'In Progress', ...(labels ? { labels } : {}), readAt: at() }));
    ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
    ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
    ok(rec('implementing', { issue: item, title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: at() }));
    commitIn(e.repos.app.worktree, { [`src/${item}.txt`]: 'ui\n' });
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
    ok(wf(root, ['gate', '--attempt', id]));
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', id]));
    ok(wf(root, ['accept', '--attempt', id]));
    ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
    return { id, rec };
  };
  // The delivered readback: the status the ticket shows and, when the tracker reports them, the labels it carries then.
  const post = ({ id, rec }, item, status, labels) => {
    const posted = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'delivery', 'delivered-comment.md'), 'utf8');
    const file = path.join(base, `posted-${id}-${++n}.md`);
    fs.writeFileSync(file, posted);
    return rec('delivered', { issue: item, status, ...(labels ? { labels } : {}), comment: { id: 'c1', bodySha256: crypto.createHash('sha256').update(posted).digest('hex'), createdAt: at() }, attachments: [], readAt: at() }, ['--comment-file', file]);
  };
  return { root, run, post };
}

test('0.7.27 (I-190): through a connector, the labels the agent\'s readback reports route the status, and the readback must show the routed status', () => {
  const { root, run, post } = connector('tracker-route-connector');
  // A ticket whose admission readback lists the label: the delivered action is Done, and the resume text says why.
  const ts = run('ENG-50', ['Bug', 'Self-serve']);
  assert.deepEqual(state(root, ts.id).tracker.done.find((d) => d.event === 'admitted').labels, ['Bug', 'Self-serve']);
  const action = state(root, ts.id).tracker.pending.find((a) => a.event === 'delivered' && a.op === 'setStatus');
  assert.deepEqual([action.status, action.route.label], ['Done', 'Self-serve']);
  assert.match(ok(wf(root, ['resume', '--attempt', ts.id])).out, /set status to "Done" \(the ticket's label "Self-serve" routes it there instead of "Ready for UAT"; the project chose that in its adapter/);
  const wrong = post(ts, 'ENG-50', 'Ready for UAT');
  assert.equal(wrong.code, 75);
  assert.match(wrong.err, /status is `Ready for UAT`, expected `Done`/);
  ok(post(ts, 'ENG-50', 'Done'));
  assert.equal(state(root, ts.id).phase, 'done');
  // One whose readback lists no routed label (or none at all) is delivered to the default.
  const plain = run('ENG-51', ['Bug']);
  assert.equal(state(root, plain.id).tracker.pending.find((a) => a.event === 'delivered' && a.op === 'setStatus').status, 'Ready for UAT');
  const unknown = run('ENG-52', null);
  assert.equal(state(root, unknown.id).tracker.pending.find((a) => a.event === 'delivered' && a.op === 'setStatus').status, 'Ready for UAT', 'no labels reported: the default');
});

// 0.7.27 (review of the release), named failure: the route was taken from the labels of the latest recorded readback, which can be
// days old, and the delivered readback then had to show exactly that status. A label removed before delivery (the person took it
// off to keep the ticket from closing itself) still forced Done. The labels of the readback being recorded decide.
test('0.7.27 (I-190): the delivered readback\'s own labels decide the routed status, not the labels of an earlier readback', () => {
  const { root, run, post } = connector('tracker-route-fresh');
  // The label was on the ticket at admission and is gone at delivery: the default status is the one to show, and Done is refused.
  const removed = run('ENG-60', ['Bug', 'Self-serve']);
  assert.equal(state(root, removed.id).tracker.pending.find((a) => a.event === 'delivered' && a.op === 'setStatus').status, 'Done', 'pending when the label was last seen');
  assert.match(ok(wf(root, ['resume', '--attempt', removed.id])).out, /if the ticket no longer carries "Self-serve" when you read it back, set "Ready for UAT"/);
  const stale = post(removed, 'ENG-60', 'Done', ['Bug']);
  assert.equal(stale.code, 75);
  assert.match(stale.err, /status is `Done`, expected `Ready for UAT` \(the ticket's labels, as read back, do not carry "Self-serve"\)/);
  ok(post(removed, 'ENG-60', 'Ready for UAT', ['Bug']));
  const rec = readLedger(root, removed.id).filter((e) => e.type === 'tracker.recorded').at(-1).data;
  assert.equal(rec.routed, undefined, 'no route was used');
  // The label is still there at delivery: Done is accepted and the route used is recorded.
  const kept = run('ENG-61', ['Self-serve']);
  ok(post(kept, 'ENG-61', 'Done', ['Self-serve', 'Bug']));
  assert.deepEqual(readLedger(root, kept.id).filter((e) => e.type === 'tracker.recorded').at(-1).data.routed, [{ step: 'delivered', label: 'Self-serve', status: 'Done', default: 'Ready for UAT' }]);
  // The label was put on after admission: the delivered readback's labels route it, whatever was pending.
  const added = run('ENG-62', ['Bug']);
  assert.equal(state(root, added.id).tracker.pending.find((a) => a.event === 'delivered' && a.op === 'setStatus').status, 'Ready for UAT');
  const early = post(added, 'ENG-62', 'Ready for UAT', ['Bug', 'self-serve']);
  assert.equal(early.code, 75);
  assert.match(early.err, /status is `Ready for UAT`, expected `Done` \(the ticket's label "Self-serve" routes it\)/);
  ok(post(added, 'ENG-62', 'Done', ['Bug', 'self-serve']));
  // A readback that reports no labels is judged as the pending action says.
  const silent = run('ENG-63', ['Self-serve']);
  ok(post(silent, 'ENG-63', 'Done'));
});

test('0.7.27 (I-190): doctor says that a rule for the first step cannot route at admission', () => {
  const p = project('tracker-route-started', { started: { 'Self-serve': 'Working' }, delivered: { 'Self-serve': 'Done' } });
  const out = ok(wf(p.root, ['doctor', '--no-steps'])).out;
  assert.match(out, /started goes to "Working" for a ticket labelled "Self-serve" \(otherwise "In Progress"\); not at admission, which comes before any readback has shown the labels/);
  assert.doesNotMatch(out, /delivered goes to "Done"[^\n]*not at admission/);
});
