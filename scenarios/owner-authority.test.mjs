// Owner-only decisions (engine/owner.mjs, 0.5.0 second and third security reviews). Named failures: every 0.5.0
// decision that skips or settles a check took the caller's word, so any agent able to run `wf` made it on the owner's
// behalf; then a non-session owner's authority was granted from the absence of agent-runtime variables, which an agent
// can unset. Now: the owner session's own message (host-recorded, each message spent once), the owner session's own
// command for `wf handoff close`, or, for an owner with no session, the phrase typed back at an interactive terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENT_PROCESSES, terminalProcessProblem } from '../engine/owner.mjs';
import { readLedger } from '../engine/ledger.mjs';
import { lastCodexOwnerCommand } from '../engine/codex-command.mjs';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, ownerSays, sh, singleRepoProject, state, wf } from './helpers.mjs';

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const silent = { ownerSilent: true };
const NO_TTY = /not done: [\s\S]*needs the owner's authority; the attempt's owner `alex` has no host transcript, and this is not an interactive terminal[\s\S]*runs the command in their own terminal, where it asks them to type `/;

function implemented(name, owner, config = {}, files = {}) {
  const p = singleRepoProject(name, { gate: { steps }, ...config }, files);
  const e = ok(wf(p.root, ['entry', '--item', 'OA-1', '--owner', owner, '--json'])).json();
  ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
  return { ...p, e, id: e.id };
}

// A `wf` command on an interactive terminal (a pseudo-terminal from script(1)), the person typing `typed` after a pause.
const SCRIPT = process.platform === 'darwin' ? ['script', '-q', '/dev/null'] : ['script', '-qec'];
const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;
// The real ancestry of this test process (its terminal faked, since the runner has none): under an agent runtime the
// accepted-confirmation scenarios cannot run here, by design; the Linux legs of `npm run verify` run them.
const realPs = (pid, field) => {
  const r = spawnSync(['/bin/ps', '/usr/bin/ps'].find((p) => fs.existsSync(p)) ?? 'ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const underAgent = terminalProcessProblem((pid, field) => (field === 'tty' ? 'ttys001' : realPs(pid, field)));
const terminalSkip = !hasScript ? 'script(1) is not installed' : underAgent ? `runs only outside an agent runtime (${underAgent})` : false;
function atTerminal(root, args, typed) {
  const runner = path.join(root, '..', `tty-${Date.now()}.sh`);
  fs.writeFileSync(runner, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(WF)} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}\n`);
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(root, '..', '.wfhome'), WF_HOME: path.join(root, '..', '.home'), WF_IMPROVEMENTS_DIR: path.join(root, '..', '.improvements'), TYPED: typed };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const inner = process.platform === 'darwin' ? `${SCRIPT.join(' ')} sh ${JSON.stringify(runner)}` : `${SCRIPT.join(' ')} ${JSON.stringify(`sh ${runner}`)} /dev/null`;
  // Slow by design (CONTRIBUTING.md, "Running the suite"): the owner types two seconds after the prompt can appear and the
  // terminal stays open two more, as a person at a terminal would; the property is that wf waits for that typed line.
  const r = spawnSync('sh', ['-c', `(sleep 2; printf '%s\\n' "$TYPED"; sleep 2) | ${inner}`], { cwd: root, encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a non-session owner, no terminal, environment scrubbed: every owner-only decision is refused', () => {
  const a = implemented('oa-noterm', 'plain:alex');
  // wf gate --reason (out of the order of work)
  assert.match(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent).err, NO_TTY);
  // wf handoff reviewer --reason (an implementer still open)
  assert.match(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--reason', 'go', '--attempt', a.id], { ...silent, implementersOpen: true }).err, NO_TTY);
  // wf handoff close
  assert.match(wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent).err, NO_TTY);
  assert.equal(state(a.root, a.id).implementers[0].closedAt, null, 'nothing recorded');
  // wf release
  ok(wf(a.root, ['hold', '--reason', 'legal says wait', '--attempt', a.id], silent));
  assert.match(wf(a.root, ['release', '--attempt', a.id], silent).err, NO_TTY);
  assert.ok(state(a.root, a.id).activeHold, 'the hold stays');
  // wf adopt (the new owner confirms)
  assert.match(wf(a.root, ['adopt', '--owner', 'plain:new-owner', '--attempt', a.id], silent).err, /needs the owner's authority; the attempt's owner `new-owner` has no host transcript, and this is not an interactive terminal/);
  // An agent runtime refuses before any prompt, whatever the terminal.
  assert.match(wf(a.root, ['release', '--attempt', a.id], { ...silent, env: { CLAUDECODE: '1' } }).err, /this runs under an agent runtime \(CLAUDECODE\)/);
});

