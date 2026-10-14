// The owner's reserved decisions, confirmed by the person in their own terminal (0.7.0, D4).
//
// Named failures: the owner-phrase grammar (engine/owner.mjs) recognised the owner's English with regular expressions.
// It refused real approvals (in 15 of 18 sampled refusals the person had already said yes) and made the person retype
// phrases, while 283 of 304 recorded "owner decisions" were the orchestrating agent's own shell command. It caught
// nothing. A reserved decision is now an engine-created record that the person confirms by typing its choice at an
// interactive terminal. Threat model (docs/trust-model.md): agents are fallible, not adversarial. An agent's shell has
// no terminal, so it cannot confirm by mistake; a pseudo-terminal can, and that is the stated limit.
//
// Reserved: waiving a blocking finding, overriding a failed gate, moving a defect the change caused (or one on a
// critical boundary) out of the delivery batch, lifting a hold, adopting an attempt whose owner session is alive.
// Everything else is the owner agent's or the strategist's recorded decision.
import readline from 'node:readline';
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import { agentEnvNames } from './hosts/index.mjs';
import { WfError, refuse } from './util.mjs';

export const RESERVED = ['waive-finding', 'override-gate', 'move-out-of-batch', 'lift-hold', 'adopt-live', 'escalation'];

const same = (d, kind, key) => d.kind === kind && d.key === String(key);

// The newest decision for kind + key, approved or not.
export const decisionFor = (state, kind, key) => (state.decisions ?? []).filter((d) => same(d, kind, key)).at(-1) ?? null;

// The approved choice for kind + key, or null. An approval is used once: the action that recorded it spent it
// (engine/ledger.mjs), and the next action under the same key needs a new decision.
export const approvedChoice = (state, kind, key) => {
  const d = decisionFor(state, kind, key);
  return d?.approved && !d.spent ? d.approved.choice : null;
};

export const pendingDecisions = (state) => (state.decisions ?? []).filter((d) => !d.approved);

// Records a decision the person must confirm, once per kind + key while it is pending; returns it.
export function createDecision(root, state, { kind, key, summary, choices = ['yes', 'no'], options = {} }) {
  if (!RESERVED.includes(kind)) throw new WfError(`unknown reserved decision kind ${kind}`);
  const open = decisionFor(state, kind, key);
  if (open && !open.approved) return open;
  const id = `A${(state.decisions ?? []).length + 1}`;
  append(root, state.id, 'decision.created', { id, kind, key: String(key), summary: String(summary), choices: choices.map(String) }, actor(options));
  return loadState(root, state.id).decisions.find((d) => d.id === id);
}

export const approveHint = (state, d) => `ask the owner to run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal (choices: ${d.choices.join(' | ')}); then run this command again`;

// A yes/no reserved decision that must be answered `yes` (0.7.0). Named failure: `requireApproved` returns whatever
// choice was approved, so an answer of `no` read as an approval at a caller that only tested for a value. A `no` refuses,
// and the next call asks a new question rather than reading the old answer for ever. Returns { decision: <id> }.
// The person's answer `deliver-core` to the round escalation (engine/strategy.mjs): what the criteria need and what blocks
// stays, and every other finding or discovered issue may leave the delivery under that one decision. Null otherwise.
// It covers what was recorded before the person answered (`raisedAt`, an ISO time): never a finding raised after it
// (second final review of 0.7.0: a critical finding raised later left under it unasked).
export const deliverCoreDecision = (state, raisedAt = null) => (state.decisions ?? []).filter((d) => d.kind === 'escalation' && String(d.key).startsWith('tripwire:') && d.approved?.choice === 'deliver-core' && raisedAt && d.approved.at && raisedAt <= d.approved.at).at(-1) ?? null;

export function requireYes(root, state, { kind, key, summary, what, options = {} }) {
  const answered = decisionFor(state, kind, key);
  if (answered?.approved?.choice === 'yes' && !answered.spent) return { decision: answered.id };
  const d = createDecision(root, state, { kind, key, summary, options });
  const earlier = answered?.approved && !answered.spent ? ` (the earlier answer, ${answered.id}, was ${answered.approved.choice})` : '';
  throw refuse(`not done: ${what} is the owner's decision (${d.id}: ${d.summary})${earlier}`, approveHint(state, d), { id: `approve:${kind}` });
}

// `wf approve <id>`: the person types the choice at an interactive terminal.
export async function approveInTerminal(root, id, options, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  const agentEnv = agentEnvNames().filter((k) => env[k]);
  if (agentEnv.length) throw refuse(`\`wf approve\` runs in the owner's own terminal, not under an agent runtime (${agentEnv.join(', ')})`, `open a terminal outside the agent app and run \`wf approve ${id} --attempt ${state.id}\``, { id: 'approve:agent-env' });
  if (!input.isTTY || !output.isTTY) throw refuse(`not an interactive terminal: \`wf approve\` is run by the owner in their own terminal, where it asks them to type the choice`, `run \`wf approve ${id} --attempt ${state.id}\` in a terminal`, { id: 'approve:no-tty' });
  const preset = options.choice === undefined || options.choice === true ? null : String(options.choice);
  if (preset && !d.choices.includes(preset)) throw new WfError(`--choice ${preset}: not one of ${d.choices.join(' | ')}`);
  output.write(`${state.id} ${d.id} (${d.kind}): ${d.summary}\n${preset ? `Type ${preset} to confirm: ` : `Type one of ${d.choices.join(' | ')}: `}`);
  const rl = readline.createInterface({ input, output, terminal: true });
  const answer = await new Promise((resolve) => {
    rl.once('line', (l) => resolve(l));
    rl.once('close', () => resolve(null));
  });
  rl.close();
  if (answer === null) throw refuse(`not confirmed (the input ended); nothing recorded`, null, { id: 'approve:eof' });
  const typed = String(answer).trim();
  const choice = preset ? (typed === preset ? preset : null) : d.choices.find((c) => c === typed) ?? null;
  if (!choice) throw refuse(`not confirmed (typed ${JSON.stringify(typed)}); nothing recorded`, null, { id: 'approve:mismatch' });
  append(root, state.id, 'decision.approved', { id, choice, via: 'interactive-terminal (unverified)' }, actor(options));
  return { state: loadState(root, state.id), decision: id, choice };
}

export const decisionLine = (d) => `${d.id}  ${d.kind}  ${d.approved ? `decided: ${d.approved.choice}${d.spent ? ' (used)' : ''}` : `pending (${d.choices.join(' | ')})`}  ${d.summary}`;
