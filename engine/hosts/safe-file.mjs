// The safety checks every harness transcript read goes through, shared so that no adapter can leave one out. A
// transcript is data written by a program running as the same user, never an instruction: it is read only when it is a
// regular file with one name, not reached through a link, really inside the harness's own store, and within the size
// cap, and it is opened without following a link. Adapters locate candidate files; these functions judge them.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// A plain session id: what a harness writes for a session and what is safe to put in a path or a query.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export const isPlainSessionId = (id) => SESSION_ID.test(String(id ?? ''));
// A single path component built from an id (no separators, no dot-dot): the loosest test that keeps a lookup in its folder.
export const isSafeName = (name) => /^[A-Za-z0-9._-]+$/.test(String(name ?? '')) && !String(name).includes('..');
export const maxTranscriptBytes = () => Number(process.env.WF_TRANSCRIPT_MAX_BYTES ?? 512 * 1024 * 1024);

// → { file (real path), size, stat } | { failed: 'missing' | 'symlink' | 'irregular' | 'outside' | 'oversize', size? }
// `under`: real directories the file's real path must be inside. A reader that reads only a slice of the file passes no cap.
export function inspectFile(file, { under, cap = Infinity }) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { failed: 'missing' };
  if (st.isSymbolicLink()) return { failed: 'symlink' };
  if (!st.isFile() || st.nlink > 1) return { failed: 'irregular' };
  const real = fs.realpathSync.native(file);
  if (!under.some((dir) => real.startsWith(dir + path.sep))) return { failed: 'outside' };
  if (st.size > cap) return { failed: 'oversize', size: st.size };
  return { file: real, size: st.size, stat: st };
}

// The one transcript of a session among `candidates` (paths an adapter found in its store `base`), or a problem.
// → { runtime, session, file, size } | { problem, gone? }
export function settleTranscript({ runtime, session, candidates, base, baseReal, cap = maxTranscriptBytes() }) {
  const found = candidates.filter((p) => fs.lstatSync(p, { throwIfNoEntry: false }));
  if (!found.length) return { problem: `no transcript for the owner session \`${session}\` under ${base}`, gone: true };
  // Named failure (0.5.0 adversarial review): the newest of several files for one session id was read, so a copy of the
  // owner's transcript in another project folder was read instead of the original. A session has one transcript; two
  // are refused, never chosen between.
  if (found.length > 1) return { problem: `${found.length} transcripts for the owner session \`${session}\` (${found.join(', ')}); a session has one, so none is read` };
  const file = found[0];
  const checked = inspectFile(file, { under: [baseReal], cap });
  if (checked.failed === 'symlink') return { problem: `${file} is a symlink; a transcript is never read through a link` };
  if (checked.failed === 'irregular') return { problem: `${file} is not a regular file with one name` };
  if (checked.failed === 'outside') return { problem: `${file} resolves outside ${base}` };
  if (checked.failed === 'oversize') return { problem: `${file} is ${checked.size} bytes, over the ${cap}-byte cap (WF_TRANSCRIPT_MAX_BYTES)` };
  return { runtime, session, file: checked.file, size: checked.size };
}

// Opens a file without following a link and checks the descriptor, not the path: a regular file with one name.
// Returns { fd, stat }; the caller closes the descriptor.
export function openRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink > 1) {
    fs.closeSync(fd);
    throw new Error(`${file} is not a regular file with one name`);
  }
  return { fd, stat };
}

// Calls `onLine(line, number)` for every line of a transcript, read from a file opened without following a link and
// capped at the size limit (the numbers count every line, including the ones the caller skips).
export async function readLines(file, onLine) {
  const { fd, stat } = openRegular(file);
  if (stat.size === 0) {
    fs.closeSync(fd);
    return;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(null, { fd, end: Math.min(stat.size, maxTranscriptBytes()) - 1 }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) onLine(line, ++n);
}

// Every JSON line of a transcript, read whole from a file opened without following a link, up to the size cap.
export function readEntries(file) {
  const { fd, stat } = openRegular(file);
  try {
    const length = Math.min(stat.size, maxTranscriptBytes());
    const buf = Buffer.alloc(length);
    let n = 0;
    while (n < length) {
      const r = fs.readSync(fd, buf, n, length - n, n);
      if (!r) break;
      n += r;
    }
    const out = [];
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// The first JSON line of a transcript for which `pick(entry)` returns a value other than null or undefined, read in
// chunks from the start (opened without following a link) and stopping there: a session's working folder is in its first
// entries, so finding it never reads the whole file. null when no line gives one.
export function firstEntry(file, pick) {
  const { fd, stat } = openRegular(file);
  try {
    const end = Math.min(stat.size, maxTranscriptBytes());
    const chunk = Buffer.alloc(64 * 1024);
    let pos = 0;
    let rest = Buffer.alloc(0);
    const tryLine = (buf) => {
      const line = buf.toString('utf8');
      if (!line.trim()) return undefined;
      try {
        return pick(JSON.parse(line)) ?? undefined;
      } catch {
        return undefined;
      }
    };
    while (pos < end) {
      const r = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
      if (!r) break;
      pos += r;
      let buf = Buffer.concat([rest, chunk.subarray(0, r)]);
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
        const v = tryLine(buf.subarray(0, nl));
        if (v !== undefined) return v;
        buf = buf.subarray(nl + 1);
      }
      rest = Buffer.from(buf);
    }
    const v = tryLine(rest);
    return v === undefined ? null : v;
  } finally {
    fs.closeSync(fd);
  }
}
