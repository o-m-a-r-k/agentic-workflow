#!/usr/bin/env node
// proof: runs one command in a worktree and appends what happened to evidence/proof.jsonl.
// Usage: node proof.mjs <ticket-folder> --in <repo> [--test T<n>] [--base] -- <command> [args...]
//   --in    the worktree, by the repo name STATE.md gives it ("Worktree <repo>: <path>")
//   --test  the tests row this run proves; --base when the tree is the base with only the test applied
// The line records the command, the test, the worktree, HEAD, the tree of the working files as they were
// (tracked and untracked, ignored files left out), base, the exit code (null when it never ran) and the output's last lines.
// Building that tree adds the files' blobs to the repo's object store, as `git add` would; nothing else in git changes.
// It never judges; it exits 0 once the line is written, whatever the command's exit, and 2 on a usage error.
import { readFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const cut = args.indexOf('--');
const opts = cut < 0 ? args : args.slice(0, cut);
const command = cut < 0 ? [] : args.slice(cut + 1);
const dir = resolve(opts[0] || '.');
const opt = (k) => (opts.includes(k) ? opts[opts.indexOf(k) + 1] : null);
const repo = opt('--in');
const test = opt('--test');
const base = opts.includes('--base');
const usage = (why) => {
  console.error(`proof: ${why}\nusage: node proof.mjs <ticket-folder> --in <repo> [--test T<n>] [--base] -- <command> [args...]`);
  process.exit(2);
};
if (!command.length) usage('no command after --');
if (!repo) usage('no --in <repo>');
if (test && !/^T\d+$/.test(test)) usage(`--test ${test} is not T<n>`);
const state = existsSync(join(dir, 'STATE.md')) ? readFileSync(join(dir, 'STATE.md'), 'utf8') : '';
const m = state.match(new RegExp(`^Worktree ${repo.replace(/[.]/g, '\\.')}:[ \\t]*(\\S+)`, 'm'));
if (!m) usage(`STATE.md has no "Worktree ${repo}:" line`);
if (!existsSync(resolve(dir, m[1]))) usage(`worktree ${m[1]} does not exist`);
const cwd = realpathSync(resolve(dir, m[1]));
const git = (a, env) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// The tree of the working files: a copy of the index takes every change, so the real index is untouched.
const index = resolve(cwd, git(['rev-parse', '--git-path', 'index']));
const temp = join(tmpdir(), `proof-index-${process.pid}-${Date.now()}`);
let tree;
try {
  if (existsSync(index)) copyFileSync(index, temp);
  git(['add', '-A'], { GIT_INDEX_FILE: temp });
  tree = git(['write-tree'], { GIT_INDEX_FILE: temp });
} finally {
  rmSync(temp, { force: true });
}
const head = git(['rev-parse', 'HEAD']);

// On Windows a runner such as npm is a .cmd file, which Node starts only through cmd.exe; checks has already refused
// shell operators in the words.
const winArgv = (argv) => {
  if (process.platform !== 'win32' || /[\\/]|\.\w+$/.test(argv[0])) return argv;
  for (const dir of (process.env.PATH || '').split(';')) for (const e of (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';'))
    if (dir && existsSync(join(dir, argv[0] + e))) return /\.(cmd|bat)$/i.test(e) ? [process.env.ComSpec || 'cmd.exe', '/d', '/c', ...argv] : [join(dir, argv[0] + e), ...argv.slice(1)];
  return argv;
};
const argv = winArgv(command);
const run = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const output = `${run.stdout || ''}${run.stderr || ''}${run.error ? `\n${run.error.message}` : ''}`;
const exit = run.error ? null : typeof run.status === 'number' ? run.status : null; // null: it never ran, or a signal ended it
const tail = output.replace(/\n$/, '').split('\n').slice(-40).join('\n');
const line = { time: new Date().toISOString(), command: command.join(' '), test, in: repo, worktree: cwd, head, tree, base, exit, error: run.error ? run.error.message : run.signal || null, log: tail };
mkdirSync(join(dir, 'evidence'), { recursive: true });
appendFileSync(join(dir, 'evidence', 'proof.jsonl'), JSON.stringify(line) + '\n');
console.log(tail);
console.log(`proof: ${test || '-'} exit ${exit} on ${base ? 'base' : 'change'} tree ${tree.slice(0, 12)} (HEAD ${head.slice(0, 12)})`);
