// Telemetry (I-24): review-round, gate-stop, implementer, sub-agent, scope and failing-test events, and `wf report`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, planDoc, sh, singleRepoProject, state, wf, write, writeReport, ownerSpeaks, spawnHome } from './helpers.mjs';
import { logFailures, playwrightJsonFailures, junitFailures } from '../engine/failures.mjs';
import { playwrightJsonSuites } from '../engine/junit.mjs';
import { BOOKKEEPING_EVENTS, REPORT_SCHEMA, agentUsage, costOf, priceOf, prices, strategyEvents, timeline } from '../engine/telemetry.mjs';

test('Codex usage treats cached input and reasoning as subsets rather than billing them twice', () => {
  // Named failure I-38: cached input and reasoning were added to totals that already included them.
  const p = singleRepoProject('codex-usage-subsets');
  const home = path.join(p.base, '.home');
  const sid = 'codex-usage-session';
  write(home, `.codex/sessions/rollout-${sid}.jsonl`, [
    { type: 'session_meta', payload: { id: sid, source: 'cli' } },
    { type: 'turn_context', payload: { model: 'audit-model' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000000, cached_input_tokens: 800000, output_tokens: 200000, reasoning_output_tokens: 50000 } } } },
  ].map(JSON.stringify).join('\n'));
  const u = agentUsage('codex', sid, home);
  assert.equal(u.input, 200000);
  assert.equal(u.cacheRead, 800000);
  assert.equal(u.output, 200000);
  assert.equal(u.reasoning, 50000);
  assert.equal(u.byModel['audit-model'].output, 200000);
  assert.equal(costOf(u, { 'audit-model': { input: 10, output: 20, cacheRead: 1 } }).cost, 6.8);
});

