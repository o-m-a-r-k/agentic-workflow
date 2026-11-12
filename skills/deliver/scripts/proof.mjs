#!/usr/bin/env node
// proof: runs one command in a worktree and appends what happened to evidence/proof.jsonl, a line for each row it proves.
// Usage: node proof.mjs <ticket-folder> --in <worktree> [--test T<n>[,T<n>...]] [--base] -- <command> [args...]
//   --in    the worktree or lane, by the name STATE.md gives it ("Worktree <repo>: <path>" or "Lane <name>: <path>")
//   --test  the tests rows this run proves, a line for each; --base when the tree is the base with only tests changed
// A line records the command's exact words, the test, the repository (its shared git folder), the worktree, HEAD, the
// tree of the working files as they were (tracked and untracked, ignored files left out), base, the exit code (null
// when it never ran) and the output's last lines. Later scripts compare that tree with the base and with HEAD, by the
// rules in ticket.mjs. Building it adds the files' blobs to the repo's object store, as `git add` would; nothing else in
// git changes. It never judges; it exits 0 once the lines are written, and 2 on a usage error.
import { existsSync, appendFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { ticket, vals, spawnArgs } from './ticket.mjs';

const args = process.argv.slice(2);
const cut = args.indexOf('--');
const opts = cut < 0 ? args : args.slice(0, cut);
const command = cut < 0 ? [] : args.slice(cut + 1);
const dir = resolve(opts[0] || '.');
const name = vals(opts, '--in')[0];
const tests = vals(opts, '--test')[0]?.split(',') || [];
const base = opts.includes('--base');
const usage = (why) => {
  console.error(`proof: ${why}\nusage: node proof.mjs <ticket-folder> --in <worktree> [--test T<n>[,T<n>...]] [--base] -- <command> [args...]`);
  process.exit(2);
};
if (!command.length) usage('no command after --');
if (!name) usage('no --in <worktree>');
for (const t of tests) if (!/^T\d+$/.test(t)) usage(`--test ${t} is not T<n>`);
const w = ticket(dir).worktrees[name];
if (!w) usage(`STATE.md has no "Worktree ${name}:" or "Lane ${name}:" line`);
if (!w.path) usage(`the worktree ${name} does not exist`);
const cwd = w.path;
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
const s = spawnArgs(command);
const run = s.error ? { error: new Error(s.error) } : spawnSync(s.argv[0], s.argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...s.env }, windowsVerbatimArguments: !!s.verbatim });
const output = `${run.stdout || ''}${run.stderr || ''}${run.error ? `\n${run.error.message}` : ''}`;
const exit = run.error ? null : typeof run.status === 'number' ? run.status : null; // null: it never ran, or a signal ended it
const tail = output.replace(/\n$/, '').split('\n').slice(-40).join('\n');
mkdirSync(join(dir, 'evidence'), { recursive: true });
for (const test of tests.length ? tests : [null])
  appendFileSync(join(dir, 'evidence', 'proof.jsonl'), JSON.stringify({ time: new Date().toISOString(), argv: command, test, in: name, repository: w.repository, worktree: cwd, head: w.head, tree, base, exit, error: run.error ? run.error.message : run.signal || null, log: tail }) + '\n');
console.log(tail);
console.log(`proof: ${tests.join(',') || '-'} exit ${exit} on ${base ? 'base' : 'change'} tree ${tree.slice(0, 12)} (HEAD ${w.head.slice(0, 12)})`);
