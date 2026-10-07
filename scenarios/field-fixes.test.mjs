// Fixes from the first real tickets run through the workflow. Each test names the failure it guards against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { append } from '../engine/ledger.mjs';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, planDoc, sh, singleRepoProject, stages, state, tmp, wf, write, yaml } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const line = (o) => JSON.stringify(o);
const homeOf = (root) => path.join(root, '..', '.home');

function admitted(name, config = {}, files = {}, item = 'ENG-1') {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, files);
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  return { ...p, e, id: e.id, wt: e.repos.app.worktree };
}

function planFile(dir, doc) {
  const f = path.join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
}

function pushToRemote(base, remote, files, msg) {
  const other = path.join(base, `other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sh(base, `git clone -q ${JSON.stringify(remote)} ${JSON.stringify(other)}`);
  sh(other, 'git config user.email o@example.test && git config user.name o');
  commitIn(other, files, msg);
  sh(other, 'git push -q origin main');
}

// A Claude Code subagent transcript as Claude Code writes it: <session>/subagents/agent-<id>.jsonl beside its meta.json.
function subagent(root, { name, agentType, entries, file = `agent-${Math.random().toString(36).slice(2)}` }) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-proj', 'session-1', 'subagents');
  write(dir, `${file}.meta.json`, JSON.stringify({ name, agentType }));
  write(dir, `${file}.jsonl`, entries.map(line).join('\n'));
}

const FIXTURE_STAGES = stages();
const PLANNER_YAML = [
  `survey: ${JSON.stringify(FIXTURE_STAGES.survey)}`,
  'plan:',
  '  summary: Change a.',
  'contract: |',
  '  GET /a returns { text }',
  'anchors:',
  '  - src/a.txt:1 the text',
  'tests:',
  '  changed: [test/a.spec.js]',
  '  run: ["node --test test/a.spec.js"]',
  'doNotRun: [e2e]',
  'externalServices: none',
  'agentSplit: one implementer',
  'criteria:',
  '  - id: C1',
  '    text: a changes',
  `impact: ${JSON.stringify(FIXTURE_STAGES.impact)}`,
].join('\n');

test('wf plan keeps the planner\'s top-level sections, refuses unknown keys, and the bundles carry the plan', () => {
  // Failure: an owner rewrote the planner output with contract/anchors/tests as top-level keys; `wf plan` read only
  // `plan`, and the frozen plan and every implementer bundle lost them.
  const { base, root, id } = admitted('plan-schema');
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  const unknown = wf(root, ['plan', '--file', planFile(base, { plan: 's', contracts: 'typo', criteria: [{ id: 'C1', text: 'a' }] }), '--attempt', id]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown top-level key\(s\) in the plan file: contracts; known keys: survey, plan, criteria, work, summary, contract, anchors, tests, doNotRun, externalServices, agentSplit, impact/);
  assert.match(wf(root, ['plan', '--file', planFile(base, { plan: { contract: 'x' }, contract: 'y', criteria: [{ id: 'C1', text: 'a' }] }), '--attempt', id]).err, /`contract` is given both at the top level and under `plan`/);
  const doc = { plan: { summary: 'Change a.', tests: { run: ['jest a'] } }, contract: 'GET /a', anchors: ['src/a.txt:1'], doNotRun: ['e2e'], externalServices: 'none', agentSplit: 'one', criteria: [{ id: 'C1', text: 'a changes' }] };
  const r = ok(wf(root, ['plan', '--file', planFile(base, planDoc(doc)), '--attempt', id]));
  assert.match(r.out, /plan sections: summary, tests, contract, anchors, doNotRun, externalServices, agentSplit/);
  const want = { summary: 'Change a.', tests: { run: ['jest a'] }, contract: 'GET /a', anchors: ['src/a.txt:1'], doNotRun: ['e2e'], externalServices: 'none', agentSplit: 'one' };
  assert.deepEqual(state(root, id).plan, want);
  const impl = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(impl.bundle, 'utf8')).plan, want, 'the implementer bundle carries every section');
  assert.match(JSON.parse(fs.readFileSync(impl.bundle, 'utf8')).instructions, /plan\.contract[\s\S]*plan\.tests\.run[\s\S]*plan\.doNotRun/);
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'b\n' });
  const rev = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(rev.bundle, 'utf8')).plan, want, 'the reviewer bundle carries every section');
});

test('wf plan --from-agent freezes the planner\'s last YAML block from its transcript, and refuses when none is found', () => {
  // Failure: the owner retyped the planner's output and dropped sections on the way.
  const { root, id } = admitted('plan-agent');
  const start = ok(wf(root, ['handoff', 'planner', '--agent', 'planner-7', '--attempt', id, '--json'])).json().startPrompt;
  const missing = wf(root, ['plan', '--from-agent', 'planner-7', '--attempt', id]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /no Claude Code subagent transcript named `planner-7` \(agent type wf-planner\)/);
  const t = new Date(Date.now() + 1000).toISOString();
  subagent(root, {
    name: 'planner-7',
    agentType: 'wf-planner',
    entries: [
      { type: 'user', timestamp: t, message: { role: 'user', content: start } },
      { type: 'assistant', timestamp: t, message: { model: 'model-b', content: [{ type: 'text', text: 'A first draft:\n```yaml\ncriteria: []\n```' }] } },
      { type: 'assistant', timestamp: t, message: { model: 'model-b', content: [{ type: 'text', text: `Final:\n\n\`\`\`yaml\n${PLANNER_YAML}\n\`\`\`` }] } },
    ],
  });
  // Same name, other agent type: not this planner.
  subagent(root, { name: 'planner-7', agentType: 'general-purpose', entries: [{ type: 'assistant', timestamp: t, message: { content: [{ type: 'text', text: '```yaml\ncriteria: [{ id: X, text: wrong }]\n```' }] } }] });
  const r = ok(wf(root, ['plan', '--from-agent', 'planner-7', '--attempt', id]));
  assert.match(r.out, /criteria frozen \(1\): C1\nplan sections: summary, contract, anchors, tests, doNotRun, externalServices, agentSplit \(from planner-7's transcript\)/);
  const s = state(root, id);
  assert.equal(s.plan.contract, 'GET /a returns { text }\n');
  assert.deepEqual(s.plan.tests, { changed: ['test/a.spec.js'], run: ['node --test test/a.spec.js'] });
  assert.equal(s.planSource.model, 'model-b', 'the model the planner ran on is recorded');
  assert.equal(fs.readFileSync(s.planSource.file, 'utf8'), PLANNER_YAML, 'the extracted block is kept verbatim in the evidence');
  assert.match(s.planSource.file, /plans\/plan-1\.raw\.yaml$/);
  assert.equal(s.planSource.provenance, 'verified');
});

