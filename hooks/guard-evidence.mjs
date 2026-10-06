#!/usr/bin/env node
// Blocks writes to agentic-workflow evidence (.wf-evidence/). Every write target is resolved against the
// session's working directory and any `cd`/`pushd` earlier in the same command, so relative paths are caught.
// Commands run through wrappers (sudo, env, xargs, timeout ...), `sh -c`, `eval` and `find -exec` are checked too, as
// are targets built by expansion, globs that can match `.wf-evidence`, and symlinks that point into it.
// Reads (cat, grep, ls, cp/install/rsync out of evidence, copies whose literal destination is outside it, `python3 -c`/`node -e` code that only reads) and redirections elsewhere
// (2>/dev/null) are allowed. Interpreter code that writes, deletes, opens for writing or runs a shell is blocked.
// Inert outside projects that have `.wf-evidence/`.
import fs from 'node:fs';
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

const WRITERS = new Set(['tee', 'rm', 'mv', 'truncate', 'dd', 'touch', 'ln', 'chmod', 'rmdir', 'mkdir', 'shred', 'unlink']);

// Copy destinations, parsed as getopt does (option clusters, attached values, `--`), per verb. Copying FROM evidence
// is a read; a destination, a target directory, a directory to create, or a file an option writes (rsync --log-file,
// --backup-dir, --temp-dir ...) inside it is a write. Named failure: copying delivered screenshots out of .wf-evidence/
// to show them was refused; 0.1.16's first parser then let `install --directory` and `install -dm755` into evidence.
const COPY_OPTS = {
  cp: { short: { t: 'target', S: 'value' }, long: { 'target-directory': 'target', suffix: 'value' } },
  install: { short: { t: 'target', m: 'value', o: 'value', g: 'value', S: 'value', B: 'value', f: 'value' }, long: { 'target-directory': 'target', mode: 'value', owner: 'value', group: 'value', suffix: 'value', directory: 'dirs' }, dirs: 'd' },
  rsync: {
    short: { e: 'value', f: 'value', T: 'target', B: 'value', M: 'value', '@': 'value' },
    long: Object.fromEntries([
      ...['rsh', 'exclude', 'include', 'filter', 'exclude-from', 'include-from', 'files-from', 'log-file-format', 'suffix', 'compare-dest', 'copy-dest', 'link-dest', 'chmod', 'chown', 'usermap', 'groupmap', 'timeout', 'contimeout', 'port', 'password-file', 'out-format', 'max-size', 'min-size', 'bwlimit', 'block-size', 'modify-window', 'iconv', 'read-batch', 'skip-compress', 'remote-option', 'sockopts', 'protocol', 'checksum-choice', 'compress-choice', 'compress-level', 'max-delete', 'max-alloc', 'info', 'debug', 'stop-after', 'stop-at', 'outbuf', 'address', 'rsync-path'].map((k) => [k, 'value']),
      ...['log-file', 'backup-dir', 'temp-dir', 'partial-dir', 'write-batch', 'only-write-batch'].map((k) => [k, 'target']),
    ]),
  },
  ditto: { short: {}, long: { arch: 'value', bom: 'value' } },
};

export function copyTargets(verb, args) {
  const spec = COPY_OPTS[verb];
  const targets = [];
  const operands = [];
  let explicit = false;
  let dirs = false;
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOpts || !a.startsWith('-') || a === '-') {
      // An operand right before an option may be the destination of a permuting parser (`src dest --opt value`).
      operands.push({ a, beforeOption: !endOpts && i + 1 < args.length && args[i + 1].startsWith('-') && args[i + 1] !== '-' });
      continue;
    }
    if (a === '--') {
      endOpts = true;
      continue;
    }
    if (a.startsWith('--')) {
      const [name, eq] = a.slice(2).split(/=(.*)/s);
      const kind = spec.long[name];
      if (kind === 'dirs') dirs = true;
      else if (kind) {
        const v = eq !== undefined ? eq : args[++i];
        if (kind === 'target' && v !== undefined) {
          targets.push(v);
          if (name === 'target-directory') explicit = true;
        }
      }
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (spec.dirs && ch === spec.dirs) dirs = true;
      const kind = spec.short[ch];
      if (!kind) continue;
      const v = k + 1 < a.length ? a.slice(k + 1) : args[++i];
      if (kind === 'target' && v !== undefined) {
        targets.push(v);
        if (ch === 't') explicit = true;
      }
      break;
    }
  }
  const local = operands.filter((o) => !(verb === 'rsync' && /^[^/]*:/.test(o.a)));
  if (dirs) return [...targets, ...local.map((o) => o.a)];
  if (!explicit && local.length >= 2) targets.push(local.at(-1).a, ...local.slice(0, -1).filter((o) => o.beforeOption).map((o) => o.a));
  return targets;
}

const INTERPRETER = /^(node|python3?|ruby|perl|deno|bun)$/;

