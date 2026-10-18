// The final review of 0.7.0 (two independent reviewers, probes P1-P10): the loop was moved, not removed. A full blind
// evidence review ran again after every fix; "caused by this round" decided both whether a round opens and whether a defect
// may leave the delivery, so a major defect the attempt wrote in an earlier round could be ticketed unasked; batches sat
// outside the round escalation and re-audited every member; rounds that were handed and never recorded did not count; the
// texts agents read named phrases and steps the engine no longer has. Each test here is one of those, now held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, wf } from './helpers.mjs';
import { stampClosure } from '../engine/review-policy.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const CHANGED = LINES.replace('l2', 'L2').replace('l5', 'L5');

function project(name) {
  const p = singleRepoProject(name, { gate: { steps } }, { 'src/a.txt': LINES, 'src/old.txt': 'o1\no2\no3\n' });
  const e = ok(wf(p.root, ['entry', '--item', 'FR-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': CHANGED });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  return { ...p, id: e.id, wt };
}
const hand = (p, agent, opts) => {
  const r = ok(wf(p.root, ['handoff', 'reviewer', '--agent', agent, '--attempt', p.id], opts));
  return JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)[1], 'utf8'));
};
const record = (p, closure) => wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]);
const finding = (id, extra = {}) => ({ id, severity: 'minor', summary: `${id} is wrong`, status: 'open', evidence: 'src/old.txt:3', ...extra });
// The check id of each refusal a command printed (D17: `leave:blocks`, `leave:medium-high`), as the refusal log recorded it.
const refusals = (p) => fs.readFileSync(path.join(p.root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const capture = (p, n) => {
  const f = path.join(p.base, `ticket-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({ issue: { identifier: `ENG-${n}`, title: 'follow-up', url: `https://tracker.example.test/ENG-${n}` } }));
  return f;
};

test('the evidence review after a fix is a delta: a finding on code earlier rounds judged is an observation, and acceptance is reachable (P1)', () => {
  const p = project('fr-p1');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev1 = hand(p, 'r2');
  assert.deepEqual([ev1.mode, ev1.round], ['full', 'evidence-review'], 'the first evidence review is the second (and last) full audit');
  ok(record(p, goodClosure('r2', { findings: [finding('F1', { severity: 'major', evidence: 'src/a.txt:2 label wording' })] })));
  assert.equal(state(p.root, p.id).review.closure.findings[0].classified.blocks, true, 'a full round still blocks on a line the attempt changed');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('L2', 'L2!') }, 'fix F1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', p.id]));
  const d = hand(p, 'r3');
  assert.equal(d.mode, 'delta');
  ok(record(p, goodClosure('r3', { criteria: [], priorFindings: [{ round: 'r2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2' }] })));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev2 = hand(p, 'r4');
  assert.deepEqual([ev2.mode, ev2.round], ['delta', 'evidence-review'], 'a fix never restarts a full audit of the whole change');
  assert.ok(ev2.gate.passedOnThisTree && Array.isArray(ev2.openFindings) && ev2.delta, 'the evidence delta carries the gate evidence, the open findings and the diff');
  assert.match(ev2.instructions, /evidence review of a tree a gate passed on, as a delta/);
  // Line 5 changed at admission and was judged by three reviewers: a fourth reviewer's finding there is an observation.
  ok(record(p, goodClosure('r4', { findings: [finding('F2', { evidence: 'src/a.txt:5 another wording nit' })] })));
  const f2 = state(p.root, p.id).review.closure.findings[0].classified;
  assert.deepEqual([f2.blocks, f2.mode], [false, 'delta']);
  ok(wf(p.root, ['accept', '--attempt', p.id]));
  // Delivery waits for the observation; a minor (low) one is ticketed only with the person's answer (D17, D18), asked once.
  assert.match(wf(p.root, ['deliver', '--attempt', p.id]).err, /observation/);
  assert.equal(wf(p.root, ['scope', 'ticket', '--finding', 'r4:F2', '--capture', capture(p, 1), '--attempt', p.id], { ownerSilent: true }).code, 75, 'the person is asked for a low-severity follow-up');
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r4:F2', '--capture', capture(p, 1), '--attempt', p.id]));
  assert.deepEqual((state(p.root, p.id).decisions ?? []).map((d) => [d.kind, d.key, d.approved?.choice]), [['move-out-of-batch', 'leave:r4:F2', 'let it leave']], 'one decision, the person\'s answer');
});

