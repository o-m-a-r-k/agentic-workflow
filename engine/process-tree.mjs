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
  startedAt: processStart,
};

// When the process `pid` started (ms), or null when it is gone or this host does not say.
function processStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (r.error || r.status !== 0) return null;
  const at = Date.parse(String(r.stdout).trim());
  return Number.isFinite(at) ? at : null;
}

// Whether `pid` is still the process launched at `spawnedAt` (ISO): a process that started well after it holds a pid the
// system gave out again. Named failure (independent review of 0.7.9): a stale launch record's pid, reused by another
// process that leads its own group (a shell job, a daemon), would have made that group "the role" and killed it. While a
// group of the old pid still had members the system could not have reused the pid, so a reused leader means the role's
// group is gone. Unknown (no start time, no record) counts as the same process, as before.
export function stillTheRole(pid, spawnedAt) {
  const launched = Date.parse(spawnedAt ?? '');
  if (!Number.isFinite(launched)) return true;
  const started = processSeams.startedAt(pid);
  if (started === null) return true;
  // `ps` reports whole seconds; the spawn is recorded right after the process starts.
  return started <= launched + 30_000 && started >= launched - 30_000;
}

// Every process as { ppid, pgid, zombie } by pid, or null when this host does not let us list them (a sandbox can forbid
// `ps`). A zombie has died and waits for its parent to collect it: it is gone.
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
  // A process seen in the tree before counts while it keeps the group it had then (an orphan's parent changes, its group
  // does not); a pid given to a new process meanwhile does not.
  for (const [pid, p] of table) if (p.pgid === leader || seen.get(pid) === p.pgid) tree.add(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of table) if (!tree.has(pid) && tree.has(p.ppid)) { tree.add(pid); grew = true; }
  }
  tree.delete(process.pid);
  return [...tree].filter((pid) => !table.get(pid).zombie).map((pid) => ({ pid, pgid: table.get(pid).pgid }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ends the tree of `leader` and returns what is still alive: `left` (pids; empty when the tree is gone, which is the only
// thing that may be reported as stopped) and `denied` (the pids this process was not permitted to signal). SIGTERM goes to
// every member and to the group, SIGKILL after STOP_GRACE_MS to whatever is left; the table is read again after each
// signal, so a process the tree started meanwhile is ended too. Without a process table only the role's group can be
// probed, which still catches the role and everything that stayed in its group.
export async function endProcessTree(leader, { graceMs = STOP_GRACE_MS, killMs = STOP_KILL_MS } = {}) {
  const seen = new Map(), signalled = new Map(), denied = new Set(), groupSignalled = new Set();
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
    if (members) for (const m of members) if (!seen.has(m.pid)) seen.set(m.pid, m.pgid);
    const alive = members ? members.map((m) => m.pid) : exists(-leader) ? [leader] : [];
    if (!alive.length) return { left: [], denied: [] };
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

// In words, what `endProcessTree` left running: why each process could not be ended, and how to end it by hand.
export function leftOver({ left, denied }) {
  const named = (pids) => pids.map((pid) => `pid ${pid}`).join(', ');
  const survived = left.filter((pid) => !denied.includes(pid));
  const why = [...(denied.length ? [`not permitted to signal ${named(denied)} (a sandbox, or another user's process)`] : []), ...(survived.length ? [`${named(survived)} survived SIGTERM and SIGKILL (${(STOP_GRACE_MS + STOP_KILL_MS) / 1000}s)`] : [])].join('; ');
  const them = left.length === 1 ? 'it' : 'them';
  return { why, byHand: `End ${them} from a shell that may signal ${them} (\`kill -9 ${left.join(' ')}\`)` };
}
