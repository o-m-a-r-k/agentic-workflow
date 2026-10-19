import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { knownLimits } from '../engine/tracker.mjs';
import { approveAsOwner, closureFile, commitIn, criteriaFile, FIXTURE_EXPECT, goodClosure, impactAddendum, impactCheckedFrom, makeRepo, ok, OUT_OF_ORDER, planDoc, reportFileOf, sh, singleRepoProject, state, tmp, toAccepted, WF, wf, writeReport, yaml } from './helpers.mjs';
import { minimalDiagnosis, runner } from './strategist-fixtures.mjs';
import { readLedger } from '../engine/ledger.mjs';

// I-18, named failure: implementers, reviewers and the owner agent noted real defects found during a ticket and parked
// them as follow-ups or "harmless today" without the owner deciding. Every issue found during a ticket is now in the
// attempt's discovered-issue ledger and ends fixed (with a commit of this ticket) or deferred with the owner's words;
// delivery refuses an open one. The reviewer's bundle lists them as context (0.7.0: a verdict per entry is optional).
// I-19, named failure: a frozen "no change in repo X" criterion blocked a fix that needed an additive change there, and
// the only way through was an amendment framed as an exception. A discovered fix now adds the repo and its work items to
// the running attempt in one owner step; the reviewer's bundle lists the added repo so the seam can be judged on both
// sides (0.7.0: a seam verdict is optional, and recorded when given).

const bundleOf = (r) => JSON.parse(fs.readFileSync(r.out.match(/^Read (\S+)/m)?.[1] ?? r.out.match(/bundle: (\S+)/)[1], 'utf8'));
const disc = (root, args, opts) => wf(root, ['discovered', ...args], opts);

// 0.7.0 (D4), named failure: a deferral took the owner's words from a real user turn in the owner session's transcript
// (`defer <attempt>:<id>`, matched by a grammar), and refused real deferrals after the person had already said yes while
// 283 of 304 recorded "owner decisions" were the orchestrating agent's own command. A deferral moves a defect out of the
// delivery, so it is the person's decision: `wf discovered close --deferred --reason` creates a decision (kind
// move-out-of-batch) and the owner confirms it with `wf approve`; the scenarios' scripted owner does that unless a test
// passes `ownerSilent`. Each approval is used once. 0.7.7 (D17): only a low issue may be deferred at all (a medium or high
// one is fixed in this delivery, engine/leaving.mjs), so the issues the scenarios defer here are rated low. 0.7.8 (D18): the
// question is one per item (key `leave:<id>`, choices `let it leave` | `fix now`), and the scripted owner answers `let it leave`.
const SID = '0wner-5e55-10n1';
const OWNER = `claude:${SID}`;
const silent = { ownerSilent: true };

