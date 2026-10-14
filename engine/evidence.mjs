import { mkdirStateDirectory } from './state-folders.mjs';
// Evidence integrity: a manifest of every evidence file in the hash-chained ledger, write protection, verification at
// every use, a chain-head anchor outside the evidence tree, repair (re-baseline) and release (prune) through the engine.
//
// Named gaps (0.1.19): a command/path guard cannot see writes made through MCP tools, harnesses without a hook, gate steps and
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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { assertSafeId, canonical, isPidAlive, refuse } from './util.mjs';
import { canonical as canonicalPath, isInside, touchesEvidence } from './paths.mjs';

const hashBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Named failure: concurrent review closures exposed raw files before their manifest entries existed.
// Serialize short evidence transactions and readers; this lock never expires a live or uncertain owner by age.
const evidenceTransactions = new Set();
export const transactionSeams = { afterCollision: null };
const transactionLockFile = (root, id) => path.join(fs.realpathSync(root), '.wf-worktrees', '_transactions', `${id}.lock`);

// Named failure: a `wf` process killed while it held an attempt's lock (a stopped gate step, a sandbox timeout, a closed
// terminal) left the lock behind, and every later command refused with "evidence transaction is still locked; reconcile
// its owner before cleanup" (144-188 refusals); the guard then blocked the manual cleanup it asked for. The lock's owner
// is the pid it records: when that process is gone on this host (kill 0 says ESRCH), nobody can be inside the
// transaction and the lock is reclaimed. A live owner, an owner on another host and a lock whose owner cannot be read
// are never reclaimed, and age alone never is.
function deadOwner(lock) {
  return Number.isInteger(lock?.pid) && lock.pid > 0 && lock.pid !== process.pid && (!lock.host || lock.host === os.hostname()) && !isPidAlive(lock.pid);
}
const parseLock = (read) => {
  try { return read ? JSON.parse(read.bytes) : null; } catch { return null; }
};
// Removes the lock `file` only while it still holds `token` and its owner is gone. Reclaiming is itself exclusive (a
// `.reclaim` file made with O_EXCL), so two processes that both saw the dead owner cannot remove each other's fresh lock.
function reclaimDeadLock(file, token) {
  const gate = `${file}.reclaim`;
  try { writeNoFollow(gate, JSON.stringify({ pid: process.pid, host: os.hostname() }), { exclusive: true }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A reclaimer that died mid-way leaves its gate: the same rule applies to it.
    if (deadOwner(parseLock(readRegular(gate)))) fs.rmSync(gate, { force: true });
    return false;
  }
  try {
    const lock = parseLock(readRegular(file));
    if (!lock || lock.token !== token || !deadOwner(lock)) return false;
    fs.unlinkSync(file);
    process.stderr.write(`wf: reclaimed an evidence lock left by a process that is gone (pid ${lock.pid})\n`);
    return true;
  } finally { fs.rmSync(gate, { force: true }); }
}

// `wf unlock --attempt ID`: remove the evidence lock of an attempt whose owner is gone (it is also reclaimed on its own at
// the next command; this is for looking at it and for a lock that nothing waits on). A live owner is refused.
export function unlockEvidence(root, id) {
  assertSafeId(id, 'attempt');
  const file = transactionLockFile(root, id);
  if (canonicalPath(file) !== file) throw refuse('evidence transaction control path resolves outside its recorded location', undefined, { id: 'lock:path' });
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { id, removed: false, note: `${id} has no evidence lock` };
  const read = readRegular(file);
  const lock = parseLock(read);
  if (!read || !lock) throw refuse(`the evidence lock of ${id} cannot be read, so its owner is unknown; it is not removed`, `inspect ${file} by hand: if no wf command runs, delete that file yourself`, { id: 'lock:unreadable' });
  if (!deadOwner(lock)) {
    const why = lock.pid === process.pid ? 'this process' : lock.host && lock.host !== os.hostname() ? `a process on another host (${lock.host})` : `pid ${lock.pid}, which is still running`;
    throw refuse(`the evidence lock of ${id} is held by ${why}`, 'wait for that command to finish, or stop it (`wf stop`, or end the process), then run `wf unlock` again', { id: 'lock:owner-alive' });
  }
  if (!reclaimDeadLock(file, lock.token)) throw refuse(`the evidence lock of ${id} changed while it was being removed; look again`, undefined, { id: 'lock:changed' });
  return { id, removed: true, pid: lock.pid, note: `removed the evidence lock of ${id} (its owner, pid ${lock.pid}, is gone)` };
}

export function withEvidenceTransaction(root, id, fn) {
  assertSafeId(id, 'attempt');
  // Named failure: a linked runner directory prevented even read-only diagnosis of a refused launch.
  // Evidence transactions have their own control directory, independent of the runner's control paths.
  const realRoot = fs.realpathSync(root), file = path.join(realRoot, '.wf-worktrees', '_transactions', `${id}.lock`);
  if (canonicalPath(file) !== file) throw refuse('evidence transaction control path resolves outside its recorded location');
  if (evidenceTransactions.has(file)) return fn();
  mkdirStateDirectory(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID(), deadline = Date.now() + 10000, sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { writeNoFollow(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { exclusive: true }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      transactionSeams.afterCollision?.(file);
      const current = readRegular(file);
      // Named failure: the owner can release its lock between EEXIST and our no-follow read.
      // Retry a missing entry only; links, unreadable entries and uncertain owners still fail closed.
      if (!current && fs.lstatSync(file, { throwIfNoEntry: false })) throw refuse('evidence transaction lock is unreadable; reconcile its owner before cleanup', undefined, { id: 'lock:unreadable' });
      const held = parseLock(current);
      if (held && deadOwner(held) && reclaimDeadLock(file, held.token)) continue;
      if (Date.now() > deadline) throw refuse('evidence transaction is still locked; reconcile its owner before cleanup, never expire it by age', `its owner is pid ${held?.pid ?? 'unknown'}${held?.pid ? ' (still running)' : ''}: wait for it, or stop it and run \`wf unlock --attempt ${id}\``, { id: 'lock:held' });
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  evidenceTransactions.add(file);
  try { return fn(); }
  finally {
    evidenceTransactions.delete(file);
    const current = readRegular(file);
    if (!current || JSON.parse(current.bytes).token !== token) throw refuse('evidence transaction ownership changed; retain the lock for diagnosis');
    fs.unlinkSync(file);
  }
}

// ---- no-follow primitives (named finding, 0.1.21 review: chmod, chflags and writes followed a symlink planted at an
// evidence path, so the engine could chmod, unflag or overwrite an arbitrary file outside the evidence) ----
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_NOFOLLOW } = fs.constants;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
export class LinkRefused extends Error {}
// Test seams: called between the check of an entry and the operation on it (to swap something in).
export const linkSeams = { beforeOpen: null, beforeFlag: null };
// Identity of an entry. Device and inode alone are not enough: Linux reuses a freed inode number at once, so a file
// removed and recreated between a check and its use had the same pair (named failure, 0.3.0 CI on Linux). The birth
// time (statx, nanoseconds) tells a recreated file apart and survives chmod and chflags; the change time also does
// where nothing is expected to touch the entry in between.
const idStat = (p) => fs.lstatSync(p, { throwIfNoEntry: false, bigint: true });
const sameEntry = (a, b, { ctime = false } = {}) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && (!ctime || a.ctimeNs === b.ctimeNs));

// chmod of exactly this entry: lstat, open without following a link, fstat compared with the lstat (same device and
// inode; a file not hard-linked elsewhere), changed through the descriptor.
export function chmodNoFollow(p, mode, { dir = false } = {}) {
  const before = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!before || (dir ? !before.isDirectory() : !before.isFile())) throw new LinkRefused(`${p} is ${before?.isSymbolicLink() ? 'a symlink' : before ? `not a ${dir ? 'folder' : 'regular file'}` : 'missing'}; not changed`);
  if (!dir && before.nlink > 1) throw new LinkRefused(`${p} is a hard link (${before.nlink} names share its data); not changed`);
  const beforeId = idStat(p);
  linkSeams.beforeOpen?.(p);
  let fd;
  try {
    fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW | (dir ? O_DIRECTORY : 0));
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new LinkRefused(`${p} became a symlink or not a ${dir ? 'folder' : 'file'}; not changed`);
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    if (dir ? !st.isDirectory() : !st.isFile()) throw new LinkRefused(`${p} is not a regular ${dir ? 'folder' : 'file'}; not changed`);
    // A file's change time too (nothing else should touch it in between); not a folder's: another wf process writing
    // into it changes its ctime legitimately.
    if (!sameEntry(fs.fstatSync(fd, { bigint: true }), beforeId, { ctime: !dir })) throw new LinkRefused(`${p} was replaced between its check and its use; not changed`);
    if (!dir && st.nlink > 1) throw new LinkRefused(`${p} is a hard link (${st.nlink} names share its data); not changed`);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

// A write to exactly this path, never through a link: a new file is created exclusively; an existing one is never
// written in place (a hard link would share the change with a file elsewhere): the content goes into a fresh exclusive
// file in the same folder, which is renamed over it (the name is replaced, not the shared data). An append (the ledger,
// a step log) opens with O_NOFOLLOW and refuses a file with more than one name.
export function writeNoFollow(file, data, { append = false, exclusive = false, mode = 0o644 } = {}) {
  const bytes = typeof data === 'string' ? data : Buffer.from(data);
  const put = (target, flags) => {
    let fd;
    try {
      fd = fs.openSync(target, O_WRONLY | O_NOFOLLOW | flags, mode);
    } catch (error) {
      if (error.code === 'ELOOP') throw new LinkRefused(`${file} is a symlink; not written through`);
      throw error;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new LinkRefused(`${file} is not a regular file; not written`);
      if (st.nlink > 1) throw new LinkRefused(`${file} is a hard link (${st.nlink} names share its data); not written`);
      fs.writeSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  };
  if (append) return put(file, O_CREAT | O_APPEND);
  if (exclusive) return put(file, O_CREAT | O_EXCL);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new LinkRefused(`${file} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; not written through`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.wf-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  put(tmp, O_CREAT | O_EXCL);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// An append stream on exactly this file (a gate step's log); refuses a link or a file with more than one name.
export function appendStreamNoFollow(file) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o644);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink > 1) {
    fs.closeSync(fd);
    throw new LinkRefused(`${file} is not a regular file with one name; not written`);
  }
  return fs.createWriteStream(null, { fd });
}


// The nearest existing ancestor and the rest; every existing component from `from` down must be a real folder.
function assertRealFolders(dir, from) {
  const rel = path.relative(from, dir);
  if (rel.startsWith('..')) return;
  let cur = from;
  for (const part of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, part);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return;
    if (!st.isDirectory()) throw new LinkRefused(`${cur} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; nothing is written through it`);
  }
}

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
export const verifyLevel = () => level;
export const ownGateRun = (root, id, runId) => gateRuns.add(`${root}\0${id}\0${runId}`);

// ---- protection ----
// Only regular files, checked with lstat; `chflags -h` acts on a link itself, never its target (chattr refuses links).
// Path-based (chflags/chattr take paths): every entry is lstat'ed before (a regular file with one name) and after; an
// entry replaced in between had the flag changed on whatever was swapped in, so that change is undone on it and the
// call refuses, naming it.
function setImmutable(files, on) {
  if (!flagsOn() || !files.length) return;
  const flag = (x) => (process.platform === 'darwin' ? ['chflags', '-h', x ? 'uchg' : 'nouchg'] : process.platform === 'linux' && process.getuid?.() === 0 ? ['chattr', x ? '+i' : '-i'] : null);
  const tool = flag(on);
  if (!tool) return;
  const before = new Map();
  for (const f of files) {
    const st = idStat(f);
    if (st?.isFile() && st.nlink === 1n) before.set(f, st);
  }
  const real = [...before.keys()];
  linkSeams.beforeFlag?.(real);
  for (let i = 0; i < real.length; i += 200) spawnSync(tool[0], [...tool.slice(1), ...real.slice(i, i + 200)], { stdio: 'ignore' });
  const swapped = real.filter((f) => !sameEntry(idStat(f), before.get(f)));
  if (swapped.length) {
    const undo = flag(!on);
    spawnSync(undo[0], [...undo.slice(1), ...swapped], { stdio: 'ignore' });
    throw new LinkRefused(`replaced while its flag was changed (the change was undone on what was swapped in): ${swapped.join(', ')}`);
  }
}

// What this machine can do, for `wf doctor`: probed on a scratch file next to the evidence.
export function protectionLayers(root) {
  const dir = path.join(root, '.wf-worktrees', '_probe');
  const file = path.join(dir, `probe-${process.pid}`);
  const out = [];
  try {
    mkdirStateDirectory(dir, { recursive: true });
    assertRealFolders(dir, root);
    writeNoFollow(file, 'x', { exclusive: true });
    chmodNoFollow(file, 0o444);
    // Tried, not assumed: root (and some filesystems) ignore the modes.
    let modes = true;
    try {
      writeNoFollow(file, 'y', { append: true });
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
      chmodNoFollow(file, 0o644);
    } catch {}
    try {
      if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
      fs.rmdirSync(dir);
    } catch {}
  }
  out.push({ layer: 'manifest verified at every use (hash chain, anchor, sha256 of every evidence file)', active: true });
  return out;
}

function walk(dir, out = { files: [], dirs: [], odd: [], errors: [] }, base = dir) {
  // Never into a link, the starting folder included.
  if (dir === base && fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    out.errors.push(`${dir}: symlink (not followed)`);
    return out;
  }
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
// One safe read for every local file a tracker action or an export sends anywhere (the files tracker's copy, the
// Linear and GitHub uploads, `wf export screenshots`, the export page). Named finding (0.4.0 review: symlink-following
// upload): an adapter read the attachment by its path, so a link planted there could upload any local file. Now the
// file must lie inside this project's attempt evidence (a reused gate step's screenshot lives in the attempt that ran
// it) after resolving every folder on its path, the last name is opened
// without following a link (and without blocking on a FIFO), the descriptor must be a regular file with one name, and
// its bytes, read once, must hash to the sha256 the gate recorded; size and hash come from those bytes. The name sent
// is the title as a plain file name. Returns { bytes, size, sha256, name } or throws with the reason.
export const deliveredSeams = { beforeOpen: null };
const refusedRead = (code, message) => Object.assign(new Error(message), { code });
// Named failure (I-100): a step plugin's artifact was recorded at the scratch path it was written to (the gate's scratch
// folder: <attempt>/<run>/<step>/<file> below the project's gate scratch root), though the gate had already sealed a copy of
// it at <attempt>/gate/<run>/<step>/out/<file> in the evidence. An attempt gated that way keeps the scratch path in its
// ledger, and every export of it was refused as outside the evidence. A reader given such a path and the recorded sha256
// reads the sealed copy instead (the sha256 is checked on its bytes, so a copy that differs is refused as any other); the
// scratch file is never opened and any other path outside the evidence is still refused.
export function sealedCopyOfScratch(root, scratchPath, sha256) {
  if (!sha256) return null;
  const gateScratch = path.join(root, '.wf-worktrees', '_gate');
  if (!isInside(scratchPath, gateScratch)) return null;
  const parts = path.relative(canonicalPath(gateScratch), canonicalPath(scratchPath)).split(path.sep);
  const [attempt, run, step, ...file] = parts;
  if (!attempt || !run || !step || !file.length || parts.some((x) => !x || x === '..')) return null;
  return path.join(evidenceRootOf(root), 'attempts', attempt, 'gate', run, step, 'out', ...file);
}

export function readEvidenceFile(root, attemptId, f) {
  const label = f.title ?? path.basename(String(f.path));
  void attemptId;
  const dir = fs.realpathSync.native(path.join(evidenceRootOf(root), 'attempts'));
  const abs = sealedCopyOfScratch(root, path.resolve(String(f.path)), f.sha256) ?? path.resolve(String(f.path));
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(abs));
  } catch {
    throw refusedRead('ENOENT', `${label}: ${abs} is missing`);
  }
  // The folders are resolved; the last name is not (a link there is refused by the no-follow open below).
  if (!isInside(parent, dir) || parent === dir) throw refusedRead('EOUTSIDE', `${label}: ${abs} is outside the project's attempt evidence; only the delivered set is read`);
  deliveredSeams.beforeOpen?.(abs);
  let fd;
  try {
    fd = fs.openSync(path.join(parent, path.basename(abs)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw refusedRead(error.code ?? 'EOPEN', `${label}: ${abs} not opened (${error.code === 'ELOOP' ? 'a symlink is never followed' : error.code ?? error.message})`);
  }
  let bytes;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refusedRead('ENOTREG', `${label}: ${abs} is not a regular file`);
    if (st.nlink > 1) throw refusedRead('ENLINK', `${label}: ${abs} has another name (hard link); not read`);
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const sha = hashBuf(bytes);
  if (f.sha256 && sha !== f.sha256) throw refusedRead('ESHA', `${label}: bytes differ from the recorded sha256 (${abs})`);
  const name = String(path.basename(String(label).replace(/\\/g, '/'))).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || /^\.+$/.test(name)) throw refusedRead('ENAME', `${JSON.stringify(label)}: not a usable file name`);
  return { bytes, size: bytes.length, sha256: sha, name };
}

// A file a command is about to read, against its recorded sha256 (0.7.0: the commands that no longer re-hash everything
// check the files they read). null for a file that is not in the manifest (the ledger); otherwise a problem line or null.
export function recordedFileProblem(root, id, abs) {
  const rel = path.relative(attemptDirOf(root, id), abs).split(path.sep).join('/');
  const m = loadLedgerLite(root, id).manifest.get(rel);
  if (!m) return null;
  const r = readRegular(abs);
  if (!r) return `${rel}: not readable as a regular file`;
  return hashBuf(r.bytes) === m.sha256 ? null : `${rel}: content differs from its recorded sha256`;
}

export function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    // A file with another name elsewhere is not evidence (its data can be changed through that name).
    if (!st.isFile() || st.nlink > 1) return null;
    return { bytes: fs.readFileSync(fd), st };
  } finally {
    fs.closeSync(fd);
  }
}

