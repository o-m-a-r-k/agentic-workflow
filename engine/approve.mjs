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
//
// Two ways to confirm (0.7.3, the person's choice): typed at their own terminal, or answered in the session's question
// panel, where the harness records the answer (`wf approve <id> --from-question`). Named failure: from the phone the person
// could confirm nothing, so an attempt stopped until they reached the machine.
import { noteLearned } from './learning.mjs';
import readline from 'node:readline';
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import { home } from './provenance.mjs';
import { agentEnvNames, detectOwner, findHost, optional } from './hosts/index.mjs';
import { WfError, refuse } from './util.mjs';

export const RESERVED = ['waive-finding', 'override-gate', 'move-out-of-batch', 'lift-hold', 'adopt-live', 'escalation'];

const same = (d, kind, key) => d.kind === kind && d.key === String(key);

// The newest decision for kind + key, approved or not.
export const decisionFor = (state, kind, key) => (state.decisions ?? []).filter((d) => same(d, kind, key) && !d.withdrawn).at(-1) ?? null;

// The approved choice for kind + key, or null. An approval is used once: the action that recorded it spent it
// (engine/ledger.mjs), and the next action under the same key needs a new decision.
export const approvedChoice = (state, kind, key) => {
  const d = decisionFor(state, kind, key);
  return d?.approved && !d.spent ? d.approved.choice : null;
};

export const pendingDecisions = (state) => (state.decisions ?? []).filter((d) => !d.approved && !d.withdrawn);
// The person picked one of the decision's choices. An answer in their own words (`other`) is recorded and shown, but it is no
// choice: it never acts as one (independent review of 0.7.8: words answering an escalation cleared it as `continue`).
export const chose = (d) => Boolean(d?.approved && d.approved.choice !== 'other' && !d.withdrawn);

// Records a decision the person must confirm, once per kind + key while it is pending; returns it.
// `plain`: the question in the person's words; `labels`: { choice: plain label }; `then`: { choice: what happens next };
// `recommend`: { choice, why }. Named failure (0.7.11): a strategist's escalation reached the person as its own rationale
// with options like "authorize-policy-correction", no description, no recommendation: "very cryptic … I don't have
// context, nor suggestions, nor even proper description". The choices stay the ids the engine acts on; the person sees
// and picks the labels.
export function createDecision(root, state, { kind, key, summary, choices = ['yes', 'no'], plain = null, labels = null, then = null, recommend = null, personDirected = null, what = null, options = {} }) {
  if (!RESERVED.includes(kind)) throw new WfError(`unknown reserved decision kind ${kind}`);
  const open = decisionFor(state, kind, key);
  if (open && !open.approved) return open;
  const id = `A${(state.decisions ?? []).length + 1}`;
  append(root, state.id, 'decision.created', { id, kind, key: String(key), summary: String(summary), choices: choices.map(String), ...(plain ? { plain: String(plain) } : {}), ...(labels ? { labels } : {}), ...(then ? { then } : {}), ...(recommend ? { recommend } : {}), ...(personDirected ? { personDirected: String(personDirected) } : {}), ...(what ? { what: String(what) } : {}) }, actor(options));
  return loadState(root, state.id).decisions.find((d) => d.id === id);
}

// The question the person is asked in the question panel: it names the attempt and the decision and says, in plain words
// when it has them, what it decides; its options are the decision's choices, by their plain labels when it has them.
export const questionFor = (state, d) => `${state.id} ${d.id}: ${d.plain ?? d.summary}`;
export const labelOf = (d, c) => d.labels?.[c] ?? c;
// Each option as the panel shows it: its label, what happens next, and the recommendation marked.
export const optionLines = (d) => d.choices.map((c) => `"${labelOf(d, c)}${d.recommend?.choice === c ? ' (Recommended)' : ''}"${d.then?.[c] ? `: ${d.then[c]}` : ''}`).join('; ') + (d.recommend?.why ? `. Recommended because ${d.recommend.why}` : '');

// Named failure (I-135): the question tool answered "accepted" but the person saw no panel and no way to decide, and the
// reply around it held file links and workflow words. The decision is shown in the reply itself (what it does, why, what
// remains), whatever the panel does: a tool's acceptance is no proof the person can see it. The answer counts as the panel
// recorded it, as the person's chat reply to a message that asked exactly this question (0.7.18), or as typed in their
// terminal.
const SHOW = 'say in your reply, in plain words, what this decides, why, and what happens after each choice (a question panel may not show, and its acceptance proves nothing)';
export const approveHint = (state, d) => `${SHOW}; then ask the owner in your question panel the question "${questionFor(state, d)}" with exactly these options (label, then its description): ${optionLines(d)}; and run \`wf approve ${d.id} --from-question --attempt ${state.id}\`; when the panel does not show for them (a phone, a mode without it), ask in your message instead, quoting that question exactly with its options and asking nothing else in that message, and after they reply run the same \`--from-question\` command; or they run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal (choices: ${d.choices.join(' | ')}); then run this command again`;

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
  const earlier = answered?.approved && !answered.spent ? ` (the earlier answer, ${answered.id}, was ${answered.approved.words ? `in their own words: "${answered.approved.words}"` : answered.approved.choice})` : '';
  throw refuse(`not done: ${what} is the owner's decision (${d.id}: ${d.summary})${earlier}`, approveHint(state, d), { id: `approve:${kind}` });
}

