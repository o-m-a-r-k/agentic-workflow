// 0.7.4, stream 5: no `wf` command writes a file into an attempt's evidence outside the transaction that records it.
//
// Named failure (I-109): a command wrote a file into the evidence first and recorded it in the manifest later (when the process
// ended, or in a later transaction), so a `wf status`, `wf resume` or `wf verify` another session ran in between was refused
// with "<file>: extra file (not written by wf)" (a file rewritten in place read as a size or sha256 mismatch). Streams 1 and 2
// closed the reviewer bundle, the rule copies, the plan, the amendments, the strategist bundle and the issue file; this file
// closes the rest: the export page, the owner's summary and the delivered comment, every tracker capture (the engine's own
// readback included), imported captures and a scope ticket's readback.
//
// The technique is the one of fix-074-lifecycle and fix-074-gate: a runner stands in for `bin/wf` and stops the writer at the
// moment a file lands in the evidence, starts a real `wf status` against the attempt, and lets the writer go on once that
// reader has either finished (refused, when the file was exposed) or is queued behind the evidence lock (the transaction is
// held, as it must be). The runner also records, for every file a command puts into the evidence, whether the transaction was
// held, and, each time the lock is let go, whether the evidence verifies: both are needed for the whole class, not one site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WF, closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, spawnHome, state, summaryFile, wf, write, yaml } from './helpers.mjs';
import { seed } from './fixtures/fake-github.mjs';
import { verifyAttempt } from '../engine/evidence.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

// ---- the runner and the reader ------------------------------------------------------------------------------------------------

