// Named failure I-52: owners repeatedly loaded an in-flight role transcript to prove that a quiet process was alive.
// Ephemeral display only: no transcript reads, findings, ledger writes, ETA or completion claims.
export const ROLE_HEARTBEAT_MS = 60_000;
// Named failure I-59: unchanged waits filled the chat with minute-by-minute pending statuses.
// Runtime activity establishes liveness, not new review progress; show only every tenth eligible check.
export const ROLE_HEARTBEAT_CHECKS = 10;

const duration = (ms) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

export function roleProgress(handoff, { now = () => performance.now(), write = (line) => process.stderr.write(line) } = {}) {
  let started = null, lastEvent = null, lastCheck = null, checks = 0, finished = false;
  const role = `${handoff.role} ${handoff.agent}`;
  return {
    start(session) {
      started = lastEvent = lastCheck = now();
      checks = 0;
      write(`Codex ${role}: session ${session} started; configured ${handoff.model ?? 'inherited model'}/${handoff.effort ?? 'inherited effort'}\n`);
    },
    event() { if (started !== null && !finished) lastEvent = now(); },
    heartbeat() {
      const at = now();
      if (finished || started === null || at - lastCheck < ROLE_HEARTBEAT_MS) return;
      lastCheck = at;
      if (++checks < ROLE_HEARTBEAT_CHECKS) return;
      checks = 0;
      write(`Codex ${role}: process running; elapsed ${duration(at - started)}; last runtime event ${duration(at - lastEvent)} ago\n`);
    },
    finish() { finished = true; },
  };
}
