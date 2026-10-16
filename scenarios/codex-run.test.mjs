import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, planDoc, sh, singleRepoProject, state, wf, write, yaml, WF } from './helpers.mjs';
import { verifyAgent } from '../engine/provenance.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';
import { readLedger } from '../engine/ledger.mjs';

const SID = '01a110b4-1637-7a42-b353-d0ad25e60000';
function prepared(mode = '', { nonGitRoot = false, config = {}, files = {} } = {}) {
  const p = singleRepoProject('codex-run', { classes: { review: { codex: { model: 'future-model', effort: 'max' } }, planning: { codex: { model: 'future-model', effort: 'max' } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, ...config }, files);
  if (nonGitRoot) {
    const cfg = JSON.parse(fs.readFileSync(path.join(p.root, '.workflow/project.yaml'), 'utf8'));
    cfg.repos[0].path = 'proj';
    commitIn(p.root, { '.workflow/project.yaml': yaml(cfg) });
    sh(p.root, 'git push -q origin main');
    fs.symlinkSync(path.join(p.root, '.workflow'), path.join(p.base, '.workflow'));
    p.root = p.base;
  }
  const { base, root } = p;
  const dir = path.join(base, 'bin');
  const host = path.join(base, '.home');
  write(dir, 'codex', `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), prompt = fs.readFileSync(0,'utf8');
if (${JSON.stringify(nonGitRoot)} && !args.includes('--skip-git-repo-check')) { console.error('Not inside a Git repository.'); process.exit(1); }
if (${JSON.stringify(mode === 'host-init')}) { console.error('Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)'); process.exit(1); }
const counter = ${JSON.stringify(path.join(base, 'counter'))};
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8')) + 1 : 0;
fs.writeFileSync(counter,String(n));
const sid = '${SID}'.slice(0,-4) + String(n).padStart(4,'0');
fs.writeFileSync(${JSON.stringify(path.join(base, 'spawn.json'))}, JSON.stringify({args,prompt,parent:process.env.CODEX_THREAD_ID??null,wfVersion:spawnSync('wf',['--version'],{encoding:'utf8'}).stdout.trim()}));
const file = path.join(${JSON.stringify(host)},'.codex','sessions','2026','10','08','rollout-test-'+sid+'.jsonl');
fs.mkdirSync(path.dirname(file),{recursive:true});
const at = new Date().toISOString(), line=(x)=>JSON.stringify({timestamp:at,...x});
const actual = prompt + ${JSON.stringify(mode === 'steered' ? ' Focus only on one file.' : '')};
fs.writeFileSync(file,[line({type:'session_meta',payload:{id:sid,timestamp:at,originator:'codex_exec',source:'exec',cwd:${JSON.stringify(root)}}}),line({type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:['agents_md.instructions','environments.environment_context']},content:[{type:'input_text',text:'# AGENTS.md instructions fixture'},{type:'input_text',text:'<environment_context>fixture</environment_context>'}]}}),line({type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']},content:[{type:'input_text',text:actual}]}}),line({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:${JSON.stringify('```yaml\n' + yaml(planDoc({ plan: 'Change a.', criteria: [{ id: 'C1', text: 'a changes' }] })) + '\n```')}}]}})].join('\\n')+'\\n');
if (${JSON.stringify(mode === 'closure-writer')}) {
  const body = JSON.parse(args.find(a => a.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  if (!body.includes('fs.writeFile') || !body.includes('apply_patch') || body.includes('with the Write tool, not a Bash heredoc')) {
    console.error('no supported Codex closure writer'); process.exit(1);
  }
  const bundle = JSON.parse(fs.readFileSync(prompt.slice(5).replace(/ and follow its instructions\\.$/, ''), 'utf8'));
  fs.writeFileSync(bundle.reviewClosureFile, ${JSON.stringify(JSON.stringify(goodClosure('r'), null, 2) + '\n')});
}
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
if (${JSON.stringify(mode === 'progress')}) {
  console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'private reasoning'}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'private tool output'}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Inspecting invoice permissions; loading-state defects are preliminary.'}}));
}
if (${JSON.stringify(mode === 'held')}) await new Promise(() => setInterval(() => {}, 1000));
if (${JSON.stringify(mode === 'runtime-error')}) console.log(JSON.stringify({type:'error'}));
if (${JSON.stringify(mode !== 'no-completion')}) console.log(JSON.stringify({type:'turn.completed'}));
process.exit(${mode === 'failed' ? 1 : 0});
`);
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  write(dir, 'wf', '#!/bin/sh\nprintf stale-engine\n');
  fs.chmodSync(path.join(dir, 'wf'), 0o755);
  const env = { PATH: dir + path.delimiter + process.env.PATH, WF_HOME: host };
  const id = ok(wf(root, ['entry', '--item', 'ENG-80', '--owner', 'o', '--json'])).json().id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--runtime', 'codex', '--attempt', id]));
  return { ...p, id, env, host };
}

test('engine-launched Codex planner records the exact fresh prompt and imports its unchanged YAML', () => {
  const { base, root, id, env, host } = prepared();
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  const launched = JSON.parse(fs.readFileSync(path.join(base, 'spawn.json'), 'utf8'));
  const h = state(root, id).handoffs.at(-1);
  assert.equal(launched.prompt, h.startPrompt);
  assert.equal(launched.parent, null);
  assert.equal(launched.wfVersion, ENGINE_VERSION, 'the child must use its launching engine, never a stale global CLI');
  assert.ok(launched.args.includes('future-model'));
  assert.ok(launched.args.includes('model_reasoning_effort="max"'));
  assert.ok(launched.args.some((a) => a.startsWith('developer_instructions=') && a.includes('You are the planner')));
  assert.ok(launched.args.includes('workspace-write'));
  assert.equal(h.session, SID);
  const previous = process.env.WF_HOME; process.env.WF_HOME = host;
  try { assert.equal(verifyAgent(h).status, 'verified'); } finally { if (previous === undefined) delete process.env.WF_HOME; else process.env.WF_HOME = previous; }
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  assert.equal(state(root, id).planSource.provenance, 'verified');
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }).code, 75, 'a handoff launches once');
});

