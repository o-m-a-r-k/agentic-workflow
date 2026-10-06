// Evidence integrity: a manifest of every evidence file in the hash-chained ledger, write protection, verification at
// every use, and a chain-head anchor outside the evidence tree.
//
// Named gaps (0.1.19): a command/path guard cannot see writes made through MCP tools, Codex (no hook), gate steps and
// tests, paths decoded at run time, symlinks made earlier, races, or a person. So the engine no longer relies on
// stopping writes: it records what it wrote and refuses to use anything that differs.
//
// - Recording. The first time a `wf` process opens an attempt it verifies it and takes a snapshot of the files there.
//   When the process ends (and right before a gate run is recorded finished) every file it created in the attempt's
//   evidence, and every file it rewrote through `prepareWrite`, is read once and recorded as { path, sha256, size,
//   mode } in an `evidence.recorded` ledger entry, from that same buffer. A file present at the start and not recorded
//   is never recorded later: it is refused as an extra file.
// - Protection. Recorded files are made 0444 and, on macOS, user-immutable (`chflags uchg`; on Linux `chattr +i` only
//   as root); directories 0555 between commands. The engine lifts it only through `prepareWrite` / `unlockDirs`.
//   `WF_EVIDENCE_FLAGS=0` keeps the modes and skips the immutable flag (tests use it so temporary folders stay removable).
// - Verification. Every opened attempt is verified quickly (chain, anchor, every file present, regular, recorded, of the
//   recorded size and mode, no extra file); `wf accept`, `wf deliver`, `wf verify` and the other commands that rely on
//   evidence content also re-hash every file (full).
// - Anchor. Each ledger append writes the chain head ({ seq, hash }) to `.wf-worktrees/_anchor/<attempt>.json`; a ledger
//   whose head differs (truncated, rewritten, restored from a copy) is refused.
// What it does not stop: a process that rewrites the ledger, recomputes the chain and rewrites the anchor too. The
// anchor only raises the bar to "change three things consistently"; it is not a signature.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const hashBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const evidenceRootOf = (root) => path.join(root, '.wf-evidence');
const attemptDirOf = (root, id) => path.join(evidenceRootOf(root), 'attempts', id);
export const anchorFile = (root, id) => path.join(root, '.wf-worktrees', '_anchor', `${id}.json`);
const flagsOn = () => process.env.WF_EVIDENCE_FLAGS !== '0';

// Files the engine keeps rewriting as bookkeeping; never recorded, never protected: the ledger (its own chain), locks,
// a gate's live lock and progress.
const MUTABLE = (rel) => rel === 'ledger.jsonl' || rel.endsWith('.lock') || rel === 'gate/gate.lock' || /^gate\/[^/]+\/progress\.json$/.test(rel);

// ---- per-process state ----
const touched = new Map(); // `${root}\0${id}` -> { root, id, snapshot: Set<rel>, verified: 'quick'|'full' }
const rewritten = new Set(); // absolute paths the engine rewrote in this process
const gateRuns = new Set(); // `${root}\0${id}\0${runId}` gate runs this process owns
let level = 'quick';
export const setVerifyLevel = (l) => (level = l);
export const ownGateRun = (root, id, runId) => gateRuns.add(`${root}\0${id}\0${runId}`);

// ---- protection ----
function setImmutable(files, on) {
  if (!flagsOn() || !files.length) return;
  if (process.platform === 'darwin') {
    for (let i = 0; i < files.length; i += 200) spawnSync('chflags', [on ? 'uchg' : 'nouchg', ...files.slice(i, i + 200)], { stdio: 'ignore' });
  } else if (process.platform === 'linux' && process.getuid?.() === 0) {
    for (let i = 0; i < files.length; i += 200) spawnSync('chattr', [on ? '+i' : '-i', ...files.slice(i, i + 200)], { stdio: 'ignore' });
  }
}

const walk = (dir, out = { files: [], dirs: [], odd: [] }, base = dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (e.isSymbolicLink()) out.odd.push({ rel, kind: 'symlink' });
    else if (e.isDirectory()) {
      out.dirs.push(p);
      walk(p, out, base);
    } else if (e.isFile()) out.files.push(rel);
    else out.odd.push({ rel, kind: 'not a regular file' });
  }
  return out;
};

// Makes the attempt's directories writable for the engine (files stay protected).
export function unlockDirs(root, id) {
  const dir = attemptDirOf(root, id);
  if (!fs.existsSync(dir)) return;
  for (const d of [dir, ...walk(dir).dirs]) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {}
  }
}