// `wf approve <id>`: the person types the choice at an interactive terminal.
export async function approveInTerminal(root, id, options, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  if (d.withdrawn) throw refuse(`${id} was withdrawn (${d.withdrawn.reason ?? ''}); the next command asks a fresh question`, null, { id: 'approve:withdrawn' });
  const agentEnv = agentEnvNames().filter((k) => env[k]);
  if (agentEnv.length) throw refuse(`\`wf approve\` runs in the owner's own terminal, not under an agent runtime (${agentEnv.join(', ')})`, `ask the person in your question panel (the question "${questionFor(state, d)}", exactly the options ${d.choices.join(' | ')}), then run \`wf approve ${id} --from-question --attempt ${state.id}\`; when the panel does not show for them (a phone, a mode without it), ask in your message instead, quoting the question exactly with its options and asking nothing else in that message, and after they reply run the same \`--from-question\` command; or they run \`wf approve ${id} --attempt ${state.id}\` in a terminal outside the agent app`, { id: 'approve:agent-env' });
  if (!input.isTTY || !output.isTTY) throw refuse(`not an interactive terminal: \`wf approve\` is run by the owner in their own terminal, where it asks them to type the choice`, `run \`wf approve ${id} --attempt ${state.id}\` in a terminal`, { id: 'approve:no-tty' });
  const preset = options.choice === undefined || options.choice === true ? null : String(options.choice);
  if (preset && !d.choices.includes(preset)) throw new WfError(`--choice ${preset}: not one of ${d.choices.join(' | ')}`);
  output.write(`${state.id} ${d.id} (${d.kind}): ${d.plain ?? d.summary}\n${d.labels || d.then ? `${d.choices.map((c) => `  ${c}: ${labelOf(d, c)}${d.then?.[c] ? ` (${d.then[c]})` : ''}${d.recommend?.choice === c ? ' [recommended]' : ''}`).join('\n')}\n` : ''}${preset ? `Type ${preset} to confirm: ` : `Type one of ${d.choices.join(' | ')}: `}`);
  const rl = readline.createInterface({ input, output, terminal: true });
  const answer = await new Promise((resolve) => {
    rl.once('line', (l) => resolve(l));
    rl.once('close', () => resolve(null));
  });
  rl.close();
  if (answer === null) throw refuse(`not confirmed (the input ended); nothing recorded`, null, { id: 'approve:eof' });
  const typed = String(answer).trim();
  const choice = preset ? (typed === preset ? preset : null) : d.choices.find((c) => c === typed || labelOf(d, c) === typed) ?? null;
  if (!choice) throw refuse(`not confirmed (typed ${JSON.stringify(typed)}); nothing recorded`, null, { id: 'approve:mismatch' });
  append(root, state.id, 'decision.approved', { id, choice, via: 'interactive-terminal (unverified)' }, actor(options));
  noteAnswer(root, state, d, choice, null);
  return { state: loadState(root, state.id), decision: id, choice };
}

// 0.7.9 (D19): what the person answered when asked whether an item may leave a delivery, kept for the project (the
// reviewers of later attempts see what this person fixes when they rate similar items; engine/learning.mjs).
function noteAnswer(root, state, d, choice, words) {
  if (d.kind !== 'move-out-of-batch' || !String(d.key ?? '').startsWith('leave:')) return;
  noteLearned(root, { kind: 'answer', attempt: state.id, choice, ...(words ? { words } : {}), summary: d.summary ?? null });
}

