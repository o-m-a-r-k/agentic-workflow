import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, postedComment, rawReadback, singleRepoProject, state, summaryFile, toAccepted, wf } from './helpers.mjs';
import { proposeCaption } from '../engine/lifecycle.mjs';

// The owner must see every delivered screenshot in the chat, captioned with the state it shows, and the ticket must
// carry each as an uploaded file. The engine prints what to show, records the owner's acknowledgement, and keeps the
// attempt open until it is recorded.

const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' };
const shownFile = (dir, entries, anomalies = 'none seen') => {
  const f = path.join(dir, `shown-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ screenshots: entries, anomalies }));
  return f;
};

test('caption proposal: the file name in words, the ticket id and sequence prefix dropped, plus the criterion that references it', () => {
  const s = { item: 'ENG-71', criteria: [{ id: 'C1', text: 'invoices list', uat: 'the empty invoice list explains how to add one' }, { id: 'C2', text: 'other' }], review: { closure: { criteria: [{ id: 'C1', evidence: { kind: 'screenshot', ref: 'shots/eng-71/01-02-eng-71-invoiceList_empty-dark.png' } }] } } };
  assert.equal(proposeCaption(s, { source: 'shots/eng-71/01-02-eng-71-invoiceList_empty-dark.png', sha256: 'x' }), 'Invoice list empty dark (shows C1: the empty invoice list explains how to add one)');
  assert.equal(proposeCaption(s, { source: 'shots/eng-71/settings.png', sha256: 'y' }), 'Settings');
  const named = { item: 'ENG-71', criteria: [{ id: 'C3', text: 'see settings-saved for the toast', uat: false }] };
  assert.equal(proposeCaption(named, { source: 'shots/settings-saved.png', sha256: 'z' }), 'Settings saved (shows C3: see settings-saved for the toast)');
});

test('quick lane with screenshots: the SHOW block is printed and the attempt stays open until the owner acknowledges', () => {
  const steps = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots/eng-72/a shots/eng-72/b && printf 1 > shots/eng-72/a/home.png && printf 2 > shots/eng-72/b/home.png', artifacts: ['shots/{itemLower}/**/*.png'] }];
  const { base, root } = singleRepoProject('shown-quick', { gate: { steps } }, ignore);
  const e = ok(wf(root, ['entry', '--item', 'ENG-72', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  const g = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  const shas = g.steps[0].artifacts.map((a) => a.sha256);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: shas })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  const d = ok(wf(root, ['deliver', '--attempt', e.id]));
  assert.match(d.out, /SHOW TO OWNER \(2 delivered screenshot\(s\) for ENG-72\)/);
  // Two files share a name: each gets a distinct attachment title from its path.
  assert.match(d.out, /attach as: shots-eng-72-a-home\.png/);
  assert.match(d.out, /attach as: shots-eng-72-b-home\.png/);
  let s = state(root, e.id);
  assert.equal(s.phase, 'handoff-pending', 'not closed before the owner saw the screenshots');
  assert.ok(fs.existsSync(path.join(root, '.wf-worktrees', '_exports', e.id, 'shown-draft.json')));
  const r = wf(root, ['shown', '--file', shownFile(base, [{ sha256: shas[0], caption: 'Home, first variant' }, { sha256: 'f'.repeat(64), caption: 'stray' }]), '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /home\.png .*not acknowledged/);
  assert.match(r.err, /f{64}: not in the delivered set/);
  const done = ok(wf(root, ['shown', '--file', shownFile(base, [{ sha256: shas[0], caption: 'Home, first variant' }, { sha256: shas[1], caption: 'Home, second variant' }]), '--attempt', e.id]));
  assert.match(done.out, /Attempt closed/);
  s = state(root, e.id);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.delivery.shown.screenshots.map((x) => x.caption), ['Home, first variant', 'Home, second variant']);
  assert.match(fs.readFileSync(s.delivery.shown.raw.path, 'utf8'), /Home, second variant/, 'the acknowledgement is kept raw');

  // The page embeds exactly the delivered set, self-contained, with the owner's captions.
  ok(wf(root, ['export', '--attempt', e.id]));
  const html = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', e.id, 'export', 'attempt.html'), 'utf8');
  assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 2);
  assert.match(html, /Home, first variant/);
  assert.match(html, /Shown to the owner/);
  assert.doesNotMatch(html, /(src|href)="https?:/, 'no external requests');
  const json = ok(wf(root, ['export', '--attempt', e.id, '--json'])).json();
  assert.equal(json.delivered.screenshots.length, 2);
  assert.doesNotMatch(JSON.stringify(json), /base64/, 'the JSON export carries no image bytes');
});

test('delivery without screenshots: the statement why is printed and recorded; no acknowledgement of images is owed', () => {
  const repos = [{ name: 'app', path: '.', base: 'main', packages: [{ path: 'src' }, { path: 'web' }] }];
  const steps = [{ id: 'unit', repo: 'app', package: 'src', run: 'true', inputs: ['**'] }, { id: 'ui', repo: 'app', package: 'web', run: 'true', artifacts: ['shots/{itemLower}/*.png'] }];
  const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' } };
  const { base, root } = singleRepoProject('shown-none', { repos, gate: { steps }, tracker }, { ...ignore, 'web/a.txt': 'w\n' });
  const { id } = toAccepted(root, base, { item: 'ENG-73' });
  const cap = path.join(base, 'cap.json');
  fs.writeFileSync(cap, JSON.stringify({ issue: { identifier: 'ENG-73', description: 'd', state: { name: 'In Progress' } } }));
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap, '--attempt', id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap, '--attempt', id]));
  const d = ok(wf(root, ['deliver', '--attempt', id]));
  assert.match(d.out, /SHOW TO OWNER: no screenshots for ENG-73: ui: its globs \(shots\/eng-73\/\*\.png\) matched no screenshot of this ticket and its package did not change/);
  const s = state(root, id);
  assert.equal(s.delivery.shown.auto, true);
  assert.match(s.delivery.shown.none, /matched no screenshot/);
  assert.match(wf(root, ['shown', '--file', shownFile(base, []), '--attempt', id]).err, /no screenshots were delivered for ENG-73; the statement is already recorded/);
  assert.doesNotMatch(ok(wf(root, ['resume', '--attempt', id])).out, /show the owner/);
  const back = path.join(base, 'back.json');
  fs.writeFileSync(back, JSON.stringify(rawReadback('ENG-73', 'Ready for UAT')));
  ok(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', back, '--attempt', id]));
  assert.equal(state(root, id).phase, 'done');
  ok(wf(root, ['export', '--attempt', id]));
  assert.match(fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'export', 'attempt.html'), 'utf8'), /No screenshots for this ticket: ui: its globs/);
});

test('batch: each member delivers only its own screenshots from the shared gate', () => {
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', tier: 'heavy', run: 'for i in $WF_ITEMS; do d=shots/$(echo $i | tr A-Z a-z); mkdir -p $d && printf "$i" > $d/home.png; done', artifacts: ['shots/{itemLower}/*.png'] }];
  const { base, root } = singleRepoProject('shown-batch', { gate: { steps } }, { ...ignore, 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-74', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-75', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  const g = ok(wf(root, ['gate', '--attempt', b.id, '--json'])).json();
  const shas = g.steps.flatMap((x) => x.artifacts ?? []).map((a) => a.sha256);
  assert.equal(shas.length, 3, 'the batch gate collects every unit\'s files (the batch\'s own folder too)');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: shas, anomalies: 'none seen' }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  const d = ok(wf(root, ['deliver', '--attempt', b.id]));
  assert.match(d.out, /SHOW TO OWNER \(1 delivered screenshot\(s\) for ENG-74\)/);
  assert.match(d.out, /SHOW TO OWNER \(1 delivered screenshot\(s\) for ENG-75\)/);
  const s1 = state(root, m1.id);
  assert.deepEqual(s1.delivery.screenshots.screenshots.map((f) => f.source), ['shots/eng-74/home.png'], 'never another member\'s file');
  assert.equal(state(root, b.id).phase, 'done', 'the batch itself shows nothing; its members do');
  ok(wf(root, ['shown', '--file', shownFile(base, [{ sha256: s1.delivery.screenshots.screenshots[0].sha256, caption: 'Home for the first ticket' }]), '--attempt', m1.id]));
  assert.equal(state(root, m1.id).phase, 'done');
  assert.equal(state(root, m2.id).phase, 'handoff-pending');
});

// 0.1.14: an over-broad glob filled a delivered set with other tickets' files (named failure: 1,320 delivered, 8 the
// ticket's), and `wf shown` and the readback required every one. `wf delivery narrow` keeps a subset, once, ledgered.
test('delivery narrow: the owner keeps the ticket\'s files of an over-broad set, once, with a reason; shown and the readback need only those', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && for n in mine-a mine-b other-1 other-2 other-3; do printf $n > shots/$n.png; done', artifacts: ['shots/*.png'] }];
  const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' };
  const { base, root } = singleRepoProject('narrow', { tracker, gate: { steps: visual } }, { ...ignore, '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n' });
  const item = 'ENG-76';
  const cap = (obj) => {
    const f = path.join(base, `cap-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: item, description: 'd', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap({ issue: { identifier: item, description: 'd', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  const all = g.steps[0].artifacts;
  assert.equal(all.length, 5);
  const mine = all.filter((a) => /mine-/.test(a.source ?? a.path)).map((a) => a.sha256);
  const reason = 'the glob shots/*.png matched other tickets\' captures; only mine-a and mine-b are this ticket\'s';
  assert.match(wf(root, ['delivery', 'narrow', '--keep', mine.join(','), '--reason', reason, '--attempt', e.id]).err, /not delivered yet/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: all.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  assert.match(ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)])).out, /SHOW TO OWNER \(5 delivered screenshot\(s\) for ENG-76\)/);
  assert.equal(state(root, e.id).tracker.pending.find((a) => a.op === 'attach').files.length, 5);

  const narrow = (args) => wf(root, ['delivery', 'narrow', ...args, '--attempt', e.id]);
  assert.match(narrow(['--keep', mine.join(',')]).err, /--reason/);
  assert.match(narrow(['--keep', 'f'.repeat(64), '--reason', reason]).err, /1 kept sha256 not in the delivered set[\s\S]*f{64}/);
  assert.match(narrow(['--keep', mine[0].slice(0, 12), '--reason', reason]).err, /not in the delivered set/, 'a prefix is not a sha256');
  assert.match(narrow(['--keep', all.map((a) => a.sha256).join(','), '--reason', reason]).err, /all 5 delivered files are kept; nothing to narrow/);
  fs.writeFileSync(path.join(base, 'keep-empty.json'), JSON.stringify({ keep: [] }));
  assert.match(narrow(['--file', path.join(base, 'keep-empty.json'), '--reason', reason]).err, /keep at least one file/);
  const before = state(root, e.id).delivery.screenshots.screenshots.length;
  assert.equal(before, 5, 'refusals change nothing');

  const keepFile = path.join(base, 'keep.json');
  fs.writeFileSync(keepFile, JSON.stringify({ keep: [...mine, mine[0]] }));
  const r = ok(narrow(['--file', keepFile, '--reason', reason]));
  assert.match(r.out, /narrowed from 5 to 2: the glob shots\/\*\.png matched/);
  let s = state(root, e.id);
  assert.deepEqual(s.delivery.screenshots.screenshots.map((f) => f.sha256).sort(), [...mine].sort());
  assert.deepEqual(s.tracker.pending.find((a) => a.op === 'attach').files.map((f) => f.sha256).sort(), [...mine].sort(), 'the pending attach action is narrowed the same way');
  assert.deepEqual({ from: s.delivery.narrowed.from, to: s.delivery.narrowed.to, dropped: s.delivery.narrowed.dropped, reason: s.delivery.narrowed.reason }, { from: 5, to: 2, dropped: 3, reason });
  assert.match(fs.readFileSync(s.delivery.narrowed.raw.path, 'utf8'), /keep/, 'the keep file is kept raw');
  const draft = JSON.parse(fs.readFileSync(path.join(root, '.wf-worktrees', '_exports', e.id, 'shown-draft.json'), 'utf8'));
  assert.equal(draft.screenshots.length, 2, 'the draft lists only the kept files');
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /narrowed from 5 to 2: the glob/);
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /each of the 2 delivered screenshot/);
  assert.match(narrow(['--keep', mine[0], '--reason', 'again']).err, /already narrowed \(5 to 2/, 'narrowed once');

  // A dropped file in the acknowledgement is outside the set now.
  const dropped = all.find((a) => !mine.includes(a.sha256)).sha256;
  assert.match(wf(root, ['shown', '--file', shownFile(base, [...mine.map((sha, i) => ({ sha256: sha, caption: `Home, variant ${i + 1}` })), { sha256: dropped, caption: 'other ticket' }]), '--attempt', e.id]).err, /not in the delivered set/);
  ok(wf(root, ['shown', '--file', shownFile(base, mine.map((sha, i) => ({ sha256: sha, caption: `Home, variant ${i + 1}` }))), '--attempt', e.id]));
  assert.match(narrow(['--keep', mine[0], '--reason', reason]).err, /already narrowed|already acknowledged/);

  const titles = s.delivery.screenshots.screenshots.map((f) => f.title);
  const after = new Date(Date.now() + 1000).toISOString();
  // The raw get_issue and list_comments results, saved together unchanged; the comment is the one `wf` rendered.
  const assets = Object.fromEntries(titles.map((t, i) => [t, `https://uploads.linear.app/x/${i}`]));
  const attachments = titles.map((t, i) => ({ id: `a${i}`, title: t, subtitle: `Home, variant ${i + 1}`, url: assets[t] }));
  ok(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments, comments: [{ id: 'c1', body: postedComment(root, e.id, assets), createdAt: after }] })), '--attempt', e.id]));
  s = state(root, e.id);
  assert.equal(s.phase, 'done');
  assert.equal(s.tracker.done.at(-1).attachments.length, 2, 'only the kept files were required on the ticket');
  ok(wf(root, ['export', '--attempt', e.id]));
  assert.match(fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', e.id, 'export', 'attempt.html'), 'utf8'), /Narrowed from 5 to 2/);
  assert.equal(ok(wf(root, ['export', '--attempt', e.id, '--json'])).json().delivered.narrowed.dropped, 3);
});

