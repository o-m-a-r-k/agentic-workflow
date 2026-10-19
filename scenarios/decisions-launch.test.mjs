// Stream 4: `wf` launches the reviewer with the bundle as its whole prompt, records the handoff with the session it
// launched, and resumes the session when the host reports the model at capacity (D61). Fake `claude` and `codex`
// commands on PATH stand in for the hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, withDoubles, ledgerLines } from './helpers/index.mjs';
import { fileLedger, startAttempt } from './decisions-helpers.mjs';
import { launchReviewer, filesRead } from '../engine/contract.mjs';

// The fake host: records its argv and stdin, writes a transcript in its own layout that reads `READ_FILE`, prints its
// event stream. While `<CAPACITY_FILE>` holds a number above 0 it fails at capacity and counts it down.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const home = process.env.WF_HOST_HOME, cwd = process.cwd(), now = new Date().toISOString();
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, args, input, session: process.env.CLAUDE_CODE_SESSION_ID ?? null }) + '\\n');
  let left = 0;
  try { left = Number(fs.readFileSync(process.env.CAPACITY_FILE, 'utf8')); } catch {}
  if (left > 0) fs.writeFileSync(process.env.CAPACITY_FILE, String(left - 1));
  if (kind === 'claude') {
    const sid = val('--session-id') ?? val('--resume');
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o) => JSON.stringify({ sessionId: sid, cwd, timestamp: now, entrypoint: 'sdk-cli', ...o });
    fs.appendFileSync(path.join(dir, sid + '.jsonl'), [line({ type: 'user', message: { role: 'user', content: input } }), line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: process.env.READ_FILE } }] } }), line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } })].join('\\n') + '\\n');
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
    console.log(JSON.stringify(left > 0 ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded_error' } : { type: 'result', subtype: 'success', is_error: false, session_id: sid }));
    process.exit(left > 0 ? 1 : 0);
  }
  const id = val('resume') ?? '0f0f0f0f-1111-4222-8333-444455556666';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  console.log(JSON.stringify(left > 0 ? { type: 'turn.failed', error: { message: 'server_overloaded' } } : { type: 'turn.completed' }));
  process.exit(left > 0 ? 1 : 0);
});
`;

async function setup(t) {
  const p = makeProject({ adapter: false });
  const bin = path.join(p.tmp, 'fakebin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WF_HOST_HOME: p.home, FAKE_LOG: path.join(p.tmp, 'fake.log'), CAPACITY_FILE: path.join(p.tmp, 'capacity'), READ_FILE: path.join(p.root, 'server/src/core/sum.mjs'), WF_TEST: '1', WF_CAPACITY_WAIT_MS: '10' });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    p.cleanup();
  });
  const L = fileLedger();
  await withDoubles(L, () => startAttempt(L, p.root, 'TK-1.1'));
  const log = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { p, L, log };
}
const bundle = { seat: 'whole', attempt: 'TK-1.1', tree: 'tree1', round: 1, prompt: 'You did not write this change. Read every product file in the diff.\nDiff: /x/diff.patch', model: null };
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}
const statusOf = (p) => {
  const dir = path.join(p.root, '.wf-evidence', 'attempts', 'TK-1.1', 'reviews');
  const runs = fs.readdirSync(dir).filter((d) => d.startsWith('launch-'));
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, runs.at(-1), 'status.json'), 'utf8'));
  } catch {
    return null;
  }
};

test('launchReviewer (Claude Code): the bundle is the whole prompt, the handoff names the session wf launched, its reads are readable', async (t) => {
  const { p, L, log } = await setup(t);
  const r = await withDoubles(L, () => launchReviewer(p.root, 'TK-1.1', bundle, { model: 'model-b' }));
  assert.equal(r.session.runtime, 'claude');
  const h = ledgerLines(p.root, 'TK-1.1').find((e) => e.type === 'handoff');
  assert.deepEqual([h.data.role, h.data.launchedBy, h.data.session.id, h.data.seat, h.data.model, h.data.tree], ['reviewer', 'wf', r.session.id, 'whole', 'model-b', 'tree1']);
  await until(() => statusOf(p)?.state === 'done');
  const [run] = log();
  assert.equal(run.input, bundle.prompt);
  assert.equal(run.session, null); // the launcher's session variable is not passed on
  assert.deepEqual([run.args[run.args.indexOf('--model') + 1], run.args.includes('--agents')], ['model-b', false]);
  assert.deepEqual(await filesRead(r.session, { home: p.home }), [process.env.READ_FILE]);
});

test('launchReviewer resumes the same session while the host reports the model at capacity (Claude Code and Codex)', async (t) => {
  const { p, L, log } = await setup(t);
  fs.writeFileSync(process.env.CAPACITY_FILE, '2');
  const r = await withDoubles(L, () => launchReviewer(p.root, 'TK-1.1', bundle));
  const s = await until(() => (statusOf(p)?.state === 'done' ? statusOf(p) : null));
  assert.equal(s.resumes, 2);
  const runs = log();
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.slice(1).map((x) => x.args[x.args.indexOf('--resume') + 1]), [r.session.id, r.session.id]);
  assert.match(runs[1].input, /at capacity/);

  fs.writeFileSync(process.env.CAPACITY_FILE, '1');
  const c = await withDoubles(L, () => launchReviewer(p.root, 'TK-1.1', { ...bundle, round: 2 }, { runtime: 'codex' }));
  assert.deepEqual(c.session, { runtime: 'codex', id: '0f0f0f0f-1111-4222-8333-444455556666' });
  await until(() => statusOf(p)?.state === 'done');
  const codexRuns = log().filter((x) => x.kind === 'codex');
  assert.equal(codexRuns.length, 2);
  assert.ok(codexRuns[1].args.includes('resume'));
});

test('launchReviewer refuses a bundle with no prompt, and reports a host that cannot start', async (t) => {
  const { p, L } = await setup(t);
  await withDoubles(L, async () => {
    await assert.rejects(launchReviewer(p.root, 'TK-1.1', { ...bundle, prompt: '' }), /no prompt/);
    fs.rmSync(path.join(p.tmp, 'fakebin', 'claude'));
    process.env.PATH = path.join(p.tmp, 'fakebin');
    await assert.rejects(launchReviewer(p.root, 'TK-1.1', bundle), /could not be launched/);
  });
});
