import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { amendFile, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, toAccepted, wf, write } from './helpers.mjs';
import { needsScreenshots } from '../engine/captures.mjs';

// Named failure (I-94): a ticket froze criteria that required English and Arabic, desktop and narrow screenshots, but the
// adapter pinned at admission had no step that collects any. The full gate passed without images and acceptance found the
// missing route only at the end. `wf plan` and `wf criteria amend` now say so while it can be acted on, and `wf captures
// import` brings in captures made by hand on the committed tree as part of the gate's screenshots for that tree.

const UNIT = { id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] };
const CRITERIA = [
  { id: 'C1', text: 'The invoices page renders in English and Arabic; screenshots of the desktop and the narrow layout show it', uat: 'open the page in both languages' },
  { id: 'C2', text: 'The api answers 200', uat: false },
];
const quick = (name, gate = { steps: [UNIT] }) => {
  const f = singleRepoProject(name, { gate });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-90', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  return { ...f, e, wt: e.repos.app.worktree };
};
const planned = (f, criteria = CRITERIA) => {
  const r = wf(f.root, ['plan', '--file', criteriaFile(f.base, criteria), '--attempt', f.e.id]);
  ok(r);
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', f.e.id]));
  commitIn(f.wt, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'close', '--agent', 'i', '--attempt', f.e.id]));
  return r;
};
const captures = (f) => {
  const dir = path.join(f.base, 'captures-src');
  write(dir, 'en/desktop.png', 'png-en-desktop');
  write(dir, 'ar/narrow.png', 'png-ar-narrow');
  write(dir, 'notes.txt', 'not an image');
  write(dir, 'blank.png', '');
  return dir;
};
const importIt = (f, dir, extra = []) => wf(f.root, ['captures', 'import', '--from', dir, '--attempt', f.e.id, ...extra]);
const bundle = (r) => JSON.parse(fs.readFileSync((r.out.match(/bundle: (\S+)/) ?? r.out.match(/^Read (\S+)/m))[1], 'utf8'));

test('what needs screenshot evidence is read from the criterion: its stated evidence, else its words; nothing to see needs none', () => {
  assert.equal(needsScreenshots({ id: 'C', text: 'x', evidence: 'screenshot' }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'x', evidence: ['test', 'screenshot'] }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'x', evidence: { kind: 'screenshot' } }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'screenshots are attached', evidence: 'test' }), false, 'stated evidence is taken at its word');
  assert.equal(needsScreenshots({ id: 'C', text: 'Capture a screenshot of the empty state' }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'x', uat: 'compare the Screen Captures of both locales' }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'a screen-shot of the page' }), true);
  assert.equal(needsScreenshots({ id: 'C', text: 'a screenshot is attached', uat: false }), false, 'uat: false says there is nothing to see');
  assert.equal(needsScreenshots({ id: 'C', text: 'The list pages 20 rows at a time' }), false);
  assert.equal(needsScreenshots({ id: 'C', text: 'Shot-clock and screen reader labels are present' }), false);
});

test('wf plan and wf criteria amend say that a criterion needs screenshots no step can collect; status and resume keep saying it', () => {
  const f = quick('capture-route-notice');
  const r = wf(f.root, ['plan', '--file', criteriaFile(f.base, CRITERIA), '--attempt', f.e.id]);
  ok(r);
  assert.match(r.err, /warning: C1 names screenshots as evidence, but no gate step of this attempt collects any \(a step needs `artifacts` globs or a plugin(; a quick fix runs light steps only)?\)/);
  assert.match(r.err, /wf captures import --from <folder> --attempt ENG-90\.1/);
  assert.doesNotMatch(r.err, /C2/);
  assert.match(ok(wf(f.root, ['resume', '--attempt', f.e.id])).out, /warning: C1 names screenshots as evidence/);
  assert.match(ok(wf(f.root, ['status', '--attempt', f.e.id])).out, /warning: C1 names screenshots as evidence/);
  const more = [{ id: 'C3', text: 'The narrow layout is shown in a screen capture', uat: 'look at it' }];
  const a = ok(wf(f.root, ['criteria', 'amend', '--file', amendFile(f.base, more), '--reason', 'narrow layout', '--attempt', f.e.id]));
  assert.match(a.err, /warning: C1, C3 name screenshots as evidence, but no gate step/);
});

test('no notice where a route exists: a step with artifacts or a plugin, a criterion that states other evidence, or one with nothing to see', () => {
  for (const [name, step] of [['artifacts', { id: 'ui', repo: 'app', run: 'true', inputs: ['src/**'], artifacts: ['shots/*.png'] }], ['plugin', { id: 'ui', repo: 'app', plugin: 'steps/ui.mjs', inputs: ['src/**'] }]]) {
    const f = quick(`capture-route-${name}`, { steps: [UNIT, step] });
    const r = wf(f.root, ['plan', '--file', criteriaFile(f.base, CRITERIA), '--attempt', f.e.id]);
    ok(r);
    assert.doesNotMatch(r.err, /names screenshots/, `a step with ${name} can collect them`);
    assert.doesNotMatch(ok(wf(f.root, ['resume', '--attempt', f.e.id])).out, /names screenshots/);
  }
  const g = quick('capture-route-stated');
  const r = wf(g.root, ['plan', '--file', criteriaFile(g.base, [{ id: 'C1', text: 'No screenshot is committed to the repository', evidence: 'test' }, { id: 'C2', text: 'x', uat: false }]), '--attempt', g.e.id]);
  ok(r);
  assert.doesNotMatch(r.err, /names screenshots/);
});

