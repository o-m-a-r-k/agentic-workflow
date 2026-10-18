// 0.7.31 (I-217, D64, D65, D66), named failure (field): an evidence reviewer noted a low display anomaly (a due date shown with a
// clock time on one page and as a date on another). The owner recorded a decision with the person before any research, briefed a
// research agent on how such a date "should" be stored and shown, and asked the person, through the host's question panel and
// with no record, a question whose two options both built the change. The research said no production caller sets the field;
// the owner turned that into "no wrong data exists", and the implementer's brief and the reviewer repeated it. The low item became
// a reshape of four API DTOs and a new failure path, built in a fix round, and was reverted after the person asked whether anyone
// had done a proper analysis. Now: an implementer whose item's premise does not hold in production builds nothing for it and
// reports it; a reviewer judges a fix's premise as well as the fix; a product decision asked outside the engine is recorded with
// what it rests on and the person's own words; an owner's brief to an implementer is evidence; a plan's survey lists who writes
// the data; and a fix round or pass whose own commits change a contract or a critical boundary sends the course to the strategist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, goodClosure, ok, planDoc, sh, singleRepoProject, wf, writeReport } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true' }];
const LINES = 'l1\nl2\nl3\nl4\nl5\nl6\n';
// A plan that predicts enough rounds, files and minutes that no other course signal fires in these flows.
const EXPECT = { files: 10, rounds: 6, minutes: 600 };

function project(name, config = {}, files = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, { 'src/a.txt': LINES, 'src/b.txt': LINES, ...files });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-1', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(p.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(p.root, ['plan', '--file', plan, '--attempt', e.id]));
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}
const bundleOf = (r) => JSON.parse(fs.readFileSync((r.out.match(/^Read (\S+)/m) ?? r.out.match(/bundle: (\S+)/))[1], 'utf8'));
const resume = (p) => ok(wf(p.root, ['resume', '--attempt', p.id, '--json'])).json();
const record = (p, closure) => ok(wf(p.root, ['review', '--closure', closureFile(p.base, closure), '--attempt', p.id]));
const amend = (p, doc) => wf(p.root, ['criteria', 'amend', '--file', closureFile(p.base, doc), '--reason', 'one planned pass for what does not block', '--attempt', p.id]);
const low = (id, evidence) => ({ id, severity: 'low', summary: `${id}: the label reads oddly`, status: 'open', evidence });
const blocking = (id, evidence, extra = {}) => ({ id, severity: 'high', summary: `${id}: the total is wrong`, status: 'open', evidence, criterion: 'C1', ...extra });
const DUE = { what: 'the due date shows a clock time on the invoice page', where: 'src/b.txt:3', why: 'not caused by this change', severity: 'low' };
// The first implementer builds C1 and leaves the display item (D1); the first review is handed the tree.
function built(p, files = { 'src/a.txt': LINES.replace('l2', 'L2') }) {
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  commitIn(p.wt, files, 'implement C1');
  writeReport(p.root, p.id, 'i1', { left: [DUE] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id]));
}