test('native role progress goes to stderr while JSON remains one terminal result', () => {
  const { root, id, env } = prepared();
  const result = ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id, '--json'], { env }));
  assert.match(result.err, /Codex planner p: session .* started; configured future-model\/max/);
  assert.equal(result.json().status, 'completed');
  assert.equal(result.json().session, SID);
  assert.doesNotMatch(result.out, /process running|configured/);
  assert.deepEqual(readLedger(root, id).filter((e) => e.type.startsWith('agent.launch.')).map((e) => e.type), ['agent.launch.requested', 'agent.launch.spawned', 'agent.launch.started', 'agent.launch.finished']);
});

// Named failure: native reviewer commentary was discarded, leaving only liveness while real review progressed.
test('native role relays agent-reported progress without leaking reasoning or changing its terminal receipt', () => {
  const { root, id, env } = prepared('progress');
  const result = ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id, '--json'], { env }));
  assert.match(result.err, /agent report \(unverified\): Inspecting invoice permissions; loading-state defects are preliminary/);
  assert.doesNotMatch(result.err, /private reasoning|private tool output/);
  assert.equal(result.json().status, 'completed');
  assert.doesNotMatch(result.out, /Inspecting invoice permissions/);
  assert.deepEqual(readLedger(root, id).filter((e) => e.type.startsWith('agent.launch.')).map((e) => e.type), ['agent.launch.requested', 'agent.launch.spawned', 'agent.launch.started', 'agent.launch.finished']);
});

// 0.7.11, named failure (audit of role launches): an error event followed by a completed turn (a retried stream) was latched,
// and four roles that had finished their work were recorded failed. An error fails a launch only if no turn completes after it.
test('a passing error before a completed turn is a completed launch; a launch with no completed turn fails, and says why', () => {
  const passing = prepared('runtime-error');
  const ok1 = wf(passing.root, ['handoff', 'run', '--agent', 'p', '--attempt', passing.id, '--json'], { env: passing.env });
  assert.equal(ok1.code, 0, ok1.err);
  assert.equal(state(passing.root, passing.id).handoffs.at(-1).launch.status, 'completed');
  for (const mode of ['no-completion']) {
    const { root, id, env } = prepared(mode);
    const result = wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id, '--json'], { env });
    assert.equal(result.code, 1);
    assert.equal(result.json().status, 'failed');
    assert.match(result.err, /session .* started/);
    assert.equal(state(root, id).handoffs.at(-1).launch.status, 'failed');
    assert.deepEqual(state(root, id).handoffs.at(-1).launch.failure, { kind: 'exited', detail: 'no completed turn' }, 'why it ended is in the ledger');
    assert.equal(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }).code, 75);
  }
});