function lockDirs(root, id) {
  const dir = attemptDirOf(root, id);
  if (!fs.existsSync(dir)) return;
  // A gate run that is still open keeps its own folders writable (its runner is still writing them).
  const s = loadLedgerLite(root, id);
  const open = new Set(s.openRuns);
  for (const d of walk(dir).dirs.reverse().concat(dir)) {
    const rel = path.relative(dir, d).split(path.sep).join('/');
    if (rel === 'gate' || rel === '' || [...open].some((r) => rel === `gate/${r}` || rel.startsWith(`gate/${r}/`))) continue;
    try {
      fs.chmodSync(d, 0o555);
    } catch {}
  }
}

// Before the engine creates or rewrites `file` inside an attempt's evidence: its folders writable, its protection lifted.
export function prepareWrite(file) {
  const abs = path.resolve(file);
  const parts = abs.split(path.sep);
  const at = parts.lastIndexOf('.wf-evidence');
  if (at < 0) return abs;
  for (let i = at + 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      if (fs.lstatSync(d).isDirectory()) fs.chmodSync(d, 0o755);
    } catch {}
  }
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st?.isFile()) {
    setImmutable([abs], false);
    try {
      fs.chmodSync(abs, 0o644);
    } catch {}
    rewritten.add(abs);
  }
  return abs;
}

// ---- the ledger, read without the engine's reducer (no import cycle) ----
function loadLedgerLite(root, id) {
  const file = path.join(attemptDirOf(root, id), 'ledger.jsonl');
  const out = { entries: [], manifest: new Map(), openRuns: [], finishedRuns: new Set(), engineVersion: null, collected: [] };
  if (!fs.existsSync(file)) return out;
  const started = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    out.entries.push(e);
    if (e.type === 'admitted') out.engineVersion = e.data?.engineVersion ?? null;
    if (e.type === 'evidence.recorded') for (const f of e.data.files ?? []) out.manifest.set(f.path, f);
    if (['gate.finished', 'check.finished'].includes(e.type) && e.data?.runId) out.finishedRuns.add(String(e.data.runId).replace(/\+carried$/, ''));
    // What the gate hashed when it collected each artifact (from the bytes it read), independent of the manifest.
    if (e.type === 'gate.finished' && !e.data?.carriedFrom) for (const st of e.data?.steps ?? []) for (const x of st.artifacts ?? []) if (x?.path && x.sha256) out.collected.push({ path: x.path, sha256: x.sha256 });
  }
  // Runs with a folder under gate/ and no finished entry are still open (or their runner died).
  const gate = path.join(attemptDirOf(root, id), 'gate');
  if (fs.existsSync(gate)) for (const d of fs.readdirSync(gate)) if (!out.finishedRuns.has(d) && fs.lstatSync(path.join(gate, d)).isDirectory()) started.add(d);
  out.openRuns = [...started];
  return out;
}

const semverLt = (a, b) => {
  const pa = String(a ?? '0').split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
};

// ---- anchor ----
export function writeAnchor(root, id, entry) {
  const file = anchorFile(root, id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return;
    if (st) fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, `${JSON.stringify({ attempt: id, seq: entry.seq, hash: entry.hash })}\n`, { mode: 0o444 });
    fs.chmodSync(file, 0o444);
  } catch {}
}