test('I-18: discovered issues are recorded, end fixed by a ticket commit or deferred in the owner\'s confirmed decision, and block delivery while open', () => {
  const { base, root } = singleRepoProject('discovered', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-700', '--owner', OWNER, '--json'])).json();
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', OWNER]));

  // Any role records what it finds; the list shows it open, and so do status and the next step.
  assert.match(disc(root, ['add', '--attempt', id]).err, /--summary/);
  const a = ok(disc(root, ['add', '--attempt', id, '--summary', 'the pager total sums only the current page', '--where', 'src/a.txt:1', '--found-by', 'impl-1']));
  assert.match(a.out, /discovered D1 recorded on ENG-700\.1/);
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}open {2}the pager total sums only the current page {2}\(src\/a\.txt:1; found by impl-1\)/);
  // 0.7.28 (I-207): an open discovered issue is no round of its own: it joins the next pass (and delivery waits for it, below).
  const listed = ok(wf(root, ['resume', '--attempt', id])).out;
  assert.match(listed, /discovered: 1 open \(D1\)/);
  assert.doesNotMatch(listed, /next: fix the discovered issue/);

  // Fixed means a commit of this ticket: not the base, not an unknown sha.
  const baseSha = sh(wt, 'git rev-parse HEAD');
  assert.match(disc(root, ['close', 'D1', '--fixed', baseSha, '--attempt', id]).err, /is not a commit of this ticket/);
  assert.match(disc(root, ['close', 'D1', '--fixed', 'deadbeef', '--attempt', id]).err, /is not a commit of this ticket/);
  commitIn(wt, { 'src/a.txt': 'b\n' }, 'pager total sums every page');
  const fix = sh(wt, 'git rev-parse HEAD');
  assert.match(ok(disc(root, ['close', 'D1', '--fixed', fix.slice(0, 10), '--attempt', id])).out, /D1 fixed in app@/);
  assert.match(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id]).err, /D1 is already fixed/);

  // Deferral is the owner's decision (`wf approve`), never the agent's words. Only a low issue may wait (D17).
  ok(disc(root, ['add', '--attempt', id, '--summary', 'tables have no phone card view', '--severity', 'low', '--found-by', 'impl-1']));
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D2 {2}open {2}low {2}tables have no phone card view.*\n {4}low: it leaves only with the person's answer, one short question per item \(wf scope defer --finding D2/);
  assert.match(disc(root, ['close', 'D2', '--fixed', fix, '--deferred', '--attempt', id]).err, /with exactly one of --fixed <commit>, --deferred/);
  // An agent's call alone is refused and leaves the pending decision; nothing is deferred.
  const asked = disc(root, ['close', 'D2', '--deferred', '--reason', 'park it for the mobile pass next sprint', '--attempt', id], silent);
  assert.equal(asked.code, 75);
  assert.match(asked.err, /the person decides this \(one short question per item/);
  assert.match(asked.err, /header "D2"\n\s+question: "ENG-700\.1 A1: Should ENG-700 ship without fixing this, listing it as a known issue, or should it be fixed first\? [^"]*Rated low by [^"]*"/);
  assert.match(asked.err, /then: wf approve A1 --from-question --attempt ENG-700\.1/);
  assert.equal(state(root, id).discovered[1].status, 'open');
  assert.deepEqual(state(root, id).decisions.map((d) => [d.id, d.kind, d.key, d.choices, d.approved]), [['A1', 'move-out-of-batch', 'leave:D2', ['let it leave', 'fix now'], null]]);
  // The scripted owner confirms A1 with `wf approve` and the command is run again: the reason and the decision are recorded.
  const closed = ok(disc(root, ['close', 'D2', '--deferred', '--reason', 'park it for the mobile pass next sprint', '--attempt', id, '--json'])).json();
  assert.equal(closed.deferred.decision, 'park it for the mobile pass next sprint');
  assert.deepEqual([closed.deferred.source.provenance, closed.deferred.source.decision], ['approved-decision', 'A1']);
  assert.ok(state(root, id).decisions[0].spent, 'the approval was used by that deferral');

  // The reviewer's bundle lists every defect still in play, as context. 0.7.0 (goals, not forms): a verdict per entry is no
  // obligation (named failure: the form measured compliance with the form, not defects), but one the reviewer gives is
  // recorded with the acceptance. The ledger, not a verdict, is what delivery checks.
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  const bundle = bundleOf(h);
  // A defect fixed since the last round is handed to verify (0.7.7); the deferred one is context.
  assert.deepEqual(bundle.discovered.map((d) => [d.id, d.status, d.fixedSinceReview ?? false]), [['D1', 'fixed', true], ['D2', 'deferred', false]]);
  assert.equal(bundle.discovered.find((d) => d.id === 'D2').deferred.decision, 'park it for the mobile pass next sprint');
  assert.match(bundle.instructions, /discovered issues[^:]*are context for your judgement: cite them in findings; no verdict form is owed/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }] })), '--attempt', id]));

  // An entry recorded after the round was handed needs no fresh round and no verdict: acceptance passes, records only the
  // verdict that was given, and delivery below still refuses the entry while it is open.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'an implicit page-size default', '--severity', 'low', '--found-by', 'o']));
  ok(wf(root, ['accept', '--attempt', id, '--owner', OWNER]));
  assert.deepEqual(state(root, id).accepted.discovered, [{ id: 'D2', verdict: 'deferred', evidence: 'owner decision recorded' }]);
  assert.match(wf(root, ['deliver', '--attempt', id, '--owner', OWNER]).err, /not delivered: 1 discovered issue\(s\) are open: D3 an implicit page-size default/, 'an entry no reviewer judged still blocks delivery');
  // D17: a low issue does not wait on the owner agent's reason alone either (0.7.6 and earlier let it): the person is asked,
  // and the entry stays open until they answer.
  // (A2 is the gate-order override above.)
  const lowAsked = disc(root, ['close', 'D3', '--deferred', '--reason', 'the default is the documented one', '--attempt', id], silent);
  assert.equal(lowAsked.code, 75);
  assert.match(lowAsked.err, /header "D3"\n\s+question: "ENG-700\.1 A3: Should ENG-700 ship without fixing this, listing it as a known issue, or should it be fixed first\? [^"]*Rated low by [^"]*"/);
  assert.equal(state(root, id).discovered[2].status, 'open');
  ok(disc(root, ['close', 'D3', '--deferred', '--reason', 'the default is the documented one', '--attempt', id]));
  assert.deepEqual([state(root, id).discovered[2].deferred.source.provenance, state(root, id).discovered[2].deferred.source.decision], ['approved-decision', 'A3'], 'a deferral is always the person\'s decision now');
  assert.deepEqual(state(root, id).decisions.filter((x) => x.key === 'leave:D3').map((x) => [x.id, x.approved.choice]), [['A3', 'let it leave']], 'the person was asked about D3 and let it leave');

  // Delivery refuses any open entry, whenever it was recorded.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'a failed Next strands the user', '--severity', 'low', '--found-by', 'o']));
  const d = wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  assert.match(d.err, /not delivered: 1 discovered issue\(s\) are open: D4 a failed Next strands the user[\s\S]*fix it in this ticket[\s\S]*medium and high are fixed in this delivery[\s\S]*a low one leaves only with the person's answer, one short question per item/);
  // An approval is used once and belongs to its entry: D2's and D3's do not defer D4.
  const d4 = disc(root, ['close', 'D4', '--deferred', '--reason', 'separate ticket ENG-701, agreed', '--attempt', id], silent);
  assert.match(d4.err, /header "D4"\n\s+question: "ENG-700\.1 A4: Should ENG-700 ship without fixing this/);
  assert.equal(state(root, id).discovered[3].status, 'open');
  ok(disc(root, ['close', 'D4', '--deferred', '--reason', 'separate ticket ENG-701, agreed', '--attempt', id]));
  // A refused delivery records no listing: nothing is marked as shown, and the same command works once the cause is gone.
  commitIn(wt, { 'src/late.txt': 'x\n' }, 'late change');
  assert.match(wf(root, ['deliver', '--attempt', id, '--owner', OWNER]).err, /modified after acceptance/);
  assert.ok(state(root, id).discovered.every((x) => !x.deferred?.acknowledged), 'a refused delivery lists nothing');
  sh(wt, 'git reset -q --hard HEAD~1');
  // 0.7.0 (final review): every deferral is listed at delivery on its own. It was decided when it was recorded (the person's
  // `wf approve` for D2, D3 and D4), so a list of ids an agent typed again proved
  // nothing and was dropped; the successful delivery records that each was listed. It prints each deferral verbatim, with the
  // channel it was decided through, for the owner to see.
  const delivered = ok(wf(root, ['deliver', '--attempt', id, '--owner', OWNER]));
  assert.match(delivered.out, /deferred issues \(show these to the owner: this is what was taken as their decision\):\n {2}D2 deferred \(approved-decision\): tables have no phone card view\n {4}taken as the owner's decision: "park it for the mobile pass next sprint"\n {4}channel: approved-decision/);
  assert.match(delivered.out, /D3 deferred \(approved-decision\): an implicit page-size default\n {4}taken as the owner's decision: "the default is the documented one"\n {4}channel: approved-decision/);
  const s = state(root, id);
  assert.deepEqual(s.discovered.map((x) => [x.id, x.status]), [['D1', 'fixed'], ['D2', 'deferred'], ['D3', 'deferred'], ['D4', 'deferred']]);
  assert.ok(s.discovered.filter((x) => x.status === 'deferred').every((x) => x.deferred.acknowledged?.at), 'a successful delivery records that each deferral was listed');
  assert.match(ok(wf(root, ['export', '--attempt', id, '--json'])).out, /park it for the mobile pass next sprint/);
  // The tester reads each deferral in the delivered comment's known limits, in plain words; who decided and why it waits
  // stay in the delivery output above and the export.
  assert.match(knownLimits(s), /- Known issue: tables have no phone card view\.\n- Known issue: an implicit page-size default\.\n- Known issue: a failed Next strands the user\./);
  assert.doesNotMatch(knownLimits(s), /ENG-700|Why it waits|Decided by/);
});

test('0.7.0: a deferral is the owner\'s confirmed decision: per entry, used once, a fix-now answer defers nothing until the question is withdrawn and asked afresh', async () => {
  const { base, root } = singleRepoProject('discovered-approve', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-730', '--owner', OWNER, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the export button is mislabelled', '--severity', 'low']));
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the import button is mislabelled', '--severity', 'low']));
  assert.equal(state(root, id).discovered[0].anchor, null, 'no transcript is read for a deferral any more');
  const close = (n, extra = [], opts = {}) => disc(root, ['close', `D${n}`, '--deferred', '--reason', 'next sprint', ...extra, '--attempt', id], opts);
  // The person answers `fix now` (D18: the refusal of the two choices): nothing is deferred, and asking again does not turn the
  // old answer into a new one: it stands until the owner withdraws it because the situation changed.
  assert.equal(close(1, [], silent).code, 75);
  const { approveInTerminal } = await import('../engine/approve.mjs');
  const { PassThrough } = await import('node:stream');
  const cwd = process.cwd();
  const keep = { ...process.env };
  Object.assign(process.env, { WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements') });
  process.chdir(root);
  try {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const pending = approveInTerminal(root, 'A1', { attempt: id, choice: 'fix now' }, { input, output, env: {} });
    setImmediate(() => input.write('fix now\n'));
    assert.equal((await pending).choice, 'fix now');
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
  const declined = close(1, [], silent);
  assert.notEqual(declined.code, 0);
  assert.match(declined.err, /the person chose to fix D1 \(A1\) now/);
  assert.equal(fs.readFileSync(path.join(root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id).at(-1), 'leave:person-answered', 'nothing to ask: the person has answered');
  assert.equal(state(root, id).discovered[0].status, 'open');
  assert.equal(state(root, id).decisions.length, 1, 'asking again made no new decision');
  ok(wf(root, ['decisions', 'withdraw', 'A1', '--reason', 'the situation changed', '--attempt', id], silent));
  const again = close(1, [], silent);
  assert.equal(again.code, 75, 'asked afresh');
  assert.match(again.err, /header "D1"\n\s+question: "ENG-730\.1 A2: Should ENG-730 ship without fixing this, listing it as a known issue, or should it be fixed first\? [^"]*Rated low by [^"]*"/);
  assert.equal(state(root, id).discovered[0].status, 'open');
  // A yes for D1 does not defer D2: the key names the entry.
  ok(close(1));
  assert.equal(state(root, id).discovered[0].status, 'deferred');
  const second = close(2, [], silent);
  assert.equal(second.code, 75);
  assert.match(second.err, /header "D2"\n\s+question: "ENG-730\.1 A3: Should ENG-730 ship without fixing this/);
  assert.equal(state(root, id).discovered[1].status, 'open');
  // Free text on the command line is not the owner's decision: `--decision` is ignored, the reason is recorded as given.
  const r = ok(close(2, ['--decision', 'harmless today', '--json'])).json();
  assert.equal(r.deferred.decision, 'next sprint');
});

test('0.7.0: a deferral works for an attempt owned by a person\'s name; no transcript is involved', () => {
  const { base, root } = singleRepoProject('discovered-noowner', {});
  const e = ok(wf(root, ['entry', '--item', 'ENG-702', '--owner', 'plain:o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id, '--owner', 'plain:o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id, '--owner', 'plain:o']));
  assert.doesNotMatch(ok(disc(root, ['add', '--attempt', e.id, '--summary', 's', '--severity', 'low'])).out, /anchor/);
  assert.equal(disc(root, ['close', 'D1', '--deferred', '--attempt', e.id], silent).code, 75);
  ok(disc(root, ['close', 'D1', '--deferred', '--reason', 'later', '--attempt', e.id]));
  assert.equal(state(root, e.id).discovered[0].status, 'deferred');
});

function twoRepos(name) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], components: [{ id: 'api', kind: 'service', repo: 'api' }, { id: 'web', kind: 'web', repo: 'web' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true' }, { id: 'web-unit', repo: 'web', run: 'true' }] } };
  makeRepo(path.join(root, 'api'), { '.gitignore': '.wf-evidence/\n.wf-worktrees/\n', '.workflow/project.yaml': yaml(cfg), 'src/totals.txt': 'page\n' });
  makeRepo(path.join(root, 'web'), { 'src/pager.txt': 'page\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('I-19: a discovered fix adds a repo and its work items to the running attempt in one owner step; the bundle lists the added repo and a seam verdict, when given, is recorded', () => {
  const { base, root } = twoRepos('add-repo');
  const e = ok(wf(root, ['entry', '--item', 'ENG-710', '--repos', 'web', '--owner', 'o', '--json'])).json();
  const id = e.id;
  assert.deepEqual(Object.keys(e.repos), ['web']);
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ plan: 'pager', expect: FIXTURE_EXPECT, criteria: [{ id: 'C1', text: 'the pager pages', uat: 'pages move' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }] }));
  ok(wf(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.web.worktree, { 'src/pager.txt': 'pages\n' });
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the total shown under the pager sums only the current page; the api must return the full total', '--found-by', 'impl-1']));

  const amend = path.join(base, 'amend.json');
  const amendWork = [{ id: 'W1', criteria: ['C1'], repos: ['web'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['api'], class: 'full', why: 'the api contract' }];
  const amendCriteria = [{ id: 'C2', text: 'the list response carries the total over every page; existing fields, permissions and tenant isolation unchanged', uat: 'the total matches the sum of all pages' }];
  fs.writeFileSync(amend, JSON.stringify({ criteria: amendCriteria, work: amendWork, impact: impactAddendum(amendCriteria, amendWork) }));
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'nope', '--attempt', id]).err, /unknown repo `nope`/);
  assert.match(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'x', '--add-repo', 'web', '--attempt', id]).err, /web is already in ENG-710\.1/);
  const noWork = path.join(base, 'amend-nowork.json');
  fs.writeFileSync(noWork, JSON.stringify({ criteria: [{ id: 'C2', text: 't', uat: 'u' }] }));
  assert.match(wf(root, ['criteria', 'amend', '--file', noWork, '--reason', 'x', '--add-repo', 'api', '--attempt', id]).err, /no work item covers the added repo api/);
  const r = ok(wf(root, ['criteria', 'amend', '--file', amend, '--reason', 'D1 needs the api total', '--add-repo', 'api', '--attempt', id, '--owner', 'o']));
  assert.match(r.out, /repo added: api \(worktree .*ENG-710\.1\/api, base [0-9a-f]{10}\)/);
  const s = state(root, id);
  assert.deepEqual(Object.keys(s.repos).sort(), ['api', 'web']);
  assert.ok(fs.existsSync(path.join(s.repos.api.worktree, 'src', 'totals.txt')));
  assert.deepEqual(s.addedRepos.map((x) => [x.repo, x.reason]), [['api', 'D1 needs the api total']]);
  // 0.7.28 (I-210): a criterion added after implementation started is a course signal: the strategist decides before W2 starts.
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /next: the course needs the strategist[^\n]*amendment 1 added C2 after implementation started/);
  const sh1 = ok(wf(root, ['handoff', 'strategist', '--agent', 'strat-1', '--attempt', id, '--json'])).json();
  const strat = path.join(base, 'strategy.json');
  fs.writeFileSync(strat, JSON.stringify({ ...minimalDiagnosis(JSON.parse(fs.readFileSync(sh1.bundle, 'utf8'))), strategist: 'strat-1', action: 'continue', rationale: 'the api total is the fix D1 needs, one work item', prediction: { signal: 'blockingLatest <= 1', by: 3 } }));
  ok(wf(root, ['strategy', 'record', '--closure', strat, '--attempt', id]));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /W2 class full .*`wf handoff implementer --work W2/);

  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  // The fix is committed in the same second D1 was recorded (git dates to the second; the ledger to the millisecond):
  // not before it. Named failure (0.7.10 verify): this step was refused on one verify leg when the two fell in one second.
  const second = new Date(Math.floor(Date.parse(s.discovered.find((d) => d.id === 'D1').at) / 1000) * 1000).toISOString();
  fs.writeFileSync(path.join(s.repos.api.worktree, 'src', 'totals.txt'), 'page\ntotal\n');
  sh(s.repos.api.worktree, `git add -A && GIT_COMMITTER_DATE=${second} GIT_AUTHOR_DATE=${second} git commit -q -m "list response carries the full total"`);
  const fix = sh(s.repos.api.worktree, 'git rev-parse HEAD');
  ok(disc(root, ['close', 'D1', '--fixed', fix, '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.addedRepos.map((x) => x.repo), ['api']);
  assert.match(bundle.instructions, /seams[^:]*are context for your judgement: cite them in findings; no verdict form is owed/);
  const closure = (reviewer, b, extra) => closureFile(base, goodClosure(reviewer, { criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'l' } }, { id: 'C2', evidence: { kind: 'output', ref: 'l' } }], impactChecked: impactCheckedFrom(b), ...extra }));
  // 0.7.0 (goals, not forms): the added repo is in the bundle as context, and a seam verdict is no obligation: a closure
  // without one is recorded. A later round that gives one has it recorded with the acceptance.
  ok(wf(root, ['review', '--closure', closure('rev-1', bundle, {}), '--attempt', id]));
  // rev-1 was handed a tree a gate had passed on, so it was the attempt's full audit; rev-2 is a delta. Every reviewer bundle
  // lists the added repo, delta included (final review of 0.7.0: a delta bundle without it made a delta round the last one
  // before acceptance impossible to accept, whatever its seam verdict said).
  const bundle2 = bundleOf(ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', id, '--owner', 'o'])));
  assert.deepEqual([bundle.mode, bundle2.mode], ['full', 'delta']);
  assert.deepEqual(bundle2.addedRepos.map((x) => x.repo), ['api']);
  ok(wf(root, ['review', '--closure', closure('rev-2', bundle2, { seams: [{ repo: 'api', verdict: 'matched', evidence: 'producer api/src/totals.txt:2; consumer web/src/pager.txt:1' }] }), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'o']));
  assert.deepEqual(state(root, id).accepted.seams, [{ repo: 'api', verdict: 'matched', evidence: 'producer api/src/totals.txt:2; consumer web/src/pager.txt:1', finding: null }]);
  const d = ok(wf(root, ['deliver', '--attempt', id, '--owner', 'o']));
  assert.match(d.out, /delivered ENG-710\.1: .*api@[0-9a-f]{10}.*web@[0-9a-f]{10}|delivered ENG-710\.1: .*web@[0-9a-f]{10}.*api@[0-9a-f]{10}/);
  assert.equal(sh(path.join(root, 'api'), 'git fetch -q origin && git show origin/main:src/totals.txt'), 'page\ntotal');
});

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: the status field shows the
// raw enum value" and handed the issue back to the owner agent to relay. An issue found while working is fixed by the
// role that found it, in this attempt, in whatever file it lives in; the only exception is a file another work item is
// editing at that moment, recorded with that work item; and a report that leaves one unfixed without a ledger entry is
// refused at the next handoff.
const homeOf = (root) => path.join(root, '..', '.home');
function implementerReport(root, name, agentType, text) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-ws', 'owner-session', 'subagents');
  const file = `agent-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file}.meta.json`), JSON.stringify({ name, agentType }));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${file}.jsonl`), [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Read the bundle and follow its instructions.' } }, { type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } }].map((x) => JSON.stringify(x)).join('\n'));
}

