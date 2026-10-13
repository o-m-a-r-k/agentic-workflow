import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readLedger } from '../engine/ledger.mjs';
import { ok, singleRepoProject, state, wf } from './helpers.mjs';

// 0.7.0 (D4), named failure: adoption waited for a natural-language request read back from the receiving chat's transcript
// (`adopt AD-1`, "read the handover and then adopt ..."), and refused real requests after the person had already asked.
// Taking over an attempt is now judged on the previous owner: a session that is gone or idle (no transcript write in 30
// minutes) is taken over as bookkeeping; one that is alive, a person-named owner, or a transcript that cannot be read needs
// the owner's `wf approve` (kind adopt-live), used once.

const OLD = '019cdead-beef-7000-8000-000000000011';
const NEW = '019cdead-beef-7000-8000-000000000012';
const THIRD = '019cdead-beef-7000-8000-000000000013';
const silent = { ownerSilent: true };

function rollout(p, session, { file = path.join(p.base, '.home', '.codex', 'sessions', 'rollout-' + session + '.jsonl'), ageMinutes = 0 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const records = [];
  if (!fs.existsSync(file)) records.push({ timestamp: at, type: 'session_meta', payload: { id: session, source: 'vscode', originator: 'Codex Desktop' } });
  records.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'working on AD-1' }] } });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const when = new Date(Date.now() - ageMinutes * 60 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

const adopt = (p, session, args, opts = {}) => wf(p.root, ['adopt', ...args, '--json'], { env: { CODEX_THREAD_ID: session }, ...opts });
const entry = (p, item, owner) => ok(wf(p.root, ['entry', '--item', item, '--owner', owner, '--json'], silent)).json();

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

test('an owner session that is gone is taken over as bookkeeping: holds are kept, a repeat is a no-op, nothing is approved', () => {
  // Named failure I-31: recovering a ticket depended on reopening its unavailable previous owner session.
  const p = singleRepoProject('gone-owner', { gate: { steps: [] } });
  const e = entry(p, 'AD-1', 'claude:unavailable-session');
  entry(p, 'AD-2', 'claude:unavailable-session');
  ok(wf(p.root, ['hold', '--attempt', e.id, '--reason', 'local only'], silent));
  const adopted = ok(adopt(p, NEW, ['--item', 'AD-1'], silent)).json();
  assert.equal(adopted.owner, 'codex:' + NEW);
  assert.equal(adopted.activeHold.reason, 'local only');
  assert.deepEqual(adopted.repos, e.repos);
  assert.deepEqual(adopted.owners, ['claude:unavailable-session', 'codex:' + NEW]);
  const transfers = readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].data.from, 'claude:unavailable-session');
  assert.equal(transfers[0].data.authority, undefined, 'bookkeeping carries no authority claim');
  assert.equal(transfers[0].actor, 'codex:' + NEW);
  assert.deepEqual(state(p.root, e.id).decisions, []);
  ok(adopt(p, NEW, ['--attempt', e.id], silent));
  assert.equal(readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted').length, 1, 'the owner adopting again changes nothing');
  assert.equal(state(p.root, 'AD-2.1').owner, 'claude:unavailable-session');
});