test('Codex usage reads the active indexed rollout and native thread snapshots without retained-rollout duplication', () => {
  // Named failure I-38: retained rollouts were summed, while native token_usage_record snapshots were ignored.
  const p = singleRepoProject('codex-usage-index');
  const home = path.join(p.base, '.home');
  const sid = 'codex-usage-indexed-session';
  const old = `.codex/sessions/rollout-${sid}.jsonl`;
  const current = `.codex/sessions/rollout-${sid}_new-segment.jsonl`;
  const meta = { type: 'session_meta', payload: { id: sid, source: 'cli' } };
  write(home, old, [meta, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9999999 } } } }].map(JSON.stringify).join('\n'));
  write(home, current, [meta, { type: 'turn_context', payload: { model: 'audit-model' } }, { type: 'token_usage_record', payload: { thread_id: sid, thread_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 50 } } }].map(JSON.stringify).join('\n'));
  const database = path.join(home, '.codex/state_5.sqlite');
  const active = path.join(home, current);
  let sqlite;
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } catch {}
  if (sqlite) {
    const db = new sqlite.DatabaseSync(database);
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(sid, active); db.close();
  } else {
    const r = spawnSync('python3', ['-I', '-c', 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)")\nc.execute("INSERT INTO threads VALUES (?, ?)",(sys.argv[2],sys.argv[3]))\nc.commit()\nc.close()', database, sid, active]);
    assert.equal(r.status, 0);
  }
  const u = agentUsage('codex', sid, home);
  assert.deepEqual(u.transcripts, [active]);
  assert.equal(u.input, 200);
  assert.equal(u.cacheRead, 800);
  assert.equal(u.output, 200);
  assert.equal(u.reasoning, 50);
});

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
  // Round 2 (no gate on this tree): one new finding, and the prior two verified in the same closure.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', e.id]));
  // rev-1 was handed a tree a gate had passed on, so it was this attempt's full audit (the first review and the first
  // evidence review in one); every round after it is a delta, handed the open findings up front.
  const c2 = goodClosure('rev-2', { findings: [finding('F1', 'minor')], priorFindings: [{ round: 'rev-1', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1' }, { round: 'rev-1', id: 'F2', status: 'fixed', evidence: 'src/a.txt:1' }] });
  ok(wf(root, ['review', '--closure', closureFile(base, c2), '--attempt', e.id]));
  // Round 3 is refused: the tree changed while it reviewed.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', e.id]));
  const fix2 = fixCommit(wt, 'src/a.txt', 'three\n', 'Fixes-finding: rev-2:F1');
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3')), '--attempt', e.id]);
  assert.equal(refused.code, 75, refused.err);
  assert.match(refused.err, /worktree changed during the review round/);
  // The same refusal again is not a second round.
  assert.equal(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-3')), '--attempt', e.id]).code, 75);
  // Round 4 is a delta review: it is handed the open finding, so one closure verifies it.
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-4', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-4', { priorFindings: [{ round: 'rev-2', id: 'F1', status: 'fixed', evidence: 'src/a.txt:1' }] })), '--attempt', e.id]));

  const s = state(root, e.id);
  const events = s.reviewRounds;
  assert.deepEqual(events.map((r) => [r.agent, r.outcome]), [['rev-1', 'recorded'], ['rev-2', 'recorded'], ['rev-3', 'refused'], ['rev-4', 'recorded']]);
  const r1 = events[0];
  assert.equal(r1.gatePassedOnTree, true);
  assert.equal(r1.tree.app.length, 40, 'the commit the reviewer judged');
  assert.deepEqual(r1.findings.map((f) => [f.id, f.severity]), [['F1', 'major'], ['F2', 'minor']]);
  assert.deepEqual(r1.openImplementers, [], 'impl-1 was closed before the round');
  assert.equal(events[1].gatePassedOnTree, false);
  assert.deepEqual(events[1].priorFindings.map((p) => [p.round, p.id, p.fixedIn]), [['rev-1', 'F1', fix1], ['rev-1', 'F2', fix1]], 'the fix commit, from the Fixes-finding trailer');
  assert.equal(events[2].reasonClass, 'tree-changed');
  assert.deepEqual(events.map((r) => r.mode), ['full', 'delta', 'delta', 'delta'], 'the first review (here also the evidence review) is the full audit, every round after it is a delta');

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
  assert.match(text, /review: 4 handoff\(s\), 3 recorded, 1 experienced refusal, 0 failed launch\(es\) \(0 before session start\), 0 unknown outcome\(s\)/);
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
  assert.deepEqual(logFailures('  1) [chromium] › tests/a.spec.ts:3:5 › list › pager stays ───────────\n'), { source: 'playwright', names: ['[chromium] › tests/a.spec.ts:3:5 › list › pager stays'] });
  // One test failing in two projects is two failures, in the log and in the JSON report (0.7.6, I-118: 612 read as 448).
  assert.equal(logFailures('  1) [en] › a.spec.ts:3:5 › t ───\n  2) [ar] › a.spec.ts:3:5 › t ───\n').names.length, 2);
  const twice = { suites: [{ file: 'a.spec.ts', specs: [{ title: 't', file: 'a.spec.ts', line: 3, ok: false, tests: [{ projectName: 'en', status: 'unexpected' }, { projectName: 'ar', status: 'unexpected' }, { projectName: 'mobile', status: 'expected' }] }] }] };
  assert.deepEqual(playwrightJsonFailures(twice), ['[en] › a.spec.ts:3 › t', '[ar] › a.spec.ts:3 › t']);
  assert.equal(playwrightJsonSuites(twice)[0].failures, 2);
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

// 0.7.0 (stream D): the report counts refusals, sizes bundles, keeps bookkeeping out of time and names unpriced models.

