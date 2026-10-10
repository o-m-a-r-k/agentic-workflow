// Named failure: owner chats manually coordinated every review/gate transition and ambiguous terminal result.
// Foreground only: the owning host retains this execution handle. No adoption, override, retry or delivery.
import fs from 'node:fs';
import path from 'node:path';
import { canonical as canonicalPath } from './paths.mjs';
import { randomUUID } from 'node:crypto';
import { openState } from './attempt.mjs';
import { originRuntime } from './runtime-policy.mjs';
import { blockingFindings } from './scope-decisions.mjs';
import { nextDecision, handoff, acceptReview, gateOrderCheck, outstandingReviewFindings, outsideWarning } from './lifecycle.mjs';
import { runGate } from './gate.mjs';
import { runRole } from './codex-run.mjs';
import { readRegular, prepareWrite, writeNoFollow, forget, setVerifyLevel } from './evidence.mjs';
import { isPidAlive, refuse, sessionIdentity } from './util.mjs';

export async function advance(root, options) {
  const allowed = ['_', 'attempt', 'root', 'runtime', 'json', 'once', 'until-owner', 'max-steps'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw refuse(`advance does not accept --${key}; it never overrides workflow decisions`);
  if (options._?.length > 1) throw refuse('advance takes no positional action or override');
  if (Boolean(options.once) === Boolean(options['until-owner'])) throw refuse('choose --once or --until-owner');
  if (options.runtime && !['claude', 'codex'].includes(options.runtime)) throw refuse('--runtime must be claude or codex');
  const limit = options.once ? 1 : Number(options['max-steps'] ?? 4);
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw refuse('--max-steps must be between 1 and 8');
  setVerifyLevel('full');
  const verifiedState = () => { forget(); return openState(root, { attempt: id }); };
  const initial = openState(root, options), id = initial.id, owner = initial.owner;
  const identity = sessionIdentity();
  if (/^(claude|codex):/.test(owner) && !identity) throw refuse('this session-owned attempt must be advanced from its owning chat');
  if (identity && owner !== `${identity.runtime}:${identity.session}`) throw refuse('only the owning chat advances this attempt; adopt through an interactive human request first');
  const lock = path.join(root, '.wf-worktrees', id, '_runner', 'advance.lock');
  if (canonicalPath(lock) !== path.join(fs.realpathSync(root), '.wf-worktrees', id, '_runner', 'advance.lock')) throw refuse('runner control path resolves outside its recorded location');
  prepareWrite(lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = randomUUID(), record = { pid: process.pid, token, owner };
  // A control lock never expires by age; stale locks require explicit reconciliation and cleanup.
  for (;;) {
    try { writeNoFollow(lock, JSON.stringify(record), { exclusive: true }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = readRegular(lock);
      let prior; try { prior = old && JSON.parse(old.bytes); } catch {}
      if (!Number.isInteger(prior?.pid) || prior.pid < 1 || isPidAlive(prior.pid)) throw refuse('an advance operation is already running or its lock is uncertain; retain its original execution handle');
      throw refuse('a previous runner left a control lock; reconcile its execution before explicit cleanup, never auto-recover a stale lock');
    }
  }
  const operations = [];
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const say = (text) => process.stderr.write(`wf advance: ${text}\n`);
  const result = (status, decision, exitCode = 0) => ({ attempt: id, status, operations, decision, exitCode });
  try {
    for (let n = 0; n < limit; n++) {
      const state = verifiedState();
      const decision = nextDecision(root, state);
      if (cancelled) return result('stopped', decision, 1);
      if (state.owner !== owner) return result('owner-required', { ...decision, status: 'blocked', blockers: ['attempt ownership changed'] });
      if (decision.status !== 'ready') { say(decision.blockers.join('; ') || decision.guidance); return result(operations.length ? 'advanced' : 'owner-required', decision); }
      if (decision.kind === 'review') {
        let h;
        if (decision.handoff) h = state.handoffs.find((h) => h.bundle === decision.handoff);
        else {
          const runtime = options.runtime ?? originRuntime(state) ?? identity?.runtime;
          if (!runtime) return result('owner-required', { ...decision, status: 'owner', blockers: ['choose --runtime claude or codex for the fresh reviewer'] });
          const warning = outsideWarning(root, state);
          if (warning) say(warning);
          const created = handoff(root, 'reviewer', { attempt: id, agent: `runner-${randomUUID()}`, runtime });
          h = created.state.handoffs.at(-1);
        }
        if (options.runtime && h.runtime !== options.runtime) return result('owner-required', { ...decision, status: 'owner', blockers: ['existing handoff belongs to a different runtime'] });
        say(`starting ${h.round} with ${h.runtime}; retain this execution handle`);
        const processResult = await runRole(root, { attempt: id, agent: h.agent });
        const operation = { kind: h.round, runtime: h.runtime, handoff: h.bundle, process: processResult, workflow: 'verification-pending', closure: null };
        operations.push(operation);
        const after = verifiedState();
        const review = after.reviews.filter((r) => r.handoff === h.bundle).at(-1);
        const workflow = review && outstandingReviewFindings(after).length ? 'verification-incomplete' : !review ? 'closure-missing-or-refused' : blockingFindings(after, review).length ? 'findings' : 'recorded-clean';
        Object.assign(operation, { workflow, closure: review?.raw ?? null });
        say(`${h.runtime} process ${processResult.status}; workflow ${workflow}`);
        if (after.owner !== owner || after.handoffs.filter((h) => h.role === 'reviewer').at(-1)?.bundle !== h.bundle) return result('owner-required', { ...nextDecision(root, after), status: 'blocked', blockers: ['owner or reviewer handoff changed during execution'] });
        if (processResult.status !== 'completed' || !review) return result('owner-required', nextDecision(root, after), processResult.status !== 'completed' ? 1 : 0);
      } else if (decision.kind === 'gate') {
        say('starting the normal gate');
        const gate = await runGate(root, state, { afterLock: gateOrderCheck(root, { attempt: id }), live: process.stderr });
        operations.push({ kind: 'gate', status: gate.record.status, runId: gate.record.runId });
        say(`normal gate ${gate.record.status}`);
        if (gate.record.status !== 'passed') return result('owner-required', nextDecision(root, verifiedState()), 1);
      } else if (decision.kind === 'accept') {
        acceptReview(root, { attempt: id });
        operations.push({ kind: 'accept', status: 'accepted' });
        say('accepted; delivery and presentation stay with the owning chat');
      }
    }
    return result('advanced', nextDecision(root, verifiedState()));
  } catch (error) {
    say(`stopped: ${error.message}`);
    return { attempt: id, status: 'refused', operations, error: error.message, exitCode: 75 };
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    const current = readRegular(lock);
    if (current && JSON.parse(current.bytes).token === token) fs.unlinkSync(lock);
  }
}