const RUNNER = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { main } from ${JSON.stringify(path.join(ENGINE, 'cli.mjs'))};
import { verifyAttempt } from ${JSON.stringify(path.join(ENGINE, 'evidence.mjs'))};
const log = process.env.TXN_LOG, dir = process.env.TXN_DIR, probe = process.env.TXN_PROBE;
const pauses = JSON.parse(process.env.TXN_PAUSES ?? '[]');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const note = (what) => fs.appendFileSync(log, JSON.stringify(what) + '\\n');
const EVIDENCE = /^(.*)\\/\\.wf-evidence\\/attempts\\/([^/]+)\\/(.+)$/;
const lockOf = (root, id) => path.join(fs.realpathSync(root), '.wf-worktrees', '_transactions', id + '.lock');
const holds = (root, id) => { try { return JSON.parse(fs.readFileSync(lockOf(root, id), 'utf8')).pid === process.pid; } catch { return false; } };
const fired = new Set();
function landed(target) {
  const m = EVIDENCE.exec(String(target));
  if (!m) return;
  const [, root, id, rel] = m;
  // The ledger is written under the lock but is not a recorded file; a gate run records its own folder; a temporary file is renamed.
  if (rel.startsWith('gate/') || rel.startsWith('ledger.jsonl') || /\\.wf-\\d+-[0-9a-f]{8}$/.test(rel)) return;
  if (!holds(root, id)) note({ kind: 'written outside the transaction', rel });
  for (const p of pauses) {
    if (fired.has(p.label) || !new RegExp(p.match).test(rel)) continue;
    fired.add(p.label);
    fs.writeFileSync(path.join(dir, p.label + '.fired'), '');
    spawn(process.execPath, [probe, root, id, path.join(dir, p.label), p.reader ?? 'verify'], { detached: true, stdio: 'ignore' }).unref();
    const end = Date.now() + 15000;
    while (Date.now() < end && !fs.existsSync(path.join(dir, p.label + '.result')) && !fs.existsSync(path.join(dir, p.label + '.blocked'))) Atomics.wait(sleeper, 0, 0, 20);
  }
}
const { O_CREAT, O_EXCL } = fs.constants;
const open = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  const fd = open.call(this, p, flags, ...rest);
  if (typeof flags === 'number' && (flags & O_CREAT) && (flags & O_EXCL)) landed(p);
  return fd;
};
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = rename.call(this, from, to);
  landed(to);
  return result;
};
const unlink = fs.unlinkSync;
let checking = false;
fs.unlinkSync = function (file, ...rest) {
  const result = unlink.call(this, file, ...rest);
  const m = /^(.*)\\/\\.wf-worktrees\\/_transactions\\/([^/]+)\\.lock$/.exec(String(file));
  if (m && !checking) {
    // The lock is gone: what the next reader finds (a verification waits for any other writer, then looks).
    checking = true;
    try {
      const problems = verifyAttempt(m[1], m[2]).filter((x) => /extra file|differs from its recorded|size \\d+, recorded|: missing|mode \\d+, recorded/.test(x));
      if (problems.length) note({ kind: 'lock let go with unrecorded evidence', id: m[2], problems });
    } finally { checking = false; }
  }
  return result;
};
const drained = (stream) => new Promise((resolve) => (stream.writableLength ? stream.once('drain', resolve) : resolve()));
const finish = async (code) => { await Promise.all([drained(process.stdout), drained(process.stderr)]); process.exit(code); };
main(process.argv.slice(2)).then((code) => finish(code ?? 0), (error) => { process.stderr.write(String(error.stack ?? error)); finish(1); });
`;

// The reader: a real `wf verify` (the one that looked at the evidence without the lock) or `wf status` (which opens the attempt, and
// so verifies it, under the evidence lock).
const PROBE = `import fs from 'node:fs';
import { main } from ${JSON.stringify(path.join(ENGINE, 'cli.mjs'))};
import { transactionSeams } from ${JSON.stringify(path.join(ENGINE, 'evidence.mjs'))};
const [,, root, id, sentinel, reader] = process.argv;
process.chdir(root);
transactionSeams.afterCollision = () => { try { fs.writeFileSync(sentinel + '.blocked', '', { flag: 'wx' }); } catch {} };
let out = '', err = '';
process.stdout.write = (chunk) => ((out += chunk), true);
process.stderr.write = (chunk) => ((err += chunk), true);
const started = Date.now();
const code = await main([reader, '--attempt', id]);
fs.writeFileSync(sentinel + '.result', JSON.stringify({ code, out, err, ms: Date.now() - started }));
process.exit(0);
`;

// A runner for one project: `through(pauses)(args)` runs a `wf` command through it, stopping the writer at each pause.
function runnerFor(f) {
  const dir = path.join(f.base, 'txn');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'runner.mjs'), probe = path.join(dir, 'probe.mjs'), log = path.join(dir, 'violations.log');
  fs.writeFileSync(bin, RUNNER);
  fs.writeFileSync(probe, PROBE);
  const through = (pauses = []) => (args, extra = {}) => wf(f.root, args, { bin, ...extra, env: { TXN_LOG: log, TXN_DIR: dir, TXN_PROBE: probe, TXN_PAUSES: JSON.stringify(pauses), ...(extra.env ?? {}) } });
  const violations = () => (fs.existsSync(log) ? [...new Set(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean))].map((l) => JSON.parse(l)) : []);
  return { through, violations, dir };
}

// Every pause was reached and the reader started there was neither refused nor given an unrecorded file; and, for every command that
// ran through the runner, no file reached the evidence outside the transaction and the lock was never let go with unrecorded evidence
// (what a reader arriving at that moment would be refused for).
async function readersUnharmed(r, labels = []) {
  for (const label of labels) {
    assert.ok(fs.existsSync(path.join(r.dir, `${label}.fired`)), `${label}: the writer reached the file`);
    const got = JSON.parse(fs.readFileSync(await until(`the reader started at ${label}`, () => (fs.existsSync(path.join(r.dir, `${label}.result`)) ? path.join(r.dir, `${label}.result`) : null)), 'utf8'));
    assert.doesNotMatch(`${got.out}\n${got.err}`, /extra file \(not written by wf\)|does not match what wf recorded|differs from its recorded|recorded \d+/, `${label}: ${got.err}`);
    assert.equal(got.code, 0, `${label}: the reader was refused:\n${got.err}`);
  }
  assert.deepEqual(r.violations(), [], 'a file reached the evidence outside the transaction that records it, or the lock was let go with unrecorded evidence');
}

const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const admitted = (f, item = 'ENG-1') => ok(wf(f.root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();

// ---- the export page ------------------------------------------------------------------------------------------------------------

test('I-109: `wf export` writes its page and records it in one transaction (first export, a rewrite in place, and the json form)', async () => {
  const f = singleRepoProject('txn-export', { gate: { steps } });
  const e = admitted(f);
  const r = runnerFor(f);
  ok(r.through([{ label: 'html', match: '^export/attempt\\.html$', reader: 'status' }])(['export', '--attempt', e.id]));
  ok(r.through([{ label: 'again', match: '^export/attempt\\.html$' }])(['export', '--attempt', e.id]));
  ok(r.through([{ label: 'json', match: '^export/attempt\\.json$', reader: 'status' }])(['export', '--json', '--attempt', e.id]));
  await readersUnharmed(r, ['html', 'again', 'json']);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
});

// ---- the owner's summary, the delivered comment and the engine's own tracker readbacks ----------------------------------------------

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const ticketFile = (id) => `---\n${yaml({ id, title: 'Show the new text', status: 'Todo', labels: ['ui'] }).trim()}\n---\nThe home screen shows the new text.\n`;

test('I-109: the summary, the delivered comment (written, then rewritten) and the tracker readbacks the engine performs are each recorded in the transaction that writes them', async () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  const f = singleRepoProject('txn-delivery', { tracker: { kind: 'files', statuses, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', 'tickets/ENG-400.md': ticketFile('ENG-400') });
  const r = runnerFor(f);
  // `wf entry` performs the admitted event on the ticket file and records the engine's own readback: the raw answer and the capture.
  const entered = ok(r.through([{ label: 'admitted-raw', match: '^tracker/admitted-files-.*\\.json$', reader: 'status' }, { label: 'admitted-capture', match: '^tracker/admitted-capture\\.json$' }])(['entry', '--item', 'ENG-400', '--owner', 'o', '--json'])).json();
  const id = entered.id;
  const any = r.through();
  ok(any(['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(any(['plan', '--file', criteriaFile(f.base), '--attempt', id]));
  ok(any(['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(entered.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(any(['gate', ...OUT_OF_ORDER, '--attempt', id, '--json'])).json();
  ok(any(['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(any(['review', '--closure', closureFile(f.base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id]));
  ok(any(['accept', '--attempt', id]));
  // `wf deliver --summary-file` records the summary and writes the delivered comment from it.
  ok(r.through([{ label: 'summary', match: '^delivery/summary-1\\.raw\\.md$', reader: 'status' }, { label: 'comment', match: '^delivery/delivered-comment\\.md$' }])(['deliver', '--attempt', id, '--summary-file', summaryFile(f.base)]));
  // `wf shown` rewrites the comment with the captions, and performs the delivered event: raw answer, then capture.
  const shown = path.join(f.base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  const done = ok(r.through([{ label: 'comment-rewrite', match: '^delivery/delivered-comment\\.md$' }, { label: 'delivered-raw', match: '^tracker/delivered-files-.*\\.json$' }, { label: 'delivered-capture', match: '^tracker/delivered-capture\\.json$' }])(['shown', '--file', shown, '--attempt', id]));
  assert.match(done.out, /tracker: delivered performed on the ticket files and read back; attempt closed/);
  await readersUnharmed(r, ['admitted-raw', 'admitted-capture', 'summary', 'comment', 'comment-rewrite', 'delivered-raw', 'delivered-capture']);
  assert.match(ok(wf(f.root, ['verify', '--attempt', id])).out, /verified 1 attempt\(s\)/);
});

// ---- `wf tracker record --agent-reported` (connector mode) ---------------------------------------------------------------------------

test('I-109: an agent-reported readback is written and recorded in one transaction', async () => {
  const f = singleRepoProject('txn-reported', { tracker: { kind: 'linear', via: 'connector', statuses }, gate: { steps } });
  const e = admitted(f, 'ENG-50');
  const reported = path.join(f.base, 'reported.json');
  fs.writeFileSync(reported, JSON.stringify({ issue: 'ENG-50', title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: new Date(Date.now() + 1000).toISOString() }));
  const r = runnerFor(f);
  ok(r.through([{ label: 'reported', match: '^tracker/admitted-reported\\.json$', reader: 'status' }])(['tracker', 'record', '--event', 'admitted', '--agent-reported', '--file', reported, '--attempt', e.id]));
  await readersUnharmed(r, ['reported']);
  assert.deepEqual(state(f.root, e.id).tracker.done.map((d) => [d.event, d.provenance]), [['admitted', 'agent-reported, unverified']]);
});

// ---- imported captures and a scope ticket's readback ---------------------------------------------------------------------------------

// These two wrote their files while holding the lock but let it go before recording them: the lock was held at every write, and a
// reader that arrived as it was let go still found the files unrecorded (so a pause at the write cannot show it; the check at the
// release does).
function inReview(name) {
  const f = singleRepoProject(name, { gate: { steps } }, { 'src/old.txt': 'o1\no2\n' });
  const e = admitted(f, 'SC-1');
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base, [{ id: 'C1', text: 'a changes', uat: 'a shows the new text' }]), '--attempt', e.id]));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  return { f, e, r: runnerFor(f) };
}

test('I-109: imported captures are recorded in the transaction that writes them, not when the command ends', async () => {
  const { f, e, r } = inReview('txn-captures');
  const images = path.join(f.base, 'images');
  write(images, 'en/desktop.png', 'png-en-desktop');
  write(images, 'ar/narrow.png', 'png-ar-narrow');
  ok(r.through([{ label: 'import', match: '^captures/import-1/.*\\.png$', reader: 'status' }])(['captures', 'import', '--from', images, '--attempt', e.id]));
  await readersUnharmed(r, ['import']);
  assert.equal(state(f.root, e.id).captureImports.length, 1);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
});

test('I-109: a scope ticket\'s readback is recorded in the transaction that writes it, not when the command ends', async () => {
  const { f, e, r } = inReview('txn-ticket');
  ok(wf(f.root, ['handoff', 'reviewer', '--agent', 'r1', '--attempt', e.id]));
  const observation = { id: 'F1', severity: 'minor', summary: 'old.txt has no empty state', status: 'open', evidence: 'src/old.txt:2' };
  ok(wf(f.root, ['review', '--closure', closureFile(f.base, goodClosure('r1', { findings: [observation] })), '--attempt', e.id]));
  const capture = path.join(f.base, 'ticket.json');
  fs.writeFileSync(capture, JSON.stringify({ issue: { identifier: 'ENG-9', title: 'empty state', url: 'https://tracker.example.test/ENG-9' } }));
  ok(r.through([{ label: 'ticket', match: '^scope/.*\\.ticket\\.json$' }])(['scope', 'ticket', '--finding', 'r1:F1', '--capture', capture, '--attempt', e.id]));
  await readersUnharmed(r, ['ticket']);
  assert.deepEqual(state(f.root, e.id).scopeDecisions.map((d) => [d.choice, d.keys]), [['ticketed', ['r1:F1']]]);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
});

// ---- waiting for the tracker ---------------------------------------------------------------------------------------------------------

// The engine performs the pending events one after the other, waiting for the tracker's answer to each. Before: the files of
// one event (the raw answer and the capture) stayed unrecorded while it waited for the next, so a reader in that time was
// refused. Now each event's files are written and recorded when its answer is in hand, and no lock is held while it waits.
test('I-109: while the engine waits for the tracker, the events it already recorded are recorded in the manifest and no evidence lock is held', async () => {
  const f = singleRepoProject('txn-wait', { tracker: { kind: 'github', repo: 'acme/app', via: 'cli', statuses, publicAssets: 'acknowledged' }, gate: { steps } });
  const bin = path.join(f.base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const park = { parked: path.join(f.base, 'parked'), release: path.join(f.base, 'release'), down: path.join(f.base, 'down') };
  // `gh` fails while `down` exists (the tracker is out: its events stay pending), and waits (once) for a release file, but only
  // after the admitted event's capture exists: the wait is in the second event.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ -e "$WF_TEST_DOWN" ]; then echo "gh: unavailable (HTTP 503)" >&2; exit 1; fi\nif [ -e "$WF_TEST_PARK_WHEN" ] && [ ! -e "$WF_TEST_PARKED" ]; then\n  : > "$WF_TEST_PARKED"\n  while [ ! -e "$WF_TEST_RELEASE" ]; do sleep 0.05; done\nfi\nexec "${process.execPath}" "${path.join(FIXTURES, 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const db = path.join(f.base, 'github.json');
  seed(db, { labels: ['bug'] });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WF_TEST_GH_STATE: db, WF_TEST_PARKED: park.parked, WF_TEST_RELEASE: park.release, WF_TEST_DOWN: park.down };
  // The tracker is out: the admitted and implementing events stay pending, both.
  fs.writeFileSync(park.down, '');
  const e = ok(wf(f.root, ['entry', '--item', 'GH-12', '--owner', 'o', '--json'], { env })).json();
  ok(wf(f.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id], { env }));
  ok(wf(f.root, ['plan', '--file', criteriaFile(f.base), '--attempt', e.id], { env }));
  ok(wf(f.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id], { env }));
  fs.rmSync(park.down);
  assert.deepEqual(state(f.root, e.id).tracker.pending.map((a) => a.event).filter((x, i, all) => all.indexOf(x) === i), ['admitted', 'implementing']);
  const childEnv = { ...process.env, WF_CONFIG_HOME: path.join(f.base, '.wfhome'), ...spawnHome(f.root), WF_EVIDENCE_FLAGS: '0', ...env, WF_TEST_PARK_WHEN: path.join(f.root, '.wf-evidence', 'attempts', e.id, 'tracker', 'admitted-capture.json') };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'AI_AGENT', 'GROK_SESSION_ID']) delete childEnv[k];
  const sync = spawn(process.execPath, [WF, 'tracker', 'sync', '--attempt', e.id], { cwd: f.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  sync.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => sync.once('exit', resolve));
  try {
    await until('the engine to wait for the tracker in its second event', () => fs.existsSync(park.parked));
    const started = Date.now();
    const meanwhile = wf(f.root, ['status', '--attempt', e.id], { env });
    assert.equal(meanwhile.code, 0, `a reader while the engine waits for the tracker:\n${meanwhile.err}`);
    assert.doesNotMatch(meanwhile.err, /extra file \(not written by wf\)|still locked/);
    assert.ok(Date.now() - started < 8000, 'the reader was not held back by an evidence lock');
    assert.match(ok(wf(f.root, ['verify', '--attempt', e.id], { env })).out, /verified 1 attempt\(s\)/, 'the first event\'s files are recorded while the second is awaited');
    assert.deepEqual(state(f.root, e.id).tracker.done.map((d) => d.event), ['admitted']);
  } finally {
    fs.writeFileSync(park.release, '');
  }
  assert.equal(await exited, 0, stderr);
  assert.deepEqual(state(f.root, e.id).tracker.done.map((d) => d.event), ['admitted', 'implementing']);
  assert.match(ok(wf(f.root, ['verify', '--attempt', e.id])).out, /verified 1 attempt\(s\)/);
});

// The engine acted on the tracker, then read the ticket back and the readback failed its checks: the tracker's answer is kept for
// the owner to read the failure against, as it always was, now written and recorded in one transaction.
test('I-109: the engine\'s own readback is kept when it fails its checks, and recorded with nothing else left unrecorded', async () => {
  const f = singleRepoProject('txn-failed-readback', { tracker: { kind: 'files', statuses }, gate: { steps } });
  const e = ok(wf(f.root, ['entry', '--item', 'ENG-9', '--owner', 'o', '--json'])).json();
  assert.deepEqual(state(f.root, e.id).tracker.done, [], 'no ticket file: the admitted event stays pending');
  const keep = process.env.WF_EVIDENCE_FLAGS;
  process.env.WF_EVIDENCE_FLAGS = '0';
  const { forget } = await import('../engine/evidence.mjs');
  const { loadConfig } = await import('../engine/config.mjs');
  const { loadState } = await import('../engine/ledger.mjs');
  const { recordTracker } = await import('../engine/tracker.mjs');
  try {
    const file = path.join(f.root, '.wf-evidence', 'attempts', e.id, 'tracker', 'admitted-files-test.json');
    const text = `${JSON.stringify({ issue: { identifier: 'ENG-8', title: 'another ticket', status: 'In Progress' } }, null, 2)}\n`;
    await assert.rejects(recordTracker(f.root, loadConfig(f.root), loadState(f.root, e.id), { event: 'admitted', engineCapture: { file, text } }), /tracker readback for `admitted` failed:\n {2}- capture is for ENG-8, not ENG-9/);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the answer is kept');
    assert.deepEqual(verifyAttempt(f.root, e.id), [], 'and recorded');
    assert.equal(fs.existsSync(path.join(path.dirname(file), 'admitted-capture.json')), false, 'a failed readback is not a capture');
  } finally {
    forget();
    if (keep === undefined) delete process.env.WF_EVIDENCE_FLAGS;
    else process.env.WF_EVIDENCE_FLAGS = keep;
  }
});

// ---- the rule itself -------------------------------------------------------------------------------------------------------------------

test('I-109: an evidence file is written only inside a recorded transaction: elsewhere the engine refuses to write it, and what a failed transaction wrote is recorded before the lock is let go', async () => {
  const f = singleRepoProject('txn-rule', { gate: { steps } });
  const e = admitted(f);
  const keep = process.env.WF_EVIDENCE_FLAGS;
  process.env.WF_EVIDENCE_FLAGS = '0';
  const { forget, prepareWrite, withEvidenceTransaction, writeNoFollow } = await import('../engine/evidence.mjs');
  const { openEvidence, recordedTogether } = await import('../engine/ledger.mjs');
  const lifecycle = await import('../engine/lifecycle.mjs');
  try {
    openEvidence(f.root, e.id);
    const dir = path.join(f.root, '.wf-evidence', 'attempts', e.id);
    const put = (rel, text = 'x\n') => {
      const file = path.join(dir, rel);
      prepareWrite(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeNoFollow(file, text);
    };
    // Outside any transaction, and inside one that does not record: refused, and nothing is created.
    assert.throws(() => put('notes/a.txt'), /notes\/a\.txt is written outside a recorded transaction/);
    assert.throws(() => withEvidenceTransaction(f.root, e.id, () => put('notes/a.txt')), /written outside a recorded transaction/);
    assert.equal(fs.existsSync(path.join(dir, 'notes')), false);
    // Inside one: written, and recorded in the manifest before the lock is let go.
    recordedTogether(f.root, e.id, () => put('notes/a.txt'));
    assert.deepEqual(verifyAttempt(f.root, e.id), []);
    // A transaction that fails after writing records what it wrote before the lock is let go (nothing is left for a reader to refuse).
    assert.throws(() => recordedTogether(f.root, e.id, () => { put('notes/b.txt'); throw new Error('the next step failed'); }), /the next step failed/);
    assert.deepEqual(verifyAttempt(f.root, e.id), []);
    // An attempt this process has not opened yet is opened first: a file written first would otherwise be one that was "already
    // there" unrecorded, and refused as an extra file by the next command.
    forget();
    recordedTogether(f.root, e.id, () => put('notes/c.txt'));
    assert.deepEqual(verifyAttempt(f.root, e.id), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').at(-1)).type, 'evidence.recorded');
    // The lock is let go when the function returns: a function that waits cannot hold it, so it is refused.
    assert.throws(() => recordedTogether(f.root, e.id, async () => {}), /takes a synchronous function/);
    // The gate's own folder and the ledger are written under their own rules.
    assert.doesNotThrow(() => prepareWrite(path.join(dir, 'gate', 'run-1', 'x')));
    assert.equal(lifecycle.recordedTogether, recordedTogether, 'lifecycle keeps exporting it for its callers');
  } finally {
    forget();
    if (keep === undefined) delete process.env.WF_EVIDENCE_FLAGS;
    else process.env.WF_EVIDENCE_FLAGS = keep;
  }
});
