// Named failure I-52: owners repeatedly loaded an in-flight role transcript to prove that a quiet process was alive.
// Ephemeral display only: no transcript reads, findings, ledger writes, ETA or completion claims.
export const ROLE_HEARTBEAT_MS = 60_000;

const duration = (ms) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

export function roleProgress(handoff, { now = () => performance.now(), write = (line) => process.stderr.write(line) } = {}) {
  let started = null, lastEvent = null, lastShown = null, finished = false;
  const role = `${handoff.role} ${handoff.agent}`;
  return {
    start(session) {
      started = lastEvent = lastShown = now();
      write(`Codex ${role}: session ${session} started; configured ${handoff.model ?? 'inherited model'}/${handoff.effort ?? 'inherited effort'}\n`);
    },
    event() { if (started !== null && !finished) lastEvent = now(); },
    heartbeat() {
      const at = now();
      if (finished || started === null || at - lastShown < ROLE_HEARTBEAT_MS) return;
      lastShown = at;
      write(`Codex ${role}: process running; elapsed ${duration(at - started)}; last runtime event ${duration(at - lastEvent)} ago\n`);
    },
    finish() { finished = true; },
  };
}
