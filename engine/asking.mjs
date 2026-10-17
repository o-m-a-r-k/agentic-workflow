// The person's questions, in one shape for every reserved decision (0.7.23, D29).
//
// Named failure (field, 2026-10-16): the person answered one clear question (ship a ticket without proof that screen
// recording works on a real phone), then was asked seven more about the same gap: six, one per review finding, each the
// reviewer's own text ("waive recording_evidence_review_110:F1 (high: Neither candidate has the required real OS recording
// ..."), and a seventh about an issue that repeated them. They answered all seven within five seconds, "without really
// knowing yes to what". 0.7.11 gave the strategist's escalations plain words, labels, consequences and a recommendation, and
// promised the same for the engine's own questions; only the escalation got them. Measured on two projects: 62 of 76
// questions carried no plain words, and the optional plain line for an item leaving a delivery (`--explain`) was given 0
// times in 18.
//
// Every question the person answers now reads the same way: what they decide, in one sentence (the engine's, from the facts
// it holds); the context in plain words and a recommendation with its reason (the owner agent's, `--ask <file.json>`: the
// engine knows the facts, the agent knows what they mean for the product and its users); one line of technical detail when
// it helps; and each choice as a plain label with what happens next (the engine's: it knows what each choice does). The
// question is written once, before it is asked: the engine refuses to ask without the agent's words, since a question the
// person cannot read is no decision of theirs.
import fs from 'node:fs';
import path from 'node:path';
import { refuse } from './util.mjs';

const text = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
// A part of the question ends as a sentence does.
const sentence = (v) => {
  const t = text(v);
  return !t || /[.?!:)"]$/.test(t) ? t : `${t}.`;
};

export const ASK_SHAPE = '{ "context": "<two or three short sentences, in plain words: what happened and what it means for the product or its users>", "recommend": { "choice": "<one of the choices>", "why": "<one line>" }, "technical": "<optional: one short line for an engineer>" }';
export const ITEM_SHAPE = '"items": { "<ref>": { "what": "<what is wrong, in one plain line>", "fix": "<what fixing it now takes>" } }';

// How to write the person's question, for the agent asked to write it (the hint of every refusal that needs one).
export const ASK_GUIDE = 'The person reads this question with nothing else in front of them, often on a phone. Write `context` for someone who knows the product but not the code: what happened, what it means for the people who use the product, and why it is theirs to decide; no ids (no finding, criterion, reviewer or decision ids), no file names, no workflow words (gate, delta, closure, handoff, attempt). `recommend` names one choice and says why in one line; when it truly depends on something only they know, give `"choice": null` and say in `why` what it depends on. `technical` is one short line an engineer would want (the check that failed, the file); leave it out when it adds nothing. A finding\'s `what` says what is wrong for a user, not what the reviewer checked';