const pendingAdapter = `
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/' + ctx.branch], { cwd: ctx.worktree }); return { url: 'https://git.example.test/mr/1' }; },
  observe() { return { state: 'awaiting-merge' }; },
  readback() { return { ok: true }; },
};`;
const ciFailedAfterMerge = `
import { execFileSync } from 'node:child_process';
export default {
  integrate(ctx) { execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: ctx.worktree }); return { url: 'https://git.example.test/mr/2' }; },
  observe() { return { state: 'ci-failed' }; },
  readback() { return { ok: true }; },
};`;
const brokenAdapter = `export default { integrate() { return { url: 'https://git.example.test/mr/3' }; }, observe() { return { state: 'merged' }; }, readback() { return { ok: true }; } };`;

// Accepted with the owner `alex` (no session): the one owner step on the way, closing the implementer, is typed at a terminal.
function acceptedPlain(p, item) {
  const a = (() => {
    const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'plain:alex', '--json'])).json();
    ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
    ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
    ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', e.id]));
    commitIn(e.repos.app.worktree, { 'src/a.txt': 'b\n' });
    return e;
  })();
  const close = atTerminal(p.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], `close ${a.id}:impl-1`);
  assert.equal(close.code, 0, close.out);
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'rev-0', '--attempt', a.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('rev-0')), '--attempt', a.id]));
  ok(wf(p.root, ['gate', '--attempt', a.id]));
  ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', a.id]));
  ok(wf(p.root, ['review', '--closure', closureFile(p.base, goodClosure('rev-1')), '--attempt', a.id]));
  ok(wf(p.root, ['accept', '--attempt', a.id]));
  return { id: a.id };
}

