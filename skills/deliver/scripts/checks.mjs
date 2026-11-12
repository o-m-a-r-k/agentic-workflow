#!/usr/bin/env node
// checks: runs the runnable checks due for a delivery and compares each output with its expect.
// Usage: node checks.mjs <ticket-folder> --delivery <n> [--after] --definition <project definition> [--definition <its .local.md>]
//        node checks.mjs <ticket-folder> --stop
// A check is due as ticket.mjs's due() says.
//   verify "cmd: <command>": run without a shell, only when its words start with an entry of the definition's
//     checks_allow ("npm test" allows "npm test -- renew", not "npm exec"). An entry with a word starting ./ ../ or /
//     names a file from the definition's folder (an oracle) and runs from there, never from the branch under test,
//     unless the plan's "Oracles changed:" line names it: then the worktree's copy runs. Any other runs in the worktree
//     named by "in" (default: the first in STATE.md). {worktree} and {ticket} become those folders' paths. It passes
//     when it exits 0, its output holds expect (or matches /regex/flags), and matches none of nothing_ran.
//     A pass stands while every worktree's commit it ran on stands for HEAD (ticket.mjs), and a green proof line with
//     the same words on a commit that stands is adopted; neither runs again. An oracle always runs. A check marked
//     "heavy" runs only once the delivery's newest review is clean on a commit that stands.
//   verify "walk: <steps>": passes when evidence/walk-<id>.md has the lines "Check: <id>", "Commit: <repo>@<sha>" on a
//     commit that stands (the last review's findings' files may differ), "Result: pass" and "Seen: <what was seen>".
// A run holds evidence/checks.run (its process id) for its ticket until it ends, and a ticket has one run at a time.
// --stop ends that ticket's run and the command it started, and nothing else on the machine; a stopped run writes no
// results, and a run that doesn't finish leaves none.
// Writes evidence/checks.json and evidence/checks/<id>.log, whose first line names the check, its spec and trees.
// Exit 0 when every due check passes, and at least one is due.
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ticket, definitionOf, proofRules, read, field, vals, matches, trivial, spawnArgs, verdict, fields, findingFiles, roundsOf, due, specOf, normPath } from './ticket.mjs';

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
if (!delivery) { console.error('usage: node checks.mjs <ticket-folder> --delivery <n> [--after] --definition <file> [--definition <file>]'); process.exit(2); }
const def = definitionOf(args);
const allow = def.list('checks_allow') || [], nothingRan = def.list('nothing_ran') || [];
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
const R = proofRules(T, def);
const W = Object.fromEntries(T.delivered.map((w) => [w.name, w]));
const heads = Object.fromEntries(T.delivered.map((w) => [w.name, w.head])), trees = Object.fromEntries(T.delivered.map((w) => [w.name, w.tree]));
const allStand = (hs = {}, also) => T.delivered.every((w) => R.stands(w, hs[w.name], also));
const lastReview = read(join(T.ev, roundsOf(T.names, 'review', delivery).at(-1) || '-'));
const reviewClean = verdict(lastReview) === 'clean' && T.delivered.every((w) => w.tree === w.baseTree || fields(lastReview, 'commit').some((c) => c.startsWith(`${w.name}@`) && R.stands(w, c.split('@')[1].split(/\s/)[0])));
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
const writeLog = (c, spec, text) => { voidLast(); writeFileSync(join(T.ev, 'checks', `${c.id}.log`), `check ${c.id} spec ${spec} trees ${JSON.stringify(trees)}\n${text}`); };

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
const label = (c) => `${c.id}${(c.surface || []).length ? ` [${c.surface.join(', ')}]` : ''}`;
for (const c of T.checks.filter((x) => due(x, delivery, after))) {
  const repo = c.in || Object.keys(W)[0], w = W[repo], spec = specOf(c, def);
  const r = { id: c.id, spec, heads, results: [] };
  results.push(r);
  const no = (reason) => Object.assign(r, { ok: false, reason });
  if (!w) { no(`no worktree "${repo}" in STATE.md`); continue; }
  if (!/^cmd:/.test(c.verify)) {
    const file = `evidence/walk-${c.id}.md`, ev = read(join(dir, file)), [wr, ws] = field(ev, 'commit').split(/\s/)[0].split('@');
    if (!ev) no(`no ${file}`);
    else if (field(ev, 'check') !== c.id) no(`${file} has no "Check: ${c.id}" line`);
    else if (!/^pass\b/i.test(field(ev, 'result'))) no(`${file} says Result: ${field(ev, 'result') || '(none)'}`);
    else if (!field(ev, 'seen')) no(`${file} has no "Seen:" line saying what was seen`);
    else if (!W[wr] || !R.stands(W[wr], ws, findingFiles(lastReview))) no(`${file} names ${field(ev, 'commit') || 'no commit'}, which doesn't stand for ${wr || repo} HEAD`);
    else Object.assign(r, { ok: true, log: file });
    continue;
  }
  const argv = split(c.verify.slice(4).trim());
  const entry = argv?.length && allow.find((a) => a.split(/\s+/).every((x, i) => argv[i] === x));
  if (!argv?.length) { no('not a plain command: no shell operators, pipes or variables'); continue; }
  if (!entry) { no(`"${argv.slice(0, 2).join(' ')}" does not start with an entry of checks_allow; it is a walk`); continue; }
  if (trivial(c.expect)) { no("expect is empty or matches anything, so the check can't fail"); continue; }
  const own = entry.split(/\s+/).filter((x) => /^(\.{1,2})?\//.test(x));
  const changedHere = (x) => T.oraclesChanged.includes(normPath(x)) && W[normPath(x).split('/')[0]];
  const where = (x) => (changedHere(x) ? join(W[normPath(x).split('/')[0]].path, normPath(x).split('/').slice(1).join('/')) : resolve(def.dir, x));
  if (own.some((x) => !existsSync(where(x)))) { no(`${own.join(' ')} is not in ${own.some(changedHere) ? 'the worktree' : `the definition's folder ${def.dir}`}`); continue; }
  if (c.heavy && !reviewClean) { no('heavy: waits for the newest review to be clean on these commits'); continue; }
  const sub = argv.map((a) => (own.includes(a) ? where(a) : a.replaceAll('{worktree}', w.path).replaceAll('{ticket}', dir)));
  const holds = (out) => !nothingRan.find((p) => matches(out, p)) && matches(out, c.expect);
  // The same check passed on commits that stand, or a green proof line ran these words on one: it stands, unrun.
  const kept = !own.length && last?.results?.find((x) => x.id === c.id && x.ok && x.spec === spec && allStand(x.heads));
  const proof = !own.length && T.proofs.findLast((p) => p.repository === w.repository && R.isGreen(p) && JSON.stringify(p.argv) === JSON.stringify(sub) && holds(p.log || ''));
  if (kept) { Object.assign(r, { ok: true, log: kept.log, heads: kept.heads, line: `${label(c)}: pass (stands from ${kept.heads[repo]?.slice(0, 12)})` }); continue; }
  if (proof) {
    writeLog(c, spec, `adopted: the proof line of ${proof.time} ran these words at ${proof.head}\n${proof.log}\n`);
    Object.assign(r, { ok: true, log: `evidence/checks/${c.id}.log`, line: `${label(c)}: pass (adopted from proof, ${proof.time})` });
    continue;
  }
  const cwd = own.length ? def.dir : w.path, s = spawnArgs(sub);
  if (s.error) { no(s.error); continue; }
  voidLast();
  const run = await exec(s.argv[0], s.argv.slice(1), { cwd, env: { ...process.env, ...s.env, CHECK_WORKTREE: w.path, CHECK_TICKET: dir }, windowsVerbatimArguments: !!s.verbatim });
  const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
  const empty = nothingRan.find((p) => matches(out, p));
  writeLog(c, spec, `$ ${sub.join(' ')}\n(in ${cwd})\n${out}\nexit ${run.status ?? run.signal}\n`);
  Object.assign(r, { ok: !run.error && run.status === 0 && holds(out), log: `evidence/checks/${c.id}.log` });
  if (!r.ok) r.reason = run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : empty ? `ran nothing ("${empty}")` : `output does not hold expect "${c.expect}"`;
}

const ok = results.length > 0 && results.every((r) => r.ok);
for (const r of results) r.line ??= `${label(T.checks.find((c) => c.id === r.id))}: ${r.ok ? 'pass' : `fail: ${r.reason}`}`;
writeFileSync(join(T.ev, 'checks.json'), JSON.stringify({ delivery, after, ok, trees, heads, definition: def.files, results: results.map(({ id, ok, line, log, spec, heads: h }) => ({ id, ok, line, log, spec, heads: h })) }, null, 2) + '\n');
console.log(`checks: ${ok ? 'pass' : 'fail'} (${results.filter((r) => r.ok).length}/${results.length} due for delivery ${delivery}; definition ${def.files.join(', ')})`);
for (const r of results) console.log(`- ${r.line}`);
if (!results.length) console.log(`- no check is due for delivery ${delivery}`);
if (!allow.length && T.checks.some((c) => due(c, delivery, after) && /^cmd:/.test(c.verify))) console.log('- no checks_allow in the project definition');
process.exit(ok ? 0 : 1);