const sigOf = (st) => [st.size, Math.round(st.mtimeMs), Math.round(st.ctimeMs), st.ino, st.mode & 0o777].join(':');

// Makes the attempt's directories writable for the engine (files stay protected).
export function unlockDirs(root, id) {
  const dir = attemptDirOf(root, id);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const d of [dir, ...walk(dir).dirs]) {
    try {
      chmodNoFollow(d, 0o755, { dir: true });
    } catch {}
  }
}

function lockDirs(root, id) {
  const dir = attemptDirOf(root, id);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  // A gate run that is still open keeps its own folders writable (its runner is still writing them).
  const open = loadLedgerLite(root, id).openRuns;
  for (const d of walk(dir).dirs.reverse().concat(dir)) {
    const rel = path.relative(dir, d).split(path.sep).join('/');
    if (rel === 'gate' || rel === '' || open.some((r) => rel === `gate/${r}` || rel.startsWith(`gate/${r}/`))) continue;
    try {
      chmodNoFollow(d, 0o555, { dir: true });
    } catch {}
  }
}

// Before the engine creates or rewrites `file` inside an attempt's evidence: its folders writable, its protection lifted.
// Refuses (LinkRefused) when any folder below `.wf-evidence`, or the file itself, is a symlink or not what it should be:
// nothing is unprotected, chmodded or written through a link. Callers write with `writeNoFollow`.
export function prepareWrite(file) {
  const abs = path.resolve(file);
  const parts = abs.split(path.sep);
  if (!touchesEvidence(abs)) return abs;
  const at = parts.map((x) => x.normalize('NFKC').toLowerCase()).lastIndexOf('.wf-evidence');
  if (at < 0) return abs;
  const evRoot = parts.slice(0, at + 1).join(path.sep);
  assertRealFolders(path.dirname(abs), evRoot);
  // From the attempt's own folder down: `attempts/` is shared by every attempt (and concurrent gates) and never locked.
  for (let i = at + 3; i < parts.length; i++) {
    const d = parts.slice(0, i).join(path.sep);
    if (fs.lstatSync(d, { throwIfNoEntry: false })?.isDirectory()) chmodNoFollow(d, 0o755, { dir: true });
  }
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new LinkRefused(`${abs} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; not unprotected or written`);
  if (st && st.nlink > 1) throw new LinkRefused(`${abs} is a hard link (${st.nlink} names share its data); not unprotected or written`);
  if (st) {
    setImmutable([abs], false);
    chmodNoFollow(abs, 0o644);
    rewritten.add(abs);
  }
  return abs;
}

