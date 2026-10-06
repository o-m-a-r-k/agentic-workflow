// Evidence integrity: a manifest of every evidence file in the hash-chained ledger, write protection, verification at
// every use, a chain-head anchor outside the evidence tree, repair (re-baseline) and release (prune) through the engine.
//
// Named gaps (0.1.19): a command/path guard cannot see writes made through MCP tools, Codex (no hook), gate steps and
// tests, paths decoded at run time, symlinks made earlier, races, or a person. So the engine records what it wrote and
// refuses to use anything that differs.
//
// - Recording. The first time a `wf` process opens an attempt it verifies it and takes a snapshot of the files there.
//   When the process ends (and right before a gate run is recorded finished) every file it created in the attempt's
//   evidence, and every file it rewrote through `prepareWrite`, is opened without following links, read once, and
//   recorded as { path, sha256, size, mode } in an `evidence.recorded` ledger entry, from that same buffer.
// - Protection. Recorded files are 0444 and, on macOS, user-immutable (`chflags uchg`; on Linux `chattr +i`, which
//   needs root and a filesystem that supports it, else silently skipped); directories 0555 between commands. Only the
//   engine lifts it (`prepareWrite`, `unlockDirs`, `releaseAttempt`). `WF_EVIDENCE_FLAGS=0` skips the immutable flag.
// - Verification. Content commands re-hash every recorded file. Other commands compare each file's stat signature
//   (size, mtime, ctime, inode, mode) with the one recorded after the last hash (a cache outside the evidence; ctime
//   cannot be set back by a user) and re-hash any file whose signature changed. Every problem is listed, never only
//   the first kind; any exception while verifying is a problem (fail closed).
// - Anchor. Each ledger append writes the chain head ({ seq, hash }) to `.wf-worktrees/_anchor/<attempt>.json`; a ledger
//   whose head differs (truncated, rewritten, restored from a copy) is refused. Same user can rewrite both: the anchor is
//   not a signature.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { canonical } from './util.mjs';

const hashBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const evidenceRootOf = (root) => path.join(root, '.wf-evidence');
const attemptDirOf = (root, id) => path.join(evidenceRootOf(root), 'attempts', id);
export const anchorFile = (root, id) => path.join(root, '.wf-worktrees', '_anchor', `${id}.json`);
const statCacheFile = (root, id) => path.join(root, '.wf-worktrees', '_anchor', `${id}.stat.json`);
const flagsOn = () => process.env.WF_EVIDENCE_FLAGS !== '0';
const FIRST_MANIFEST = '0.1.20';

// The only unrecorded files, each justified: the ledger (protected by its own hash chain and the anchor), its lock
// (exists only while an append runs), the gate lock (the live runner's pid and children, rewritten while it runs), and
// a gate run's progress file while that run is open (the live view `wf status` shows). A file of any other name is
// recorded or refused. Progress is never trusted for results: a dead runner's steps are recovered from the ledger.
const MUTABLE = (rel, openRuns, v020 = false) => rel === 'ledger.jsonl' || rel === 'ledger.jsonl.lock' || rel === 'gate/gate.lock' || openRuns.some((r) => rel === `gate/${r}/progress.json`) || (v020 && /^gate\/[^/]+\/progress\.json$/.test(rel));
// 0.1.20 never recorded a run's progress file; attempts it admitted keep that exemption.
const isV020 = (lite) => lite.engineVersion === '0.1.20';

// ---- per-process state ----
const touched = new Map(); // `${root}\0${id}` -> { root, id, snapshot: Set<rel>, verified, sigs: Map<rel, sig> }
const rewritten = new Set(); // absolute paths the engine rewrote in this process
const gateRuns = new Set(); // `${root}\0${id}\0${runId}` gate runs this process owns
let level = 'quick';
export const setVerifyLevel = (l) => (level = l);
export const ownGateRun = (root, id, runId) => gateRuns.add(`${root}\0${id}\0${runId}`);

