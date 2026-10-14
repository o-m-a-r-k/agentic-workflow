import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, wf, write } from './helpers.mjs';
import { readEvidenceFile, sealedCopyOfScratch } from '../engine/evidence.mjs';

// Named failure (I-100): a step plugin is handed only a scratch folder and returned the screenshot it wrote there. The
// gate copied the scratch bytes into the evidence but recorded the scratch path, so `wf export screenshots --gate`
// refused every image as outside the project's attempt evidence although the gate had passed, and delivery could not
// list it. The record now names the sealed copy.

const PNG = 'png-bytes-from-the-plugin';
const plugin = (extra = '') => `import fs from 'node:fs';import path from 'node:path';
export default { async run(ctx) {
  const png = path.join(ctx.evidenceDir, 'shots', 'home.png');
  fs.mkdirSync(path.dirname(png), { recursive: true });
  fs.writeFileSync(png, ${JSON.stringify(PNG)});
  ${extra}
  return { status: 'passed', suites: [{ id: 'browser', status: 'passed' }], artifacts: [{ path: png, kind: 'screenshot' }${extra ? ', ...more' : ''}] };
} };`;

function project(name, extra = '') {
  const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'browser', repo: 'app', plugin: 'steps/shot.mjs', inputs: ['src/**'] }];
  return singleRepoProject(name, { gate: { steps } }, { '.workflow/steps/shot.mjs': plugin(extra) });
}

function toGated(f, item) {
  const e = ok(wf(f.root, ['entry', '--item', item, '--json'])).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r0', '--attempt', e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r0')), '--attempt', e.id]));
  return e;
}

test('I-100: a plugin-produced screenshot goes gate, export --gate, review, acceptance and delivery', () => {
  const f = project('plugin-shot');
  const e = toGated(f, 'ENG-100');
  const g = ok(wf(f.root, ['gate', '--attempt', e.id, '--json'])).json();
  assert.equal(g.status, 'passed');
  const shot = g.steps.find((s) => s.id === 'browser').artifacts[0];
  assert.equal(shot.kind, 'screenshot');
  assert.match(shot.path, /\.wf-evidence\/attempts\/ENG-100\.1\/gate\/[^/]+\/browser\/out\/shots\/home\.png$/, 'recorded at the sealed copy, never the scratch path');
  assert.ok(!shot.path.includes('_gate'));
  assert.equal(fs.readFileSync(shot.path, 'utf8'), PNG);
  const exported = ok(wf(f.root, ['export', 'screenshots', '--gate', '--attempt', e.id, '--to', path.join(f.base, 'out'), '--json'])).json();
  assert.equal(exported.files.length, 1);
  assert.equal(exported.files[0].title, 'home.png');
  assert.equal(fs.readFileSync(exported.files[0].file, 'utf8'), PNG);
  // The reviewer must inspect it, and acceptance then delivers it.
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r1', { screenshotsInspected: [shot.sha256] })), '--attempt', e.id]));
  ok(wf(f.root, ['accept', '--attempt', e.id]));
  const d = ok(wf(f.root, ['deliver', '--attempt', e.id]));
  assert.match(d.out, /SHOW TO OWNER \(1 delivered screenshot\(s\) for ENG-100\)/);
  const delivered = state(f.root, e.id).delivery.screenshots.screenshots;
  assert.deepEqual(delivered.map((x) => [x.title, x.sha256, x.path]), [['home.png', shot.sha256, shot.path]]);
  const copies = ok(wf(f.root, ['export', 'screenshots', '--attempt', e.id, '--to', path.join(f.base, 'out2'), '--json'])).json();
  assert.equal(fs.readFileSync(copies.files[0].file, 'utf8'), PNG);
});

