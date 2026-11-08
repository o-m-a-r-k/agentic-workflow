#!/usr/bin/env node
// checks: runs the runnable checks due for a delivery and compares each output with its expect.
// Usage: node checks.mjs <ticket-folder> --delivery <n> [--after] [--only <id,...>] --definition <project definition> [--definition <its .local.md>]
//        node checks.mjs <ticket-folder> --stop
// A check is due when its due is "before delivery <n>", a Surface check also when due before an earlier one, and with
// --after (run once the delivery's steps are taken) also when due "after <step> in delivery <n>".
//   verify "cmd: <command>": run without a shell, only when its words start with an entry of the definition's
//     checks_allow ("npm test" allows "npm test -- renew", not "npm exec"). An entry with a word starting ./ ../ or /
//     names a file from the definition's folder (an oracle) and runs from there, never from the branch under test; any
//     other runs in the worktree named by
//     "in" (default: the first in STATE.md). {worktree} and {ticket} in the command become those folders' paths.
//     It passes when it exits 0, its output holds expect (or matches it, written /regex/flags), and its output matches
//     none of the definition's nothing_ran patterns (a runner's "no tests found").
//   verify "walk: <steps>": passes when passes is true and its evidence file holds a "seen:" line and names a commit
//     that is HEAD, the same change on a moved base, or one whose diff to HEAD stays within the last review's
//     findings' files plus tests.
// --only reruns the named commands and keeps every other command's result, when the last run was the same delivery on
// the same commits and those commands are unchanged; otherwise it runs nothing and exits 2. Walks are always re-read.
// A run holds evidence/checks.run (its process id) for its ticket until it ends, and a ticket has one run at a time.
// --stop ends that ticket's run and the command it started, and nothing else on the machine; a stopped run writes no results, and a run that doesn't finish leaves none.
// Writes evidence/checks.json (one line per check) and evidence/checks/<id>.log. Exit 0 when every due check passes.
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const vals = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
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
const delivery = +vals('--delivery')[0];
const only = vals('--only').flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
const after = args.includes('--after');
if (!delivery) {
  console.error('usage: node checks.mjs <ticket-folder> --delivery <n> [--after] [--only <id,...>] --definition <file> [--definition <file>]');
  process.exit(2);
}