test('an idle owner session (no transcript write in 30 minutes) is taken over without approval; an active one needs it, once', () => {
  const idle = singleRepoProject('idle-owner', { gate: { steps: [] } });
  const a = entry(idle, 'AD-1', 'codex:' + OLD);
  rollout(idle, OLD, { ageMinutes: 31 });
  assert.equal(ok(adopt(idle, NEW, ['--attempt', a.id], silent)).json().owner, 'codex:' + NEW);

  const p = singleRepoProject('live-owner', { gate: { steps: [] } });
  const e = entry(p, 'AD-1', 'codex:' + OLD);
  rollout(p, OLD, { ageMinutes: 5 });
  const refused = adopt(p, NEW, ['--attempt', e.id], silent);
  assert.equal(refused.code, 75, refused.out + refused.err);
  assert.match(refused.err, /adopting AD-1\.1 from codex:\S+ is the owner's decision \(A1: adopt AD-1\.1 as codex:\S+ from codex:/);
  assert.equal(state(p.root, e.id).owner, 'codex:' + OLD);
  assert.equal(state(p.root, e.id).decisions[0].kind, 'adopt-live');
  // The scripted owner confirms it with `wf approve`; the adoption then records the decision it used.
  assert.equal(ok(adopt(p, NEW, ['--attempt', e.id])).json().owner, 'codex:' + NEW);
  const adopted = readLedger(p.root, e.id).find((r) => r.type === 'owner.adopted');
  assert.equal(adopted.data.decision, 'A1');
  assert.ok(state(p.root, e.id).decisions[0].spent, 'one approval, one adoption');

  // The owner changes back (the new owner has no transcript here: gone), then the first session is taken over again from
  // an owner that is alive: the key carries the number of earlier transfers, so it is a new question, not the old answer.
  ok(adopt(p, OLD, ['--attempt', e.id], silent));
  assert.equal(state(p.root, e.id).owner, 'codex:' + OLD);
  const again = adopt(p, NEW, ['--attempt', e.id], silent);
  assert.equal(again.code, 75, again.out + again.err);
  assert.match(again.err, /\(A2: /);
  assert.equal(state(p.root, e.id).owner, 'codex:' + OLD);
});

test('Codex liveness reads the active indexed suffixed rollout rather than the stale initial transcript', () => {
  // Named failure I-34: resumed desktop chat messages lived in the indexed suffixed rollout, invisible to filename lookup.
  for (const [activeAge, originalAge, adoptable] of [[40, 0, true], [0, 40, false]]) {
    const p = singleRepoProject('indexed-owner', { gate: { steps: [] } });
    const e = entry(p, 'AD-1', 'codex:' + OLD);
    const dir = path.join(p.base, '.home', '.codex', 'sessions');
    rollout(p, OLD, { ageMinutes: originalAge });
    const active = path.join(dir, 'rollout-later-' + OLD + '_' + THIRD + '.jsonl');
    rollout(p, OLD, { file: active, ageMinutes: activeAge });
    indexedTranscript(p, OLD, active);
    const result = adopt(p, NEW, ['--attempt', e.id], silent);
    assert.equal(result.code, adoptable ? 0 : 75, `active ${activeAge} min old, original ${originalAge} min old: ${result.out}${result.err}`);
    assert.equal(state(p.root, e.id).owner, adoptable ? 'codex:' + NEW : 'codex:' + OLD);
  }
});

test('a transcript that exists but cannot be read, and a person-named owner, are not dead: both need the approval', () => {
  for (const bad of ['identity', 'outside', 'link', 'missing', 'database-link', 'database-corrupt', 'two-files']) {
    const p = singleRepoProject('unreadable-owner', { gate: { steps: [] } });
    const e = entry(p, 'AD-1', 'codex:' + OLD);
    const original = rollout(p, OLD, { ageMinutes: 60 });
    const store = path.join(p.base, '.home', '.codex');
    if (bad === 'two-files') {
      // Two transcripts for one session: which is the session's is not decided, so liveness is not either.
      const copy = path.join(store, 'sessions', 'copy', 'rollout-copy-' + OLD + '.jsonl');
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.copyFileSync(original, copy);
    } else {
      let active = path.join(store, 'sessions', 'rollout-later-' + OLD + '_' + THIRD + '.jsonl');
      if (bad === 'outside') active = path.join(p.base, 'elsewhere.jsonl');
      fs.copyFileSync(original, active);
      if (bad === 'identity') fs.writeFileSync(active, fs.readFileSync(active, 'utf8').replace(OLD, THIRD));
      if (bad === 'link') { fs.rmSync(active); fs.symlinkSync(original, active); }
      if (bad === 'missing') fs.rmSync(active);
      indexedTranscript(p, OLD, active);
      const db = path.join(store, 'state_5.sqlite');
      if (bad === 'database-link') { fs.renameSync(db, db + '.real'); fs.symlinkSync(db + '.real', db); }
      if (bad === 'database-corrupt') fs.writeFileSync(db, 'not a database');
    }
    const result = adopt(p, NEW, ['--attempt', e.id], silent);
    assert.equal(result.code, 75, `${bad}: ${result.out}${result.err}`);
    assert.match(result.err, /is the owner's decision/, bad);
    assert.equal(state(p.root, e.id).owner, 'codex:' + OLD, bad);
  }
  const person = singleRepoProject('person-owner', { gate: { steps: [] } });
  const e = entry(person, 'AD-1', 'plain:alice');
  const refused = adopt(person, NEW, ['--attempt', e.id], silent);
  assert.equal(refused.code, 75, refused.out + refused.err);
  assert.match(refused.err, /adopting AD-1\.1 from alice is the owner's decision/);
  assert.equal(ok(adopt(person, NEW, ['--attempt', e.id])).json().owner, 'codex:' + NEW);
});

test('adoption refuses a closed attempt and conflicting selectors', () => {
  const p = singleRepoProject('closed-adopt', { gate: { steps: [] } });
  const e = entry(p, 'AD-1', 'claude:unavailable-session');
  assert.equal(adopt(p, NEW, ['--attempt', e.id, '--item', 'AD-2'], silent).code, 75);
  assert.equal(state(p.root, e.id).owner, e.owner);
  ok(wf(p.root, ['abandon', '--attempt', e.id, '--reason', 'no longer needed'], silent));
  const refused = adopt(p, NEW, ['--attempt', e.id], silent);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /closed/);
  assert.equal(readLedger(p.root, e.id).filter((r) => r.type === 'owner.adopted').length, 0);
});