test('wf report counts the refusals logged against each attempt by check id, whether or not --attempt was typed (0.7.0)', () => {
  // Named failure: nothing counted refusals, so no check was ever measured (design principle 13) and no check was retired.
  const { base, root } = singleRepoProject('tel-refusals', { gate: { steps: [] } });
  const e = admitted(root, base, 'TEL-10');
  assert.equal(wf(root, ['release', '--attempt', e.id]).code, 75, 'only a closed or abandoned attempt is released');
  assert.equal(wf(root, ['release', '--attempt', e.id]).code, 75);
  // No --attempt typed: the only open attempt is found by the command and the refusal is still counted against it.
  assert.equal(wf(root, ['accept']).code, 75, 'nothing to accept yet');
  const rows = fs.readFileSync(path.join(base, 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.cmd, r.attempt, r.project]), [['release', e.id, 'proj'], ['release', e.id, 'proj'], ['accept', e.id, 'proj']]);
  const second = ok(wf(root, ['entry', '--item', 'TEL-11', '--owner', 'o', '--json'])).json();
  assert.equal(wf(root, ['release', '--attempt', second.id]).code, 75);
  const counts = Object.fromEntries(ok(wf(root, ['refusals', '--json'])).json().map((c) => [c.id, c.count]));
  const a = reportJson(root).attempts.find((x) => x.id === e.id);
  const b = reportJson(root).attempts.find((x) => x.id === second.id);
  assert.equal(a.refusalCount, 3);
  assert.equal(Object.values(a.refusalsById).reduce((n, x) => n + x, 0), 3);
  assert.equal(a.refusalsById[rows[0].id], 2, 'the same check twice');
  assert.equal(a.refusalsById[rows[2].id], 1);
  assert.deepEqual([b.refusalCount, Object.values(b.refusalsById)], [1, [1]], 'another attempt keeps its own count');
  assert.equal(counts[rows[0].id], 3, '`wf refusals` counts the check over every attempt');
  assert.match(ok(wf(root, ['report'])).out, new RegExp(`${e.id}[^\\n]*\\n(?:.*\\n)*?  refusals: 3 \\(`));
  const csv = path.join(base, 'refusals.csv');
  ok(wf(root, ['report', '--csv', csv]));
  const [head, ...lines] = fs.readFileSync(csv, 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => l.split(',')[head.split(',').indexOf('refusalCount')]).sort(), ['1', '3']);
});

test('bookkeeping ledger entries written long after the work do not extend wall time or create idle gaps (0.7.0)', () => {
  // Named failure: an evidence-baseline entry written days later made a 6-minute abandoned attempt report 4,403 minutes.
  const t = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const ev = (m, type, data = {}) => ({ at: t(m), type, data });
  const work = [
    ev(0, 'admitted', { id: 'X.1', item: 'X', lane: 'standard', repos: {} }),
    ev(1, 'handoff', { role: 'planner', agent: 'p', bundle: '/h/01-planner.json' }),
    ev(1, 'evidence.recorded', { files: [] }),
    ev(6, 'criteria.frozen', { criteria: [{ id: 'C1' }] }),
  ];
  const later = [ev(4403, 'evidence.baseline', { files: [] }), ev(4410, 'lesson.recurred', { id: 'L-1' }), ev(9000, 'evidence.rebaselined', { reason: 'x', changes: [] }), ev(9100, 'exported', { file: 'a' })];
  // Abandoned: the attempt ended at the abandon entry; the later entries do not count and create no gap.
  const abandoned = [...work, ev(6, 'abandoned', { reason: 'wrong ticket' }), ...later];
  const a = timeline(abandoned, { idleMinutes: 30 });
  assert.equal(a.end, t(6));
  assert.equal(a.phases.totalMinutes, 6);
  assert.deepEqual(a.idleGaps, []);
  // Never closed or abandoned: it ends at its last entry that records work.
  const open = timeline([...work, ...later], { idleMinutes: 30 });
  assert.equal(open.end, t(6));
  assert.equal(open.phases.totalMinutes, 6);
  assert.deepEqual(open.idleGaps, []);
  // Real work entries still count: a handoff three hours later is an idle gap and the end.
  const resumed = timeline([...work, ...later, ev(200, 'handoff', { role: 'implementer', agent: 'i', bundle: '/h/02-implementer.json' })], { idleMinutes: 30 });
  assert.equal(resumed.end, t(200));
  assert.deepEqual(resumed.idleGaps.map((g) => [g.minutes, g.after, g.before]), [[194, 'criteria.frozen', 'handoff']]);
  for (const type of ['evidence.baseline', 'evidence.recorded', 'evidence.rebaselined', 'lesson.recorded', 'lesson.recurred', 'lesson.acknowledged', 'authority.spent', 'discovered.acknowledged', 'models.refreshed', 'exported', 'screenshots.exported']) assert.ok(BOOKKEEPING_EVENTS.has(type), type);
  for (const type of ['admitted', 'handoff', 'gate.finished', 'review.recorded', 'delivered', 'closed', 'abandoned', 'hold', 'strategy.decided', 'strategy.tripwire']) assert.ok(!BOOKKEEPING_EVENTS.has(type), type);
});

