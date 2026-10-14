import os from 'node:os';
import { findHost, optional } from './hosts/index.mjs';

// Where a runtime's transcripts are available, a review round (or a plan taken with --from-agent) must come from the
// agent the engine handed the work to, started with exactly the line `wf handoff` printed. Named failures: a steered
// reviewer (extra prompt text), and a review round run outside the engine under a reused name.

export const home = () => process.env.WF_HOME ?? os.homedir();
export const startPromptFor = (bundle) => `Read ${bundle} and follow its instructions.`;

// → { status: 'verified', transcript, identity } | { status: 'unverified', reason } | { status: 'mismatch', reason }
// The harness adapter judges its own transcripts; a harness whose roles leave none the workflow can read is unverified.
export function verifyAgent(handoff) {
  const verify = optional(findHost(handoff.runtime), 'verifyRole');
  if (!verify) return { status: 'unverified', reason: `no transcripts are read for runtime ${handoff.runtime}` };
  return verify(handoff, { home: home(), startPrompt: handoff.startPrompt ?? startPromptFor(handoff.bundle) });
}
