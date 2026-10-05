import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, singleRepoProject, state, tmp, toAccepted, wf } from './helpers.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';

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

// A UI-changing ticket whose globs matched nothing passed as "no screenshots for this ticket" and nothing flagged it.
test('no evidence: a step whose globs matched nothing while its package changed needs the reviewer\'s verdict', () => {
  const steps = [{ id: 'ui', repo: 'app', run: writeShots, artifacts: ['shots/{itemLower}/**/*.png'] }];
  const { base, root } = singleRepoProject('evidence-none', { gate: { steps } }, ignore);
  const { id, gate, bundle } = toReview(root, base, 'ENG-71');
  assert.equal(gate.steps[0].artifacts.length, 0);
  const ui = bundle.gate.artifacts[0];
  assert.equal(ui.uncovered, true);
  assert.deepEqual(ui.changedHere, ['src/a.txt']);
  assert.match(ui.note, /no captures for this ticket \(globs: shots\/eng-71\/\*\*\/\*\.png\), though it changed 1 file\(s\).*noEvidence/);
  assert.match(bundle.instructions, /noEvidence: \[\{ step, reason \}\]/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  const refused = wf(root, ['accept', '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /step ui: its artifacts globs \(shots\/eng-71\/\*\*\/\*\.png\) matched nothing though this ticket changed 1 file\(s\) in its package/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', { noEvidence: [{ step: 'ui', reason: '   ' }] })), '--attempt', id]));
  assert.match(wf(root, ['accept', '--attempt', id]).err, /step ui: its artifacts globs/, 'an empty reason is no verdict');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r3', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r3', { noEvidence: [{ step: 'ui', reason: 'copy change in a text file; no screen shows it' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  const data = ok(wf(root, ['export', '--attempt', id, '--json'])).json();
  assert.deepEqual(data.evidence, [{ step: 'ui', glob: 'shots/{itemLower}/**/*.png', expanded: ['shots/eng-71/**/*.png'], files: [] }]);
  assert.deepEqual(data.noEvidence, [{ step: 'ui', changed: 1, globs: ['shots/eng-71/**/*.png'], reason: 'copy change in a text file; no screen shows it', finding: null }]);
  assert.deepEqual(data.reviews.at(-1).noEvidence, [{ step: 'ui', reason: 'copy change in a text file; no screen shows it' }]);
  ok(wf(root, ['export', '--attempt', id]));
  const html = fs.readFileSync(`${root}/.wf-evidence/attempts/${id}/export/attempt.html`, 'utf8');
  assert.match(html, /Steps without captures[\s\S]*copy change in a text file/);
  assert.equal(state(root, id).accepted.noEvidence[0].reason, 'copy change in a text file; no screen shows it', 'the verdict is ledgered with the acceptance');
});

test('no evidence: a finding that names the step is a verdict too', () => {
  const steps = [{ id: 'web-ui', repo: 'app', run: 'true', artifacts: ['shots/{itemLower}/*.png'] }];
  const { base, root } = singleRepoProject('evidence-finding', { gate: { steps } }, ignore);
  const { id } = toReview(root, base, 'ENG-73');
  const finding = { id: 'F1', severity: 'minor', summary: 'web-ui wrote no capture; the change is not visible on any screen', status: 'verified-nonissue', evidence: 'src/a.txt:1' };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { findings: [finding] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
});

test('no evidence: nothing is required from a step whose package did not change', () => {
  const repos = [{ name: 'app', path: '.', base: 'main', packages: [{ path: 'web' }, { path: 'api' }] }];
  const steps = [{ id: 'ui', repo: 'app', package: 'web', run: 'true', artifacts: ['shots/{itemLower}/*.png'] }];
  const { base, root } = singleRepoProject('evidence-other-pkg', { repos, gate: { steps } }, { ...ignore, 'web/a.txt': 'w\n', 'api/a.txt': 'a\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-74', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'api/a.txt': 'changed\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id, '--json'])).json();
  const ui = JSON.parse(fs.readFileSync(h.bundle, 'utf8')).gate.artifacts[0];
  assert.equal(ui.uncovered, false);
  assert.deepEqual(ui.changedHere, []);
  assert.match(ui.note, /package did not change, nothing is required/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
});

test('a screenshot criterion must reference a screenshot the gate collected', () => {
  const steps = [{ id: 'ui', repo: 'app', run: writeShots, artifacts: ['shots/{itemLower}/**/*.png'] }];
  const { base, root } = singleRepoProject('evidence-criterion', { gate: { steps } }, ignore);
  const { id, bundle } = toReview(root, base, 'ENG-70');
  const shot = bundle.gate.artifacts[0].globs[0].files[0];
  const closure = (reviewer, ref) => goodClosure(reviewer, { criteria: [{ id: 'C1', evidence: { kind: 'screenshot', ref } }], screenshotsInspected: [shot.sha256] });
  ok(wf(root, ['review', '--closure', closureFile(base, closure('r', 'shots/eng-99/other.png')), '--attempt', id]));
  const refused = wf(root, ['accept', '--attempt', id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /criterion C1: screenshot `shots\/eng-99\/other\.png` is not one the gate collected/);
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, closure('r2', shot.source)), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]), 'matched by source path');
});

// The env var decides WHICH captures the tests make; where they go stays the project's convention (the artifacts glob).
test('steps receive WF_ITEM and WF_ITEMS, for one attempt and for a batch', () => {
  const steps = [
    { id: 'unit', repo: 'app', run: 'echo "light item=$WF_ITEM items=$WF_ITEMS"', inputs: ['src/**'] },
    { id: 'e2e', repo: 'app', run: 'echo "item=$WF_ITEM items=$WF_ITEMS" >> "$WF_ROOT/../env.log"', tier: 'heavy' },
  ];
  const { base, root } = singleRepoProject('evidence-env', { gate: { steps } }, { 'src/b.txt': 'b\n' });
  const single = toReview(root, base, 'ENG-80');
  const unit = single.gate.steps.find((x) => x.id === 'unit');
  assert.match(fs.readFileSync(unit.log, 'utf8'), /light item=ENG-80 items=ENG-80$/m);
  fs.rmSync(`${root}/../env.log`);
  const m1 = toAccepted(root, base, { item: 'ENG-81', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-82', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['gate', '--attempt', b.id]));
  assert.equal(fs.readFileSync(`${root}/../env.log`, 'utf8').trim(), `item=${b.item} items=${b.item} ENG-81 ENG-82`);
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

test('wf init drafts the ticket folder under the Playwright test dir, and nothing for an unknown runner', () => {
  const pkg = (deps) => JSON.stringify({ name: 'web', scripts: { 'test:e2e': 'run-e2e' }, devDependencies: deps });
  const pw = makeRepo(`${tmp('init-pw')}/web`, { 'package.json': pkg({ '@playwright/test': '1' }), 'playwright.config.ts': "export default { testDir: './specs/e2e', use: {} };\n" }).dir;
  const r = ok(wf(pw, ['init']));
  const draft = fs.readFileSync(`${pw}/.workflow/project.yaml`, 'utf8');
  assert.match(draft, /artifacts:\n\s+- specs\/e2e\/\.evidence\/\{itemLower\}\/\*\*\/\*\.png/);
  assert.match(r.out, /note: web-e2e: specs\/e2e\/\.evidence\/\{itemLower\}\/\*\*\/\*\.png\. UI tests must write each ticket's captures there; WF_ITEMS lists the tickets of the run\./);
  const cy = makeRepo(`${tmp('init-cy')}/web`, { 'package.json': pkg({ cypress: '13' }) }).dir;
  ok(wf(cy, ['init']));
  assert.match(fs.readFileSync(`${cy}/.workflow/project.yaml`, 'utf8'), /- cypress\/\.evidence\/\{itemLower\}\/\*\*\/\*\.png/);
  const other = makeRepo(`${tmp('init-other')}/web`, { 'package.json': pkg({}) }).dir;
  const o = ok(wf(other, ['init']));
  assert.doesNotMatch(fs.readFileSync(`${other}/.workflow/project.yaml`, 'utf8'), /artifacts/);
  assert.doesNotMatch(o.out, /note:/);
});

test('doctor warns from the adapter alone about a glob without a placeholder, before any gate', () => {
  const steps = [{ id: 'ui', repo: 'app', run: 'true', artifacts: ['shots/**/*.png', 'att/{attempt}/*.png'] }];
  const { root } = singleRepoProject('evidence-static', { gate: { steps } });
  const d = ok(wf(root, ['doctor', '--no-steps']), 'a warning never fails doctor');
  assert.match(d.out, /! warning: artifacts of step ui — `shots\/\*\*\/\*\.png` has no \{item\}\/\{itemLower\}\/\{attempt\} placeholder: every file the suite writes under it is evidence/);
  assert.doesNotMatch(d.out, /`att\/\{attempt\}/);
});

test('engine pin: >=x.y.z is enforced at entry and gate, naming installed and required', () => {
  const [maj, min, pat] = ENGINE_VERSION.split('.').map(Number);
  for (const pin of [`>=${ENGINE_VERSION}`, `>=${maj}.${min}.${Math.max(0, pat - 1)}`, `${maj}.x`]) {
    const { root } = singleRepoProject('pin-ok', { engine: pin, gate: { steps: [] } });
    ok(wf(root, ['entry', '--item', 'ENG-90', '--owner', 'o']), `pin ${pin} is satisfied`);
  }
  const newer = `>=${maj}.${min}.${pat + 1}`;
  const { root } = singleRepoProject('pin-old', { engine: newer, gate: { steps: [] } });
  const refused = wf(root, ['entry', '--item', 'ENG-91', '--owner', 'o']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, new RegExp(`needs engine ${newer.replace(/[.]/g, '\\.')}; installed is ${ENGINE_VERSION.replace(/[.]/g, '\\.')}`));
  assert.match(refused.err, /claude plugin update/);
  const d = wf(root, ['doctor', '--no-steps']);
  assert.notEqual(d.code, 0);
  assert.match(d.out, /engine version — the project needs engine/);
  // A pin raised after admission stops the gate too.
  const p = singleRepoProject('pin-gate', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-92', '--owner', 'o', '--json'])).json();
  const cfgFile = `${p.root}/.workflow/project.yaml`;
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), engine: newer }));
  const g = wf(p.root, ['gate', '--attempt', e.id]);
  assert.equal(g.code, 75);
  assert.match(g.err, /needs engine/);
  const bad = singleRepoProject('pin-bad', { engine: '0.1', gate: { steps: [] } });
  assert.match(wf(bad.root, ['doctor', '--no-steps']).out, /`engine` must be `N\.x` \(same major\) or `>=x\.y\.z`/);
});

test('the ledger records the released engine version', () => {
  const { root } = singleRepoProject('engine-version', { gate: { steps: [] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-93', '--owner', 'o', '--json'])).json();
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(state(root, e.id).engineVersion, version);
});