test('start is visible before a quiet child finishes and cancellation records failure', { timeout: 15_000 }, async () => {
  const { root, id, env } = prepared('held');
  const runtimeEnv = { ...process.env, ...env, WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_EVIDENCE_FLAGS: '0' };
  for (const key of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT', 'GROK_SESSION_ID']) delete runtimeEnv[key];
  const child = spawn(process.execPath, [WF, 'handoff', 'run', '--agent', 'p', '--attempt', id, '--json'], { cwd: root, env: runtimeEnv });
  let stderr = '', stdout = '';
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (bytes) => { stdout += bytes; });
  const started = new Promise((resolve, reject) => {
    child.stderr.on('data', (bytes) => { stderr += bytes; if (/session .* started/.test(stderr)) resolve(); });
    child.once('close', () => reject(new Error('role closed before start: ' + stderr)));
  });
  try {
    await started;
    assert.equal(child.exitCode, null, 'start is shown while the execution handle is still live');
    child.kill('SIGTERM');
    assert.equal(await exited, 1);
    assert.equal(JSON.parse(stdout).status, 'failed');
    assert.match(stderr, /interrupted/);
    assert.equal(state(root, id).handoffs.at(-1).launch.status, 'failed');
    assert.equal(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }).code, 75);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); }
});

test('review readiness: disappearing handed document refuses before native child spawn or launch receipt', () => {
  const { base, root, id, env } = prepared('', { config: { invariants: 'invariants.md' }, files: { '.workflow/invariants.md': '# Required invariants\n' } });
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'changed\n' });
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  const required = path.join(root, '.workflow/invariants.md');
  fs.unlinkSync(required);
  const refused = wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env });
  assert.equal(refused.code, 75);
  assert.match(refused.err, /review readiness refused before native launch[\s\S]*invariants: required document unavailable/);
  assert.equal(fs.existsSync(path.join(base, 'spawn.json')), false);
  assert.equal(state(root, id).handoffs.at(-1).launch, undefined);
  fs.writeFileSync(required, '# Required invariants\n');
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  assert.equal(state(root, id).handoffs.at(-1).launch.status, 'completed');
});

test('engine-launched Codex provenance refuses a steered prompt and a failed planner run', () => {
  for (const mode of ['steered', 'failed']) {
    const { root, id, env } = prepared(mode);
    const run = wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env });
    assert.equal(run.code, mode === 'failed' ? 1 : 0);
    const imported = wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env });
    assert.equal(imported.code, 75, imported.out);
    assert.match(imported.err, mode === 'failed' ? /not completed successfully/ : /start prompt/);
    assert.equal(state(root, id).criteria, null);
    assert.notEqual(state(root, id).handoffs.at(-1).launch.failure?.kind, 'host-initialization-permission', 'a started failed turn is not a host initialization failure');
  }
});

test('an engine-launched Codex reviewer is recorded as launched by the engine while the existing tree binding still refuses writes', () => {
  const { base, root, id, env } = prepared();
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'changed by implementer' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /ready but has not launched/);
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /reviewer r completed with no closure recorded[\s\S]*wf handoff reviewer --agent <new id>/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id], { env }));
  assert.equal(state(root, id).reviews.at(-1).provenance, 'engine-launched');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id]));
  ok(wf(root, ['handoff', 'run', '--agent', 'r2', '--attempt', id], { env }));
  fs.writeFileSync(path.join(state(root, id).repos.app.worktree, 'src/a.txt'), 'changed during review');
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', id], { env }).err, /uncommitted changes since the review round was handed/);
});