// ---- protection ----
function setImmutable(files, on) {
  if (!flagsOn() || !files.length) return;
  const tool = process.platform === 'darwin' ? ['chflags', on ? 'uchg' : 'nouchg'] : process.platform === 'linux' && process.getuid?.() === 0 ? ['chattr', on ? '+i' : '-i'] : null;
  if (!tool) return;
  for (let i = 0; i < files.length; i += 200) spawnSync(tool[0], [tool[1], ...files.slice(i, i + 200)], { stdio: 'ignore' });
}

// What this machine can do, for `wf doctor`: probed on a scratch file next to the evidence.
export function protectionLayers(root) {
  const dir = path.join(root, '.wf-worktrees', '_probe');
  const file = path.join(dir, `probe-${process.pid}`);
  const out = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    // Tried, not assumed: root (and some filesystems) ignore the modes.
    let modes = true;
    try {
      fs.appendFileSync(file, 'y');
      modes = false;
    } catch {}
    out.push({ layer: 'read-only modes (0444 files, 0555 folders)', active: modes, ...(modes ? {} : { detail: `off: a write to a 0444 file succeeded${process.getuid?.() === 0 ? ' (running as root, which ignores modes)' : ''}` }) });
    let immutable = 'not available on this platform';
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const tool = process.platform === 'darwin' ? ['chflags', 'uchg', 'nouchg'] : ['chattr', '+i', '-i'];
      if (process.platform === 'linux' && process.getuid?.() !== 0) immutable = 'off: `chattr +i` needs root';
      else if (!flagsOn()) immutable = 'off: WF_EVIDENCE_FLAGS=0';
      else {
        const set = spawnSync(tool[0], [tool[1], file], { encoding: 'utf8' });
        let held = false;
        try {
          fs.unlinkSync(file);
        } catch {
          held = true;
        }
        spawnSync(tool[0], [tool[2], file], { stdio: 'ignore' });
        immutable = set.status === 0 && held ? `on (${tool[0]} ${tool[1]})` : `off: ${tool[0]} ${tool[1]} is not supported here${set.stderr ? ` (${set.stderr.trim().split('\n')[0]})` : ''}; files stay 0444`;
      }
    }
    out.push({ layer: 'immutable flag', active: immutable.startsWith('on'), detail: immutable });
  } catch (error) {
    out.push({ layer: 'protection probe', active: false, detail: error.message });
  } finally {
    try {
      fs.chmodSync(file, 0o644);
      fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
    } catch {}
  }
  out.push({ layer: 'manifest verified at every use (hash chain, anchor, sha256 of every evidence file)', active: true });
  return out;
}

function walk(dir, out = { files: [], dirs: [], odd: [], errors: [] }, base = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === base && error.code === 'ENOENT') return out;
    out.errors.push(`${path.relative(base, dir) || '.'}: unreadable folder (${error.code ?? error.message})`);
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
}

// One read of a regular file, never through a link; null when it is not one.
export function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    return { bytes: fs.readFileSync(fd), st };
  } finally {
    fs.closeSync(fd);
  }
}

