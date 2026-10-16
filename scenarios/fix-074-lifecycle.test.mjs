// 0.7.4, stream 1: the lifecycle defects of the 0.7.2 inbox triage. Each test names its failure and fails on 0.7.3.
//
// I-107  an amendment on an accepted attempt left the acceptance standing, so `wf deliver` shipped a criterion no review had
//        mapped to evidence (and `wf accept` took a re-worded one on the evidence mapped to its earlier wording);
// I-69   a launched reviewer that ended with no closure left the owner with no route, and a closure that named scope it did
//        not reach counted as the attempt's full audit with nothing showing the scope that was never looked at;
// I-79/89 a handoff stopped before it ran still spent the sweep it was handed;
// I-115  an unscoped legacy implementer left the other work items "not started" for good;
// I-114  a planner output `wf plan` could not read left no record for the next planner;
// I-109  rule copies were written into the evidence outside the transaction that records the handoff.
//
// Obligations of 0.7.4 gate on the version an attempt was admitted at (engine/versions.mjs), and the engine's version is read
// from package.json: `engineAt(version)` runs the same code stamped with another version (as strategist-fixtures.mjs does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT_OF_ORDER, amendFile, closureFile, commitIn, criteriaFile, goodClosure, ok, planDoc, singleRepoProject, tmp, toAccepted, wf, write } from './helpers.mjs';
import { loadState } from '../engine/ledger.mjs';
import { knownLimits } from '../engine/tracker.mjs';
import { verifyAttempt } from '../engine/evidence.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copies = new Map();
function engineAt(version) {
  if (copies.has(version)) return copies.get(version);
  const dir = tmp(`engine-${version}`);
  for (const d of ['bin', 'engine', 'templates', 'docs', 'skills', 'adapters', 'hooks']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }));
  const bin = path.join(dir, 'bin', 'wf');
  copies.set(version, bin);
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}
const runner = (version) => {
  const bin = engineAt(version);
  const run = (root, args, opts = {}) => wf(root, args, { ...opts, bin });
  run.state = (root, id) => ok(run(root, ['resume', '--attempt', id, '--json'])).json();
  return run;
};

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const map = (...ids) => ids.map((id) => ({ id, evidence: { kind: 'output', ref: 'gate log line 1' } }));