test('tracker captures: the admitted capture needs the description, a recycled capture is refused, implementing is queued once', () => {
  const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' } };
  const { base, root, id } = admitted('tracker-captures', { tracker }, {}, 'ENG-80');
  const cap = (obj) => planFile(base, obj);
  // Failure: a hand-written capture without the issue body was accepted.
  const bare = wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: 'ENG-80', state: { name: 'In Progress' } } }), '--attempt', id]);
  assert.equal(bare.code, 75);
  assert.match(bare.err, /no issue description; save the raw tracker response unchanged \(the whole get_issue JSON\), or, if the issue really has no description, add "descriptionEmpty": true/);
  const raw = { identifier: 'ENG-80', title: 'Title only', description: '', state: { name: 'In Progress' } };
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ ...raw, descriptionEmpty: true }), '--attempt', id]));

  // Failure: a capture byte-identical to another attempt's was accepted (recycled, not read).
  const other = admitted('tracker-recycle', { tracker }, {}, 'ENG-81');
  const good = cap({ identifier: 'ENG-81', description: 'Do the thing.', state: { name: 'In Progress' } });
  ok(wf(other.root, ['tracker', 'record', '--event', 'admitted', '--capture', good, '--attempt', other.id]));
  ok(wf(other.root, ['abandon', '--reason', 'superseded', '--attempt', other.id]));
  const again = ok(wf(other.root, ['entry', '--item', 'ENG-81', '--owner', 'o', '--json'])).json();
  const recycled = wf(other.root, ['tracker', 'record', '--event', 'admitted', '--capture', good, '--attempt', again.id]);
  assert.equal(recycled.code, 75);
  assert.match(recycled.err, new RegExp(`byte-identical to the one recorded for ${other.id.replace('.', '\\.')} \\(admitted\\); read the issue again now`));

  // Failure: parallel work items queued one identical `implementing` read per implementer handoff.
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', planFile(base, planDoc({ criteria: [{ id: 'C1', text: 'a' }, { id: 'C2', text: 'b' }], work: [{ id: 'W1', criteria: ['C1'] }, { id: 'W2', criteria: ['C2'] }] })), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W1', '--agent', 'i1', '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--work', 'W2', '--agent', 'i2', '--attempt', id]));
  const pending = state(root, id).tracker.pending.filter((a) => a.event === 'implementing');
  assert.deepEqual(pending.map((a) => a.op), ['read', 'setStatus'], 'one implementing read and status check, not one per handoff');
});

