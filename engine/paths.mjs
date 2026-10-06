// One canonical answer to "where is this path, really" and "is it in the evidence", used by the engine, the CLI's
// option checks, export, release and the guard hook. Named finding (0.1.22 review): callers disagreed with the OS:
// lexical `..` (path.resolve) where the OS follows a link first, a prefix test that took `.wf-evidence-x` for
// `.wf-evidence`, case and Unicode forms on case-insensitive volumes, trailing slashes and `.` components.
import fs from 'node:fs';
import path from 'node:path';

// Case-insensitive volumes, detected per device on an existing folder (macOS APFS and HFS+ by default; Windows).
const insensitiveByDev = new Map();
function caseInsensitive(existing) {
  let st;
  try {
    st = fs.statSync(existing);
  } catch {
    return process.platform === 'darwin' || process.platform === 'win32';
  }
  if (insensitiveByDev.has(st.dev)) return insensitiveByDev.get(st.dev);
  const base = path.basename(existing);
  const flipped = base.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  let r = process.platform === 'darwin' || process.platform === 'win32';
  if (flipped !== base) {
    try {
      const o = fs.statSync(path.join(path.dirname(existing), flipped));
      r = o.ino === st.ino && o.dev === st.dev;
    } catch {
      r = false;
    }
  }
  insensitiveByDev.set(st.dev, r);
  return r;
}

// Invisible format characters dropped and compatibility forms folded, for comparing names.
const foldName = (s, insensitive) => {
  const n = String(s).normalize('NFC').replace(/[\p{Cf}­]/gu, '');
  return insensitive ? n.toLowerCase() : n;
};

// The path as the OS resolves it: components taken in order, a link at any existing component followed before the next
// (so `link/..` is the link target's parent, as the kernel does), `.` dropped, trailing separators ignored, the existing
// part in its on-disk case and Unicode form (realpath native), the rest kept as given.
export function canonical(p, cwd = process.cwd()) {
  const abs = path.isAbsolute(String(p)) ? String(p) : path.join(cwd, String(p));
  const parts = abs.split(/[\\/]+/).filter((x) => x !== '');
  let cur = path.parse(abs).root || path.sep;
  let exists = true;
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, part);
    if (exists) {
      try {
        cur = fs.realpathSync.native(next);
        continue;
      } catch {
        exists = false;
      }
    }
    cur = next;
  }
  return cur;
}

// The nearest existing ancestor of a canonical path (whose volume decides case sensitivity).
function existingAncestor(c) {
  let cur = c;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

// Whether `child` is `parent` or below it, both resolved by `canonical`, compared name by name (separator-bounded:
// `.wf-evidence-x` is not inside `.wf-evidence`), case-folded on a case-insensitive volume.
export function isInside(child, parent, cwd = process.cwd()) {
  const c = canonical(child, cwd);
  const pp = canonical(parent, cwd);
  const insensitive = caseInsensitive(existingAncestor(pp));
  const cs = c.split(path.sep).filter(Boolean).map((x) => foldName(x, insensitive));
  const ps = pp.split(path.sep).filter(Boolean).map((x) => foldName(x, insensitive));
  return ps.length <= cs.length && ps.every((x, i) => cs[i] === x);
}

const EVIDENCE = '.wf-evidence';
const isEvidenceName = (name) => foldName(String(name).normalize('NFKC'), true) === EVIDENCE;

// Whether a path lies in any project's evidence: a `.wf-evidence` component in the path as written (conservative) or
// as the OS resolves it (links followed). Case and Unicode forms are folded either way.
export function touchesEvidence(p, cwd = process.cwd()) {
  const raw = String(p ?? '');
  if (raw.split(/[\\/]+/).some(isEvidenceName)) return true;
  return canonical(raw, cwd).split(path.sep).some(isEvidenceName);
}
