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
import { ASK_SHAPE, askFirst, askProblems, composeAsk, frameLabels, itemWords, readAsk } from './asking.mjs';

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

// The person's answer to an escalation whose chosen option settles this item (0.7.23, D29: the option named the open items
// it decides, and the person read that it does), or null. Only items named when the escalation was created: never one raised
// after it (as for `deliver-core`).
export const settledBy = (state, ref) => (state.decisions ?? []).filter((d) => d.kind === 'escalation' && chose(d) && (d.settles?.[d.approved.choice] ?? []).includes(ref)).at(-1) ?? null;

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
// 0.7.23 (D29, engine/asking.mjs): `context` and `technical` are the owner agent's words the question carries (`plain` is the
// whole question as asked); `items` is the plain line per item a question names ({ ref: { what, fix } }); `settles` is, per
// choice of an escalation, the open items that choice decides with it ({ choice: [ref] }), so they are not asked again.
export function createDecision(root, state, { kind, key, summary, choices = ['yes', 'no'], plain = null, labels = null, then = null, recommend = null, context = null, technical = null, items = null, settles = null, personDirected = null, what = null, options = {} }) {
  if (!RESERVED.includes(kind)) throw new WfError(`unknown reserved decision kind ${kind}`);
  const open = decisionFor(state, kind, key);
  if (open && !open.approved) return open;
  const id = `A${(state.decisions ?? []).length + 1}`;
  append(root, state.id, 'decision.created', { id, kind, key: String(key), summary: String(summary), choices: choices.map(String), ...(plain ? { plain: String(plain) } : {}), ...(labels ? { labels } : {}), ...(then ? { then } : {}), ...(recommend ? { recommend } : {}), ...(context ? { context: String(context) } : {}), ...(technical ? { technical: String(technical) } : {}), ...(items && Object.keys(items).length ? { items } : {}), ...(settles && Object.keys(settles).length ? { settles } : {}), ...(personDirected ? { personDirected: String(personDirected) } : {}), ...(what ? { what: String(what) } : {}) }, actor(options));
  return loadState(root, state.id).decisions.find((d) => d.id === id);
}

// The question the person is asked in the question panel: it names the attempt and the decision and says, in plain words
// when it has them, what it decides; its options are the decision's choices, by their plain labels when it has them.
export const questionFor = (state, d) => `${state.id} ${d.id}: ${d.plain ?? d.summary}`;
export const labelOf = (d, c) => d.labels?.[c] ?? c;
// Each option as the panel shows it: its label, what happens next, and the recommendation marked.
// A question written since 0.7.23 says its recommendation itself (engine/asking.mjs); an earlier one has it after the options.
export const optionLines = (d) => d.choices.map((c) => `"${labelOf(d, c)}${d.recommend?.choice === c ? ' (Recommended)' : ''}"${d.then?.[c] ? `: ${d.then[c]}` : ''}`).join('; ') + (d.recommend?.why && !/ (Recommended|No recommendation): /.test(d.plain ?? '') ? `. Recommended because ${d.recommend.why}` : '');

// Named failure (I-135): the question tool answered "accepted" but the person saw no panel and no way to decide, and the
// reply around it held file links and workflow words. The decision is shown in the reply itself (what it does, why, what
// remains), whatever the panel does: a tool's acceptance is no proof the person can see it. The answer counts as the panel
// recorded it, as the person's chat reply to a message that asked exactly this question (0.7.18), as the agent read their words
// and quoted them (0.7.27, D41), or as typed in their terminal.
export const SHOW_TEXT = 'say in your reply, in plain words, what this decides, why, and what happens after each choice (a question panel may not show, and its acceptance proves nothing)';
// How the agent records an answer (0.7.27, D41): one that is exactly an option by itself; any other as its reading, with the words.
export const READ_LINE = 'when an answer is more than one option\'s name, read it yourself and add `--choice <choice> --quote "<their words>"` (`--choice other` keeps words that choose no option as theirs), then tell them in that reply what you recorded and from which words';
export const afterAnswer = (state, d) => `run \`wf approve ${d.id} --from-question --attempt ${state.id}\` (${READ_LINE})`;
export const approveHint = (state, d) => `${SHOW_TEXT}; then ask them in your message, so they can simply type their answer: quote the question "${questionFor(state, d)}" exactly with these options (label, then what follows it): ${optionLines(d)}, and ask nothing else in that message (end your turn with it). You may also show the same question and options in your question panel: a typed reply and a panel answer both count. After they answer, ${afterAnswer(state, d)}; or they run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal (choices: ${d.choices.join(' | ')}); then run this command again. Until they answer, any reply of yours that mentions this decision (a status, what remains) asks it in this form; one that describes it in your own words leaves it unasked`;

