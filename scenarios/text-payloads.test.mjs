import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, ok, reportFileOf, singleRepoProject, wf } from './helpers.mjs';
import { project, started, strategistClosure } from './strategist-fixtures.mjs';
import { closureProblems } from '../engine/strategy.mjs';
import { YAML } from '../engine/util.mjs';

// Named failure (second final review of 0.7.0): the engine changed and the texts followed late. The strategist's own example
// closure was refused by the engine of that day (empty `items`, `split`, `model` and `options` beside an action that owns
// none of them), a quick-fix plan written as the skill said carried no `expect` and was refused, the reviewer example rated
// a finding "major" on a scale the texts no longer used, and the planner example named a query it never defined, an empty
// `flows` list and a survey entry it excluded that did not exist. Each was found on first honest use by a role, none by a
// check; `final-review-0.7.test.mjs` checks only that the commands a text names exist and that none asks for a phrase.
//
// This scenario feeds every example payload in the role templates and skills through the engine's own validators, as a
// role would hand it in, and asserts it is accepted. The payloads are found by scanning the texts, so a fenced JSON or YAML
// block this file does not know is a failure: the next example is wired in when it is written, not after a role refuses it.
//
// What the test fills in, because an example has placeholders and the engine wants real values:
//   - `<your agent id>` and `<its agent id>`: the id the role was handed;
//   - `<sha256>`: any 64 hex digits;
//   - `<n>` in an `expect` line: any positive number (3 files, 2 rounds, 60 minutes);
//   - `<n>` as `hits`: the count the engine itself returns for that query (`wf impact run --file`), which is what the
//     planner is told to record.
// Nothing else is changed: every key, value and the order of the payload is the text's.

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const r = { run: wf };

// ---- Finding the payloads ----

// The fenced blocks of a markdown file: { lang, body } with the body dedented by the fence's own indentation.
function fenced(rel) {
  const out = [];
  const lines = read(rel).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```([a-z]*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const body = [];
    for (i += 1; i < lines.length && !new RegExp(`^${open[1]}\`\`\`\\s*$`).test(lines[i]); i++) body.push(lines[i].startsWith(open[1]) ? lines[i].slice(open[1].length) : lines[i]);
    out.push({ lang: open[2], body: body.join('\n') });
  }
  return out;
}

const TEXTS = [
  'templates/session-rules.md',
  ...fs.readdirSync(path.join(ROOT, 'templates', 'agents')).filter((f) => f.endsWith('.md')).map((f) => `templates/agents/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`).filter((f) => fs.existsSync(path.join(ROOT, f))),
];
const PAYLOAD_LANGS = ['json', 'jsonl', 'yaml', 'yml'];
// `file#lang:n`: the n-th block of that language in that file.
function payloads() {
  const found = {};
  for (const rel of TEXTS) {
    const seen = {};
    for (const b of fenced(rel)) {
      if (!PAYLOAD_LANGS.includes(b.lang)) continue;
      seen[b.lang] = (seen[b.lang] ?? 0) + 1;
      found[`${rel}#${b.lang}:${seen[b.lang]}`] = b.body;
    }
  }
  return found;
}
const KNOWN = {
  strategistClosure: 'templates/agents/strategist.md#json:1',
  strategistActions: 'templates/agents/strategist.md#jsonl:1',
  reviewerClosure: 'templates/agents/reviewer.md#json:1',
  implementerReport: 'templates/agents/implementer.md#json:1',
  plannerPlan: 'templates/agents/planner.md#yaml:1',
  quickFixPlan: 'skills/quick-fix/SKILL.md#yaml:1',
};
const payload = (name) => {
  const text = payloads()[KNOWN[name]];
  assert.ok(text, `${KNOWN[name]} is not in the texts any more: update KNOWN in this scenario with the example's new place`);
  return text;
};