const sigOf = (st) => [st.size, Math.round(st.mtimeMs), Math.round(st.ctimeMs), st.ino, st.mode & 0o777].join(':');

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
  const open = loadLedgerLite(root, id).openRuns;
  for (const d of walk(dir).dirs.reverse().concat(dir)) {
    const rel = path.relative(dir, d).split(path.sep).join('/');
    if (rel === 'gate' || rel === '' || open.some((r) => rel === `gate/${r}` || rel.startsWith(`gate/${r}/`))) continue;
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
const SEMVER = /^\d+\.\d+\.\d+$/;
function loadLedgerLite(root, id) {
  const file = path.join(attemptDirOf(root, id), 'ledger.jsonl');
  const out = { entries: [], manifest: new Map(), openRuns: [], finishedRuns: new Set(), startedRuns: new Set(), engineVersion: null, admitted: false, baselined: false, collected: [], unreadable: [], chainBreak: null, rebaselined: new Set() };
  let prevHash = null;
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      out.unreadable.push(i + 1);
      continue;
    }
    out.entries.push(e);
    // The chain, checked here too: a manifest is trusted only from an unbroken ledger.
    if (out.chainBreak === null) {
      const { hash, ...rest } = e;
      if (e.prev !== prevHash || hash !== hashBuf(canonical(rest))) out.chainBreak = e.seq ?? out.entries.length;
      prevHash = hash;
    }
    const d = e.data ?? {};
    if (e.type === 'admitted' && out.entries.length === 1) {
      out.admitted = true;
      out.engineVersion = typeof d.engineVersion === 'string' && SEMVER.test(d.engineVersion) ? d.engineVersion : null;
    }
    if (e.type === 'evidence.recorded' || e.type === 'evidence.baseline') {
      out.baselined = true;
      for (const f of d.files ?? []) out.manifest.set(f.path, f);
    }
    if (e.type === 'evidence.rebaselined') for (const c of d.changes ?? []) {
      out.rebaselined.add(c.path);
      if (c.kind === 'removed') out.manifest.delete(c.path);
      else out.manifest.set(c.path, { path: c.path, sha256: c.new, size: c.size, mode: c.mode });
    }
    if (e.type === 'gate.started' && d.runId) out.startedRuns.add(String(d.runId));
    if (['gate.finished', 'check.finished'].includes(e.type) && d.runId) out.finishedRuns.add(String(d.runId).replace(/\+carried$/, ''));
    // What the gate hashed when it collected each artifact (from the bytes it read), independent of the manifest.
    if (e.type === 'gate.finished' && !d.carriedFrom) for (const st of d.steps ?? []) for (const x of st.artifacts ?? []) if (x?.path && x.sha256) out.collected.push({ path: x.path, sha256: x.sha256 });
    if (e.type === 'gate.step' && d.step) for (const x of d.step.artifacts ?? []) if (x?.path && x.sha256) out.collected.push({ path: x.path, sha256: x.sha256 });
  }
  // A run is open only when the ledger says it started and has not finished: a folder alone opens nothing.
  out.openRuns = [...out.startedRuns].filter((r) => !out.finishedRuns.has(r));
  return out;
}

// Pre-manifest attempts are told apart only by the version the ledger's own first entry records (inside the chain).
const preManifest = (lite) => lite.admitted && lite.engineVersion !== null && semverLt(lite.engineVersion, FIRST_MANIFEST) && !lite.baselined;
function semverLt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}

// ---- anchor ----
export function writeAnchor(root, id, entry, extra = {}) {
  const file = anchorFile(root, id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return;
    if (st) fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, `${JSON.stringify({ attempt: id, seq: entry?.seq ?? null, hash: entry?.hash ?? null, ...extra })}\n`, { mode: 0o444 });
    fs.chmodSync(file, 0o444);
  } catch {}
}
const readAnchor = (root, id) => {
  const af = anchorFile(root, id);
  const st = fs.lstatSync(af, { throwIfNoEntry: false });
  if (!st) return { missing: true, file: af };
  if (!st.isFile()) return { odd: true, file: af };
  try {
    return { ...JSON.parse(fs.readFileSync(af, 'utf8')), file: af };
  } catch {
    return { unreadable: true, file: af };
  }
};

// ---- stat signature cache (outside the evidence; trusted only to skip re-hashing an unchanged file) ----
function readCache(root, id) {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(statCacheFile(root, id), 'utf8')).files ?? {}));
  } catch {
    return new Map();
  }
}
function writeCache(root, id, cache) {
  try {
    const f = statCacheFile(root, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ files: Object.fromEntries(cache) }));
  } catch {}
}

