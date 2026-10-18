// 0.7.30 (I-198, I-160, D55): the screenshots of one named run, exported for diagnosis.
//
// Named failure (I-198, field): a failed browser step kept four failed-case screenshots that `wf evidence list` showed, but
// `wf export screenshots --gate` said the last gate collected no screenshots, and the role instructions allow viewing images
// only through an exported copy: the implementer diagnosing the failure could not look at them. A gate stopped after its
// first failed case (I-199) and captures imported before any full gate (I-160) were refused the same way. One route now
// covers all three: `wf export screenshots --run <run id | import-<n>>`, every image recorded in that run or import, each
// checked against its recorded sha256 like the existing exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, commitIn, criteriaFile, ok, OUT_OF_ORDER, ownerSpeaks, singleRepoProject, spawnHome, state, wf, write } from './helpers.mjs';

const admitted = (root, base, item) => {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  return e;
};
// A browser-like step: the failed cases' screenshots go to the run's scratch folder (sealed under the step's `out/`), never
// under the step's `artifacts` globs, and the step fails until `src/pass.txt` exists.
const BROWSER = { id: 'browser', repo: 'app', run: 'mkdir -p "$WF_EVIDENCE/test-results" && printf fail-a > "$WF_EVIDENCE/test-results/case-a.png" && printf fail-b > "$WF_EVIDENCE/test-results/case-b.png" && test -f src/pass.txt', artifacts: ['e2e/.evidence/{itemLower}/**/*.png'] };

