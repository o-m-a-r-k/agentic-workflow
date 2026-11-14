// runner: one run per ticket for a script that runs commands (checks, gate), and the commands it runs. Not a script.
// A run holds evidence/<file> (its process id and start time) until it ends; a second run on the ticket is refused.
// stop() ends that ticket's run and the command it started, and nothing else on the machine. Each command gets its own
// process group, so stopping it reaches everything it started and only that. A command that outlives a killed run is
// ended by the next stop() or run.
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { read } from './ticket.mjs';

const windows = process.platform === 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A process is named by its id and start time, so that a reused id is never taken for it.
const startOf = (pid) => (windows ? 'any' : (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim());
const same = (p) => !!p?.pid && alive(p.pid) && startOf(p.pid) === p.started;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const GRACE = 60000; // what a command's own teardown (containers, volumes) gets before it is killed
const signalGroup = (pid, signal) => { try { process.kill(windows ? pid : -pid, signal); } catch {} };

export function runner(dir, file, name) {
  const runFile = join(dir, 'evidence', file);
  const record = () => { try { return JSON.parse(read(runFile)); } catch { return null; } };
  // A run killed outright leaves its file and perhaps its command: the command is ended and the file removed.
  const clearLeftover = () => {
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
  };
  const stop = () => {
    if (!existsSync(join(dir, 'STATE.md'))) { console.error(`${name}: ${dir} is not a ticket folder`); process.exit(2); }
    const run = record();
    if (!same(run)) { console.log(clearLeftover() ? `${name}: ended the command a killed run left` : `${name}: no run in progress for this ticket`); process.exit(0); }
    process.kill(run.pid, 'SIGTERM');
    const until = Date.now() + GRACE + 10000;
    // The run removes its file as it exits; a finished process can stay visible until its parent collects it.
    const on = () => existsSync(runFile) && same(run);
    while (on() && Date.now() < until) pause(200);
    console.log(on() ? `${name}: run ${run.pid} did not stop` : `${name}: stopped run ${run.pid}`);
    process.exit(on() ? 1 : 0);
  };

  let child = null, held = false, stopping = false;
  const me = { pid: process.pid, started: startOf(process.pid) };
  const killCommand = (signal) => {
    if (!child) return;
    if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else signalGroup(child.pid, signal);
  };
  // At the end of the grace: killed, and its pipes let go even if something outside the group still holds them.
  const forceEnd = () => { killCommand('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy(); };
  // Holds the ticket, or exits 2 while another run holds it. Stopped from outside: the command first, then this run.
  const hold = () => {
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    const take = () => { try { writeFileSync(runFile, JSON.stringify(me), { flag: 'wx' }); return (held = true); } catch { return false; } };
    if (!take()) {
      const other = record();
      if (!same(other)) clearLeftover();
      if (same(other) || !take()) { console.error(`${name}: a run is in progress for this ticket; wait until evidence/${file} is gone, or use --stop`); process.exit(2); }
    }
    process.on('exit', () => { if (held) rmSync(runFile, { force: true }); });
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.error(`${name}: stopped; the command in progress leaves no result`);
      if (!child) process.exit(code);
      const group = child.pid;
      child.once('close', () => { if (!windows) signalGroup(group, 'SIGKILL'); process.exit(code); });
      killCommand('SIGTERM');
      setTimeout(forceEnd, GRACE);
    });
  };
  // Runs one command without a shell; resolves with its status, signal, output and any error. An hour at most.
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
  // Another live run holds the ticket.
  const busy = () => { const r = record(); return !!r && r.pid !== process.pid && same(r); };
  return { stop, hold, exec, busy, stopping: () => stopping };
}