test('captures made by hand on the committed tree are imported by wf, bound to the tree, and reach the reviewer, acceptance and delivery as the gate\'s own', () => {
  const f = quick('capture-route-import');
  planned(f);
  const dir = captures(f);
  // Uncommitted work: a capture says nothing about a tree that is not committed.
  write(f.wt, 'src/a.txt', 'dirty\n');
  const dirty = importIt(f, dir);
  assert.equal(dirty.code, 75);
  assert.match(dirty.err, /commit the change before importing captures/);
  commitIn(f.wt, { 'src/a.txt': 'changed again\n' });

  assert.match(wf(f.root, ['captures', 'import', '--attempt', f.e.id]).err, /give the folder of captures \(--from\) or one image \(--file\)/);
  assert.match(importIt(f, dir, ['--criteria', 'C9']).err, /--criteria names frozen criteria \(C1, C2\), not C9/);
  const done = ok(importIt(f, dir, ['--criteria', 'C1', '--note', 'a desktop browser at 1440 and 390 px wide']));
  assert.match(done.out, /2 capture\(s\) imported into ENG-90\.1 as import 1, bound to the committed tree for C1/);
  assert.match(done.out, /skipped 1: blank\.png \(empty: nothing was captured\)/);
  const s = state(f.root, f.e.id);
  const imported = s.captureImports[0];
  assert.deepEqual(imported.files.map((x) => x.source), ['import-1/ar/narrow.png', 'import-1/en/desktop.png']);
  assert.equal(imported.note, 'a desktop browser at 1440 and 390 px wide');
  assert.equal(imported.criteria[0], 'C1');
  assert.equal(imported.ignored, 1, 'the text file is counted, not imported');
  // Recorded in the evidence folder by wf: write-once, read-only, the bytes that were read.
  for (const file of imported.files) {
    assert.match(file.path, /captures[\\/]import-1[\\/]/);
    assert.equal(fs.readFileSync(file.path, 'utf8'), file.source.endsWith('desktop.png') ? 'png-en-desktop' : 'png-ar-narrow');
    assert.equal(fs.statSync(file.path).mode & 0o222, 0, 'read-only');
  }
  assert.match(ok(wf(f.root, ['verify', '--attempt', f.e.id])).out, /verified 1 attempt/);
  assert.doesNotMatch(ok(wf(f.root, ['resume', '--attempt', f.e.id])).out, /names screenshots/, 'the route exists now');
  // The same files again add nothing.
  assert.match(wf(f.root, ['captures', 'import', '--from', dir, '--attempt', f.e.id]).err, /no capture imported .*already imported for this tree/s);

  // They are the gate's screenshots for this tree: the reviewer is handed them and acceptance wants each inspected.
  ok(wf(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', f.e.id]));
  const shas = imported.files.map((x) => x.sha256);
  const hand = wf(f.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', f.e.id]);
  ok(hand);
  const shots = bundle(hand).gate.screenshots;
  assert.deepEqual(shots.map((x) => x.sha256).sort(), [...shas].sort());
  assert.ok(shots.every((x) => x.origin === 'imported by the owner'), 'the reviewer is told these were not collected by a gate step');
  const criteria = [{ id: 'C1', evidence: { kind: 'screenshot', ref: shas[1] } }, { id: 'C2', evidence: { kind: 'not-applicable', reason: 'nothing to see' } }];
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r', { criteria, screenshotsInspected: [shas[0]] })), '--attempt', f.e.id]));
  assert.match(wf(f.root, ['accept', '--attempt', f.e.id]).err, /1 gate screenshot\(s\) not inspected by the reviewer/);
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', f.e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r2', { criteria, screenshotsInspected: shas })), '--attempt', f.e.id]));
  // A capture added once the tree is accepted would be delivered unreviewed.
  write(f.base, 'late/late.png', 'late');
  ok(wf(f.root, ['accept', '--attempt', f.e.id]));
  const late = importIt(f, path.join(f.base, 'late'));
  assert.equal(late.code, 75);
  assert.match(late.err, /the review of this tree is accepted: captures imported now would reach the delivery without a reviewer inspecting them/);
  // And delivery attaches them like any gate screenshot.
  const delivered = ok(wf(f.root, ['deliver', '--attempt', f.e.id])).out;
  assert.match(delivered, /SHOW TO OWNER \(2 delivered screenshot\(s\) for ENG-90\)/);
  assert.match(delivered, /attach as: desktop\.png/);
});

