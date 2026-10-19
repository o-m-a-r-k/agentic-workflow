// Finding a Codex session's transcript. Named failure I-34: desktop resumes write suffixed rollouts; filename-only lookup
// reads the abandoned initial file. Codex's threads index chooses its active rollout. Read it without writing, then
// validate the path and the recorded id. No newest-file heuristic and no caller-supplied authority text. A same-user
// forger can edit this host store too, which is outside the threat model (D6 in docs/DESIGN.md).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { inspectFile, isPlainSessionId, maxTranscriptBytes, settleTranscript } from './safe-file.mjs';

const require = createRequire(import.meta.url);

// Rows of a read-only query against a SQLite file: Node's own driver where it has one, else the system `sqlite3`
// command. `params` are plain ids (letters, digits, dashes) the caller already validated; the command line has no
// parameter binding, so anything else is refused here too.
export function rows(file, sql, params = []) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (error) {
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  }
  // Node 20 has no built-in SQLite. Use a read-only system reader; no shell, and the already-validated ids are plain.
  if (params.some((p) => !/^[A-Za-z0-9-]+$/.test(String(p)))) throw new Error('a query parameter is not a plain id');
  let at = 0;
  const text = sql.replace(/\?/g, () => `'${params[at++]}'`);
  const cli = spawnSync(fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3', ['-readonly', '-json', file, text], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (cli.status === 0) return JSON.parse(cli.stdout.trim() || '[]');
  throw new Error('the read-only thread index could not be read (requires Node with node:sqlite, or the sqlite3 command)');
}

// → the rollout Codex's index records for the thread, checked: { runtime, session, file, size, index } | { problem } | null
// (null: an older store with no index; unique, unsuffixed transcript discovery still applies).
function indexedRollout(base, baseReal, id, cap) {
  const databases = fs.readdirSync(base).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!databases.length) return null;
  const file = path.join(base, databases[0]); // newest schema generation, never filesystem modification time
  if (inspectFile(file, { under: [baseReal], cap }).failed) return { problem: 'the Codex thread index is not a regular, size-capped file inside the host store' };
  let found;
  try { found = rows(file, 'SELECT rollout_path FROM threads WHERE id = ? LIMIT 2', [id]); } catch (error) { return { problem: `the Codex thread index could not be read: ${error.message}` }; }
  if (!found.length) return { problem: `the Codex thread index has no entry for the owner session \`${id}\`; no stale transcript is substituted` };
  if (found.length !== 1) return { problem: `the Codex thread index has several entries for the owner session \`${id}\`` };
  const selected = found[0].rollout_path;
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.length > 4096) return { problem: 'the Codex thread index records no valid absolute rollout path' };
  const resolved = path.resolve(selected);
  const allowed = ['sessions', 'archived_sessions'].some((dir) => resolved.startsWith(path.join(path.resolve(base), dir) + path.sep));
  if (!allowed) return { problem: 'the indexed Codex rollout is outside the host transcript folders' };
  const checked = inspectFile(selected, { under: ['sessions', 'archived_sessions'].map((dir) => path.join(baseReal, dir)), cap });
  if (['missing', 'symlink', 'irregular'].includes(checked.failed)) return { problem: 'the indexed Codex rollout is missing or is not a regular file with one name' };
  if (checked.failed === 'outside') return { problem: 'the indexed Codex rollout resolves outside the host transcript folders' };
  if (checked.failed === 'oversize') return { problem: `the indexed Codex rollout is ${checked.size} bytes, over the ${cap}-byte cap (WF_TRANSCRIPT_MAX_BYTES)` };
  // The index and the rollout must agree. Never grant another thread's request through a stale or poisoned pointer.
  let meta;
  const fd = fs.openSync(checked.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== checked.stat.ino || opened.dev !== checked.stat.dev) return { problem: 'the indexed Codex rollout changed while it was opened' };
    const bytes = Buffer.alloc(Math.min(opened.size, 1024 * 1024));
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, read).toString('utf8').split('\n')) {
      try { const entry = JSON.parse(line); if (entry.type === 'session_meta') { meta = entry.payload; break; } } catch {}
    }
  } finally { fs.closeSync(fd); }
  if (meta?.id !== id) return { problem: 'the indexed Codex rollout session_meta does not match the owner session' };
  return { runtime: 'codex', session: id, file: checked.file, size: checked.size, index: file };
}

// The transcript of a Codex session under `home`: { runtime, session, file, size } | { problem, gone? }.
export function codexTranscript(session, { home, cap = maxTranscriptBytes(), label = 'Codex' }) {
  // The index lookup puts the id in a query: only a plain id reaches it.
  if (!isPlainSessionId(session)) return { problem: `the owner's session id is not a plain id; no transcript is read` };
  const base = path.join(home, '.codex');
  let baseReal;
  try {
    baseReal = fs.realpathSync.native(base);
  } catch {
    return { problem: `no ${label} transcript store on this machine (${base})`, gone: true };
  }
  const indexed = indexedRollout(base, baseReal, session, cap);
  if (indexed) return indexed;
  const candidates = [];
  for (const top of ['sessions', 'archived_sessions']) {
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.name.startsWith('rollout-') && e.name.endsWith(`-${session}.jsonl`)) candidates.push(p);
      }
    };
    walk(path.join(base, top), 0);
  }
  return settleTranscript({ runtime: 'codex', session, candidates, base, baseReal, cap });
}
