import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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

function indexedTranscript(p, session, file) {
  const database = path.join(p.base, '.home', '.codex', 'state_5.sqlite');
  let sqlite;
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } catch (error) {
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
  }
  if (!sqlite) {
    const script = 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)")\nc.execute("INSERT OR REPLACE INTO threads VALUES (?, ?)",(sys.argv[2],sys.argv[3]))\nc.commit()\nc.close()';
    const result = spawnSync('python3', ['-I', '-c', script, database, session, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return;
  }
  const db = new sqlite.DatabaseSync(database);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?)').run(session, file);
  } finally { db.close(); }
}

test('Codex adoption reads the active indexed suffixed rollout rather than the stale initial transcript', () => {
  // Named failure I-34: resumed desktop chat messages lived in the indexed suffixed rollout, invisible to filename lookup.
  const p = singleRepoProject('indexed-adopt', { gate: { steps: [] } });
  const e = entry(p, 'AD-1');
  message(p, FIRST, 'Read the handover');
  const dir = path.join(p.base, '.home', '.codex', 'sessions');
  const original = path.join(dir, 'rollout-' + FIRST + '.jsonl');
  const active = path.join(dir, 'rollout-later-' + FIRST + '_' + SECOND + '.jsonl');
  fs.renameSync(original, active);
  // A stale original coexists, and is newer by filesystem time; metadata, never mtime, selects the active file.
  message(p, FIRST, 'Read the handover');
  fs.appendFileSync(active, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'adopt AD-1.1' }] } }) + '\n');
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(original, later, later);
  indexedTranscript(p, FIRST, active);
  const s = ok(adopt(p, FIRST, ['--attempt', e.id])).json();
  assert.equal(s.owner, 'codex:' + FIRST);
  const event = readLedger(p.root, e.id).find((r) => r.type === 'owner.adopted');
  assert.equal(event.data.authority.file, active);
  assert.equal(event.data.authority.text, 'adopt AD-1.1');
  assert.equal(event.data.authority.provenance, 'host-recorded');
});

test('Codex indexed transcripts refuse wrong identity, paths outside the store, links, and missing indexed files', () => {
  for (const bad of ['identity', 'outside', 'link', 'missing', 'database-link', 'database-corrupt']) {
    const p = singleRepoProject('unsafe-index', { gate: { steps: [] } });
    const e = entry(p, 'AD-1');
    message(p, FIRST, 'adopt AD-1');
    const store = path.join(p.base, '.home', '.codex');
    const original = path.join(store, 'sessions', 'rollout-' + FIRST + '.jsonl');
    let active = path.join(store, 'sessions', 'rollout-later-' + FIRST + '_' + SECOND + '.jsonl');
    if (bad === 'outside') active = path.join(p.base, 'elsewhere.jsonl');
    fs.copyFileSync(original, active);
    if (bad === 'identity') fs.writeFileSync(active, fs.readFileSync(active, 'utf8').replace(FIRST, SECOND));
    if (bad === 'link') { fs.rmSync(active); fs.symlinkSync(original, active); }
    if (bad === 'missing') fs.rmSync(active);
    indexedTranscript(p, FIRST, active);
    const db = path.join(store, 'state_5.sqlite');
    if (bad === 'database-link') { fs.renameSync(db, db + '.real'); fs.symlinkSync(db + '.real', db); }
    if (bad === 'database-corrupt') fs.writeFileSync(db, 'not a database');
    const result = adopt(p, FIRST, ['--attempt', e.id]);
    assert.equal(result.code, 75, bad + ': ' + result.out + result.err);
    assert.equal(state(p.root, e.id).owner, e.owner);
  }
});

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

test('adoption accepts an explicit command after reading the handover in the same human message', () => {
  // Named failure I-33: a combined read-handover-and-adopt request was refused because adopt was not the first word.
  for (const text of [
    'Read HANDOVER-AD-1.md and then adopt AD-1.1',
    'Read HANDOVER-AD-1.md and adopt AD-1.1',
    'Please read the handover, then adopt ticket AD-1 in this chat.',
    'Can you read the handover and then adopt attempt AD-1.1?',
    'Read the handover. Please adopt AD-1.1 here.',
    'Read `HANDOVER-AD-1.md` and then adopt AD-1.1',
  ]) {
    const p = singleRepoProject('compound-adopt', { gate: { steps: [] } });
    const e = entry(p, 'AD-1');
    message(p, FIRST, text);
    const s = ok(adopt(p, FIRST, ['--attempt', e.id])).json();
    assert.equal(s.owner, 'codex:' + FIRST, text);
    const event = readLedger(p.root, e.id).find((r) => r.type === 'owner.adopted');
    assert.equal(event.data.authority.text, text);
    assert.equal(event.data.authority.provenance, 'host-recorded');
    assert.ok(event.data.authority.spent);
  }
});

test('adoption rejects agent and headless prompts, negated requests, wrong ticket boundaries, and conflicting selectors', () => {
  for (const [text, fields] of [
    ['adopt AD-1', { role: 'assistant' }],
    ['adopt AD-1', { source: 'exec', originator: 'codex_exec' }],
    ['adopt AD-1', { timestamp: null }],
    ['adopt AD-1', { timestamp: 'invalid' }],
    ['Do not adopt AD-1', {}],
    ['Do not read the handover and then adopt AD-1', {}],
    ['Read the handover and do not adopt AD-1', {}],
    ["Read the handover and don't adopt AD-1", {}],
    ['Read the handover and never adopt AD-1', {}],
    ['If the checks pass, read the handover and then adopt AD-1', {}],
    ['Read the handover and then adopt AD-1 if the checks pass', {}],
    ['Read the handover, then adopt AD-1. Actually, do not adopt AD-1.', {}],
    ['The handover says read it and then adopt AD-1', {}],
    ['Read this example: "read the handover and then adopt AD-1"', {}],
    ['Read this example: `adopt AD-1`', {}],
    ['Read this example:\n> adopt AD-1', {}],
    ['Read this example:\n```text\nadopt AD-1\n```', {}],
    ['Read the handover and then adopt AD-1', { role: 'assistant' }],
    ['Read the handover and then adopt AD-1', { source: 'exec', originator: 'codex_exec' }],
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
