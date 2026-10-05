import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, toAccepted, wf } from './helpers.mjs';
import { proposeCaption } from '../engine/lifecycle.mjs';

// The owner must see every delivered screenshot in the chat, captioned with the state it shows, and the ticket must
// carry each as an uploaded file. The engine prints what to show, records the owner's acknowledgement, and keeps the
// attempt open until it is recorded.

const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' };
const shownFile = (dir, entries) => {
  const f = path.join(dir, `shown-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ screenshots: entries }));
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
  assert.ok(fs.existsSync(path.join(root, '.wf-evidence', 'attempts', e.id, 'delivery', 'shown-draft.json')));
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
  fs.writeFileSync(back, JSON.stringify({ issue: { identifier: 'ENG-73', state: { name: 'Ready for UAT' } }, attachments: [] }));
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
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: shas }), '--attempt', b.id]));
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
