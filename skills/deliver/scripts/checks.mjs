#!/usr/bin/env node
// checks: runs the runnable checks due for a delivery and compares each output with its expect.
// Usage: node checks.mjs <ticket-folder> --delivery <n> [--after] --definition <project definition> [--definition <its .local.md>]
//        node checks.mjs <ticket-folder> --stop
// A check is due when its due is "before delivery <n>", a Surface check also when due before an earlier one, and with
// --after (run once the delivery's steps are taken) also when due "after <step> in delivery <n>".
//   verify "cmd: <command>": run without a shell, only when its words start with an entry of the definition's
//     checks_allow ("npm test" allows "npm test -- renew", not "npm exec"). An entry with a word starting ./ ../ or /
//     names a file from the definition's folder (an oracle) and runs from there, never from the branch under test; any
//     other runs in the worktree named by "in" (default: the first in STATE.md). {worktree} and {ticket} in the command
//     become those folders' paths. It passes when it exits 0, its output holds expect (or matches it, written
//     /regex/flags), and its output matches none of the definition's nothing_ran patterns (a runner's "no tests found").
//     A command run in the worktree is keyed by its repo's tree: a pass on an identical tree with the same check stands,
//     and a green proof line with the same words on that tree is adopted; neither is run again. An oracle always runs.
//   verify "walk: <steps>": passes when evidence/walk-<id>.md holds a "seen:" line and names a commit whose tree is
//     HEAD's, the same change on a moved base, or one whose diff to HEAD stays within the last review's findings'
//     files plus tests.
// A run holds evidence/checks.run (its process id) for its ticket until it ends, and a ticket has one run at a time.
// --stop ends that ticket's run and the command it started, and nothing else on the machine; a stopped run writes no
// results, and a run that doesn't finish leaves none.
// Writes evidence/checks.json (one line per check) and evidence/checks/<id>.log. Exit 0 when every due check passes.
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { ticket, definition, read, git, vals, sha, matches, trivial, testMatcher, spawnArgs, findingFiles, roundsOf } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const runFile = join(dir, 'evidence', 'checks.run');
const windows = process.platform === 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A process is named by its id and start time, so that a reused id is never taken for it.
const startOf = (pid) => (windows ? 'any' : (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim());
const same = (p) => !!p?.pid && alive(p.pid) && startOf(p.pid) === p.started;
const record = () => { try { return JSON.parse(read(runFile)); } catch { return null; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const GRACE = 60000; // what a command's own teardown (containers, volumes) gets before it is killed
const signalGroup = (pid, signal) => { try { process.kill(windows ? pid : -pid, signal); } catch {} };
// A run killed outright leaves its file and perhaps its command: the command is ended and the file removed.
function clearLeftover() {
  const c = record()?.command;
  const left = same(c);
  if (left) {
    signalGroup(c.pid, 'SIGTERM');
    const until = Date.now() + GRACE;
    while (same(c) && Date.now() < until) pause(200);
    signalGroup(c.pid, 'SIGKILL');
  }
  rmSync(runFile, { force: true });
  return left;
}
if (args.includes('--stop')) {
  if (!existsSync(join(dir, 'STATE.md'))) { console.error(`checks: ${dir} is not a ticket folder`); process.exit(2); }
  const run = record();
  if (!same(run)) { console.log(clearLeftover() ? 'checks: ended the command a killed run left' : 'checks: no run in progress for this ticket'); process.exit(0); }
  process.kill(run.pid, 'SIGTERM');
  const until = Date.now() + GRACE + 10000;
  // The run removes its file as it exits; a finished process can stay visible until its parent collects it.
  const on = () => existsSync(runFile) && same(run);
  while (on() && Date.now() < until) pause(200);
  console.log(on() ? `checks: run ${run.pid} did not stop` : `checks: stopped run ${run.pid}`);
  process.exit(on() ? 1 : 0);
}
const delivery = +vals(args, '--delivery')[0];
const after = args.includes('--after');
if (!delivery || !vals(args, '--definition').length) {
  console.error('usage: node checks.mjs <ticket-folder> --delivery <n> [--after] --definition <file> [--definition <file>]');
  process.exit(2);
}
const def = definition(vals(args, '--definition'));
const allow = def.list('checks_allow') || [], nothingRan = def.list('nothing_ran') || [];
const isTest = testMatcher(def.list('test_files'));
// A command split like a shell would, quotes only; anything that needs a shell is refused.
function split(s) {
  const out = [];
  let cur = '', q = null, quoted = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { if (cur || quoted) out.push(cur); cur = ''; quoted = false; continue; }
    if (/[;&|<>`$]/.test(ch)) return null;
    cur += ch;
  }
  if (q) return null;
  if (cur || quoted) out.push(cur);
  return out;
}

const T = ticket(dir);
if (T.checksError) { console.error(`checks: CHECKS.json: ${T.checksError}`); process.exit(1); }
const trees = Object.fromEntries(Object.entries(T.worktrees).filter(([, w]) => w.path).map(([r, w]) => [r, w.tree]));
// A walk at commit c still shows HEAD's behaviour when c's tree is HEAD's, c is the same change on a moved base, or
// the diff since stays within the files the delivery's last review's findings name plus tests.
const named = findingFiles(read(join(T.ev, roundsOf(T.names, 'review', delivery).at(-1) || '-')));
const patch = (w, a, b) => { const t = git(w.path, 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: w.path, input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
const sameChange = (w, c) => {
  if (git(w.path, 'rev-parse', `${c}^{tree}`) === w.tree) return true;
  if (git(w.path, 'merge-base', '--is-ancestor', c, 'HEAD') !== null && (git(w.path, 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).every((f) => isTest(f) || named.some((x) => f === x || f.endsWith(`/${x}`)))) return true;
  const p1 = w.baseRef && patch(w, git(w.path, 'merge-base', c, w.baseRef), c);
  return !!p1 && p1 === patch(w, git(w.path, 'merge-base', 'HEAD', w.baseRef), 'HEAD');
};

const dueBefore = (c) => +((String(c.due).match(/^before delivery (\d+)$/) || [])[1] || 0);
const dueAfter = (c) => +((String(c.due).match(/^after .+ in delivery (\d+)$/) || [])[1] || 0);
const due = (c) => dueBefore(c) === delivery || ((c.surface || []).length > 0 && dueBefore(c) > 0 && dueBefore(c) < delivery) || (after && dueAfter(c) === delivery);
const specOf = (c) => sha(JSON.stringify([c.verify, c.expect ?? null, c.in ?? null, allow, nothingRan]));
let last = null;
try { last = JSON.parse(read(join(T.ev, 'checks.json'))); } catch {}
mkdirSync(join(T.ev, 'checks'), { recursive: true });

// One run per ticket. The file names it, so that nobody has to find it by matching processes.
let held = false;
process.on('exit', () => { if (held) rmSync(runFile, { force: true }); });
const me = { pid: process.pid, started: startOf(process.pid) };
const hold = () => { try { writeFileSync(runFile, JSON.stringify(me), { flag: 'wx' }); return (held = true); } catch { return false; } };
if (!hold()) {
  const other = record();
  if (!same(other)) clearLeftover();
  if (same(other) || !hold()) { console.error(`checks: a run is in progress for this ticket; wait until evidence/checks.run is gone, or use --stop`); process.exit(2); }
}
// The last whole result stops standing the moment a run starts replacing its logs; a run that doesn't finish leaves none.
let logsTouched = false;
const voidLast = () => { if (!logsTouched) rmSync(join(T.ev, 'checks.json'), { force: true }); logsTouched = true; };
const writeLog = (id, text) => { voidLast(); writeFileSync(join(T.ev, 'checks', `${id}.log`), text); };

// Each command gets its own process group, so that stopping it reaches everything it started and only that.
let child = null;
const killCommand = (signal) => {
  if (!child) return;
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else signalGroup(child.pid, signal);
};
// At the end of the grace: killed, and its pipes let go even if something outside the group still holds them.
const forceEnd = () => { killCommand('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy(); };
const exec = (cmd, argv, opts) => new Promise((done) => {
  let stdout = '', stderr = '', size = 0, error = null, force = null, over = false;
  const end = (why) => { error = error || new Error(why); killCommand('SIGTERM'); force = force || setTimeout(forceEnd, GRACE); };
  const c = (child = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows }));
  if (c.pid) writeFileSync(runFile, JSON.stringify({ ...me, command: { pid: c.pid, started: startOf(c.pid) } }));
  const limit = setTimeout(() => end('timed out after an hour'), 3600000);
  const finish = (status, signal) => {
    if (over) return;
    over = true;
    clearTimeout(limit); clearTimeout(force);
    if (child === c) child = null;
    done({ status, signal, stdout, stderr, error });
  };
  const take = (add) => (d) => { add(d); size += d.length; if (size > 1 << 28) end('output over the limit'); };
  c.stdout?.setEncoding('utf8').on('data', take((d) => { stdout += d; }));
  c.stderr?.setEncoding('utf8').on('data', take((d) => { stderr += d; }));
  c.on('error', (e) => { error = e; if (!c.pid) finish(null, null); });
  c.on('close', finish);
});
// Stopped from outside: the command first, then this run; no results are written.
let stopping = false;
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  console.error('checks: stopped; no results written');
  if (!child) process.exit(code);
  const group = child.pid;
  child.once('close', () => { if (!windows) signalGroup(group, 'SIGKILL'); process.exit(code); });
  killCommand('SIGTERM');
  setTimeout(forceEnd, GRACE);
});

const results = [];
for (const c of T.checks.filter(due)) {
  const repo = c.in || Object.keys(trees)[0], w = T.worktrees[repo];
  const r = { id: c.id, surface: c.surface || [], spec: specOf(c), tree: trees[repo] };
  results.push(r);
  if (!w?.path) { Object.assign(r, { ok: false, reason: `no worktree "${repo}" in STATE.md` }); continue; }
  if (!/^cmd:/.test(c.verify)) {
    const file = `evidence/walk-${c.id}.md`, ev = read(join(dir, file));
    const commit = (ev.match(/\b[0-9a-f]{7,40}\b/g) || []).find((h) => sameChange(w, h));
    if (!ev) Object.assign(r, { ok: false, reason: `no ${file}` });
    else if (!commit) Object.assign(r, { ok: false, reason: `${file} names neither a commit with ${repo} HEAD's tree nor the same change` });
    else if (!/^\W*seen:/im.test(ev)) Object.assign(r, { ok: false, reason: `${file} has no "seen:" line saying what was seen` });
    else Object.assign(r, { ok: true, log: file });
    continue;
  }
  const argv = split(c.verify.slice(4).trim());
  const entry = argv?.length && allow.find((a) => a.split(/\s+/).every((x, i) => argv[i] === x));
  if (!argv?.length) { Object.assign(r, { ok: false, reason: 'not a plain command: no shell operators, pipes or variables' }); continue; }
  if (!entry) { Object.assign(r, { ok: false, reason: `"${argv.slice(0, 2).join(' ')}" does not start with an entry of checks_allow; it is a walk` }); continue; }
  if (trivial(c.expect)) { Object.assign(r, { ok: false, reason: "expect is empty or matches anything, so the check can't fail" }); continue; }
  const own = entry.split(/\s+/).filter((x) => /^(\.{1,2})?\//.test(x));
  if (own.some((x) => !existsSync(resolve(def.dir, x)))) { Object.assign(r, { ok: false, reason: `${own.join(' ')} is not in the definition's folder ${def.dir}` }); continue; }
  const sub = argv.map((a) => a.replaceAll('{worktree}', w.path).replaceAll('{ticket}', dir));
  const holds = (out) => !nothingRan.find((p) => matches(out, p)) && matches(out, c.expect);
  // The same check passed on this tree, or a green proof line ran these words on it: it stands, unrun.
  const kept = !own.length && last?.results?.find((x) => x.id === c.id && x.ok && x.spec === r.spec && x.tree === w.tree);
  const proof = !own.length && T.proofs.findLast((p) => !p.base && p.exit === 0 && p.repository === w.repository && p.tree === w.tree && JSON.stringify(p.argv) === JSON.stringify(sub) && holds(p.log || ''));
  if (kept) { Object.assign(r, { ok: true, log: kept.log, line: `${c.id}${r.surface.length ? ` [${r.surface.join(', ')}]` : ''}: pass (stands on tree ${w.tree.slice(0, 12)})` }); continue; }
  if (proof) {
    writeLog(c.id, `adopted: the proof line of ${proof.time} ran these words on tree ${w.tree}\n${proof.log}\n`);
    Object.assign(r, { ok: true, log: `evidence/checks/${c.id}.log`, line: `${c.id}${r.surface.length ? ` [${r.surface.join(', ')}]` : ''}: pass (adopted from proof, ${proof.time})` });
    continue;
  }
  const cwd = own.length ? def.dir : w.path, s = spawnArgs(sub);
  voidLast();
  const run = await exec(s.argv[0], s.argv.slice(1), { cwd, env: { ...process.env, ...s.env, CHECK_WORKTREE: w.path, CHECK_TICKET: dir }, windowsVerbatimArguments: !!s.verbatim });
  const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
  const empty = nothingRan.find((p) => matches(out, p));
  writeLog(c.id, `$ ${sub.join(' ')}\n(in ${cwd}, ${repo} tree ${w.tree} at HEAD ${w.head})\n${out}\nexit ${run.status ?? run.signal}\n`);
  Object.assign(r, { ok: !run.error && run.status === 0 && holds(out), log: `evidence/checks/${c.id}.log` });
  if (!r.ok) r.reason = run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : empty ? `ran nothing ("${empty}")` : `output does not hold expect "${c.expect}"`;
}

const ok = results.every((r) => r.ok);
for (const r of results) r.line ??= `${r.id}${r.surface.length ? ` [${r.surface.join(', ')}]` : ''}: ${r.ok ? 'pass' : `fail: ${r.reason}`}`;
writeFileSync(join(T.ev, 'checks.json'), JSON.stringify({ delivery, after, ok, trees, results: results.map(({ id, ok, line, log, spec, tree }) => ({ id, ok, line, log, spec, tree })) }, null, 2) + '\n');
console.log(`checks: ${ok ? 'pass' : 'fail'} (${results.filter((r) => r.ok).length}/${results.length} due for delivery ${delivery})`);
for (const r of results) console.log(`- ${r.line}`);
if (!allow.length && T.checks.some((c) => due(c) && /^cmd:/.test(c.verify))) console.log('- no checks_allow in the project definition');
process.exit(ok ? 0 : 1);
