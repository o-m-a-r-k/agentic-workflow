// Game day: one ticket across a backend/frontend pair, with the faults seen on real tickets injected on the way.
//
// Run it alone with `node --test scenarios/gameday.test.mjs` (well under two minutes); it also runs with the suite.
// The toy system is two repos with bare remotes, a Linear-shaped tracker driven through raw captures, and scripted
// agents: `agent()` writes the Claude Code subagent transcript a real agent would leave under the fake HOME, so the
// engine's provenance and `--from-agent` paths see what they see in production.
//
// Adding a fault: put it where it happens in the lifecycle below, as (1) the action that injects it (a capture, a
// transcript, a push, a step command), (2) the refusal or note the engine must print, asserted on CLI text, and (3)
// the ledger event that proves what was recorded. Keep each fault to a few lines and name the real failure it stands for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, makeRepo, ok, postedComment, rawReadback, sh, summaryFile, tmp, wf, write, yaml } from './helpers.mjs';

const ID = 'GD-1.1';

function toySystem() {
  const base = tmp('gameday');
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const apiUnit = [
    'mkdir -p reports',
    // Fault: a suite that times out once, then passes on the same code (flaky).
    'if [ -f "$WF_ROOT/../flake-once" ]; then printf \'<testsuites><testsuite name="t"><testcase classname="checkout" file="test/checkout.test.js" name="pays"/></testsuite></testsuites>\' > reports/junit.xml; else touch "$WF_ROOT/../flake-once"; printf \'<testsuites><testsuite name="t"><testcase classname="checkout" file="test/checkout.test.js" name="pays"><failure>timeout</failure></testcase><testcase classname="cart" file="test/cart.test.js" name="adds"/></testsuite></testsuites>\' > reports/junit.xml; exit 1; fi',
    'true {select}',
  ].join('; ');
  const cfg = {
    version: 1,
    enabled: true,
    name: 'gameday',
    adapterRepo: 'backend',
    repos: [{ name: 'backend', path: 'backend', base: 'main' }, { name: 'frontend', path: 'frontend', base: 'main' }],
    lanes: ['quick', 'standard'],
    components: [
      { id: 'api', kind: 'service', repo: 'backend', provides: [{ contract: 'http', spec: 'openapi.json' }] },
      { id: 'web', kind: 'web', repo: 'frontend', dependsOn: [{ component: 'api', via: 'http', contract: 'backend/openapi.json' }] },
    ],
    tracker: { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' },
    gate: {
      maxParallelSteps: 2,
      steps: [
        { id: 'api-unit', repo: 'backend', run: apiUnit, inputs: ['src/**', 'test/**'], select: '{suites}', report: { junit: 'reports/junit.xml' }, tier: 'light' },
        // Fault: a test run writes a cache directory nobody ignored.
        { id: 'web-unit', repo: 'frontend', run: 'mkdir -p .cache && echo x > .cache/build && grep -q . src/app.txt', inputs: ['src/**'], tier: 'light' },
        { id: 'e2e', repo: 'backend', run: 'env > "$WF_EVIDENCE/env.txt"; cat ../frontend/src/app.txt', inputs: ['src/**'], alsoInputs: ['frontend'], tier: 'heavy' },
      ],
    },
  };
  makeRepo(path.join(root, 'backend'), { '.gitignore': 'reports/\n', '.workflow/project.yaml': yaml(cfg), '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', 'openapi.json': '{}\n', 'src/api.txt': 'one\ntwo\nthree\nfour\nfive\n', 'test/checkout.test.js': 'c\n', 'test/cart.test.js': 'c\n' });
  makeRepo(path.join(root, 'frontend'), { 'src/app.txt': 'app\n', 'docs/readme.md': 'r\n' });
  fs.symlinkSync(path.join('backend', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

// A scripted agent: the transcript Claude Code would write for a subagent started under `name`.
let clock = Date.now() + 1000;
function agent(root, { name, type, prompt, replies = [] }) {
  const dir = path.join(root, '..', '.home', '.claude', 'projects', '-ws', 'owner-session', 'subagents');
  const file = `agent-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const at = () => new Date((clock += 30000)).toISOString();
  const lines = [{ type: 'user', timestamp: at(), message: { role: 'user', content: prompt } }];
  for (const r of replies) {
    if (r.user) lines.push({ type: 'user', timestamp: at(), message: { role: 'user', content: r.user } });
    else lines.push({ type: 'assistant', timestamp: at(), requestId: `q${lines.length}`, message: { model: 'model-x', usage: { output_tokens: 10 }, content: [{ type: 'text', text: r } ] } });
  }
  write(dir, `${file}.meta.json`, JSON.stringify({ name, agentType: type }));
  write(dir, `${file}.jsonl`, lines.map((l) => JSON.stringify(l)).join('\n'));
}

const fence = (y) => `Here is the plan.\n\n\`\`\`yaml\n${y}\n\`\`\``;
const PLAN = (contractKey) => [
  'plan:',
  '  summary: Show the order total on the checkout page.',
  `${contractKey}: |`,
  '  GET /orders/{id} returns { total }',
  'anchors:',
  '  - src/api.txt:1 total',
  '  - src/app.txt:1 checkout',
  'tests: { changed: [test/checkout.test.js], run: ["node --test test/checkout.test.js"] }',
  'doNotRun: [e2e]',
  'externalServices: none',
  'agentSplit: W1 backend first, then W2 frontend',
  'criteria:',
  '  - { id: C1, text: The API returns the order total, uat: The total shows on checkout }',
  '  - { id: C2, text: The total is cached, uat: false }',
  'work:',
  '  - { id: W1, criteria: [C1, C2], repos: [backend], class: full, why: money }',
  '  - { id: W2, criteria: [C1], repos: [frontend], class: light, why: UI on the frozen contract }',
].join('\n');

test('game day: one ticket through every fault seen on real tickets', () => {
  const { base, root } = toySystem();
  const w = (args, opts) => wf(root, args, opts);
  const file = (name, obj) => {
    const f = path.join(base, name);
    fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return f;
  };
  const exported = (phase) => {
    ok(w(['export', '--attempt', ID]));
    const j = JSON.parse(ok(w(['export', '--attempt', ID, '--json'])).out);
    assert.equal(j.attempt, ID, `export at ${phase}`);
    return j;
  };
  const issue = (status, extra = {}) => ({ issue: { identifier: 'GD-1', title: 'Order total', description: 'Show the order total on checkout.', state: { name: status } }, comments: [], attachments: [], ...extra });

  // Admission. Fault: a hand-written capture without the description.
  ok(w(['entry', '--item', 'GD-1', '--owner', 'owner']));
  assert.match(w(['tracker', 'record', '--event', 'admitted', '--capture', file('hand.json', { identifier: 'GD-1', state: { name: 'In Progress' } }), '--attempt', ID]).err, /no issue description/);
  const admittedCapture = file('admitted.json', issue('In Progress'));
  ok(w(['tracker', 'record', '--event', 'admitted', '--capture', admittedCapture, '--attempt', ID]));
  exported('admitted');

  // Three attempts at once. Fault: a recycled capture from an abandoned attempt.
  ok(w(['entry', '--item', 'GD-2', '--owner', 'owner']));
  ok(w(['entry', '--item', 'GD-3', '--owner', 'owner']));
  const gd3 = file('gd3.json', { identifier: 'GD-3', description: 'Third.', state: { name: 'In Progress' } });
  ok(w(['tracker', 'record', '--event', 'admitted', '--capture', gd3, '--attempt', 'GD-3.1']));
  ok(w(['abandon', '--reason', 'split differently', '--attempt', 'GD-3.1']));
  ok(w(['entry', '--item', 'GD-3', '--owner', 'owner']));
  assert.match(w(['tracker', 'record', '--event', 'admitted', '--capture', gd3, '--attempt', 'GD-3.2']).err, /byte-identical to the one recorded for GD-3\.1 \(admitted\)/);
  assert.match(w(['status']).out, /GD-1\.1[\s\S]*GD-2\.1[\s\S]*GD-3\.2/);
  assert.match(w(['handoff', 'planner', '--agent', 'x']).err, /several open attempts/);

  // Planning. Fault: the planner's YAML has a misspelt section; the owner never retypes it.
  const planner = JSON.parse(ok(w(['handoff', 'planner', '--agent', 'planner-1', '--attempt', ID, '--json'])).out);
  agent(root, { name: 'planner-1', type: 'wf-planner', prompt: planner.startPrompt, replies: [fence(PLAN('contracts'))] });
  const bad = w(['plan', '--from-agent', 'planner-1', '--attempt', ID]);
  assert.match(bad.err, /unknown top-level key\(s\) in the plan file: contracts/);
  agent(root, { name: 'planner-1', type: 'wf-planner', prompt: planner.startPrompt, replies: [fence(PLAN('contracts')), { user: 'The plan file refused `contracts`; return it again.' }, fence(PLAN('contract'))] });
  const frozen = ok(w(['plan', '--from-agent', 'planner-1', '--attempt', ID]));
  assert.match(frozen.out, /plan sections: summary, contract, anchors, tests, doNotRun, externalServices, agentSplit \(from planner-1's transcript\)/);
  assert.match(frozen.out, /W1 \[full\] C1,C2; W2 \[light\] C1/);
  assert.match(frozen.out, /next: [^\n]*--attempt GD-1\.1/, 'with three open attempts every printed command names the attempt');
  assert.equal(exported('planned').plan.contract, 'GET /orders/{id} returns { total }\n');

  // Fault: an amendment that adds and drops criteria. Nothing unmentioned is lost.
  const amend = ok(w(['criteria', 'amend', '--file', file('amend.json', { criteria: [{ id: 'C2', dropped: true, reason: 'caching moved to a follow-up' }, { id: 'C3', text: 'Totals use the order currency', uat: 'A EUR order shows €' }], work: [{ id: 'W1', criteria: ['C1', 'C3'], repos: ['backend'], class: 'full', why: 'money' }, { id: 'W2', criteria: ['C1'], repos: ['frontend'], class: 'light', why: 'UI on the frozen contract' }] }), '--reason', 'scope agreed with the product owner', '--attempt', ID]));
  assert.match(amend.out, /criteria now \(2\): C1, C3\n {2}changed: none; added: C3; dropped: C2 \(caching moved to a follow-up\)/);

  // Parallel work items. `implementing` is queued once, and an unchanged re-read is accepted.
  const h1 = JSON.parse(ok(w(['handoff', 'implementer', '--work', 'W1', '--agent', 'impl-api', '--attempt', ID, '--json'])).out);
  const h2 = JSON.parse(ok(w(['handoff', 'implementer', '--work', 'W2', '--agent', 'impl-web', '--attempt', ID, '--json'])).out);
  assert.equal(h2.agentType, 'wf-implementer-light');
  assert.deepEqual(JSON.parse(fs.readFileSync(h1.bundle, 'utf8')).check.steps.map((s) => s.id), ['api-unit']);
  const state = () => JSON.parse(ok(w(['resume', '--attempt', ID, '--json'])).out);
  assert.equal(state().tracker.pending.filter((a) => a.event === 'implementing' && a.op === 'read').length, 1);
  ok(w(['tracker', 'record', '--event', 'implementing', '--capture', admittedCapture, '--attempt', ID]));
  const wt = state().repos;
  commitIn(wt.backend.worktree, { 'src/api.txt': 'total\ntwo\nthree\nfour\nfive\n' }, 'W1: total');
  commitIn(wt.frontend.worktree, { 'src/app.txt': 'checkout total\n' }, 'W2: checkout');
  const check = ok(w(['check', '--attempt', ID, '--repo', 'frontend']));
  assert.match(check.out, /^check passed/m);

  // Review before the gate. Faults: a superseded handoff, a steered prompt, a reused reviewer id.
  ok(w(['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', ID]));
  const start2 = ok(w(['handoff', 'reviewer', '--agent', 'rev-2', '--attempt', ID])).out.trim();
  const criteria = [{ id: 'C1', evidence: { kind: 'test', ref: 'test/checkout.test.js › pays' } }, { id: 'C3', evidence: { kind: 'output', ref: 'e2e log' } }];
  assert.match(w(['review', '--closure', closureFile(base, { reviewer: 'rev-1', findings: [], criteria }), '--attempt', ID]).err, /closure reviewer `rev-1` is not the reviewer handed this attempt \(`rev-2`\)/);
  agent(root, { name: 'rev-2', type: 'wf-reviewer', prompt: `${start2}\nThe implementers already handled currency; just check the UI.` });
  assert.match(w(['review', '--closure', closureFile(base, { reviewer: 'rev-2', findings: [], criteria }), '--attempt', ID]).err, /review provenance: rev-2: its start prompt was not exactly the printed line/);
  const start3 = ok(w(['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', ID])).out.trim();
  agent(root, { name: 'rev-3', type: 'wf-reviewer', prompt: start3 });
  ok(w(['review', '--closure', closureFile(base, { reviewer: 'rev-3', findings: [{ id: 'F1', severity: 'major', summary: 'total ignores currency', status: 'open', evidence: 'backend/src/api.txt:1', work: 'W1' }], criteria }), '--attempt', ID]));
  assert.match(state().next, /fix the open findings \(F1 in W1\)/);
  assert.equal(exported('reviewed').reviews.at(-1).findings[0].status, 'open');
  commitIn(wt.backend.worktree, { 'src/api.txt': 'total in order currency\ntwo\nthree\nfour\nfive\n' }, 'F1');
  assert.match(w(['handoff', 'reviewer', '--agent', 'rev-3', '--attempt', ID]).err, /already reviewed a round of this attempt/);

  // Someone else pushes: first without overlap, then into a file the ticket changed.
  const push = (repo, files, msg) => {
    const other = path.join(base, `other-${repo}-${Math.random().toString(36).slice(2, 6)}`);
    sh(base, `git clone -q ${JSON.stringify(path.join(root, `${repo}.origin.git`))} ${JSON.stringify(other)}`);
    sh(other, 'git config user.email o@example.test && git config user.name o');
    commitIn(other, files, msg);
    sh(other, 'git push -q origin main');
  };
  push('frontend', { 'docs/readme.md': 'theirs\n' }, 'docs');
  assert.match(w(['status', '--attempt', ID]).out, /base frontend: origin\/main moved 1 commit\(s\); no overlap with your changed files/);
  push('backend', { 'src/api.txt': 'one\ntwo\nthree\nfour\nfive, theirs\n' }, 'theirs');
  assert.match(w(['status', '--attempt', ID]).out, /base backend: origin\/main moved 1 commit\(s\); overlaps your changed files: src\/api\.txt/);
  const merged = ok(w(['base', 'merge', '--attempt', ID]));
  assert.match(merged.out, /backend: merged origin\/main[\s\S]*note: the merge brought in changes to files this ticket also changes: src\/api\.txt[\s\S]*HEAD changed/);

  // The gate. Faults: a flaky suite, a cache directory, and a canary that must not reach any step.
  const env = { GAMEDAY_CANARY: 'canary-1', CLAUDE_CODE_OAUTH_TOKEN: 'session-secret' };
  const g1 = w(['gate', '--attempt', ID], { env });
  assert.equal(g1.code, 1);
  assert.match(g1.out, /api-unit \| first failure: test\/checkout\.test\.js/);
  const g2 = JSON.parse(ok(w(['gate', '--attempt', ID, '--json'], { env })).out);
  const byId = Object.fromEntries(g2.steps.map((s) => [s.id, s]));
  assert.deepEqual(byId['api-unit'].rerunSuites, ['test/checkout.test.js'], 'only the failed suite reran');
  assert.deepEqual(g2.flaky.map((f) => [f.step, f.suites]), [['api-unit', ['test/checkout.test.js']]]);
  assert.equal(byId['web-unit'].status, 'reused', `the cache web-unit wrote did not block the next gate: ${byId['web-unit'].reason}`);
  const seen = fs.readFileSync(path.join(path.dirname(byId.e2e.log), 'env.txt'), 'utf8');
  assert.doesNotMatch(seen, /GAMEDAY_CANARY|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(w(['status', '--attempt', ID]).out, /flaky: api-unit \(test\/checkout\.test\.js\)/);
  assert.equal(exported('gated').flaky[0].step, 'api-unit');

  // Evidence pass by a fresh reviewer: blind closure first, then the earlier finding is revealed for verification.
  const start4 = ok(w(['handoff', 'reviewer', '--agent', 'rev-4', '--attempt', ID])).out.trim();
  const bundle4 = JSON.parse(fs.readFileSync(start4.match(/^Read (\S+)/)[1], 'utf8'));
  assert.equal(bundle4.gate.passedOnThisTree, true);
  assert.equal(bundle4.flaky[0].step, 'api-unit');
  assert.doesNotMatch(JSON.stringify(bundle4), /total ignores currency/, 'the bundle carries no earlier finding');
  agent(root, { name: 'rev-4', type: 'wf-reviewer', prompt: start4 });
  const clean = { reviewer: 'rev-4', findings: [], criteria };
  const blind = ok(w(['review', '--closure', closureFile(base, clean), '--attempt', ID])).out;
  assert.match(blind, /1 finding\(s\) from earlier rounds to verify/);
  assert.match(w(['accept', '--attempt', ID]).err, /earlier-round finding\(s\) not verified: rev-3:F1/);
  ok(w(['review', '--closure', closureFile(base, { ...clean, priorFindings: [{ round: 'rev-3', id: 'F1', status: 'fixed', evidence: 'backend/src/api.txt:1 uses the order currency' }] }), '--attempt', ID]));
  ok(w(['accept', '--attempt', ID]));

  // Delivery and the tracker readback.
  const d = ok(w(['deliver', '--attempt', ID, '--summary-file', summaryFile(base, 'Checkout now shows the order total, in the order\'s currency.')]));
  assert.match(d.out, /delivered GD-1\.1: backend@\w+, frontend@\w+/);
  const after = new Date(Date.now() + 1000).toISOString();
  const posted = postedComment(root, ID);
  assert.match(posted, /^GD-1 is ready for UAT\.\n\nCheckout now shows the order total, in the order's currency\.\n\nUAT scope:\n- The total shows on checkout\n- A EUR order shows €\n\nKnown limits and follow-ups:\n- Not delivered: caching moved to a follow-up\n$/, 'a criterion dropped by an amendment is a known limit');
  // Fault: a hand-built readback (the issue rebuilt from memory, the comment abridged) is refused.
  const hand = file('hand-delivered.json', issue('Ready for UAT', { comments: [{ id: 'c1', body: 'GD-1 is ready for UAT.\n\nUAT scope:\n- The total shows on checkout', createdAt: after }] }));
  const refused = w(['tracker', 'record', '--event', 'delivered', '--capture', hand, '--attempt', ID]).err;
  assert.match(refused, /not the unmodified tracker output \(get_issue fields missing: [^)]*stateHistory[\s\S]*no list_comments result/);
  assert.match(refused, /cp <saved path> issue\.json/);
  const abridged = file('abridged.json', rawReadback('GD-1', 'Ready for UAT', { comments: [{ id: 'c1', body: posted.replace(/\n- A EUR order shows €/, ''), createdAt: after }] }));
  assert.match(w(['tracker', 'record', '--event', 'delivered', '--capture', abridged, '--attempt', ID]).err, /the posted comment is not the one `wf` rendered[\s\S]*first difference at line 5: expected "- A EUR order shows €"/);
  const readback = file('delivered.json', rawReadback('GD-1', 'Ready for UAT', { comments: [{ id: 'c1', body: posted, createdAt: after }] }));
  const closed = ok(w(['tracker', 'record', '--event', 'delivered', '--capture', readback, '--attempt', ID]));
  assert.match(closed.out, /Attempt closed and worktrees removed/);
  const final = exported('done');
  assert.equal(final.phase, 'done');
  assert.deepEqual(final.tracker.done.map((t) => t.event), ['admitted', 'implementing', 'delivered']);
  assert.deepEqual(final.reviews.map((r) => r.reviewer), ['rev-3', 'rev-4', 'rev-4']);

  // The ledger holds every step, in order.
  const ledger = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', ID, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  for (const t of ['admitted', 'tracker.recorded', 'criteria.frozen', 'criteria.amended', 'handoff', 'check.finished', 'review.recorded', 'base.merged', 'gate.finished', 'gate.flaky', 'review.accepted', 'delivered', 'closed']) assert.ok(ledger.includes(t), t);
  assert.ok(ledger.indexOf('review.recorded') < ledger.indexOf('gate.finished'), 'the review came before the gate');

  // Hygiene: doctor names the cache directory a test run left behind.
  assert.match(ok(w(['doctor'])).out, /! warning: untracked files in frontend — light steps left 1 untracked path\(s\) on a clean base: \.cache\//);
});
