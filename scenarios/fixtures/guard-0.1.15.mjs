#!/usr/bin/env node
// FROZEN COPY of the 0.1.15 hook, the baseline the current guard must never be more permissive than. Do not edit.
// Blocks writes to agentic-workflow evidence (.wf-evidence/). Every write target is resolved against the
// session's working directory and any `cd`/`pushd` earlier in the same command, so relative paths are caught.
// Reads (cat, grep, ls, cp out of evidence, `python3 -c`/`node -e` code that only reads) and redirections elsewhere
// (2>/dev/null) are allowed. Interpreter code that writes, deletes, opens for writing or runs a shell is blocked.
// Inert outside projects that have `.wf-evidence/`.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run as a hook only when executed directly; importing (tests) has no side effects.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      process.exit(0);
    }
    const verdict = check(data);
    if (verdict) {
      process.stderr.write(`agentic-workflow: ${verdict}. Evidence under .wf-evidence/ is written only by \`wf\` commands; use the matching wf command.\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

const inEvidence = (p) => p.split(/[\\/]+/).includes('.wf-evidence');

// Splits a shell command into segments and words. Handles quotes, escapes, `&&`, `||`, `;`, `|`, newlines.
export function segments(command) {
  const out = [];
  let words = [];
  let word = '';
  let quote = null;
  let hasWord = false;
  const pushWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const pushSeg = () => {
    pushWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
    } else if (/\s/.test(c)) {
      if (c === '\n') pushSeg();
      else pushWord();
    } else if (c === ';' || c === '|' || c === '&') {
      pushSeg();
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
    } else if (c === '>' || c === '<') {
      pushWord();
      let op = c;
      while (command[i + 1] === '>' || command[i + 1] === '&' || command[i + 1] === '|') op += command[++i];
      words.push(op);
    } else {
      word += c;
      hasWord = true;
    }
  }
  pushSeg();
  return out;
}

const WRITERS = new Set(['tee', 'rm', 'mv', 'truncate', 'dd', 'install', 'touch', 'ln', 'chmod', 'rmdir', 'mkdir', 'shred', 'unlink']);

const INTERPRETER = /^(node|python3?|ruby|perl|deno|bun)$/;

// Calls that change files or hand work to a shell, in the languages the interpreters above run. Conservative:
// anything here counts as a write. Pure reads (open for reading, readFile, json.load, glob, print) do not match.
const MUTATORS = /\b(writeFile|appendFile|createWriteStream|write_text|write_bytes|unlink|rename|rmSync|rmdir|removedirs|truncate|copyFile|cpSync|mkdir|makedirs|symlink|chmod|chown|utimes|touch|popen|system|execSync|execFileSync|spawnSync|spawn|exec)(?:Sync)?\s*\(|\b(shutil|subprocess|child_process|FileUtils)\b|\bos\.(remove|replace|link)\b|\b(File|IO)\.(write|delete|unlink|rename|binwrite)\b|\bDeno\.(write|remove|rename|create|truncate|mkdir|copy)|\bBun\.write\b|\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|\bsyswrite\b/;

const READ_MODE = /^(?:[rbtU]{1,3}|<(?![<>])[^>|]*)$/;
const isWriteMode = (v) => (/^[rwxabtU+]{1,4}$/.test(v) && /[wax+]/.test(v)) || /^\s*(\+?>|\+<|\|)/.test(v) || /\|\s*$/.test(v);
const literal = (a) => /^(['"`])([\s\S]*)\1$/.exec(a)?.[2];

// Top-level arguments of the call whose opening parenthesis ends at `start`.
function callArgs(code, start) {
  const args = [];
  let depth = 0;
  let cur = '';
  let q = null;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (q) {
      cur += c;
      if (c === '\\') cur += code[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  args.push(cur.trim());
  return args.filter(Boolean);
}

// open()/openSync()/File.open(): a read unless a mode or flag says otherwise. A mode that is not a literal
// counts as a write.
function openWrites(args) {
  const positional = [];
  for (const a of args) {
    const kw = /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (kw) {
      if (['mode', 'flags', 'flag'].includes(kw[1]) && !READ_MODE.test(literal(kw[2]) ?? '\0')) return true;
      continue;
    }
    positional.push(a);
  }
  for (const a of positional) {
    if (!a.startsWith('{') || !/\bflags?\s*:/.test(a)) continue;
    const f = /\bflags?\s*:\s*(['"`])([^'"`]*)\1/.exec(a);
    if (!f || !READ_MODE.test(f[2])) return true;
  }
  const lits = positional.map(literal);
  if (lits.some((v) => v !== undefined && isWriteMode(v))) return true;
  if (positional.length <= 1) return false;
  return !lits.some((v) => v !== undefined && READ_MODE.test(v));
}

export function interpreterWrites(code) {
  if (MUTATORS.test(code)) return true;
  const re = /\bopen(?:Sync)?\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) if (openWrites(callArgs(code, m.index + m[0].length))) return true;
  return false;
}

export function check(data) {
  const t = data.tool_input ?? {};
  let cwd = data.cwd || process.cwd();
  const file = t.file_path ?? t.notebook_path ?? '';
  if (file && inEvidence(path.resolve(cwd, file))) return `${file} is workflow evidence`;
  const cmd = typeof t.command === 'string' ? t.command : '';
  if (!cmd) return null;
  const resolve = (p) => path.resolve(cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  for (const words of segments(cmd)) {
    const [verb, ...args] = words;
    if (verb === 'cd' || verb === 'pushd') {
      cwd = resolve(args.find((a) => !a.startsWith('-')) ?? process.env.HOME ?? cwd);
      continue;
    }
    // Redirection targets: > file, >> file, &> file. File descriptors (2>&1) and /dev/* are not files.
    for (let i = 0; i < words.length; i++) {
      if (/^&?>>?\|?$/.test(words[i]) && words[i + 1] && !words[i + 1].startsWith('&') && !words[i + 1].startsWith('/dev/')) {
        if (inEvidence(resolve(words[i + 1]))) return 'this command writes to workflow evidence';
      }
    }
    const plain = args.filter((a) => !a.startsWith('-') && !/^&?[<>]/.test(a));
    if (WRITERS.has(verb) && plain.some((a) => inEvidence(resolve(a.replace(/^of=/, ''))))) return 'this command writes to workflow evidence';
    if (verb === 'dd' && args.some((a) => a.startsWith('of=') && inEvidence(resolve(a.slice(3))))) return 'this command writes to workflow evidence';
    if (verb === 'sed' && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a)) && plain.some((a) => inEvidence(resolve(a)))) return 'this command edits workflow evidence';
    if ((verb === 'cp' || verb === 'rsync') && plain.length >= 2 && inEvidence(resolve(plain.at(-1)))) return 'this command copies into workflow evidence';
    if (INTERPRETER.test(verb)) {
      if (/^(ruby|perl)$/.test(verb) && args.some((a) => /^-[a-zA-Z]*i/.test(a)) && (inEvidence(cwd) || plain.some((a) => inEvidence(resolve(a))))) return 'this command edits workflow evidence';
      if (args.some((a) => /^-[a-zA-Z]*[ec]$/.test(a) || a === '-p' || a === '--eval')) {
        const code = args.join(' ');
        if ((code.includes('.wf-evidence') || inEvidence(cwd)) && interpreterWrites(code)) return 'this command writes to workflow evidence';
      }
    }
  }
  return null;
}