test('with two open attempts every printed command names --attempt, and wf status --attempt shows only that attempt', () => {
  // Failure: `wf status` ignored --attempt, and with two open attempts no printed command could run as printed.
  const { base, root, id } = admitted('two-attempts');
  const second = ok(wf(root, ['entry', '--item', 'ENG-2', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['hold', '--reason', 'local only', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'b\n' });
  const one = ok(wf(root, ['status', '--attempt', id])).out;
  assert.match(one, new RegExp(`^${id.replace('.', '\\.')} `));
  assert.doesNotMatch(one, new RegExp(second.id.replace('.', '\\.')), 'only the named attempt is shown');
  const next = state(root, id).next;
  const commands = [...next.matchAll(/`(wf [^`]*)`/g)].map((m) => m[1]);
  assert.ok(commands.length >= 3, next);
  for (const c of commands) assert.match(c, new RegExp(`--attempt ${id.replace('.', '\\.')}$`), c);
  assert.match(state(root, second.id).next, new RegExp(`wf handoff planner --agent <id> --attempt ${second.id.replace('.', '\\.')}`));
  ok(wf(root, ['abandon', '--reason', 'done with it', '--attempt', second.id]));
  assert.doesNotMatch(state(root, id).next, /--attempt/, 'with one open attempt commands stay short');
});

test('a gate stop reason is shown only while the tree is unchanged, and wf review prints only a receipt', () => {
  // Failure: the stop reason (owner notes on earlier findings) and the owner's next steps reached a blind reviewer.
  const { base, root, id } = admitted('stale-text');
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  const wt = state(root, id).repos.app.worktree;
  commitIn(wt, { 'src/a.txt': 'b\n' });
  const tree = { app: sh(wt, 'git rev-parse HEAD') };
  append(root, id, 'gate.stopped', { runId: 'r1', reason: 'F1 still open: the null check in a' }, null);
  append(root, id, 'gate.finished', { runId: 'r1', status: 'stopped', tree, steps: [] }, null);
  assert.match(state(root, id).next, /gate stopped \(F1 still open: the null check in a\)/);
  commitIn(wt, { 'src/a.txt': 'fixed\n' });
  const next = state(root, id).next;
  assert.doesNotMatch(next, /F1 still open|gate stopped/, 'the reason is about a tree that no longer exists');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  const rec = ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { findings: [{ id: 'F1', status: 'open', summary: 's', evidence: 'x' }] })), '--attempt', id]));
  assert.equal(rec.out, 'review recorded (1 finding(s)).\n', 'no next steps, tracker actions or state on the reviewer console');
  assert.deepEqual(Object.keys(ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id, '--json'])).json()).sort(), ['attempt', 'file', 'findings', 'provenance', 'recorded', 'verify']);
});

test('wf status shows how far the base moved and whether it overlaps the change; wf base merge stops cleanly on conflicts', () => {
  // Failure: base movement surfaced only at delivery, after the gate and the review were spent on a stale base.
  const { base, root, remote, id, wt } = admitted('base-status', {}, { 'src/m.txt': '1\n2\n3\n4\n5\n', 'docs/r.md': 'r\n' });
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(wt, { 'src/a.txt': 'mine\n', 'src/m.txt': 'one\n2\n3\n4\n5\n' });
  assert.doesNotMatch(ok(wf(root, ['status'])).out, /base app/, 'nothing to say while the base is current');
  pushToRemote(base, remote, { 'docs/r.md': 'theirs\n' }, 'docs');
  assert.match(ok(wf(root, ['status'])).out, /base app: origin\/main moved 1 commit\(s\); no overlap with your changed files \(`wf base merge` merges it in\)/);
  pushToRemote(base, remote, { 'src/a.txt': 'theirs\n' }, 'conflicting');
  const r = ok(wf(root, ['resume', '--attempt', id, '--json'])).json();
  assert.deepEqual([r.base[0].commits, r.base[0].overlap], [2, ['src/a.txt']]);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /moved 2 commit\(s\); overlaps your changed files: src\/a\.txt/);
  const head = sh(wt, 'git rev-parse HEAD');
  const conflict = wf(root, ['base', 'merge', '--attempt', id]);
  assert.equal(conflict.code, 75);
  assert.match(conflict.err, /merging origin\/main into app conflicts in src\/a\.txt; the merge was aborted and app is unchanged/);
  assert.equal(sh(wt, 'git rev-parse HEAD'), head);
  assert.equal(sh(wt, 'git status --porcelain'), '', 'the worktree is left clean');
  assert.equal(state(root, id).baseMerges.length, 0);
  write(wt, 'src/x.txt', 'dirty\n');
  assert.match(wf(root, ['base', 'merge', '--attempt', id]).err, /commit or remove uncommitted changes before merging the base/);
});

test('wf base merge records the merge, notes overlapping files and says the gate and review no longer count', () => {
  const { base, root, remote, id, wt } = admitted('base-merge', {}, { 'src/m.txt': '1\n2\n3\n4\n5\n' });
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(wt, { 'src/m.txt': 'one\n2\n3\n4\n5\n' });
  ok(wf(root, ['gate', '--attempt', id]));
  pushToRemote(base, remote, { 'src/m.txt': '1\n2\n3\n4\nfive\n', 'src/n.txt': 'n\n' }, 'theirs');
  const m = ok(wf(root, ['base', 'merge', '--attempt', id]));
  assert.match(m.out, /app: merged origin\/main \(1 commit\(s\), 2 file\(s\)\); HEAD \w{10} -> \w{10}/);
  assert.match(m.out, /note: the merge brought in changes to files this ticket also changes: src\/m\.txt/);
  assert.match(m.out, /HEAD changed: the gate and the review are bound to the tree, so neither counts for the merged tree/);
  assert.equal(fs.readFileSync(path.join(wt, 'src/m.txt'), 'utf8'), 'one\n2\n3\n4\nfive\n');
  const s = state(root, id);
  assert.equal(s.baseMerges.length, 1);
  assert.deepEqual(s.baseMerges[0].overlap, ['src/m.txt']);
  assert.doesNotMatch(ok(wf(root, ['status'])).out, /base app/, 'the base is current again');
  assert.match(s.next, /run `wf gate`/, 'the gate on the old tree no longer counts');
  const rev = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id, '--json'])).json();
  assert.equal(JSON.parse(fs.readFileSync(rev.bundle, 'utf8')).bases.app, sh(wt, 'git rev-parse origin/main'), 'the reviewer diffs against the merged base');
  assert.match(ok(wf(root, ['base', 'merge', '--attempt', id])).out, /app: already on its base/);
});

function multiRepo(name, step) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [step] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n' });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n' });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

test('wf doctor warns when a step reads a sibling repo without alsoInputs', () => {
  // Failure: a passing end-to-end step was reused against old API code because the sibling was not an input.
  const run = 'cat ../web/src/w.txt && test -f "$WF_ROOT/.wf-worktrees/$WF_ATTEMPT/web/src/w.txt"';
  const bare = multiRepo('sibling-warn', { id: 'api-e2e', repo: 'api', run, inputs: ['src/**'] });
  const d = ok(wf(bare.root, ['doctor', '--no-steps']));
  assert.match(d.out, /! warning: step api-e2e reads repo web — its command references \.\.\/web but `alsoInputs` does not list web/);
  assert.match(d.out, /fix: add `alsoInputs: \[web\]` to step api-e2e/);
  assert.match(d.out, /doctor: all checks passed \(1 warning\(s\)\)/, 'a warning never fails doctor');
  const listed = multiRepo('sibling-ok', { id: 'api-e2e', repo: 'api', run, inputs: ['src/**'], alsoInputs: ['web'] });
  assert.doesNotMatch(ok(wf(listed.root, ['doctor', '--no-steps'])).out, /warning/);
});

test('gate steps get an allowlisted environment: no session tokens, adapter pass-through honoured', () => {
  // Failure: every step received the owner's whole environment, agent session tokens included.
  const envStep = { id: 'env', repo: 'app', run: 'env > "$WF_EVIDENCE/env.txt"', inputs: ['src/**'] };
  const { root, id, wt, base } = admitted('gate-env', { gate: { steps: [envStep], env: { pass: ['MY_PROJECT_*', 'ANTHROPIC_BASE_URL', 'CL*'] } } });
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(wt, { 'src/a.txt': 'b\n' });
  const env = { SECRET_CANARY: 'canary-value', CLAUDE_CODE_OAUTH_TOKEN: 'session-token', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://proxy.test', MY_PROJECT_FLAG: 'on', CLOUDSDK_X: 'c' };
  const g = JSON.parse(ok(wf(root, ['gate', '--attempt', id, '--json'], { env })).out);
  const seen = fs.readFileSync(path.join(path.dirname(g.steps[0].log), 'out', 'env.txt'), 'utf8');
  for (const leak of ['SECRET_CANARY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) assert.doesNotMatch(seen, new RegExp(`^${leak}=`, 'm'), `${leak} reached the step`);
  for (const passed of ['MY_PROJECT_FLAG=on', 'ANTHROPIC_BASE_URL=http://proxy.test', 'CLOUDSDK_X=c', `WF_STEP=env`]) assert.match(seen, new RegExp(`^${passed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
  assert.match(seen, /^PATH=/m);
  const bad = singleRepoProject('gate-env-bad', { gate: { steps, env: { pass: 'MY_*' } } });
  assert.match(wf(bad.root, ['doctor', '--no-steps']).out, /`gate\.env\.pass` must be a list/);
});

test('wf report shows active minutes and rounds; doctor warns when unpinned agents ran on several models', () => {
  // Failure: wall minutes counted idle time (185 wall vs ~21 active), and an effort comparison was confounded because
  // unpinned agents followed the owner session onto another model.
  // The planner runs at an unpinned class here, so it inherits the session's model (and doctor fails on it, I-25).
  const { base, root, id } = admitted('models', { roles: { planner: { class: 'full' } } });
  const t = (min) => new Date(Date.now() + 1000 + min * 60000).toISOString();
  write(path.join(homeOf(root), '.claude', 'projects', '-proj'), 'sess-1.jsonl', [line({ type: 'assistant', timestamp: t(0), message: { model: 'model-a', content: [] } })].join('\n'));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id, '--owner', 'o'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } }));
  assert.equal(state(root, id).handoffs[0].sessionModel, 'model-a', 'the model an unpinned agent inherits is recorded at handoff');
  subagent(root, {
    name: 'p',
    agentType: 'wf-planner',
    entries: [
      { type: 'user', timestamp: t(0), message: { role: 'user', content: 'Read the bundle' } },
      { type: 'assistant', timestamp: t(1), requestId: 'q1', message: { model: 'model-b', usage: { output_tokens: 5 }, content: [{ type: 'tool_use' }] } },
      { type: 'user', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', timestamp: t(3), requestId: 'q2', message: { model: 'model-b', usage: { output_tokens: 5 }, content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', timestamp: t(20), message: { role: 'user', content: 'One more thing' } },
      { type: 'assistant', timestamp: t(21), requestId: 'q3', message: { model: 'model-b', usage: { output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
    ],
  });
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  assert.equal(state(root, id).planSource.model, 'model-b');
  const rows = JSON.parse(ok(wf(root, ['report', '--json'])).out);
  const p = rows[0].roles.find((r) => r.role === 'planner');
  assert.deepEqual([p.wallMinutes, p.activeMinutes, p.rounds], [21, 4, 2], 'the 17-minute gap is idle; the second prompt is a resume');
  assert.deepEqual(p.roundDetail.map((r) => r.activeMinutes), [3, 1]);
  assert.deepEqual(rows[0].observedModels.sort(), ['model-a', 'model-b']);
  const d = wf(root, ['doctor', '--no-steps']);
  assert.match(d.out, /! warning: models in ENG-1\.1 — agents ran on model-a, model-b and a class a role runs at pins no model/);
  assert.match(d.out, /✗ config: planner model — the planner role runs at class `full`, which pins no Claude model/);
  const pinned = path.join(root, '.workflow', 'project.yaml');
  const cfg = JSON.parse(fs.readFileSync(pinned, 'utf8'));
  fs.writeFileSync(pinned, JSON.stringify({ ...cfg, classes: { full: { claude: { model: 'model-b' } } } }));
  assert.doesNotMatch(ok(wf(root, ['doctor', '--no-steps'])).out, /models in/, 'a pinned model silences the warning');
});