test('an implementer whose item\'s premise does not hold in production builds nothing for it and reports why; no pass is handed it again, and it waits for a reviewer\'s verdict or the person', () => {
  const p = project('pm-route');
  built(p);
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label and the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id])));
  assert.match(b.instructions, /whether its premise holds in production/, 'the pass is told to establish each item\'s premise before it builds');
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 fixed') }, 'the label');
  const sha = sh(p.wt, 'git rev-parse HEAD').trim();
  writeReport(p.root, p.id, 'i2', {
    approach: 'traced who writes the due date before changing how it is shown',
    expect: { minutes: 20 },
    premises: [{ ref: 'r1:F1', holds: true, checked: ['src/a.txt:2 renders the label every user sees'] }],
    premiseFailed: [{ ref: 'D1', why: 'nothing in production writes the due date: only the specs set it, so no user sees the clock time', evidence: ['src/b.txt:3 is read only by the invoice page', 'no production writer: the one assignment is in a spec'] }],
  });
  const closed = ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  assert.match(closed.out, /i2 reports that the premise of D1 does not hold in production/);
  assert.match(closed.out, /nothing was built for it/);
  ok(wf(p.root, ['scope', 'fixed', '--finding', 'r1:F1', '--commit', sha, '--attempt', p.id]));
  let s = resume(p);
  const rep = s.implementerReports.at(-1);
  assert.deepEqual(rep.premiseFailed.map((x) => x.ref), ['D1']);
  assert.match(rep.premiseFailed[0].evidence.join(' '), /no production writer/);
  assert.deepEqual(rep.premises.map((x) => [x.ref, x.holds]), [['r1:F1', true]]);
  // The pass is built: the gate is next, and the step names the premise and its routes.
  assert.equal(s.decision.kind, 'gate');
  assert.match(s.next, /premise reported failed: D1 \(i2: nothing in production writes the due date/);
  assert.match(s.next, /the next reviewer is handed it and judges its premise/);
  assert.match(s.next, /`wf discovered close D1 --not-a-defect --reason "<why>"/);
  ok(wf(p.root, ['gate', '--attempt', p.id]));
  const ev = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.deepEqual(ev.premiseFailed.map((x) => [x.ref, x.kind, x.reportedBy]), [['D1', 'discovered', 'i2']]);
  assert.match(ev.premiseFailed[0].evidence.join(' '), /no production writer/);
  assert.match(ev.instructions, /`premiseFailed` lists items an implementer did not build because their premise does not hold in production/);
  // The reviewer gives it no verdict: the next step is not the acceptance and not another pass, but the premise's routes.
  record(p, goodClosure('r2'));
  record(p, goodClosure('r2', { priorFindings: [{ round: 'r1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:2 reads well' }] }));
  s = resume(p);
  assert.equal(s.decision.kind, 'premise');
  assert.match(s.next, /D1 \(i2: nothing in production writes the due date[^)]*\) was not settled by the review after it/);
  // The person decides it is not a defect (D38): it closes, and the acceptance is next.
  ok(wf(p.root, ['discovered', 'close', 'D1', '--not-a-defect', '--reason', 'nothing writes the due date in production', '--attempt', p.id]));
  assert.equal(resume(p).decision.kind, 'accept');
});

test('a reviewer judges the premise of a fix as well as the fix: one that does not hold settles the finding, one that holds sends the item back to be fixed', () => {
  const p = project('pm-verdict');
  built(p);
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2')] }));
  // The fix round: F1 blocks; D1 joins it. The implementer finds both premises false and builds neither.
  const fx = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  assert.deepEqual(fx.alsoFix.map((x) => x.ref), ['D1']);
  assert.match(fx.instructions, /whether its premise holds in production/);
  writeReport(p.root, p.id, 'i1', { approach: 'traced both premises; built nothing', expect: { minutes: 15 }, premiseFailed: [
    { ref: 'r1:F1', why: 'the total is computed only for an export no production path runs', evidence: ['src/a.txt:2'] },
    { ref: 'D1', why: 'nothing in production writes the due date', evidence: ['src/b.txt:3'] },
  ] });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  // It built nothing: the next step is a verdict on the premise, not another fix round for the same finding.
  const after = resume(p);
  assert.equal(after.decision.kind, 'premise');
  assert.match(after.next, /r1:F1 \(i1: the total is computed only for an export no production path runs[^)]*\) has not been judged by a review yet/);
  assert.match(after.next, /a fresh reviewer \(`wf handoff reviewer --agent <new id>/);
  assert.doesNotMatch(after.next, /fix the open findings/);
  // The delta reviewer is handed both premises, with the implementer's evidence.
  const d = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', p.id])));
  assert.deepEqual(d.premiseFailed.map((x) => [x.ref, x.kind]), [['r1:F1', 'finding'], ['D1', 'discovered']]);
  // F1's premise does not hold (a verified non-issue, with its premise line); D1's does (open: it goes back to be fixed).
  record(p, goodClosure('r2', {
    criteria: [],
    priorFindings: [{ round: 'r1', id: 'F1', status: 'verified-nonissue', evidence: 'src/a.txt:2', rationale: 'the premise behind the fix does not hold in production paths', premise: 'does not hold: no production path computes this total (src/a.txt:2 is reached only from a spec)' }],
    discovered: [{ id: 'D1', verdict: 'open', evidence: 'src/b.txt:3 is written by the nightly import', premise: 'holds: the nightly import writes the due date with a clock time' }],
  }));
  const s = resume(p);
  assert.equal(s.decision.kind, 'pass', 'D1 is back with the work that does not block');
  assert.deepEqual(s.decision.outstanding, ['D1']);
  assert.doesNotMatch(s.next, /premise reported failed/);
  ok(amend(p, { pass: [{ items: ['D1'], why: 'the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  const pass = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i3', '--work', 'P1', '--attempt', p.id])));
  const f1 = pass.findingHistory.find((h) => h.ref === 'r1:F1');
  assert.equal(f1.status, 'verified-nonissue');
  assert.match(f1.premise, /does not hold: no production path computes this total/, 'the history carries the premise line of the verdict that settled it');
});