// A front-matter list, as [a, b] or a block list; the first definition that sets it wins.
function list(text, key) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+- .*)*)`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
  const items = v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return items.map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const defs = vals('--definition').map((p) => resolve(p));
const setting = (key) => defs.map((p) => list(read(p), key)).find(Boolean) || [];
const allow = setting('checks_allow');
const nothingRan = setting('nothing_ran');
const defDir = defs[0] ? (basename(dirname(defs[0])) === '.agents' ? dirname(dirname(defs[0])) : dirname(defs[0])) : dir;
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

const state = read(join(dir, 'STATE.md'));
const git = (cwd, ...a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim(); } catch { return null; }
};
const trees = {}, baseRef = {}, heads = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)(?:.*?\bfrom (\S+))?/gm)) {
  if (!existsSync(resolve(dir, m[2]))) continue;
  const p = (trees[m[1]] = realpathSync(resolve(dir, m[2])));
  heads[m[1]] = git(p, 'rev-parse', 'HEAD');
  baseRef[m[1]] = m[3] ? [`origin/${m[3]}`, m[3]].find((b) => git(p, 'rev-parse', '--verify', '-q', b)) : null;
}
// The same change on a moved base: the diff from where each commit meets the base is the same patch.
const patch = (r, a, b) => { const t = git(trees[r], 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: trees[r], input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
// A walk at commit c still shows HEAD's behaviour when c is HEAD, the same change on a moved base, or when the diff
// since stays within the files the delivery's last review's findings name (F<n> lines) plus tests.
const reviews = (existsSync(join(dir, 'evidence')) ? readdirSync(join(dir, 'evidence')) : []).filter((f) => (f.match(/^review-(\d+)-(\d+)\.md$/) || [])[1] === String(delivery));
const lastReview = read(join(dir, 'evidence', reviews.sort((a, b) => +a.split('-')[2].split('.')[0] - +b.split('-')[2].split('.')[0]).at(-1) || '-'));
const blocks = lastReview.split(/^#+\s*outside the ticket/im)[0].split('\n').reduce((acc, l) => { if (/^[\s>#*_-]*F\d+\b/.test(l)) acc.push(l); else if (/^#/.test(l)) acc.push(null); else if (acc.length && acc.at(-1) !== null) acc[acc.length - 1] += `\n${l}`; return acc; }, []).filter(Boolean);
const named = blocks.flatMap((b) => [...b.matchAll(/([^\s`'"()]+\.\w+):\d+/g)].map((m) => m[1]));
// Test files: the definition's test_files globs, or a default across common languages.
const globs = setting('test_files').length ? setting('test_files') : ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_tests.*', '**/test_*.*', '**/tests.*', '**/*_spec.rb', '**/*Test.*', '**/*Tests.*'];
const testRx = globs.map((g) => new RegExp(`^${g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')}$`));
const isTest = (f) => testRx.some((rx) => rx.test(f));
// On Windows a runner such as npm is a .cmd file, which Node starts only through cmd.exe; checks has already refused
// shell operators in the words.
const winArgv = (argv) => {
  if (process.platform !== 'win32' || /[\\/]|\.\w+$/.test(argv[0])) return argv;
  for (const dir of (process.env.PATH || '').split(';')) for (const e of (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';'))
    if (dir && existsSync(join(dir, argv[0] + e))) return /\.(cmd|bat)$/i.test(e) ? [process.env.ComSpec || 'cmd.exe', '/d', '/c', ...argv] : [join(dir, argv[0] + e), ...argv.slice(1)];
  return argv;
};

const sameChange = (r, c) => {
  if (heads[r]?.startsWith(c)) return true;
  if (git(trees[r], 'cat-file', '-e', `${c}^{commit}`) === null) return false;
  const diff = git(trees[r], 'diff', '--name-only', c, 'HEAD');
  if (diff !== null && git(trees[r], 'merge-base', '--is-ancestor', c, 'HEAD') !== null && diff.split('\n').filter(Boolean).every((f) => isTest(f) || named.some((x) => f === x || f.endsWith(`/${x}`)))) return true;
  if (!baseRef[r]) return false;
  const p1 = patch(r, git(trees[r], 'merge-base', c, baseRef[r]), c);
  return !!p1 && p1 === patch(r, git(trees[r], 'merge-base', 'HEAD', baseRef[r]), 'HEAD');
};
let checks;
try {
  checks = JSON.parse(read(join(dir, 'CHECKS.json')));
} catch (e) {
  console.error(`checks: CHECKS.json: ${e.message}`);
  process.exit(1);
}

const dueBefore = (c) => +((String(c.due).match(/^before delivery (\d+)$/) || [])[1] || 0);
const dueAfter = (c) => +((String(c.due).match(/^after .+ in delivery (\d+)$/) || [])[1] || 0);
const due = (c) => dueBefore(c) === delivery || ((c.surface || []).length > 0 && dueBefore(c) > 0 && dueBefore(c) < delivery) || (after && dueAfter(c) === delivery);
const matches = (out, expect) => {
  const rx = String(expect).match(/^\/(.*)\/([a-z]*)$/s);
  return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(String(expect).trim());
};
// An expect that can't fail (the same rule as plan-shape): empty, or a /regex/ matching "", "x" or "ok".
const trivial = (e) => {
  const rx = String(e ?? '').match(/^\/(.*)\/([a-z]*)$/s);
  try { return !String(e ?? '').trim() || (!!rx && ['', 'x', 'ok'].some((o) => new RegExp(rx[1], rx[2]).test(o))); } catch { return true; }
};
// What decides a command's result besides the commits; a kept result must have come from the same.
const ownFiles = (c) => (split(String(c.verify).replace(/^cmd:/, '').trim()) || []).filter((w) => /^(\.{1,2})?\//.test(w) && allow.some((a) => a.split(/\s+/).includes(w))).map((w) => read(resolve(defDir, w)));
const specOf = (c) => createHash('sha256').update(JSON.stringify([c.verify, c.expect ?? null, c.in ?? null, allow, nothingRan, ownFiles(c)])).digest('hex').slice(0, 16);
const isCmd = (c) => /^cmd:/.test(c.verify);
const kept = new Map();
if (only.length) {
  const refuse = (why) => { console.error(`checks: --only ran nothing: ${why}`); process.exit(2); };
  const dueNow = checks.filter(due);
  const unknown = only.filter((id) => !dueNow.some((c) => c.id === id));
  if (unknown.length) refuse(`${unknown.join(', ')} not due for delivery ${delivery}`);
  let last = null;
  try { last = JSON.parse(read(join(dir, 'evidence', 'checks.json'))); } catch {}
  if (!last || last.delivery !== delivery || !!last.after !== after || JSON.stringify(last.heads) !== JSON.stringify(heads)) refuse('the last whole run was not this delivery on these commits; run them all');
  const stale = dueNow.filter((c) => isCmd(c) && !only.includes(c.id) && last.results.find((x) => x.id === c.id)?.spec !== specOf(c)).map((c) => c.id);
  if (stale.length) refuse(`${stale.join(', ')} changed since the last run or never ran; name them too or run them all`);
  for (const x of last.results) kept.set(x.id, x);
}
mkdirSync(join(dir, 'evidence', 'checks'), { recursive: true });

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
const writeLog = (id, text) => {
  if (!logsTouched) { rmSync(join(dir, 'evidence', 'checks.json'), { force: true }); logsTouched = true; }
  writeFileSync(join(dir, 'evidence', 'checks', `${id}.log`), text);
};

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
for (const c of checks) {
  if (!due(c)) continue;
  if (only.length && !only.includes(c.id) && isCmd(c)) { results.push({ ...kept.get(c.id) }); continue; }
  const repo = c.in || Object.keys(trees)[0];
  const r = { id: c.id, surface: c.surface || [], in: repo, spec: specOf(c) };
  if (!trees[repo]) Object.assign(r, { ok: false, reason: `no worktree "${repo}" in STATE.md` });
  else if (/^cmd:/.test(c.verify)) {
    const argv = split(c.verify.slice(4).trim());
    r.command = c.verify.slice(4).trim();
    if (!argv || !argv.length) Object.assign(r, { ok: false, reason: 'not a plain command: no shell operators, pipes or variables' });
    else if (!allow.some((a) => a.split(/\s+/).every((w, i) => argv[i] === w))) Object.assign(r, { ok: false, reason: `"${argv.slice(0, 2).join(' ')}" does not start with an entry of checks_allow; it is a walk` });
    else if (trivial(c.expect)) Object.assign(r, { ok: false, reason: "expect is empty or matches anything, so the check can't fail" });
    else {
      const entry = allow.find((a) => a.split(/\s+/).every((w, i) => argv[i] === w));
      const own = entry.split(/\s+/).filter((w) => /^(\.{1,2})?\//.test(w));
      const cwd = own.length ? defDir : trees[repo];
      if (own.some((w) => !existsSync(resolve(defDir, w)))) { results.push(Object.assign(r, { ok: false, reason: `${own.join(' ')} is not in the definition's folder ${defDir}` })); continue; }
      const sub = argv.map((a) => a.replaceAll('{worktree}', trees[repo]).replaceAll('{ticket}', dir));
      const w = winArgv(sub);
      const run = await exec(w[0], w.slice(1), { cwd, env: { ...process.env, CHECK_WORKTREE: trees[repo], CHECK_TICKET: dir } });
      const out = `${run.stdout || ''}${run.stderr || ''}${run.error ? run.error.message : ''}`;
      const empty = nothingRan.find((p) => matches(out, p));
      const ok = !run.error && run.status === 0 && matches(out, c.expect) && !empty;
      writeLog(c.id, `$ ${sub.join(' ')}\n(in ${cwd}, ${repo} HEAD ${heads[repo]})\n${out}\nexit ${run.status ?? run.signal}\n`);
      Object.assign(r, { ok, exit: run.status, head: heads[repo], log: `evidence/checks/${c.id}.log` });
      if (!ok) r.reason = run.error ? `did not run: ${run.error.message}` : run.status !== 0 ? `exit ${run.status ?? run.signal}` : empty ? `ran nothing ("${empty}")` : `output does not hold expect "${c.expect}"`;
    }
  } else {
    const ev = c.evidence && !/\s/.test(c.evidence) ? read(join(dir, c.evidence)) : '';
    const named = (ev.match(/\b[0-9a-f]{7,40}\b/g) || []).find((h) => sameChange(repo, h));
    if (c.passes !== true) Object.assign(r, { ok: false, reason: 'passes is not true' });
    else if (!ev) Object.assign(r, { ok: false, reason: `evidence "${c.evidence || ''}" is not a file in the ticket folder` });
    else if (!named) Object.assign(r, { ok: false, reason: `evidence names neither ${repo} HEAD ${heads[repo]?.slice(0, 12)} nor the same change on an earlier base` });
    else if (!/^\W*seen:/im.test(ev)) Object.assign(r, { ok: false, reason: 'evidence has no "seen:" line saying what was seen' });
    else Object.assign(r, { ok: true, head: heads[repo] });
  }
  results.push(r);
}

const ok = results.every((r) => r.ok);
for (const r of results) r.line ??= `${r.id}${r.surface.length ? ` [${r.surface.join(', ')}]` : ''}: ${r.ok ? 'pass' : `fail: ${r.reason}`}`;
writeFileSync(join(dir, 'evidence', 'checks.json'), JSON.stringify({ delivery, after, ok, heads, results: results.map(({ id, ok, line, log, spec }) => ({ id, ok, line, log, spec })) }, null, 2) + '\n');
console.log(`checks: ${ok ? 'pass' : 'fail'} (${results.filter((r) => r.ok).length}/${results.length} due for delivery ${delivery}${only.length ? `, reran ${only.join(', ')}` : ''})`);
for (const r of results) console.log(`- ${r.line}`);
if (!allow.length && checks.some((c) => due(c) && /^cmd:/.test(c.verify))) console.log('- no checks_allow in the project definition');
process.exit(ok ? 0 : 1);