// `wf approve <id> --from-question`: the answer the person gave in the calling session's question panel, or their reply in
// its chat to a message that asked the decision's exact question (0.7.18), as the harness recorded it. It counts when the question names this attempt and decision and carries the decision's own summary (so the
// person saw what they confirm), offered exactly the decision's choices (when the harness records the options), and was
// answered after the decision was created; the latest such answer is the person's. Nothing else in the transcript is read.
// Its stated limit, as for the tracker readback: the host's record, not a signature (docs/trust-model.md).
export async function approveFromQuestion(root, id, options, { env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  if (d.withdrawn) throw refuse(`${id} was withdrawn (${d.withdrawn.reason ?? ''}); the next command asks a fresh question`, null, { id: 'approve:withdrawn' });
  if (options.choice !== undefined && options.choice !== true) throw new WfError('--choice is for the terminal; with --from-question the choice is the one the person picked in the panel');
  const question = questionFor(state, d);
  const how = `${SHOW}; ask again in your question panel (the question "${question}" with exactly these options: ${optionLines(d)}) and run this again. When the panel does not show for them (a phone, a mode without it), ask in your message instead: quote the question exactly, list the options, ask nothing else in that message, and run this again after they reply; or they run \`wf approve ${id} --attempt ${state.id}\` in their own terminal`;
  const caller = detectOwner(env);
  const host = caller ? findHost(caller.runtime) : null;
  const read = optional(host, 'questionAnswers');
  const chat = optional(host, 'chatAnswers');
  if (!caller || !read) throw refuse(`--from-question reads the question panel of the agent session that runs it, and this is not a session whose harness records one`, `the person runs \`wf approve ${id} --attempt ${state.id}\` in their own terminal`, { id: 'approve:no-panel' });
  const t = optional(host, 'transcriptFile')?.(caller.session, { home: home() });
  if (!t?.file) throw refuse(`this session's transcript cannot be read (${t?.problem ?? 'no transcript'}), so its question panel cannot be`, `the person runs \`wf approve ${id} --attempt ${state.id}\` in their own terminal`, { id: 'approve:no-panel' });
  const created = Date.parse(d.createdAt);
  // A label may carry the panel's recommendation suffix ("yes (Recommended)"); the choice is the label without it.
  const norm = (x) => String(x).trim().replace(/\s*\(recommended\)$/i, '').trim().toLowerCase();
  const offered = (opts) => !opts || (opts.length === d.choices.length && d.choices.every((c) => opts.some((o) => norm(o) === norm(c) || norm(o) === norm(labelOf(d, c)))));
  // The question carries the exact text, as a whole: `ENG-1.1 A1: ...` never matches inside `ENG-1.1 A10: ...` or
  // `XENG-1.1 A1: ...` (independent review of 0.7.3). It was asked, and answered, after the decision existed.
  const carries = (q) => {
    const at = q.indexOf(question);
    return at >= 0 && (at === 0 || /\s/.test(q[at - 1]));
  };
  const after = (x) => Number.isFinite(Date.parse(x)) && Date.parse(x) >= created;
  // A chat reply binds to this decision only when the message it answers asks this question and no other open one of the
  // attempt, so a "yes" can answer only one decision.
  const others = (state.decisions ?? []).filter((x) => x.id !== d.id && !x.approved && !x.withdrawn).map((x) => questionFor(state, x));
  const alone = (a) => a.channel !== 'chat' || !others.some((q) => {
    const at = a.question.indexOf(q);
    return at >= 0 && (at === 0 || /\s/.test(a.question[at - 1]));
  });
  const answers = [...(await read(t.file)), ...(chat ? await chat(t.file) : [])];
  const bound = answers.filter((a) => carries(a.question) && alone(a) && offered(a.options) && after(a.at) && (a.askedAt == null || after(a.askedAt))).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const last = bound.at(-1);
  if (!last) throw refuse(`no answer to ${d.id} in this session's question panel, or in its chat to a message asking exactly its question, after the decision was created`, how, { id: 'approve:no-answer' });
  // A chat reply chooses by its first words ("yes, go ahead" is yes); the panel's answer is the option itself.
  const leads = (c) => [c, labelOf(d, c)].map(norm).filter((l) => l && (norm(last.answer) === l || (last.channel === 'chat' && norm(last.answer).startsWith(l) && /^[^\p{L}\p{N}]/u.test(norm(last.answer).slice(l.length)))));
  const choice = d.choices.filter((c) => leads(c).length).sort((x, y) => Math.max(...leads(y).map((l) => l.length)) - Math.max(...leads(x).map((l) => l.length)))[0] ?? null;
  // An answer in the person's own words (the panel's free-text option) is theirs: recorded as `other` with the words, so the
  // question is answered and the owner follows the words; it grants nothing a choice would (0.7.8: it left the question
  // open for ever).
  const words = choice ? null : String(last.answer).trim().slice(0, 2000);
  if (!choice && !words) throw refuse(`the person's answer to ${d.id} is empty; nothing recorded`, how, { id: 'approve:mismatch' });
  append(root, state.id, 'decision.approved', { id, choice: choice ?? 'other', ...(words ? { words } : {}), via: `${last.channel === 'chat' ? 'chat' : 'question-panel'} (${host.label}, host-recorded)`, question: { text: last.question.slice(0, 2000), at: last.at, askedAt: last.askedAt } }, actor(options));
  noteAnswer(root, state, d, choice ?? 'other', words);
  return { state: loadState(root, state.id), decision: id, choice: choice ?? 'other', words };
}

export const decisionLine = (d) => `${d.id}  ${d.kind}  ${d.withdrawn ? `withdrawn: ${d.withdrawn.reason ?? ''}` : d.approved ? `decided: ${d.approved.words ? `in their words: "${d.approved.words}"` : d.approved.choice}${d.spent ? ' (used)' : ''}` : `pending (${d.choices.join(' | ')})`}  ${d.summary}`;

// `wf decisions withdraw <id> --reason`: the owner takes back a question whose subject changed (a pending one, or one
// answered and not yet used), so it is not asked or read any more. It grants nothing; the next command asks afresh.
export function withdrawDecision(root, id, options) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.withdrawn) throw refuse(`${id} is already withdrawn`);
  if (d.spent) throw refuse(`${id} was already used by the action it allowed; nothing to withdraw`);
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!reason) throw new WfError('--reason says what changed');
  append(root, state.id, 'decision.withdrawn', { id, reason }, actor(options));
  return loadState(root, state.id);
}
