// A reviewer launched from a Codex session runs on Codex: the caller's own host launches it, as a fresh session that is not
// its launcher (no session or sandbox variable of the caller reaches it), in the attempt's worktrees folder, with the bundle as
// its whole prompt on stdin, read-only, writing only its review file; the handoff records the thread Codex started. A fake
// `codex` on PATH stands in for the program.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, withDoubles, ledgerLines } from './helpers/index.mjs';
import { fileLedger, startAttempt } from './decisions-helpers.mjs';
import { launchReviewer } from '../engine/contract.mjs';

const THREAD = '0f0f0f0f-1111-4222-8333-444455556666';
// Records its argv, working folder, stdin and the session variables it was given, then reports a started thread and a
// completed turn.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const env = {};
  for (const k of ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT']) env[k] = process.env[k] ?? null;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, env }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '${THREAD}' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`;

test('a reviewer launched from a Codex session runs on Codex, as a fresh read-only session in the worktrees folder that is not its launcher', async (t) => {
  const p = makeProject({ adapter: false });
  const bin = path.join(p.tmp, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), FAKE, { mode: 0o755 });
  const log = path.join(p.tmp, 'fake.log');
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WF_HOST_HOME: p.home, FAKE_LOG: log, WF_TEST: '1', CODEX_THREAD_ID: 'the-callers-thread', CODEX_SANDBOX: 'seatbelt' });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDECODE;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    p.cleanup();
  });
  const L = fileLedger();
  await withDoubles(L, () => startAttempt(L, p.root, 'TK-2.1'));
  const worktrees = path.join(p.root, '.wf-worktrees', 'TK-2.1');
  fs.mkdirSync(worktrees, { recursive: true });
  const bundle = { seat: 'whole', attempt: 'TK-2.1', tree: 'tree1', round: 1, prompt: 'You did not write this change. Read every product file in the diff.', model: 'model-x' };

  const r = await withDoubles(L, () => launchReviewer(p.root, 'TK-2.1', bundle));
  assert.deepEqual(r.session, { runtime: 'codex', id: THREAD }, 'the caller\'s host, with the thread it started');
  const h = ledgerLines(p.root, 'TK-2.1').find((e) => e.type === 'handoff');
  assert.deepEqual([h.data.role, h.data.launchedBy, h.data.session], ['reviewer', 'wf', r.session]);
  assert.deepEqual(h.actor, { runtime: 'codex', id: 'the-callers-thread' }, 'the launcher is recorded as the actor, never as the reviewer');
  for (let i = 0; i < 400 && !fs.existsSync(log); i++) await new Promise((res) => setTimeout(res, 25));
  const [run] = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(run.input, bundle.prompt);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(worktrees));
  assert.deepEqual(run.env, { CODEX_THREAD_ID: null, CODEX_SANDBOX: null, CLAUDE_CODE_SESSION_ID: null, CLAUDECODE: null, AI_AGENT: 'wf-reviewer' });
  assert.equal(run.args[run.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(run.args[run.args.indexOf('--output-last-message') + 1], r.closure);
  assert.equal(run.args[run.args.indexOf('--model') + 1], 'model-x');
});
