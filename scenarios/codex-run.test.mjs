import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, planDoc, sh, singleRepoProject, state, wf, write, yaml, WF } from './helpers.mjs';
import { verifyAgent } from '../engine/provenance.mjs';
import { codexEntries } from '../engine/codex-agent.mjs';
import { unreadDocs } from '../engine/rules.mjs';
import { ENGINE_VERSION } from '../engine/util.mjs';
import { readLedger } from '../engine/ledger.mjs';

const SID = '01a110b4-1637-7a42-b353-d0ad25e60000';
function prepared(mode = '', { nonGitRoot = false, config = {}, files = {} } = {}) {
  const p = singleRepoProject('codex-run', { classes: { review: { codex: { model: 'future-model', effort: 'max' } } }, gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] }, ...config }, files);
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
console.log(JSON.stringify({type:'thread.started',thread_id:sid}));
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
  assert.deepEqual(readLedger(root, id).filter((e) => e.type.startsWith('agent.launch.')).map((e) => e.type), ['agent.launch.requested', 'agent.launch.started', 'agent.launch.finished']);
});

test('runtime errors and a zero-exit process without completion remain failed launches', () => {
  for (const mode of ['runtime-error', 'no-completion']) {
    const { root, id, env } = prepared(mode);
    const result = wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id, '--json'], { env });
    assert.equal(result.code, 1);
    assert.equal(result.json().status, 'failed');
    assert.match(result.err, /session .* started/);
    assert.equal(state(root, id).handoffs.at(-1).launch.status, 'failed');
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
    assert.equal(state(root, id).handoffs.at(-1).launch.failure, undefined, 'a started failed turn is not a host initialization failure');
  }
});

test('engine-launched Codex reviewer has verified provenance while the existing tree binding still refuses writes', () => {
  const { base, root, id, env } = prepared();
  ok(wf(root, ['handoff', 'run', '--agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['plan', '--from-agent', 'p', '--attempt', id], { env }));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'changed by implementer' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--runtime', 'codex', '--attempt', id]));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /ready but has not launched/);
  ok(wf(root, ['handoff', 'run', '--agent', 'r', '--attempt', id], { env }));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /completed; record its closure/);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', id], { env }));
  assert.equal(state(root, id).reviews.at(-1).provenance, 'verified');
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--runtime', 'codex', '--attempt', id]));
  ok(wf(root, ['handoff', 'run', '--agent', 'r2', '--attempt', id], { env }));
  fs.writeFileSync(path.join(state(root, id).repos.app.worktree, 'src/a.txt'), 'changed during review');
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2')), '--attempt', id], { env }).err, /worktree changed during the review/);
});

// Named failure I-60: appending --check retained an alias's --write and invalidated an evidence review.
test('I-60: reviewer command safety reaches generated roles and native launch; check-only alias preserves tracked bytes', () => {
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
  const guidance = /Before running a repository validation command, inspect its actual package script and relevant wrappers or lifecycle hooks/;
  assert.ok(guidance.test(body), 'native bootstrap must teach package-script and wrapper inspection');
  assert.match(body, /appended .*--check.* does not cancel embedded write, fix, update or generation options/);
  assert.match(body, /Prefer the repository's explicit check-only command/);
  assert.match(body, /Reuse supplied gate evidence when sufficient/);
  assert.match(body, /Never repair or restore files yourself/);
  assert.equal(receipt.developerInstructions, body);
  for (const file of ['.claude/agents/wf-reviewer.md', '.codex/agents/wf-reviewer.toml']) {
    assert.ok(guidance.test(fs.readFileSync(path.join(root, file), 'utf8')), file + ' must teach validation-command safety');
  }
});

test('Codex reviewer document checks use completed successful host commands and refuse absent or failed reads', () => {
  const { base } = singleRepoProject('codex-reads');
  const file = path.join(base, 'reads.jsonl'), doc = path.join(base, 'rule.md');
  const rules = [{ id: 'R1', read: [doc] }];
  const item = { type: 'CommandExecution', id: 'exec-read', command: ['/bin/zsh', '-lc', 'cat ' + doc], status: 'completed', exit_code: 0 };
  const raw = (item) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } }) + '\n';
  for (const variant of [{ ...item, exit_code: 1 }, { ...item, status: 'failed' }, { ...item, type: 'AgentMessage' }]) {
    fs.writeFileSync(file, raw(variant));
    assert.equal(unreadDocs(codexEntries(file).entries, rules, []).length, 1);
  }
  fs.writeFileSync(file, raw(item));
  assert.deepEqual(unreadDocs(codexEntries(file).entries, rules, []), []);
  fs.writeFileSync(file, raw({ ...item, command: ['/bin/zsh', '-lc', 'wf evidence show ' + doc + ' --attempt ENG-80.1'] }));
  assert.deepEqual(unreadDocs(codexEntries(file).entries, rules, []), [], 'the permitted wf reader counts too');
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