// Named failure I-75: the native bootstrap required an unavailable Claude writer after inspecting the tree.
test('I-75: native Codex writes and records its own closure without a Claude Write tool', () => {
  const { root, id, env } = prepared('closure-writer');
  ok(wf(root, ['plan', '--file', criteriaFile(path.dirname(root)), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  const tree = state(root, id).repos.app.worktree;
  commitIn(tree, { 'src/a.txt': 'implemented\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  const before = sh(tree, 'git rev-parse HEAD');
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  const h = state(root, id).handoffs.at(-1);
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(bundle.reviewClosureFile, 'utf8')).reviewer, 'r');
  ok(wf(root, ['review', '--closure', bundle.reviewClosureFile, '--attempt', id], { env }));
  assert.equal(state(root, id).reviews.at(-1).provenance, 'engine-launched');
  assert.equal(sh(tree, 'git rev-parse HEAD'), before);
  assert.equal(sh(tree, 'git status --porcelain'), '');
});

// Named failure I-60: appending --check retained an alias's --write and invalidated an evidence review.
test('I-60: a check-only alias preserves tracked bytes; the native reviewer launch records the instructions it was given and both role files are generated', () => {
  const scripts = { format: 'node formatter.mjs --write src/a.txt', 'format:check': 'node formatter.mjs --check src/a.txt' };
  const { base, root, id, env } = prepared('', { files: {
    'package.json': JSON.stringify({ private: true, scripts }),
    'formatter.mjs': "import fs from 'node:fs'; const args=process.argv.slice(2); if(args.includes('--write')) fs.writeFileSync('src/a.txt','formatted\\n'); console.log(JSON.stringify(args));\n",
  } });
  ok(wf(root, ['sync']));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  const tree = state(root, id).repos.app.worktree;
  commitIn(tree, { 'src/a.txt': 'changed\n' });
  const target = path.join(tree, 'src/a.txt'), original = fs.readFileSync(target);
  const actualScripts = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).scripts;
  // Model package-script forwarding, not a claim that guidance constrains arbitrary commands.
  const runAlias = (name, extra = []) => spawnSync(process.execPath, [...actualScripts[name].split(' ').slice(1), ...extra], { cwd: tree, encoding: 'utf8' });
  const unsafe = runAlias('format', ['--check']);
  assert.equal(unsafe.status, 0, unsafe.stderr);
  assert.deepEqual(JSON.parse(unsafe.stdout), ['--write', 'src/a.txt', '--check']);
  assert.notDeepEqual(fs.readFileSync(target), original, '--check did not remove the embedded write');
  fs.writeFileSync(target, original);
  const safe = runAlias('format:check');
  assert.equal(safe.status, 0, safe.stderr);
  assert.deepEqual(JSON.parse(safe.stdout), ['--check', 'src/a.txt']);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(sh(tree, 'git status --porcelain'), '');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  const launched = JSON.parse(fs.readFileSync(path.join(base, 'spawn.json'), 'utf8'));
  const body = JSON.parse(launched.args.find((a) => a.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  const receipt = JSON.parse(fs.readFileSync(state(root, id).handoffs.at(-1).launch.file, 'utf8'));
  assert.equal(receipt.developerInstructions, body, 'the receipt records the instructions the native reviewer was launched with');
  for (const file of ['.claude/agents/wf-reviewer.md', '.codex/agents/wf-reviewer.toml']) assert.ok(fs.statSync(path.join(root, file)).size > 0, `${file} is generated`);
});

test('I-44: resume reports failed native reviewer launches without claiming a reviewer is running', () => {
  const { base, root, id, env } = prepared('failed');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'changed' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }).code, 1);
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /launch failed; create a fresh reviewer handoff/);
  assert.doesNotMatch(ok(wf(root, ['resume', '--attempt', id])).out, /waiting for reviewer/);
  assert.equal(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id], { env }).code, 75);
});

test('I-46: a configured project root outside Git launches roles against its verified Git worktrees', () => {
  const { base, root, id, env } = prepared('', { nonGitRoot: true });
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  const launched = JSON.parse(fs.readFileSync(path.join(base, 'spawn.json')));
  assert.ok(launched.args.includes('--skip-git-repo-check'));
  assert.ok(launched.args.includes('workspace-write'));
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  assert.equal(state(root, id).planSource.provenance, 'verified');
});

test('I-47: host initialization permission failures name approved recovery, preserve failed receipts and refuse reuse', () => {
  const { root, id, env } = prepared('host-init');
  const r = wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env });
  assert.equal(r.code, 1);
  assert.match(r.err, /approved host execution/);
  assert.match(r.err, /fresh handoff/);
  assert.match(r.err, /child sandbox/);
  const h = state(root, id).handoffs.at(-1);
  assert.equal(h.launch.status, 'failed');
  assert.equal(h.launch.failure.kind, 'host-initialization-permission');
  assert.equal(h.session, null);
  assert.ok(h.launch.file);
  assert.equal(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }).code, 75);
});

