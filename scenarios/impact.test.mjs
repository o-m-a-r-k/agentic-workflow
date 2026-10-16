// I-26: the planner's two-stage impact analysis (survey before the design, impact map after it), checked by the engine's
// own structured queries at `wf plan`, owed again by a scope-adding amendment (0.7.0: told to the implementer in its bundle,
// never a stop), and re-derived from the final diff for the reviewer. I-25: fix handoffs carry a pattern sweep per open
// finding (0.7.0: answered in a trailer or not, the reviewer is told either way); doctor fails on a planner or reviewer
// with no model; a plan's externalServices restriction that names a repo or suite the diff now touches is warned about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, FIXTURE_EXPECT, ok, OUT_OF_ORDER, sh, singleRepoProject, state, wf } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const FILES = {
  'src/table.js': 'export function renderTable(rows) {\n  return rows;\n}\n',
  'src/pages/a.js': "import { renderTable } from '../table.js';\nif (isError) return null;\nrenderTable([]);\n",
  'src/pages/b.js': "import { renderTable } from '../table.js';\nrenderTable([]);\n",
  'src/pages/c.js': 'if (isError) return null;\n',
  'docs/notes.md': 'renderTable is documented here\n',
};
// 0.7.0 (goals, not forms): a component row names the file and the query that found it, and says what matters for this change.
const row = (id, file, extra = {}) => ({ id, file, query: 'Q-consumers', notes: 'paging and the error branch matter here', ...extra });

const survey = () => ({
  queries: [
    { id: 'Q-consumers', pattern: 'renderTable(', kind: 'literal', paths: ['src/pages/**'], hits: 2 },
    { id: 'Q-error', pattern: 'isError\\)', kind: 'regex', paths: ['src/**'], exclude: ['src/pages/b.js'], hits: 2 },
  ],
  components: [row('S-a', 'src/pages/a.js'), row('S-b', 'app:src/pages/b.js')],
  patterns: [{ id: 'P-error', description: 'an error branch replaces the table', query: 'Q-error', hits: 2 }],
});
const design = () => ({ expect: FIXTURE_EXPECT, plan: { summary: 'renderTable takes a pager', anchors: ['src/table.js:1 renderTable'], doNotRun: ['full e2e'] }, criteria: [{ id: 'C1', text: 'every table pages', uat: 'pages move' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'full', why: 'shared component' }] });
const change = (extra = {}) => ({ id: 'I1', element: 'renderTable(rows, pager)', kind: 'symbol', cites: ['C1'], covers: ['S-a', 'S-b', 'P-error'], consumers: { query: 'Q-consumers', hits: 2 }, flows: [{ flow: 'next page', failure: 'a failed next keeps the rows', query: 'Q-consumers', hits: 2 }], contracts: [], suites: [{ suite: 'unit', query: 'Q-consumers', hits: 2 }], work: ['W1'], ...extra });
const impact = (extra = {}) => ({ changes: [change(extra)] });
const goodPlan = () => ({ survey: survey(), ...design(), impact: impact() });

