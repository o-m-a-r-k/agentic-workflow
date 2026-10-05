import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, wf } from './helpers.mjs';

// A real ticket was refused at `wf accept` with 1,300 screenshots from other tickets' specs: the step's artifacts globs
// matched everything the e2e suite wrote. Placeholders scope a glob to the ticket's own evidence folder.
const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\natt/\n' };
const writeShots = 'mkdir -p shots/eng-70 shots/eng-99 att/$WF_ATTEMPT && printf a > shots/eng-70/home.png && printf b > shots/eng-99/other.png && printf c > att/$WF_ATTEMPT/x.png';

function toReview(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': `${item}\n` });
  const g = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).json();
  return { id: e.id, gate: g, bundle: JSON.parse(fs.readFileSync(h.bundle, 'utf8')) };
}

test('artifacts placeholders: only the ticket\'s files are collected, listed per glob, and each must be inspected', () => {
  const steps = [{ id: 'ui', repo: 'app', run: writeShots, artifacts: ['shots/{itemLower}/**/*.png', 'att/{attempt}/*.png'] }];
  const { base, root } = singleRepoProject('evidence', { gate: { steps } }, ignore);
  const { id, gate, bundle } = toReview(root, base, 'ENG-70');
  const sources = gate.steps[0].artifacts.map((a) => a.source).sort();
  assert.deepEqual(sources, ['att/ENG-70.1/x.png', 'shots/eng-70/home.png'], 'another ticket\'s screenshot is never collected');
  const [shots, att] = bundle.gate.artifacts[0].globs;
  assert.deepEqual(shots.expanded, ['shots/eng-70/**/*.png']);
  assert.deepEqual(att.expanded, [`att/${id}/*.png`]);
  assert.equal(shots.files.length, 1);
  assert.match(shots.files[0].sha256, /^[0-9a-f]{64}$/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [shots.files[0].sha256] })), '--attempt', id]));
  const refused = wf(root, ['accept', '--attempt', id]);
  assert.match(refused.err, /1 gate screenshot\(s\) not inspected.*att\/ENG-70\.1\/x\.png/, 'a matched file not inspected still blocks');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { screenshotsInspected: [shots.files[0].sha256, att.files[0].sha256] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
});

test('artifacts placeholders: a ticket with no files under its globs needs no screenshots', () => {
  const steps = [{ id: 'ui', repo: 'app', run: writeShots, artifacts: ['shots/{itemLower}/**/*.png'] }];
  const { base, root } = singleRepoProject('evidence-none', { gate: { steps } }, ignore);
  const { id, gate, bundle } = toReview(root, base, 'ENG-71');
  assert.equal(gate.steps[0].artifacts.length, 0);
  assert.equal(bundle.gate.artifacts[0].note, 'no screenshots for this ticket (globs: shots/eng-71/**/*.png)');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  const ev = ok(wf(root, ['export', '--attempt', id, '--json'])).json().evidence;
  assert.deepEqual(ev, [{ step: 'ui', glob: 'shots/{itemLower}/**/*.png', expanded: ['shots/eng-71/**/*.png'], files: [] }]);
});

test('artifacts placeholders: an unknown placeholder is refused with the known ones', () => {
  const steps = [{ id: 'ui', repo: 'app', run: 'true', artifacts: ['shots/{ticket}/*.png', 'shots/{a,b}/*.png'] }];
  const { root } = singleRepoProject('evidence-bad', { gate: { steps } });
  const d = wf(root, ['doctor', '--no-steps']);
  assert.notEqual(d.code, 0);
  assert.match(d.out, /artifacts glob `shots\/\{ticket\}\/\*\.png` uses unknown placeholder\(s\) \{ticket\} \(known: \{item\}, \{itemLower\}, \{attempt\}\)/);
  assert.doesNotMatch(d.out, /\{a,b\}/, 'brace alternation is not a placeholder');
});

test('doctor: counts per glob from the last gate, and warns on a placeholder-less glob matching files the ticket did not touch', () => {
  const steps = [{ id: 'ui', repo: 'app', run: writeShots, artifacts: ['shots/**/*.png', 'att/{attempt}/*.png'] }];
  const { base, root } = singleRepoProject('evidence-doctor', { gate: { steps } }, ignore);
  toReview(root, base, 'ENG-72');
  const d = ok(wf(root, ['doctor', '--no-steps']));
  assert.match(d.out, /ui: shots\/\*\*\/\*\.png matched 2/);
  assert.match(d.out, /ui: att\/\{attempt\}\/\*\.png matched 1/);
  assert.match(d.out, /warning: artifacts of step ui — `shots\/\*\*\/\*\.png` has no \{item\}\/\{itemLower\}\/\{attempt\} placeholder and matched 2 file\(s\)/);
  assert.match(d.out, /1,300 unrelated screenshots/);
  assert.doesNotMatch(d.out, /`att\/\{attempt\}/, 'a placeholder glob is not warned');
});