test('what leaves the delivery follows the person\'s rule (D17): a major defect the attempt wrote and a medium one are refused whatever the reason, a minor one needs the person\'s answer to its own question (P9)', () => {
  const p = project('fr-p9');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1')));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('l3', 'L3') });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', p.id]));
  hand(p, 'r2');
  ok(record(p, goodClosure('r2', { criteria: [], findings: [
    finding('F1', { severity: 'major', summary: 'the label this ticket wrote is wrong', evidence: 'src/a.txt:5' }),
    finding('F2', { severity: 'medium', evidence: 'src/old.txt:1' }),
    finding('F3', { severity: 'nit', evidence: 'src/old.txt:2' }),
  ] })));
  const s = state(p.root, p.id);
  assert.deepEqual(s.review.closure.findings.map((f) => [f.id, f.classified.blocks, f.classified.placement]), [['F1', false, 'high'], ['F2', false, 'medium'], ['F3', false, 'low']], 'none opens a round; each has a placement');
  const ticket = (refs, n, extra = []) => wf(p.root, ['scope', 'ticket', '--finding', refs, '--capture', capture(p, n), ...extra, '--attempt', p.id], { ownerSilent: true });
  // A major (high) or a medium defect is fixed here: refused with its own check id, with or without a reason, and nothing is
  // put to the person. A low one named together with it does not leave either, the command being refused as a whole.
  const major = ticket('r2:F1', 2);
  assert.equal(major.code, 75);
  assert.match(major.err, /r2:F1 \(high, rated major\)/);
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  const medium = ticket('r2:F2', 3, ['--reason', 'the export page is redesigned next sprint']);
  assert.equal(medium.code, 75);
  assert.match(medium.err, /r2:F2 \(medium\)/);
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  const together = ticket('r2:F1,r2:F2,r2:F3', 4);
  assert.match(together.err, /r2:F1 \(high, rated major\), r2:F2 \(medium\)/);
  assert.equal(refusals(p).at(-1).id, 'leave:medium-high');
  assert.deepEqual(state(p.root, p.id).decisions ?? [], [], 'nothing was put to the person');
  assert.deepEqual(state(p.root, p.id).scopeDecisions ?? [], [], 'nothing left');
  // A minor one is the person's answer to a question of its own, asked once; the reason travels with the ticket.
  const low = ticket('r2:F3', 5, ['--reason', 'the export page is redesigned next sprint']);
  assert.equal(low.code, 75);
  assert.equal(refusals(p).at(-1).id, 'leave:ask');
  assert.match(low.err, /A1  header "r2:F3"/);
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r2:F3', '--capture', capture(p, 5), '--reason', 'the export page is redesigned next sprint', '--attempt', p.id]));
  const t = state(p.root, p.id).scopeDecisions.at(-1);
  assert.deepEqual([t.keys, t.reason, t.placement, t.decisions, t.decisionFor], [['r2:F3'], 'the export page is redesigned next sprint', { 'r2:F3': 'low' }, ['A1'], { 'r2:F3': 'A1' }]);
  assert.equal(t.decision, undefined, 'one decision per item, not one for the event');
  assert.ok(state(p.root, p.id).decisions[0].spent, 'the approval is spent by the ticket');
});

