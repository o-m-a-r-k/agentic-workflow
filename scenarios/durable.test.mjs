// 0.1.8: durable artifacts, review provenance, wf check, flakes, scope, leases, doctor hygiene, secrets scope, Linear API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, summaryFile, tmp, wf, write, yaml } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const homeOf = (root) => path.join(root, '..', '.home');
const jsonFile = (dir, obj) => {
  const f = path.join(dir, `f-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};

function implemented(name, config = {}, files = {}, { item = 'ENG-1', plan, change = { 'src/a.txt': 'b\n' } } = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, files);
  const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', plan ? jsonFile(p.base, plan) : criteriaFile(p.base), '--attempt', e.id]));
  const impl = ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id, '--json'])).json();
  const wt = e.repos.app.worktree;
  if (change) commitIn(wt, change);
  return { ...p, id: e.id, wt, implBundle: JSON.parse(fs.readFileSync(impl.bundle, 'utf8')) };
}

test('raw plan, amendment and closure files are kept verbatim; wf export renders one self-contained page at any phase', () => {
  // Owner request: intermediate outputs, the plan above all, must never exist only in chat.
  const secret = { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'API_TOKEN', kind: 'provided', usedBy: ['unit'] }] }) };
  const p = singleRepoProject('durable', { gate: { steps } }, secret);
  ok(wf(p.root, ['secrets', 'set', 'API_TOKEN'], { input: 'tok_verysecret_123' }));
  const e = ok(wf(p.root, ['entry', '--item', 'ENG-9', '--owner', 'o', '--json'])).json();
  const early = ok(wf(p.root, ['export', '--attempt', e.id]));
  assert.match(early.out, /exported ENG-9\.1 to \S+attempt\.html\n {2}a view of the ledger and evidence/);
  assert.match(fs.readFileSync(path.join(p.root, '.wf-evidence/attempts/ENG-9.1/export/attempt.html'), 'utf8'), /not frozen yet/, 'a half-finished attempt exports');
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const planText = `${JSON.stringify({ plan: { summary: 'Change a.' }, criteria: [{ id: 'C1', text: 'a changes' }] }, null, 1)}\n`;
  const planPath = path.join(p.base, 'plan.json');
  fs.writeFileSync(planPath, planText);
  ok(wf(p.root, ['plan', '--file', planPath, '--attempt', e.id]));
  const s1 = state(p.root, e.id);
  assert.equal(fs.readFileSync(s1.planSource.file, 'utf8'), planText, 'the raw plan file is kept byte for byte');
  assert.match(s1.planSource.file, /plans\/plan-1\.raw\.json$/);
  assert.match(ok(wf(p.root, ['resume', '--attempt', e.id])).out, /warning: the frozen plan has no contract or anchors section/);
  const amendPath = jsonFile(p.base, { criteria: [{ id: 'C2', text: 'b also changes' }] });
  ok(wf(p.root, ['criteria', 'amend', '--file', amendPath, '--reason', 'the token tok_verysecret_123 leaked into a note', '--attempt', e.id]));
  assert.equal(fs.readFileSync(path.join(p.root, '.wf-evidence/attempts/ENG-9.1/plans/amend-1.raw.json'), 'utf8'), fs.readFileSync(amendPath, 'utf8'));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  ok(wf(p.root, ['gate', '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  const closure = closureFile(p.base, goodClosure('r', { findings: [{ id: 'F1', severity: 'minor', summary: 'naming', status: 'verified-nonissue', evidence: 'src/a.txt:1' }], criteria: [{ id: 'C1', evidence: { kind: 'output', ref: 'log' } }, { id: 'C2', evidence: { kind: 'output', ref: 'log' } }] }));
  ok(wf(p.root, ['review', '--closure', closure, '--attempt', e.id]));
  const raw = state(p.root, e.id).reviews.at(-1).raw;
  assert.equal(fs.readFileSync(raw.file, 'utf8'), fs.readFileSync(closure, 'utf8'), 'the raw closure is kept byte for byte');
  ok(wf(p.root, ['export', '--attempt', e.id]));
  const html = fs.readFileSync(path.join(p.root, '.wf-evidence/attempts/ENG-9.1/export/attempt.html'), 'utf8');
  for (const want of ['Change a.', 'b also changes', 'leaked into a note', 'F1', 'naming', 'verified-nonissue', 'unit', 'prefers-color-scheme: dark', 'name="viewport"']) assert.ok(html.includes(want), want);
  assert.doesNotMatch(html, /tok_verysecret_123/, 'catalogued secrets are masked in the export');
  assert.doesNotMatch(html, /<script|<link|src=|url\(/, 'no external requests');
  const j = JSON.parse(ok(wf(p.root, ['export', '--attempt', e.id, '--json'])).out);
  assert.deepEqual([j.item, j.criteria.length, j.amendments[0].changes.added, j.reviews[0].findings[0].id, j.gates[0].status], ['ENG-9', 2, ['C2'], 'F1', 'passed']);
  assert.match(ok(wf(p.root, ['resume', '--attempt', e.id])).out, /export: \S+attempt\.html/);
});

function claudeSubagent(root, name, agentType, prompt, at = new Date(Date.now() + 1000).toISOString()) {
  const dir = path.join(homeOf(root), '.claude', 'projects', '-proj', 'sess', 'subagents');
  const f = `agent-${Math.random().toString(36).slice(2)}`;
  write(dir, `${f}.meta.json`, JSON.stringify({ name, agentType }));
  write(dir, `${f}.jsonl`, [{ type: 'user', timestamp: at, message: { role: 'user', content: prompt } }, { type: 'assistant', timestamp: at, message: { model: 'm', content: [{ type: 'text', text: 'done' }] } }].map((x) => JSON.stringify(x)).join('\n'));
}

test('review provenance: a steered or unknown reviewer is refused where transcripts exist; elsewhere it is unverified', () => {
  // Named failures: a reviewer started with extra steering text, and a review round run outside the engine.
  const { base, root, id } = implemented('provenance');
  fs.mkdirSync(path.join(homeOf(root), '.claude', 'projects'), { recursive: true });
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-a', '--attempt', id])).out.trim();
  const none = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-a')), '--attempt', id]);
  assert.equal(none.code, 75);
  assert.match(none.err, /review provenance: no Claude Code subagent transcript named `rev-a`/);
  claudeSubagent(root, 'rev-a', 'wf-reviewer', `${start}\nFocus on the null check; the implementer already fixed F1.`);
  const steered = wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-a')), '--attempt', id]);
  assert.match(steered.err, /its start prompt was not exactly the printed line/);
  claudeSubagent(root, 'rev-a', 'general-purpose', start);
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-a')), '--attempt', id]).err, /ran as agent type `general-purpose`, not `wf-reviewer`/);
  claudeSubagent(root, 'rev-a', 'wf-reviewer', start);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('rev-a')), '--attempt', id]));
  assert.equal(state(root, id).reviews.at(-1).provenance, 'verified');
  const other = implemented('provenance-none');
  ok(wf(other.root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', other.id]));
  ok(wf(other.root, ['review', '--closure', closureFile(other.base, goodClosure('r')), '--attempt', other.id]));
  assert.equal(state(other.root, other.id).reviews.at(-1).provenance, 'unverified', 'no transcript store: recorded, not refused');
});

test('wf check runs light steps only, never counts as a gate, and the gate reuses what it proved', () => {
  const two = [{ id: 'lint', repo: 'app', run: 'true', inputs: ['src/**'], tier: 'light' }, { id: 'e2e', repo: 'app', run: 'true', inputs: ['src/**'], tier: 'heavy' }];
  const { root, id, wt, implBundle } = implemented('check', { gate: { steps: two } });
  assert.deepEqual(implBundle.check.steps.map((s) => s.id), ['lint'], 'the implementer bundle names the light steps');
  assert.match(implBundle.check.command, /^wf check --attempt ENG-1\.1/);
  assert.match(implBundle.instructions, /Done means `check\.command` passes/);
  const c = ok(wf(root, ['check', '--attempt', id]));
  assert.match(c.out, /^wf check: run[\s\S]*^check passed[\s\S]*skipped {5}e2e {2}`wf check` runs light steps only[\s\S]*never counts as one/m);
  const s = state(root, id);
  assert.equal(s.gates.length, 0);
  assert.equal(s.checks.length, 1);
  assert.match(s.next, /run `wf gate`/, 'a check opens nothing');
  const g = JSON.parse(ok(wf(root, ['gate', '--attempt', id, '--json'])).out);
  assert.deepEqual(g.steps.map((x) => [x.id, x.status]).sort(), [['e2e', 'passed'], ['lint', 'reused']]);
  write(wt, 'src/a.txt', 'dirty\n');
  assert.match(wf(root, ['check', '--attempt', id]).err, /commit changes before the check/);
});

test('a step that fails and then passes on the same inputs is recorded as flaky; --rerun-failed reruns only failed steps and never counts', () => {
  const flakyStep = { id: 'flaky', repo: 'app', run: 'if [ -f "$WF_ROOT/../flag" ]; then exit 0; fi; touch "$WF_ROOT/../flag"; exit 1', inputs: ['src/**'] };
  const always = { id: 'always', repo: 'app', run: 'true' };
  const { base, root, id } = implemented('flaky', { gate: { steps: [flakyStep, always] } });
  assert.equal(wf(root, ['gate', '--attempt', id]).code, 1);
  const r = ok(wf(root, ['gate', '--attempt', id, '--rerun-failed']));
  assert.match(r.out, /skipped {5}always {2}--rerun-failed reruns only the steps that failed last time/);
  assert.match(r.out, /flaky: flaky failed earlier and passed now with the same inputs/);
  assert.match(r.out, /--rerun-failed: proof while repairing/);
  const s = state(root, id);
  assert.equal(s.flaky[0].step, 'flaky');
  assert.match(ok(wf(root, ['status'])).out, /flaky: flaky failed and then passed with the same inputs/);
  const rev = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(rev.bundle, 'utf8'));
  assert.equal(bundle.flaky[0].step, 'flaky');
  assert.equal(bundle.gate.passedOnThisTree, false, 'a --rerun-failed gate is not the proof of the tree');
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id]));
  assert.match(wf(root, ['accept', '--attempt', id]).err, /skipped always/);
});

test('the gate starts light steps first and the longest heavy step first', () => {
  const order = [
    { id: 'h-short', repo: 'app', run: 'true', tier: 'heavy' },
    { id: 'h-long', repo: 'app', run: 'sleep 0.5', tier: 'heavy' },
    { id: 'light', repo: 'app', run: 'true', tier: 'light' },
  ];
  const { root, id } = implemented('schedule', { gate: { steps: order, maxParallelSteps: 1 } });
  const starts = (out) => [...out.matchAll(/wf gate: start {4}(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(starts(ok(wf(root, ['gate', '--attempt', id])).out), ['light', 'h-short', 'h-long'], 'no durations known yet: light first, then adapter order');
  assert.deepEqual(starts(ok(wf(root, ['gate', '--attempt', id])).out), ['light', 'h-long', 'h-short'], 'then the longest heavy step first');
});

test('changed files outside the plan are listed for the reviewer and warned about in wf status', () => {
  // Named failure: an implementer changed audit-read code outside the plan and nothing pointed the reviewer at it.
  const plan = { plan: { summary: 's', anchors: ['src/a.txt:1 the text'], tests: { changed: ['test/a.test.js'] } }, criteria: [{ id: 'C1', text: 'a' }] };
  const { base, root, id } = implemented('scope', {}, {}, { plan, change: { 'src/a.txt': 'b\n', 'test/a.test.js': 't\n', 'src/audit.txt': 'x\n' } });
  assert.match(ok(wf(root, ['status'])).out, /warning: 1 changed file\(s\) outside the plan: app:src\/audit\.txt/);
  const rev = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(rev.bundle, 'utf8')).outsidePlan, ['app:src/audit.txt']);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { outsidePlan: [{ file: 'app:src/audit.txt', verdict: 'covered', by: 'C1', evidence: 'C1 needs the audit read' }] })), '--attempt', id]));
});

test('wf run --lease holds a machine-wide slot for its command and waits while another holder has it', async () => {
  // Named failure: implementers started docker stacks outside the `docker: 1` lease and overloaded the machine.
  const { root } = singleRepoProject('lease-run', { gate: { steps, leases: { docker: 1 } } });
  const leases = path.join(root, '..', '.wfhome', 'leases');
  const r = ok(wf(root, ['run', '--lease', 'docker', '--', 'sh', '-c', `ls "${leases}"`]));
  assert.match(r.out, /^docker\.1$/m, 'the slot is held while the command runs');
  assert.deepEqual(fs.readdirSync(leases), [], 'and freed after');
  assert.equal(wf(root, ['run', '--lease', 'docker', '--', 'sh', '-c', 'exit 3']).code, 3, 'the command exit code is passed on');
  fs.writeFileSync(path.join(leases, 'docker.1'), String(process.pid));
  const env = { ...process.env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome') };
  const child = spawn(process.execPath, [WF, 'run', '--lease', 'docker', '--', 'sh', '-c', 'echo ran'], { cwd: root, env });
  let err = '';
  let out = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !err.includes('waiting'); i++) await new Promise((res) => setTimeout(res, 100));
  assert.match(err, /waiting for a `docker` lease \(1 slot\(s\), all held\)/);
  assert.equal(out, '');
  fs.rmSync(path.join(leases, 'docker.1'));
  assert.equal(await new Promise((res) => child.on('exit', res)), 0);
  assert.match(out, /ran/);
});

test('wf doctor lists untracked files light steps leave on a clean base, with the .gitignore lines', () => {
  const { root } = singleRepoProject('hygiene', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'mkdir -p .cache && touch .cache/x report.xml', tier: 'light' }] } });
  const d = ok(wf(root, ['doctor']));
  assert.match(d.out, /! warning: untracked files in app — light steps left 2 untracked path\(s\) on a clean base: \.cache\/, report\.xml/);
  assert.match(d.out, /fix: add to app\/\.gitignore:\n {6}\/\.cache\/\n {6}\/report\.xml/);
});

test('secrets: only keys a step uses (or required ones) are asked for; wf init drafts no unused keys', () => {
  // Named failure: `wf secrets guide` asked the owner for eleven secrets no gate step used.
  const keys = [{ key: 'UNUSED_A', kind: 'provided' }, { key: 'UNUSED_B', kind: 'provided' }, { key: 'UNUSED_C', kind: 'provided' }, { key: 'USED_KEY', kind: 'provided', usedBy: ['unit'] }];
  const { root } = singleRepoProject('secret-scope', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys }) });
  const g = wf(root, ['secrets', 'guide']);
  assert.match(g.out, /not needed by any step \(not asked\): UNUSED_A, UNUSED_B, UNUSED_C/);
  assert.match(g.out, /1 secret\(s\) to enter[\s\S]*\[1\/1\] USED_KEY/);
  assert.doesNotMatch(g.out, /\[\d\/\d\] UNUSED/);
  const st = wf(root, ['secrets', 'status']);
  assert.equal(st.code, 1);
  assert.match(st.out, /✗ USED_KEY[\s\S]*not needed by any step: UNUSED_A, UNUSED_B, UNUSED_C/);
  ok(wf(root, ['secrets', 'set', 'USED_KEY'], { input: 'value-123456' }));
  assert.match(ok(wf(root, ['secrets', 'status'])).out, /nothing to enter/);
  const none = singleRepoProject('secret-none', { gate: { steps } }, { '.workflow/secrets.yaml': yaml({ keys: keys.slice(0, 3) }) });
  assert.match(ok(wf(none.root, ['secrets', 'guide'])).out, /nothing to enter/);
  assert.doesNotMatch(ok(wf(none.root, ['doctor', '--no-steps'])).out, /✗ secrets/);
  const base = tmp('init-secrets');
  const dir = path.join(base, 'svc');
  makeRepo(dir, { 'package.json': JSON.stringify({ name: 'svc', scripts: { test: 'jest' } }), '.env.example': 'STRIPE_API_KEY=\nGITHUB_TOKEN=\nDB_PASSWORD=\nSENTRY_DSN=\nJWT_SECRET=\n' });
  const init = ok(wf(dir, ['init']));
  assert.match(init.out, /secrets: none a detected step uses \(not catalogued: STRIPE_API_KEY, GITHUB_TOKEN, DB_PASSWORD, SENTRY_DSN, JWT_SECRET\)/);
  assert.equal(fs.existsSync(path.join(dir, '.workflow', 'secrets.yaml')), false);
});

async function fakeLinear(base, issue) {
  const file = path.join(base, 'linear.json');
  fs.writeFileSync(file, JSON.stringify({ issue, states: [{ id: 's1', name: 'Todo' }, { id: 's2', name: 'In Progress' }, { id: 's3', name: 'Ready for UAT' }, { id: 's4', name: 'Done' }], log: [] }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'fake-linear.mjs'), file, 'lin_api_testkey_123'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(`${file}.port`); i++) await new Promise((r) => setTimeout(r, 50));
  return { url: `http://127.0.0.1:${fs.readFileSync(`${file}.port`, 'utf8')}/graphql`, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), stop: () => child.kill() };
}

test('tracker.via api: the engine performs and reads back admitted, implementing and delivered itself; without the key it falls back', async () => {
  const p0 = singleRepoProject('linear-api-tmp', {});
  const server = await fakeLinear(p0.base, { id: 'uuid-1', identifier: 'ENG-90', title: 'Show a', description: 'Show the new text.', url: 'https://linear.example.test/ENG-90', updatedAt: '2026-01-01T00:00:00.000Z', state: { name: 'Todo' }, comments: [], attachments: [] });
  try {
    const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
    const tracker = { kind: 'linear', via: 'api', apiUrl: server.url, statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' };
    const { base, root } = singleRepoProject('linear-api', { tracker, gate: { steps: visual } }, {
      '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n',
      '.workflow/secrets.yaml': yaml({ keys: [{ key: 'LINEAR_API_KEY', kind: 'provided', required: true }] }),
      '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n',
    });
    const noKey = ok(wf(root, ['entry', '--item', 'ENG-90', '--owner', 'o']));
    assert.match(noKey.out, /tracker: LINEAR_API_KEY is not set \(`wf secrets guide` in your terminal\); perform the tracker actions through the connector/);
    assert.ok(state(root, 'ENG-90.1').tracker.pending.length, 'actions stay pending for the agent flow');
    ok(wf(root, ['secrets', 'set', 'LINEAR_API_KEY'], { input: 'lin_api_testkey_123' }));
    const sync = ok(wf(root, ['tracker', 'sync', '--attempt', 'ENG-90.1']));
    assert.match(sync.out, /tracker: admitted performed through the API and read back/);
    assert.equal(server.read().issue.state.name, 'In Progress');
    const id = 'ENG-90.1';
    ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
    ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
    const h = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
    assert.match(h.err, /tracker: implementing performed through the API/);
    commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'ui\n' });
    const g = JSON.parse(ok(wf(root, ['gate', '--attempt', id, '--json'])).out);
    ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
    ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id]));
    ok(wf(root, ['accept', '--attempt', id]));
    const d = ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
    assert.match(d.out, /tracker: delivered waits for the owner: show the delivered screenshots/);
    assert.match(d.out, /SHOW TO OWNER \(1 delivered screenshot/);
    assert.ok(!server.read().log.includes('upload home.png'), 'nothing is uploaded before the owner captions it');
    const shownFile = path.join(base, 'shown.json');
    fs.writeFileSync(shownFile, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
    const sh = ok(wf(root, ['shown', '--file', shownFile, '--attempt', id]));
    assert.match(sh.out, /tracker: delivered performed through the API and read back; attempt closed/);
    const linear = server.read();
    assert.equal(linear.issue.attachments[0].subtitle, 'Home screen with the new text');
    assert.match(linear.issue.attachments[0].url, /^https:\/\/uploads\.linear\.app\//);
    assert.equal(linear.issue.state.name, 'Ready for UAT');
    assert.match(linear.issue.comments[0].body, /ENG-90 is ready for UAT\.\n\nThe home screen now shows the new text\.[\s\S]*- a shows the new text[\s\S]*\*\*1\. Home screen with the new text\*\*\n!\[home\.png\]\(https:\/\/uploads\.linear\.app\/fake\/home\.png\)/, 'the API embeds each uploaded screenshot by its asset url');
    assert.ok(linear.log.indexOf('attach home.png') < linear.log.indexOf('comment'), 'uploaded before the comment that embeds it');
    assert.deepEqual(linear.issue.attachments.map((a) => a.title), ['home.png']);
    assert.ok(linear.log.includes('upload home.png'));
    const s = state(root, id);
    assert.equal(s.phase, 'done');
    assert.deepEqual(s.tracker.done.map((t) => t.event), ['admitted', 'implementing', 'delivered']);
    for (const t of s.tracker.done) assert.doesNotMatch(fs.readFileSync(t.capture.path, 'utf8'), /lin_api_testkey_123/, 'the key never lands in a capture');
  } finally {
    server.stop();
  }
});