test('a non-session owner, no terminal: acknowledging an adapter state, abandoning past an integration and re-pinning are refused', { skip: terminalSkip }, () => {
  const pend = singleRepoProject('oa-pending', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': pendingAdapter });
  const p = acceptedPlain(pend, 'OA-2');
  ok(wf(pend.root, ['deliver', '--attempt', p.id], silent));
  assert.match(wf(pend.root, ['abandon', '--reason', 'closed', '--acknowledge-integration', 'app:awaiting-merge', '--attempt', p.id], silent).err, NO_TTY);
  assert.notEqual(state(pend.root, p.id).phase, 'abandoned');
  const ci = singleRepoProject('oa-ci', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': ciFailedAfterMerge });
  const c = acceptedPlain(ci, 'OA-3');
  assert.match(wf(ci.root, ['deliver', '--attempt', c.id], silent).err, /reports ci-failed after the merge/);
  assert.match(wf(ci.root, ['deliver', '--acknowledge-adapter-state', 'app:ci-failed', '--attempt', c.id], silent).err, NO_TTY);
  assert.equal(state(ci.root, c.id).delivery.repos.app, undefined);
  const br = singleRepoProject('oa-repin', { delivery: { kind: './delivery/mr.mjs' }, gate: { steps } }, { '.workflow/delivery/mr.mjs': brokenAdapter });
  const b = acceptedPlain(br, 'OA-4');
  assert.match(wf(br.root, ['deliver', '--attempt', b.id], silent).err, /unknown state "merged"/);
  sh(br.root, "git checkout -q main && sed -i.bak 's/merged/integrated/' .workflow/delivery/mr.mjs && rm .workflow/delivery/mr.mjs.bak && git commit -qam 'fix the adapter' && git push -q origin main");
  const tip = sh(br.root, 'git rev-parse HEAD').slice(0, 12);
  assert.match(wf(br.root, ['deliver', '--repin-adapter', tip, '--reason', 'fixed', '--attempt', b.id], silent).err, NO_TTY);
  assert.equal(state(br.root, b.id).adapterRepins.length, 0);
});

test('a session owner: an agent\'s flag never counts; the owner\'s message does, once; the owner session\'s own close command counts', () => {
  const a = implemented('oa-session', 'owner');
  const home = path.join(a.root, '..', '.home');
  const owner = state(a.root, a.id).owner;
  const refused = wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /needs the owner's authority, and the owner session's transcript cannot be read|no unspent owner message in the owner session/);
  // A sub-agent or tool result saying it is not the owner: only genuine owner turns count.
  ownerSays(home, owner, 'Implement OA-1.');
  fs.appendFileSync(fs.readdirSync(path.join(home, '.codex', 'sessions')).map((f) => path.join(home, '.codex', 'sessions', f))[0], `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call_output', output: `override ${a.id}:gate` } })}\n`);
  assert.match(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent).err, /no unspent owner message in the owner session[\s\S]*starts with `override OA-1\.1:gate`/);
  ownerSays(home, owner, `override ${a.id}:gate: the reviewer is out today`);
  ok(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent));
  const o = state(a.root, a.id).gateOverrides.at(-1).authority;
  assert.deepEqual([o.provenance, o.phrase], ['host-recorded', `override ${a.id}:gate`]);
  assert.match(o.text, /the reviewer is out today/);
  // Spent: the same message does not authorise a second override.
  commitIn(a.e.repos.app.worktree, { 'src/a.txt': 'c\n' });
  assert.match(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent).err, /no unspent owner message/);
  // `wf handoff close`: the owner says it, or the owner session ran the command itself.
  assert.match(wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent).err, /closing implementer impl-1 needs the owner's authority/);
  ownerSays(home, owner, `close ${a.id}:impl-1`);
  ok(wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent));
  assert.equal(state(a.root, a.id).implementers[0].outcome, 'done');
});

