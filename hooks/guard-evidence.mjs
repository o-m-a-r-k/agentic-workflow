#!/usr/bin/env node
// Blocks writes to agentic-workflow evidence (.wf-evidence/). Every write target is resolved against the
// session's working directory and any `cd`/`pushd` earlier in the same command, so relative paths are caught.
// Reads (cat, grep, ls, cp out of evidence) and redirections elsewhere (2>/dev/null) are allowed.
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
    if (/^(node|python3?|ruby|perl|deno|bun)$/.test(verb) && args.some((a) => /^-[ecp]$/.test(a) || a === '--eval')) {
      const code = args.join(' ');
      const writes = /(writeFile|appendFile|createWriteStream|open\(|unlink|rename|rmSync|truncate)/.test(code);
      if (writes && (code.includes('.wf-evidence') || inEvidence(cwd))) return 'this command writes to workflow evidence';
    }
  }
  return null;
}
