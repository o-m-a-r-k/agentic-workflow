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
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, ownerSpeaks, singleRepoProject, spawnHome, state, wf, write } from './helpers.mjs';

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
  // The implementer handed the repair is told the route, named with the failed run.
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  const repair = ok(wf(root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync((repair.out.match(/bundle: (\S+)/) ?? repair.out.match(/^Read (\S+)/m))[1], 'utf8'));
  assert.equal(bundle.failedGate.screenshots, `\`wf export screenshots --run ${runId} --attempt ENG-198.1 --to <folder>\` copies every image this run recorded, failure captures included, sha256-checked`);
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

// 0.7.32 (D75). Named failure (field, I-221): a passing gate reran only the 2 suites that had failed in the run before it and
// carried 1251 tests from that run, but none of that run's 170 screenshots: the end-to-end step showed as uncovered for the
// evidence review, whose reviewer opened the earlier run's files by hand. A suite carried from an earlier run carries that run's
// captures (those this run did not write again), each checked against its recorded sha256 and naming the run it came from, and
// the evidence review is handed them as this gate's evidence.
const SUITES = `
const fs=require('fs'),path=require('path');const sel=process.argv.slice(2);
const all=['tests/a.test.js','tests/b.test.js'];const run=sel.length?sel:all;
fs.appendFileSync(process.env.WF_EVIDENCE+'/../ran.txt',run.join(',')+'\\n');
const out=path.join('e2e','.evidence',String(process.env.WF_ITEM).toLowerCase());
fs.rmSync(path.join('e2e','.evidence'),{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const counter=path.join(process.env.WF_ROOT,'..','b-runs.txt');
let failed=false;const cases=run.map(f=>{const name=path.basename(f,'.test.js');
  let fail=false;if(name==='b'){const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(n+1));fail=n===0;}
  fs.writeFileSync(path.join(out,name+'.png'),name+'-'+(fail?'failed':'passed')+'-'+Date.now());failed=failed||fail;
  return '<testcase classname="x" name="'+f+'" file="'+f+'">'+(fail?'<failure/>':'')+'</testcase>';}).join('');
fs.writeFileSync(process.env.WF_EVIDENCE+'/junit.xml','<testsuites><testsuite name="s">'+cases+'</testsuite></testsuites>');
process.exit(failed?1:0);`;
const E2E = { id: 'e2e', repo: 'app', run: 'node runner.cjs {select}', select: '{suites}', report: { junit: '{evidence}/junit.xml' }, inputs: ['tests/**', 'runner.cjs', 'src/**'], artifacts: ['e2e/.evidence/{itemLower}/**/*.png'] };
const suitesProject = (name) => singleRepoProject(name, { gate: { steps: [E2E] } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\ne2e/.evidence/\n', 'runner.cjs': SUITES, 'tests/a.test.js': 'a\n', 'tests/b.test.js': 'b\n' });

test('D75: a passing rerun carries the captures of the suites it carried, sha256-checked, named with their run, as the gate\'s evidence', () => {
  const { base, root } = suitesProject('carried-captures');
  const e = admitted(root, base, 'ENG-221');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const first = wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json']);
  assert.equal(first.code, 1);
  const failedRun = JSON.parse(first.out);
  const earlier = failedRun.steps[0].artifacts;
  assert.deepEqual(earlier.map((a) => a.source).sort(), ['e2e/.evidence/eng-221/a.png', 'e2e/.evidence/eng-221/b.png']);
  // The same tree: the flaky suite reruns alone and passes; suite a is carried from the failed run.
  const second = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json();
  assert.equal(second.status, 'passed');
  assert.deepEqual(second.steps[0].rerunSuites, ['tests/b.test.js']);
  assert.ok(second.steps[0].suites.find((s) => s.id === 'tests/a.test.js').carried);
  const shots = second.steps[0].artifacts;
  const a = shots.find((x) => x.source === 'e2e/.evidence/eng-221/a.png');
  const b = shots.find((x) => x.source === 'e2e/.evidence/eng-221/b.png');
  assert.ok(a, 'the carried suite\'s capture is the passing gate\'s evidence');
  assert.equal(a.carriedFrom, failedRun.runId);
  assert.deepEqual([a.path, a.sha256], [earlier.find((x) => x.source === a.source).path, earlier.find((x) => x.source === a.source).sha256]);
  assert.ok(b && !b.carriedFrom, 'the rerun suite\'s capture is this run\'s own');
  assert.notEqual(b.sha256, earlier.find((x) => x.source === b.source).sha256);
  assert.deepEqual(second.steps[0].artifactGlobs[0].files.map((f) => f.source).sort(), ['e2e/.evidence/eng-221/a.png', 'e2e/.evidence/eng-221/b.png']);
  // The evidence review is handed both, the carried one with its run, and the step is covered.
  const hand = ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev', '--attempt', e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(hand.bundle, 'utf8'));
  assert.equal(bundle.round, 'evidence-review');
  assert.deepEqual(bundle.gate.screenshots.map((x) => [x.source, x.carriedFrom ?? null]).sort(), [['e2e/.evidence/eng-221/a.png', failedRun.runId], ['e2e/.evidence/eng-221/b.png', null]]);
  const step = bundle.gate.artifacts.find((x) => x.step === 'e2e');
  assert.equal(step.uncovered, false);
  assert.deepEqual(step.globs[0].files.map((f) => [f.source, f.carriedFrom ?? null]).sort(), [['e2e/.evidence/eng-221/a.png', failedRun.runId], ['e2e/.evidence/eng-221/b.png', null]]);
  const out = ok(wf(root, ['export', 'screenshots', '--gate', '--attempt', e.id, '--to', path.join(base, 'shots'), '--json'])).json();
  assert.deepEqual(out.files.map((f) => fs.readFileSync(f.file, 'utf8').replace(/-\d+$/, '')).sort(), ['a-passed', 'b-passed']);
});

// 0.7.32 (D75). Named failure (field, I-221): nothing re-collected evidence on an unchanged tree: `--rerun-failed` refuses when the
// last gate passed, a gate reuses every step whose key is unchanged, and the gate order waits for the evidence review's open
// finding, so a finding only a re-run could satisfy took a dummy commit or the person's override. A finding that names its gate
// step and says only a re-run satisfies it (`step`, `rerun: true`) sends the next step to one `wf gate` on the unchanged tree, which
// re-runs that step whole; the evidence review after it verifies the finding. It is offered once: a finding that a re-run did not
// satisfy goes to the implementer like any other.
const FLAKY_CAPTURE = { id: 'e2e', repo: 'app', tier: 'heavy', run: 'n=$(cat "$WF_ROOT/../e2e-runs" 2>/dev/null || echo 0); echo $((n+1)) > "$WF_ROOT/../e2e-runs"; rm -rf e2e/.evidence; mkdir -p e2e/.evidence/eng-222; if [ "$n" -gt 0 ]; then printf "shot-$n" > e2e/.evidence/eng-222/home.png; fi', inputs: ['src/**'], artifacts: ['e2e/.evidence/{itemLower}/**/*.png'] };
function evidenceFinding(name) {
  const { base, root } = singleRepoProject(name, { gate: { steps: [FLAKY_CAPTURE] } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\ne2e/.evidence/\n' });
  const e = admitted(root, base, 'ENG-222');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'code-0', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('code-0')), '--attempt', e.id]));
  const first = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  assert.equal(first.steps[0].artifacts.length, 0, 'the first run collected no capture');
  const hand = ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev-1', '--attempt', e.id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(hand.bundle, 'utf8')).gate.artifacts[0].uncovered, true);
  const finding = { id: 'F1', severity: 'high', criterion: 'C1', step: 'e2e', rerun: true, summary: 'the e2e step collected no capture of the home screen: its capture did not run, nothing in the change is wrong', evidence: 'gate e2e: no file matched e2e/.evidence/eng-222/**/*.png' };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-1', { findings: [finding] })), '--attempt', e.id]));
  return { base, root, e, first };
}

test('D75: an evidence finding only a re-run satisfies sends the next step to one gate on the unchanged tree, which re-runs its step; the evidence review after it accepts', () => {
  const { base, root, e, first } = evidenceFinding('rerun-route');
  const s = state(root, e.id);
  assert.equal(s.decision.kind, 'gate');
  assert.match(s.next, /the evidence review's finding ev-1:F1 names gate step e2e and says only a re-run satisfies it: run one `wf gate`; it re-runs e2e whole on this unchanged tree \(no commit, no override\), and the evidence review after it verifies the finding/);
  const plan = ok(wf(root, ['gate', '--prepare-only', '--attempt', e.id, '--json'])).json();
  assert.equal(plan.steps.find((x) => x.id === 'e2e').decision, 'run');
  const second = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  const step = second.steps.find((x) => x.id === 'e2e');
  assert.equal(step.status, 'passed');
  assert.match(step.reason, /re-run for the evidence review's finding ev-1:F1/);
  assert.deepEqual(second.rerunFor, [{ step: 'e2e', findings: ['ev-1:F1'] }]);
  assert.equal(step.artifacts.length, 1);
  assert.deepEqual(second.tree, first.tree, 'the same tree');
  // Next: the evidence review of the re-run, which verifies the finding with the new capture; then the acceptance.
  assert.equal(state(root, e.id).decision.kind, 'review');
  const hand = ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev-2', '--attempt', e.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(hand.bundle, 'utf8'));
  assert.equal(bundle.round, 'evidence-review');
  const shot = bundle.gate.screenshots[0];
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-2', { screenshotsInspected: [shot.sha256], priorFindings: [{ round: 'ev-1', id: 'F1', status: 'fixed', evidence: `the re-run collected ${shot.source} (sha256 ${shot.sha256})` }] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
});

test('D75: the re-run route is offered once: a finding raised again on the re-run\'s evidence, or kept open after it, goes to the implementer, and the gate waits for it', () => {
  for (const kept of [false, true]) {
    const { base, root, e } = evidenceFinding(`rerun-once-${kept}`);
    ok(wf(root, ['gate', '--attempt', e.id]));
    const hand = ok(wf(root, ['handoff', 'reviewer', '--agent', 'ev-2', '--attempt', e.id, '--json'])).json();
    const shot = JSON.parse(fs.readFileSync(hand.bundle, 'utf8')).gate.screenshots[0];
    // The re-run's capture shows the wrong screen: F1 kept open, or settled and raised again as a re-run finding of its own.
    const again = { id: 'F2', severity: 'high', criterion: 'C1', step: 'e2e', rerun: true, summary: 'the e2e capture shows the old home screen', evidence: `${shot.source}` };
    const closure = kept ? { priorFindings: [{ round: 'ev-1', id: 'F1', status: 'open', evidence: 'the capture shows the old screen' }] } : { findings: [again], priorFindings: [{ round: 'ev-1', id: 'F1', status: 'fixed', evidence: `the re-run collected ${shot.source}` }] };
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('ev-2', { screenshotsInspected: [shot.sha256], ...closure })), '--attempt', e.id]));
    const s = state(root, e.id);
    // A repair (through the strategist when the course has signals), never another re-run gate.
    assert.ok(['repair', 'strategy'].includes(s.decision.kind), `kept=${kept}: ${s.decision.kind}`);
    assert.doesNotMatch(s.next, /only a re-run satisfies it/);
    assert.equal(wf(root, ['gate', '--attempt', e.id]).code, 75);
  }
});