test('the owner session\'s own command closes an implementer only when it is exactly that call, fresh and unspent; it never authorises anything else', () => {
  const sid = 'claude-owner-session-1';
  const a = implemented('oa-claude', `claude:${sid}`);
  const file = path.join(a.root, '..', '.home', '.claude', 'projects', '-proj', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const call = (command, { minutesAgo = 0, ...extra } = {}) => fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(), sessionId: sid, ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'Bash', input: { command } }] } })}\n`);
  const close = () => wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent);
  const exact = `wf handoff close --agent impl-1 --attempt ${a.id}`;
  const cases = [
    [exact, { isSidechain: true }, /the owner session ran no command/],
    [`echo wf handoff close --agent impl-1 --attempt ${a.id}`, {}, /not a wf invocation/],
    [`wf handoff close --agent impl-1 --attempt ${a.id} --outcome done`, {}, /has `--outcome`, which this decision does not name/],
    [`wf handoff close --agent impl-1 --attempt OTHER-9.1`, {}, /has `--attempt OTHER-9\.1`, not `--attempt OA-1\.1`/],
    [`wf handoff close --agent impl-1`, {}, /lacks --attempt/],
    [`wf handoff close --agent impl-1 --attempt ${a.id} && rm -rf /tmp/x`, {}, /not one plain wf invocation/],
    [`wf handoff close --agent impl-1 --attempt ${a.id}; true`, {}, /not one plain wf invocation/],
    [exact, { minutesAgo: 11 }, /ran more than 10 minutes ago/],
    ['git status', {}, /not a wf invocation/],
  ];
  for (const [command, extra, why] of cases) {
    call(command, extra);
    const r = close();
    assert.equal(r.code, 75, command);
    assert.match(r.err, why, command);
  }
  assert.equal(state(a.root, a.id).implementers[0].closedAt, null);
  call(exact);
  ok(close());
  const auth = state(a.root, a.id).implementers[0];
  assert.equal(auth.outcome, 'done');
  // Spent: a new implementer handoff under the same name is not closed by replaying the same call.
  ok(wf(a.root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', a.id], silent));
  assert.match(close().err, /its last command was already counted for a decision/);
  // The owner session's own command authorises bookkeeping only: never a gate override or a release.
  call(`wf gate --reason skip --attempt ${a.id}`);
  assert.match(wf(a.root, ['gate', '--reason', 'skip', '--attempt', a.id], silent).err, /needs the owner's authority, and no unspent owner message[\s\S]*starts with `override OA-1\.1:gate`; an agent's word/);
  call(`wf handoff reviewer --agent rev-9 --reason go --attempt ${a.id}`);
  assert.match(wf(a.root, ['handoff', 'reviewer', '--agent', 'rev-9', '--reason', 'go', '--attempt', a.id], { ...silent, implementersOpen: true }).err, /starts with `override OA-1\.1:review`; an agent's word/);
  // Only `wf handoff close` names a command path at all; every other owner-only decision is phrase-only.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'lifecycle.mjs'), 'utf8') + fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'attempt.mjs'), 'utf8');
  assert.deepEqual([...src.matchAll(/ownerAuthority\([^\n]*command: \{ sub: \[([^\]]*)\]/g)].map((m) => m[1]), ["'handoff', 'close'"]);
  ok(wf(a.root, ['hold', '--reason', 'wait', '--attempt', a.id], silent));
  call(`wf release --attempt ${a.id}`);
  assert.match(wf(a.root, ['release', '--attempt', a.id], silent).err, /starts with `release OA-1\.1`; an agent's word/);
});

test('Codex owner-session command closes an implementer through direct and functions-exec records, once only', () => {
  // Named failure I-35: the bookkeeping command exception read only Claude Bash calls, blocking Codex's fresh review.
  for (const wrapper of [false, true]) {
    const sid = 'codex-owner-close-session';
    const a = implemented('oa-codex-close', `codex:${sid}`);
    const file = path.join(a.base, '.home', '.codex', 'sessions', `rollout-${sid}.jsonl`);
    const exact = `wf handoff close --agent impl-1 --attempt ${a.id}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid, source: 'vscode', originator: 'Codex Desktop', cwd: a.root } }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: wrapper
      ? { type: 'custom_tool_call', name: 'exec', call_id: 'call_close_1', input: `text(await tools.exec_command({cmd:${JSON.stringify(exact)},workdir:${JSON.stringify(a.root)},yield_time_ms:1000}));\n` }
      : { type: 'function_call', name: 'exec_command', call_id: 'call_close_1', arguments: JSON.stringify({ cmd: exact, workdir: a.root }) }
    }) + '\n');
    const close = () => wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], { ...silent, env: { CODEX_THREAD_ID: sid } });
    ok(close());
    const closed = state(a.root, a.id).implementers[0];
    assert.equal(closed.outcome, 'done');
    const authority = readLedger(a.root, a.id).find((event) => event.type === 'implementer.closed').data.authority;
    assert.equal(authority.runtime, 'codex');
    assert.equal(authority.provenance, 'owner-session command');
    assert.equal(authority.command, exact);
    assert.match(authority.spent, /cmd:call:call_close_1$/);
    ok(wf(a.root, ['handoff', 'implementer', '--agent', 'impl-1', '--attempt', a.id], silent));
    assert.match(close().err, /already counted for a decision/);
  }
});