test('I-100: an attempt gated before the fix (scratch path recorded) is read through its sealed copy, by sha256 only', () => {
  const f = project('plugin-shot-legacy');
  const e = toGated(f, 'ENG-101');
  const g = ok(wf(f.root, ['gate', '--attempt', e.id, '--json'])).json();
  const shot = g.steps.find((s) => s.id === 'browser').artifacts[0];
  const runId = g.runId;
  const scratch = path.join(fs.realpathSync(f.root), '.wf-worktrees', '_gate', e.id, runId, 'browser', 'shots', 'home.png');
  assert.equal(sealedCopyOfScratch(fs.realpathSync(f.root), scratch, shot.sha256), shot.path);
  const read = readEvidenceFile(f.root, e.id, { path: scratch, sha256: shot.sha256, title: 'home.png' });
  assert.equal(read.bytes.toString('utf8'), PNG);
  // Nothing else is let through: a wrong hash, no hash, and a file outside the scratch layout stay refused.
  assert.throws(() => readEvidenceFile(f.root, e.id, { path: scratch, sha256: 'f'.repeat(64), title: 'home.png' }), { code: 'ESHA' });
  assert.throws(() => readEvidenceFile(f.root, e.id, { path: scratch, title: 'home.png' }), { code: 'EOUTSIDE' });
  const planted = path.join(e.repos.app.worktree, 'shots', 'home.png');
  write(e.repos.app.worktree, 'shots/home.png', PNG);
  assert.throws(() => readEvidenceFile(f.root, e.id, { path: planted, sha256: shot.sha256, title: 'home.png' }), { code: 'EOUTSIDE' });
  const notYours = path.join(fs.realpathSync(f.root), '.wf-worktrees', '_gate', e.id, runId, 'browser', '..', '..', '..', '..', 'x.png');
  assert.equal(sealedCopyOfScratch(fs.realpathSync(f.root), notYours, shot.sha256), null);
});

test('I-100: a plugin artifact that is not a regular file of its output folder or package fails the step and says why', () => {
  const f = singleRepoProject('plugin-shot-refused', { gate: { steps: [{ id: 'browser', repo: 'app', plugin: 'steps/shot.mjs', inputs: ['src/**'] }] } }, {
    '.workflow/steps/shot.mjs': `import fs from 'node:fs';import path from 'node:path';
export default { async run(ctx) {
  const outside = path.join(ctx.root, 'outside.png'); fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, path.join(ctx.evidenceDir, 'link.png'));
  return { status: 'passed', artifacts: [{ path: outside, kind: 'screenshot' }, { path: path.join(ctx.evidenceDir, 'link.png'), kind: 'screenshot' }, { path: path.join(ctx.evidenceDir, 'gone.png'), kind: 'screenshot' }] };
} };`,
  });
  const e = toGated(f, 'ENG-102');
  const g = wf(f.root, ['gate', '--attempt', e.id, '--json']);
  assert.equal(g.code, 1);
  const step = g.json().steps.find((s) => s.id === 'browser');
  assert.equal(step.status, 'failed');
  assert.deepEqual(step.artifacts, []);
  const log = fs.readFileSync(step.log, 'utf8');
  assert.match(log, /outside\.png: outside the step's output folder/);
  assert.match(log, /link\.png: not a regular file in the step's output folder/);
  assert.match(log, /gone\.png: not a regular file in the step's output folder/);
});

test('I-100: a file the plugin leaves in its package folder is copied into the evidence like a globbed capture', () => {
  const f = singleRepoProject('plugin-shot-package', { gate: { steps: [{ id: 'browser', repo: 'app', plugin: 'steps/shot.mjs', inputs: ['src/**'] }] } }, {
    '.gitignore': '.wf-evidence/\n.wf-worktrees/\ncaptures/\n',
    '.workflow/steps/shot.mjs': `import fs from 'node:fs';import path from 'node:path';
export default { async run(ctx) {
  const png = path.join(ctx.dir, 'captures', 'page.png'); fs.mkdirSync(path.dirname(png), { recursive: true }); fs.writeFileSync(png, 'package-bytes');
  return { status: 'passed', artifacts: [{ path: png, kind: 'screenshot' }] };
} };`,
  });
  const e = toGated(f, 'ENG-103');
  const g = ok(wf(f.root, ['gate', '--attempt', e.id, '--json'])).json();
  const shot = g.steps[0].artifacts[0];
  assert.match(shot.path, /browser\/artifacts\/captures\/page\.png$/);
  assert.equal(shot.source, 'captures/page.png');
  const exported = ok(wf(f.root, ['export', 'screenshots', '--gate', '--attempt', e.id, '--to', path.join(f.base, 'out'), '--json'])).json();
  assert.equal(fs.readFileSync(exported.files[0].file, 'utf8'), 'package-bytes');
});
