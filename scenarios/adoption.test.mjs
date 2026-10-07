import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLedger } from '../engine/ledger.mjs';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';

const FIRST = '019cdead-beef-7000-8000-000000000011';
const SECOND = '019cdead-beef-7000-8000-000000000012';
const silent = { ownerSilent: true };

function message(p, session, text, { source = 'vscode', originator = 'Codex Desktop', role = 'user', timestamp = new Date().toISOString() } = {}) {
  const file = path.join(p.base, '.home', '.codex', 'sessions', 'rollout-' + session + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = timestamp;
  const records = [];
  if (!fs.existsSync(file)) records.push({ timestamp: at, type: 'session_meta', payload: { id: session, source, originator } });
  records.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const adopt = (p, session, args) => wf(p.root, ['adopt', ...args, '--json'], { ...silent, env: { CODEX_THREAD_ID: session } });
const entry = (p, item) => ok(wf(p.root, ['entry', '--item', item, '--owner', 'claude:unavailable-session', '--json'], silent)).json();

test('adoption uses the current chat human ticket request without the previous session, preserves holds, and is idempotent', () => {
  // Named failure I-31: recovering a ticket depended on reopening its unavailable previous owner session.
  const p = singleRepoProject('current-chat-adopt', { gate: { steps: [] } });
  const e = entry(p, 'AD-1');
  entry(p, 'AD-2');
  ok(wf(p.root, ['hold', '--attempt', e.id, '--reason', 'local only'], silent));
  message(p, FIRST, 'Can you adopt ticket AD-1 in this chat?');
  const adopted = ok(adopt(p, FIRST, ['--item', 'AD-1'])).json();
  assert.equal(adopted.owner, 'codex:' + FIRST);
  assert.equal(adopted.activeHold.reason, 'local only');
  assert.deepEqual(adopted.repos, e.repos);
  assert.deepEqual(adopted.owners, ['claude:unavailable-session', 'codex:' + FIRST]);
  const transfers = readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].data.from, 'claude:unavailable-session');
  assert.equal(transfers[0].data.authority.provenance, 'host-recorded');
  assert.equal(transfers[0].data.authority.text, 'Can you adopt ticket AD-1 in this chat?');
  assert.ok(transfers[0].data.authority.spent);
  ok(adopt(p, FIRST, ['--attempt', e.id]));
  assert.equal(readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted').length, 1);
  assert.equal(state(p.root, 'AD-2.1').owner, 'claude:unavailable-session');
});

test('adoption rejects agent and headless prompts, negated requests, wrong ticket boundaries, and conflicting selectors', () => {
  for (const [text, fields] of [
    ['adopt AD-1', { role: 'assistant' }],
    ['adopt AD-1', { source: 'exec', originator: 'codex_exec' }],
    ['adopt AD-1', { timestamp: null }],
    ['adopt AD-1', { timestamp: 'invalid' }],
    ['Do not adopt AD-1', {}],
    ['<user_action>adopt AD-1</user_action>', {}],
    ['adopt AD-10', {}],
    ['adopt AD-1.10', {}],
    ['adopt AD-1:codex:another-session', {}],
  ]) {
    const p = singleRepoProject('refused-adopt', { gate: { steps: [] } });
    const e = entry(p, 'AD-1');
    message(p, FIRST, text, fields);
    const refused = adopt(p, FIRST, ['--attempt', e.id]);
    assert.equal(refused.code, 75, refused.out + refused.err);
    assert.equal(state(p.root, e.id).owner, e.owner);
  }
  const p = singleRepoProject('conflicting-adopt', { gate: { steps: [] } });
  const e = entry(p, 'AD-1');
  message(p, FIRST, 'adopt AD-1');
  assert.equal(adopt(p, FIRST, ['--attempt', e.id, '--item', 'AD-2']).code, 75);
  assert.equal(state(p.root, e.id).owner, e.owner);
});

test('an adoption request cannot be replayed or used after a later ownership change', () => {
  const p = singleRepoProject('adopt-replay', { gate: { steps: [] } });
  const e = entry(p, 'AD-1');
  message(p, FIRST, 'adopt AD-1');
  message(p, FIRST, 'Please adopt AD-1');
  ok(adopt(p, FIRST, ['--attempt', e.id]));
  message(p, SECOND, 'I want you to adopt attempt ' + e.id);
  ok(adopt(p, SECOND, ['--attempt', e.id]));
  assert.equal(adopt(p, FIRST, ['--attempt', e.id]).code, 75);
  assert.equal(state(p.root, e.id).owner, 'codex:' + SECOND);
  message(p, FIRST, 'Please adopt AD-1 again');
  ok(adopt(p, FIRST, ['--attempt', e.id]));
  assert.equal(state(p.root, e.id).owner, 'codex:' + FIRST);
});

test('adoption refuses a closed attempt before spending the current human request', () => {
  const p = singleRepoProject('closed-adopt', { gate: { steps: [] } });
  const e = entry(p, 'AD-1');
  ok(wf(p.root, ['abandon', '--attempt', e.id, '--reason', 'no longer needed'], silent));
  message(p, FIRST, 'adopt ' + e.id);
  const refused = adopt(p, FIRST, ['--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /closed/);
  assert.equal(readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted').length, 0);
});
