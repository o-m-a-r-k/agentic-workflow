import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from '../engine/ledger.mjs';
import { YAML } from '../engine/util.mjs';
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

// 0.7.27 (review of the release), named failure: the engine performed the status the pending action carried, routed from the
// labels of an earlier readback, and then judged the readback by the ticket's labels as it read them; a label taken off (or put
// on) in between made the readback refuse what the engine itself had just set, and a retry set it again and was refused again,
// with no refusal naming a way out. The engine now routes at the moment it performs, from the labels it reads then, with the
// rule the readback is judged by.
const relabel = (root, item, change) => {
  const file = path.join(root, 'tickets', `${item}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const front = YAML.parse(m[1]);
  const labels = change(front.labels ?? []);
  if (labels === undefined) delete front.labels;
  else front.labels = labels;
  fs.writeFileSync(file, `---\n${YAML.stringify(front)}---\n${m[2]}`);
};

test('0.7.27 (I-190): the engine sets the status the ticket\'s labels route to when it performs, not the one routed from an earlier readback', () => {
  const p = project('tracker-route-perform', ROUTED);
  // The label was on the ticket at admission and the person took it off before delivery: the default is set, and the readback accepts it.
  const removed = toAccepted(p.root, p.base, { item: 'ENG-400', change: { 'src/a.txt': 'removed\n' } });
  relabel(p.root, 'ENG-400', (labels) => labels.filter((l) => l !== 'Self-serve'));
  const done = ok(wf(p.root, ['deliver', '--attempt', removed.id, '--summary-file', summaryFile(p.base)]));
  assert.match(done.out, /tracker: delivered performed/);
  assert.equal(statusOf(p.root, 'ENG-400'), 'Ready for UAT', 'the labels the engine read when it performed decide');
  assert.equal(delivery(p.root, removed.id).status, 'Done', 'pending as routed when the label was last seen');
  assert.equal(state(p.root, removed.id).phase, 'done');
  assert.equal(readLedger(p.root, removed.id).filter((e) => e.type === 'tracker.recorded').at(-1).data.routed, undefined);
  // The label was put on after admission: the routed status is set, and the readback accepts it.
  const added = toAccepted(p.root, p.base, { item: 'ENG-401', change: { 'src/b.txt': 'added\n' } });
  relabel(p.root, 'ENG-401', (labels) => [...labels, 'self-serve']);
  ok(wf(p.root, ['deliver', '--attempt', added.id, '--summary-file', summaryFile(p.base)]));
  assert.equal(statusOf(p.root, 'ENG-401'), 'Done');
  const route = [{ step: 'delivered', label: 'Self-serve', status: 'Done', default: 'Ready for UAT' }];
  assert.deepEqual(readLedger(p.root, added.id).filter((e) => e.type === 'tracker.recorded').at(-1).data.routed, route);
  // The route used is in the state (`wf resume --json`, and `wf status --json` while the attempt is open), and in the export.
  assert.deepEqual(state(p.root, added.id).tracker.done.find((d) => d.event === 'delivered').routed, route);
  assert.deepEqual(JSON.parse(ok(wf(p.root, ['export', '--attempt', added.id, '--json'])).out).tracker.done.find((d) => d.event === 'delivered').routed, route);
  assert.equal(state(p.root, removed.id).tracker.done.find((d) => d.event === 'delivered').routed, undefined, 'none when the default was used');
  const page = fs.readFileSync(ok(wf(p.root, ['export', '--attempt', added.id])).out.match(/(\S+\.html)/)[1], 'utf8');
  assert.match(page, /routed to Done by the label Self-serve/);
});

// 0.7.27 (review of the release, second pass), named failures. (A) The files adapter judged a ticket with no `labels:` key as
// carrying none while it performed, and the readback judged it as carrying none too, but the adapter kept the status the action
// carried when it read no list: it set Done and the readback then expected the default, so `wf deliver` stopped at 75 with the
// ticket left at Done, and a retry did the same. (B) The rule lived in each built-in adapter: a project adapter with its own
// `perform` got the status routed from stale labels and nothing told its author, so it kept the dead end. One view of the labels
// decides both: the engine reads the ticket through the adapter's own `perform` with no actions (the readback the status is
// judged by), resolves the status of each routed step from those labels, and hands `perform` the status to set.
test('0.7.27 (I-190): a ticket whose labels key was deleted is judged as carrying none, by what is set and by the readback alike', () => {
  const p = project('tracker-route-nokey', ROUTED);
  const gone = toAccepted(p.root, p.base, { item: 'ENG-400', change: { 'src/a.txt': 'nokey\n' } });
  relabel(p.root, 'ENG-400', () => undefined);
  ok(wf(p.root, ['deliver', '--attempt', gone.id, '--summary-file', summaryFile(p.base)]));
  assert.equal(statusOf(p.root, 'ENG-400'), 'Ready for UAT');
  assert.equal(state(p.root, gone.id).phase, 'done');
});

const probe = `import fs from 'node:fs';
import path from 'node:path';
const file = (root, item) => path.join(root, 'probe-db', item + '.json');
const read = (root, item) => (fs.existsSync(file(root, item)) ? JSON.parse(fs.readFileSync(file(root, item), 'utf8')) : { identifier: item, title: 'Show the text', description: 'The home screen shows the new text.', status: 'Todo', labels: ['ui', 'Self-serve'], comments: [] });
export default {
  via: 'files',
  operations: { readIssue: 'read', setStatus: 'set', comment: 'comment', attach: 'none', readBack: 'read back' },
  isUpload: () => false,
  files: {
    // A project adapter's own perform: it sets the status it is handed, and with no actions it only reads.
    async perform({ root, item, actions }) {
      const t = read(root, item);
      for (const a of actions) {
        if (a.op === 'setStatus') t.status = a.status;
        else if (a.op === 'comment' && a.body) t.comments.push({ id: 'c' + (t.comments.length + 1), body: a.body, createdAt: new Date().toISOString() });
      }
      fs.mkdirSync(path.dirname(file(root, item)), { recursive: true });
      fs.writeFileSync(file(root, item), JSON.stringify(t, null, 2));
      return { issue: t };
    },
  },
  normalize(raw) {
    const i = raw.issue ?? raw;
    return { id: i.identifier, title: i.title, description: i.description, status: i.status, labels: i.labels, url: null, updatedAt: null, comments: (i.comments ?? []).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.createdAt })), attachments: [] };
  },
};
`;

test('0.7.27 (I-190): a project adapter with its own perform is handed the status the ticket\'s labels route to when the engine performs; it carries no routing rule', () => {
  const { base, root } = singleRepoProject('tracker-route-project-adapter', { tracker: { kind: './tracker/probe.mjs', via: 'files', statuses, deliveredComment: 'uat.md', statusByLabel: ROUTED }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nprobe-db/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', '.workflow/tracker/probe.mjs': probe });
  const db = (item) => path.join(root, 'probe-db', `${item}.json`);
  const edit = (item, change) => fs.writeFileSync(db(item), JSON.stringify(change(JSON.parse(fs.readFileSync(db(item), 'utf8'))), null, 2));
  // Labelled at admission, the label taken off before delivery.
  const removed = toAccepted(root, base, { item: 'ENG-80', change: { 'src/a.txt': 'p1\n' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(db('ENG-80'), 'utf8')).labels, ['ui', 'Self-serve']);
  edit('ENG-80', (t) => ({ ...t, labels: ['ui'] }));
  ok(wf(root, ['deliver', '--attempt', removed.id, '--summary-file', summaryFile(base)]));
  assert.equal(JSON.parse(fs.readFileSync(db('ENG-80'), 'utf8')).status, 'Ready for UAT', 'the adapter was handed the default');
  assert.equal(state(root, removed.id).phase, 'done');
  // Unlabelled at admission, the label put on before delivery.
  fs.mkdirSync(path.dirname(db('ENG-81')), { recursive: true });
  fs.writeFileSync(db('ENG-81'), JSON.stringify({ identifier: 'ENG-81', title: 'Show the text', description: 'The home screen shows the new text.', status: 'Todo', labels: ['ui'], comments: [] }));
  const added = toAccepted(root, base, { item: 'ENG-81', change: { 'src/b.txt': 'p2\n' } });
  edit('ENG-81', (t) => ({ ...t, labels: ['ui', 'self-serve'] }));
  ok(wf(root, ['deliver', '--attempt', added.id, '--summary-file', summaryFile(base)]));
  assert.equal(JSON.parse(fs.readFileSync(db('ENG-81'), 'utf8')).status, 'Done');
  assert.deepEqual(readLedger(root, added.id).filter((e) => e.type === 'tracker.recorded').at(-1).data.routed.map((r) => [r.step, r.label, r.status]), [['delivered', 'Self-serve', 'Done']]);
  // A stuck delivery (the ticket left at a status the labels no longer route to) is mended by the next attempt of the tracker step.
  const stuck = toAccepted(root, base, { item: 'ENG-82', change: { 'src/c.txt': 'p3\n' } });
  edit('ENG-82', (t) => ({ ...t, labels: ['ui'], status: 'Done' }));
  ok(wf(root, ['deliver', '--attempt', stuck.id, '--summary-file', summaryFile(base)]));
  assert.equal(JSON.parse(fs.readFileSync(db('ENG-82'), 'utf8')).status, 'Ready for UAT', 'the status the labels route to, whatever the ticket held');
});