// ---- verification ----
// Problems, first offenders first; [] when the attempt verifies.
export function verifyAttempt(root, id, { full = false } = {}) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const problems = [];
  const head = lite.entries.at(-1);
  // Anchor: the chain head must match what the engine last wrote outside the evidence.
  const af = anchorFile(root, id);
  const ast = fs.lstatSync(af, { throwIfNoEntry: false });
  if (head && ast && !ast.isFile()) problems.push(`anchor ${af} is not a regular file`);
  else if (head && ast) {
    let a = null;
    try {
      a = JSON.parse(fs.readFileSync(af, 'utf8'));
    } catch {}
    if (!a) problems.push(`anchor ${af} is unreadable`);
    else if (a.seq !== head.seq || a.hash !== head.hash) problems.push(`ledger head (entry ${head.seq}) does not match its anchor (entry ${a.seq}): the ledger was ${a.seq > head.seq ? 'truncated' : 'rewritten or appended outside wf'}`);
  } else if (head && !ast && !semverLt(lite.engineVersion, '0.1.20')) problems.push(`anchor ${af} is missing`);
  const legacy = semverLt(lite.engineVersion, '0.1.20') && lite.manifest.size === 0;
  if (legacy) return problems; // baselined by `touch` on first use
  const { files, odd } = walk(dir);
  for (const o of odd) problems.push(`${o.rel}: ${o.kind}`);
  const pending = (rel) => lite.openRuns.some((r) => rel.startsWith(`gate/${r}/`));
  const onDisk = new Set(files);
  for (const rel of files) {
    if (MUTABLE(rel) || lite.manifest.has(rel) || pending(rel)) continue;
    problems.push(`${rel}: extra file (not written by wf)`);
  }
  for (const [rel, m] of lite.manifest) {
    if (!onDisk.has(rel)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    if (st.size !== m.size) problems.push(`${rel}: size ${st.size}, recorded ${m.size}`);
    else if ((st.mode & 0o777) !== m.mode && !rewritten.has(p)) problems.push(`${rel}: mode ${(st.mode & 0o777).toString(8)}, recorded ${m.mode.toString(8)}`);
    else if (full && hashBuf(fs.readFileSync(p)) !== m.sha256) problems.push(`${rel}: content differs from its recorded sha256`);
  }
  // A capture changed between the gate's collection and its recording: the manifest then holds the changed bytes, the
  // gate's own record the collected ones.
  if (full) {
    for (const c of lite.collected) {
      const rel = path.relative(dir, c.path).split(path.sep).join('/');
      const m = lite.manifest.get(rel);
      if (m && m.sha256 !== c.sha256) problems.push(`${rel}: changed between the gate collecting it and wf recording it`);
    }
  }
  return problems;
}

// ---- recording ----
export function recordFiles(root, id, rels, appendFn) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const out = [];
  const abs = [];
  for (const rel of rels) {
    if (MUTABLE(rel)) continue;
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    try {
      fs.chmodSync(p, 0o444);
    } catch {}
    const buf = fs.readFileSync(p);
    const m = lite.manifest.get(rel);
    const entry = { path: rel, sha256: hashBuf(buf), size: buf.length, mode: 0o444 };
    if (m && m.sha256 === entry.sha256 && m.size === entry.size && m.mode === entry.mode) continue;
    out.push(entry);
    abs.push(p);
  }
  if (out.length) appendFn(root, id, 'evidence.recorded', { files: out }, null);
  setImmutable(abs, true);
  return out;
}

// The first open of an attempt in this process: verify, baseline a pre-0.1.20 attempt, snapshot, unlock folders.
export function touch(root, id, appendFn) {
  const key = `${root}\0${id}`;
  const prev = touched.get(key);
  if (prev && (prev.verified === 'full' || level === 'quick')) return [];
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  if (lite.entries.length && semverLt(lite.engineVersion, '0.1.20') && lite.manifest.size === 0 && !prev) {
    // Adopted as found: everything already there is recorded once (a baseline, not proof of what came before).
    unlockDirs(root, id);
    recordFiles(root, id, walk(dir).files, appendFn);
    const head = loadLedgerLite(root, id).entries.at(-1);
    if (head) writeAnchor(root, id, head);
  }
  const problems = verifyAttempt(root, id, { full: level === 'full' });
  if (problems.length) return problems;
  touched.set(key, { root, id, snapshot: prev?.snapshot ?? new Set(walk(dir).files), verified: level });
  unlockDirs(root, id);
  return [];
}

// End of a `wf` process (and before a gate run is recorded finished): record what this process created or rewrote,
// protect it, lock the folders again.
export function seal(appendFn, only = null) {
  for (const t of touched.values()) {
    if (only && (t.root !== only.root || t.id !== only.id)) continue;
    const dir = attemptDirOf(t.root, t.id);
    if (!fs.existsSync(dir)) continue;
    const lite = loadLedgerLite(t.root, t.id);
    const mine = (rel) => {
      const run = /^gate\/([^/]+)\//.exec(rel)?.[1];
      if (run && lite.openRuns.includes(run)) return gateRuns.has(`${t.root}\0${t.id}\0${run}`) && (!only?.runId || only.runId === run);
      return !t.snapshot.has(rel) || rewritten.has(path.join(dir, rel));
    };
    const rels = walk(dir).files.filter((rel) => !MUTABLE(rel) && mine(rel) && (!lite.manifest.has(rel) || rewritten.has(path.join(dir, rel))));
    recordFiles(t.root, t.id, rels, appendFn);
    for (const rel of rels) {
      t.snapshot.add(rel);
      rewritten.delete(path.join(dir, rel));
    }
    if (!only) lockDirs(t.root, t.id);
  }
}

// Every attempt this process opened is new to it again (tests that run several engine calls in one process).
export function forget() {
  touched.clear();
  rewritten.clear();
  gateRuns.clear();
}
