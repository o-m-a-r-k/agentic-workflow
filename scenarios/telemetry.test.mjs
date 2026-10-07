// Telemetry (I-24): review-round, gate-stop, implementer, sub-agent, scope and failing-test events, and `wf report`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, sh, singleRepoProject, state, wf, write, ownerSpeaks, spawnHome } from './helpers.mjs';
import { logFailures, playwrightJsonFailures, junitFailures } from '../engine/failures.mjs';
import { REPORT_SCHEMA, priceOf, prices, timeline } from '../engine/telemetry.mjs';

function admitted(root, base, item) {
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  return e;
}
const reportJson = (root, extra = []) => JSON.parse(ok(wf(root, ['report', '--json', ...extra])).out);
const fixCommit = (wt, file, content, trailer) => {
  write(wt, file, content);
  sh(wt, `git add -A && git commit -q -m fix -m ${JSON.stringify(trailer)}`);
  return sh(wt, 'git rev-parse HEAD');
};
const finding = (id, severity) => ({ id, severity, summary: `${id} is wrong`, status: 'open', evidence: 'src/a.txt:1' });

test('wf report counts every finding and repair round over several review rounds, and records each round (I-24)', () => {
  const { base, root } = singleRepoProject('tel-rounds', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const e = admitted(root, base, 'TEL-1');
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': 'one\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  // Round 1 on a green tree: one major and one minor finding.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { findings: [finding('F1', 'major'), finding('F2', 'minor')] })), '--attempt', e.id]));
  const fix1 = fixCommit(wt, 'src/a.txt', 'two\n', 'Fixes-finding: rev-1:F1, rev-1:F2');
  // Round 2 (no gate on this tree): one new finding, then the prior two verified.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', e.id]));
  const c2 = goodClosure('rev-2', { findings: [finding('F1', 'minor')] });
  ok(wf(root, ['review', '--closure', closureFile(base, c2), '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { ...c2, priorFindings: [{ round: 'rev-1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1' }, { round: 'rev-1', id: 'F2', status: 'fixed', evidence: 'src/a.txt:1' }] }), '--attempt', e.id]));
  // Round 3 is refused: the tree changed while it reviewed.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', e.id]));
  const fix2 = fixCommit(wt, 'src/a.txt', 'three\n', 'Fixes-finding: rev-2:F1');
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3')), '--attempt', e.id]);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /worktree changed during the review round/);
  // The same refusal again is not a second round.
  assert.equal(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3')), '--attempt', e.id]).code, 75);
  // Round 4: clean, verifies the last open finding.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-4', '--attempt', e.id]));
  const c4 = goodClosure('rev-4');
  ok(wf(root, ['review', '--closure', closureFile(base, c4), '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, { ...c4, priorFindings: [{ round: 'rev-2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1' }] }), '--attempt', e.id]));

  const s = state(root, e.id);
  const events = s.reviewRounds;
  assert.deepEqual(events.map((r) => [r.agent, r.outcome]), [['rev-1', 'recorded'], ['rev-2', 'recorded'], ['rev-2', 'recorded'], ['rev-3', 'refused'], ['rev-4', 'recorded'], ['rev-4', 'recorded']]);
  const r1 = events[0];
  assert.equal(r1.gatePassedOnTree, true);
  assert.equal(r1.tree.app.length, 40, 'the commit the reviewer judged');
  assert.deepEqual(r1.findings.map((f) => [f.id, f.severity]), [['F1', 'major'], ['F2', 'minor']]);
  assert.deepEqual(r1.openImplementers, [], 'impl-1 was closed before the round');
  assert.equal(events[1].gatePassedOnTree, false);
  assert.deepEqual(events[2].priorFindings.map((p) => [p.round, p.id, p.fixedIn]), [['rev-1', 'F1', fix1], ['rev-1', 'F2', fix1]], 'the fix commit, from the Fixes-finding trailer');
  assert.equal(events[3].reasonClass, 'tree-changed');

  const r = reportJson(root).attempts.find((x) => x.id === e.id);
  assert.equal(r.findings, 3, 'every finding of every round, not the last closure only');
  assert.deepEqual(r.findingsBySeverity, { major: 1, minor: 2 });
  assert.equal(r.findingsOpen, 0);
  assert.equal(r.repairRounds, 2, 'two rounds raised findings to fix');
  assert.deepEqual([r.reviewRounds, r.recordedRounds, r.refusedRounds, r.wastedReviewerRounds, r.roundsWithGreenGate, r.roundsOnUnsettledTree], [4, 3, 1, 1, 1, 0]);
  assert.equal(r.findingList.find((f) => f.round === 'rev-2' && f.id === 'F1').fixedIn, fix2);
  assert.deepEqual(r.rounds.map((x) => x.outcome), ['recorded', 'recorded', 'refused', 'recorded']);
  assert.deepEqual(r.implementers, { opened: 1, closed: 1, open: [] });
  assert.equal(r.gates.passed, 1);

  const text = ok(wf(root, ['report'])).out;
  assert.match(text, /review: 4 round\(s\), 3 recorded, 1 refused, 0 abandoned \(1 wasted/);
  assert.match(text, /findings: 3 \(major 1, minor 2\), 0 not yet verified fixed/);
  assert.match(text, /phases \(min\): planning [\d.]+, implementing/);
  const csv = path.join(base, 'r.csv');
  ok(wf(root, ['report', '--csv', csv]));
  const [head, row] = fs.readFileSync(csv, 'utf8').trim().split('\n');
  const cols = head.split(',');
  const cell = (name) => row.split(',')[cols.indexOf(name)];
  assert.deepEqual([cell('findings'), cell('repairRounds'), cell('reviewRounds'), cell('refusedRounds')], ['3', '2', '4', '1']);
});

test('wf stop records the reason class, the step in flight, discarded minutes and an open reviewer (I-24)', async () => {
  const steps = [{ id: 'slow', repo: 'app', run: 'sleep 30', inputs: ['src/**'] }];
  const { base, root } = singleRepoProject('tel-stop', { gate: { steps } });
  const e = admitted(root, base, 'TEL-2');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_EVIDENCE_FLAGS: '0' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k]; // no agent runtime: the scenario is the owner at a terminal (engine/owner.mjs)
  ownerSpeaks(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]);
  const child = spawn(process.execPath, [WF, 'gate', ...OUT_OF_ORDER, '--attempt', e.id], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  for (let i = 0; i < 200 && !/start\s+slow/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /start\s+slow/);
  // Slow by design (CONTRIBUTING.md, "Running the suite"): the step must have run for a measurable time before the stop.
  await new Promise((r) => setTimeout(r, 1200));
  const bad = wf(root, ['stop', '--reason', 'x', '--class', 'bored', '--attempt', e.id]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--class is required: one of major-finding, tree-change, owner-decision/);
  ok(wf(root, ['stop', '--reason', 'findings came back', '--class', 'major-finding', '--attempt', e.id]));
  await exited;
  const s = state(root, e.id);
  const stop = s.stops.at(-1);
  assert.equal(stop.reason, 'findings came back');
  assert.equal(stop.class, 'major-finding');
  assert.equal(stop.reviewerOpen, true, 'a reviewer was handed the attempt and had not recorded');
  assert.deepEqual(stop.stepsInFlight.map((x) => x.id), ['slow']);
  assert.ok(stop.stepsInFlight[0].seconds >= 1, JSON.stringify(stop));
  assert.ok(stop.discardedSeconds >= 1 && stop.wallSeconds >= stop.discardedSeconds, JSON.stringify(stop));
  assert.equal(stop.discardedMinutes, Math.round(stop.discardedSeconds / 6) / 10);
  const r = reportJson(root).attempts[0];
  assert.deepEqual([r.gates.started, r.gates.stopped, r.gates.stops, r.gates.stoppedDuringReview, r.gates.stopClasses], [1, 1, 1, 1, { 'major-finding': 1 }]);
  assert.equal(r.gates.stepsInterrupted, 1);
});

test('wf handoff close records the implementer and attributes its sub-agents; cost per handoff from the price table (I-24)', () => {
  const { base, root } = singleRepoProject('tel-subagents', { gate: { steps: [] } });
  const e = admitted(root, base, 'TEL-3');
  const h = state(root, e.id).handoffs.find((x) => x.role === 'implementer');
  const dir = path.join(root, '..', '.home', '.claude', 'projects', '-p', 'sess', 'subagents');
  const at = new Date(Date.now() + 1000).toISOString();
  const usage = (model, u) => JSON.stringify({ type: 'assistant', timestamp: at, requestId: `${model}-${u.output_tokens}`, message: { model, usage: u, content: [] } });
  write(dir, 'agent-p1.meta.json', JSON.stringify({ name: 'impl-1', agentType: h.agentType }));
  write(dir, 'agent-p1.jsonl', usage('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000 }));
  write(dir, 'agent-c1.meta.json', JSON.stringify({ name: 'cards-a', agentType: 'wf-implementer', parentAgentId: 'p1', spawnDepth: 2 }));
  write(dir, 'agent-c1.jsonl', usage('claude-sonnet-5-5-20260101', { input_tokens: 1000, output_tokens: 1000 }));
  write(dir, 'agent-c2.meta.json', JSON.stringify({ agentType: 'general-purpose', parentAgentId: 'c1', spawnDepth: 3 }));
  write(dir, 'agent-c2.jsonl', usage('model-x', { input_tokens: 1000000, output_tokens: 0 }));
  // Someone else's sub-agent: never attributed.
  write(dir, 'agent-z9.meta.json', JSON.stringify({ name: 'other', agentType: 'wf-implementer', parentAgentId: 'zz' }));
  write(dir, 'agent-z9.jsonl', usage('claude-opus-5-5', { input_tokens: 5, output_tokens: 5 }));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'one\n' });
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'two\n' });
  assert.match(wf(root, ['handoff', 'close', '--agent', 'nobody', '--attempt', e.id]).err, /no open implementer `nobody`/);
  const closed = ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--outcome', 'done', '--attempt', e.id]));
  assert.match(closed.out, /2 sub-agent\(s\) attributed to 02-implementer/);
  assert.match(closed.out, /every implementer is closed/);
  const s = state(root, e.id);
  assert.deepEqual(s.implementers.map((x) => [x.agent, x.handoff, x.outcome, x.commits.app]), [['impl-1', '02-implementer', 'done', 2]]);
  assert.deepEqual(s.subagents.map((x) => [x.agentId, x.parentHandoff, x.depth]), [['c1', '02-implementer', 2], ['c2', '02-implementer', 3]]);
  // A project price for a model the default table does not know.
  write(root, '.workflow/prices.yaml', 'models:\n  model-x: { input: 1, output: 1 }\n');
  assert.deepEqual(priceOf(prices(root), 'claude-sonnet-5-5-20260101'), priceOf(prices(), 'claude-sonnet-5-5'), 'a dated id finds its family');
  const r = reportJson(root).attempts[0];
  const impl = r.roles.find((x) => x.role === 'implementer');
  assert.equal(impl.cost, 0.046, 'opus 5.5: 1000 in x $4 + 2000 out x $20 + 10000 cache reads x $0.20 per million');
  assert.deepEqual(impl.children.map((c) => [c.agentId, c.name, c.depth, c.cost]), [['c1', 'cards-a', 2, 0.012], ['c2', null, 3, 1]]);
  assert.equal(impl.childCost, 1.012);
  assert.equal(r.cost, 1.058);
  assert.deepEqual(Object.keys(r.tokensByModel).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5-20260101', 'model-x']);
  assert.equal(r.tokensByModel['claude-opus-5-5'].output, 2000);
  assert.equal(r.subagentTokens, 1002000);
  assert.deepEqual(r.unpricedModels, []);
  fs.rmSync(path.join(root, '.workflow', 'prices.yaml'));
  const r2 = reportJson(root).attempts[0];
  assert.deepEqual(r2.unpricedModels, ['model-x'], 'without a price the model is listed, not guessed');
  assert.equal(r2.cost, 0.058);
});

test('a criteria amendment records its scope change; a malformed scope is refused (I-24)', () => {
  const { base, root } = singleRepoProject('tel-scope', { gate: { steps: [] } });
  const e = admitted(root, base, 'TEL-4');
  const amend = (doc) => {
    const f = path.join(base, `amend-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(doc));
    return wf(root, ['criteria', 'amend', '--file', f, '--reason', 'the owner ruled every found issue is fixed here', '--attempt', e.id]);
  };
  const bad = amend({ criteria: [{ id: 'C2', text: 'two' }], scope: { endpoints: 'lots' } });
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /scope\.endpoints` must be a count/);
  ok(amend({ criteria: [{ id: 'C2', text: 'two' }, { id: 'C3', text: 'three' }], scope: { endpoints: ['PATCH /invoices/:id', 'GET /totals'], errorCodes: 5, repos: 1 } }));
  ok(amend({ criteria: [{ id: 'C1', text: 'one, reworded' }] }));
  const s = state(root, e.id);
  assert.deepEqual(s.scopeChanges.map((x) => [x.amendment, x.criteria.before, x.criteria.after, x.criteria.added, x.criteria.changed, x.endpoints, x.errorCodes, x.repos]), [[1, 1, 3, 2, 0, 2, 5, 1], [2, 3, 3, 0, 1, null, null, null]]);
  assert.deepEqual(s.scopeChanges[0].stated.endpoints, ['PATCH /invoices/:id', 'GET /totals']);
  const r = reportJson(root).attempts[0];
  assert.deepEqual(r.scope, { amendments: 2, criteriaAdded: 2, criteriaChanged: 1, criteriaDropped: 0, endpoints: 2, errorCodes: 5, repos: 1 });
  assert.equal(r.criteriaAtFreeze, 1);
});

test('a failed gate step records its failing test names (Jest, JUnit, Playwright JSON) or exit code and last lines (I-24)', () => {
  const jest = "console.log('FAIL src/a.test.ts');console.log('  ● Totals › sums the filtered rows');console.log('  ● Totals › keeps the pager');process.exit(1);";
  const junit = "require('fs').writeFileSync(process.env.WF_EVIDENCE+'/j.xml','<testsuites><testsuite name=\"s\"><testcase name=\"keeps order\" classname=\"Reorder\"><failure/></testcase><testcase name=\"ok\"/></testsuite></testsuites>');process.exit(1);";
  const pw = "require('fs').writeFileSync(process.env.WF_EVIDENCE+'/pw.json',JSON.stringify({suites:[{title:'a.spec.ts',file:'a.spec.ts',specs:[{title:'pager stays',ok:false,line:12},{title:'fine',ok:true}],suites:[{title:'cards',specs:[{title:'fit',ok:false,file:'a.spec.ts',line:30}]}]}]}));process.exit(1);";
  const opaque = "console.log('starting');console.log('Error: connection refused');process.exit(3);";
  const steps = [
    { id: 'jest', repo: 'app', run: 'node jest.cjs', inputs: ['src/**'] },
    { id: 'junit', repo: 'app', run: 'node junit.cjs', report: { junit: '{evidence}/j.xml' }, inputs: ['src/**'] },
    { id: 'pw', repo: 'app', run: 'node pw.cjs', report: { playwright: '{evidence}/pw.json' }, inputs: ['src/**'] },
    { id: 'opaque', repo: 'app', run: 'node opaque.cjs', inputs: ['src/**'] },
  ];
  const { base, root } = singleRepoProject('tel-failures', { gate: { steps } }, { 'jest.cjs': jest, 'junit.cjs': junit, 'pw.cjs': pw, 'opaque.cjs': opaque });
  const e = admitted(root, base, 'TEL-5');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'x\n' });
  assert.equal(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]).code, 1);
  const g = state(root, e.id).gates.at(-1);
  const f = Object.fromEntries(g.steps.map((x) => [x.id, x.failures]));
  assert.deepEqual([f.jest.source, f.jest.tests], ['jest', ['Totals › sums the filtered rows', 'Totals › keeps the pager']]);
  assert.deepEqual([f.junit.source, f.junit.tests], ['junit', ['Reorder › keeps order']]);
  assert.deepEqual([f.pw.source, f.pw.tests], ['playwright-json', ['a.spec.ts:12 › pager stays', 'a.spec.ts:30 › cards › fit']]);
  assert.deepEqual([f.opaque.source, f.opaque.tests, f.opaque.exitCodes], ['exit-code', [], [3]]);
  assert.equal(f.opaque.tail.at(-1), 'Error: connection refused');
  const r = reportJson(root).attempts[0];
  assert.deepEqual(r.failingTests.map((x) => [x.step, x.total]), [['jest', 2], ['junit', 1], ['pw', 2], ['opaque', 0]]);
  assert.match(ok(wf(root, ['report'])).out, /failed opaque \([^)]+\): exit 3: Error: connection refused/);
});

test('failure parsers read node:test, Playwright list output and JUnit names', () => {
  assert.deepEqual(logFailures('▶ totals\n  ✔ adds (1ms)\n  ✖ keeps the pager (2.5ms)\n✖ failing tests:\n\ntest at a.test.mjs:3:1\n✖ keeps the pager (2.5ms)\n'), { source: 'node-test', names: ['keeps the pager'] });
  assert.deepEqual(logFailures('TAP version 13\nok 1 - a\nnot ok 2 - b fails # time=3ms\n'), { source: 'node-test', names: ['b fails'] });
  assert.deepEqual(logFailures('  1) [chromium] › tests/a.spec.ts:3:5 › list › pager stays ───────────\n'), { source: 'playwright', names: ['tests/a.spec.ts:3:5 › list › pager stays'] });
  assert.equal(logFailures('all good\n'), null);
  assert.deepEqual(junitFailures('<testcase name="x &amp; y" file="t.js"><error/></testcase><testcase name="z"/>'), ['t.js › x & y']);
  assert.deepEqual(playwrightJsonFailures({ suites: [] }), []);
});

test('wf report phases: each minute in one phase, idle gaps above the threshold; --json has a versioned schema (I-24)', () => {
  const t = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const ev = (m, type, data = {}) => ({ at: t(m), type, data });
  const entries = [
    ev(0, 'admitted', { id: 'X.1', item: 'X', lane: 'standard', repos: {} }),
    ev(0, 'handoff', { role: 'planner', agent: 'p', bundle: '/h/01-planner.json' }),
    ev(10, 'criteria.frozen', { criteria: [{ id: 'C1' }] }),
    ev(10, 'handoff', { role: 'implementer', agent: 'i', bundle: '/h/02-implementer.json' }),
    ev(60, 'handoff', { role: 'reviewer', agent: 'r1', bundle: '/h/03-reviewer.json', gate: null }),
    ev(60, 'gate.started', { runId: 'g1', kind: 'gate' }),
    ev(80, 'review.recorded', { handoff: '/h/03-reviewer.json', closure: { reviewer: 'r1', findings: [{ id: 'F1', severity: 'major', status: 'open' }] } }),
    ev(90, 'gate.stopped', { runId: 'g1', reason: 'findings', class: 'major-finding', discardedMinutes: 25 }),
    ev(90, 'gate.finished', { runId: 'g1', status: 'stopped', steps: [] }),
    ev(210, 'handoff', { role: 'reviewer', agent: 'r2', bundle: '/h/04-reviewer.json', gate: null }),
    ev(230, 'review.recorded', { handoff: '/h/04-reviewer.json', closure: { reviewer: 'r2', findings: [] } }),
    ev(230, 'review.accepted', {}),
    ev(240, 'closed', {}),
  ];
  const tl = timeline(entries, { idleMinutes: 30 });
  assert.deepEqual(tl.phases, { minutes: { planning: 10, implementing: 50, gating: 10, reviewing: 40, fixing: 120, delivering: 10 }, totalMinutes: 240 });
  assert.deepEqual(tl.idleGaps.map((g) => [g.minutes, g.phase, g.after]), [[120, 'fixing', 'gate.finished'], [50, 'implementing', 'handoff']]);
  assert.deepEqual(timeline(entries, { idleMinutes: 200 }).idleGaps, []);

  const { base, root } = singleRepoProject('tel-json', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  admitted(root, base, 'TEL-6');
  const doc = reportJson(root, ['--idle-minutes', '0.0001']);
  assert.equal(doc.schema, REPORT_SCHEMA);
  const a = doc.attempts[0];
  for (const k of ['phases', 'wallMinutes', 'idleGaps', 'gates', 'checks', 'failingTests', 'repairRounds', 'reviewRounds', 'refusedRounds', 'wastedReviewerRounds', 'rounds', 'findings', 'findingsBySeverity', 'findingList', 'scope', 'implementers', 'tokensByModel', 'tokens', 'subagentTokens', 'cost', 'unpricedModels', 'roles']) assert.ok(k in a, `report --json has ${k}`);
  assert.ok(a.idleGaps.length > 0, 'a tiny threshold lists the gaps between ledger events');
  assert.ok(!('usage' in a.roles[0]), 'raw usage (transcript paths) stays out of the JSON');
  assert.notEqual(wf(root, ['report', '--idle-minutes', '0']).code, 0);
});