test('wf report lists models with no price, their share of the tokens and the files to add a price to (0.7.0)', () => {
  // Named failure: 58.6% of one project's tokens (the Codex models) were unpriced and silently missing from the cost.
  const { base, root } = singleRepoProject('tel-unpriced', { gate: { steps: [] } });
  const e = admitted(root, base, 'TEL-12');
  const h = state(root, e.id).handoffs.find((x) => x.role === 'implementer');
  const dir = path.join(base, '.home', '.claude', 'projects', '-p', 'sess', 'subagents');
  const at = new Date(Date.now() + 1000).toISOString();
  const usage = (model, u) => JSON.stringify({ type: 'assistant', timestamp: at, requestId: `${model}-${u.output_tokens}`, message: { model, usage: u, content: [] } });
  write(dir, 'agent-p1.meta.json', JSON.stringify({ name: 'impl-1', agentType: h.agentType }));
  write(dir, 'agent-p1.jsonl', usage('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000 }));
  write(dir, 'agent-c1.meta.json', JSON.stringify({ name: 'cards-a', agentType: 'wf-implementer', parentAgentId: 'p1', spawnDepth: 2 }));
  write(dir, 'agent-c1.jsonl', usage('novel-model-9', { input_tokens: 1000000, output_tokens: 0 }));
  const doc = reportJson(root);
  assert.deepEqual(doc.unpriced, [{ model: 'novel-model-9', tokens: 1000000, attempts: 1, share: 0.997 }]);
  const a = doc.attempts[0];
  assert.deepEqual([a.unpricedModels, a.unpricedTokens, a.unpricedShare, a.cost], [['novel-model-9'], 1000000, 0.997, 0.044]);
  const text = ok(wf(root, ['report'])).out;
  assert.match(text, /cost: \$0\.04 \(priced models only: 99\.7% of the tokens have no price for novel-model-9\)/);
  assert.match(text, /unpriced models: 1 model\(s\), 99\.7% of all tokens, are in no cost figure above\n {2}novel-model-9 {2}1000000 tokens in 1 attempt\(s\)/);
  assert.ok(text.includes(path.join(base, '.wfhome', 'prices.yaml')), 'the user file to edit');
  assert.ok(text.includes('<project>/.workflow/prices.yaml'), 'the project file to edit');
  assert.match(text, /engine[\\/]prices\.yaml/, 'the shipped table');
  assert.match(text, /<model id prefix>: \{ input: <USD per million tokens>/);
  const page = path.join(base, 'r.html');
  ok(wf(root, ['report', '--html', page]));
  const html = fs.readFileSync(page, 'utf8');
  assert.match(html, /<h2>Unpriced models<\/h2>[\s\S]*\.workflow\/prices\.yaml[\s\S]*novel-model-9/);
  // A price makes the section go away.
  write(root, '.workflow/prices.yaml', 'models:\n  novel-model-9: { input: 1, output: 1 }\n');
  assert.deepEqual(reportJson(root).unpriced, []);
  assert.doesNotMatch(ok(wf(root, ['report'])).out, /unpriced models:/);
});

test('wf report sizes each reviewer bundle and reads observations and strategy events without needing them (0.7.0)', () => {
  const { base, root } = singleRepoProject('tel-bundles', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const e = admitted(root, base, 'TEL-13');
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'one\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', e.id]));
  const handoffs = state(root, e.id).handoffs;
  const reviewer = handoffs.find((h) => h.role === 'reviewer');
  const size = fs.statSync(reviewer.bundle).size;
  assert.ok(size > 0);
  const a = reportJson(root).attempts[0];
  assert.deepEqual(a.rounds.map((r) => r.bundleBytes), [size]);
  assert.equal(a.maxReviewerBundleBytes, size);
  assert.deepEqual(a.roles.map((r) => [r.role, r.bundleBytes]), handoffs.map((h) => [h.role, fs.statSync(h.bundle).size]));
  assert.equal(a.openObservations, 0);
  assert.deepEqual([a.strategyDecisions, a.strategyTripwires, a.tripwiresFired], [0, 0, []], 'a ledger without strategist events counts zero');
  assert.match(ok(wf(root, ['report'])).out, new RegExp(`reviewer bundles: 1 handoff\\(s\\), largest ${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}`));
  const handoffsCsv = path.join(base, 'h.csv');
  ok(wf(root, ['report', '--handoffs-csv', handoffsCsv]));
  const [head, ...rows] = fs.readFileSync(handoffsCsv, 'utf8').trim().split('\n');
  assert.equal(head.split(',').at(-1), 'bundleBytes');
  assert.equal(rows.length, handoffs.length);
  // Strategist events (written by the strategist stream) are read from the raw entries, defensively.
  const t = '2026-01-01T00:00:00.000Z';
  assert.deepEqual(strategyEvents([]), { decisions: 0, tripwires: 0, fired: [] });
  assert.deepEqual(strategyEvents([{ at: t, type: 'strategy.tripwire', data: { tripwire: 'wall-clock' } }, { at: t, type: 'strategy.tripwire', data: { id: 'bundle-bytes' } }, { at: t, type: 'strategy.tripwire', data: {} }, { at: t, type: 'strategy.decided', data: { action: 'split' } }, { at: t, type: 'strategy.tripwire' }]), { decisions: 1, tripwires: 4, fired: ['wall-clock', 'bundle-bytes'] });
});

test('wf report traces each located finding to the implementer whose commits wrote the line, and shows predictions beside actuals (0.7.0)', () => {
  const { base, root } = singleRepoProject('tel-introduced', { gate: { steps: [{ id: 'u', repo: 'app', run: 'true', inputs: ['src/**'] }] } });
  const e = ok(wf(root, ['entry', '--item', 'TEL-21', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const plan = path.join(base, 'plan-expect.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: { summary: 'change a', expect: { files: 1, rounds: 1, minutes: 30 } }, criteria: [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }] })));
  ok(wf(root, ['plan', '--file', plan, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  const wt = e.repos.app.worktree;
  commitIn(wt, { 'src/a.txt': 'one\n', 'src/b.txt': 'untouched\n' });
  writeReport(root, e.id, 'impl-1', { expect: { minutes: 20 } });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', e.id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id]));
  // F1 cites the line impl-1 wrote; F2 cites no file, so it cannot be traced.
  const findings = [finding('F1', 'major'), { id: 'F2', severity: 'minor', summary: 'F2 is vague', status: 'open', evidence: 'C1' }];
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { findings })), '--attempt', e.id]));

  const r = reportJson(root).attempts.find((x) => x.id === e.id);
  const row = r.introduced.byAgent['impl-1'];
  assert.ok(row, JSON.stringify(r.introduced));
  assert.equal(row.blocking + row.observations, 1, 'F1 only: it cites a line impl-1 committed');
  assert.equal(r.introduced.unattributed, 0);
  assert.deepEqual(r.course.expected, { files: 1, rounds: 1, minutes: 30 });
  // What happened, beside what was predicted: distinct review rounds, minutes since admission, files the attempt changed.
  assert.equal(r.course.actual.rounds, 1);
  assert.equal(r.course.actual.files, 2);
  assert.equal(typeof r.course.actual.minutes, 'number');
  assert.deepEqual(r.course.implementers.map((x) => [x.agent, x.expectMinutes, typeof x.tookMinutes]), [['impl-1', 20, 'number']]);
  const text = ok(wf(root, ['report'])).out;
  assert.match(text, /introduced by implementer \(located findings traced to its commits\): impl-1 \d blocking, \d observation\(s\)/);
  assert.match(text, /predicted: files 1, rounds 1, minutes 30; actual: files 2, rounds 1, minutes \d+/);
  assert.match(text, /impl-1: expected 20 min, took \d+ min/);
  // Across attempts the report says how good the predictions were: the median of actual over predicted (1 is exact).
  const { calibration } = reportJson(root);
  assert.deepEqual([calibration.files.attempts, calibration.files.medianActualOverPredicted], [1, 2], 'two files changed against one predicted');
  assert.deepEqual([calibration.rounds.attempts, calibration.rounds.medianActualOverPredicted], [1, 1]);
  assert.equal(calibration.implementerMinutes.handoffs, 1);
  assert.match(text, /predictions \(median of actual \/ predicted; 1 is exact\):\n {2}files: 2 over 1 attempt\(s\)\n {2}rounds: 1 over 1 attempt\(s\)/);
});
