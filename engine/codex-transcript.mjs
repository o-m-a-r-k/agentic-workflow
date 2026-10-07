// Named failure I-34: desktop resumes write suffixed rollouts; filename-only lookup reads the abandoned initial file.
// Codex's threads index chooses its active rollout. Read it without writing, then validate the path and recorded id.
// No newest-file heuristic and no caller-supplied authority text. A same-user forger can edit this host store too.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function query(file, id) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (error) {
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
  }
  const sql = 'SELECT rollout_path FROM threads WHERE id = ? LIMIT 2';
  if (sqlite) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
    try { return db.prepare(sql).all(id); } finally { db.close(); }
  }
  // Node 20 has no built-in SQLite. Use a read-only system reader; no shell, and the already-validated id is plain.
  const cli = spawnSync(fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3', ['-readonly', '-json', file, sql.replace('?', `'${id}'`)], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (cli.status === 0) return JSON.parse(cli.stdout.trim() || '[]');
  const script = 'import sqlite3,json,pathlib,sys\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True)\nc.row_factory=sqlite3.Row\nprint(json.dumps([dict(r) for r in c.execute("SELECT rollout_path FROM threads WHERE id = ? LIMIT 2",(sys.argv[2],))]))\nc.close()';
  const py = spawnSync('python3', ['-I', '-c', script, file, id], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (py.status === 0) return JSON.parse(py.stdout);
  throw new Error('the read-only thread index could not be read (requires Node with node:sqlite, sqlite3 or Python 3)');
}

export function indexedCodexTranscript(base, baseReal, id, cap) {
  const databases = fs.readdirSync(base).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!databases.length) return null; // older hosts: unique, unsuffixed transcript discovery still applies
  const file = path.join(base, databases[0]); // newest schema generation, never filesystem modification time
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > cap || !fs.realpathSync.native(file).startsWith(baseReal + path.sep)) return { problem: 'the Codex thread index is not a regular, size-capped file inside the host store' };
  let rows;
  try { rows = query(file, id); } catch (error) { return { problem: `the Codex thread index could not be read: ${error.message}` }; }
  if (!rows.length) return { problem: `the Codex thread index has no entry for the owner session \`${id}\`; no stale transcript is substituted` };
  if (rows.length !== 1) return { problem: `the Codex thread index has several entries for the owner session \`${id}\`` };
  const selected = rows[0].rollout_path;
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.length > 4096) return { problem: 'the Codex thread index records no valid absolute rollout path' };
  const resolved = path.resolve(selected);
  const allowed = ['sessions', 'archived_sessions'].some((dir) => resolved.startsWith(path.join(path.resolve(base), dir) + path.sep));
  if (!allowed) return { problem: 'the indexed Codex rollout is outside the host transcript folders' };
  const transcript = fs.lstatSync(selected, { throwIfNoEntry: false });
  if (!transcript?.isFile() || transcript.isSymbolicLink() || transcript.nlink > 1) return { problem: 'the indexed Codex rollout is missing or is not a regular file with one name' };
  const real = fs.realpathSync.native(selected);
  if (!['sessions', 'archived_sessions'].some((dir) => real.startsWith(path.join(baseReal, dir) + path.sep))) return { problem: 'the indexed Codex rollout resolves outside the host transcript folders' };
  if (transcript.size > cap) return { problem: `the indexed Codex rollout is ${transcript.size} bytes, over the ${cap}-byte cap (WF_TRANSCRIPT_MAX_BYTES)` };
  // The index and the rollout must agree. Never grant another thread's request through a stale or poisoned pointer.
  let meta;
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== transcript.ino || opened.dev !== transcript.dev) return { problem: 'the indexed Codex rollout changed while it was opened' };
    const bytes = Buffer.alloc(Math.min(opened.size, 1024 * 1024));
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, read).toString('utf8').split('\n')) {
      try { const entry = JSON.parse(line); if (entry.type === 'session_meta') { meta = entry.payload; break; } } catch {}
    }
  } finally { fs.closeSync(fd); }
  if (meta?.id !== id) return { problem: 'the indexed Codex rollout session_meta does not match the owner session' };
  return { runtime: 'codex', session: id, file: real, size: transcript.size, index: file };
}