// The agent's words for the person's question (`--ask <file.json>`), or null when none were given.
export function readAsk(options) {
  const file = options?.ask;
  if (file === undefined || file === null || file === false) return null;
  if (typeof file !== 'string' || !file.trim()) throw refuse(`--ask is a JSON file: ${ASK_SHAPE}`, null, { id: 'ask:shape' });
  let doc;
  try {
    const p = path.resolve(file);
    if (!fs.statSync(p).isFile()) throw new Error('not a file');
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (error) {
    throw refuse(`--ask ${file}: ${error.code === 'ENOENT' ? 'no such file' : `not a JSON file (${String(error.message).split('\n')[0]})`}`, `write it as ${ASK_SHAPE}`, { id: 'ask:shape' });
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw refuse(`--ask ${file} is not a JSON object`, `write it as ${ASK_SHAPE}`, { id: 'ask:shape' });
  return doc;
}

// The plain words an item question uses for one item: the agent's line in `--ask` (`items`), or in the older `--explain`
// file (`{ "<ref>": { what, fix } }`, kept for the leave commands).
export function itemWords(ask, explain, ref) {
  const from = (doc) => (doc && typeof doc === 'object' && doc[ref] && typeof doc[ref] === 'object' ? doc[ref] : null);
  const a = from(ask?.items) ?? {};
  const e = from(explain) ?? {};
  return { what: text(a.what) || text(e.what) || null, fix: text(a.fix) || text(e.fix) || null, recommend: a.recommend ?? null };
}

// One item's words for its own question: the item's `context`, `recommend` and `technical` in `--ask` when it has them, else
// the shared ones (one `--ask` file words every item of a command; each item is still its own question).
export function itemAsk(ask, explain, ref) {
  const own = ask?.items?.[ref] && typeof ask.items[ref] === 'object' ? ask.items[ref] : {};
  const words = itemWords(ask, explain, ref);
  if (!ask && !words.what) return null;
  return { context: own.context ?? ask?.context, recommend: own.recommend ?? ask?.recommend, technical: own.technical ?? ask?.technical, items: { [ref]: { what: words.what, ...(words.fix ? { fix: words.fix } : {}) } } };
}

// The choice a recommendation names (by its id or its label), or undefined when it names none of them; null is "no
// recommendation", allowed when `why` says what it depends on.
const pickOf = (choices, labels, named) => {
  if (named === null) return null;
  const n = text(String(named ?? '')).toLowerCase();
  return choices.find((c) => c.toLowerCase() === n || text(labels?.[c]).toLowerCase() === n);
};

// What is missing from the agent's words for one question; empty when the question can be asked.
export function askProblems(ask, { choices, labels = null, items = [], explain = null }) {
  const p = [];
  if (!ask) return ['no `--ask` file: the person\'s question is written before it is asked'];
  if (!text(ask.context)) p.push('`context`: in plain words, what happened and what it means for the product or its users');
  const rec = ask.recommend;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) p.push(`\`recommend\`: { "choice": "<one of: ${choices.map((c) => labels?.[c] ?? c).join(' | ')}>", "why": "<one line>" } (choice null only when it depends on something they know, and why says on what)`);
  else {
    if (pickOf(choices, labels, rec.choice) === undefined) p.push(`\`recommend.choice\` must be one of: ${choices.map((c) => `"${labels?.[c] ?? c}"`).join(', ')} (or null)`);
    if (!text(rec.why)) p.push('`recommend.why`: why, in one line');
  }
  if (ask.technical !== undefined && ask.technical !== null && typeof ask.technical !== 'string') p.push('`technical`, when given, is one line of text');
  const missing = items.filter((ref) => !itemWords(ask, explain, ref).what);
  if (missing.length) p.push(`\`items\`: a plain \`what\` for ${missing.join(', ')} (${ITEM_SHAPE})`);
  return p;
}

// The question as the person reads it: what they decide, the context, the technical line, the recommendation. `frame` is
// the engine's: { question, labels, then } (labels and then per choice), and `facts`, a line the engine adds after the
// context (who rated an item, and every re-rating: D18).
// `items`: [{ ref, what, fix }] the question names, listed after it in the agent's plain lines (`itemNoun`: what an item is
// called, "problem" by default).
export function composeAsk(ask, frame, choices, { items = [], itemNoun = 'problem' } = {}) {
  const labels = frame.labels ?? null;
  const pick = pickOf(choices, labels, ask.recommend.choice);
  const tech = text(ask.technical);
  const listed = items.length === 1 ? `The ${itemNoun}: ${sentence(items[0].what)}` : items.length ? `The ${itemNoun}s: ${items.map((x, i) => `(${i + 1}) ${text(x.what).replace(/[.\s]+$/, '')}`).join('; ')}.` : '';
  const rec = pick ? `Recommended: "${labels?.[pick] ?? pick}", because ${text(ask.recommend.why).replace(/^because\s+/i, '')}` : `No recommendation: ${text(ask.recommend.why)}`;
  const plain = [sentence(frame.question), listed, sentence(ask.context), sentence(frame.facts), tech ? `Technical detail: ${sentence(tech)}` : '', sentence(rec)].filter(Boolean).join(' ');
  return { plain, labels, then: frame.then ?? null, ...(frame.aliases ? { aliases: frame.aliases } : {}), recommend: pick ? { choice: pick, why: text(ask.recommend.why) } : null, context: text(ask.context), ...(tech ? { technical: tech } : {}), ...(items.length ? { items: Object.fromEntries(items.map((x) => [x.ref, { what: text(x.what), ...(x.fix ? { fix: text(x.fix) } : {}) }])) } : {}) };
}

// The refusal that asks the agent to write the question first: what the person will be asked (the engine's sentence and
// choices), the facts behind it, and what is missing.
export function askFirst(what, frame, choices, problems, facts, { items = [] } = {}) {
  const opts = choices.map((c) => `"${frame.labels?.[c] ?? c}"${frame.then?.[c] ? ` (${frame.then[c]})` : ''}`).join(' | ');
  return refuse(`not asked yet: ${what} is the person's decision, and its question is written for them before it is asked.\n  the question: ${sentence(frame.question)}\n  the choices: ${opts}\n  the facts behind it (for you; the person reads your words): ${facts}\n  missing: ${problems.join('; ')}`, `write ${ASK_SHAPE}${items.length ? ` with ${ITEM_SHAPE} for ${items.join(', ')}` : ''} to a file and run this command again with \`--ask <file>\`. ${ASK_GUIDE}`, { id: 'ask:words' });
}

// The engine's side of each question: what the person decides, what each choice does, and the short names a typed answer may
// use for it (`aliases`, engine/approve.mjs choiceOfReply). Each frame is written from the
// facts the engine holds, in the words the person reads; the agent's `context` says what the facts mean. `item` is the
// ticket (the tracker item), the name the person knows the work by.
const they = (n, one, many) => (n === 1 ? one : many);
// The two choices of an item leaving a delivery (engine/leaving.mjs), defined here so a frame's words can name them.
export const LEAVE = 'let it leave';
export const FIX = 'fix now';
// What a level means for an item, in the person's words, under the project's `leaving:` policy (engine/leaving.mjs).
export const PERSON_RULE = { never: 'it is still fixed before this delivery ships', person: 'it may ship unfixed, but only if you say so when asked', owner: 'it may ship unfixed on the recorded reason of the agent running the ticket' };
export const FRAMES = {
  waive: ({ item, n }) => ({
    aliases: { yes: ['accept it', 'accept them', 'ship it'], no: ['fix it', 'fix them', 'fix it first', 'fix them first'] },
    question: `Should ${item} ship with ${they(n, 'a problem the reviewers found', `${n} problems the reviewers found`)} accepted as ${they(n, 'it is', 'they are')}, instead of fixed?`,
    labels: { yes: they(n, 'Accept it and ship', 'Accept them and ship'), no: they(n, 'No, fix it first', 'No, fix them first') },
    then: { yes: `${they(n, 'it is', 'they are')} set aside and named in the delivery note as accepted without a fix; every other check still runs before delivery`, no: `${they(n, 'it stays', 'they stay')} open: ${item} is not delivered until ${they(n, 'it is', 'they are')} fixed, or a later review finds ${they(n, 'it', 'them')} resolved` },
  }),
  leave: ({ item, ticketed, fix, LEAVE, FIX, directed, level, rated }) => ({
    aliases: { [LEAVE]: ['ship now', 'ship it', 'leave it', ...(ticketed ? ['ticket it'] : ['list it']), LEAVE], [FIX]: ['fix it', 'fix it first', 'fix it now'] },
    facts: rated,
    question: `Should ${item} ship without fixing this${ticketed ? ', with a follow-up ticket for it,' : ', listing it as a known issue,'} or should it be fixed first?${directed ? ` (Your rule fixes ${level} items before shipping; you asked to leave this one out: "${directed}".)` : ''}`,
    labels: { [LEAVE]: ticketed ? 'Ship now, follow-up ticket' : 'Ship now, list it as known', [FIX]: 'Fix it first' },
    then: { [LEAVE]: ticketed ? 'it ships without this fix; a follow-up ticket tracks it' : 'it ships without this fix; the delivery note lists it as a known issue', [FIX]: fix || 'it is fixed in this delivery (a fix, a short review and the tests), then it ships' },
  }),
  rateDown: ({ item, from, to, toRule }) => ({
    aliases: { yes: ['lower it', `count it ${to}`], no: ['keep it', `keep it ${from}`] },
    question: `Should a problem found in ${item} count as ${to} instead of ${from}?`,
    labels: { yes: `Count it as ${to}`, no: `Keep it ${from}` },
    then: { yes: `it counts as ${to}: ${toRule}`, no: `it stays ${from} and is fixed in this delivery` },
  }),
  // 0.7.27 (I-188): a discovered issue the owner says is not a defect at all. "Yes" keeps the product as it works now.
  notDefect: ({ item, rated, directed }) => ({
    aliases: { yes: ['keep it', 'keep it as it is', 'not a problem', 'it is not a problem'], no: ['fix it', 'fix the problem', 'it is a problem'] },
    facts: [rated, directed ? `You told us: "${directed}".` : ''].filter(Boolean).join(' '),
    question: `Should ${item} keep working as it does now, because the problem reported in it is not one?`,
    labels: { yes: 'Yes, keep it as it is', no: 'No, fix the problem' },
    then: { yes: 'the report is closed as not a problem and nothing is changed for it; the delivery note does not list it, and the report and why it is not a problem stay in the record', no: 'it stays open and is fixed in this delivery (a fix, a short review and the tests) before it ships' },
  }),
  gateOrder: ({ item, owes = {} }) => ({
    aliases: { yes: ['run the tests', 'run them', 'run it'], no: ['keep the order', 'wait'] },
    question: `Should ${item}'s full test run start now, ${[owes.uncovered ? 'before a code review has looked at the latest code' : '', owes.open?.length ? `while the last code review still has ${owes.open.length === 1 ? 'a problem' : `${owes.open.length} problems`} open` : '', owes.unverified?.length ? `before a reviewer has confirmed ${owes.unverified.length === 1 ? 'an earlier problem is' : `${owes.unverified.length} earlier problems are`} fixed` : '', owes.validationPending ? 'before a code review has checked a newly added test step' : ''].filter(Boolean).join(', and ') || 'before the step that normally comes first'}?`,
    labels: { yes: 'Run the tests now', no: 'Keep the usual order' },
    then: { yes: 'the full test run starts on the current code, and the skipped order is recorded with your answer; everything else delivery needs still applies', no: 'the step that comes first (a code review that finds nothing left to fix) happens before the tests' },
  }),
  acknowledge: ({ item, repo, observed }) => ({
    aliases: { yes: ['count it'], no: ['not yet'] },
    question: `Should the ${repo} part of ${item} count as delivered, although ${observed === 'ci-failed' ? 'its automatic checks failed after the merge' : observed === 'rejected' ? 'its merge was reported as rejected' : `its delivery reports "${observed}" after the merge`}?`,
    labels: { yes: 'Count it as delivered', no: 'Not yet' },
    then: { yes: 'the delivery is recorded as done, with the failed check shown beside it; anything to fix goes into a new attempt of the ticket', no: 'the delivery stays unfinished until the check passes, or the delivery settings are corrected' },
  }),
  repin: ({ item, tip }) => ({
    aliases: { yes: ['use them', 'use the new settings'], no: ['keep them'] },
    question: `Should the rest of ${item}'s delivery use the corrected delivery settings now on the main branch?`,
    labels: { yes: 'Use the corrected settings', no: 'Keep the current settings' },
    then: { yes: `the rest of the delivery runs with the settings committed at ${tip}; the tests and reviews already done stay as they are`, no: 'the delivery goes on with the settings it started with' },
  }),
  closeShipped: ({ item, hold }) => ({
    aliases: { yes: ['close it'], no: ['keep it'] },
    question: `${item}'s change is already on its main branch (it was merged outside the workflow). Should it be closed as shipped, without the workflow's final acceptance?${hold ? ` This also ends your pause on it ("${hold}").` : ''}`,
    labels: { yes: 'Close it as shipped', no: 'Keep it open' },
    then: { yes: 'it is closed as shipped; what was still open stays in its record, and its working folders are removed', no: 'it stays open' },
  }),
  // 0.7.27 (I-196, D42): the delivery waits for the deployment, and it cannot be confirmed (or the fix failed there).
  closeUndeployed: ({ item, why, where }) => ({
    aliases: { yes: ['close it without it', 'close it anyway', 'close the delivery'], no: ['keep it open', 'keep waiting', 'wait'] },
    question: `${item}'s change is merged, but ${why}. Should its delivery be closed without that confirmation? The ticket is not moved to its final status: it stays where the delivery put it.`,
    labels: { yes: 'Close it, the ticket stays as it is', no: 'Keep it open' },
    then: { yes: 'the delivery is closed without a confirmed deployment, with the reason in its record; the ticket is yours to move, or to reopen for a fix', no: `it stays open until the deployment in ${where} is confirmed and the fix tested there` },
  }),
  abandonIntegration: ({ item, repo }) => ({
    aliases: { yes: ['give it up', 'abandon it'], no: ['keep it'] },
    question: `Should this attempt at ${item} be given up, now that its open merge in ${repo} has been closed?`,
    labels: { yes: 'Give it up', no: 'Keep it' },
    then: { yes: 'it is closed as abandoned and its working folders are removed; none of it is delivered', no: 'it stays open' },
  }),
  abandonSplit: ({ item, id }) => ({
    aliases: { yes: ['give it up', 'abandon it'], no: ['keep it'] },
    question: `Should ${id} be given up? It carries part of ${item}'s work that was split so that all parts ship together.`,
    labels: { yes: 'Give it up', no: 'Keep it' },
    then: { yes: 'it is closed as abandoned; the work it carries does not ship with the other parts and needs a new attempt', no: 'it stays, and ships with the other parts' },
  }),
  abandonBatch: ({ batch, members }) => ({
    aliases: { yes: ['give it up', 'abandon it'], no: ['keep it'] },
    question: `Should ${batch}, the combined delivery of ${members.join(' and ')}, be given up? Its parts were split so that they ship together; after this they no longer have to.`,
    labels: { yes: 'Give it up', no: 'Keep it' },
    then: { yes: 'the combined delivery is closed (its branch is kept); its parts are released, so each can be combined again (or delivered alone if it ran its full test run), anything a part handed to it to fix comes back to that part, and work made only in the combined delivery is not delivered', no: 'it stays, and its parts ship together' },
  }),
  leaveAbandoned: ({ id, batch }) => ({
    aliases: { yes: ['release it', 'take it out'], no: ['leave it'] },
    question: `${id} is still tied to ${batch}, a combined delivery that was given up earlier, so it cannot ship. It was split from other work so that they ship together. Should it be released, so it can be combined again?`,
    labels: { yes: 'Release it', no: 'Leave it as it is' },
    then: { yes: 'it is free to be combined again with the parts that remain', no: 'it stays tied to the given-up delivery and cannot ship' },
  }),
  eject: ({ id, batch }) => ({
    aliases: { yes: ['take it out'], no: ['keep it'] },
    question: `Should ${id} be taken out of ${batch}, the combined delivery that was set up so that it ships together with its other parts?`,
    labels: { yes: 'Take it out', no: 'Keep it in' },
    then: { yes: 'it is delivered on its own; what the split moved into it no longer ships with the other parts', no: 'it stays in the combined delivery' },
  }),
  liftHold: ({ item, reason }) => ({
    aliases: { yes: ['lift it', 'unpause it', 'resume it'], no: ['keep it', 'keep it paused'] },
    question: `Should your pause on ${item} be lifted? You paused it with: "${reason}".`,
    labels: { yes: 'Lift the pause', no: 'Keep it paused' },
    then: { yes: 'work and delivery continue', no: 'nothing more is delivered until you lift it' },
  }),
  adopt: ({ item }) => ({
    aliases: { yes: ['take it', 'take over'], no: ['leave it'] },
    question: `Should this session take over ${item} from another session that may still be working on it?`,
    labels: { yes: 'Take it over', no: 'Leave it with the other session' },
    then: { yes: 'this session continues the work, and the other session no longer owns it', no: 'the other session keeps it' },
  }),
  correctCheck: ({ item }) => ({
    aliases: { yes: ['use it', 'use the corrected one'], no: ['keep it', 'keep the original'] },
    question: `Should a test step that was frozen when work on ${item} started be replaced by its corrected version?`,
    labels: { yes: 'Use the corrected step', no: 'Keep the original step' },
    then: { yes: 'the corrected step replaces it (the original stays in the record); a fresh code review and the full test run follow', no: 'the original step stays' },
  }),
  owner: ({ rounds }) => ({
    question: `This ticket has been through ${rounds} review round${rounds === 1 ? '' : 's'} and the reviews keep finding problems. How should it go on?`,
  }),
};

// 0.7.27 (I-192, D41). The frame a decision was asked under, read from its kind and key. Named failure (field): a decision
// `wf close --shipped` created under 0.7.17 carried no aliases, no labels and no plain words (frames came in 0.7.23), so the
// person's "ok we can close this then" named nothing the engine knew, although the decision's kind and key say which frame it is.
// The engine's words for a frame apply to every question asked under it, whichever release asked it.
const FRAME_KEYS = [
  ['override-gate', 'close-shipped:', 'closeShipped'],
  ['override-gate', 'deployment-close:', 'closeUndeployed'],
  ['override-gate', 'abandon:', 'abandonIntegration'],
  ['override-gate', 'gate:', 'gateOrder'],
  ['override-gate', 'acknowledge:', 'acknowledge'],
  ['override-gate', 'repin:', 'repin'],
  ['override-gate', 'correct-admission:', 'correctCheck'],
  ['lift-hold', 'release:', 'liftHold'],
  ['adopt-live', 'adopt:', 'adopt'],
  ['move-out-of-batch', 'abandon-split:', 'abandonSplit'],
  ['move-out-of-batch', 'abandon-batch:', 'abandonBatch'],
  ['move-out-of-batch', 'eject-abandoned:', 'leaveAbandoned'],
  ['move-out-of-batch', 'eject:', 'eject'],
  ['move-out-of-batch', 'nonissue:', 'notDefect'],
  ['move-out-of-batch', 'rate:', 'rateDown'],
  ['move-out-of-batch', 'leave:', 'leave'],
  ['waive-finding', '', 'waive'],
];
export const frameOf = (d) => FRAME_KEYS.find(([kind, prefix]) => d?.kind === kind && String(d.key ?? '').startsWith(prefix))?.[2] ?? null;
// What a frame needs to say its words with none of the decision's facts (a word that needs a fact is left out).
const PROBES = { waive: { n: 1 }, leave: { LEAVE, FIX }, gateOrder: { owes: {} }, abandonBatch: { members: [] } };

// The decision's action in the person's own terms (0.7.27, I-192, D41): what a reply may say to choose an option when the
// message before it neither quoted the question nor named the decision. `<it>` is a reference to the work (it, this, that,
// the ticket, the task, the attempt, the item's or the attempt's id); `<it?>` is one or nothing ("go ahead and close").
// These are the frame's own verbs and labels, specific to what it decides, never a generic word: "continue", "stop",
// "keep it" or "fix it" said about something else must never answer a question (independent security review of 0.7.23), so
// an escalation and a frame whose words are generic have none, and a "no" is an act only where its words are as specific.
const ACTS = {
  closeShipped: { yes: ['close <it?>', 'closing <it?>', 'mark <it> as shipped', 'mark <it> shipped'], no: ['keep <it> open', 'leave <it> open'] },
  closeUndeployed: { yes: ['close <it?>', 'close <it?> without the confirmation', 'close <it?> anyway', 'close the delivery'], no: ['keep <it> open', 'keep waiting'] },
  liftHold: { yes: ['lift the pause', 'lift the hold', 'lift <it>', 'unpause <it?>', 'end the pause'], no: ['keep <it> paused', 'keep the pause', 'keep the hold'] },
  adopt: { yes: ['take <it> over', 'take over <it?>'], no: ['leave <it> with the other session'] },
  abandonIntegration: { yes: ['give <it> up', 'abandon <it?>'] },
  abandonSplit: { yes: ['give <it> up', 'abandon <it?>'] },
  abandonBatch: { yes: ['give <it> up', 'abandon <it?>'] },
  gateOrder: { yes: ['run the tests now', 'run the full test run', 'run the gate', 'start the tests'], no: ['keep the usual order'] },
  acknowledge: { yes: ['count <it> as delivered'] },
  repin: { yes: ['use the corrected settings', 'use the new settings'], no: ['keep the current settings'] },
  correctCheck: { yes: ['use the corrected step', 'use the corrected check'], no: ['keep the original step', 'keep the original check'] },
  waive: { yes: ['accept <it> and ship', 'accept <it> as is', 'ship <it> as is'] },
  leave: { [LEAVE]: ['let <it> leave'] },
};

// The engine's words for each choice of a decision: the aliases and labels it was asked with, the ones its frame gives today
// (an earlier release's question gets them too), and the acts above. { choice: { phrases, acts } }; display is unchanged
// (`labelOf` still shows what the question showed).
export function choiceWords(d) {
  const name = frameOf(d);
  let f = null;
  try {
    f = name ? FRAMES[name]({ ...(PROBES[name] ?? {}) }) : null;
  } catch {
    f = null;
  }
  const clean = (xs) => (Array.isArray(xs) ? xs : [xs]).filter((x) => typeof x === 'string' && x.trim() && !x.includes('undefined'));
  return Object.fromEntries((d?.choices ?? []).map((c) => [c, { phrases: [...new Set([...clean(d.aliases?.[c] ?? []), ...clean(f?.aliases?.[c] ?? []), ...clean(f?.labels?.[c] ?? [])])], acts: clean(ACTS[name]?.[c] ?? []) }]));
}