test('an imported capture is left behind by a change to the tree, and the notice returns', () => {
  const f = quick('capture-route-stale');
  planned(f);
  ok(importIt(f, captures(f)));
  assert.doesNotMatch(ok(wf(f.root, ['resume', '--attempt', f.e.id])).out, /names screenshots/);
  commitIn(f.wt, { 'src/a.txt': 'fixed after review\n' });
  const resume = ok(wf(f.root, ['resume', '--attempt', f.e.id])).out;
  assert.match(resume, /warning: C1 names screenshots as evidence/);
  assert.match(resume, /Captures imported earlier were made on an earlier tree; import them again from the current one/);
  ok(wf(f.root, ['gate', ...OUT_OF_ORDER, '--attempt', f.e.id]));
  const hand = ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', f.e.id]));
  assert.deepEqual(bundle(hand).gate.screenshots, [], 'the earlier tree\'s captures are not this tree\'s evidence');
  // Imported again from the new tree, they count again (a second import, new copies).
  const again = ok(importIt(f, captures(f)));
  assert.match(again.out, /as import 2/);
  assert.doesNotMatch(ok(wf(f.root, ['resume', '--attempt', f.e.id])).out, /names screenshots/);
});

test('what is imported is only what wf can trust: images, regular files with one name, not empty; a capture edited afterwards is caught', () => {
  const f = quick('capture-route-trust');
  planned(f);
  const dir = captures(f);
  fs.symlinkSync(path.join(dir, 'en', 'desktop.png'), path.join(dir, 'link.png'));
  write(dir, 'hard.png', 'png-hard');
  fs.linkSync(path.join(dir, 'hard.png'), path.join(dir, 'hard-twin.png'));
  // A capture saved before the tree's last commit cannot show that commit: it is imported, flagged, and the reviewer is told.
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(dir, 'en', 'desktop.png'), old, old);
  const r = ok(importIt(f, dir));
  assert.match(r.out, /2 capture\(s\) imported/);
  assert.match(r.out, /note: 1 of them were saved before the last commit of this tree/);
  const flagged = state(f.root, f.e.id).captureImports[0].files;
  assert.deepEqual(flagged.map((x) => [x.source, x.madeBeforeLastCommit === true]), [['import-1/ar/narrow.png', false], ['import-1/en/desktop.png', true]]);
  assert.match(r.out, /skipped 4: /);
  assert.deepEqual(state(f.root, f.e.id).captureImports[0].skipped.map((x) => x.file).sort(), ['blank.png', 'hard-twin.png', 'hard.png', 'link.png'], 'a link, a file with another name and an empty file are never imported');
  // The single-file form.
  write(f.base, 'one/home.png', 'png-home');
  assert.match(ok(wf(f.root, ['captures', 'import', '--file', path.join(f.base, 'one', 'home.png'), '--attempt', f.e.id])).out, /1 capture\(s\) imported .* as import 2/s);
  assert.match(wf(f.root, ['captures', 'import', '--from', path.join(f.base, 'captures-src', 'en'), '--file', path.join(f.base, 'one', 'home.png'), '--attempt', f.e.id]).err, /not both and not neither/);
  // Never hand-edited: a changed copy no longer matches what wf recorded.
  const copy = state(f.root, f.e.id).captureImports[0].files[0].path;
  fs.chmodSync(copy, 0o644);
  fs.writeFileSync(copy, 'edited by hand');
  const verify = wf(f.root, ['verify', '--attempt', f.e.id]);
  assert.notEqual(verify.code, 0);
  assert.match(verify.out + verify.err, /content differs from its recorded sha256|size/);
});

test('a batch imports captures for the member they show; only that member delivers them', () => {
  const steps = [UNIT];
  const { base, root } = singleRepoProject('capture-route-batch', { gate: { steps } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-94', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-95', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  const dir = path.join(base, 'batch-shots');
  write(dir, 'home.png', 'png-first-member');
  const into = (extra) => wf(root, ['captures', 'import', '--from', dir, '--attempt', b.id, ...extra]);
  assert.match(into([]).err, /is a batch: say which member the captures show with --for \(members: ENG-94\.1, ENG-95\.1\)/);
  assert.match(into(['--for', 'ENG-99.1']).err, /is a batch: say which member/);
  // A member accepted on its own tree takes no more captures.
  assert.match(wf(root, ['captures', 'import', '--from', dir, '--attempt', m1.id]).err, /the review of this tree is accepted/);
  ok(into(['--for', m1.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  const hand = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  const shots = bundle(hand).gate.screenshots;
  assert.equal(shots.length, 1);
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [shots[0].sha256], anomalies: 'none seen' }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  const d = ok(wf(root, ['deliver', '--attempt', b.id])).out;
  assert.match(d, /SHOW TO OWNER \(1 delivered screenshot\(s\) for ENG-94\)/);
  assert.doesNotMatch(d, /delivered screenshot\(s\) for ENG-95/, 'never another member\'s capture');
});