const SHA = 'a'.repeat(64);
const fill = (text, { agent = null, expect = true } = {}) => {
  let t = text.replace(/<sha256>/g, SHA);
  if (agent) t = t.replace(/<(?:your|its) agent id>/g, agent);
  if (expect) t = t.replace(/(expect:\s*\{\s*files:\s*)<n>(,\s*rounds:\s*)<n>(,\s*minutes:\s*)<n>/g, (_, files, rounds, minutes) => `${files}3${rounds}2${minutes}60`);
  return t;
};

// ---- The payloads are all known ----

test('every fenced JSON or YAML payload in the role templates and skills is one this scenario feeds to the engine', () => {
  const found = Object.keys(payloads());
  const wired = Object.values(KNOWN);
  assert.deepEqual(found.filter((k) => !wired.includes(k)), [], 'an example payload no scenario feeds to the engine: add it to KNOWN and give it a test below');
  assert.deepEqual(wired.filter((k) => !found.includes(k)), [], 'a payload this scenario expects is gone from the texts');
});

// ---- The strategist's closure ----

test('the strategist\'s example closure is recorded by `wf strategy record`, the keys it lists for each action are accepted, and the strategy page\'s closure passes the same check', () => {
  const ctx = project('payload-strategist');
  const a = started(r, ctx, { item: 'ENG-901' });
  const h = ok(wf(ctx.root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', a.id, '--reason', 'the example closure is checked', '--json'])).json();
  const closure = JSON.parse(fill(payload('strategistClosure'), { agent: 'strat-1' }));
  // The example carries the keys its action needs; `by` is a round later than the ones recorded (none yet).
  assert.deepEqual(closureProblems(closure, { rounds: 0 }), []);
  const rec = ok(wf(ctx.root, ['strategy', 'record', '--closure', strategistClosure(ctx.base, h.bundle, closure).file, '--attempt', a.id, '--json'])).json();
  assert.equal(rec.decision.action, closure.action);
  assert.deepEqual(rec.decision.prediction, closure.prediction);

  // Each action's own keys, merged over the example (one JSON object per line in the text).
  const lines = payload('strategistActions').split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 5, 'the text lists the keys of cluster, ticket, split, model and escalate');
  const actions = [];
  for (const line of lines) {
    const extra = JSON.parse(fill(line));
    actions.push(extra.action);
    assert.deepEqual(closureProblems({ ...closure, ...extra }, { rounds: 0, plainEscalation: true }), [], `the ${extra.action} keys in the text are refused by the engine`);
  }
  assert.deepEqual(actions, ['cluster', 'ticket', 'split', 'model', 'escalate']);

  // The check is not vacuous: an action without the key it needs, or a prediction naming a round already recorded, is refused.
  for (const bad of [
    { ...closure, action: 'ticket' },
    { ...closure, action: 'split' },
    { ...closure, action: 'model', model: { role: 'reviewer' } },
    { ...closure, action: 'escalate', options: ['only-one'] },
    { ...closure, prediction: { ...closure.prediction, by: 0 } },
  ]) assert.ok(closureProblems(bad, { rounds: 0, plainEscalation: true }).length >= 1, `${bad.action} closure ${JSON.stringify(bad).slice(0, 80)} should be refused`);

  // The closure the strategy page shows is accepted too.
  const blocks = fenced('docs/strategy.md').filter((b) => b.lang === 'json');
  assert.equal(blocks.length, 1, 'docs/strategy.md shows one strategist closure');
  assert.deepEqual(closureProblems(JSON.parse(fill(blocks[0].body, { agent: 'strat-1' })), { rounds: 0 }), []);
});

// ---- The reviewer's closure ----

test('the reviewer\'s example closure is recorded by `wf review` in the delta round it describes: findings, criteria, a prior finding fixed and another re-rated', () => {
  const ctx = project('payload-reviewer', {}, { 'src/export.tsx': Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join('') });
  const a = started(r, ctx, { item: 'ENG-902' });
  commitIn(a.wt, { 'src/a.txt': 'first change\n' });
  // Round 1 (full, blind) raises what the example's prior findings refer to: F3 blocks (it fails C1), F4 is an observation on a
  // line this attempt did not change.
  ok(wf(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', a.id]));
  const one = {
    reviewer: 'rev-1', scope: 'the diff', expect: { minutes: 10 },
    findings: [
      { id: 'F3', severity: 'high', summary: 'the list loses its pager', status: 'open', evidence: 'src/a.txt:1', criterion: 'C1' },
      { id: 'F4', severity: 'medium', summary: 'the export page sums one page only', status: 'open', evidence: 'src/export.tsx:40' },
    ],
    criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log line 1' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log line 2' } }],
    screenshotsInspected: [], anomalies: 'none seen', impactChecked: 'no impact map', notReached: [],
  };
  ok(wf(ctx.root, ['review', '--closure', closureFile(ctx.base, one), '--attempt', a.id]));
  commitIn(a.wt, { 'src/a.txt': 'the pager is back\n' });
  // Round 2 is a delta: the closure of the text, with the id the reviewer was handed.
  ok(wf(ctx.root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', a.id]));
  const text = fill(payload('reviewerClosure'), { agent: 'rev-2' });
  const closure = JSON.parse(text);
  assert.equal(closure.priorFindings[0].round, 'rev-1', 'the example\'s prior findings name round rev-1, which this scenario plays');
  ok(wf(ctx.root, ['review', '--closure', closureFile(ctx.base, closure), '--attempt', a.id]));
  // The engine read it as the text says: the finding that cites C2 blocks; F4 was re-rated low by the later reviewer.
  const rows = ok(wf(ctx.root, ['scope', 'list', '--attempt', a.id, '--json'])).json();
  const byRef = Object.fromEntries(rows.map((x) => [x.ref, x]));
  assert.equal(byRef['rev-2:F1']?.blocks, true, 'F1 cites criterion C2');
  assert.equal(byRef['rev-1:F4']?.blocks, false);
  assert.equal(byRef['rev-1:F4']?.severity, 'low', 'a later reviewer\'s severity on a prior finding it finds still open decides where it may go');
  assert.equal(byRef['rev-1:F3'], undefined, 'F3 was verified fixed');
  // 0.7.27 (I-191): the example's `sameCauseAs` is read as the text says. F1 shares the cause of F3, which this closure verified
  // fixed: the cause came back, and the owner is told.
  const sig = ok(wf(ctx.root, ['signals', '--attempt', a.id, '--json'])).json();
  assert.deepEqual(sig.recurringCauses.map((x) => [x.again, x.fixed]), [['rev-2:F1', ['rev-1:F3']]], 'the link in the example reaches the signals');
});

// ---- The implementer's report ----

test('the implementer\'s example report is recorded at `wf handoff close`: what it ran, its proofs, and every item it left as a discovered issue', () => {
  const ctx = project('payload-implementer');
  const a = started(r, ctx, { item: 'ENG-903' });
  commitIn(a.wt, { 'src/a.txt': 'built\n' });
  const agent = 'impl-ENG-903';
  const report = JSON.parse(fill(payload('implementerReport'), { agent }));
  // The example's third item names an issue the implementer recorded earlier with `wf discovered add` (0.7.27, I-184).
  const named = report.left.find((l) => l.discoveredId);
  assert.ok(named, 'the example shows an item that names an issue already in the ledger');
  ok(wf(ctx.root, ['discovered', 'add', '--summary', named.what, '--severity', named.severity, '--where', named.where, '--found-by', agent, '--attempt', a.id]));
  fs.mkdirSync(path.dirname(reportFileOf(ctx.root, a.id, agent)), { recursive: true });
  fs.writeFileSync(reportFileOf(ctx.root, a.id, agent), JSON.stringify(report));
  ok(wf(ctx.root, ['handoff', 'close', '--agent', agent, '--attempt', a.id]));
  const state = ok(wf(ctx.root, ['resume', '--attempt', a.id, '--json'])).json();
  assert.equal(state.discovered.length, report.left.length, 'every item it left is one discovered issue: the item that names D1 is D1, not another');
  assert.equal(state.discovered.filter((d) => d.summary.includes(named.what)).length, 1, 'the named issue is not recorded twice');
  const [, first, second] = state.discovered;
  assert.match(first.summary, /the export page sums one page only/);
  assert.equal(first.severity, 'medium');
  assert.match(second.summary, /another tenant's rows/);
  assert.equal(second.invariant, 'tenant isolation', 'an item that names an invariant is recorded with it (and is high)');
  const recorded = state.implementerReports?.at(-1);
  assert.ok(recorded, 'the report is recorded');
  assert.deepEqual(recorded.expect, report.expect);
  assert.equal(recorded.ran.length, report.ran.length);
  assert.equal(recorded.proofs.length, report.proofs.length);
});

// ---- The planner's plan ----

// A project whose repo is called `web`, as the planner's example names it, with files the example's queries and components hit.
function webProject(name) {
  const page = (extra) => `export const Page = () => (isError ? <Fail /> : <Table rows={rows} />);\n${extra}`;
  return singleRepoProject(name, {
    repos: [{ name: 'web', path: '.', base: 'main' }],
    gate: { steps: [{ id: 'unit', repo: 'web', run: 'true' }] },
  }, {
    'src/pages/list.tsx': page('// pages\n'),
    'src/pages/report.tsx': '<Table rows={rows} readOnly />\n',
    'src/pages/other.tsx': page('// other\n'),
  });
}

test('the planner\'s example plan is frozen by `wf plan`, its `hits` being the counts the engine returns for its own queries', () => {
  const p = webProject('payload-planner');
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-904', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const text = fill(payload('plannerPlan'));
  // The planner records what `wf impact run` returns for each query: ask the engine, the way the text tells the planner to.
  const draft = path.join(p.base, 'draft-plan.yaml');
  fs.writeFileSync(draft, text.replace(/<n>/g, '0'));
  const counts = Object.fromEntries(ok(wf(p.root, ['impact', 'run', '--file', draft, '--attempt', e.id, '--json'])).json().map((q) => [q.id, q.hits]));
  assert.deepEqual(Object.keys(counts).sort(), ['Q1', 'Q2'], 'the example defines the two queries its entries name');
  assert.ok(counts.Q1 > 0 && counts.Q2 > 0, 'the fixture holds hits for both queries');
  // `hits: <n>` follows `query: Qx` (or `id: Qx` in a query's own definition) in the same entry.
  const filled = text.replace(/\b(query|id): (Q\d+)([^{}]*?)hits: <n>/g, (_, key, id, between) => `${key}: ${id}${between}hits: ${counts[id]}`);
  assert.doesNotMatch(filled, /<n>/, 'every placeholder is filled');
  const plan = path.join(p.base, 'plan.yaml');
  fs.writeFileSync(plan, filled);
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  const state = ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json();
  assert.deepEqual(state.criteria.map((c) => c.id), ['C1']);
  assert.deepEqual(state.work.map((w) => w.id), ['W1']);
  assert.ok(state.impact?.impact?.changes?.length, 'the impact map is recorded with the plan');

  // The numbers are the engine's: the example with a count the engine does not return is refused, so `hits` is not decoration.
  const q = ok(wf(p.root, ['entry', '--item', 'ENG-905', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p2', '--attempt', q.id]));
  const wrong = path.join(p.base, 'wrong-plan.yaml');
  fs.writeFileSync(wrong, filled.replace(/hits: (\d+)/g, (_, n) => `hits: ${Number(n) + 7}`));
  const refused = wf(p.root, ['plan', '--file', wrong, '--attempt', q.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /recorded \d+ hit\(s\), the engine finds/);
});

// ---- The quick-fix plan ----

test('the quick-fix skill\'s plan is frozen by `wf plan` in the quick lane, and the same plan without its `expect` is refused', () => {
  const p = singleRepoProject('payload-quick', {});
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  assert.match(e.id, /^QF-/);
  const text = fill(payload('quickFixPlan'));
  assert.doesNotMatch(text, /<n>/);
  const plan = path.join(p.base, 'quick-plan.yaml');
  fs.writeFileSync(plan, text);
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  const state = ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json();
  assert.deepEqual(state.criteria.map((c) => c.id), ['C1']);

  // The skill used to show a plan of criteria alone; the engine refuses a plan that states no prediction.
  const q = ok(wf(p.root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  const bare = path.join(p.base, 'quick-bare.yaml');
  fs.writeFileSync(bare, YAML.stringify({ criteria: YAML.parse(text).criteria }));
  const refused = wf(p.root, ['plan', '--file', bare, '--attempt', q.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /states no expectation/);
});

// ---- The texts agree where they state the same rule ----

const flat = (rel) => read(rel).replace(/\*\*/g, '').replace(/\s+/g, ' ').toLowerCase();

// The scale is one scale: the same definitions in every text that states it. A change to it is a change to all of them.
test('the severity scale reads alike in every text that states it', () => {
  const scale = [
    'a user, a tenant or the business is harmed or blocked (wrong or lost data, a broken flow, security, money, a visible defect on a primary screen)',
    'degraded but usable (a secondary flow, an edge case, a confusing state)',
    'polish (wording, spacing, naming, style)',
    'A tenant-isolation, authorization or money defect is always high',
  ];
  // 0.7.11: the AGENTS.md block no longer copies the rules into projects (two projects carried a rule three releases old);
  // it points to the plugin's texts, which state them.
  const states = [
    'templates/agents/reviewer.md', 'templates/agents/implementer.md', 'templates/agents/planner.md',
    'skills/work/SKILL.md', 'skills/quick-fix/SKILL.md', 'docs/scope-decisions.md', 'docs/lifecycle.md', 'docs/releases/v0.7.0.md',
  ];
  const missing = [];
  for (const rel of states) {
    const text = flat(rel);
    for (const part of scale) if (!text.includes(part.toLowerCase())) missing.push(`${rel}: ${part}`);
  }
  assert.deepEqual(missing, []);
  // The scale the examples use is the scale: no example rates a finding or an item on another one.
  for (const key of ['reviewerClosure', 'implementerReport']) {
    for (const m of payload(key).matchAll(/"severity":\s*"([^"]+)"/g)) assert.ok(['high', 'medium', 'low'].includes(m[1]), `${key} rates something "${m[1]}"`);
  }
});

test('the rule for what blocks a round reads alike in every text that states it: a low finding never opens one', () => {
  const states = ['templates/agents/reviewer.md', 'skills/work/SKILL.md', 'skills/quick-fix/SKILL.md', 'docs/scope-decisions.md', 'docs/lifecycle.md', 'docs/trust-model.md'];
  const problems = [];
  for (const rel of states) {
    const text = flat(rel);
    if (!/rated low (?:never opens a round|is an observation)/i.test(text)) problems.push(`${rel}: does not say a finding rated low never opens a round`);
    if (!/criterion/.test(text) || !/invariant/.test(text)) problems.push(`${rel}: does not name the frozen criterion and the critical invariant`);
  }
  assert.deepEqual(problems, []);
});

// ---- Claims the engine retired ----

// Each pattern is a sentence a text once said that the 0.7.0 engine contradicts, with the engine behaviour it contradicts. A
// text that says it again fails here, with the file and the line.
const RETIRED = [
  [/acknowledge-deferrals/, 'deferrals are listed at delivery on their own; nothing is acknowledged'],
  [/about an hour/, 'the engine holds no tickets to a duration; the plan\'s own prediction is compared'],
  [/amend the plan so one work item covers/, 'an implementer handed without --work covers every unstarted work item'],
  [/with the user's approval, in a sibling/, 'a move to a sibling attempt of the batch asks nobody'],
  [/prediction it cannot compare is refused at once/, 'only a plan\'s expect is refused; a role\'s own unreadable expect is dropped'],
  [/(?:runs|run) only the specs (?:it|they) changed/, 'a method, not a goal: the implementer owns the criteria on the whole tree'],
  [/may not appear in `doNotRun`/, 'doNotRun restricts nothing'],
  [/deferred on the owner's confirmed decision/, 'a deferral follows the severity rule'],
  [/Deferral stays the owner's decision/, 'a deferral follows the severity rule'],
  [/every deferral[^.|]*creates a decision/i, 'only a high, unrated or invariant-breaking deferral does'],
  [/need a verdict per rule/, 'a verdict per rule is optional context'],
  [/`wf review` refuses a closure missing one/, 'a verdict per design hit is optional context'],
  [/`wf accept` refuses a missing verdict/, 'a verdict per rule is optional context'],
  [/Without it the handoff is refused/, 'a sweep is optional'],
  [/`wf handoff reviewer` refuses while one is unanswered/, 'an unanswered sweep stops nothing'],
  [/No implementer starts while an amendment owes/, 'an owed impact update is information'],
  [/Until it is recorded, `wf handoff implementer` and `wf accept` refuse/, 'an owed impact update is information'],
  [/Where Claude Code transcripts exist, `wf review` refuses/, 'the engine reads no reviewer transcript'],
  [/identifies the round's agent by that name in its transcript/, 'the engine reads no reviewer transcript'],
  [/with a verdict for each rule/, 'a verdict per rule is optional context'],
  // 0.7.27 (D41, D39 as corrected): the person may ask the agent to set Done, and a rule for the first step routes at admission.
  [/Never set a ticket to done|a human does\b/i, 'Done is set when the adapter routes the ticket there or the person explicitly asks for it'],
  [/cannot route at admission/, 'a rule for the first step routes at admission (the engine reads the labels first; a connector\'s pending action names the routes)'],
  // 0.7.27 (D41): a decision is asked in the agent's message in the form that binds; the panel is optional.
  [/goes in the question panel \(or `wf approve`\)/, 'a reserved question is asked in the agent\'s message, quoted exactly; the panel is optional'],
  // 0.7.27 (D41, as reworked): the engine reads no meaning into a reply; the agent reads it and records the choice with the words it
  // relies on (`--choice` with `--quote`). Named failure: patterns bound "close it if the deploy is fine" and refused "proceed".
  [/names what (?:the question|the decision|it) decides|whatever (?:your|the) message before it said|in its frame's own terms/i, 'the engine reads no meaning into a reply: the agent reads it and records its reading with the person\'s words'],
  [/reply chooses when it names one of (?:the|its) options|go with your recommendation|reply is read (?:per|sentence by) sentence/i, 'a reply binds by itself only when it is exactly one option; the agent reads any other'],
  [/`wf approve <id> --from-question` reads it\)/, 'the agent reads the person\'s words; `wf approve --from-question` checks they are theirs and records the reading'],
];
test('no text repeats a claim the engine retired', () => {
  const docs = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md') && f !== 'DESIGN.md' && !/^v\d/.test(f)).map((f) => `docs/${f}`);
  const files = [...TEXTS, ...docs, 'README.md', 'CONTRIBUTING.md'];
  const found = [];
  for (const rel of files) {
    read(rel).split('\n').forEach((line, i) => {
      for (const [re, why] of RETIRED) if (re.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}  [${why}]`);
    });
  }
  assert.deepEqual(found, []);
});
