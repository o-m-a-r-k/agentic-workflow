// The files a shell command printed whole or in part: `cat`, `nl`, `head`, `tail`, `sed -n`, `less`, `more`, `bat`.
// A host whose agents read through the shell (Codex) shows its reads only here; a reader that also has a file tool
// (Claude Code's Read) may still use the shell. Facts of the command line only: a path is counted when a reading command
// names it, resolved against the command's working folder and any `cd` before it in the same command.
import path from 'node:path';

const READERS = new Set(['cat', 'nl', 'head', 'tail', 'sed', 'less', 'more', 'bat', 'batcat']);
// Flags of these readers that take a value (`head -n 40`, `sed -e s/a/b/`).
const VALUED = { head: ['-n', '-c'], tail: ['-n', '-c'], sed: ['-e', '-f', '-l'], bat: ['-r', '--line-range', '-l', '--language'], batcat: ['-r', '--line-range', '-l', '--language'], nl: ['-b', '-w', '-s', '-v', '-i'] };

// Words of a shell line, quotes removed; operators (`&&`, `||`, `;`, `|`, newline) as their own words.
function words(line) {
  const out = [];
  let cur = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur ??= '';
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur = (cur ?? '') + line[++i];
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      if (cur !== null) out.push(cur);
      out.push({ op: two });
      cur = null;
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '&') {
      if (cur !== null) out.push(cur);
      out.push({ op: c });
      cur = null;
      continue;
    }
    if (c === '<' || c === '>') {
      // A redirection's target is not read by the command before it (`> out`) or is read by the shell (`< in`): skip it.
      if (cur !== null) out.push(cur);
      cur = null;
      out.push({ op: 'redirect' });
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// `bash -lc "<script>"` and the like: the script is the command.
function unwrap(command) {
  if (Array.isArray(command)) {
    const [bin, ...rest] = command.map(String);
    if (/(^|\/)(ba|z)?sh$/.test(bin)) {
      const i = rest.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (i >= 0 && rest[i + 1] !== undefined) return rest[i + 1];
    }
    return command.map(String).join(' ');
  }
  return String(command ?? '');
}

// → absolute paths the command reads, in order.
export function shellReads(command, cwd) {
  const out = [];
  let dir = cwd ?? process.cwd();
  const segments = [];
  let seg = [];
  for (const w of words(unwrap(command))) {
    if (typeof w === 'object') {
      if (w.op === 'redirect') seg.push(w);
      else {
        segments.push(seg);
        seg = [];
      }
    } else seg.push(w);
  }
  segments.push(seg);
  for (const s of segments) {
    let args = [];
    for (let i = 0; i < s.length; i++) {
      if (typeof s[i] === 'object') i++; // the redirection and its target
      else args.push(s[i]);
    }
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args = args.slice(1); // VAR=value prefixes
    if (!args.length) continue;
    const bin = path.basename(args[0]);
    if (bin === 'cd') {
      if (args[1]) dir = path.resolve(dir, args[1]);
      continue;
    }
    if (/^(ba|z|da)?sh$/.test(bin)) {
      const i = args.findIndex((a, k) => k > 0 && /^-[a-z]*c$/.test(a));
      if (i > 0 && args[i + 1] !== undefined) out.push(...shellReads(args[i + 1], dir));
      continue;
    }
    if (!READERS.has(bin)) continue;
    const valued = VALUED[bin] ?? [];
    let script = bin === 'sed' && !args.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression'));
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (valued.includes(a)) {
        i++;
        continue;
      }
      if (a.startsWith('-') && a !== '-') continue;
      if (script) {
        script = false;
        continue;
      }
      if (a === '-' || /[*?]/.test(a)) continue;
      out.push(path.resolve(dir, a));
    }
  }
  return out;
}