// A yes/no reserved decision that must be answered `yes` (0.7.0). Named failure: `requireApproved` returns whatever
// choice was approved, so an answer of `no` read as an approval at a caller that only tested for a value. A `no` refuses,
// and the next call asks a new question rather than reading the old answer for ever. Returns { decision: <id> }.
// The person's answer `deliver-core` to the round escalation (engine/strategy.mjs): what the criteria need and what blocks
// stays, and every other finding or discovered issue may leave the delivery under that one decision. Null otherwise.
// It covers what was recorded before the person answered (`raisedAt`, an ISO time): never a finding raised after it
// (second final review of 0.7.0: a critical finding raised later left under it unasked).
export const deliverCoreDecision = (state, raisedAt = null) => (state.decisions ?? []).filter((d) => d.kind === 'escalation' && String(d.key).startsWith('tripwire:') && d.approved?.choice === 'deliver-core' && raisedAt && d.approved.at && raisedAt <= d.approved.at).at(-1) ?? null;

// `frame` (0.7.23, D29): the engine's side of the person's question, { question, labels, then } for the choices yes and no;
// `items`, the refs the question names, each needing the agent's plain line. The agent's side comes with `--ask` (engine/
// asking.mjs); without it nothing is created and the refusal says what to write. A question still pending from before
// keeps its words; the agent may withdraw it and ask again with `--ask`.
export function requireYes(root, state, { kind, key, summary, what, frame = null, items = [], ask: given, options = {} }) {
  const answered = decisionFor(state, kind, key);
  if (answered?.approved?.choice === 'yes' && !answered.spent) return { decision: answered.id };
  // The person's other answer stands: the same question is not asked again (0.7.23, the person's rule: "i don't want the same
  // question asked multiple times"; before, every run after a "no" asked it afresh). When something changed, the owner
  // withdraws the answer with what changed, and the next run asks a new question.
  if (answered?.approved && !answered.spent) throw refuse(`not done: ${what}: the person answered ${answered.id} ${answered.approved.words ? `in their own words, "${answered.approved.words}"` : `"${labelOf(answered, answered.approved.choice)}"`}`, `follow their answer; it is not asked again. If something changed since they answered, withdraw it with what changed (\`wf decisions withdraw ${answered.id} --attempt ${state.id} --reason "<what changed>"\`) and run this command again`, { id: 'approve:answered' });
  const choices = ['yes', 'no'];
  let words = {};
  if (frame && !(answered && !answered.approved)) {
    // `ask`: the words already read for this question (one item of a command that words several), else `--ask`.
    const ask = given !== undefined ? given : readAsk(options);
    const problems = askProblems(ask, { choices, labels: frame.labels, items });
    if (problems.length) throw askFirst(what, frame, choices, problems, summary, { items });
    words = composeAsk(ask, frame, choices, { items: items.map((ref) => ({ ref, ...itemWords(ask, null, ref) })), itemNoun: frame.itemNoun });
  }
  const d = createDecision(root, state, { kind, key, summary, ...words, options });
  const unworded = !d.plain ? `; it was created without plain words for the person: withdraw it (\`wf decisions withdraw ${d.id} --attempt ${state.id} --reason "reworded for the person"\`) and run this command again with \`--ask <file>\` (${ASK_SHAPE})` : '';
  throw refuse(`not done: ${what} is the owner's decision (${d.id}: ${d.summary})`, `${approveHint(state, d)}${unworded}`, { id: `approve:${kind}` });
}

// 0.7.27 (I-186). Named failure (field): a question the owner withdrew was shown to the owner as the thing to approve, and
// `wf approve` refused it with no way on. A withdrawn question has no answer to give: `wf resume` names what happens next (the
// command that asks it afresh, or, for a strategist's escalation, the decision that supersedes it).
const withdrawnHint = (state) => `nothing is answered for a withdrawn question; \`wf resume --attempt ${state.id}\` names the step that asks it afresh or supersedes it`;

