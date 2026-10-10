// Named failure I-52: owners repeatedly loaded an in-flight role transcript to prove that a quiet process was alive.
// Ephemeral display only: no transcript reads, ledger writes, ETA or engine verdict claims.
export const ROLE_HEARTBEAT_MS = 60_000;
// Named failure I-59: unchanged waits filled the chat with minute-by-minute pending statuses.
// Runtime activity establishes liveness, not new review progress; show only every tenth eligible check.
export const ROLE_HEARTBEAT_CHECKS = 10;

const duration = (ms) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

// Named failure: the native stream carried useful role commentary but the launcher discarded it.
// Relay only completed assistant text, never reasoning, tools or terminal result payloads.
export function roleReport(event, runtime) {
  if (runtime === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') return event.item.text;
  if (runtime === 'claude' && event.type === 'assistant' && Array.isArray(event.message?.content)) {
    return event.message.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join(' ');
  }
  return null;
}

function displayText(text) {
  if (typeof text !== 'string') return '';
  // Strip terminal escape sequences and control/direction characters before flattening and bounding output.
  const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 600 ? clean.slice(0, 600) + '…' : clean;
}

export function roleProgress(handoff, { now = () => performance.now(), runtime = 'Codex', write = (line) => process.stderr.write(line) } = {}) {
  let started = null, lastEvent = null, lastCheck = null, checks = 0, finished = false;
  let pending = '', lastReport = '', reportedAt = null;
  const role = `${handoff.role} ${handoff.agent}`;
  const flush = () => {
    if (!pending) return;
    write(`${runtime} ${role}: agent report (unverified): ${pending}\n`);
    lastReport = pending; pending = ''; reportedAt = now(); checks = 0;
  };
  return {
    start(session) {
      started = lastEvent = lastCheck = now();
      checks = 0;
      write(`${runtime} ${role}: session ${session} started; configured ${handoff.model ?? 'inherited model'}/${handoff.effort ?? 'inherited effort'}\n`);
    },
    event() { if (started !== null && !finished) lastEvent = now(); },
    report(text) {
      if (started === null || finished) return;
      const clean = displayText(text);
      if (!clean) return;
      if (clean === lastReport) { pending = ''; return; }
      if (clean === pending) return;
      pending = clean;
      if (reportedAt === null || now() - reportedAt >= ROLE_HEARTBEAT_MS) flush();
    },
    heartbeat() {
      const at = now();
      if (finished || started === null || at - lastCheck < ROLE_HEARTBEAT_MS) return;
      lastCheck = at;
      if (pending && (reportedAt === null || at - reportedAt >= ROLE_HEARTBEAT_MS)) { flush(); return; }
      if (++checks < ROLE_HEARTBEAT_CHECKS) return;
      checks = 0;
      write(`${runtime} ${role}: process running; elapsed ${duration(at - started)}; last runtime event ${duration(at - lastEvent)} ago\n`);
    },
    finish() { if (!finished) flush(); finished = true; },
  };
}