// Which of an attempt's files a reader may list. Named failure (I-50): a file a `wf` command had written but not yet
// recorded was listed (and offered to `wf evidence show`) as if it were evidence. Recorded files, the ledger and the
// files that are never recorded (a gate's lock and live progress) are; an attempt from before the manifest has nothing to
// filter by.
export function listableOf(root, id) {
  const lite = loadLedgerLite(root, id);
  if (!lite.baselined) return () => true;
  return (rel) => lite.manifest.has(rel) || MUTABLE(rel, lite.openRuns, isV020(lite));
}

// ---- the ledger, read without the engine's reducer (no import cycle) ----
const SEMVER = /^\d+\.\d+\.\d+$/;
// Named failure (0.7.0): on a 96 MB ledger a read took 9 seconds, because every command parsed the ledger several times and
// hashed every entry each time. The result is kept for as long as the ledger file is unchanged (size, mtime, inode), and the
// hash chain is walked in full only by the commands that must (`full`: accept, deliver, verify, doctor, export); every other
// command checks the links between entries and the last entry's own hash, which is what the anchor binds.
const liteCache = new Map(); // ledger file -> { sig, chained, out }
function loadLedgerLite(root, id, { chain = false } = {}) {
  const file = path.join(attemptDirOf(root, id), 'ledger.jsonl');
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return { entries: [], manifest: new Map(), openRuns: [], finishedRuns: new Set(), startedRuns: new Set(), engineVersion: null, admitted: false, baselined: false, collected: [], unreadable: [], chainBreak: null, rebaselined: new Set() };
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
  let hit = liteCache.get(file);
  if (!hit || hit.sig !== sig) {
    hit = { sig, chained: false, out: parseLedgerLite(file) };
    liteCache.set(file, hit);
  }
  if (hit.out.chainBreak === null) {
    const { entries } = hit.out;
    const hashOk = (e) => { const { hash, ...rest } = e; return hash === hashBuf(canonical(rest)); };
    if (chain && !hit.chained) {
      let prevHash = null;
      for (const [i, e] of entries.entries()) {
        if (e.prev !== prevHash || !hashOk(e)) { hit.out.chainBreak = e.seq ?? i + 1; break; }
        prevHash = e.hash;
      }
      hit.chained = true;
    } else if (!hit.chained && !hit.tail) {
      const last = entries.at(-1);
      if (last && (last.prev !== (entries.at(-2)?.hash ?? null) || !hashOk(last))) hit.out.chainBreak = last.seq ?? entries.length;
      hit.tail = true;
    }
  }
  return hit.out;
}