test('an observation the attempt fixed is settled by its commit; a blocking finding is refused; a commit that does not touch the cited file is recorded with that fact', () => {
  const p = project('fr-fixed');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F1', { evidence: 'src/old.txt:2 typo' }), finding('F2', { severity: 'major', evidence: 'src/a.txt:2 broken' })] })));
  const s = state(p.root, p.id);
  assert.deepEqual(s.review.closure.findings.map((f) => f.classified.blocks), [false, true]);
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': CHANGED.replace('L2', 'L2 fixed') }, 'fix F2');
  const other = sh(p.wt, 'git rev-parse HEAD');
  commitIn(p.wt, { 'src/old.txt': 'o1\no2 fixed\no3\n' }, 'fix F1');
  const fix = sh(p.wt, 'git rev-parse HEAD');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i', '--attempt', p.id]));
  assert.match(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F2', '--commit', fix, '--attempt', p.id]).err, /blocks: a review round verifies its fix/);
  // A fix may live in another file than the one cited (refusal audit of 0.7.0): recorded, with that fact, for the next reviewer.
  const elsewhere = ok(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', other, '--attempt', p.id]));
  assert.match(elsewhere.out, /the commit does not change the file r1:F1 cites/);
  assert.deepEqual(state(p.root, p.id).scopeDecisions.at(-1).notInCitedFile, ['r1:F1']);
  assert.match(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', fix, '--attempt', p.id]).err, /already went elsewhere/);
  const d = hand(p, 'r2');
  assert.deepEqual(d.openFindings.find((f) => f.id === 'F1').claimedFixed.commit.slice(0, 10), other.slice(0, 10), 'the next reviewer is handed the claim to verify');
});

test('every reviewer sees what left the delivery (P4)', () => {
  const p = project('fr-p4');
  hand(p, 'r1');
  ok(record(p, goodClosure('r1', { findings: [finding('F9', { summary: 'export totals sum one page', evidence: 'src/old.txt:3' })] })));
  ok(wf(p.root, ['scope', 'ticket', '--finding', 'r1:F9', '--capture', capture(p, 9), '--attempt', p.id]));
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = hand(p, 'r2');
  assert.deepEqual(ev.followUps.map((f) => [f.ref, f.went, f.ticket, f.summary]), [['r1:F9', 'ticketed', 'https://tracker.example.test/ENG-9', 'export totals sum one page']]);
});

test('review rounds handed and never recorded count toward the person\'s escalation (P6)', () => {
  const p = project('fr-p6');
  for (let i = 0; i < 10; i++) {
    commitIn(p.wt, { 'src/a.txt': `${CHANGED}x${i}\n` });
    ok(wf(p.root, ['handoff', 'reviewer', '--agent', `dead-${i}`, '--attempt', p.id]));
  }
  const sig = ok(wf(p.root, ['signals', '--attempt', p.id, '--json'])).json();
  assert.deepEqual([sig.roundsRecorded, sig.roundsHanded], [0, 10]);
  assert.equal(sig.strategy.escalation.firing.key, 'rounds:10');
  const next = wf(p.root, ['handoff', 'reviewer', '--agent', 'r-11', '--attempt', p.id], { ownerSilent: true });
  assert.equal(next.code, 75);
  assert.match(next.err, /10 review rounds handed/);
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /10 handed \(10 never recorded\)/);
});

test('in a batch, a line a member wrote does not open a round in the batch\'s full review; a line the batch wrote does (P7)', () => {
  const dir = tmp('fr-batch');
  const wt = path.join(dir, 'app');
  makeRepo(wt, { 'a.txt': LINES });
  const base = sh(wt, 'git rev-parse HEAD');
  sh(wt, 'git checkout -q -b member');
  write3(wt, 'a.txt', LINES.replace('l2', 'member line'));
  sh(wt, 'git commit -qam member');
  const member = sh(wt, 'git rev-parse HEAD');
  write3(wt, 'a.txt', LINES.replace('l2', 'member line').replace('l5', 'batch line'));
  sh(wt, 'git commit -qam batch');
  const s = { lane: 'batch', criteria: [], repos: { app: { worktree: wt, base } }, batch: { members: ['M-1'], heads: { 'M-1': { app: member } } } };
  const closure = { reviewer: 'b1', findings: [{ id: 'F1', severity: 'major', evidence: 'a.txt:2' }, { id: 'F2', severity: 'major', evidence: 'a.txt:5' }], criteria: [] };
  const stamped = stampClosure(s, closure, { mode: 'full' }).findings.map((f) => f.classified);
  assert.deepEqual(stamped.map((c) => [c.blocks, c.memberLine ?? false]), [[false, true], [true, false]]);
  assert.match(stamped[0].reason, /a batch member wrote/);
  // Outside a batch the same lines both block (the attempt wrote them).
  assert.deepEqual(stampClosure({ ...s, lane: 'standard' }, closure, { mode: 'full' }).findings.map((f) => f.classified.blocks), [true, true]);
});
function write3(dir, rel, content) {
  fs.writeFileSync(path.join(dir, rel), content);
}

// ---- The texts agents read say what the engine does ----

// Named failure (final review of 0.7.0): the AGENTS block still told the owner agent to ask for `override <attempt>:gate`
// and `release <attempt>` phrases, the resume line for discovered issues named `defer <id>`, and the work skill promised a
// list the evidence reviewer never received; each was found downstream by a reviewer, none by a check. Every `wf` command an
// agent-facing text names exists in the CLI, with a subcommand the CLI lists, and no text asks the person for a phrase.
test('every wf command an agent-facing text names exists, and no text asks the person to type a phrase', () => {
  // The commands and subcommands the CLI dispatches (engine/cli.mjs), the source of truth for what a text may name.
  const cli = fs.readFileSync(path.join(ROOT, 'engine', 'cli.mjs'), 'utf8');
  const subs = new Map();
  const blocks = cli.split(/\n    case '/).slice(1);
  for (const b of blocks) {
    const name = /^([a-z][a-z-]*)':/.exec(b)?.[1];
    if (!name) continue;
    const words = new Set([...b.matchAll(/sub [!=]== '([a-z][a-z-]*)'/g)].map((m) => m[1]));
    for (const m of b.matchAll(/\[((?:'[a-z-]+',?\s*)+)\]\.includes\(sub\)/g)) for (const w of m[1].matchAll(/'([a-z-]+)'/g)) words.add(w[1]);
    subs.set(name, words);
  }
  for (const m of cli.matchAll(/cmd === '([a-z][a-z-]*)'/g)) if (!subs.has(m[1])) subs.set(m[1], new Set());
  const files = [
    'templates/session-rules.md',
    ...fs.readdirSync(path.join(ROOT, 'templates', 'agents')).map((f) => `templates/agents/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((f) => fs.existsSync(path.join(ROOT, f))),
  ];
  const engineStrings = ['engine/lifecycle.mjs', 'engine/strategy.mjs', 'engine/discovered.mjs', 'engine/scope-decisions.mjs', 'engine/cli.mjs', 'engine/analysis.mjs'];
  const problems = [];
  const dead = [/start(?:s)? (?:a|their) message with/i, /message starts with/i, /`override </, /`release </, /`defer [^`\s]+:[^`\s]+`/];
  const check = (file, text) => {
    for (const m of text.matchAll(/`wf ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const known = subs.get(m[1]);
      if (!known) problems.push(`${file}: \`wf ${m[1]}\` is not a command`);
      else if (m[2] && known.size && !known.has(m[2]) && !m[2].startsWith('-')) problems.push(`${file}: \`wf ${m[1]} ${m[2]}\` is not a ${m[1]} subcommand (${[...known].join(', ')})`);
    }
    for (const re of dead) if (re.test(text)) problems.push(`${file}: asks for a typed phrase (${re})`);
  };
  for (const f of files) check(f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  // Engine guidance: code lines only (comments record history).
  for (const f of engineStrings) check(f, fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n').replace(/\\`/g, '`'));
  assert.deepEqual(problems, []);
});

test('wf doctor says when the harness has another version of the plugin installed than this engine (rollout skew)', () => {
  const p = singleRepoProject('fr-skew', { gate: { steps } });
  const home = path.join(p.base, '.home');
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agentic-workflow@agentic-workflow': [{ scope: 'user', version: '0.6.3' }] } }));
  const out = wf(p.root, ['doctor', '--no-steps', '--runtime', 'claude'], { env: { WF_HOME: home } });
  // The engine's own version, not a literal: a patch release must not fail its own suite (0.7.1).
  assert.ok((out.out + out.err).includes(`has agentic-workflow 0.6.3 installed while wf is ${ENGINE_VERSION}`), out.out + out.err);
});

test('a strategist model decision runs the role\'s next handoffs at the work class it names, with that class\'s pinned settings (Opus gap 5)', async () => {
  const { project: proj, runner, started, reviewRound, strategistClosure } = await import('./strategist-fixtures.mjs');
  const v7 = runner('0.7.0');
  const ctx = proj('fr-model');
  const a = started(v7, ctx, { item: 'ENG-990' });
  reviewRound(v7, ctx, a, { findings: 1 });
  const h = ok(v7.run(ctx.root, ['handoff', 'strategist', '--agent', 'st-m', '--attempt', a.id, '--reason', 'the same family failed twice', '--json'])).json();
  const bad = strategistClosure(ctx.base, h.bundle, { strategist: 'st-m', action: 'model', rationale: 'stronger model', prediction: { signal: 'blockingLatest <= 0', by: 3 }, model: { role: 'implementer', class: 'nonexistent' } });
  assert.match(v7.run(ctx.root, ['strategy', 'record', '--closure', bad.file, '--attempt', a.id]).err, /not a work class of this project/);
  const c = strategistClosure(ctx.base, h.bundle, { strategist: 'st-m', action: 'model', rationale: 'the fix needs the full class', prediction: { signal: 'blockingLatest <= 0', by: 3 }, model: { role: 'implementer', class: 'full' } });
  ok(v7.run(ctx.root, ['strategy', 'record', '--closure', c.file, '--attempt', a.id]));
  assert.deepEqual(v7.state(ctx.root, a.id).strategy.classFor, { implementer: 'full' });
  ok(v7.run(ctx.root, ['handoff', 'implementer', '--agent', 'impl-full', '--attempt', a.id, '--owner', a.owner]));
  assert.equal(v7.state(ctx.root, a.id).handoffs.at(-1).class, 'full');
});

test('course lines separate work from waiting and mark what passed its own estimate, with no threshold (D9)', async () => {
  const { courseLines, pastEstimates } = await import('../engine/signals.mjs');
  const sig = {
    expect: { files: 4, rounds: 2, minutes: 60 }, firstExpect: { files: 2, rounds: 2, minutes: 60 },
    files: { changed: 5 }, rounds: [{ n: 1, reviewer: 'r1', minutes: 300, activeUntilMinute: 25, expectMinutes: 30 }], roundsHanded: 3,
    wallMinutes: 900, longestQuietMinutes: 610,
    implementers: [{ agent: 'i', open: false, outcome: 'done', minutes: 40, activeUntilMinute: 39.5, expectMinutes: 45 }],
    sessions: [{ role: 'reviewer', agent: 'r2', minutes: 50, expectMinutes: 20, located: true, idleMinutes: 2 }],
  };
  const lines = courseLines(sig).join('\n');
  assert.match(lines, /files changed: 5; the plan expected 4 \(past its own estimate\) \(first predicted 2\)/);
  assert.match(lines, /review rounds recorded: 1; the plan expected 2; 3 handed \(2 never recorded\)/);
  assert.match(lines, /minutes since admission: 900; the plan expected 60 \(past its own estimate\); the longest stretch with nothing recorded was 610 min/);
  assert.match(lines, /review round 1 \(r1\): took 300 min \(last active at minute 25\); it expected 30 min \(past its own estimate\)/);
  assert.match(lines, /implementer i done: took 40 min; it expected 45 min/, 'within a minute of its last activity: nothing added');
  assert.match(lines, /reviewer r2 is working: 50 min since handed, it expects 20 min \(past its own estimate\)/);
  assert.deepEqual(pastEstimates(sig), ['files changed 5 (the plan expected 4)', 'review rounds 3 (the plan expected 2)', '900 minutes (the plan expected 60; 610 of them in one stretch with nothing recorded)', 'reviewer r2 working 50 min (it expected 20)']);
  assert.deepEqual(pastEstimates({ ...sig, expect: null, sessions: [] }), [], 'no prediction, nothing marked');
});

test('onboarding drafts a quality bar from what the project documents, and doctor says when a project has none', () => {
  const dir = tmp('fr-quality');
  makeRepo(path.join(dir, 'web'), { 'package.json': '{"name":"web","scripts":{"test":"node --test"}}', 'DESIGN_SYSTEM.md': '# Design\n' });
  makeRepo(path.join(dir, 'api'), { 'package.json': '{"name":"api","scripts":{"test":"node --test"}}' });
  ok(wf(dir, ['init']));
  const draft = fs.readFileSync(path.join(dir, '.workflow', 'project.yaml'), 'utf8');
  assert.match(draft, /quality:/);
  assert.match(draft, /follows web\/DESIGN_SYSTEM\.md and uses its components/);
  assert.match(draft, /The web, api repositories stay one matched contract|The api, web repositories stay one matched contract/);
  assert.match(draft, /The invariants in AGENTS\.invariants\.md hold/);
  const p = singleRepoProject('fr-noquality', { gate: { steps } });
  const out = wf(p.root, ['doctor', '--no-steps']);
  assert.match(out.out + out.err, /the adapter states no `quality:` goals/);
});