test('linear readback shapes: raw get_issue alone, with list_comments, as an MCP envelope, as a list, and a hand-written issue id', async () => {
  const linear = (await import('../adapters/tracker/linear.mjs')).default;
  const getIssue = { id: 'ENG-77', uuid: 'u', title: 't', status: 'Ready for UAT', attachments: [{ id: 'a', title: 'home.png', subtitle: 'Home', url: 'https://uploads.linear.app/x' }] };
  const listComments = { comments: [{ id: 'c', body: 'hello', createdAt: '2026-01-01T00:00:00Z' }], hasNextPage: false };
  const envelope = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  for (const raw of [getIssue, { issue: getIssue, comments: listComments }, { issue: envelope(getIssue), comments: envelope(listComments) }, envelope(getIssue), [getIssue, listComments], [envelope(getIssue), envelope(listComments)], { issue: 'ENG-77', status: 'Ready for UAT', attachments: getIssue.attachments }]) {
    const n = linear.normalize(raw);
    assert.equal(n.id, 'ENG-77', JSON.stringify(raw).slice(0, 80));
    assert.equal(n.status, 'Ready for UAT');
    assert.equal(n.attachments[0].title, 'home.png');
  }
  assert.equal(linear.normalize({ issue: getIssue, comments: listComments }).comments[0].body, 'hello');
  assert.equal(linear.normalize([getIssue, listComments]).comments[0].body, 'hello');
  assert.equal(linear.normalize({ issue: { identifier: 'ENG-78', id: 'uuid', state: { name: 'Done' } } }).id, 'ENG-78', 'the GraphQL shape: identifier wins over the uuid');
});

