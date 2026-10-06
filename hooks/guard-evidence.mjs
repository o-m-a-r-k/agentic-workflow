#!/usr/bin/env node
// Keeps agents' shell and file-editing tools out of agentic-workflow evidence (.wf-evidence/). It does not try to
// understand shell: it decides on the raw text. Named failures: 0.1.16 and 0.1.17 parsed commands to tell a copy OUT of
// evidence (a read) from a write INTO it, and every rule added for that opened a new parser differential.
//
// - A Bash command that mentions the evidence in any form (case-insensitive; also after removing quotes, backslashes,
//   `$'`, `${`, braces and whitespace; a glob that can match `.wf-evidence`; `evidence` next to a glob, brace or
//   variable character) is blocked, unless the whole trimmed command is exactly one `wf <subcommand> [args]` with none
//   of ; & | ` $ ( ) < > newline, backslash or quote characters. A command run with its working directory inside the
//   evidence is blocked the same way.
// - An Edit/Write/NotebookEdit target that mentions the evidence, or really lies inside it (symlinks resolved), is
//   blocked. The content written is not inspected (a closure may cite evidence paths).
// - Anything it cannot read (unparsable input, an unknown tool shape, an exception) is blocked when the input mentions
//   the evidence, and passes otherwise.
// Reading evidence is the Read tool's job (this hook does not see it); copies out are made by `wf export screenshots`.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { touchesEvidence } from '../engine/paths.mjs';

const REFUSAL = 'agentic-workflow: this touches workflow evidence. Evidence under .wf-evidence/ is written only by `wf` commands: read it with the Read tool, get screenshots out with `wf export screenshots`, and run every other `wf` command as one plain invocation.';