// Calls that change files or hand work to a shell, in the languages the interpreters above run. Conservative:
// anything here counts as a write. Pure reads (open for reading, readFile, json.load, glob, print) do not match.
const MUTATORS = /\b(writeFile|appendFile|createWriteStream|write_text|write_bytes|unlink|rename|rmSync|rmdir|removedirs|truncate|copyFile|cpSync|mkdir|makedirs|symlink|chmod|chown|utimes|touch|popen|system|execSync|execFileSync|spawnSync|spawn|exec)(?:Sync)?\s*\(|\b(shutil|subprocess|child_process|FileUtils)\b|\bos\.(remove|replace|link)\b|\b(File|IO)\.(write|delete|unlink|rename|binwrite)\b|\bDeno\.(write|remove|rename|create|truncate|mkdir|copy)|\bBun\.write\b|\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|\bsyswrite\b/;

const READ_MODE = /^(?:[rbtU]{1,3}|<(?![<>])[^>|]*)$/;
const isWriteMode = (v) => (/^[rwxabtU+]{1,4}$/.test(v) && /[wax+]/.test(v)) || /^\s*(\+?>|\+<|\|)/.test(v) || /\|\s*$/.test(v);
const literal = (a) => /^(['"`])([\s\S]*)\1$/.exec(a)?.[2];
// A destination that is certainly this text: one plain quoted string, no escapes, no interpolation, no concatenation.
const strictLiteral = (a) => {
  const m = /^'([^'\\]*)'$|^"([^"\\$#]*)"$/.exec(String(a ?? '').trim());
  return m ? (m[1] ?? m[2]) : undefined;
};

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

// A copy whose destination is a plain literal outside evidence reads the evidence; it is not a write. Not when the
// code changes directory (a relative destination would then land elsewhere). Named failures in 0.1.16: a ternary or a
// template literal passed as "a literal"; `import shutil as s` stripped, leaving `s.rmtree` unseen.
const COPY_CALL = /\b(?:shutil\.(?:copy2?|copyfile|copytree)|(?:fs\.(?:promises\.)?)?(?:copyFileSync|copyFile|cpSync))\s*\(/g;
const CHDIR = /\bchdir\b|\bcwd\s*[=:]|\bDir\.chdir\b/;
function withoutReadCopies(code, cwd) {
  if (CHDIR.test(code)) return code;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(COPY_CALL)) {
    const dest = strictLiteral(callArgs(code, m.index + m[0].length)[1]);
    if (dest === undefined || dest === '' || targetInEvidence(dest, { cwd: cwd ?? process.cwd(), mentions: true })) continue;
    out += `${code.slice(last, m.index)}__read_copy(`;
    last = m.index + m[0].length;
  }
  out += code.slice(last);
  // `import shutil` is dropped only as that exact statement and only when no other use of shutil remains.
  const stripped = out.replace(/(^|[\s;])import\s+shutil\s*(?=;|\n|$)/g, '$1');
  return /\bshutil\b/.test(stripped) ? out : stripped;
}

export function interpreterWrites(rawCode, cwd) {
  const code = withoutReadCopies(rawCode, cwd);
  if (MUTATORS.test(code)) return true;
  const re = /\bopen(?:Sync)?\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) if (openWrites(callArgs(code, m.index + m[0].length))) return true;
  return false;
}

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

const globSegment = (seg) => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\\\[/g, '[')}$`);
// Whether a write target can be evidence. A target built by expansion ($VAR, $(...), backticks) is unknown: it counts
// when the command mentions the evidence or runs inside it. A glob counts when a segment can match `.wf-evidence`
// (a dotfile matches only a segment that starts with a literal dot). A symlinked path counts by where it points.
export function targetInEvidence(p, ctx) {
  const raw = String(p ?? '');
  if (!raw) return false;
  // `$(echo .wf-evidence)/a` splits into words at the space: a parenthesis left in a word marks it as expansion too.
  if (/[$`()]/.test(raw)) return ctx.mentions || inEvidence(ctx.cwd);
  const expanded = raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  if (expanded.split('/').some((seg) => seg.startsWith('.') && /[*?[]/.test(seg) && globSegment(seg).test('.wf-evidence'))) return true;
  const abs = path.resolve(ctx.cwd, expanded);
  return inEvidence(abs) || inEvidence(real(abs));
}