// The person's words are proven theirs (D41), as a reading of an answer is.
const CLAUDE = 'c1aude00-0000-4000-8000-00000000dec1';
const personWrites = (p, text, offsetMs = 1000) => {
  const file = path.join(p.base, '.home', '.claude', 'projects', 'proj', `${CLAUDE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const when = (ms) => new Date(Date.now() + ms).toISOString();
  fs.appendFileSync(file, [{ type: 'assistant', timestamp: when(offsetMs - 500), message: { role: 'assistant', content: [{ type: 'text', text: 'Should the due date show only the date on every page?' }] } }, { type: 'user', timestamp: when(offsetMs), message: { role: 'user', content: text } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const session = { env: { CLAUDE_CODE_SESSION_ID: CLAUDE } };

test('a product decision asked outside the engine is recorded with its question, recommendation, basis and the person\'s own words, shown in resume and handed to later roles', () => {
  const p = project('pm-decide');
  const asked = ['--question', 'Should the due date show only the date on every page?', '--recommend', 'Only the date: it is a calendar day, not an instant', '--basis', 'traced the two pages that show it (src/a.txt:2, src/b.txt:3)'];
  const decide = (extra) => wf(p.root, ['decide', ...asked, '--not-checked', 'who writes the due date in production; what reads it besides the two pages', ...extra, '--attempt', p.id], session);
  // What was not checked is part of the record: without it nothing is recorded.
  const bare = wf(p.root, ['decide', ...asked, '--choice', 'Only the date', '--quote', 'only the date please', '--attempt', p.id], session);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--not-checked/);
  // Words the person never wrote are not recorded as theirs.
  personWrites(p, 'looks fine');
  const unproven = decide(['--choice', 'Only the date', '--quote', 'only the date please']);
  assert.equal(unproven.code, 75);
  assert.match(unproven.err, /not recorded: "only the date please" is in no message of the person's in this session/);
  personWrites(p, 'ok, only the date please, on both pages', 2000);
  const rec = ok(decide(['--choice', 'Only the date', '--quote', 'only the date please']));
  assert.match(rec.out, /product decision PD1 recorded on PM-1\.1/);
  const s = resume(p);
  const pd = s.productDecisions[0];
  assert.deepEqual([pd.id, pd.choice, pd.quote], ['PD1', 'Only the date', 'only the date please']);
  assert.match(pd.notChecked, /who writes the due date in production/);
  assert.match(pd.via, /^chat, read by the agent/);
  const text = ok(wf(p.root, ['resume', '--attempt', p.id])).out;
  assert.match(text, /product decision PD1: "Should the due date show only the date on every page\?" -> "Only the date" \(their words: "only the date please"\)/);
  assert.match(text, /not checked: who writes the due date in production/);
  // The same record from a file: what the agent asked, word for word.
  const file = path.join(p.base, 'decision.json');
  fs.writeFileSync(file, JSON.stringify({ question: 'Should the reminder go out on the due day?', recommend: 'Yes, on the due day', basis: 'traced the reminder job (src/a.txt:4)', notChecked: 'the time zone it runs in', choice: 'Yes, on the due day', quote: 'only the date please' }));
  assert.match(ok(wf(p.root, ['decide', '--file', file, '--attempt', p.id], session)).out, /product decision PD2 recorded/);
  // Later roles are handed it: the implementer with the person's words, a blind reviewer without them.
  const impl = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id])));
  assert.deepEqual(impl.decisions.map((x) => [x.id, x.choice, x.quote]), [['PD1', 'Only the date', 'only the date please'], ['PD2', 'Yes, on the due day', 'only the date please']]);
  assert.match(impl.decisions[0].notChecked, /who writes the due date/);
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const rev = bundleOf(ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', p.id])));
  assert.equal(rev.decisions[0].id, 'PD1');
  assert.equal(rev.decisions[0].quote, undefined, 'a blind reviewer gets the decision and its basis, not the words');
  // The analysis changes the picture: the decision is withdrawn with what changed, and says so where it was shown.
  ok(wf(p.root, ['decide', 'withdraw', 'PD1', '--reason', 'the trace found nothing writes the due date in production', '--attempt', p.id]));
  assert.match(resume(p).productDecisions[0].withdrawn.reason, /nothing writes the due date/);
  assert.match(ok(wf(p.root, ['resume', '--attempt', p.id])).out, /product decision PD1 \(withdrawn: the trace found nothing writes the due date in production\)/);
});

test('an owner\'s brief to an implementer is evidence: recorded with the handoff and in its bundle; a reviewer stays blind', () => {
  const p = project('pm-context');
  const brief = path.join(p.base, 'brief.md');
  fs.writeFileSync(brief, 'The research found no production caller sets the due date; only specs do. Check that before you build anything.\n');
  const b = bundleOf(ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--context-file', brief, '--attempt', p.id])));
  assert.match(b.ownerContext, /no production caller sets the due date/);
  assert.match(b.instructions, /`ownerContext` is what the owner carried to you/);
  assert.match(resume(p).handoffs.filter((x) => x.role === 'implementer').at(-1).context, /no production caller sets the due date/);
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2') }, 'implement C1');
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const refused = wf(p.root, ['handoff', 'reviewer', '--agent', 'r1', '--context', 'look at the due date', '--attempt', p.id]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /a reviewer is started blind/);
});

test('a plan\'s survey lists who writes the data beside who reads it: each producer is a query the engine re-runs', () => {
  const p = singleRepoProject('pm-producers', { gate: { steps } }, { 'src/a.txt': LINES });
  const e = ok(wf(p.root, ['entry', '--item', 'PM-2', '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const doc = (hits) => {
    const d = planDoc({ plan: { summary: 'show the due date as a date', expect: EXPECT, anchors: ['src/a.txt'] }, criteria: [{ id: 'C1', text: 'the due date shows as a date', uat: 'the invoice page shows a date' }] });
    d.survey.queries.push({ id: 'QW', pattern: 'dueAt =', kind: 'literal', paths: ['src/**'], hits });
    d.survey.producers = [{ id: 'SW', symbol: 'dueAt', query: 'QW', hits, absent: 'the page shows no due date; reminders key off the period end' }];
    d.impact.changes[0].covers.push('SW');
    return d;
  };
  const wrong = wf(p.root, ['plan', '--file', closureFile(p.base, doc(3)), '--attempt', e.id]);
  assert.equal(wrong.code, 75, 'a producer count the engine does not find is refused, as every survey count is');
  assert.match(wrong.err, /survey\.producers\[0\] \(SW\)/);
  ok(wf(p.root, ['plan', '--file', closureFile(p.base, doc(0)), '--attempt', e.id]));
  const producer = ok(wf(p.root, ['resume', '--attempt', e.id, '--json'])).json().impact.survey.producers[0];
  assert.deepEqual([producer.id, producer.hits], ['SW', 0], 'no production writer is a recorded fact, not an inference');
  assert.match(producer.absent, /reminders key off the period end/);
});

const API = { components: [{ id: 'api', kind: 'service', repo: 'app', provides: [{ contract: 'http', spec: 'openapi.json' }] }] };

test('a fix round whose own commits change a contract, for an item with no stated fix, makes the strategist the next step; the first build of the planned work does not', () => {
  const p = project('pm-reach', API, { 'openapi.json': '{"paths":{}}\n' });
  built(p, { 'src/a.txt': LINES.replace('l2', 'L2'), 'openapi.json': '{"paths":{"/a":{}}}\n' });
  record(p, goodClosure('r1', { findings: [blocking('F1', 'src/a.txt:2', { fix: { what: 'round the total once', minutes: 60 } })] }));
  assert.equal(resume(p).decision.kind, 'repair', 'the planned work changing its own contract is no signal');
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i1', '--attempt', p.id]));
  const h = resume(p).handoffs.filter((x) => x.role === 'implementer').at(-1);
  assert.deepEqual(h.fixes, { repair: ['r1:F1'], alsoFix: ['D1'], unbounded: ['D1'] });
  // It fixes F1 and, for the low item with no stated fix, reshapes the endpoint's contract. It expects exactly twice the stated
  // fix, which the implementer-estimate signal does not count.
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 rounded'), 'openapi.json': '{"paths":{"/a":{"dueDate":"date"}}}\n' }, 'fix F1; the due date as a date');
  writeReport(p.root, p.id, 'i1', { approach: 'round once; send the due date as a date', expect: { minutes: 120 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i1', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['reach']);
  assert.match(s.next, /the fix round of implementer i1 changed the contract openapi\.json/);
  assert.match(s.next, /1 handed item with no stated fix \(unbounded\): D1/);
  assert.match(ok(wf(p.root, ['signals', '--attempt', p.id])).out, /the fix round of implementer i1 changed the contract openapi\.json/);
  // The strategist answers it; the premise its decision rests on is recorded with it.
  const st = ok(wf(p.root, ['handoff', 'strategist', '--agent', 's1', '--attempt', p.id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(st.bundle, 'utf8')).courseSignals.map((x) => x.id), ['reach']);
  const f = path.join(p.base, 's1.json');
  fs.writeFileSync(f, JSON.stringify({ strategist: 's1', action: 'continue', rationale: 'the person asked for the contract change', prediction: { signal: 'blockingLatest <= 1', by: 3 }, expect: { files: 5, rounds: 2, minutes: 120 }, premise: { shared: 'the due date is written in production', traced: 'the two pages that show it', notTraced: 'who writes it' } }));
  ok(wf(p.root, ['strategy', 'record', '--closure', f, '--attempt', p.id]));
  const after = resume(p);
  assert.notEqual(after.decision.kind, 'strategy', 'its decision answers the signal');
  assert.match(after.strategy.decisions.at(-1).premise.notTraced, /who writes it/);
});

test('a planned pass whose own commits add a migration makes the strategist the next step', () => {
  const p = project('pm-reach-migration');
  built(p);
  record(p, goodClosure('r1', { findings: [low('F1', 'src/a.txt:2')] }));
  ok(amend(p, { pass: [{ items: ['r1:F1', 'D1'], why: 'the label and the due date', repos: ['app'] }], expect: { minutes: 30, rounds: 1 } }));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i2', '--work', 'P1', '--attempt', p.id]));
  commitIn(p.wt, { 'src/a.txt': LINES.replace('l2', 'L2 fixed'), 'db/migrations/002_due_date.sql': 'alter table invoice alter column due type date;\n' }, 'the pass');
  writeReport(p.root, p.id, 'i2', { approach: 'store the due date as a date', expect: { minutes: 30 } });
  ok(wf(p.root, ['handoff', 'close', '--agent', 'i2', '--attempt', p.id]));
  const s = resume(p);
  assert.equal(s.decision.kind, 'strategy', 'not the gate: the pass reached a critical boundary');
  assert.deepEqual(s.decision.courseSignals.map((x) => x.id), ['reach']);
  assert.match(s.next, /the planned pass of implementer i2 added or changed a migration \(db\/migrations\/002_due_date\.sql\)/);
});