// `wf approve <id>`: the person types the choice at an interactive terminal.
export async function approveInTerminal(root, id, options, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  if (d.withdrawn) throw refuse(`${id} was withdrawn (${d.withdrawn.reason ?? ''}); the next command asks a fresh question`, withdrawnHint(state), { id: 'approve:withdrawn' });
  if (options.quote !== undefined) throw new WfError('--quote goes with --from-question: the person\'s words the agent read in its session, with --choice');
  const agentEnv = agentEnvNames().filter((k) => env[k]);
  if (agentEnv.length) throw refuse(`\`wf approve\` runs in the owner's own terminal, not under an agent runtime (${agentEnv.join(', ')})`, `in this same reply, ask them in your message, quoting the question "${questionFor(state, d)}" exactly with its options (${optionLines(d)}) and asking nothing else in that message, so they can type the answer (you may also show it in your question panel: either answer counts); after they answer, ${afterAnswer(state, d)}; or they run \`wf approve ${id} --attempt ${state.id}\` in a terminal outside the agent app`, { id: 'approve:agent-env' });
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
  const choice = preset ? (typed === preset ? preset : null) : d.choices.find((c) => c === typed || labelOf(d, c) === typed) ?? exactChoice(d, typed);
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

// The choice a reply makes by itself (0.7.23, D29; 0.7.27, D41). The person's rule (2026-10-16): "why are you stopping me from
// just typing no, why do i have to answer the questionnaire? both should be accepted": a typed reply counts like a panel answer.
// Named failure (0.7.27, an independent review of the first fix for I-192): reading a reply's meaning with patterns could not be
// made right in either direction. It recorded yes for replies the person did not mean ("close it. NO.", "close it if the deploy
// is fine", "she told me to close it, but I disagree", "maybe close it", "lift the pause on" another ticket, "I refuse to ship it
// as is"), refused or misfiled clear ones ("proceed", "go for it", "the first one", "ok do it"), and recorded a stray question
// back ("is it on main?") as the person's own words, which then stood in the way of their real answer; every round of patterns
// opened new holes. The engine now records by itself only a reply that is exactly one option: its choice, its label (for a
// question an earlier release asked without labels, the labels of its frame, read from its kind and key: engine/asking.mjs), or
// for a yes or no question a bare yes or no word. Case, spacing, a trailing "." or "!" and the panel's "(Recommended)" aside;
// nothing else. Every other reply is read by the agent, which has the whole conversation, and recorded with the words it relies
// on (`--choice` with `--quote`, below). `bare`: whether a bare yes or no word counts (not when the message did not quote the
// question: it says nothing about which question it answers); `ids`: whether a choice's id counts, per choice.
const norm = (x) => String(x).replace(/[\u2018\u2019\u02bc]/g, "'").trim().replace(/\s*\(recommended\)$/i, '').trim().toLowerCase();
const whole = (x) => norm(x).replace(/\s+/g, ' ').replace(/[\s.!]+$/u, '').replace(/\s*\(recommended\)$/i, '').trim();
const BARE = {
  yes: ['yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'sure', 'go ahead', 'do it', 'go for it', 'proceed', 'confirm', 'confirmed', 'approve', 'approved', 'accept', 'accepted', 'agreed'],
  no: ['no', 'n', 'nope', 'nah', 'decline', 'declined', 'reject', 'rejected'],
};
const isYesNo = (d) => d.choices.length === 2 && d.choices.includes('yes') && d.choices.includes('no');
const labelsOf = (d, c) => [...new Set([labelOf(d, c), ...(frameLabels(d)[c] ?? [])])];
// A choice in plain words: the label the question showed, else its frame's (a question an earlier release asked), else its id.
export const plainLabel = (d, c) => d.labels?.[c] ?? frameLabels(d)[c]?.[0] ?? c;
export function exactChoice(d, text, { bare = true, ids = () => true } = {}) {
  const reply = whole(text ?? '');
  if (!reply) return null;
  const names = (c) => [...(ids(c) ? [c] : []), ...labelsOf(d, c), ...(bare && isYesNo(d) ? BARE[c] : [])].map(whole).filter(Boolean);
  const hits = d.choices.filter((c) => names(c).includes(reply));
  return hits.length === 1 ? hits[0] : null;
}
export const optionNamed = (d, text) => {
  const t = norm(text);
  return d.choices.some((c) => labelsOf(d, c).some((l) => {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${norm(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    return m.test(t);
  }));
};

// Whether the words the agent relies on are verbatim in a message of the person's (0.7.27, D41): the same characters, case,
// spacing and typographic quotes aside, starting and ending on a word's edge ("yes" is not in "yesterday").
const fold = (x) => String(x ?? '').normalize('NFKC').replace(/[\u2018\u2019\u02bc\u2032]/g, "'").replace(/[\u201c\u201d\u2033]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const wordy = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
function holds(message, quote) {
  const t = fold(message);
  const q = fold(quote);
  if (!q || !/[\p{L}\p{N}]/u.test(q)) return false;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    const end = at + q.length;
    if ((!wordy(q[0]) || !wordy(t[at - 1])) && (!wordy(q.at(-1)) || !wordy(t[end]))) return true;
  }
  return false;
}
const unwrap = (q) => {
  const m = /^\s*(["'\u201c\u2018])([\s\S]*)(["'\u201d\u2019])\s*$/.exec(q);
  return m ? m[2] : null;
};

// What the agent does when an answer is refused: it asks the question now, in the same reply, in the form that binds (0.7.27,
// I-192). Named failure (field): after `wf approve --from-question` refused, the agent recorded an improvement and ended its
// turn having asked nothing, and the person waited a day on a question that was never put to them again.
const askNowHint = (state, d) => `${SHOW_TEXT}; then, in this same reply (this refusal never ends your turn with the question unasked), ask them in your message, quoting the question "${questionFor(state, d)}" exactly with its options (${optionLines(d)}) and asking nothing else in that message, so they can type the answer (you may also show it in your question panel: a typed reply and a panel answer both count), and run this again after they answer; or they run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal`;
// The options as `--choice` names them.
const choiceList = (d) => d.choices.map((c) => `${c}${plainLabel(d, c) !== c ? ` "${plainLabel(d, c)}"` : ''}`).join(', ');
// How the agent records what it read (0.7.27, D41): the words are the person's, the reading is the agent's, and the person sees it
// at once, so a misreading is corrected in their next message. What is not a choice is listed, so it is asked about, not read in.
export const READ_FORM = (state, d) => `\`wf approve ${d.id} --from-question --attempt ${state.id} --choice <choice> --quote "<their words, exactly as they typed them>"\``;
export const NOT_A_CHOICE = 'a condition ("if the deploy is fine", "tomorrow"), a hedge ("maybe", "I think we could"), a later sentence that takes it back ("close it. not yet"), someone else\'s words reported ("she told me to close it"), words about something else ("the dialog needs a button to close it"), or the action meant for another ticket';
const readHint = (state, d) => `read their words yourself (you have the whole conversation): when they choose one of its options (${choiceList(d)}), record it with ${READ_FORM(state, d)}; when they answer it in their own words that choose no option, \`--choice other\` with their words records them as theirs (they grant nothing a choice would); then tell them in that same reply what you recorded and from which words. Words that choose nothing are no answer: ${NOT_A_CHOICE}; for those, and only for those, ${askNowHint(state, d)}. A question they already answered is never put to them a second time`;

// `wf approve <id> --from-question`: the answer the person gave in the calling session's question panel, or their reply in its
// chat, as the harness recorded it (0.7.3, D12; 0.7.18, D26). It binds by itself when the question names this attempt and
// decision and carries its summary (so the person saw what they confirm), offered exactly the decision's choices (when the harness
// records the options), was asked and answered after the decision was created, and the answer is exactly one option; the latest
// such answer is the person's. 0.7.27 (D41): every other answer is the agent's to read, and `--choice <choice> --quote "<words>"`
// records its reading: the engine proves the words are verbatim in one of the person's own messages in this session's host
// transcript (their typed messages and panel answers; never the agent's text, a tool's output, a harness note or a sub-agent's
// thread), written after the decision existed and not followed by an exact answer of theirs, and that the choice is one of the
// decision's options or `other` (the person's own words, recorded as theirs). The reading is the agent's: the decision records
// the words, the whole message, the agent's message it answered and that the agent read it.
// Its stated limit, as for the tracker readback: the host's record, not a signature (docs/trust-model.md).
export async function approveFromQuestion(root, id, options, { env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  if (d.withdrawn) throw refuse(`${id} was withdrawn (${d.withdrawn.reason ?? ''}); the next command asks a fresh question`, withdrawnHint(state), { id: 'approve:withdrawn' });
  const given = (v) => v !== undefined && v !== true && String(v).trim() !== '';
  if (given(options.quote) && !given(options.choice)) throw new WfError('--quote goes with --choice: the option the person\'s words choose (or other, for their own words)');
  if (given(options.choice) && !given(options.quote)) throw new WfError(`--choice with --from-question records your reading of the person's words: add --quote "<their words>" (the words of theirs it relies on, exactly as they typed them)`);
  const reading = given(options.choice) ? { choice: String(options.choice).trim(), quote: String(options.quote) } : null;
  const question = questionFor(state, d);
  const how = askNowHint(state, d);
  const caller = detectOwner(env);
  const host = caller ? findHost(caller.runtime) : null;
  const read = optional(host, 'questionAnswers');
  const chat = optional(host, 'chatAnswers');
  if (!caller || !read) throw refuse(`--from-question reads the question panel of the agent session that runs it, and this is not a session whose harness records one`, `the person runs \`wf approve ${id} --attempt ${state.id}\` in their own terminal`, { id: 'approve:no-panel' });
  const t = optional(host, 'transcriptFile')?.(caller.session, { home: home() });
  if (!t?.file) throw refuse(`this session's transcript cannot be read (${t?.problem ?? 'no transcript'}), so its question panel cannot be`, `the person runs \`wf approve ${id} --attempt ${state.id}\` in their own terminal`, { id: 'approve:no-panel' });
  const created = Date.parse(d.createdAt);
  // A label may carry the panel's recommendation suffix ("yes (Recommended)"); the choice is the label without it (`norm`).
  const offered = (opts) => !opts || (opts.length === d.choices.length && d.choices.every((c) => opts.some((o) => norm(o) === norm(c) || norm(o) === norm(labelOf(d, c)))));
  // The question carries the exact text, as a whole: `ENG-1.1 A1: ...` never matches inside `ENG-1.1 A10: ...` or
  // `XENG-1.1 A1: ...` (independent review of 0.7.3), and may sit in quotes, bold or code, as the engine's hints show it
  // (independent review of 0.7.18). It was asked, and answered, after the decision existed.
  const carriesText = (text, q) => {
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + 1)) if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return true;
    return false;
  };
  const carries = (q) => carriesText(q, question);
  const after = (x) => Number.isFinite(Date.parse(x)) && Date.parse(x) >= created;
  const time = (a) => Date.parse(a.at) || 0;
  const latest = (xs) => [...xs].sort((x, y) => time(x) - time(y)).at(-1) ?? null;
  // A chat reply binds to this decision only when the message it answers asks this question and no other: no other open
  // decision of the attempt, and no other decision named the engine's way (`<attempt> A<n>:`, of any attempt), so a "yes" can
  // answer only one decision.
  const others = (state.decisions ?? []).filter((x) => x.id !== d.id && !x.approved && !x.withdrawn).map((x) => questionFor(state, x));
  // An attempt id is `<item>.<n>` (engine/attempt.mjs), so "decision A1:" in the agent's own words is no decision's key.
  const named = (text) => new Set([...text.matchAll(/(?<![\p{L}\p{N}._-])([\p{L}\p{N}][\p{L}\p{N}._-]*\.\d+ A\d+):/gu)].map((m) => m[1]));
  const alone = (a) => a.channel !== 'chat' || (!others.some((q) => carriesText(a.question, q)) && [...named(a.question)].every((k) => k === `${state.id} ${d.id}`) && (a.panels ?? []).every((x) => !carriesText(x.text, question) || offered(x.options)));
  const panelAnswers = await read(t.file);
  const answers = [...panelAnswers, ...(chat ? await chat(t.file) : [])];
  // Every answer to the question asked exactly: the panel's, and each chat reply to a message that carried it.
  const asked = answers.filter((a) => carries(a.question) && alone(a) && offered(a.options) && after(a.at) && (a.askedAt == null || after(a.askedAt)));
  // 0.7.23: a chat reply to a message that explained the question in the session's own words binds when that message names
  // this decision by its id (`<attempt> <id>`) and no other, was written after the decision existed, the reply is exactly an
  // option's label (or a choice other than yes and no, when the message showed a label), and it is the attempt's only open
  // question. A message that never named the decision binds no reply: a "stop" or "continue" said about something else is
  // never the person's answer to it (independent security review of 0.7.23).
  const key = new RegExp(`(?<![\\p{L}\\p{N}._-])${state.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${d.id}(?![\\p{N}])`, 'u');
  const namesOnlyThis = (text) => key.test(text) && [...named(text)].every((k) => k === `${state.id} ${d.id}`);
  const unquotedIds = (a) => (c) => !['yes', 'no'].includes(c) && optionNamed(d, a.question);
  const unquoted = others.length || asked.length ? [] : answers.filter((a) => a.channel === 'chat' && !carries(a.question) && namesOnlyThis(a.question) && after(a.at) && a.askedAt != null && after(a.askedAt) && exactChoice(d, a.answer, { bare: false, ids: unquotedIds(a) })).map((a) => ({ ...a, unquoted: true }));
  const exactOf = (a) => (a.unquoted ? exactChoice(d, a.answer, { bare: false, ids: unquotedIds(a) }) : exactChoice(d, a.answer));
  // The person's latest answer to the question decides: when it is exactly one option, it is recorded as it is; any other is
  // the agent's to read, and an earlier exact answer never outranks it (a "yes" is not recorded over a later "wait, not yet").
  const last = latest([...asked, ...unquoted]);
  const recordable = latest([...asked, ...unquoted].filter((a) => exactOf(a)));
  // The person's own messages: what they typed in the chat (a reply after no message of the agent's too) and what they answered
  // in the question panel, as the harness recorded them; never the agent's text, a tool's output, a harness note or a
  // sub-agent's thread (engine/hosts/questions.mjs).
  const theirs = answers.filter((a) => typeof a.answer === 'string' && a.answer.trim()).map((a) => ({ ...a, how: a.channel === 'chat' ? 'chat' : 'question-panel' }));
  const clip = (x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 300);
  if (reading) return recordReading(root, state, d, options, { reading, theirs, after, recordable, exactOf, host, how, clip });
  if (!last || !exactOf(last)) {
    const since = latest(theirs.filter((a) => after(a.at)));
    const base = `no answer to ${d.id} in this session's question panel, or in its chat to a message asking exactly its question, after the decision was created`;
    if (!since) throw refuse(`${base}: the person has written nothing in this session since it was created`, how, { id: 'approve:no-answer' });
    const where = (a) => (a.how === 'question-panel' ? 'their answer in the question panel' : carries(a.question ?? '') ? 'a reply to your message that asked it' : namesOnlyThis(a.question ?? '') ? 'a reply to your message that named it' : 'a reply to a message that did not ask it');
    const toIt = last && !(last.at === since.at && last.answer === since.answer) ? `; ${last.channel === 'chat' ? 'their reply to your message that asked it' : 'their answer to it in the question panel'}: "${clip(last.answer)}"` : '';
    throw refuse(`${base}: the engine records by itself only a reply that is exactly one of its options; the person's latest words since then: "${clip(since.answer)}" (${where(since)})${toIt}`, readHint(state, d), { id: 'approve:no-answer' });
  }
  const choice = exactOf(last);
  append(root, state.id, 'decision.approved', { id, choice, via: `${last.channel === 'chat' ? (last.unquoted ? 'chat, the question not quoted' : 'chat') : 'question-panel'} (${host.label}, host-recorded)`, question: { text: last.question.slice(0, 2000), at: last.at, askedAt: last.askedAt } }, actor(options));
  noteAnswer(root, state, d, choice, null);
  return { state: loadState(root, state.id), decision: id, choice, words: null };
}

// The agent's reading of the person's words (0.7.27, D41), recorded once the engine has checked what it can: the choice is one of
// the decision's options (by its id or its label) or `other`; the words are verbatim in one of the person's own messages, the
// latest that holds them, written after the decision existed; no exact answer of theirs to this question came after it; and
// when that message is itself exactly one of this question's options, the reading names that option.
function recordReading(root, state, d, options, { reading, theirs, after, recordable, exactOf, host, how, clip }) {
  const id = d.id;
  const named = reading.choice.toLowerCase() === 'other' ? 'other' : d.choices.find((c) => c === reading.choice) ?? d.choices.find((c) => whole(c) === whole(reading.choice) || labelsOf(d, c).some((l) => whole(l) === whole(reading.choice))) ?? null;
  // Named failure (review of the reading path): an agent naming a choice the decision does not have would record nothing the
  // action can use, or a choice of another question.
  if (!named) throw refuse(`not recorded: --choice ${reading.choice} is none of ${id}'s options (${choiceList(d)}), nor other (the person's own words, recorded as theirs)`, `name the option their words choose by its choice or its label, or \`--choice other\``, { id: 'approve:read-choice' });
  const quote = holdsAny(theirs, reading.quote) ? reading.quote : unwrap(reading.quote) ?? reading.quote;
  const holding = theirs.filter((a) => holds(a.answer, quote));
  // Named failure (review of the reading path): words from the agent's own message, a tool's output or a harness note read as the
  // person's answer; and a paraphrase the agent wrote for them.
  if (!holding.length) throw refuse(`not recorded: "${clip(reading.quote)}" is in no message of the person's in this session (what they typed in the chat or answered in the question panel, as the harness recorded it; never your own text, a tool's output, a note the harness adds or a sub-agent's thread)`, `quote the words of theirs your reading relies on, exactly as they typed them (whole words; case and spacing aside); when they have not answered, ${how}`, { id: 'approve:quote' });
  const at = (a) => Date.parse(a.at) || 0;
  const fresh = holding.filter((a) => after(a.at));
  if (!fresh.length) throw refuse(`not recorded: the person wrote "${clip(reading.quote)}" before ${id} existed (at ${[...holding].sort((x, y) => at(x) - at(y)).at(-1).at ?? 'an unknown time'}; the question was created at ${d.createdAt}): words from before a question cannot answer it`, how, { id: 'approve:quote-before' });
  const m = [...fresh].sort((x, y) => at(x) - at(y)).at(-1);
  const same = (a, b) => a.at === b.at && a.answer === b.answer;
  if (recordable && at(recordable) > at(m)) throw refuse(`not recorded: the person answered ${id} after those words, "${clip(recordable.answer)}" (${recordable.at}), and that answer stands`, `run \`wf approve ${id} --from-question --attempt ${state.id}\` without --choice to record it`, { id: 'approve:quote-superseded' });
  if (recordable && same(recordable, m) && exactOf(recordable) !== named) throw refuse(`not recorded: their reply "${clip(m.answer)}" is exactly the option ${exactOf(recordable)}${labelOf(d, exactOf(recordable)) !== exactOf(recordable) ? ` ("${labelOf(d, exactOf(recordable))}")` : ''}, not ${named}`, `run \`wf approve ${id} --from-question --attempt ${state.id}\` without --choice to record it`, { id: 'approve:quote-exact' });
  const words = named === 'other' ? String(quote).trim().slice(0, 2000) : null;
  append(root, state.id, 'decision.approved', { id, choice: named, ...(words ? { words } : {}), quote: String(quote).trim().slice(0, 2000), message: String(m.answer).trim().slice(0, 2000), via: `${m.how}, read by the agent (${host.label}, host-recorded)`, question: { text: String(m.question ?? '').slice(0, 2000), at: m.at, askedAt: m.askedAt ?? null } }, actor(options));
  noteAnswer(root, state, d, named, words);
  return { state: loadState(root, state.id), decision: id, choice: named, words, read: { quote: String(quote).trim(), message: String(m.answer).trim() } };
}
const holdsAny = (theirs, quote) => theirs.some((a) => holds(a.answer, quote));

// An answer the agent read shows the words it relies on (0.7.27, D41).
export const decisionLine = (d) => `${d.id}  ${d.kind}  ${d.withdrawn ? `withdrawn: ${d.withdrawn.reason ?? ''}` : d.approved ? `decided: ${d.approved.words ? `in their words: "${d.approved.words}"` : `${d.approved.choice}${d.approved.quote ? ` (read from their words "${d.approved.quote}")` : ''}`}${d.spent ? ' (used)' : ''}` : `pending (${d.choices.join(' | ')})`}  ${d.summary}`;

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
