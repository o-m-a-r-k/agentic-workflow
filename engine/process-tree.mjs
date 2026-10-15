// Ending a launched role's processes, and knowing they are gone. The launcher starts a role as the leader of a process
// group of its own (engine/launch.mjs); everything the role starts after that is its tree: the processes in that group, and
// the descendants that left it (a runtime runs each command in a group of its own, a daemon calls setsid).
//
// Named failure (I-128): `wf handoff stop` sent one SIGTERM to the role's group, ignored a signal that did not arrive
// (a sandbox forbids signalling a process it did not start), did not look again and recorded the role stopped while the
// role and its child kept running and kept emitting progress. A stop is reported only after the tree is observed gone.
import { spawnSync } from 'node:child_process';

// SIGTERM first (the role may clean up); what is still alive after this long is killed; what survives that is reported.
export const STOP_GRACE_MS = 5000;
export const STOP_KILL_MS = 5000;
const POLL_MS = 100;

// The two things this host is asked, replaceable by a scenario: a signal, and the table of processes.
export const processSeams = {
  kill: (pid, signal) => process.kill(pid, signal),
  table: processTable,
};

// Every process as { ppid, pgid, zombie } by pid, or null when this host does not let us list them (a sandbox can forbid
// `ps`; see processCommand in engine/gate.mjs). A zombie has died and waits for its parent to collect it: it is gone.
function processTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const table = new Map();
  for (const line of String(r.stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].startsWith('Z') });
  }
  return table.size ? table : null;
}

const exists = (target) => {
  try {
    processSeams.kill(target, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// The live processes of the tree of `leader`: its group (the leader is in it only while it leads it: a pid the system has
// since given to another process is not the role), whatever was seen in the tree before (it may have been orphaned since)
// and the descendants of any of them. Null when the host gives no process table.
function treeMembers(leader, seen) {
  const table = processSeams.table();
  if (!table) return null;
  const tree = new Set();
  for (const [pid, p] of table) if (p.pgid === leader || seen.has(pid)) tree.add(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of table) if (!tree.has(pid) && tree.has(p.ppid)) { tree.add(pid); grew = true; }
  }
  tree.delete(process.pid);
  return [...tree].filter((pid) => !table.get(pid).zombie);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ends the tree of `leader` and returns what is still alive: `left` (pids; empty when the tree is gone, which is the only
// thing that may be reported as stopped) and `denied` (the pids this process was not permitted to signal). SIGTERM goes to
// every member and to the group, SIGKILL after STOP_GRACE_MS to whatever is left; the table is read again after each
// signal, so a process the tree started meanwhile is ended too. Without a process table only the role's group can be
// probed, which still catches the role and everything that stayed in its group.
export async function endProcessTree(leader, { graceMs = STOP_GRACE_MS, killMs = STOP_KILL_MS } = {}) {
  const seen = new Set(), signalled = new Map(), denied = new Set(), groupSignalled = new Set();
  const startedAt = Date.now();
  const send = (target, signal) => {
    try {
      processSeams.kill(target, signal);
    } catch (e) {
      if (e.code === 'EPERM') denied.add(target < 0 ? leader : target);
    }
  };
  for (;;) {
    const members = treeMembers(leader, seen);
    const alive = members ?? (exists(-leader) ? [leader] : []);
    if (!alive.length) return { left: [], denied: [] };
    for (const pid of alive) seen.add(pid);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= graceMs + killMs) return { left: alive, denied: [...denied].filter((pid) => alive.includes(pid)) };
    const signal = elapsed < graceMs ? 'SIGTERM' : 'SIGKILL';
    if (!groupSignalled.has(signal)) { groupSignalled.add(signal); send(-leader, signal); }
    for (const pid of alive) if (signalled.get(pid) !== signal) { signalled.set(pid, signal); send(pid, signal); }
    // Nothing alive can be signalled by this process: waiting would only run out the clock.
    if (alive.every((pid) => denied.has(pid))) return { left: alive, denied: [...denied] };
    await sleep(POLL_MS);
  }
}