// ---- verification ----
// Every problem found (never only the first kind); [] when the attempt verifies. `sigs` (optional) receives each verified
// file's stat signature, for a later `assertUnchanged`.
export function verifyAttempt(root, id, { full = false, sigs = null } = {}) {
  try {
    return verifyInner(root, id, full, sigs);
  } catch (error) {
    return [`verification failed: ${error.message}`];
  }
}

function verifyInner(root, id, full, sigs) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const problems = lite.unreadable.map((n) => `ledger line ${n} is not JSON`);
  if (lite.chainBreak !== null) return [...problems, `ledger hash chain broken at entry ${lite.chainBreak}; the ledger was edited by hand (nothing else is checked against a broken chain)`];
  const head = lite.entries.at(-1);
  const a = readAnchor(root, id);
  if (a.released) problems.push(`${id} was released ${a.at ?? ''}; its evidence must not reappear`);
  if (head && a.odd) problems.push(`anchor ${a.file} is not a regular file`);
  else if (head && a.unreadable) problems.push(`anchor ${a.file} is unreadable`);
  else if (head && a.missing) {
    if (!preManifest(lite)) problems.push(`anchor ${a.file} is missing`);
  } else if (head && (a.seq !== head.seq || a.hash !== head.hash)) problems.push(`ledger head (entry ${head.seq}) does not match its anchor (entry ${a.seq}): the ledger was ${a.seq > head.seq ? 'truncated' : 'rewritten or appended outside wf'}`);
  if (head && !lite.admitted) problems.push('the ledger does not start with its admission entry');
  if (preManifest(lite)) return problems; // adopted by `touch` on first use
  const { files, odd, errors } = walk(dir);
  problems.push(...errors);
  for (const o of odd) problems.push(`${o.rel}: ${o.kind}`);
  const pending = (rel) => lite.openRuns.some((r) => rel.startsWith(`gate/${r}/`));
  const onDisk = new Set(files);
  for (const rel of files) {
    if (MUTABLE(rel, lite.openRuns, isV020(lite)) || lite.manifest.has(rel) || pending(rel)) continue;
    problems.push(`${rel}: extra file (not written by wf)`);
  }
  const cache = readCache(root, id);
  let cacheChanged = false;
  for (const [rel, m] of lite.manifest) {
    if (!onDisk.has(rel)) {
      problems.push(`${rel}: missing`);
      continue;
    }
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    const sig = sigOf(st);
    if (st.size !== m.size) problems.push(`${rel}: size ${st.size}, recorded ${m.size}`);
    else if ((st.mode & 0o777) !== m.mode && !rewritten.has(p)) problems.push(`${rel}: mode ${(st.mode & 0o777).toString(8)}, recorded ${m.mode.toString(8)}`);
    else if (full || cache.get(rel) !== `${sig}:${m.sha256}`) {
      const r = readRegular(p);
      if (!r) problems.push(`${rel}: not readable as a regular file`);
      else if (hashBuf(r.bytes) !== m.sha256) problems.push(`${rel}: content differs from its recorded sha256`);
      else {
        cache.set(rel, `${sigOf(r.st)}:${m.sha256}`);
        cacheChanged = true;
        sigs?.set(rel, sigOf(r.st));
      }
      continue;
    }
    sigs?.set(rel, sig);
  }
  // A capture changed between the gate's collection and its recording: the manifest then holds the changed bytes, the
  // gate's own record the collected ones.
  const seen = new Set();
  for (const c of lite.collected) {
    const rel = path.relative(dir, c.path).split(path.sep).join('/');
    const m = lite.manifest.get(rel);
    // A file the owner re-baselined is judged against what was accepted, not against the gate's original record.
    if (m && m.sha256 !== c.sha256 && !seen.has(rel) && !lite.rebaselined.has(rel)) {
      seen.add(rel);
      problems.push(`${rel}: changed between the gate collecting it and wf recording it`);
    }
  }
  if (cacheChanged && !problems.length) writeCache(root, id, cache);
  return problems;
}