// Prefixes that run the rest of the line as a command, and how many option values they take.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', 'time', 'exec', 'command', 'builtin', 'nohup', 'noglob']);
const WRAPPERS = { sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D', '-T']), env: new Set(['-u', '-C', '-P', '-S']), nice: new Set(['-n']), stdbuf: new Set(['-i', '-o', '-e']), timeout: new Set(['-s', '-k', '--signal', '--kill-after']), xargs: new Set(['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a', '-e', '-i', '-l']), doas: new Set(['-u', '-C']) };
const SHELLS = /^(ba|z|da|k|fi)?sh$/;

function unwrap(words) {
  let w = [...words];
  for (let guard = 0; guard < 20 && w.length; guard++) {
    // A subshell or group opened on the same word: `(cd x`, `{rm`.
    if (/^[({]./.test(w[0])) w[0] = w[0].slice(1);
    if (KEYWORDS.has(w[0]) || /^[A-Za-z_]\w*=/.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const opts = WRAPPERS[w[0]];
    if (!opts) break;
    const verb = w[0];
    let i = 1;
    while (i < w.length && (w[i].startsWith('-') || (verb === 'env' && /^[A-Za-z_]\w*=/.test(w[i])))) {
      if (opts.has(w[i])) i += 1;
      i += 1;
    }
    if (verb === 'timeout' && i < w.length) i += 1; // the duration
    w = w.slice(i);
  }
  return w;
}

function checkWords(words, ctx, depth) {
  const unwrapped = unwrap(words);
  if (!unwrapped.length) return null;
  const [verb, ...args] = unwrapped;
  const resolve = (p) => path.resolve(ctx.cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  const hit = (p) => targetInEvidence(p, ctx);
  if (verb === 'cd' || verb === 'pushd') {
    const to = args.find((a) => !a.startsWith('-'));
    ctx.cwd = to && /[$`]/.test(to) ? (ctx.mentions ? path.join(ctx.cwd, '.wf-evidence') : ctx.cwd) : resolve(to ?? process.env.HOME ?? ctx.cwd);
    return null;
  }
  // A command string run by a shell, eval, or find -exec is checked as a command of its own.
  if (depth < 4) {
    if (SHELLS.test(verb)) {
      const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (c >= 0 && args[c + 1] !== undefined) {
        const r = checkCommand(args[c + 1], { ...ctx }, depth + 1);
        if (r) return r;
      }
    }
    if (verb === 'eval') {
      const r = checkCommand(args.join(' '), { ...ctx }, depth + 1);
      if (r) return r;
    }
    if (verb === 'find') {
      for (let i = 0; i < args.length; i++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) continue;
        const end = args.findIndex((a, k) => k > i && (a === ';' || a === '+' || a === '\;'));
        const r = checkWords(args.slice(i + 1, end < 0 ? undefined : end), { ...ctx }, depth + 1);
        if (r) return r;
      }
    }
  }
  const plain = args.filter((a) => !a.startsWith('-') && !/^&?[<>]/.test(a));
  if (WRITERS.has(verb) && plain.some((a) => hit(a.replace(/^of=/, '')))) return 'this command writes to workflow evidence';
  if (verb === 'dd' && args.some((a) => a.startsWith('of=') && hit(a.slice(3)))) return 'this command writes to workflow evidence';
  if (verb === 'sed' && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a)) && plain.some((a) => hit(a))) return 'this command edits workflow evidence';
  if (COPY_OPTS[verb] && copyTargets(verb, args).some((a) => hit(a))) return 'this command copies into workflow evidence';
  if (INTERPRETER.test(verb)) {
    if (/^(ruby|perl)$/.test(verb) && args.some((a) => /^-[a-zA-Z]*i/.test(a)) && (inEvidence(ctx.cwd) || plain.some((a) => hit(a)))) return 'this command edits workflow evidence';
    if (args.some((a) => /^-[a-zA-Z]*[ec]$/.test(a) || a === '-p' || a === '--eval')) {
      const code = args.join(' ');
      if ((code.includes('.wf-evidence') || inEvidence(ctx.cwd)) && interpreterWrites(code, ctx.cwd)) return 'this command writes to workflow evidence';
    }
  }
  return null;
}

function checkCommand(cmd, ctx, depth = 0) {
  for (const words of segments(cmd)) {
    // Redirection targets: > file, >> file, &> file. File descriptors (2>&1) and /dev/* are not files.
    for (let i = 0; i < words.length; i++) {
      if (/^&?>>?\|?$/.test(words[i]) && words[i + 1] && !words[i + 1].startsWith('&') && !words[i + 1].startsWith('/dev/')) {
        if (targetInEvidence(words[i + 1], ctx)) return 'this command writes to workflow evidence';
      }
    }
    // Redirections are not arguments: `xargs cp {} dest < list` copies to dest, not to list.
    const argv = [];
    for (let i = 0; i < words.length; i++) {
      if (/^&?\d*[<>]/.test(words[i])) {
        if (/^&?\d*[<>]+&?\|?$/.test(words[i])) i += 1;
        continue;
      }
      argv.push(words[i]);
    }
    const r = checkWords(argv, ctx, depth);
    if (r) return r;
  }
  return null;
}

export function check(data) {
  const t = data.tool_input ?? {};
  const cwd = data.cwd || process.cwd();
  const file = t.file_path ?? t.notebook_path ?? '';
  if (file && targetInEvidence(file, { cwd, mentions: false })) return `${file} is workflow evidence`;
  const cmd = typeof t.command === 'string' ? t.command : '';
  if (!cmd) return null;
  return checkCommand(cmd, { cwd, mentions: /wf-evidence/.test(cmd) || inEvidence(cwd) });
}