function parseLedgerLite(file) {
  const out = { entries: [], manifest: new Map(), openRuns: [], finishedRuns: new Set(), startedRuns: new Set(), engineVersion: null, admitted: false, baselined: false, collected: [], unreadable: [], chainBreak: null, rebaselined: new Set() };
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
    // I-94: an imported capture is judged the same way, against the bytes `wf captures import` read.
    if (e.type === 'captures.imported') for (const x of d.files ?? []) if (x?.path && x.sha256) out.collected.push({ path: x.path, sha256: x.sha256 });
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
  // Never through a link: a symlinked `.wf-worktrees`, `_anchor` or anchor file leaves the anchor stale, and the next
  // verification refuses the attempt (anchor not a regular file, or head mismatch).
  try {
    assertRealFolders(path.dirname(file), root);
    mkdirStateDirectory(path.dirname(file), { recursive: true });
    assertRealFolders(path.dirname(file), root);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return;
    if (st) chmodNoFollow(file, 0o644);
    writeNoFollow(file, `${JSON.stringify({ attempt: id, seq: entry?.seq ?? null, hash: entry?.hash ?? null, ...extra })}\n`, { mode: 0o444 });
    chmodNoFollow(file, 0o444);
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
    assertRealFolders(path.dirname(f), root);
    mkdirStateDirectory(path.dirname(f), { recursive: true });
    writeNoFollow(f, JSON.stringify({ files: Object.fromEntries(cache) }));
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
  const lite = loadLedgerLite(root, id, { chain: full });
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
  const top = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (top && !top.isDirectory()) return [...problems, `the attempt folder ${dir} is ${top.isSymbolicLink() ? 'a symlink' : 'not a folder'}; nothing in it is used`];
  for (const p of [evidenceRootOf(root), path.dirname(dir)]) {
    const s = fs.lstatSync(p, { throwIfNoEntry: false });
    if (s && !s.isDirectory() && p !== evidenceRootOf(root)) return [...problems, `${p} is a symlink or not a folder; nothing in it is used`];
  }
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
    if (st.nlink > 1) problems.push(`${rel}: hard link (${st.nlink} names share its data)`);
    else if (st.size !== m.size) problems.push(`${rel}: size ${st.size}, recorded ${m.size}`);
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
      chmodNoFollow(p, 0o444);
    } catch {
      continue; // a link or not a regular file: never recorded (verification names it)
    }
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
  return withEvidenceTransaction(root, id, () => touchLocked(root, id, appendFn));
}
function touchLocked(root, id, appendFn) {
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
    withEvidenceTransaction(t.root, t.id, () => {
    const dir = attemptDirOf(t.root, t.id);
    if (!fs.existsSync(dir)) return;
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
    });
  }
}