function admitted(name, config = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, FILES);
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const file = (doc, name = 'plan') => {
    const f = path.join(p.base, `${name}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  return { ...p, id: e.id, wt: e.repos.app.worktree, file, plan: (doc) => wf(p.root, ['plan', '--file', file(doc), '--attempt', e.id]) };
}

test('I-26: a plan with a design but no survey or impact map is refused for full-class work; light work, an opt-out adapter and the quick lane need none', () => {
  const a = admitted('impact-missing');
  const r = a.plan(design());
  assert.equal(r.code, 75);
  assert.match(r.err, /plan refused: the impact analysis is incomplete[\s\S]*the plan has a design but no `survey`[\s\S]*the plan has no `impact` map/);
  const light = admitted('impact-light');
  ok(light.plan({ ...design(), work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'light', why: 'ui' }] }));
  const optOut = admitted('impact-optout', { impact: { requiredFor: [] } });
  ok(optOut.plan(design()));
  const quick = singleRepoProject('impact-quick', { gate: { steps } }, FILES);
  const q = ok(wf(quick.root, ['entry', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  const qf = path.join(quick.base, 'qf.json');
  fs.writeFileSync(qf, JSON.stringify(design()));
  ok(wf(quick.root, ['plan', '--file', qf, '--attempt', q.id]));
  const bad = singleRepoProject('impact-badcfg', { gate: { steps }, impact: { requiredFor: ['heavy'] } });
  assert.match(wf(bad.root, ['doctor', '--no-steps']).out, /`impact\.requiredFor` must list known classes/);
});

test('I-26: the survey is written before the design and the impact map after it', () => {
  const a = admitted('impact-order');
  const { survey: s, ...rest } = goodPlan();
  const late = a.plan({ ...rest, survey: s });
  assert.equal(late.code, 75);
  assert.match(late.err, /`survey` comes after the design: write the survey of what exists first/);
  const { impact: i, ...noImpact } = goodPlan();
  const early = a.plan({ survey: s, impact: i, ...design() });
  assert.match(early.err, /`impact` comes before the design/);
  assert.match(a.plan({ ...design(), plan: { summary: 's', survey: s } }).err, /`survey` and `impact` sit at the top level/);
  assert.ok(noImpact);
});

test('I-26: wf plan re-runs every query itself and refuses a count that does not match, an entry that repeats a wrong count, or a row that is no hit', () => {
  const a = admitted('impact-counts');
  // The planner (read-only, no draft file) checks one query before recording its count.
  const one = ok(wf(a.root, ['impact', 'run', '--attempt', a.id, '--query', JSON.stringify({ pattern: 'renderTable(', paths: ['src/pages/**'] })]));
  assert.match(one.out, /^query: 2 files at app@[0-9a-f]{10}\n {4}app:src\/pages\/a\.js\n {4}app:src\/pages\/b\.js/);
  assert.match(wf(a.root, ['impact', 'run', '--attempt', a.id, '--query', '{"pattern": "x", "kind": "glob"}']).err, /`kind` is literal or regex/);
  // The engine caps what a query reads: a text file over the cap refuses the query (its count would leave the file out,
  // 0.5.0 second review: fail closed), excluded it counts again; a query reading too much is refused.
  const capped = admitted('impact-caps', { impact: { maxFileBytes: 40 } });
  const big = wf(capped.root, ['impact', 'run', '--attempt', capped.id, '--query', JSON.stringify({ pattern: 'isError', paths: ['src/**'] })]);
  assert.equal(big.code, 75);
  assert.match(big.err, /query `query` cannot read 3 text file\(s\) over impact\.maxFileBytes \(40 bytes\), so its count would leave them out: app:src\/pages\/a\.js \(\d+ bytes\), app:src\/pages\/b\.js \(\d+ bytes\), app:src\/table\.js/);
  const c = ok(wf(capped.root, ['impact', 'run', '--attempt', capped.id, '--query', JSON.stringify({ pattern: 'isError', paths: ['src/**'], exclude: ['src/pages/a.js', 'src/pages/b.js', 'src/table.js'] })]));
  assert.match(c.out, /^query: 1 files at [^\n]+\n {4}app:src\/pages\/c\.js$/m);
  const tight = admitted('impact-scan', { impact: { maxScanBytes: 10 } });
  assert.match(wf(tight.root, ['impact', 'run', '--attempt', tight.id, '--query', JSON.stringify({ pattern: 'isError' })]).err, /query `query` reads more than 10 bytes; narrow its `paths`/);
  const wrong = goodPlan();
  wrong.survey.queries[0].hits = 128;
  wrong.survey.components[0].file = 'src/pages/c.js';
  wrong.survey.patterns[0].hits = 5;
  delete wrong.survey.components[1].notes;
  const r = a.plan(wrong);
  assert.equal(r.code, 75);
  assert.match(r.err, /query `Q-consumers`: recorded 128 hit\(s\), the engine finds 2 \(app@[0-9a-f]{10}\)/);
  assert.match(r.err, /survey\.components\[0\] \(S-a\): src\/pages\/c\.js is not a hit of query `Q-consumers`/);
  assert.match(r.err, /survey\.patterns\[0\] \(P-error\): states 5 hit\(s\) for query `Q-error`, which returns 2/);
  assert.doesNotMatch(r.err, /survey\.components\[1\]/, 'a component row without a column or a note is no plan error (0.7.0): the row is judged by its file and query');
  const noQuery = goodPlan();
  delete noQuery.survey.patterns[0].query;
  assert.match(a.plan(noQuery).err, /survey\.patterns\[0\] \(P-error\): names no `query`/);
  const badRegex = goodPlan();
  badRegex.survey.queries[1].pattern = '(';
  assert.match(a.plan(badRegex).err, /query `Q-error`: invalid regex/);
  // Queries are data: a pattern is never run by a shell.
  const sneaky = goodPlan();
  const marker = path.join(a.base, 'pwned');
  sneaky.survey.queries.push({ id: 'Q-x', pattern: `$(touch ${marker})`, kind: 'literal', hits: 0 });
  sneaky.survey.patterns.push({ id: 'P-x', description: 'x', query: 'Q-x', hits: 0 });
  sneaky.impact.excluded = [{ survey: 'P-x', reason: 'fixture' }];
  ok(a.plan(sneaky));
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(Object.keys(state(a.root, a.id).impact.results).sort(), ['Q-consumers', 'Q-error', 'Q-x']);
});

test('I-26: a survey entry the impact map neither covers nor excludes and an impact entry that cites no design element are refused; a plan doNotRun never bans a must-run suite (0.7.0)', () => {
  const a = admitted('impact-cover');
  const r = a.plan({ survey: survey(), ...design(), impact: impact({ covers: ['S-a'], cites: ['nothing-in-the-design'] }) });
  assert.equal(r.code, 75);
  assert.match(r.err, /survey entries the impact map neither covers nor excludes: S-b, P-error/);
  assert.match(r.err, /impact\.changes\[0\] \(I1\): cites no element of the design/);
  const reasonless = a.plan({ survey: survey(), ...design(), impact: { ...impact({ covers: ['S-a', 'S-b'] }), excluded: [{ survey: 'P-error' }] } });
  assert.match(reasonless.err, /impact\.excluded\[0\] \(P-error\): an exclusion needs a `reason`/);
  const noFlows = a.plan({ survey: survey(), ...design(), impact: impact({ flows: [], work: ['W9'] }) });
  assert.match(noFlows.err, /needs `flows` \(end to end, including failure paths\)[\s\S]*unknown work item `W9`/);
  // Cites may name anchor text; an exclusion with a reason covers an entry. Named failure (0.7.0): doNotRun banned suites a
  // change needed, so the plan below lists the `unit` suite as banned and as a must-run suite of the impact map, and is
  // frozen: doNotRun is kept as the planner wrote it and restricts nothing.
  const s = ok(a.plan({ survey: survey(), ...design(), plan: { ...design().plan, doNotRun: ['the unit suite'] }, impact: { ...impact({ covers: ['S-a', 'S-b'], cites: ['src/table.js:1'] }), excluded: [{ survey: 'P-error', reason: 'error branches keep the table already' }] } }));
  assert.match(s.out, /criteria frozen \(1\): C1/);
  const frozen = state(a.root, a.id);
  assert.deepEqual(frozen.plan.doNotRun, ['the unit suite']);
  assert.equal(frozen.impact.results['Q-consumers'].hits, 2);
  assert.deepEqual(frozen.impact.results['Q-error'].files, ['app:src/pages/a.js', 'app:src/pages/c.js']);
});

const implementerBundle = (r) => JSON.parse(fs.readFileSync(r.out.match(/bundle: (\S+)/)[1], 'utf8'));

// Named failure (0.7.0, I-25): the implementer handoff was refused until an impact addendum was recorded, and review and
// acceptance refused the same obligation, so an implementer stopped for a form while the consumers were found one at a
// time anyway. The obligation is now information in the implementer's bundle (`impactOwed`); the addendum is still
// checked like the plan when it is given.
test('I-26: a scope-adding amendment owes an impact update that the implementer bundle carries; the addendum, when given, is checked like the plan', () => {
  const a = admitted('impact-amend');
  ok(a.plan(goodPlan()));
  const amend = (doc) => wf(a.root, ['criteria', 'amend', '--file', a.file(doc, 'amend'), '--reason', 'an endpoint joins', '--attempt', a.id]);
  const owed = ok(amend({ criteria: [{ id: 'C2', text: 'the list endpoint returns the total', uat: 'total matches' }] }));
  assert.match(owed.out, /impact owed: this amendment adds scope/);
  // The handoff is not refused; the bundle says what is owed and carries no stop.
  const first = ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i0', '--attempt', a.id]));
  const owedBundle = implementerBundle(first);
  assert.deepEqual([owedBundle.impactOwed.amendment, owedBundle.impactOwed.reason], [1, 'an endpoint joins']);
  assert.match(owedBundle.impactOwed.note, /added scope without an impact map: find the consumers and flows it reaches as you build/);
  const addendum = (extra = {}) => ({ survey: { queries: [{ id: 'Q-total', pattern: 'rows', kind: 'literal', paths: ['src/table.js'], hits: 1 }], consumers: [{ id: 'S-total', symbol: 'rows', query: 'Q-total', hits: 1 }] }, changes: [{ ...change(), id: 'I2', element: 'GET /list total', kind: 'endpoint', cites: ['C2'], covers: ['S-total'], consumers: { query: 'Q-total', hits: 1 }, ...extra }] });
  assert.match(amend({ impact: addendum({ cites: [] }) }).err, /amendment refused: its impact addendum is incomplete[\s\S]*cites no element of the design/);
  assert.match(amend({ impact: addendum({ covers: [] }) }).err, /survey entry the addendum neither covers nor excludes: S-total/);
  const dup = addendum();
  dup.survey.queries[0].id = 'Q-consumers';
  assert.match(amend({ impact: dup }).err, /query `Q-consumers` is already recorded/);
  const r = ok(amend({ impact: addendum() }));
  assert.match(r.out, /impact addendum recorded/);
  assert.equal(implementerBundle(ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i', '--attempt', a.id]))).impactOwed, undefined, 'a recorded addendum clears what is owed');
  // A wording change owes one too (the owner is told again); `unchanged` states why it adds no element and clears it.
  ok(amend({ criteria: [{ id: 'C2', text: 'the list endpoint returns the total over every page', uat: 'total matches' }] }));
  assert.deepEqual(implementerBundle(ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i2', '--attempt', a.id]))).impactOwed?.amendment, 3);
  ok(amend({ impact: { unchanged: 'C2 wording only: same endpoint, same consumers' } }));
  assert.equal(implementerBundle(ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i3', '--attempt', a.id]))).impactOwed, undefined);
  assert.deepEqual(state(a.root, a.id).criteriaAmendments.map((x) => x.impact), ['owed', true, 'owed', true]);
});

function reviewed(name) {
  const a = admitted(name);
  ok(a.plan(goodPlan()));
  ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', a.id]));
  commitIn(a.wt, { 'src/table.js': 'export function renderTable(rows, pager) {\n  return pager ? rows : rows;\n}\n' });
  ok(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id]));
  return a;
}
const checked = (extra = {}) => ({
  queries: [{ query: 'Q-consumers', hits: 2 }, { query: 'Q-error', hits: 2 }, { query: 'Q-total', hits: 1 }].slice(0, 2),
  sampled: ['S-a', 'S-b', 'P-error', 'I1'].map((entry) => ({ entry, verdict: 'matches', evidence: `${entry} checked in the code` })),
  derived: [{ symbol: 'renderTable', file: 'app:docs/notes.md', verdict: 'in-map', evidence: 'documentation only' }],
  ...extra,
});
const closure = (reviewer, extra = {}) => ({ reviewer, findings: [], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'unit log' } }], screenshotsInspected: [], impactChecked: checked(), ...extra });

test('I-26: an owed impact update stops nothing downstream: the next step is not a repair, and the gate, review and acceptance go through', () => {
  const a = admitted('impact-owed-flow');
  ok(a.plan(goodPlan()));
  ok(wf(a.root, ['criteria', 'amend', '--file', a.file({ criteria: [{ id: 'C2', text: 'the list endpoint returns the total', uat: 'total matches' }] }, 'amend'), '--reason', 'an endpoint joins', '--attempt', a.id]));
  assert.equal(state(a.root, a.id).impact.owed.amendment, 1, 'the update is owed');
  ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', a.id]));
  commitIn(a.wt, { 'src/table.js': 'export function renderTable(rows, pager) {\n  return pager ? rows : rows;\n}\n' });
  ok(wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id]));
  assert.match(state(a.root, a.id).next, /code review: hand to a fresh reviewer/, 'an owed impact update is no reason for a repair step: the next step is the review');
  ok(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id]));
  ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', a.id]));
  ok(wf(a.root, ['review', '--closure', closureFile(a.base, closure('rev-1', { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'unit log' } }, { id: 'C2', evidence: { kind: 'output', ref: 'unit log' } }] })), '--attempt', a.id]));
  ok(wf(a.root, ['accept', '--attempt', a.id]));
  assert.equal(state(a.root, a.id).phase, 'accepted');
});

test('I-26: the reviewer bundle carries the impact map and the callers the final diff reaches outside it; the reviewer-side check is notes, not a quota (0.7.0)', () => {
  const a = reviewed('impact-review');
  const start = ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', a.id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.impactMap.inventory, ['S-a', 'S-b', 'P-error', 'I1']);
  assert.equal(bundle.impactMap.sampleSize, undefined, 'no sampling quota is handed to the reviewer');
  assert.deepEqual(bundle.impactMap.queries['Q-consumers'].hits, 2);
  assert.ok(bundle.impactMap.derived.symbols.includes('renderTable'));
  assert.deepEqual(bundle.impactMap.derived.outside, [{ symbol: 'renderTable', declaredIn: 'app:src/table.js', declarationOrigins: ['app:src/table.js'], originAmbiguous: false, matchKind: 'textual', file: 'app:docs/notes.md' }]);
  // The bundle says what the derived callers are (textual).
  assert.match(bundle.instructions, /Impact discovery under impactMap\.derived is textual, not structurally resolved consumer analysis/);
  assert.doesNotMatch(bundle.instructions, /impactChecked\.sampled/);
  const run = ok(wf(a.root, ['impact', 'run', '--attempt', a.id]));
  assert.match(run.out, /Q-consumers: 2 files \(as recorded\) at app@[0-9a-f]{10}\n {4}app:src\/pages\/a\.js\n {4}app:src\/pages\/b\.js/);
  const review = (c) => wf(a.root, ['review', '--closure', closureFile(a.base, c), '--attempt', a.id]);
  // Named failure (0.7.0): reviewer-side shape refusals (a sample of ten, a restated hit count, a verdict per derived caller).
  // A closure with no impactChecked, or with a count that differs from the re-run, is recorded; the planner-side fact
  // (`wf plan` re-runs every query and refuses a count that does not match) is unchanged.
  ok(review(closure('rev-1', { impactChecked: undefined })));
  ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1b', '--attempt', a.id]));
  ok(review(closure('rev-1b', { impactChecked: checked({ queries: [{ query: 'Q-consumers', hits: 3 }], sampled: [], derived: [] }) })));
  ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1c', '--attempt', a.id]));
  const gap = { id: 'F1', severity: 'minor', summary: 'the docs describe the old signature', status: 'open', evidence: 'docs/notes.md:1', category: 'impact-gap', work: 'W1' };
  ok(review(closure('rev-1c', { findings: [gap], impactChecked: checked({ derived: [{ symbol: 'renderTable', file: 'app:docs/notes.md', verdict: 'impact-gap', finding: 'F1' }] }) })));
  const rows = JSON.parse(ok(wf(a.root, ['report', '--json'])).out);
  assert.equal(rows.attempts[0].impactGaps, 1, 'impact-gap findings are counted per attempt');
});

test('I-25: a fix handoff may name a pattern sweep per family (0.7.0: optional); the implementer answers each in a trailer, and the next review lists them with their answers (none required)', () => {
  const a = reviewed('sweep');
  ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', a.id]));
  const f1 = { id: 'F1', severity: 'major', summary: 'a failed next removes the table', status: 'open', evidence: 'src/pages/a.js:2', criterion: 'C1', work: 'W1' };
  ok(wf(a.root, ['review', '--closure', closureFile(a.base, closure('rev-1', { findings: [f1] })), '--attempt', a.id]));
  const fix = (extra = [], agent = 'impl-2') => wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', agent, '--attempt', a.id, ...extra]);
  // 0.7.0 (goals, not methods): a fix handoff without a sweep is not refused. The implementer finds the other instances of
  // each family itself; the handoff still lists the blocking findings by family and carries no sweep.
  const bare = ok(fix([], 'impl-bare'));
  const bareBundle = JSON.parse(fs.readFileSync(bare.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.equal(bareBundle.sweep, undefined);
  assert.deepEqual(bareBundle.repair.map((g) => [g.family, g.findings.map((f) => f.ref)]), [[null, ['rev-1:F1']]]);
  assert.match(bareBundle.instructions, /This is a fix round: find the cause of each family in `repair` and fix it once, with one proof/);
  // A sweep that is given is still checked.
  const sweepFile = (sweeps) => a.file({ sweeps }, 'sweep');
  assert.match(fix(['--sweep', sweepFile([{ finding: 'rev-1:F9', query: { pattern: 'isError' } }])]).err, /`rev-1:F9` is not an open finding or family \(open: rev-1:F1\)/);
  assert.match(fix(['--sweep', sweepFile([{ finding: 'rev-1:F1', query: { pattern: '(', kind: 'regex' } }])]).err, /invalid regex/);
  const h = ok(fix(['--sweep', sweepFile([{ finding: 'rev-1:F1', why: 'an error branch replaces the table', query: { pattern: 'isError', kind: 'literal', paths: ['src/**'] } }])]));
  assert.match(h.out, /pattern sweep \(answer each family in a commit trailer with one proof: `Sweep <id>: proof - <command> => <expected result>`\):\n {2}S1 for rev-1:F1: 2 hit\(s\)\n {4}app:src\/pages\/a\.js\n {4}app:src\/pages\/c\.js/);
  const implBundle = JSON.parse(fs.readFileSync(h.out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(implBundle.sweep.map((s) => [s.id, s.finding, s.hits]), [['S1', 'rev-1:F1', 2]]);
  assert.match(implBundle.instructions, /This is a fix round: find the cause of each family in `repair` and fix it once, with one proof/);
  assert.deepEqual(implBundle.repair.map((g) => [g.family, g.findings.map((f) => f.ref)]), [[null, ['rev-1:F1']]], 'a repair handoff lists the blocking findings by family');
  commitIn(a.wt, { 'src/pages/a.js': "import { renderTable } from '../table.js';\nrenderTable([]);\n" }, 'F1: keep the table on error');
  // Named failure (0.7.0): the reviewer handoff was refused until each sweep had its trailer, and the fix implementer wrote
  // a placeholder to get through. An unanswered sweep is shown to the reviewer as it stands (no answer, the hits now);
  // a trailer written later is shown as the answer.
  const unanswered = ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', a.id]));
  const before = JSON.parse(fs.readFileSync(unanswered.out.trim().match(/^Read (\S+)/)[1], 'utf8'));
  assert.deepEqual(before.sweeps.map((s) => [s.id, s.finding, s.hitsAtHandoff, s.hitsNow, s.answer]), [['S1', 'rev-1:F1', 2, 1, null]]);
  commitIn(a.wt, { 'src/pages/c.js': 'renderTable([]);\n' }, 'F1 sweep: c.js too');
  sh(a.wt, 'git commit -q --allow-empty -m "Sweeps" -m "Sweep S1: fixed - src/pages/a.js and src/pages/c.js keep the table on error"');
  const start = ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', a.id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  assert.deepEqual(bundle.sweeps.map((s) => [s.id, s.finding, s.hitsAtHandoff, s.hitsNow, s.answer.answer]), [['S1', 'rev-1:F1', 2, 0, 'fixed']]);
  // A second implementer handoff in the same fix round owes no new sweep for an already swept finding.
  ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-3', '--attempt', a.id]));
});

test('I-25: doctor fails when the planner or reviewer resolves to no model; the default review class pins one and wf sync writes it', () => {
  const ok1 = singleRepoProject('doctor-models', { gate: { steps } });
  const d = ok(wf(ok1.root, ['doctor', '--no-steps']));
  assert.match(d.out, /✓ config: planner model: fable \(class planning\) \(claude\)\n✓ config: reviewer model: opus \(class review\) \(claude\)/);
  ok(wf(ok1.root, ['sync']));
  const front = fs.readFileSync(path.join(ok1.root, '.claude/agents/wf-reviewer.md'), 'utf8');
  assert.match(front, /^model: opus$/m);
  assert.match(fs.readFileSync(path.join(ok1.root, '.claude/agents/wf-planner.md'), 'utf8'), /^model: fable$/m);
  const bad = singleRepoProject('doctor-nomodel', { gate: { steps }, roles: { reviewer: { class: 'full' } } });
  const r = wf(bad.root, ['doctor', '--no-steps']);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ config: reviewer model \(claude\) — the reviewer role runs at class `full`, which pins no Claude model[\s\S]*fix: set `classes\.full\.claude\.model`/);
  const pinned = singleRepoProject('doctor-pinned', { gate: { steps }, roles: { reviewer: { class: 'full' } }, classes: { full: { claude: { model: 'some-model' } } } });
  ok(wf(pinned.root, ['doctor', '--no-steps']));
  const noPlanner = singleRepoProject('doctor-noplanner', { gate: { steps }, roles: { planner: false } });
  assert.doesNotMatch(ok(wf(noPlanner.root, ['doctor', '--no-steps'])).out, /planner model/);
});

// Named failure (I-25): a plan's doNotRun banned one repo's suites ("no source changes there"); the ticket later changed that
// repo, the ban stayed, and a stale public-API test reached review. 0.7.0: doNotRun is accepted but is no restriction (it
// banned suites a change needed), so nothing is warned about; an externalServices restriction still is.
test('I-25: a plan externalServices restriction that names a repo or suite the diff now touches is warned about at handoff and amendment; doNotRun restricts and warns of nothing', () => {
  const a = admitted('restrictions');
  const plan = goodPlan();
  plan.plan.doNotRun = ['the app suites (no source changes there)', 'full e2e'];
  plan.plan.externalServices = 'never call the unit sandbox';
  ok(a.plan(plan));
  const before = ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i', '--attempt', a.id]));
  assert.doesNotMatch(before.err, /warning: plan/, 'nothing changed yet');
  commitIn(a.wt, { 'src/table.js': 'export function renderTable(rows, pager) {\n  return rows;\n}\n' });
  const h = ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i2', '--attempt', a.id]));
  assert.doesNotMatch(h.err, /doNotRun/, 'a doNotRun entry naming the changed repo is no restriction, so no warning');
  assert.match(h.err, /warning: plan externalServices "never call the unit sandbox" names unit, but this attempt changes app, which step unit tests/);
  const m = ok(wf(a.root, ['criteria', 'amend', '--file', a.file({ impact: { unchanged: 'no new element' } }, 'amend'), '--reason', 'note', '--attempt', a.id]));
  assert.match(m.err, /warning: plan externalServices "never call the unit sandbox"/);
  assert.doesNotMatch(m.err, /doNotRun/);
  const rev = ok(wf(a.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', a.id]));
  assert.doesNotMatch(rev.out, /warning/, 'the reviewer prompt on stdout stays one line');
});

// Named failure (I-84, I-87): a plan `wf plan` refused left nothing behind, so the replacement planner started blind and made the
// same mistake. The refused report and the validator's message reach the next planner's bundle, and no other role's.
test('a refused plan and its validator message are handed to the next planner only', () => {
  const a = admitted('plan-refused');
  const refused = a.plan({ survey: survey(), ...design(), impact: impact({ consumers: { query: 'Q-consumers', hits: 99 } }) });
  assert.equal(refused.code, 75);
  const out = ok(wf(a.root, ['handoff', 'planner', '--agent', 'p2', '--attempt', a.id])).out;
  const bundle = JSON.parse(fs.readFileSync(out.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.equal(bundle.priorPlanRefusals.refusals.length, 1);
  const [r] = bundle.priorPlanRefusals.refusals;
  assert.equal(r.agent, 'p');
  assert.match(r.error, /99/);
  assert.match(fs.readFileSync(r.report, 'utf8'), /Q-consumers/, 'the refused report is kept unchanged');
  assert.match(bundle.priorPlanRefusals.note, /repo-relative/);
  ok(a.plan(goodPlan()));
  ok(wf(a.root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i', '--attempt', a.id]));
  assert.equal(state(a.root, a.id).planRefusals.length, 1);
});