// Right before a decision is recorded (accept, deliver): nothing verified at open has changed since. Stat signatures
// (ctime and inode included) taken when the content was hashed; any difference refuses.
export function assertUnchanged(root, id) {
  const t = touched.get(`${root}\0${id}`);
  if (!t?.sigs) return [`${id} was not verified in this command`];
  const dir = attemptDirOf(root, id);
  const out = [];
  for (const [rel, sig] of t.sigs) {
    const st = fs.lstatSync(path.join(dir, rel), { throwIfNoEntry: false });
    if (!st || sigOf(st) !== sig) out.push(`${rel}: changed after it was verified in this command`);
  }
  return out;
}

// ---- recording ----
export function recordFiles(root, id, rels, appendFn, type = 'evidence.recorded', exemptRuns = null) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const out = [];
  const abs = [];
  for (const rel of rels) {
    if (MUTABLE(rel, exemptRuns ?? lite.openRuns)) continue;
    const p = path.join(dir, rel);
    try {
      fs.chmodSync(p, 0o444);
    } catch {}
    const r = readRegular(p);
    if (!r) continue;
    const m = lite.manifest.get(rel);
    const entry = { path: rel, sha256: hashBuf(r.bytes), size: r.bytes.length, mode: 0o444 };
    if (m && m.sha256 === entry.sha256 && m.size === entry.size && m.mode === entry.mode) continue;
    out.push(entry);
    abs.push(p);
  }
  if (out.length || type === 'evidence.baseline') appendFn(root, id, type, { files: out }, null);
  setImmutable(abs, true);
  // Signatures after protection (the immutable flag changes ctime).
  const cache = readCache(root, id);
  for (const e of out) {
    const st = fs.lstatSync(path.join(dir, e.path), { throwIfNoEntry: false });
    if (st) cache.set(e.path, `${sigOf(st)}:${e.sha256}`);
  }
  if (out.length) writeCache(root, id, cache);
  return out;
}

// The first open of an attempt in this process: verify, adopt a pre-manifest attempt once, snapshot, unlock folders.
export function touch(root, id, appendFn) {
  const key = `${root}\0${id}`;
  const prev = touched.get(key);
  if (prev && (prev.verified === 'full' || level === 'quick')) return [];
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  if (!prev && preManifest(lite) && !lite.unreadable.length) {
    // Adopted as found, once: an `evidence.baseline` entry is appended even when there is nothing to record, so the
    // attempt is never adopted again.
    const anchorProblems = verifyAttempt(root, id);
    if (anchorProblems.length) return anchorProblems;
    unlockDirs(root, id);
    const { files, odd, errors } = walk(dir);
    if (odd.length || errors.length) return [...errors, ...odd.map((o) => `${o.rel}: ${o.kind}`)];
    recordFiles(root, id, files.filter((rel) => !MUTABLE(rel, [])), appendFn, 'evidence.baseline');
  }
  const sigs = new Map();
  const problems = verifyAttempt(root, id, { full: level === 'full', sigs });
  if (problems.length) return problems;
  touched.set(key, { root, id, snapshot: prev?.snapshot ?? new Set(walk(dir).files), verified: level, sigs });
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
    // A run being recorded finished is no longer open: its progress file is recorded with the rest of it.
    const exempt = only?.runId ? lite.openRuns.filter((r) => r !== only.runId) : lite.openRuns;
    const rels = walk(dir).files.filter((rel) => !MUTABLE(rel, exempt) && mine(rel) && (!lite.manifest.has(rel) || rewritten.has(path.join(dir, rel))));
    recordFiles(t.root, t.id, rels, appendFn, 'evidence.recorded', exempt);
    for (const rel of rels) {
      t.snapshot.add(rel);
      rewritten.delete(path.join(dir, rel));
    }
    if (!only) lockDirs(t.root, t.id);
  }
}

