// `wf evidence list|show` (I-16): read an attempt's evidence without naming its folder in any shell command. Named
// failure: agents reached for `cat`, `ls` or `grep` on evidence paths, the guard refused them (it decides on the raw text
// and never parses shell), and they split commands or switched tools by trial. These commands write nothing of their
// own (opening the attempt runs the usual evidence verification, as every `wf` command does); the attempt folder and
// each file are refused when they are links, each file is opened with O_NOFOLLOW and must have one name, only paths
// inside this attempt's evidence are read, and at most MAX_SHOW_BYTES are read. Images are not printed: `wf export screenshots` copies them out, sha256-checked.
import fs from 'node:fs';
import path from 'node:path';
import { attemptDir } from './ledger.mjs';
import { isInside } from './paths.mjs';
import { WfError, refuse } from './util.mjs';

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
export const MAX_SHOW_BYTES = 4 * 1024 * 1024;

// The kind of an evidence file, from its path inside the attempt folder.
export function kindOf(rel) {
  const [top] = rel.split('/');
  if (IMAGE.test(rel)) return 'screenshot';
  if (rel === 'ledger.jsonl') return 'ledger';
  if (top === 'plans') return 'plan';
  if (top === 'handoffs') return 'handoff';
  if (top === 'review') return 'review';
  if (top === 'gate' || top === 'checks') return /\.(log|txt|out)$/i.test(rel) ? 'gate log' : 'gate record';
  if (top === 'tracker') return 'tracker';
  if (top === 'delivery') return 'delivery';
  if (top === 'issue') return 'issue';
  return 'other';
}

function walk(dir, rel, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile()) out.push({ path: r, file: abs, kind: kindOf(r), size: fs.lstatSync(abs).size });
    else out.push({ path: r, file: abs, kind: 'not a regular file (not read)', size: null });
  }
}

function attemptFolder(root, state) {
  const dir = attemptDir(root, state.id);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw refuse(`${dir} is not a real folder (a link or missing); nothing is read through it`);
  return dir;
}

export function listEvidence(root, state, { kind = null } = {}) {
  const dir = attemptFolder(root, state);
  const files = [];
  walk(dir, '', files);
  return { attempt: state.id, dir, files: kind ? files.filter((f) => f.kind === kind) : files };
}

export function showEvidence(root, state, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new WfError(`usage: wf evidence show <path> --attempt ${state.id} (a path from \`wf evidence list\`)`);
  const dir = fs.realpathSync.native(attemptFolder(root, state));
  // Named failure I-45: native roles receive absolute bundle/rule paths, but the sanctioned reader rejected them.
  if (rel.split(/[\\/]/).includes('..')) throw refuse(`${rel}: give a path inside this attempt's evidence, relative to it, as \`wf evidence list --attempt ${state.id}\` prints it`);
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.join(dir, rel);
  if (!abs.startsWith(dir + path.sep)) throw refuse('give an evidence file inside the selected attempt; cross-attempt and outside reads are refused');
  let parent;
  try {
    parent = fs.realpathSync.native(path.dirname(abs));
  } catch {
    throw refuse(`${rel}: no such evidence file in ${state.id}`);
  }
  if (!(parent === dir || isInside(parent, dir))) throw refuse(`${rel}: give a path inside this attempt's evidence, relative to it`);
  if (IMAGE.test(rel)) throw refuse(`${rel} is an image: copy it out with \`wf export screenshots --gate --attempt ${state.id} --to <folder>\` (the gate's set; without --gate, the delivered set) and view the copy with the Read tool`);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) throw refuse(`${rel}: no such evidence file in ${state.id}`);
  if (st.isSymbolicLink() || !st.isFile()) throw refuse(`${rel} is not a regular file; nothing is read through it`);
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw refuse(`${rel} could not be opened without following a link; nothing is read through it`);
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1) throw refuse(`${rel} is not a regular file with one name; nothing is read through it`);
    const buf = Buffer.alloc(Math.min(fst.size, MAX_SHOW_BYTES));
    let n = 0;
    while (n < buf.length) {
      const k = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!k) break;
      n += k;
    }
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) throw refuse(`${rel} is binary; it is not printed`);
    return { path: rel, file: abs, size: fst.size, truncated: fst.size > MAX_SHOW_BYTES, text: bytes.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}