// An attempt with its criteria frozen (C1), an implementer's committed change and nothing reviewed yet.
function started(run, name, { config = {}, files = {} } = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, files);
  const e = ok(run(p.root, ['entry', '--item', 'ENG-1', '--owner', 'owner-1', '--json'])).json();
  ok(run(p.root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', 'owner-1']));
  ok(run(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id, '--owner', 'owner-1']));
  ok(run(p.root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id, '--owner', 'owner-1']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  return { ...p, run, id: e.id, wt: e.repos.app.worktree };
}
// One recorded review round on the current tree.
const round = (a, agent, closure = goodClosure(agent)) => {
  const handed = ok(a.run(a.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', a.id]));
  const bundle = JSON.parse(fs.readFileSync(handed.out.match(/^Read (\S+)/m)[1], 'utf8'));
  ok(a.run(a.root, ['review', '--closure', closureFile(a.base, closure), '--attempt', a.id]));
  return bundle;
};
// The order of work: a clean code review, one gate, the evidence review; accepted unless `accept: false`.
function accepted(run, name, { accept = true, config } = {}) {
  const a = started(run, name, { config });
  round(a, 'rev-0');
  ok(run(a.root, ['gate', '--attempt', a.id]));
  round(a, 'rev-1');
  if (accept) ok(run(a.root, ['accept', '--attempt', a.id]));
  return a;
}
const next = (a) => a.run.state(a.root, a.id).next;

// ---- a fake `codex`, for the roles the engine launches ----

const SID = '01a110b4-1637-7a42-b353-d0ad25e60000';
// A `codex` that runs a turn and ends (exit 0) without writing the closure file; its transcript's last reply is `reply`.
function fakeCodex(base, reply = 'done') {
  const bin = path.join(base, 'bin');
  const home = path.join(base, '.home');
  write(bin, 'codex', `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const prompt = fs.readFileSync(0, 'utf8');
const counter = ${JSON.stringify(path.join(base, 'counter'))};
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 0;
fs.writeFileSync(counter, String(n));
const sid = '${SID}'.slice(0, -4) + String(n).padStart(4, '0');
const file = path.join(${JSON.stringify(home)}, '.codex', 'sessions', '2026', '10', '08', 'rollout-test-' + sid + '.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
const at = new Date().toISOString(), line = (x) => JSON.stringify({ timestamp: at, ...x });
const user = (kinds, text) => line({ type: 'response_item', payload: { type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { content_item_kinds: kinds }, content: [{ type: 'input_text', text }] } });
fs.writeFileSync(file, [
  line({ type: 'session_meta', payload: { id: sid, timestamp: at, originator: 'codex_exec', source: 'exec', cwd: process.cwd() } }),
  user(['agents_md.instructions'], '# AGENTS.md instructions fixture'),
  user(['user.text'], prompt),
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ${JSON.stringify(reply)} }] } }),
].join('\\n') + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: sid }));
// A reviewer that writes its closure file and ends without recording it (FAKE_CLOSURE: the closure, reviewer filled in).
if (process.env.FAKE_CLOSURE) {
  const bundle = JSON.parse(fs.readFileSync(/Read (\\S+) and follow/.exec(prompt)[1], 'utf8'));
  if (bundle.reviewClosureFile) { fs.mkdirSync(path.dirname(bundle.reviewClosureFile), { recursive: true }); fs.writeFileSync(bundle.reviewClosureFile, JSON.stringify({ ...JSON.parse(process.env.FAKE_CLOSURE), reviewer: bundle.agent })); }
}
// A session that ends before it finishes (FAKE_EXIT: its exit code), after anything it wrote.
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
console.log(JSON.stringify({ type: 'turn.completed' }));
`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  return { PATH: bin + path.delimiter + process.env.PATH, WF_HOME: home };
}
const codexConfig = { classes: { review: { codex: { model: 'future-model', effort: 'max' } } } };

// Named failure (I-107): `wf criteria amend` on an accepted attempt added a criterion and left the acceptance standing. `wf resume`
// said "deliver" and `wf deliver` delivered, with the new criterion mapped to no evidence by any review.
test('I-107: an amendment that adds a criterion withdraws the acceptance; delivery waits for a fresh review that maps it', () => {
  const run = runner('0.7.4');
  const a = accepted(run, 'i107');
  const amended = ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', a.id]));
  const s = run.state(a.root, a.id);
  assert.equal(s.accepted, null, 'the acceptance is withdrawn');
  const refused = run(a.root, ['deliver', '--attempt', a.id]);
  assert.equal(refused.code, 75, 'a criterion no review mapped to evidence is not delivered');
  assert.match(refused.err, /review not accepted/);
  assert.equal(s.criteriaAmendments.at(-1).withdrewAcceptance, true);
  assert.match(amended.out, /acceptance withdrawn: C2 was added or changed after the review that was accepted/, 'the outcome is printed with the command, not as a warning');
  assert.doesNotMatch(s.next, /deliver: `wf deliver`/, 'resume no longer says to deliver');
  assert.match(s.next, /C2 was added or re-worded by an amendment[\s\S]*wf handoff reviewer --agent <new id>/);
  const accept = run(a.root, ['accept', '--attempt', a.id]);
  assert.equal(accept.code, 75);
  assert.match(accept.err, /criterion C2 is not mapped to evidence \(an amendment added or changed it after this review round was handed\)/);
  // The way on: a fresh reviewer on the same tree and its gate evidence maps every criterion.
  const bundle = round(a, 'rev-2', goodClosure('rev-2', { criteria: map('C1', 'C2') }));
  assert.equal(bundle.mode, 'delta', 'the first evidence review audited the whole change; this one verifies the criteria');
  assert.deepEqual(bundle.criteria.map((c) => c.id), ['C1', 'C2']);
  ok(run(a.root, ['accept', '--attempt', a.id]));
  assert.deepEqual(run.state(a.root, a.id).accepted.reviewer, 'rev-2');
  ok(run(a.root, ['deliver', '--attempt', a.id]));
});

// The same cause one step earlier: a criterion re-worded after the round that mapped it kept that mapping for `wf accept`.
test('I-107: a criterion re-worded after the last review round is not accepted on the evidence mapped to its earlier wording', () => {
  const run = runner('0.7.4');
  const a = accepted(run, 'i107-reworded', { accept: false });
  ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C1', text: 'a changes, and says so twice', uat: 'a shows the new text' }]), '--reason', 'reword C1', '--attempt', a.id]));
  assert.match(next(a), /C1 was added or re-worded by an amendment[\s\S]*hand to a fresh reviewer/);
  const refused = run(a.root, ['accept', '--attempt', a.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /criterion C1 was re-worded by an amendment after this review round was handed, so the round judged its earlier wording/);
  round(a, 'rev-2', goodClosure('rev-2', { criteria: map('C1') }));
  ok(run(a.root, ['accept', '--attempt', a.id]));
  // An amendment that only drops a criterion, or states an expectation, changes nothing the round judged.
  ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C1', text: 'a changes, and says so twice', uat: 'a shows the new text' }], {}), '--reason', 'same wording again', '--attempt', a.id]));
  assert.notEqual(run.state(a.root, a.id).accepted, null, 'an amendment that changes no criterion leaves the acceptance');
});

// D13: the engine that records an amendment decides; an amendment an earlier engine recorded keeps its acceptance when
// its ledger is folded again, and `wf resume` says what delivery would ship.
test('I-107 (D13): an amendment an engine before 0.7.4 recorded keeps its acceptance, is told what delivery would ship, and re-folds unchanged', () => {
  const old = runner('0.7.3');
  const a = accepted(old, 'i107-old');
  const amended = ok(old(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', a.id]));
  assert.match(amended.err, /this engine \(0\.7\.3\) leaves \S+ acceptance standing, and `wf deliver` would ship C2 with no review having mapped it to evidence/);
  const s = old.state(a.root, a.id);
  assert.notEqual(s.accepted, null);
  assert.equal(s.criteriaAmendments.at(-1).withdrewAcceptance, undefined, 'the older attempt\'s amendment carries no flag');
  assert.match(s.next, /deliver: `wf deliver` -- WARNING: C2 was added or re-worded after the acceptance and no review mapped it to evidence \(the amendment was recorded before 0.7.4/);
  // A newer engine reading the same ledger folds the same state: nothing is broken retroactively.
  const again = ok(wf(a.root, ['resume', '--attempt', a.id, '--json'])).json();
  assert.notEqual(again.accepted, null);
  assert.equal(again.phase, 'accepted');
  // The earlier behaviour stays for it: delivery is not refused (the warning is the engine's whole answer).
  ok(old(a.root, ['deliver', '--attempt', a.id]));
});

// D13: the hole is closed for attempts already in flight. An attempt admitted and accepted under 0.7.3 and amended by
// 0.7.4 loses its acceptance like a new one: every delivered criterion was always to be mapped to evidence.
test('I-107 (D13): an attempt admitted before 0.7.4 and amended by 0.7.4 has its acceptance withdrawn', () => {
  const old = runner('0.7.3');
  const a = accepted(old, 'i107-inflight');
  const now = runner('0.7.4');
  const amended = ok(now(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', a.id]));
  assert.match(amended.out + amended.err, /acceptance withdrawn/);
  const s = now.state(a.root, a.id);
  assert.equal(s.accepted, null);
  assert.equal(s.criteriaAmendments.at(-1).engine, '0.7.4');
  assert.equal(now(a.root, ['deliver', '--attempt', a.id], { ownerSilent: true }).code, 75, 'delivery waits for a review that maps C2');
});

// Independent review of 0.7.4: a criterion dropped and added again under the same id before acceptance was accepted on the
// evidence mapped to its earlier wording, because it was compared by id only.
test('I-107: a criterion dropped and added again under the same id is not accepted on the evidence mapped to its earlier wording', () => {
  const run = runner('0.7.4');
  const a = started(run, 'i107-readd');
  ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', a.id]));
  round(a, 'rev-0', goodClosure('rev-0', { criteria: map('C1', 'C2') }));
  ok(run(a.root, ['gate', '--attempt', a.id]));
  round(a, 'rev-1', goodClosure('rev-1', { criteria: map('C1', 'C2') }));
  ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', dropped: true, reason: 'not needed' }], { impact: undefined }), '--reason', 'drop C2', '--attempt', a.id]));
  ok(run(a.root, ['criteria', 'amend', '--file', amendFile(a.base, [{ id: 'C2', text: 'something else entirely holds', uat: 'other' }]), '--reason', 'C2 again', '--attempt', a.id]));
  const refused = run(a.root, ['accept', '--attempt', a.id], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /criterion C2 was re-worded by an amendment after this review round was handed/);
});

// Independent review of 0.7.4 (high): a batch delivered a member whose acceptance an amendment had withdrawn after it
// joined, and the batch's own review maps only the batch criteria, so the member's new criterion shipped unmapped.
test('I-107: a batch is not delivered while a member\'s acceptance is withdrawn', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('i107-batch', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-40', change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-41', change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['criteria', 'amend', '--file', amendFile(base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', m1.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id]));
  const refused = wf(root, ['deliver', '--attempt', b.id], { ownerSilent: true });
  assert.equal(refused.code, 75);
  assert.match(refused.err, new RegExp(`batch member ${m1.id.replace('.', '\\.')} is not accepted: its acceptance was withdrawn after it joined`));
});

// ---- I-114 ----

// Named failure (I-114): `wf plan --from-agent` refused a transcript with no fenced YAML block, and YAML that does not parse,
// outside the block that records a refused plan, so the next planner's bundle carried no word of it.
test('I-114: a planner output that cannot be read as a plan is recorded with the refusal and handed to the next planner', () => {
  for (const [reply, error] of [['I looked at the code and have no plan yet.', /has no fenced YAML block/], ['```yaml\ncriteria: [a, b\n```', /YAML does not parse|does not parse/]]) {
    const p = singleRepoProject('i114', { gate: { steps }, ...codexConfig });
    const env = fakeCodex(p.base, reply);
    const run = (args) => wf(p.root, args, { env });
    const id = ok(run(['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
    ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
    ok(run(['handoff', 'run', '--agent', 'p', '--attempt', id]));
    const refused = run(['plan', '--from-agent', 'p', '--attempt', id]);
    assert.equal(refused.code, 75);
    assert.match(refused.err, error);
    assert.equal(loadState(p.root, id).planRefusals.length, 1, 'the refusal is recorded');
    // The owner's mistakes are not the planner's: an agent that was never handed the planning records nothing.
    assert.equal(run(['plan', '--from-agent', 'nobody', '--attempt', id]).code, 75);
    assert.equal(loadState(p.root, id).planRefusals.length, 1);
    const next = ok(run(['handoff', 'planner', '--agent', 'p2', '--runtime', 'codex', '--attempt', id]));
    const bundle = JSON.parse(fs.readFileSync(next.out.match(/bundle: (\S+)/)[1], 'utf8'));
    assert.equal(bundle.priorPlanRefusals.refusals.length, 1);
    assert.match(bundle.priorPlanRefusals.refusals[0].error, error);
    assert.equal(bundle.priorPlanRefusals.refusals[0].agent, 'p');
    assert.ok(fs.existsSync(bundle.priorPlanRefusals.refusals[0].report), 'the report is kept');
  }
});

test('I-114: a plan file that does not parse is recorded with the refusal too', () => {
  const p = singleRepoProject('i114-file', { gate: { steps } });
  const id = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  const bad = path.join(p.base, 'plan.yaml');
  fs.writeFileSync(bad, 'criteria: [a, b\n');
  assert.notEqual(wf(p.root, ['plan', '--file', bad, '--attempt', id]).code, 0);
  assert.notEqual(wf(p.root, ['plan', '--file', path.join(p.base, 'missing.yaml'), '--attempt', id]).code, 0);
  const s = loadState(p.root, id);
  assert.equal(s.planRefusals.length, 1, 'a file that cannot be opened is the owner\'s mistake and is not recorded');
  assert.equal(fs.readFileSync(s.planRefusals[0].report, 'utf8'), 'criteria: [a, b\n');
  const bundle = JSON.parse(fs.readFileSync(ok(wf(p.root, ['handoff', 'planner', '--agent', 'p2', '--attempt', id])).out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.equal(bundle.priorPlanRefusals.refusals.length, 1);
});

// ---- I-109 ----

const rules = { review: { rules: [{ id: 'api', read: ['docs/api.md'] }] } };
const ruleFiles = { 'docs/api.md': '# API rules\nErrors are typed.\n' };

// Named failure (I-109): the rule copies (`rules/<sha>-<doc>`) were written into the evidence while the reviewer bundle was being
// built, before the handoff was recorded and outside its transaction. A `wf status` run in between was refused with "extra file
// (not written by wf)", and a handoff refused after that point left the copy behind.
test('I-109: the rule copies of a reviewer bundle are written by the transaction that records the handoff, and by no refused handoff', () => {
  const p = singleRepoProject('i109-refused', { gate: { steps }, ...rules, invariants: 'missing-invariants.md' }, ruleFiles);
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const refused = wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /review readiness refused[\s\S]*invariants: required document unavailable/);
  assert.equal(fs.existsSync(path.join(p.root, '.wf-evidence', 'attempts', e.id, 'rules')), false, 'a handoff that was refused wrote nothing into the evidence');
  assert.deepEqual(verifyAttempt(p.root, e.id), []);
  // Once the document exists the handoff goes through, and the copy is recorded with it.
  write(p.root, '.workflow/missing-invariants.md', '# Invariants\n');
  const handed = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const bundle = JSON.parse(fs.readFileSync(handed.out.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.equal(bundle.rules.length, 1);
  assert.match(fs.readFileSync(bundle.rules[0].read[0], 'utf8'), /Errors are typed/);
  assert.deepEqual(verifyAttempt(p.root, e.id), []);
});

// Every evidence file a command writes is written while the attempt's evidence transaction is held: `lockHeldAt` runs the real
// command in a child process and records, for each file created under the folders named, whether the lock file existed then.
function lockHeldAt(root, id, argv, folders) {
  const script = path.join(tmp('probe'), 'probe.mjs');
  const out = `${script}.json`;
  write(path.dirname(script), 'probe.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const [,, root, id, out, folders, ...argv] = process.argv;
const lock = path.join(fs.realpathSync(root), '.wf-worktrees', '_transactions', id + '.lock');
const watched = (p) => folders.split('|').some((f) => p.includes('/' + f + '/'));
const seen = [];
const open = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (typeof p === 'string' && watched(p) && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) seen.push({ file: path.basename(p), locked: fs.existsSync(lock) });
  return open.call(this, p, flags, ...rest);
};
const { main } = await import(${JSON.stringify(path.join(REPO, 'engine', 'cli.mjs'))});
const code = await main(argv);
fs.writeFileSync(out, JSON.stringify({ code, seen }));
`);
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const r = spawnSync(process.execPath, [script, root, id, out, folders, ...argv], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.code, 0, r.stderr);
  return result.seen;
}

test('I-109: the files a reviewer handoff, a plan and an amendment write into the evidence are written inside its transaction', () => {
  const p = singleRepoProject('i109-lock', { gate: { steps }, ...rules }, ruleFiles);
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const planned = lockHeldAt(p.root, e.id, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id], 'plans');
  assert.ok(planned.some((w) => /plan-1\.raw/.test(w.file)), 'the raw plan was written');
  assert.deepEqual(planned.filter((w) => !w.locked), [], 'every plan file is written while the transaction is held');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const amended = lockHeldAt(p.root, e.id, ['criteria', 'amend', '--file', amendFile(p.base, [{ id: 'C2', text: 'a second thing holds', uat: 'second' }]), '--reason', 'add C2', '--attempt', e.id], 'plans');
  assert.ok(amended.some((w) => /amend-1\.raw/.test(w.file)));
  assert.deepEqual(amended.filter((w) => !w.locked), []);
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  const handed = lockHeldAt(p.root, e.id, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id, '--runtime', 'claude'], 'rules');
  assert.ok(handed.some((w) => /api\.md/.test(w.file)), 'the rule copy was written');
  assert.deepEqual(handed.filter((w) => !w.locked), [], 'the rule copy is written while the transaction is held');
  assert.deepEqual(verifyAttempt(p.root, e.id), []);
});
// ---- I-69 ----

// Named failure (I-69): two engine-launched reviewers completed (exit 0) before whole-change review and wrote no closure. The
// owner read "record its closure through the handed reviewer", could not run `wf handoff run` again (a handoff launches once),
// and nothing said that a round with no recorded closure is not an audit.
// 0.7.11, named failure (audit of 51 attempts): three launched reviewers ended with their closure written and not recorded,
// and fresh reviewers judged the same tree again. The engine records the closure the reviewer wrote, with every check.
test('a launched reviewer that wrote its closure and did not record it has it recorded by the engine', () => {
  const p = singleRepoProject('i69-salvage', { gate: { steps }, ...codexConfig });
  const env = { ...fakeCodex(p.base), FAKE_CLOSURE: JSON.stringify(goodClosure('x')) };
  const run = (args, opts = {}) => wf(p.root, args, { env, ...opts });
  const id = ok(run(['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
  ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  ok(run(['plan', '--file', criteriaFile(p.base), '--attempt', id]));
  ok(run(['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(loadState(p.root, id).repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(run(['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  const launched = ok(run(['handoff', 'run', '--agent', 'r', '--attempt', id]));
  assert.match(launched.err, /reviewer r ended without recording its closure; the engine recorded the closure it wrote/);
  assert.doesNotMatch(launched.err, /completed with no closure recorded/);
  assert.deepEqual(loadState(p.root, id).reviews.map((r) => [r.reviewer, r.recordedBy]), [['r', 'engine']], 'recorded by the engine, and said so');
});

// I-152, named failure (audit of role launches): a reviewer that ran 12 hours on a 1,303-file change and one stopped after
// 94 minutes kept their findings only in their transcripts. What a reviewer wrote into its closure file is kept as a
// partial round: its findings count, and it is neither an audit nor an acceptance.
test('I-152: a launched reviewer that dies after writing findings has them kept as a partial round', () => {
  const p = singleRepoProject('i152-partial', { gate: { steps }, ...codexConfig });
  const found = { ...goodClosure('x'), findings: [{ id: 'F1', severity: 'medium', summary: 'the total is off by one', status: 'open', evidence: 'src/a.txt:1', criterion: 'C1' }] };
  const env = { ...fakeCodex(p.base), FAKE_CLOSURE: JSON.stringify(found), FAKE_EXIT: '1' };
  const run = (args, opts = {}) => wf(p.root, args, { env, ...opts });
  const id = ok(run(['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
  ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  ok(run(['plan', '--file', criteriaFile(p.base), '--attempt', id]));
  ok(run(['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(loadState(p.root, id).repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(run(['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  const launched = run(['handoff', 'run', '--agent', 'r', '--attempt', id]);
  assert.match(launched.err, /reviewer r did not finish; the engine kept the 1 finding\(s\) it had written, as a partial round/);
  const state = loadState(p.root, id);
  assert.deepEqual(state.reviews.map((r) => [r.reviewer, r.recordedBy, r.partial, r.covered]), [['r', 'engine', true, false]]);
  assert.deepEqual(state.reviews[0].closure.findings.map((f) => f.id), ['F1'], 'the finding it wrote is kept');
  assert.match(state.reviews[0].closure.notReached.join(' '), /ended before the reviewer finished \(/);
  const accept = wf(p.root, ['accept', '--attempt', id], { env });
  assert.notEqual(accept.code, 0);
  assert.match(accept.err, /ended before its reviewer finished; its findings are kept/);
  const next = ok(run(['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id, '--json'])).json();
  assert.equal(next.mode ?? JSON.parse(fs.readFileSync(next.bundle, 'utf8')).mode, 'full', 'the next round is a full one');
});

// Independent review of 0.7.12: a delta reviewer stopped before it gave the prior findings their verdicts had its findings
// refused, and after a kept partial round the next delta started at the partial round's tree, so what it never reached
// was handed to no reviewer.
test('I-152: a delta reviewer that dies before its verdicts keeps its findings, and the next delta starts where the last finished round did', () => {
  const p = singleRepoProject('i152-delta', { gate: { steps }, ...codexConfig });
  const base = fakeCodex(p.base);
  const run = (args, env = {}) => wf(p.root, args, { env: { ...base, ...env } });
  const id = ok(run(['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
  ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  ok(run(['plan', '--file', criteriaFile(p.base), '--attempt', id]));
  const wt = loadState(p.root, id).repos.app.worktree;
  ok(run(['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(wt, { 'src/a.txt': 'changed\n' });
  ok(run(['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r1', '--attempt', id]));
  ok(run(['review', '--closure', closureFile(p.base, { ...goodClosure('r1'), findings: [{ id: 'F1', severity: 'high', summary: 'wrong total', status: 'open', evidence: 'src/a.txt:1', criterion: 'C1' }] }), '--attempt', id]));
  const judged = loadState(p.root, id).reviews[0].tree;
  ok(run(['handoff', 'implementer', '--agent', 'i2', '--attempt', id]));
  commitIn(wt, { 'src/a.txt': 'fixed\n', 'src/b.txt': 'new code\n' });
  ok(run(['handoff', 'close', '--agent', 'i2', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id]));
  const died = { ...goodClosure('x'), criteria: [], findings: [{ id: 'F1', severity: 'medium', summary: 'b is wrong', status: 'open', evidence: 'src/b.txt:1', criterion: 'C1' }] };
  const launched = run(['handoff', 'run', '--agent', 'r2', '--attempt', id], { FAKE_CLOSURE: JSON.stringify(died), FAKE_EXIT: '1' });
  assert.match(launched.err, /kept the 1 finding\(s\) it had written, as a partial round/);
  const kept = loadState(p.root, id).reviews.find((r) => r.reviewer === 'r2');
  assert.equal(kept.partial, true);
  assert.match(kept.closure.notReached.join(' '), /not reached before it ended: verdicts on the open finding\(s\) r1:F1/);
  ok(run(['handoff', 'implementer', '--agent', 'i3', '--attempt', id]));
  commitIn(wt, { 'src/b.txt': 'b fixed\n' });
  ok(run(['handoff', 'close', '--agent', 'i3', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r3', '--runtime', 'codex', '--attempt', id]));
  const next = loadState(p.root, id).handoffs.findLast((h) => h.agent === 'r3');
  assert.equal(next.mode, 'delta');
  assert.deepEqual(next.deltaFrom, judged, 'the delta starts at the tree the last finished round judged, not the partial one');
});

test('I-69: a launched reviewer that ends with no closure leaves the owner the real routes, and the round is not an audit', () => {
  const p = singleRepoProject('i69-guidance', { gate: { steps }, ...codexConfig });
  const env = fakeCodex(p.base);
  const run = (args, opts = {}) => wf(p.root, args, { env, ...opts });
  const id = ok(run(['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json().id;
  ok(run(['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  ok(run(['plan', '--file', criteriaFile(p.base), '--attempt', id]));
  ok(run(['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(loadState(p.root, id).repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(run(['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(run(['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  const launched = ok(run(['handoff', 'run', '--agent', 'r', '--attempt', id]));
  assert.match(launched.err, /reviewer r completed with no closure recorded[\s\S]*not an audit and counts toward nothing, so the next reviewer is handed a full round/);
  assert.match(launched.err, /wf handoff reviewer --agent <new id> --attempt .*wf handoff run --agent <new id> --attempt /);
  const resume = ok(run(['resume', '--attempt', id])).out;
  assert.match(resume, /reviewer r completed with no closure recorded[\s\S]*It wrote no closure file\. Otherwise hand a fresh reviewer with a new id: `wf handoff reviewer --agent <new id>/);
  assert.doesNotMatch(resume, /record its closure through the handed reviewer/);
  // A handoff launches once; the refusal names the way on.
  const again = run(['handoff', 'run', '--agent', 'r', '--attempt', id]);
  assert.equal(again.code, 75);
  assert.match(again.err, /already launched[\s\S]*`wf handoff reviewer --agent <new id> --attempt .*` hands a fresh reviewer, then `wf handoff run --agent <new id>/);
  // The way on: the unrecorded round did not count, so the fresh reviewer is the attempt's full audit.
  const fresh = ok(run(['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id]));
  assert.equal(JSON.parse(fs.readFileSync(fresh.out.match(/^Read (\S+)/m)[1], 'utf8')).mode, 'full');
});

// Named failure (I-69): a closure that names scope the reviewer did not reach (`notReached`) was recorded as the attempt's one
// full audit, so every later round was a delta, and no owner, reviewer or delivered comment ever saw what was not looked at.
test('I-69: a closure with unreached scope is not the full audit, and the scope is shown to the owner, the next reviewer, the export and the delivered comment', () => {
  const run = runner('0.7.4');
  const a = started(run, 'i69-partial');
  const partial = goodClosure('rev-0', { notReached: ['the export module', 'tests under src/legacy'] });
  round(a, 'rev-0', partial);
  // The next round is a full audit again, handed what the last one did not reach.
  const again = round(a, 'rev-1', goodClosure('rev-1'));
  assert.equal(again.mode, 'full', 'a closure with unreached scope was not the full audit');
  const sig = ok(run(a.root, ['signals', '--attempt', a.id, '--json'])).json();
  assert.deepEqual(sig.rounds[0].notReached, ['the export module', 'tests under src/legacy']);
  assert.match(ok(run(a.root, ['resume', '--attempt', a.id])).out, /review round 1 \(rev-0\):.*did not reach: the export module; tests under src\/legacy/);
  assert.deepEqual(again.unreachedBefore.rounds.map((r) => [r.reviewer, r.notReached]), [['rev-0', ['the export module', 'tests under src/legacy']]]);
  assert.match(again.unreachedBefore.note, /none of these rounds counted as an audit[\s\S]*narrows nothing/);
  // A complete full audit covers the change: the next round is a delta and carries no list.
  commitIn(a.wt, { 'src/a.txt': 'c\n' });
  const third = ok(run(a.root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', a.id]));
  const bundle = JSON.parse(fs.readFileSync(third.out.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.equal(bundle.mode, 'delta');
  assert.equal(bundle.unreachedBefore, undefined);
  ok(run(a.root, ['review', '--closure', closureFile(a.base, goodClosure('rev-2', { criteria: [] })), '--attempt', a.id]));
  // The evidence review that is accepted names what it did not reach: accepted as it is, and the delivered comment says so.
  ok(run(a.root, ['gate', '--attempt', a.id]));
  round(a, 'rev-3', goodClosure('rev-3', { notReached: ['the dark theme'] }));
  ok(run(a.root, ['accept', '--attempt', a.id]));
  assert.match(knownLimits(loadState(a.root, a.id)), /- The final review left 1 item\(s\) unchecked; the delivery record lists them\./);
  ok(run(a.root, ['export', '--attempt', a.id]));
  assert.match(fs.readFileSync(path.join(a.root, '.wf-evidence', 'attempts', a.id, 'export', 'attempt.html'), 'utf8'), /not reached by this round: the dark theme/);
});

// D7: counting such a round as the audit changes what the next handoff of an attempt already past it owes; the list is shown
// for every attempt, the round count follows the admission version.
test('I-69 (D7): an attempt admitted before 0.7.4 still counts the partial round, and is shown what it did not reach', () => {
  const old = runner('0.7.3');
  const a = started(old, 'i69-old');
  round(a, 'rev-0', goodClosure('rev-0', { notReached: ['the export module'] }));
  const second = round(a, 'rev-1');
  assert.equal(second.mode, 'delta', 'the earlier count is kept for an attempt admitted earlier');
  assert.deepEqual(second.unreachedBefore.rounds.map((r) => r.notReached), [['the export module']]);
});

// ---- I-79, I-89 ----

const CHANGED = 'l1\nL2\nl3\nl4\nl5\nl6\n';
function twoBlocking(name) {
  const a = started(runner('0.7.4'), name, { files: { 'src/a.txt': 'l1\nl2\nl3\nl4\nl5\nl6\n' } });
  commitIn(a.wt, { 'src/a.txt': CHANGED }, 'change');
  const finding = (id) => ({ id, severity: 'major', summary: `${id}: a raw label`, status: 'open', evidence: 'src/a.txt:2', criterion: 'C1', family: 'raw-labels' });
  const bundle = round(a, 'r1', goodClosure('r1', { findings: [finding('F1'), finding('F2')] }));
  assert.ok(bundle);
  a.sweep = (n) => { const f = path.join(a.base, `sweep-${n}.json`); fs.writeFileSync(f, JSON.stringify({ sweeps: [{ family: 'raw-labels', why: `pass ${n}`, query: { pattern: 'l', kind: 'literal', paths: ['src/**'] } }] })); return f; };
  a.fix = (agent, n) => a.run(a.root, ['handoff', 'implementer', '--agent', agent, '--attempt', a.id, ...(n ? ['--sweep', a.sweep(n)] : [])]);
  return a;
}

// Named failure (I-79, I-89): a repair handoff stopped before its implementer ran still spent the sweeps it was handed, so the
// replacement's corrected `--sweep` was refused with "no open review finding is owed a sweep" (false), and the next reviewer was
// shown the stopped handoff's sweep as unanswered.
test('I-79/I-89: a repair handoff stopped before it ran does not spend its sweeps; the replacement\'s corrected sweep is handed and the reviewer sees only that one', () => {
  const a = twoBlocking('i79');
  ok(a.fix('impl-2', 1));
  ok(a.run(a.root, ['handoff', 'close', '--agent', 'impl-2', '--outcome', 'stopped', '--attempt', a.id]));
  const replacement = a.fix('impl-3', 2);
  assert.equal(replacement.code, 0, replacement.err);
  const bundle = JSON.parse(fs.readFileSync(replacement.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.sweep.map((s) => [s.id, s.family, s.findings]), [['S2', 'raw-labels', ['r1:F1', 'r1:F2']]]);
  commitIn(a.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') }, 'repair');
  ok(a.run(a.root, ['handoff', 'close', '--agent', 'impl-3', '--attempt', a.id]));
  const handed = ok(a.run(a.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', a.id]));
  const forReviewer = JSON.parse(fs.readFileSync(handed.out.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.deepEqual(forReviewer.sweeps.map((s) => s.id), ['S2'], 'the stopped handoff\'s sweep is not an unanswered sweep of this pass');
});

test('I-79/I-89: a handoff that ran and was closed done still spends the sweep it was handed', () => {
  const a = twoBlocking('i79-done');
  ok(a.fix('impl-2', 1));
  commitIn(a.wt, { 'src/a.txt': CHANGED.replace('l5', 'L5') }, 'repair');
  ok(a.run(a.root, ['handoff', 'close', '--agent', 'impl-2', '--attempt', a.id]));
  const second = a.fix('impl-3', 2);
  assert.equal(second.code, 75);
  assert.match(second.err, /no open review finding is owed a sweep/);
});

// ---- I-115 ----

// Named failure (I-115): on an attempt admitted before 0.7.0, one implementer handed with --work W1 and a later one handed without
// it left W2 "not started" for ever (0.7.0 records what an unscoped handoff covers; the earlier ones recorded nothing).
test('I-115: on a legacy attempt, an implementer handed without --work covers every item no scoped handoff names, and items added later stay unstarted', () => {
  const old = runner('0.6.9');
  const p = singleRepoProject('i115', { gate: { steps } });
  const work = (...ids) => ids.map((id) => ({ id, criteria: ['C1'], repos: ['app'], class: 'light', why: 'fixture' }));
  const e = ok(old(p.root, ['entry', '--item', 'ENG-1', '--owner', 'owner-1', '--json'])).json();
  ok(old(p.root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', e.id, '--owner', 'owner-1']));
  const planFile = path.join(p.base, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(planDoc({ plan: 'change a', criteria: [{ id: 'C1', text: 'a changes', uat: false }], work: work('W1', 'W2', 'W3') })));
  ok(old(p.root, ['plan', '--file', planFile, '--attempt', e.id, '--owner', 'owner-1']));
  ok(old(p.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i1', '--attempt', e.id]));
  assert.match(old.state(p.root, e.id).next, /start the implementers for the open work items[\s\S]*W2[\s\S]*W3/);
  ok(old(p.root, ['handoff', 'implementer', '--agent', 'i2', '--attempt', e.id]));
  assert.deepEqual(old.state(p.root, e.id).handoffs.at(-1).covers, undefined, 'a legacy handoff recorded no cover');
  assert.doesNotMatch(old.state(p.root, e.id).next, /start the implementers for the open work items/, 'W2 and W3 are covered by the unscoped implementer');
  // A work item an amendment adds after that handoff has no implementer yet.
  const amendment = amendFile(p.base, [{ id: 'C1', text: 'a changes', uat: false }], { work: work('W1', 'W2', 'W3', 'W4') });
  ok(old(p.root, ['criteria', 'amend', '--file', amendment, '--reason', 'W4 joins', '--attempt', e.id]));
  const after = old.state(p.root, e.id).next;
  assert.match(after, /start the implementers for the open work items[\s\S]*W4/);
  assert.doesNotMatch(after, /W2 class|W3 class/);
});