test('I-198: the failed-case screenshots of a named failed run export, sha256-checked, also after a later gate passed', () => {
  const { base, root } = singleRepoProject('run-shots-failed', { gate: { steps: [BROWSER] } });
  const e = admitted(root, base, 'ENG-198');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const failed = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']);
  assert.equal(failed.code, 1);
  const runId = JSON.parse(failed.out).runId;
  const listed = ok(wf(root, ['evidence', 'list', '--attempt', e.id, '--json'])).json().files.filter((f) => f.kind === 'screenshot').map((f) => f.path);
  assert.deepEqual(listed, [`gate/${runId}/browser/out/test-results/case-a.png`, `gate/${runId}/browser/out/test-results/case-b.png`]);
  // The gate's own set is empty: the refusal names the run that holds images and the route.
  const refused = wf(root, ['export', 'screenshots', '--gate', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, new RegExp(`the last gate of ENG-198\\.1 collected no screenshots; images are recorded in: gate run ${runId} \\(failed\\): 2 \\(\`wf export screenshots --run <run id> --attempt ENG-198\\.1\`\\)`));
  // `wf evidence show` sends an image to the export of the run it belongs to.
  assert.match(wf(root, ['evidence', 'show', listed[0], '--attempt', e.id]).err, new RegExp(`is an image: copy it out with \`wf export screenshots --run ${runId} --attempt ENG-198\\.1 --to <folder>\``));
  const to = path.join(base, 'diag');
  const out = ok(wf(root, ['export', 'screenshots', '--run', runId, '--attempt', e.id, '--to', to, '--json'])).json();
  assert.deepEqual(out.files.map((f) => f.title).sort(), ['case-a.png', 'case-b.png']);
  for (const f of out.files) {
    assert.ok(f.file.startsWith(to), f.file);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.title === 'case-a.png' ? 'fail-a' : 'fail-b');
  }
  assert.equal(out.run, runId);
  const human = ok(wf(root, ['export', 'screenshots', '--run', runId, '--attempt', e.id, '--to', to])).out;
  assert.match(human, new RegExp(`copied 2 screenshot\\(s\\) of gate run ${runId} \\(failed\\) of ENG-198\\.1 to \\S+ \\(each sha256-checked against the evidence record; view them with the Read tool\\)`));
  // A later gate passes; the failed run is still named and exported, the export is not recorded as the delivered set.
  commitIn(e.repos.app.worktree, { 'src/pass.txt': 'ok\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  assert.equal(ok(wf(root, ['export', 'screenshots', '--run', runId, '--attempt', e.id, '--to', to, '--json'])).json().files.length, 2);
  assert.equal(state(root, e.id).delivery.exported, undefined, 'a diagnostic export is never the delivered set');
  // An unknown run is refused with the runs that exist.
  const unknown = wf(root, ['export', 'screenshots', '--run', 'nope', '--attempt', e.id]);
  assert.equal(unknown.code, 75);
  assert.match(unknown.err, new RegExp(`no run \`nope\` in ENG-198\\.1; runs with images: gate run ${runId} \\(failed\\): 2`));
  assert.match(wf(root, ['export', 'screenshots', '--run', '--attempt', e.id]).err, /usage: .*--run <run id \| import-<n>>/);
  assert.equal(ok(wf(root, ['verify', '--attempt', e.id])).code, 0);
});

// I-199 (retired into I-198): a gate stopped after its first failed case keeps the captures it wrote; its run exports them.
test('I-198: a gate stopped by the owner exports the captures its interrupted step wrote', async () => {
  const step = { id: 'browser', repo: 'app', run: 'mkdir -p "$WF_EVIDENCE/test-results" && printf first-failure > "$WF_EVIDENCE/test-results/first.png" && sleep 30' };
  const { base, root } = singleRepoProject('run-shots-stopped', { gate: { steps: [step] } });
  const e = admitted(root, base, 'ENG-199');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const args = ['gate', ...OUT_OF_ORDER, '--attempt', e.id];
  ownerSpeaks(root, args);
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), ...spawnHome(root) };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const child = spawn(process.execPath, [WF, ...args], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const ended = new Promise((resolve) => child.once('close', resolve));
  const scratch = path.join(root, '.wf-worktrees', '_gate', e.id);
  for (let i = 0; i < 200; i++) {
    const found = fs.existsSync(scratch) && fs.readdirSync(scratch).some((r) => fs.existsSync(path.join(scratch, r, 'browser', 'test-results', 'first.png')));
    if (found) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(wf(root, ['stop', '--class', 'owner-decision', '--reason', 'diagnose the first failure', '--attempt', e.id]));
  await ended;
  const g = state(root, e.id).gates.at(-1);
  assert.equal(g.status, 'stopped');
  assert.equal(g.steps.find((x) => x.id === 'browser').status, 'interrupted');
  assert.match(wf(root, ['export', 'screenshots', '--gate', '--attempt', e.id]).err, new RegExp(`images are recorded in: gate run ${g.runId} \\(stopped\\): 1`));
  const out = ok(wf(root, ['export', 'screenshots', '--run', g.runId, '--attempt', e.id, '--to', path.join(base, 'diag'), '--json'])).json();
  assert.deepEqual(out.files.map((f) => f.title), ['first.png']);
  assert.equal(fs.readFileSync(out.files[0].file, 'utf8'), 'first-failure');
});

// I-160, named failure (field): the person said "skip the full gate but do the review"; captures imported on the committed tree
// could not be exported for the review route ("not delivered", "the last gate collected no screenshots"), because imports
// joined the gate's set only for a tree a gate had run on.
test('I-160: captures imported before any gate export by their import, with where they came from', () => {
  const { base, root } = singleRepoProject('run-shots-import', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = admitted(root, base, 'ENG-160');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const dir = path.join(base, 'made-by-hand');
  write(dir, 'desktop.png', 'png-desktop');
  write(dir, 'narrow/home.png', 'png-narrow');
  ok(wf(root, ['captures', 'import', '--from', dir, '--note', 'made by hand on the committed tree', '--attempt', e.id]));
  assert.match(wf(root, ['export', 'screenshots', '--gate', '--attempt', e.id]).err, /no gate has run on ENG-160\.1; images are recorded in: import-1 \(imported by the owner[^)]*\): 2/);
  assert.match(wf(root, ['evidence', 'show', 'captures/import-1/desktop.png', '--attempt', e.id]).err, /copy it out with `wf export screenshots --run import-1 --attempt ENG-160\.1 --to <folder>`/);
  const to = path.join(base, 'diag');
  const out = ok(wf(root, ['export', 'screenshots', '--run', 'import-1', '--attempt', e.id, '--to', to, '--json'])).json();
  assert.deepEqual(out.files.map((f) => f.title).sort(), ['desktop.png', 'home.png']);
  assert.equal(fs.readFileSync(out.files.find((f) => f.title === 'home.png').file, 'utf8'), 'png-narrow');
  const human = ok(wf(root, ['export', 'screenshots', '--run', 'import-1', '--attempt', e.id, '--to', to])).out;
  assert.match(human, /copied 2 screenshot\(s\) of import-1 \(imported by the owner[^)]*; made by hand on the committed tree\) of ENG-160\.1 to /);
  assert.match(human, /not a gate's evidence until a gate passes on the tree they were made on/);
});