// ---- repair: `wf verify --accept-changes --reason` ----
// The differences, for the owner to see; never applied without the explicit flag. Refused when the ledger itself is in
// doubt (unreadable lines, chain or anchor mismatch) or when a path is a link or not a regular file.
export function changesOf(root, id) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const blocking = verifyAttempt(root, id).filter((p) => /^ledger|anchor|released|does not start|unreadable folder|verification failed/.test(p));
  const { files, odd, errors } = walk(dir);
  blocking.push(...errors, ...odd.map((o) => `${o.rel}: ${o.kind} (replace it with a regular file or remove it first)`));
  const changes = [];
  const pending = (rel) => lite.openRuns.some((r) => rel.startsWith(`gate/${r}/`));
  for (const [rel, m] of lite.manifest) {
    const r = readRegular(path.join(dir, rel));
    if (!r) changes.push({ path: rel, kind: 'removed', old: m.sha256, new: null });
    else {
      const h = hashBuf(r.bytes);
      if (h !== m.sha256 || r.bytes.length !== m.size || (r.st.mode & 0o777) !== m.mode) changes.push({ path: rel, kind: 'changed', old: m.sha256, new: h, size: r.bytes.length, mode: 0o444 });
    }
  }
  for (const rel of files) if (!MUTABLE(rel, lite.openRuns, isV020(lite)) && !lite.manifest.has(rel) && !pending(rel)) {
    const r = readRegular(path.join(dir, rel));
    if (r) changes.push({ path: rel, kind: 'added', old: null, new: hashBuf(r.bytes), size: r.bytes.length, mode: 0o444 });
  }
  return { blocking, changes };
}

export function rebaseline(root, id, reason, appendFn, actor) {
  const { blocking, changes } = changesOf(root, id);
  if (blocking.length) return { blocking, changes: [] };
  if (!changes.length) return { blocking: [], changes: [] };
  const dir = attemptDirOf(root, id);
  unlockDirs(root, id);
  const keep = changes.filter((c) => c.kind !== 'removed').map((c) => path.join(dir, c.path));
  for (const p of keep) {
    setImmutable([p], false);
    fs.chmodSync(p, 0o444);
  }
  appendFn(root, id, 'evidence.rebaselined', { reason, changes }, actor);
  setImmutable(keep, true);
  const cache = readCache(root, id);
  for (const c of changes) {
    if (c.kind === 'removed') cache.delete(c.path);
    else {
      const st = fs.lstatSync(path.join(dir, c.path));
      cache.set(c.path, `${sigOf(st)}:${c.new}`);
    }
  }
  writeCache(root, id, cache);
  lockDirs(root, id);
  return { blocking: [], changes };
}

// ---- release: `wf evidence release` ----
// Moves the attempt's evidence out of `attempts/` in one rename (so it is never half-listed), lifts the protection
// through this helper, deletes it, and leaves a tombstone anchor; a ledger reappearing under that id is refused.
export function releaseAttempt(root, id, reason) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const head = lite.entries.at(-1);
  const dest = path.join(evidenceRootOf(root), 'released', `${id}-${Date.now()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.chmodSync(dir, 0o755);
  fs.renameSync(dir, dest);
  writeAnchor(root, id, head, { released: true, at: new Date().toISOString(), reason });
  const leftover = removeTree(dest);
  try {
    fs.rmSync(statCacheFile(root, id), { force: true });
  } catch {}
  return { id, removed: !leftover, leftover };
}

// Lifts flags and modes, then deletes. Returns null, or the path left behind (with why) when something refused.
function removeTree(dir) {
  const { files, dirs } = walk(dir);
  setImmutable(files.map((rel) => path.join(dir, rel)), false);
  for (const d of [dir, ...dirs]) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {}
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `${dir} (${error.code ?? error.message})`;
  }
}

// Every attempt this process opened is new to it again (tests that run several engine calls in one process).
export function forget() {
  touched.clear();
  rewritten.clear();
  gateRuns.clear();
}