// Run as a hook only when executed directly; importing (tests) has no side effects.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let verdict;
    let input = '';
    try {
      // Decoded once: a multi-byte character split across chunks must not turn into replacement characters.
      input = Buffer.concat(chunks).toString('utf8');
      verdict = decide(input);
    } catch {
      verdict = mentionsEvidence(input) ? 'the hook could not judge this input' : null;
    }
    if (verdict) {
      process.stderr.write(`${REFUSAL} (${verdict})\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

const segmentsOf = (p) => String(p).split(/[\\/]+/);
const inEvidence = (p) => segmentsOf(p).some((s) => s.normalize('NFKC').replace(/[\p{Cf}\u00ad]/gu, '').toLowerCase() === '.wf-evidence');

// A path segment written as a glob (`.wf-*`, `.[w]f-evidence`, `.*`) that the shell could expand to `.wf-evidence`.
// Translated as the shell matches a glob: `*` and `?` as wildcards, a closed `[...]` as a class, an unclosed `[`
// as a literal (named false positive, 0.3.0: an unclosed `[` made an invalid regex, and the error counted as a match).
function globSegmentMatches(seg, target) {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let body = seg.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`${re}$`, 'i').test(target);
  } catch {
    return false;
  }
}
function globMatchesEvidence(token) {
  return token.split('/').some((seg) => seg.startsWith('.') && /[*?[]/.test(seg) && globSegmentMatches(seg, '.wf-evidence'));
}

// Whether text refers to the evidence in any form the shell could turn into its path.
// Unicode is folded first (NFKC: full-width and compatibility forms; zero-width and other invisible format characters
// removed), so a look-alike spelling counts too.
const fold = (text) => String(text ?? '').normalize('NFKC').replace(/[\p{Cf}\u00ad]|[\p{Cc}](?<![\n\t\r])/gu, '').toLowerCase();
// Escapes a shell or printf turns into characters: \xHH, \NNN (octal), \uHHHH, \UHHHHHHHH.
const unescape = (text) => text.replace(/\\x([0-9a-f]{1,2})|\\u([0-9a-f]{4})|\\U([0-9a-f]{8})|\\0?([0-7]{1,3})/gi, (m, x, u, U, o) => {
  try {
    return String.fromCodePoint(parseInt(x ?? u ?? U ?? o, x || u || U ? 16 : 8));
  } catch {
    return m;
  }
});

export function mentionsEvidence(text) {
  const raw = fold(text);
  if (raw.includes('wf-evidence') || fold(unescape(raw)).includes('wf-evidence')) return true;
  // A path assembled at run time: an expansion or substitution together with a part of the name (`wf-` or `.wf`, or
  // `evidence` assigned to a variable or touching an expansion). The word evidence alone in prose next to a `$` does not
  // count (named false positive, 0.3.0).
  if (/[$`]/.test(raw) && (/wf-|\.wf\b/.test(raw) || /=\s*['"]?evidence|[$`})]evidence|evidence[$`{(]/.test(raw))) return true;
  // Brace alternatives reassemble when braces and commas are dropped.
  const squeezed = raw.replace(/\$'|\$\{|[\s'"`\\{},]/g, '');
  if (squeezed.includes('wf-evidence') || squeezed.includes('wf-ev')) return true;
  // `evidence` glued to a glob or expansion character (`*evidence`, `.wf-{evidence,x}` is caught above): not a comma, a
  // brace or a bracket in prose or code (named false positive, 0.3.0: "keep evidence, ledger" was refused).
  if (/(^|[^a-z0-9])[*?$]+evidence\b|\bevidence[*?]/.test(raw.replace(/['"\\]/g, ''))) return true;
  return raw.split(/[\s;&|()<>'"`=]+/).some((t) => t && globMatchesEvidence(t));
}

// Exactly one plain `wf` invocation: nothing that chains, substitutes, redirects, quotes or escapes.
export const isPlainWf = (command) => {
  const c = String(command).trim();
  return /^wf [a-z][a-z-]*( [^\s].*)?$/.test(c) && !/[;&|`$()<>\n\r\\'"]/.test(c);
};

// The real location of a path whose ancestors may be symlinks (the nearest existing ancestor is resolved).
function real(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function check(data) {
  if (!data || typeof data !== 'object') return mentionsEvidence(JSON.stringify(data ?? '')) ? 'unreadable input' : null;
  const t = data.tool_input;
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
  const cwdInEvidence = inEvidence(cwd) || touchesEvidence(cwd);
  if (!t || typeof t !== 'object') return mentionsEvidence(JSON.stringify(data)) || cwdInEvidence ? 'unknown tool input' : null;
  // Every file target is checked whatever else the input carries (a `command` next to a `file_path` whitelists nothing).
  const files = [t.file_path, t.notebook_path, t.path, ...(Array.isArray(t.edits) ? t.edits.map((e) => e?.file_path) : [])];
  for (const file of files) {
    if (file === undefined || file === null) continue;
    if (typeof file !== 'string') return mentionsEvidence(JSON.stringify(file)) || cwdInEvidence ? 'unknown file target' : null;
    const abs = path.resolve(cwd, file.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (mentionsEvidence(file) || inEvidence(abs) || inEvidence(real(abs)) || touchesEvidence(file.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'), cwd)) return `${file} is workflow evidence`;
  }
  const bashTool = data.tool_name === undefined || data.tool_name === 'Bash';
  if (typeof t.command === 'string') {
    // A Bash command; an unexpected `command` on another tool is judged the same way, never as a whitelist.
    if (bashTool && isPlainWf(t.command)) return null;
    if (mentionsEvidence(t.command)) return 'the command mentions .wf-evidence';
    if (cwdInEvidence) return 'the command runs inside .wf-evidence';
    return null;
  }
  if (t.command !== undefined) return mentionsEvidence(JSON.stringify(t.command)) || cwdInEvidence ? 'a command that is not text' : null;
  if (files.some((f) => typeof f === 'string')) return null;
  // Neither a command nor a file target: judged on everything it carries.
  return mentionsEvidence(JSON.stringify(t)) || cwdInEvidence ? 'unknown tool input' : null;
}

export function decide(input) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return mentionsEvidence(input) ? 'unparsable input' : null;
  }
  return check(data);
}
