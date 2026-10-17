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
import { append, listAttempts, loadState } from './ledger.mjs';
import { home } from './provenance.mjs';
import { agentEnvNames, detectOwner, findHost, optional } from './hosts/index.mjs';
import { WfError, refuse } from './util.mjs';
import { ASK_SHAPE, askFirst, askProblems, choiceWords, composeAsk, itemWords, readAsk } from './asking.mjs';

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
export function createDecision(root, state, { kind, key, summary, choices = ['yes', 'no'], plain = null, labels = null, then = null, aliases = null, recommend = null, context = null, technical = null, items = null, settles = null, personDirected = null, what = null, options = {} }) {
  if (!RESERVED.includes(kind)) throw new WfError(`unknown reserved decision kind ${kind}`);
  const open = decisionFor(state, kind, key);
  if (open && !open.approved) return open;
  const id = `A${(state.decisions ?? []).length + 1}`;
  append(root, state.id, 'decision.created', { id, kind, key: String(key), summary: String(summary), choices: choices.map(String), ...(plain ? { plain: String(plain) } : {}), ...(labels ? { labels } : {}), ...(then ? { then } : {}), ...(aliases ? { aliases } : {}), ...(recommend ? { recommend } : {}), ...(context ? { context: String(context) } : {}), ...(technical ? { technical: String(technical) } : {}), ...(items && Object.keys(items).length ? { items } : {}), ...(settles && Object.keys(settles).length ? { settles } : {}), ...(personDirected ? { personDirected: String(personDirected) } : {}), ...(what ? { what: String(what) } : {}) }, actor(options));
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
// recorded it, as the person's chat reply to a message that asked exactly this question (0.7.18), or as typed in their
// terminal.
export const SHOW_TEXT = 'say in your reply, in plain words, what this decides, why, and what happens after each choice (a question panel may not show, and its acceptance proves nothing)';
export const approveHint = (state, d) => `${SHOW_TEXT}; then ask them in your message, so they can simply type their answer: quote the question "${questionFor(state, d)}" exactly with these options (label, then what follows it): ${optionLines(d)}, and ask nothing else in that message (end your turn with it). You may also show the same question and options in your question panel: a typed reply and a panel answer both count. After they answer, run \`wf approve ${d.id} --from-question --attempt ${state.id}\`; or they run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal (choices: ${d.choices.join(' | ')}); then run this command again. Until they answer, any reply of yours that mentions this decision (a status, what remains) asks it in this form; one that describes it in your own words leaves it unasked`;

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
  const agentEnv = agentEnvNames().filter((k) => env[k]);
  if (agentEnv.length) throw refuse(`\`wf approve\` runs in the owner's own terminal, not under an agent runtime (${agentEnv.join(', ')})`, `in this same reply, ask them in your message, quoting the question "${questionFor(state, d)}" exactly with its options (${optionLines(d)}) and asking nothing else in that message, so they can type the answer (you may also show it in your question panel: either answer counts); after they answer run \`wf approve ${id} --from-question --attempt ${state.id}\`; or they run \`wf approve ${id} --attempt ${state.id}\` in a terminal outside the agent app`, { id: 'approve:agent-env' });
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
  const choice = preset ? (typed === preset ? preset : null) : d.choices.find((c) => c === typed || labelOf(d, c) === typed) ?? choiceOfReply(d, typed, { chat: false }).choice;
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

// The choice a reply makes, and the words kept beside it (0.7.23). The person's rule (2026-10-16): "why are you stopping me
// from just typing no, why do i have to answer the questionnaire? both should be accepted". Named failure (field): the person
// typed "ok fix all and continue" to the round-limit question; it named one of its choices, but a reply chose only by its
// first words, so it was refused and the session put the question panel in front of them. A reply chooses:
// - by its first words: an option's label (with or without a leading "yes, " or "no, "), a short name the engine gives the
//   option ("fix it", "ship it", "run the tests"), or its choice; for a yes or no question also "ok", "sure", "go ahead",
//   "nope" and the like; or
// - by naming exactly one option anywhere in it ("ok fix all and continue" is continue).
// It is the person's own words, not a choice, when it asks something back, names two options ("yes, actually no"), negates
// or conditions the one it names, before it ("don't continue", "decide whether to continue") or right after it ("continue
// is not an option"). Words beside a choice are kept with it, so a condition reaches the owner. `quoted`: the message the
// reply answers asked this question; a reply to one that did not chooses only by an option named plainly (a label or a
// short name, or a choice other than yes and no when `ids`: a bare "yes" says nothing about which question it answers).
//
// 0.7.27 (I-192, D41). Named failure (field): the person answered "ok we can close this then. ticket is on done? and clean up
// completed?"; the reply was no answer because it held a question mark, although both questions were about other things, and
// "close this" was no name the engine gave the option. A reply is read sentence by sentence: a question about something else
// (it names none of the options and has a subject of its own: "ticket is on done?") is set aside, and only a question about the
// decision (one naming an option, or one with no subject of its own: "why?", "are you sure?") is a question back. A request in
// a question's form ("can you close it?") asks for the action. A condition anywhere before the option in its sentence ("if all
// good ... close it", "check the data and then close it") makes it the person's words. The frame's own terms for its action
// count too (`acts`, engine/asking.mjs: "close this", "go ahead and close", "close the ticket"), and `own` reads a reply to a
// message that neither quoted nor named the decision: only those terms count there, never a bare "yes", a label or a short name.
const norm = (x) => String(x).replace(/[\u2018\u2019\u02bc]/g, "'").trim().replace(/\s*\(recommended\)$/i, '').trim().toLowerCase();
const flat = (x) => x.replace(/\s+/g, ' ').trim();
const YES_WORDS = ['ok', 'okay', 'sure', 'go ahead', 'yep', 'yeah', 'approve', 'approved', 'accept', 'accepted', 'agreed', 'do it'];
// The recommended option, named as such (0.7.27, I-192): "go with your recommendation" chose the option the question recommended.
const RECOMMENDED = ['recommended', 'the recommended one', 'your recommendation', 'the recommendation', 'what you recommend', 'as you recommend'];
const NO_WORDS = ['nope', 'nah', 'decline', 'declined', 'reject', 'rejected'];
// A negation or a condition within four words before the option (independent review of 0.7.23: "I would prefer that we do
// not at this point continue" and "decide whether to continue" read as continue). 0.7.27: any "n't" ("shouldn't", typed
// with a phone's curly apostrophe too) and "hold off".
const BEFORE = /(?:^|[^\p{L}\p{N}])(?:not|never|no|without|cannot|dont|cant|wont|shouldnt|wouldnt|didnt|doesnt|isnt|arent|couldnt|mustnt|\p{L}+n't|do not|hold off|instead of|rather than|if|unless|until|before|whether)(?:[^\p{L}\p{N}]+[\p{L}\p{N}'-]+){0,4}[^\p{L}\p{N}]*$/u;
// A condition anywhere before the option in its sentence (0.7.27): "then if all good check the data, and then close the ticket".
const CONDITION = /(?<![\p{L}\p{N}])(?:if|unless|until|before|after|once|when|whether|as soon as|provided|and then)(?![\p{L}\p{N}])/u;
// A negation of the option right after it ("continue is not an option", "accept it and ship is not what I want").
const AFTER = /^[^\p{L}\p{N}]*(?:is not|isn't|is no|is never|would be a mistake|is a mistake|would be wrong|is wrong|is the wrong)(?![\p{L}\p{N}])/u;
// An exception or a time after the option can turn the answer around ("fix it here unless it is already in ENG-636", D18's
// named failure; "ship it after the fix" means fix first; "lift it once the review is in" means not now): the person's
// words, which the owner follows or asks about, not the option. A condition that does not move the action stays beside the
// choice ("yes, but keep the old button").
const EXCEPTION = /(?<![\p{L}\p{N}])(?:unless|except|otherwise|after|once|when|later|until|in the follow-up|next time)(?![\p{L}\p{N}])/u;
const escapeRe = (l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWordAt = (text, l) => {
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(l)}(?![\\p{L}\\p{N}])`, 'u').exec(text);
  return m ? m.index : -1;
};
// Sentences: a question is one that ends with "?" or opens as one ("should we close it"), after a filler word or two.
const sentencesOf = (text) => String(text).split(/(?<=[.!?;])\s+|\n+/).map(flat).filter(Boolean);
const FILLER = '(?:(?:ok|okay|so|and|but|then|well|hmm|hey|also|wait|right)[,\\s]+)*';
// An auxiliary opens a question only before its subject ("should we", "is it", "can you"): "will do" and "is fine" are answers.
const ASKING = new RegExp(`^${FILLER}(?:(?:should|shall|can|could|would|will|do|does|did|is|are|was|were|has|have|may|might|must|isn't|aren't|wouldn't|shouldn't|can't|won't|don't|doesn't) (?:we|i|you|it|this|that|they|he|she|there|the|our|my|your|its)|why|how|what|where|who|which|whether)(?![\\p{L}\\p{N}'])`, 'u');
const REQUEST = new RegExp(`^${FILLER}(?:please|(?:can|could|would|will) you)(?![\\p{L}\\p{N}'])`, 'u');
const isQuestion = (s) => /\?\s*$/.test(s) || ASKING.test(s);
// A question with no subject of its own is about what was just said ("why?", "is it safe?", "are you sure about that?").
const PLAIN_WORDS = new Set(("a an the it its it's this that these those them they there here you your we our us i me my he she " +
  'is are was were be been being am do does did done has have had will would shall should can could may might must ' +
  'not no yes ok okay sure really so then now too also just still yet and or but if to of on in at for with about by from as up ' +
  "what why how when where who which whether safe right fine good wise correct wrong risky ready idea call thing way move option choice " +
  "that's isn't aren't won't can't don't doesn't didn't hm hmm huh well though sound sounds look looks seem seems mean means think").split(' '));
const ownSubject = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).some((w) => !PLAIN_WORDS.has(w));
// An act (engine/asking.mjs) as a pattern: `<it>` a reference to the work, `<it?>` one or nothing; after an open end only the
// end of the clause or a word that cannot be its object ("close this then", never "close this PR" or "close the browser").
const REF_NOUNS = 'ticket|task|attempt|item|work|story|card|change|one';
const TAIL = 'now|then|too|also|please|pls|today|tomorrow|tonight|already|out|off|anyway|here|there|as|and|but|so|for|with|since|because|if|when|after|once|unless|until|before|without|or|yet|first|later|asap|thanks|thank';
function actPattern(act, refs) {
  const ref = `(?:${[...new Set(refs.filter(Boolean).map((r) => escapeRe(norm(r))))].sort((a, b) => b.length - a.length).concat(['this one', 'that one', 'it', 'this', 'that', 'them', 'these', 'those', `(?:the|this|that|our|my|your) (?:${REF_NOUNS})`]).join('|')})`;
  let src = '';
  act.split(' ').forEach((w, i) => {
    if (w === '<it?>') src += `(?: ${ref})?`;
    else src += `${i ? ' ' : ''}${w === '<it>' ? ref : escapeRe(w)}`;
  });
  const end = /<it\??>$/.test(act) ? `(?![.\\-_]?[\\p{L}\\p{N}])(?=\\s*$|\\s*[^\\p{L}\\p{N}\\s]|\\s+(?:${TAIL})(?![\\p{L}\\p{N}]))` : '(?![\\p{L}\\p{N}])';
  return new RegExp(`(?<![\\p{L}\\p{N}])${src}${end}`, 'u');
}
const actHits = (acts, text, refs) => acts.map((a) => actPattern(a, refs).exec(text)).filter(Boolean).map((m) => ({ at: m.index, l: m[0] }));
// Whether a reply names this decision's action in its own terms, in any form (chosen, negated, conditioned or asked about):
// the person's latest such words are their answer, or no answer. `phrases` also counts its labels and short names, for the
// check that the same words could answer another open decision.
export function namesAction(d, answer, refs = [], { phrases = false } = {}) {
  const text = sentencesOf(norm(answer)).join(' ');
  const words = choiceWords(d);
  return d.choices.some((c) => actHits(words[c]?.acts ?? [], text, refs).length > 0 || (phrases && [...(words[c]?.phrases ?? []), labelOf(d, c) !== c ? labelOf(d, c) : null].filter(Boolean).map(norm).some((l) => wholeWordAt(text, l) >= 0)));
}
// Whether a chat reply speaks of this decision at all (0.7.27, I-192): it names one of its options (a label, a short name, a
// choice, an act), says yes or no in any words (it replies to a message that quoted the question), or shares a word with the
// question as the person read it (its words, its labels, what follows each choice: "let's wait for the phone" answers "...
// or wait for a phone?" in their own words, which are recorded as theirs). Named failure (a transcript of the field case): the
// person's first message of the next day, "where are we? update the wf plugin", followed the message that had asked the
// question and would have been recorded as their answer in their own words, so the decision read as answered and their later
// "ok we can close this then" could no longer count. A reply that does none of these is about something else: no answer.
const STOP = new Set(['let', "let's", 'lets', 'please', 'thanks', 'thank', 'get', 'got', 'going', 'want', 'need', 'make', 'all', 'any', 'some', 'more', 'very', 'much', 'like', 'know', 'see', 'say', 'tell', 'give', 'take', 'than', 'their', 'into', 'over', 'out', 'off', 'new', 'yours', 'whom', 'everything', 'something', 'anything']);
const contentWords = (t) => new Set((norm(t).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => w.length >= 3 && !PLAIN_WORDS.has(w) && !STOP.has(w)).map((w) => w.replace(/(?<=\p{L}{3})s$/u, '')));
export function addresses(d, answer, { question = '', refs = [] } = {}) {
  const text = sentencesOf(norm(answer)).join(' ');
  const words = choiceWords(d);
  const yesNo = d.choices.length === 2 && d.choices.includes('yes') && d.choices.includes('no');
  if (d.choices.some((c) => [norm(labelOf(d, c)), norm(labelOf(d, c)).replace(/^(yes|no)\s*,\s*/, ''), norm(c), ...(words[c]?.phrases ?? []).map(norm), ...(yesNo ? (c === 'yes' ? YES_WORDS : NO_WORDS) : []), ...(d.recommend?.choice === c ? RECOMMENDED : [])].filter(Boolean).some((l) => wholeWordAt(text, l) >= 0) || actHits(words[c]?.acts ?? [], text, refs).length > 0)) return true;
  const asked = contentWords([question, d.summary ?? '', ...d.choices.map((c) => labelOf(d, c)), ...Object.values(d.then ?? {}), d.context ?? '', d.technical ?? ''].join(' '));
  return [...contentWords(answer)].some((w) => asked.has(w));
}
export const optionNamed = (d, text) => d.choices.some((c) => wholeWordAt(norm(text), norm(labelOf(d, c))) >= 0);
export function choiceOfReply(d, answer, { chat = true, quoted = true, ids = true, own = false, refs = [] } = {}) {
  const reply = norm(answer);
  if (!reply) return { choice: null, said: null };
  const words = choiceWords(d);
  const yesNo = d.choices.length === 2 && d.choices.includes('yes') && d.choices.includes('no');
  const label = (c) => norm(labelOf(d, c));
  const plainly = (c) => (own ? [] : [...new Set([label(c), label(c).replace(/^(yes|no)\s*,\s*/, ''), ...(words[c]?.phrases ?? []).map(norm), ...(ids && (quoted || !['yes', 'no'].includes(c)) ? [norm(c)] : []), ...(d.recommend?.choice === c ? RECOMMENDED : [])].filter(Boolean))]);
  const leading = (c) => [...plainly(c), ...(!own && quoted && yesNo ? (c === 'yes' ? YES_WORDS : c === 'no' ? NO_WORDS : []) : [])];
  const hitsIn = (text, c) => [...plainly(c).map((l) => ({ at: wholeWordAt(text, l), l })).filter((h) => h.at >= 0), ...actHits(words[c]?.acts ?? [], text, refs)];
  // The sentences read for the choice: every one in a typed reply but a question about something else; a question about the
  // decision is a question back, and nothing is chosen.
  let text = reply;
  let setAside = false;
  if (chat) {
    const kept = [];
    for (const s of sentencesOf(reply)) {
      if (!isQuestion(s) || REQUEST.test(s)) kept.push(s);
      else if (d.choices.some((c) => hitsIn(s, c).length || leading(c).some((l) => wholeWordAt(s, l) >= 0)) || !ownSubject(s)) return { choice: null, said: null };
      else setAside = true;
    }
    text = kept.join(' ');
    if (!text) return { choice: null, said: null };
  }
  const starts = (l) => text === l || (chat && text.startsWith(l) && /^[^\p{L}\p{N}]/u.test(text.slice(l.length)));
  const leads = (c) => leading(c).filter(starts);
  const longest = (ls) => Math.max(...ls.map((l) => l.length));
  let choice = d.choices.filter((c) => leads(c).length).sort((x, y) => longest(leads(y)) - longest(leads(x)))[0] ?? null;
  let used = choice ? longest(leads(choice)) : 0;
  if (choice) {
    const rest = text.slice(used);
    if (AFTER.test(rest) || EXCEPTION.test(rest) || d.choices.some((c) => c !== choice && hitsIn(rest, c).length)) choice = null;
  } else if (chat) {
    const named = d.choices.filter((c) => hitsIn(text, c).length);
    const hits = named.length === 1 ? hitsIn(text, named[0]).sort((x, y) => x.at - y.at || y.l.length - x.l.length) : [];
    const hit = hits[0];
    const head = hit ? text.slice(0, hit.at) : '';
    const sentence = head.slice(Math.max(0, ...['. ', '! ', '? ', '; '].map((p) => (head.includes(p) ? head.lastIndexOf(p) + p.length : 0))));
    if (hit && !BEFORE.test(head) && !CONDITION.test(sentence) && !AFTER.test(text.slice(hit.at + hit.l.length)) && !EXCEPTION.test(text.slice(hit.at + hit.l.length))) {
      choice = named[0];
      used = -1;
    }
  }
  const said = choice && chat && (used < 0 || setAside || /[\p{L}\p{N}]/u.test(text.slice(used))) ? String(answer).trim().slice(0, 2000) : null;
  return { choice, said };
}

// Every other open question the same words could answer: this attempt's and every other open attempt's in the project (0.7.27,
// I-192). An attempt that cannot be read is left out; it is not this decision's.
function openDecisions(root, state, d) {
  const open = (s) => (s.decisions ?? []).filter((x) => !x.approved && !x.withdrawn && !(s.id === state.id && x.id === d.id)).map((x) => ({ attempt: s.id, d: x, refs: [s.id, s.item] }));
  const out = open(state);
  for (const id of listAttempts(root)) {
    if (id === state.id) continue;
    try {
      const s = loadState(root, id);
      if (!['done', 'abandoned'].includes(s.phase)) out.push(...open(s));
    } catch {}
  }
  return out;
}

// What the agent does when an answer is refused: it asks the question now, in the same reply, in the form that binds (0.7.27,
// I-192). Named failure (field): after `wf approve --from-question` refused, the agent recorded an improvement and ended its
// turn having asked nothing, and the person waited a day on a question that was never put to them again.
const askNowHint = (state, d) => `${SHOW_TEXT}; then, in this same reply (this refusal never ends your turn with the question unasked), ask them in your message, quoting the question "${questionFor(state, d)}" exactly with its options (${optionLines(d)}) and asking nothing else in that message, so they can type the answer (you may also show it in your question panel: a typed reply and a panel answer both count), and run this again after they answer; or they run \`wf approve ${d.id} --attempt ${state.id}\` in their own terminal`;

// `wf approve <id> --from-question`: the answer the person gave in the calling session's question panel, or their reply in
// its chat to a message that asked the decision's exact question (0.7.18), as the harness recorded it. It counts when the question names this attempt and decision and carries the decision's own summary (so the
// person saw what they confirm), offered exactly the decision's choices (when the harness records the options), and was
// answered after the decision was created; the latest such answer is the person's. From 0.7.27 (D41) a reply in the person's
// own words that names what the decision does counts as well, whatever the message before it said (below). Nothing else in
// the transcript is read: the agent's words are never an answer.
// Its stated limit, as for the tracker readback: the host's record, not a signature (docs/trust-model.md).
export async function approveFromQuestion(root, id, options, { env = process.env } = {}) {
  const state = openState(root, options);
  const d = (state.decisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no decision ${id ?? ''} on ${state.id}; \`wf decisions --attempt ${state.id}\` lists them`);
  if (d.approved) throw refuse(`${id} was already decided: ${d.approved.choice}`, null, { id: 'approve:already' });
  if (d.withdrawn) throw refuse(`${id} was withdrawn (${d.withdrawn.reason ?? ''}); the next command asks a fresh question`, withdrawnHint(state), { id: 'approve:withdrawn' });
  if (options.choice !== undefined && options.choice !== true) throw new WfError('--choice is for the terminal; with --from-question the choice is the one the person picked in the panel');
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
  // A chat reply binds to this decision only when the message it answers asks this question and no other: no other open
  // decision of the attempt, and no other decision named the engine's way (`<attempt> A<n>:`, of any attempt), so a "yes" can
  // answer only one decision.
  const others = (state.decisions ?? []).filter((x) => x.id !== d.id && !x.approved && !x.withdrawn).map((x) => questionFor(state, x));
  // An attempt id is `<item>.<n>` (engine/attempt.mjs), so "decision A1:" in the agent's own words is no decision's key.
  const named = (text) => new Set([...text.matchAll(/(?<![\p{L}\p{N}._-])([\p{L}\p{N}][\p{L}\p{N}._-]*\.\d+ A\d+):/gu)].map((m) => m[1]));
  const alone = (a) => a.channel !== 'chat' || (!others.some((q) => carriesText(a.question, q)) && [...named(a.question)].every((k) => k === `${state.id} ${d.id}`) && (a.panels ?? []).every((x) => !carriesText(x.text, question) || offered(x.options)));
  const answers = [...(await read(t.file)), ...(chat ? await chat(t.file) : [])];
  const refs = [state.id, state.item];
  // A chat reply to that message is an answer only when it speaks of the decision (`addresses`); the panel's answer always is.
  const bound = answers.filter((a) => carries(a.question) && alone(a) && offered(a.options) && after(a.at) && (a.askedAt == null || after(a.askedAt)) && (a.channel !== 'chat' || addresses(d, a.answer, { question, refs })));
  // 0.7.23: a chat reply to a message that explained the question in the session's own words binds when that message names
  // this decision by its id (`<attempt> <id>`) and no other, was written after the decision existed, the reply names one of
  // its options plainly, and it is the attempt's only open question (named failure: "ok fix all and continue" was refused
  // because the session had explained the question in its own words). A message that never named the decision binds no
  // reply: a "stop" or "continue" said about something else is never the person's answer to it (independent security
  // review of 0.7.23).
  const key = new RegExp(`(?<![\\p{L}\\p{N}._-])${state.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${d.id}(?![\\p{N}])`, 'u');
  const namesOnlyThis = (text) => key.test(text) && [...named(text)].every((k) => k === `${state.id} ${d.id}`);
  // A choice id counts there only when the message also showed an option's label; an answer to the quoted question, when
  // there is one, is the person's answer (independent review of 0.7.23: "ENG-1.1 A2 is still pending; meanwhile should I
  // split the lint fix?" answered "yes, split it" read as the escalation's split).
  const unquoted = others.length || bound.length ? [] : answers.filter((a) => a.channel === 'chat' && !carries(a.question) && namesOnlyThis(a.question) && after(a.at) && a.askedAt != null && after(a.askedAt) && choiceOfReply(d, a.answer, { quoted: false, ids: optionNamed(d, a.question) }).choice).map((a) => ({ ...a, unquoted: true, ids: optionNamed(d, a.question) }));
  // 0.7.27 (I-192, D41): a reply in the person's own words that names what this decision does, in its frame's own terms ("ok we
  // can close this then"), whatever the message before it said (named failure: the agent had described the closure as what
  // remained, in its own words; the person's clear "close this" was refused because of the form of that message). Every reply
  // since the decision was created that names its action counts, chosen or not, and the latest reply bound any way is the
  // person's answer: a later "don't close it yet" takes back an earlier "close it". Words that name another open decision's
  // action or option as well (this attempt's or another open attempt's) answer neither.
  const seen = new Set([...bound, ...unquoted].map((a) => `${a.at}\u0000${a.answer}`));
  const own = answers.filter((a) => a.channel === 'chat' && after(a.at) && !seen.has(`${a.at}\u0000${a.answer}`) && namesAction(d, a.answer, refs)).map((a) => ({ ...a, own: true }));
  const last = [...bound, ...unquoted, ...own].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).at(-1);
  if (!last) throw refuse(`no answer to ${d.id} in this session's question panel, or in its chat to a message asking exactly its question, after the decision was created, and no reply of the person's since then names what it decides`, `answer what they asked, if they asked something; then ${how}`, { id: 'approve:no-answer' });
  const clip = (x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 300);
  if (last.own) {
    const fits = openDecisions(root, state, d).filter((o) => namesAction(o.d, last.answer, o.refs, { phrases: true }));
    if (fits.length) throw refuse(`no answer to ${d.id}: the person's words "${clip(last.answer)}" name what it decides, and could answer ${fits.map((o) => `${o.attempt} ${o.d.id} (${o.d.plain ?? o.d.summary})`.slice(0, 200)).join('; ')} as well, so they answer neither`, `${how}; ask each open question on its own`, { id: 'approve:no-answer' });
    if (!choiceOfReply(d, last.answer, { own: true, refs }).choice) throw refuse(`no answer to ${d.id}: the person's latest words about what it decides, "${clip(last.answer)}", choose nothing (they negate it, make it wait on something, or ask about it)`, `answer what they asked, if they asked something; then ${how}`, { id: 'approve:no-answer' });
  }
  // The panel's answer is the option itself, or what the person typed in its free-text field; a chat reply is read as
  // `choiceOfReply` says.
  const { choice, said } = choiceOfReply(d, last.answer, { chat: last.channel === 'chat' || !d.choices.some((c) => norm(c) === norm(last.answer) || norm(labelOf(d, c)) === norm(last.answer)), quoted: !last.unquoted && !last.own, ids: (!last.unquoted || last.ids) && !last.own, own: Boolean(last.own), refs });
  // An answer in the person's own words (the panel's free-text option) is theirs: recorded as `other` with the words, so the
  // question is answered and the owner follows the words; it grants nothing a choice would (0.7.8: it left the question
  // open for ever).
  const words = choice ? null : String(last.answer).trim().slice(0, 2000);
  if (!choice && !words) throw refuse(`the person's answer to ${d.id} is empty; nothing recorded`, how, { id: 'approve:mismatch' });
  append(root, state.id, 'decision.approved', { id, choice: choice ?? 'other', ...(words ? { words } : {}), ...(said ? { reply: said } : {}), via: `${last.channel === 'chat' ? (last.own ? 'chat, in their own words' : last.unquoted ? 'chat, the question not quoted' : 'chat') : 'question-panel'} (${host.label}, host-recorded)`, question: { text: last.question.slice(0, 2000), at: last.at, askedAt: last.askedAt } }, actor(options));
  noteAnswer(root, state, d, choice ?? 'other', words);
  return { state: loadState(root, state.id), decision: id, choice: choice ?? 'other', words, reply: said };
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