// 0.7.0, named failure (final review): a hung role run in the foreground blocked the owner with no way back. The launcher
// returns once the role passes the estimate it stated itself, leaving it running; the owner follows it again (`wf handoff
// wait`, with its own new expectation) or ends it (`wf handoff stop`) and hands a fresh one. No number is the engine's.
test('a launched role past its own estimate hands control back while it keeps running; wait follows it again and stop ends it', { timeout: 30_000 }, async () => {
  const { base, root, id, env } = prepared('held');
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id], { env }));
  const handed = ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--runtime', 'codex', '--attempt', id, '--json'], { env })).json();
  const h = state(root, id).handoffs.at(-1);
  fs.mkdirSync(path.dirname(h.reportFile), { recursive: true });
  fs.writeFileSync(h.reportFile, JSON.stringify({ implementer: 'i', approach: 'edit a', expect: { minutes: 0.02 } }));
  const run = wf(root, ['handoff', 'run', '--agent', 'i', '--attempt', id, '--json'], { env });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.json().status, 'running');
  assert.match(run.err, /is still running \(pid \d+, \d+ min since launch, past its own estimate of 0\.02 min\)/);
  assert.match(run.err, /wf handoff wait --agent i/);
  const launch = state(root, id).handoffs.at(-1).launch;
  assert.equal(launch.status, 'running');
  assert.ok(launch.pid > 0);
  assert.doesNotThrow(() => process.kill(launch.pid, 0), 'the role is still running');
  const waited = wf(root, ['handoff', 'wait', '--agent', 'i', '--minutes', '0.03', '--attempt', id, '--json'], { env });
  assert.equal(waited.json().status, 'running');
  assert.match(waited.err, /the 0\.03 min you chose to wait/);
  ok(wf(root, ['handoff', 'stop', '--agent', 'i', '--reason', 'silent past its estimate', '--attempt', id], { env }));
  const after = state(root, id).handoffs.at(-1).launch;
  assert.deepEqual([after.status, after.failure.kind], ['failed', 'stopped']);
  for (let n = 0; n < 40; n++) {
    try { process.kill(launch.pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.throws(() => process.kill(launch.pid, 0), 'the role process group ended');
  assert.equal(wf(root, ['handoff', 'wait', '--agent', 'i', '--attempt', id, '--json'], { env }).json().status, 'failed');
  void handed;
});

// Second final review of 0.7.0 (O9): a role that states no estimate (a planner, a strategist) still trapped the owner. The
// owner's own expectation (`--minutes`) is the return point for such a role; the engine picks no number.
test('a launched role that states no estimate returns at the owner\'s own expectation and keeps running', { timeout: 30_000 }, async () => {
  const { root, id, env } = prepared('held');
  const run = wf(root, ['handoff', 'run', '--agent', 'p', '--minutes', '0.02', '--attempt', id, '--json'], { env });
  assert.equal(run.code, 0, run.err);
  assert.equal(run.json().status, 'running');
  assert.match(run.err, /past your expectation of 0\.02 min \(it stated none\)/);
  ok(wf(root, ['handoff', 'stop', '--agent', 'p', '--attempt', id], { env }));
  assert.match(wf(root, ['handoff', 'run', '--agent', 'p', '--minutes', 'soon', '--attempt', id], { env }).err, /--minutes is a positive number|already launched/);
});

// 0.7.22: a planning panel's two drafts run at the same time; an engine-launched role returns once it has started.
test('wf handoff run --detach returns once the role has started; wf handoff wait and stop follow it', () => {
  const { root, id, env } = prepared('held');
  const started = Date.now();
  const r = ok(wf(root, ['handoff', 'run', '--agent', 'p', '--detach', '--attempt', id], { env }));
  assert.ok(Date.now() - started < 30000, 'it does not wait for the role to finish');
  assert.match(r.err, /planner p is still running .*detached as you asked/);
  assert.ok(state(root, id).handoffs.at(-1).launch?.session, 'the session it started is recorded');
  ok(wf(root, ['handoff', 'stop', '--agent', 'p', '--attempt', id], { env }));
});