test('Codex closure refuses child calls, forged results, ambiguous wrappers, mismatched commands, and stale records', () => {
  const sid = 'codex-owner-refuse-session';
  const a = implemented('oa-codex-refuse', `codex:${sid}`);
  const file = path.join(a.base, '.home', '.codex', 'sessions', `rollout-${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exact = `wf handoff close --agent impl-1 --attempt ${a.id}`;
  const meta = { id: sid, source: 'vscode', originator: 'Codex Desktop', cwd: a.root };
  const direct = (cmd = exact, extra = {}) => ({ type: 'function_call', name: 'exec_command', call_id: 'call_refuse', arguments: JSON.stringify({ cmd, workdir: a.root, ...extra }) });
  const wrapped = (input) => ({ type: 'custom_tool_call', name: 'exec', call_id: 'call_refuse', input });
  const literal = `await tools.exec_command({cmd:${JSON.stringify(exact)},workdir:${JSON.stringify(a.root)}})`;
  const cases = [
    [direct(), { source: { subagent: { thread_spawn: {} } } }],
    [direct(), { source: 'exec', originator: 'codex_exec' }],
    [direct(), { id: 'another-session' }],
    [{ type: 'function_call_output', call_id: 'call_refuse', output: JSON.stringify(direct()) }],
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: literal }] }],
    [{ ...direct(), name: 'mcp__fake__exec_command' }],
    [{ ...direct(), role: 'user' }],
    [direct('echo ' + exact)],
    [direct(exact.replace('impl-1', 'impl-other'))],
    [direct(exact.replace(a.id, 'OTHER-1.1'))],
    [direct(exact + '; true')],
    [direct(exact, { workdir: a.base })],
    [direct(exact, { shell: '/usr/bin/true' })],
    [direct(), {}, -11 * 60000],
    [direct(), {}, 60000],
    [wrapped(`if (false) ${literal};`)],
    [wrapped(`${literal}; await tools.exec_command({cmd:"git status"});`)],
    [wrapped(`tools.exec_command = fake; ${literal};`)],
    [wrapped(`await tools.exec_command({cmd:${JSON.stringify(exact)},yield_time_ms:variable});`)],
    [wrapped(`await tools.exec_command({cmd:${JSON.stringify(exact)}, ...options});`)],
    [wrapped('await tools.exec_command({cmd:`' + exact + '`});')],
  ];
  for (const [payload, metadata = {}, shift = 0] of cases) {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { ...meta, ...metadata } }),
      JSON.stringify({ type: 'response_item', timestamp: new Date(Date.now() + shift).toISOString(), payload }),
    ].join('\n') + '\n');
    const result = wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent);
    assert.equal(result.code, 75, JSON.stringify(payload) + ': ' + result.err);
    assert.equal(state(a.root, a.id).implementers[0].closedAt, null);
  }
  // A command in a separate child transcript never counts as the owner's request.
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: meta }) + '\n');
  fs.writeFileSync(path.join(path.dirname(file), 'rollout-child-session.jsonl'), JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: direct() }) + '\n');
  assert.equal(wf(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], silent).code, 75);
  // The same owner command record never authorizes decisions beyond bookkeeping.
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: direct(`wf gate --reason skip --attempt ${a.id}`) }) + '\n');
  assert.equal(wf(a.root, ['gate', '--reason', 'skip', '--attempt', a.id], silent).code, 75);
  ok(wf(a.root, ['hold', '--reason', 'wait', '--attempt', a.id], silent));
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: direct(`wf release --attempt ${a.id}`) }) + '\n');
  assert.equal(wf(a.root, ['release', '--attempt', a.id], silent).code, 75);
});

test('Codex static command reader decodes literal strings and rejects duplicate keys without executing wrapper code', () => {
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'literal-session', source: 'cli', cwd: '/tmp' } });
  const read = (input) => lastCodexOwnerCommand(Buffer.from(meta + '\n' + JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_literal', input } })), 'literal-session');
  assert.equal(read("text(await tools.exec_command({cmd:'wf handoff close --agent impl-1 --attempt OA-1.1',workdir:'/tmp'}));").command, 'wf handoff close --agent impl-1 --attempt OA-1.1');
  assert.equal(read('await tools.exec_command({cmd:"wf handoff close --agent impl-1 --attempt OA-1.1",cmd:"other"});'), null);
  assert.equal(read('await tools.exec_command({cmd:runSomething()});'), null);
});

test('terminal confirmation, process checks: an agent runtime among the ancestors, an unreadable ancestry or no terminal device refuse', () => {
  const chain = { 10: ['5', 'node', 'node wf release'], 5: ['3', 'zsh', '-zsh'], 3: ['1', 'login', 'login -pf alex'] };
  const ps = (over = {}) => (pid, field) => {
    if (field === 'tty') return over.tty ?? 'ttys004';
    const row = { ...chain, ...over.chain }[pid];
    if (!row || over.unreadable === pid) return null;
    return { ppid: row[0], comm: row[1], command: row[2] }[field];
  };
  assert.equal(terminalProcessProblem(ps(), 10), '', 'a person at a login shell');
  assert.match(terminalProcessProblem(ps({ chain: { 5: ['4', 'zsh', '-zsh'], 4: ['3', '/usr/local/bin/claude', 'claude --resume'] } }), 10), /ancestor process \(pid 4, claude\) is an agent runtime \(Claude Code\)/);
  assert.match(terminalProcessProblem(ps({ chain: { 5: ['4', 'zsh', '-zsh'], 4: ['3', 'node', 'node /opt/lib/node_modules/@openai/codex/bin/codex.js'] } }), 10), /is an agent runtime \(Codex\)/);
  assert.match(terminalProcessProblem(ps({ unreadable: 5 }), 10), /process ancestry cannot be read at pid 5 \(fail closed\)/);
  assert.match(terminalProcessProblem(ps({ tty: '??' }), 10), /no controlling terminal device/);
  assert.match(terminalProcessProblem(ps({ tty: '?' }), 10), /no controlling terminal device/);
  assert.match(terminalProcessProblem(() => null, 10), /controlling terminal cannot be read \(fail closed\)/);
  assert.ok(AGENT_PROCESSES.length >= 5, 'the best-effort list lives in one place');
});

test('terminal confirmation under a process named like an agent runtime is refused, even on a terminal with a scrubbed environment', { skip: !hasScript && 'script(1) is not installed' }, () => {
  const a = implemented('oa-ancestor', 'plain:alex');
  ok(wf(a.root, ['hold', '--reason', 'wait', '--attempt', a.id], silent));
  const fake = path.join(a.root, '..', 'bin', 'claude');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.symlinkSync(process.execPath, fake);
  const runner = path.join(a.root, '..', 'under-agent.mjs');
  fs.writeFileSync(runner, `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(WF)}, 'release', '--attempt', ${JSON.stringify(a.id)}], { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`);
  const env = { ...process.env, WF_EVIDENCE_FLAGS: '0', WF_CONFIG_HOME: path.join(a.root, '..', '.wfhome'), WF_HOME: path.join(a.root, '..', '.home'), TYPED: `release ${a.id}` };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete env[k];
  const cmd = `${JSON.stringify(fake)} ${JSON.stringify(runner)}`;
  const inner = process.platform === 'darwin' ? `script -q /dev/null sh -c ${JSON.stringify(cmd)}` : `script -qec ${JSON.stringify(cmd)} /dev/null`;
  // Slow by design (CONTRIBUTING.md, "Running the suite"): the owner types two seconds after the prompt can appear and the
  // terminal stays open two more, as a person at a terminal would; the property is that wf waits for that typed line.
  const r = spawnSync('sh', ['-c', `(sleep 2; printf '%s\\n' "$TYPED"; sleep 2) | ${inner}`], { cwd: a.root, encoding: 'utf8', env });
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /is an agent runtime \(Claude Code\)/);
  assert.ok(state(a.root, a.id).activeHold, 'the hold stays');
});

test('a non-session owner at an interactive terminal types the phrase back: accepted and recorded unverified; anything else refuses', { skip: terminalSkip }, () => {
  const a = implemented('oa-tty', 'plain:alex');
  const wrong = atTerminal(a.root, ['release', '--attempt', a.id], 'yes');
  ok(wf(a.root, ['hold', '--reason', 'wait', '--attempt', a.id], silent));
  const wrong2 = atTerminal(a.root, ['release', '--attempt', a.id], 'yes');
  assert.notEqual(wrong2.code, 0, wrong2.out);
  assert.match(wrong2.out, /Type exactly `release OA-1\.1` to confirm[\s\S]*not confirmed \(typed "yes", not `release OA-1\.1`\)/);
  assert.ok(state(a.root, a.id).activeHold);
  const good = atTerminal(a.root, ['release', '--attempt', a.id], `release ${a.id}`);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /recorded as interactive-terminal \(unverified\): release OA-1\.1/);
  assert.equal(state(a.root, a.id).activeHold, null);
  const gate = atTerminal(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], `override ${a.id}:gate`);
  assert.equal(gate.code, 0, gate.out);
  assert.deepEqual(state(a.root, a.id).gateOverrides.at(-1).authority, { provenance: 'interactive-terminal (unverified)', phrase: `override ${a.id}:gate` });
  const close = atTerminal(a.root, ['handoff', 'close', '--agent', 'impl-1', '--attempt', a.id], `close ${a.id}:impl-1`);
  assert.equal(close.code, 0, close.out);
  assert.equal(wrong.code === 0, false, 'release without a hold is refused anyway');
});

// Fifth review: spends are project-wide and made before the action.
test('one owner message is spent once across the project: it cannot waive two reopens, serve another attempt, or be spent twice by racing commands', async () => {
  const p = singleRepoProject('oa-spend', { gate: { steps } });
  const { toAccepted } = await import('./helpers.mjs');
  const first = toAccepted(p.root, p.base, { item: 'OA-9' });
  ok(wf(p.root, ['deliver', '--attempt', first.id]));
  const home = path.join(p.root, '..', '.home');
  const owner = state(p.root, first.id).owner;
  // One waiver message, two reopens of the same delivered attempt: the second needs a message of its own.
  ownerSays(home, owner, `waive-lesson ${first.id}: a typo, nothing to learn`);
  const r1 = ok(wf(p.root, ['reopen', '--item', 'OA-9', '--reason', 'typo', '--no-lesson', 'nothing to learn', '--json'], silent)).json();
  assert.equal(state(p.root, r1.id).lessons.waived.reason, 'nothing to learn');
  ok(wf(p.root, ['abandon', '--reason', 'superseded', '--attempt', r1.id], silent));
  const again = wf(p.root, ['reopen', '--item', 'OA-9', '--reason', 'typo again', '--no-lesson', 'nothing to learn'], silent);
  assert.equal(again.code, 75, again.err);
  assert.match(again.err, /reopening OA-9 without a lesson needs the owner's authority, and no unspent owner message/);
  // A message names its attempt: an override said for one attempt never serves another.
  const a = implemented('oa-spend-a', 'owner');
  const b = (() => {
    const e = ok(wf(a.root, ['entry', '--item', 'OA-8', '--owner', 'owner', '--json'])).json();
    ok(wf(a.root, ['handoff', 'planner', '--agent', 'p2', '--attempt', e.id]));
    ok(wf(a.root, ['plan', '--file', criteriaFile(a.base), '--attempt', e.id]));
    ok(wf(a.root, ['handoff', 'implementer', '--agent', 'impl-2', '--attempt', e.id]));
    commitIn(e.repos.app.worktree, { 'src/a.txt': 'z\n' });
    return e;
  })();
  ownerSays(path.join(a.root, '..', '.home'), state(a.root, a.id).owner, `override ${a.id}:gate: just this one`);
  assert.match(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', b.id], silent).err, /starts with `override OA-8\.1:gate`/);
  ok(wf(a.root, ['gate', ...OUT_OF_ORDER, '--attempt', a.id], silent));
  // Two commands racing for one message: exactly one spends it.
  const c = implemented('oa-race', 'owner');
  ownerSays(path.join(c.root, '..', '.home'), state(c.root, c.id).owner, `override ${c.id}:review: the owner checked the tree`);
  const racer = path.join(c.root, '..', 'race.mjs');
  fs.writeFileSync(racer, `import { ownerAuthority } from ${JSON.stringify(path.join(import.meta.dirname, '..', 'engine', 'owner.mjs'))};\nconst state = JSON.parse(process.argv[2]);\ntry { ownerAuthority(${JSON.stringify(c.root)}, state, 'override ' + state.id + ':review', { what: 'race' }); console.log('won'); } catch (e) { console.log('lost'); }\n`);
  const s = JSON.stringify(state(c.root, c.id));
  const env = { ...process.env, WF_HOME: path.join(c.root, '..', '.home') };
  const { spawn } = await import('node:child_process');
  const run = () => new Promise((resolve) => {
    let out = '';
    const ch = spawn(process.execPath, [racer, s], { env });
    ch.stdout.on('data', (d) => (out += d));
    ch.on('exit', () => resolve(out.trim()));
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(results.sort(), ['lost', 'lost', 'lost', 'won'], 'one message, one spend');
});
