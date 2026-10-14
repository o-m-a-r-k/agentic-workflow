// Owner identity, and the line between bookkeeping and reserved decisions (0.7.0, D4).
//
// Named failure: 0.5.0 made every owner decision (closing an implementer, choosing a runtime, lifting a hold, deferring
// a finding) wait for the owner's own words, read back from the owner session's transcript with a natural-language
// grammar (`ownerAuthority`, `adoptionRequest`, `scopeReply`, an owner-session command matcher). In the field it caught
// nothing: 46 refusals with no genuine catch, 15 of 18 phrase refusals came after the person had already said yes, and
// 283 of 304 recorded "owner decisions" were the orchestrating agent's own shell command. The engine also parsed
// transcripts for authority, which DESIGN.md principle 1 forbids.
//
// Now there are two classes, and neither reads a transcript for authority:
//
// - Bookkeeping: the owner agent records it as itself (closing an implementer, a runtime or model choice, adopting an
//   attempt whose owner session is gone, acknowledging what a delivery reported when nothing failed, a lesson waiver,
//   the statement that screenshots were shown). The ledger entry carries the caller as actor and no authority claim.
// - Reserved (engine/approve.mjs RESERVED): waiving a blocking finding, overriding a failed or skipped check, moving a
//   defect out of the delivery batch, lifting a hold, adopting an attempt whose owner session is alive. The engine
//   creates a decision; the person confirms it with `wf approve`, in their own terminal or through the question panel
//   (0.7.3, D12); the command is then run again.
//
// Threat model (docs/trust-model.md): agents are fallible, not adversarial. A shell without a terminal cannot confirm a
// decision by mistake; an agent that fakes a pseudo-terminal can, and that is the stated limit.
import fs from 'node:fs';
import { ownerTranscript } from './host-record.mjs';
import { ownerRuntime } from './hosts/index.mjs';

export { agentEnvNames } from './hosts/index.mjs';

export const isSession = (owner) => ownerRuntime(owner) !== null;

// A session is alive when its transcript was written within this window. A measurement of liveness only: it never
// grants or proves anything about who said what.
export const OWNER_ALIVE_MS = 30 * 60 * 1000;

// 'gone' (a session whose transcript is not on this machine), 'idle' (written, but not in the last 30 minutes), 'alive'
// (written in the last 30 minutes), or 'unknown' (a person-named owner has no session to measure; a transcript that exists
// but cannot be read or is ambiguous gives no answer). Only 'gone' and 'idle' let a session take over without the owner's
// `wf approve`: failing to measure never counts as dead (0.7.0 review: a person-owned attempt was adoptable by anyone).
export function ownerLiveness(owner, now = Date.now()) {
  if (!isSession(owner)) return 'unknown';
  const t = ownerTranscript(owner);
  if (t.problem) return t.gone ? 'gone' : 'unknown';
  try {
    return now - fs.statSync(t.file).mtimeMs <= OWNER_ALIVE_MS ? 'alive' : 'idle';
  } catch {
    return 'unknown';
  }
}

// Whether taking an attempt over from `owner` is the person's decision (kind adopt-live).
export const adoptNeedsApproval = (owner, now = Date.now()) => !['gone', 'idle'].includes(ownerLiveness(owner, now));