// ---- repair: `wf verify --accept-changes --reason` ----
// The differences, for the owner to see; never applied without the explicit flag. Refused when the ledger itself is in
// doubt (unreadable lines, chain or anchor mismatch) or when a path is a link or not a regular file.
export function changesOf(root, id) {
  const dir = attemptDirOf(root, id);
  const lite = loadLedgerLite(root, id);
  const blocking = verifyAttempt(root, id, { full: true }).filter((p) => /^ledger|anchor|released|does not start|unreadable folder|verification failed/.test(p));
  const { files, odd, errors } = walk(dir);
  blocking.push(...errors, ...odd.map((o) => `${o.rel}: ${o.kind} (replace it with a regular file or remove it first)`));
  for (const rel of files) {
    const st = fs.lstatSync(path.join(dir, rel), { throwIfNoEntry: false });
    if (st?.nlink > 1) blocking.push(`${rel}: hard link (${st.nlink} names share its data); replace it with a copy first`);
  }
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
    if (!fs.lstatSync(p, { throwIfNoEntry: false })?.isFile()) return { blocking: [`${p}: not a regular file; nothing re-baselined`], changes: [] };
    setImmutable([p], false);
    chmodNoFollow(p, 0o444);
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
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new LinkRefused(`${dir} is ${st ? 'a symlink or not a folder' : 'missing'}; nothing released`);
  const dest = path.join(evidenceRootOf(root), 'released', `${id}-${Date.now()}`);
  assertRealFolders(path.dirname(dest), evidenceRootOf(root));
  mkdirStateDirectory(path.dirname(dest), { recursive: true });
  chmodNoFollow(dir, 0o755, { dir: true });
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
      chmodNoFollow(d, 0o755, { dir: true });
    } catch {}
  }
  try {
    // rm removes links themselves and does not descend into them.
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