// 0.1.15: an attempt delivered by 0.1.6 has no recorded set (no `delivery.screenshots`, no `wf shown`), only a pending
// `delivered` attach action listing every gate capture, checked by title. Named failure: 1,320 listed, narrow refused
// "no set to narrow". The ledger entries below are the ones 0.1.6 wrote at delivery.
test('delivery narrow on an attempt delivered before 0.1.11: the pending attach action is narrowed; the readback needs only the kept titles', async () => {
  const { append } = await import('../engine/ledger.mjs');
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && for n in mine-a mine-b other-1 other-2 other-3 other-4; do printf $n > shots/$n.png; done && mkdir -p shots/results && cp shots/mine-a.png shots/results/run-mine-a-0f3c.png', artifacts: ['shots/*.png', 'shots/results/*.png'] }];
  const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' } };
  const { base, root } = singleRepoProject('narrow-legacy', { tracker, gate: { steps: visual } }, ignore);
  const item = 'ENG-79';
  const cap = (obj) => {
    const f = path.join(base, `cap-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: item, description: 'd', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap({ issue: { identifier: item, description: 'd', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const all = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json().steps[0].artifacts;
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: all.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  append(root, e.id, 'delivered', { order: ['app'] }, 'o');
  append(root, e.id, 'tracker.pending', { event: 'delivered', actions: [{ op: 'attach', files: all }, { op: 'setStatus', key: 'delivered', status: 'Ready for UAT', unless: [] }, { op: 'readback', what: 'x' }] }, null);
  let s = state(root, e.id);
  assert.equal(s.delivery.screenshots, undefined);
  assert.equal(s.phase, 'handoff-pending');

  assert.equal(all.length, 7, 'mine-a is collected twice: its evidence copy and the runner\'s copy');
  const mine = [...new Set(all.filter((a) => /mine-/.test(a.source)).map((a) => a.sha256))];
  assert.equal(mine.length, 2);
  const reason = 'the glob matched every spec\'s captures; only mine-a and mine-b are this ticket\'s';
  const narrow = (args) => wf(root, ['delivery', 'narrow', ...args, '--attempt', e.id]);
  assert.match(narrow(['--keep', 'f'.repeat(64), '--reason', reason]).err, /not in the delivered set[\s\S]*tracker\.pending/);
  const ledger = path.join(root, '.wf-evidence', 'attempts', e.id, 'ledger.jsonl');
  const bytes = fs.readFileSync(ledger, 'utf8');
  const dry = ok(narrow(['--keep', mine.join(','), '--reason', reason, '--dry-run']));
  assert.match(dry.out, /dry run, nothing recorded: .* from 7 to 2 \(5 dropped; delivered before 0\.1\.11/);
  assert.match(dry.out, /mine-a\.png/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), bytes, 'a dry run writes nothing');

  ok(narrow(['--keep', mine.join(','), '--reason', reason]));
  s = state(root, e.id);
  assert.deepEqual(s.tracker.pending.find((a) => a.op === 'attach').files.map((f) => path.basename(f.path)).sort(), ['mine-a.png', 'mine-b.png'], 'one file per kept sha256, the first recorded; the runner\'s copy is dropped');
  assert.equal(s.delivery.narrowed.legacy, true);
  assert.equal(s.delivery.screenshots, undefined, 'no set is invented: the legacy check stays title-only');
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /delivered files narrowed from 7 to 2/);
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, /upload and attach 2 screenshot\(s\)/);
  assert.match(narrow(['--keep', mine[0], '--reason', reason]).err, /already narrowed/);
  assert.match(wf(root, ['shown', '--file', shownFile(base, []), '--attempt', e.id]).err, /delivered before screenshots were recorded/);

  const upload = (t) => ({ id: t, title: t, url: `https://uploads.linear.app/x/${t}` });
  const missing = wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments: [upload('mine-a.png')] }).issue), '--attempt', e.id]);
  assert.match(missing.err, /1 of 2 delivered screenshot\(s\) not attached[\s\S]*mine-b\.png/);
  ok(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments: [upload('mine-a.png'), upload('mine-b.png')] }).issue), '--attempt', e.id]));
  s = state(root, e.id);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.tracker.done.at(-1).attachments.map((a) => a.title).sort(), ['mine-a.png', 'mine-b.png']);
  assert.equal(ok(wf(root, ['export', '--attempt', e.id, '--json'])).json().delivery.narrowed.to, 2);
});