// D7: an attempt admitted before 0.7.0 keeps the obligation it was admitted under, so the legacy scan of the implementer's
// transcript runs under an engine stamped 0.6.9. From 0.7.0 the structured report replaces it (the next test).
test('I-18 (attempts admitted before 0.7.0): an implementer report that leaves an issue unfixed without a ledger entry is refused; a blocked fix names the work item editing that file', () => {
  const old = runner('0.6.9');
  const dis = (root, args, opts) => old.run(root, ['discovered', ...args], opts);
  const { base, root } = singleRepoProject('report-check', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(old.run(root, ['entry', '--item', 'ENG-720', '--owner', 'o', '--json'])).json();
  const id = e.id;
  assert.equal(old.state(root, id).engineVersion, '0.6.9', 'the attempt is admitted under the older obligations');
  ok(old.run(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  const plan = path.join(base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify(planDoc({ plan: 'p', criteria: [{ id: 'C1', text: 'a', uat: 'a' }, { id: 'C2', text: 'b', uat: 'b' }], work: [{ id: 'W1', criteria: ['C1'], repos: ['app'], class: 'light', why: 'ui' }, { id: 'W2', criteria: ['C2'], repos: ['app'], class: 'full', why: 'api' }] })));
  ok(old.run(root, ['plan', '--file', plan, '--attempt', id, '--owner', 'o']));
  const h1 = ok(old.run(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  ok(old.run(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  const type = h1.out.match(/Start agent type (\S+)/)[1];
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nNot fixed, outside the brief: the status field shows the raw enum value (src/status.tsx:12).\nNo follow-ups needed elsewhere.');
  const r = old.run(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']);
  assert.match(r.err, /impl-1's report leaves 1 issue\(s\) unfixed without a discovered entry:\n {2}- Not fixed, outside the brief: the status field shows the raw enum value/);
  assert.doesNotMatch(r.err, /No follow-ups needed/);
  assert.match(r.err, /the implementer that found it fixes it[\s\S]*wf discovered add/);

  // The one exception: the file is another work item's at that moment. The entry names it; an unknown work item is refused.
  assert.match(dis(root, ['add', '--attempt', id, '--summary', 's', '--blocked-by', 'W9']).err, /no work item W9/);
  ok(dis(root, ['add', '--attempt', id, '--summary', 'the status field shows the raw enum value', '--where', 'src/status.tsx:12', '--found-by', 'impl-1', '--blocked-by', 'W2']));
  assert.match(ok(dis(root, ['list', '--attempt', id])).out, /D1 {2}open .* blocked by W2: route it to that work item's implementer/);
  assert.match(ok(old.run(root, ['resume', '--attempt', id])).out, /D1 to the implementer of W2/);
  // A report naming the entry passes.
  implementerReport(root, 'impl-1', type, 'Done: C1 passes.\n\nD1 not fixed here: src/status.tsx is the file W2 is editing right now (recorded, blocked by W2).');
  // With more than one work item the combined tree passes `wf check` first (a 0.7.0 attempt must; this one may).
  ok(old.run(root, ['check', '--attempt', id, '--owner', 'o']));
  ok(old.run(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
});

// 0.7.0 (goals, not methods), named failure: the engine read Claude transcripts for prose about unfixed issues, and
// implementers on another harness (Codex) went unchecked. An implementer now writes a structured report; `wf handoff close`
// refuses a close without it and records it, and every item it says it left becomes an open discovered issue.
test('0.7.0: an implementer closes with its report; each item it left becomes an open discovered issue that blocks delivery until fixed; a close without a report is refused and a stopped implementer needs none', () => {
  const { base, root } = singleRepoProject('report-left', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-721', '--owner', 'o', '--json'])).json();
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', 'o']));
  const handed = ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  assert.equal(bundleOf(handed).implementerReportFile, reportFileOf(root, id, 'impl-1'), 'the bundle names where the report goes');
  assert.match(bundleOf(handed).instructions, /write your report to `implementerReportFile` with your `approach` and `expect: \{ minutes \}`/);
  commitIn(wt, { 'src/a.txt': 'b\n' }, 'the change');

  // A work item reported done without a report is refused with its own check id, and the implementer stays open.
  const refusals = () => fs.readFileSync(path.join(root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const none = wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', id], silent);
  assert.equal(none.code, 75);
  assert.match(none.err, /impl-1 has not reported: no report at /);
  assert.equal(refusals().at(-1).id, 'handoff:report-missing');
  assert.equal(state(root, id).implementers[0].closedAt, null);
  // Only an unreadable report refuses the close (refusal audit of 0.7.0: its shape is read leniently, an item it left is
  // never dropped). The file is the one handed to this implementer, so the name a report states is not checked either.
  fs.writeFileSync(reportFileOf(root, id, 'impl-1'), 'not json');
  assert.match(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', id], silent).err, /the report is not JSON/);
  // An implementer that was stopped did not finish, so it owes no report.
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--outcome', 'stopped', '--attempt', id], silent));
  assert.equal(state(root, id).implementers[0].outcome, 'stopped');
  assert.deepEqual([state(root, id).discovered, state(root, id).implementerReports], [[], []]);

  // The next implementer reports what it did and what it left: two items, one of them fixed before the review.
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(wt, { 'src/b.txt': 'c\n' }, 'the change, finished');
  writeReport(root, id, 'impl-2', {
    implementer: 'someone-else',
    summary: 'C1 holds',
    approach: 'the total was summed per page; it sums the response now',
    ran: [{ command: 'node --test', result: 'passed' }],
    left: [{ what: 'the export page sums one page only', where: 'src/export.tsx:40', why: 'not caused by this change', severity: 'major' }, { what: 'the footer shows no total' }],
  });
  ok(wf(root, ['handoff', 'close', '--agent', 'impl-2', '--attempt', id], silent)); // a report naming another agent is still impl-2's: the file is the handed one
  const closed = state(root, id);
  assert.equal(closed.implementers[1].outcome, 'done');
  assert.deepEqual(closed.implementerReports.map((x) => [x.agent, x.summary, x.approach, x.ran, x.left.length]), [['impl-2', 'C1 holds', 'the total was summed per page; it sums the response now', [{ command: 'node --test', result: 'passed' }], 2]]);
  assert.deepEqual(closed.discovered.map((d) => [d.id, d.status, d.kind, d.summary, d.where, d.foundBy]), [
    ['D1', 'open', 'defect', 'left by impl-2: the export page sums one page only', 'src/export.tsx:40', 'impl-2'],
    ['D2', 'open', 'defect', 'left by impl-2: the footer shows no total', null, 'impl-2'],
  ]);
  // A `left` item may carry the severity the implementer rates it at; the ledger keeps it (null when unrated).
  assert.deepEqual(closed.discovered.map((d) => d.severity), ['major', null]);
  // 0.7.28 (I-207): the items it left join the next pass; the review comes first, never a round for them alone.
  const after = ok(wf(root, ['resume', '--attempt', id])).out;
  assert.match(after, /discovered: 2 open \(D1, D2\)[\s\S]*next: code review/);

  // D1 is fixed in this ticket and D2 stays open. The reviewer is handed the report, the open entry as context, and D1 marked
  // fixed since the last round, to verify the claim (0.7.7).
  commitIn(wt, { 'src/export.txt': 'every page\n' }, 'the export sums every page');
  ok(disc(root, ['close', 'D1', '--fixed', sh(wt, 'git rev-parse HEAD'), '--attempt', id]));
  const rev0 = bundleOf(ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id, '--owner', 'o'])));
  assert.deepEqual(rev0.implementerReports.map((x) => [x.agent, x.left.map((l) => l.what)]), [['impl-2', ['the export page sums one page only', 'the footer shows no total']]]);
  assert.deepEqual(rev0.discovered.map((d) => [d.id, d.status, d.fixedSinceReview ?? false]), [['D1', 'fixed', true], ['D2', 'open', false]]);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-0')), '--attempt', id]));
  ok(wf(root, ['gate', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure()), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', 'o']));
  const refused = wf(root, ['deliver', '--attempt', id, '--owner', 'o']);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /not delivered: 1 discovered issue\(s\) are open: D2 left by impl-2: the footer shows no total/);
  assert.doesNotMatch(refused.err, /D1/, 'the fixed entry no longer blocks');
});

// 0.7.27 (I-184), named failure (field): an implementer recorded a defect with `wf discovered add` (D70) and named it in its
// report's `left` with `discoveredId: "D70"`, the same family and the same summary. Closing the handoff recorded D71 for the
// same defect: one defect, two scope items, two delivery blockers. The report's reading also dropped the `family` the template
// shows on a `left` item, so the entries it did create had none.
test('0.7.27 (I-184): a left item that names a discovered issue of the attempt links to it and records no second one; a named id that is no issue is recorded as new and reported', () => {
  const { base, root } = singleRepoProject('report-linked', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-722', '--owner', 'o', '--json'])).json();
  const id = e.id;
  const wt = e.repos.app.worktree;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', 'o']));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', 'o']));
  commitIn(wt, { 'src/a.txt': 'b\n' }, 'the change');
  // The implementer records the defect when it finds it, and names it again when it reports.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the export page sums one page only', '--severity', 'medium', '--where', 'src/export.tsx:40', '--found-by', 'impl-1', '--family', 'page-only-totals']));
  writeReport(root, id, 'impl-1', {
    summary: 'C1 holds',
    left: [
      { what: 'the export page sums one page only', where: 'src/export.tsx:40', why: 'recorded as D1', severity: 'medium', family: 'page-only-totals', discoveredId: 'D1' },
      { what: 'the footer shows no total', severity: 'low', family: 'missing-totals' },
      { what: 'the header is cut off on a phone', discoveredId: 'D9' },
    ],
  });
  const closed = ok(wf(root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', id], silent));
  const s = state(root, id);
  assert.deepEqual(s.discovered.map((d) => [d.id, d.summary]), [
    ['D1', 'the export page sums one page only'],
    ['D2', 'left by impl-1: the footer shows no total'],
    ['D3', 'left by impl-1: the header is cut off on a phone'],
  ], 'the item that names D1 links to it: one defect, one scope item');
  assert.equal(s.discovered[0].severity, 'medium', 'the entry keeps its own rating and words');
  assert.equal(s.discovered[1].family, 'missing-totals', 'a left item\'s family reaches its issue (the template shows it)');
  assert.match(readLedger(root, id).filter((x) => x.type === 'discovered.added').at(-1).data.why, /named D9, which is not a discovered issue of this attempt/, 'the record of the new issue says why it is new');
  // The report as recorded says what each item became.
  assert.deepEqual(s.implementerReports.at(-1).left.map((l) => [l.linked ?? null, l.recorded ?? null]), [['D1', null], [null, 'D2'], [null, 'D3']]);
  // The close says so, for the owner who reads it: the link, and the id that matched nothing (recorded, not dropped).
  assert.match(closed.out, /left item linked to D1 \(open\): no second issue recorded/);
  assert.match(closed.out, /left item names D9, which is not a discovered issue of ENG-722\.1: recorded as D3/);
  // An item that names an issue already fixed links to it without reopening it.
  commitIn(wt, { 'src/export.txt': 'every page\n' }, 'the export sums every page');
  ok(disc(root, ['close', 'D1', '--fixed', sh(wt, 'git rev-parse HEAD'), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', id, '--owner', 'o']));
  commitIn(wt, { 'src/b.txt': 'c\n' }, 'finished');
  writeReport(root, id, 'impl-2', { left: [{ what: 'the export page sums one page only', discoveredId: 'D1' }] });
  const again = ok(wf(root, ['handoff', 'close', '--agent', 'impl-2', '--attempt', id], silent));
  const after = state(root, id);
  assert.equal(after.discovered.length, 3, 'no fourth entry');
  assert.equal(after.discovered[0].status, 'fixed', 'a link reopens nothing');
  assert.match(again.out, /left item linked to D1 \(fixed\): not reopened/);
});

// Independent review of 0.4.5: a batch delivery lists every member's deferrals, qualified by attempt. 0.7.0 (final review):
// the listing is automatic (the `--acknowledge-deferrals` list an agent typed again proved nothing); a refused delivery
// lists, and records, nothing.
test('0.7.0: a batch delivery lists every member deferral as <member>:<id> on its own; a refused delivery lists none', () => {
  const heavy = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }, { id: 'e2e', repo: 'app', run: 'true', tier: 'heavy' }];
  const { base, root } = singleRepoProject('discovered-batch', { gate: { steps: heavy } }, { 'src/b.txt': 'b\n' });
  const m1 = toAccepted(root, base, { item: 'ENG-760', owner: OWNER, change: { 'src/a.txt': 'one\n' }, extraEntry: ['--defer-heavy'] });
  const m2 = toAccepted(root, base, { item: 'ENG-761', owner: OWNER, change: { 'src/b.txt': 'two\n' }, extraEntry: ['--defer-heavy'] });
  for (const m of [m1.id, m2.id]) {
    ok(disc(root, ['add', '--attempt', m, '--summary', `limit in ${m}`, '--severity', 'low']));
    ok(disc(root, ['close', 'D1', '--deferred', '--reason', 'next sprint', '--attempt', m]));
  }
  const b = ok(wf(root, ['batch', 'create', '--members', `${m1.id},${m2.id}`, '--owner', OWNER, '--json'])).json();
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rb', '--attempt', b.id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, { reviewer: 'rb', findings: [], criteria: [{ id: 'B1', evidence: { kind: 'output', ref: 'batch gate' } }], screenshotsInspected: [] }), '--attempt', b.id]));
  ok(wf(root, ['accept', '--attempt', b.id, '--owner', OWNER]));
  // A delivery that is refused (the batch changed after acceptance) lists nothing and marks no member's deferral as listed.
  const wt = state(root, b.id).repos.app.worktree;
  commitIn(wt, { 'src/late.txt': 'x\n' }, 'late change');
  assert.match(wf(root, ['deliver', '--attempt', b.id, '--owner', OWNER]).err, /modified after acceptance/);
  for (const m of [m1.id, m2.id]) assert.ok(!state(root, m).discovered[0].deferred.acknowledged, `${m}: a refused delivery lists nothing`);
  sh(wt, 'git reset -q --hard HEAD~1');
  const d = ok(wf(root, ['deliver', '--attempt', b.id, '--owner', OWNER]));
  for (const m of [m1.id, m2.id]) {
    assert.match(d.out, new RegExp(`${m.replace('.', '\\.')}:D1 deferred \\(approved-decision\\): limit in ${m.replace('.', '\\.')}\\n {4}taken as the owner's decision: "next sprint"`));
    assert.ok(state(root, m).discovered[0].deferred.acknowledged?.at, `${m}: listed by the delivery that succeeded`);
  }
});

// Review of 76ad8d8: refusals can still follow (a push conflict, an adapter readback, an adapter still waiting for merge)
// once the deferrals are listed, so a refused delivery is always retried with the same command. 0.7.0 (final review): that
// command carries no list of ids any more, so the retry is plain `wf deliver`.
test('0.7.0: a delivery refused by a push conflict is retried with the same plain command and fails for the same reason', () => {
  const { base, root, remote } = singleRepoProject('discovered-ackretry', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-800', '--owner', OWNER, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' }, 'change');
  ok(disc(root, ['add', '--attempt', id, '--summary', 'x', '--severity', 'low', '--found-by', 'impl-1']));
  ok(disc(root, ['close', 'D1', '--deferred', '--reason', 'later', '--attempt', id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'deferred', evidence: 'r' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', OWNER]));
  // The base moves with a conflicting change: the push refuses.
  sh(base, `git clone -q ${JSON.stringify(remote)} other`);
  const other = path.join(base, 'other');
  sh(other, "git config user.email t@example.test && git config user.name t && printf 'c\\n' > src/a.txt && git commit -qam conflict && git push -q origin main");
  const first = wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  assert.notEqual(first.code, 0);
  assert.doesNotMatch(first.err, /acknowledg|not a deferred issue/, 'no list of deferrals is asked for');
  const retry = wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  assert.notEqual(retry.code, 0);
  assert.doesNotMatch(retry.err, /acknowledg|not a deferred issue/, 'the same command is accepted again; only the conflict refuses');
  assert.equal(retry.err.split('\n')[0], first.err.split('\n')[0], 'the retry fails for the same reason as the first try');
});

// Review of b5b2183: the same command also works after an adapter that is still waiting for merge and after a failed
// adapter readback, both of which come after the deferrals are listed. 0.7.0: no list of ids is passed any more.
test('0.7.0: the same plain wf deliver command is retried after an adapter waits and after its readback fails', () => {
  const adapter = `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const flag = (root, n) => root + '/../' + n;
export default {
  integrate(ctx) {
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree });
    return { url: 'https://git.example.test/mr/1', branch: ctx.branch };
  },
  observe(ctx) {
    if (!fs.existsSync(flag(ctx.root, 'merged.flag'))) return { state: 'awaiting-merge' };
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree });
    return { state: 'integrated' };
  },
  readback(ctx) {
    if (fs.existsSync(flag(ctx.root, 'readback-fails.flag'))) return { ok: false, reason: 'the merge is not visible yet' };
    return { ok: true };
  },
};`;
  const { base, root } = singleRepoProject('discovered-adapter', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } }, { '.workflow/delivery/mr.mjs': adapter });
  const e = ok(wf(root, ['entry', '--item', 'ENG-810', '--owner', OWNER, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id, '--owner', OWNER]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' }, 'change');
  ok(disc(root, ['add', '--attempt', id, '--summary', 'x', '--severity', 'low', '--found-by', 'impl-1']));
  ok(disc(root, ['close', 'D1', '--deferred', '--reason', 'later', '--attempt', id]));
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id, '--owner', OWNER, '--runtime', 'codex']));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1', { discovered: [{ id: 'D1', verdict: 'deferred', evidence: 'r' }] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id, '--owner', OWNER]));
  const deliver = () => wf(root, ['deliver', '--attempt', id, '--owner', OWNER]);
  // The adapter waits for merge (exit 0, not a refusal): the delivery is not complete, and the same command waits again.
  assert.match(ok(deliver()).out, /awaiting-merge/);
  assert.equal(state(root, id).delivery.completedAt, null, 'a delivery that waits is not delivered');
  assert.match(ok(deliver()).out, /awaiting-merge/, 'the same command after the wait');
  // Merged, but the readback fails: refused. The same command is accepted again. The accepted commit is now on the target branch, but I-20: ancestry alone is not the adapter's proof, so the
  // retry asks the adapter again (observe, then readback) and refuses while its readback still fails.
  fs.writeFileSync(path.join(root, '..', 'merged.flag'), '');
  fs.writeFileSync(path.join(root, '..', 'readback-fails.flag'), '');
  assert.match(deliver().err, /readback failed: the merge is not visible yet/);
  assert.match(deliver().err, /readback failed: the merge is not visible yet/, 'the retry asks the adapter again, not only git');
  fs.rmSync(path.join(root, '..', 'readback-fails.flag'));
  const again = deliver();
  assert.equal(again.code, 0, again.err);
  const s = state(root, id);
  assert.ok(s.delivery.completedAt, 'delivered (no tracker: the attempt then closes)');
  assert.equal(s.delivery.repos.app.adapterState, 'integrated');
  assert.equal(s.delivery.repos.app.recovered, true);
  assert.ok(s.discovered[0].deferred.acknowledged?.at, 'the delivery that succeeded listed the deferral');
  assert.match(again.out, /D1 deferred \(approved-decision\): x\n {4}taken as the owner's decision: "later"/);
});

// 0.7.27 (I-188), named failure (field): a discovered issue was rated high on a faulty premise (a helper and a dormant branch
// misread what current behaviour is). The planner found no authoritative alternative policy and the person said to keep the
// behaviour as it is; no work was planned or built. The only ways to close the entry were `--fixed <commit>`, a fix that was
// never made, or `--deferred`, which would list a claim nobody holds as a known issue and needs a reason it does not have;
// a reviewer's verdict on it could only be fixed, deferred or open, so the reviewer wrote that the claim "is not established"
// in its summary, which settles nothing. An entry that is not a defect is closed as such: the claim and why it is not one
// stay in the record, and the delivered comment does not list it. Who may close it follows who may let a defect leave: an
// independent reviewer's verdict (`verified-nonissue`, as for findings) or the person's decision (the project's `leaving:`
// policy may let the owner agent do it for a level, with its reason).
const CLAIM = 'a yearly limit counts loans over a rolling year, which can wrongly allow or reject a request';
const WHY = 'the rolling year is what the product means by yearly; the helper misread it';
const refusalIds = (root) => fs.readFileSync(path.join(root, '..', 'refusals.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);

function nonissueScene(name, config = {}) {
  const { base, root } = singleRepoProject(name, { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, ...config });
  const e = ok(wf(root, ['entry', '--item', 'ENG-880', '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'plan-1', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  return { base, root, id, wt: e.repos.app.worktree };
}

test('0.7.27 (I-188): an independent reviewer\'s verified-nonissue verdict closes a discovered issue as not a defect; the claim stays in the record and delivery no longer waits for it', () => {
  const { base, root, id } = nonissueScene('discovered-nonissue-reviewer');
  ok(disc(root, ['add', '--attempt', id, '--summary', CLAIM, '--severity', 'high', '--where', 'src/a.txt:1', '--found-by', 'impl-1']));
  const h = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', id]));
  const bundle = bundleOf(h);
  assert.deepEqual(bundle.discovered.map((d) => [d.id, d.status]), [['D1', 'open']]);
  assert.match(bundle.instructions, /"verdict": "verified-nonissue"/, 'the reviewer is told how to say a discovered issue is not a defect');
  const record = (verdicts, agent = 'rev-0') => wf(root, ['review', '--closure', closureFile(base, goodClosure(agent, { discovered: verdicts })), '--attempt', id]);
  // A verdict that says neither why nor what it checked refuses the closure and records nothing.
  const bare = record([{ id: 'D1', verdict: 'verified-nonissue', evidence: 'src/a.txt:1' }]);
  assert.equal(bare.code, 75);
  assert.match(bare.err, /D1: verified-nonissue needs a rationale/);
  assert.match(bare.err, /"rationale"/, 'the hint shows the shape');
  assert.equal(refusalIds(root).at(-1), 'review:discovered-nonissue');
  assert.match(record([{ id: 'D1', verdict: 'verified-nonissue', rationale: WHY }]).err, /D1: verified-nonissue needs evidence/);
  // An issue this reviewer was never handed is not its to close.
  ok(disc(root, ['add', '--attempt', id, '--summary', 'recorded after the round was handed', '--severity', 'low', '--found-by', 'o']));
  const unseen = record([{ id: 'D2', verdict: 'verified-nonissue', evidence: 'src/a.txt:1', rationale: WHY }]);
  assert.equal(unseen.code, 75);
  assert.match(unseen.err, /D2: not in your bundle/);
  assert.deepEqual(state(root, id).discovered.map((d) => d.status), ['open', 'open']);
  assert.equal((state(root, id).reviews ?? []).length, 0, 'no refusal recorded a round');
  // The verdict, with its evidence and rationale, closes it.
  ok(record([{ id: 'D1', verdict: 'verified-nonissue', evidence: 'src/a.txt:1', rationale: WHY }]));
  const s = state(root, id);
  const d1 = s.discovered[0];
  assert.equal(d1.status, 'not-a-defect');
  assert.equal(d1.summary, CLAIM, 'the original claim stays');
  assert.equal(d1.severity, 'high');
  assert.equal(d1.notADefect.reason, WHY);
  assert.equal(d1.notADefect.evidence, 'src/a.txt:1');
  assert.deepEqual([d1.notADefect.source.provenance, d1.notADefect.source.reviewer], ['reviewer-verdict', 'rev-0']);
  assert.equal(d1.deferred, null, 'it is not a deferral');
  assert.equal(s.discovered[1].status, 'open');
  assert.match(ok(disc(root, ['list', '--attempt', id])).out, /D1 {2}not-a-defect {2}high {2}a yearly limit counts loans[^\n]*  not a defect \(an independent reviewer's verdict[^)]*\): "the rolling year is what the product means by yearly/);
  // It is nobody's known issue: not in the delivered comment, and delivery waits only for what is still open.
  assert.doesNotMatch(knownLimits(s), /rolling|yearly/);
  ok(wf(root, ['gate', '--attempt', id]));
  // The evidence reviewer is shown the closed issue once, to dispute it with a finding if the claim holds after all.
  const evidence = bundleOf(ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', id])));
  assert.deepEqual(evidence.discovered.map((d) => [d.id, d.status, d.notADefectSinceReview ?? false]), [['D1', 'not-a-defect', true], ['D2', 'open', false]]);
  // 0.7.27 (review of the release): the reviewer is told who closed it, as the record has it: this one on a reviewer's verdict.
  assert.match(evidence.instructions, /closed that way \(D1 on reviewer rev-0's verdict\): raise a finding if the claim holds after all/);
  assert.doesNotMatch(evidence.instructions, /on the word of the person or the owner/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-1')), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  const refused = wf(root, ['deliver', '--attempt', id]);
  assert.match(refused.err, /not delivered: 1 discovered issue\(s\) are open: D2 recorded after the round was handed/);
  assert.doesNotMatch(refused.err, /D1 a yearly/);
  assert.match(ok(wf(root, ['export', '--attempt', id, '--json'])).out, /the rolling year is what the product means by yearly/, 'the export keeps why');
});

test('0.7.27 (I-188): the person decides a discovered issue is not a defect, one question per item; the project\'s leaving policy may let the owner agent do it for a level', () => {
  const { root, id } = nonissueScene('discovered-nonissue-person');
  ok(disc(root, ['add', '--attempt', id, '--summary', CLAIM, '--severity', 'high', '--invariant', 'loan policy must allow and deny as the product intends', '--found-by', 'impl-1']));
  ok(disc(root, ['add', '--attempt', id, '--summary', 'the export button is mislabelled', '--severity', 'medium', '--found-by', 'impl-1']));
  const close = (ref, extra = [], opts = silent) => disc(root, ['close', ref, '--not-a-defect', ...extra, '--attempt', id], opts);
  // One way to close at a time, and a reason that says why it is not a defect.
  assert.match(disc(root, ['close', 'D1', '--fixed', 'abc1234', '--not-a-defect', '--attempt', id]).err, /exactly one of --fixed <commit>, --deferred/);
  const noReason = close('D1');
  assert.equal(noReason.code, 75);
  assert.match(noReason.err, /--not-a-defect needs --reason/);
  assert.equal(refusalIds(root).at(-1), 'discovered:nonissue-reason');
  // An agent's word alone closes a high issue at no level: the question is written first, then asked.
  const unworded = close('D1', ['--reason', WHY], { ownerSilent: true, words: false });
  assert.equal(unworded.code, 75);
  assert.match(unworded.err, /not asked yet: closing D1 as not a defect is the person's decision/);
  assert.match(unworded.err, /the question: Should ENG-880 keep working as it does now, because the problem reported in it is not one\?/);
  assert.equal((state(root, id).decisions ?? []).length, 0, 'nothing is put to the person before its words exist');
  const asked = close('D1', ['--reason', WHY, '--person-directed', 'this should remain the same way it is now']);
  assert.equal(asked.code, 75);
  assert.match(asked.err, /ENG-880\.1 A1: Should ENG-880 keep working as it does now, because the problem reported in it is not one\?/);
  const d = state(root, id).decisions[0];
  assert.deepEqual([d.kind, d.key, d.choices], ['move-out-of-batch', 'nonissue:D1', ['yes', 'no']]);
  assert.match(d.plain, /You told us: "this should remain the same way it is now"\./, 'the person\'s own words are shown back to them');
  assert.equal(state(root, id).discovered[0].status, 'open');
  // Their yes closes it, with their words and the decision in the record; the other issue is its own question.
  approveAsOwner(root, id, 'A1', 'yes');
  const done = ok(close('D1', ['--reason', WHY, '--person-directed', 'this should remain the same way it is now', '--json'], silent)).json();
  assert.equal(done.status, 'not-a-defect');
  assert.equal(done.summary, CLAIM);
  assert.deepEqual([done.notADefect.reason, done.notADefect.personDirected, done.notADefect.source.provenance, done.notADefect.source.decision], [WHY, 'this should remain the same way it is now', 'approved-decision', 'A1']);
  assert.ok(state(root, id).decisions[0].spent, 'the approval is used once');
  assert.match(disc(root, ['close', 'D1', '--not-a-defect', '--reason', 'again', '--attempt', id]).err, /D1 is already not-a-defect/);
  const second = close('D2', ['--reason', 'the label is the agreed wording']);
  assert.equal(second.code, 75);
  assert.equal(state(root, id).decisions.length, 2);
  // A no stands: the issue is a defect and is fixed; it is not asked again.
  approveAsOwner(root, id, 'A2', 'no');
  const declined = close('D2', ['--reason', 'the label is the agreed wording']);
  assert.equal(declined.code, 75);
  assert.match(declined.err, /closing D2 as not a defect: the person answered A2 "No, fix the problem"/);
  assert.equal(state(root, id).discovered[1].status, 'open');
  assert.equal(state(root, id).decisions.length, 2);
  assert.doesNotMatch(knownLimits(state(root, id)), /rolling|yearly|mislabelled/);
  // The next reviewer is told it was the person's answer, never "a reviewer's verdict".
  assert.match(bundleOf(ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-p', '--attempt', id]))).instructions, /closed that way \(D1 on the person's answer\): raise a finding/);

  // Under a project policy that lets the owner agent decide a low issue, a low one closes on its reason; a high one still asks.
  const o = nonissueScene('discovered-nonissue-owner', { leaving: { low: 'owner' } });
  ok(disc(o.root, ['add', '--attempt', o.id, '--summary', 'a stale comment says the page size is 10', '--severity', 'low', '--found-by', 'impl-1']));
  ok(disc(o.root, ['add', '--attempt', o.id, '--summary', CLAIM, '--severity', 'high', '--found-by', 'impl-1']));
  const low = ok(disc(o.root, ['close', 'D1', '--not-a-defect', '--reason', 'the comment is right: the page size is 10', '--attempt', o.id, '--json'], silent)).json();
  assert.deepEqual([low.status, low.notADefect.source.provenance], ['not-a-defect', 'owner-reason']);
  assert.equal(disc(o.root, ['close', 'D2', '--not-a-defect', '--reason', WHY, '--attempt', o.id], silent).code, 75, 'a level the policy does not give the owner is still the person\'s');
  assert.equal(state(o.root, o.id).discovered[1].status, 'open');
  assert.match(bundleOf(ok(wf(o.root, ['handoff', 'reviewer', '--agent', 'rev-o', '--attempt', o.id]))).instructions, /closed that way \(D1 on the owner agent's recorded reason\): raise a finding/);
});
