// What may leave a delivery unfixed (D17, refined by D18 in 0.7.8). By default a review finding or discovered issue that is
// high or medium (unrated, citing a frozen criterion or breaking a critical invariant counts as high) is fixed in this
// delivery batch, here or in a sibling attempt; a low one leaves only with the person's answer. The project's adapter may
// change who decides each level (`leaving: { high, medium, low }`: never, person or owner). The person's `deliver-core`
// answer to the round escalation stays the one exception: they decided there that what does not block may leave.
//
// D18 (0.7.8), named failure (field): the person was asked one yes/no question about three items at once, in the reviewers'
// own long text, so they could neither understand it nor fix one and let another go; their written answer ("fix all here,
// except F3 if a follow-up ticket already has it") was not a choice, so the question stayed open. Each item is now its own short question,
// with two choices, and an answer in the person's own words is recorded as theirs (from 0.7.27, D41, when the agent reads it so).
import { READ_LINE, createDecision, decisionFor, deliverCoreDecision, optionLines, questionFor, settledBy } from './approve.mjs';
import { FIX, FRAMES, LEAVE, askFirst, askProblems, composeAsk, itemAsk, itemWords, readAsk } from './asking.mjs';
import { refuse } from './util.mjs';

export { FIX, LEAVE };
const LEVELS = ['high', 'medium', 'low'];
export const DEFAULT_POLICY = { high: 'never', medium: 'never', low: 'person' };
export const policyOf = (cfg) => ({ ...DEFAULT_POLICY, ...(cfg?.leaving ?? {}) });

const who = { never: 'never leaves (fixed here, or in a sibling attempt of the batch)', person: 'leaves only with the person\'s answer', owner: 'may leave on the owner\'s recorded reason' };
export const ruleText = (policy = DEFAULT_POLICY) => `${LEVELS.map((l) => `${l}: ${who[policy[l]]}`).join('; ')}${LEVELS.every((l) => policy[l] === DEFAULT_POLICY[l]) ? '' : ' (the project\'s `leaving:` policy)'}; a fix that needs a product decision is a question for the person, not a deferral`;
export const RULE = ruleText();
// The same rule in a line, for routine output (next steps, a recorded issue); refusals print the full rule.
export const RULE_SHORT = 'medium and high are fixed in this delivery; a low one leaves only with the person\'s answer, one short question per item (`wf scope defer` or `wf scope ticket`), unless the project\'s `leaving:` policy says otherwise';

// The first sentence of a long text, for a question the person reads on a phone; the whole text stays in the record.
const firstSentence = (s) => {
  const t = String(s ?? '').replace(/^left by [^:]+:\s*/, '').replace(/^F\d+:\s*/, '').trim();
  // The end of the first sentence: a full stop or semicolon after a word longer than two letters (not "e.g", "i.e").
  const end = t.search(/(?<![\s.][A-Za-z]{1,2})[.;](\s|$)/);
  const cut = end > 0 && end < 200 ? t.slice(0, end) : t;
  return cut.length > 200 ? `${cut.slice(0, 197)}...` : cut;
};
const shortWhere = (w) => (w ? String(w).split('/').pop() : null);

// The owner's plain line for an item (`--explain`), kept on its decision: the delivered comment names the item by it.
const plainWhat = (x, explain) => (typeof explain?.[x.ref]?.what === 'string' && explain[x.ref].what.trim() ? explain[x.ref].what.trim() : null);

// Who rated an item, by role (an agent's id means nothing to the person), and every re-rating (D18): "Rated low by a
// reviewer, re-rated medium to low (why)".
const raterOf = (by) => (!by ? 'its reporter' : /^reviewer /.test(by) ? 'a reviewer' : /^its implementer /.test(by) ? 'the implementer' : /^human:/.test(by) ? 'a person' : 'the agent running the ticket');
export const ratedText = (x) => `Rated ${x.severity ?? x.level} by ${raterOf(x.ratedBy)}${x.ratings?.length ? `, re-rated ${x.ratings.map((r) => `${r.from ?? 'unrated'} to ${r.to}${r.reason ? ` (${r.reason})` : ''}`).join(', ')}` : ''}.`;

// The item's facts for the record (the decision's summary): what is wrong in one line, the facts behind its rating, and
// what leaving means.
function questionText(x, verb, explain) {
  const what = typeof explain?.[x.ref]?.what === 'string' && explain[x.ref].what.trim() ? explain[x.ref].what.trim() : firstSentence(x.summary);
  const rated = `${x.severity ?? x.level}, rated by ${x.ratedBy ?? 'its reporter'}${x.ratings?.length ? `, re-rated ${x.ratings.map((r) => `${r.from ?? 'unrated'} to ${r.to}${r.reason ? ` (${r.reason})` : ''}`).join(', ')}` : ''}${x.where ? `, ${shortWhere(x.where)}` : ''}`;
  return `${x.ref}: ${what} (${rated}). Fix it now, or let it leave this delivery ${verb === 'ticketed' ? 'as a follow-up ticket' : 'as a known issue'}?`;
}

// items: [{ ref, level, blocks, severity, summary, raisedAt, ratedBy, ratings, where }]. Returns { ref: decision id |
// 'owner' } for every item that may leave, or throws: a refusal naming what must stay, the person's answers to follow, or
// the person's questions (one per item, asked together).
export function leavingDecisions(root, state, items, { verb, reason = '', options = {}, policy = DEFAULT_POLICY, explain = {} }) {
  const blocking = items.filter((x) => x.blocks);
  if (blocking.length) throw refuse(`${blocking.map((x) => x.ref).join(', ')} ${blocking.length > 1 ? 'block' : 'blocks'} this delivery: it is fixed here; a finding the person judges wrong is waived by them (\`wf scope waive\`)`, null, { id: 'leave:blocks' });
  const raised = items.map((x) => x.raisedAt).filter(Boolean).sort().at(-1) ?? null;
  const core = deliverCoreDecision(state, raised);
  if (core) return Object.fromEntries(items.map((x) => [x.ref, core.id]));
  // I-142 (the person's rule, 2026-10-15): when the person directs that an item stays out of the ticket ("leave the legacy
  // part unchanged"), even a level that never leaves may leave on their own answer to that item; an agent never lets it go.
  // The owner passes the person's words (`--person-directed "<their words>"`); the person still answers each item.
  const directed = typeof options['person-directed'] === 'string' && options['person-directed'].trim() ? options['person-directed'].trim().slice(0, 500) : null;
  // 0.7.23 (D29): an item the person's answer to an escalation already decided (its chosen option settles it) leaves under that
  // answer, whatever its level: the person read that the option decides it.
  const settled = Object.fromEntries(items.map((x) => [x.ref, settledBy(state, x.ref)]).filter(([, d]) => d));
  const whoFor = (x) => { if (settled[x.ref]) return 'settled'; const w = policy[x.level] ?? DEFAULT_POLICY[x.level]; return w === 'never' && directed ? 'person' : w; };
  const kept = items.filter((x) => whoFor(x) === 'never');
  if (kept.length) throw refuse(`not ${verb}: ${kept.map((x) => `${x.ref} (${x.level}${x.severity && x.severity !== x.level ? `, rated ${x.severity}` : ''})`).join(', ')} ${kept.length > 1 ? 'stay' : 'stays'} in this delivery: ${ruleText(policy)}`, 'fix it through the implementer that did that work, or move it to a sibling attempt of the batch (`wf scope move`); if the person told you to leave it out of this ticket, run this again with `--person-directed "<their words>"`: they answer each item themselves', { id: 'leave:medium-high' });
  // 0.7.28 (I-207): the person's "fix all" (`wf scope fix-all`) is their answer for every item they would be asked about: none is
  // asked again, unless they now direct one out (`--person-directed`, their new words), which asks that item.
  const fixAll = state.fixAll && !directed ? items.filter((x) => whoFor(x) === 'person' && !decisionFor(state, 'move-out-of-batch', `leave:${x.ref}`)) : [];
  if (fixAll.length) throw refuse(`not ${verb}: the person said to fix every item ("${state.fixAll.words}", ${state.fixAll.at}), so ${fixAll.map((x) => x.ref).join(', ')} ${fixAll.length > 1 ? 'are' : 'is'} fixed in this delivery and not asked about again`, 'fix it in the next planned pass (`wf resume` names it); if the person now tells you to let one leave, run this again with `--person-directed "<their words>"`: they answer that item themselves', { id: 'leave:fix-all' });
  const owner = items.filter((x) => whoFor(x) === 'owner');
  if (owner.length && !reason) throw refuse(`${owner.map((x) => x.ref).join(', ')} may leave on your judgement under the project's \`leaving:\` policy: say why it waits`, 'pass `--reason "<why it can wait>"`', { id: 'leave:owner-reason' });
  const decided = Object.fromEntries([...owner.map((x) => [x.ref, 'owner']), ...Object.entries(settled).map(([ref, d]) => [ref, d.id])]);
  const answered = [];
  const asked = [];
  const unworded = [];
  const ask = readAsk(options);
  let current = state;
  for (const x of items.filter((i) => whoFor(i) === 'person')) {
    const d = decisionFor(current, 'move-out-of-batch', `leave:${x.ref}`);
    if (d?.approved && !d.spent) {
      if (d.approved.choice === LEAVE) decided[x.ref] = d.id;
      else answered.push({ x, d });
      continue;
    }
    if (d && !d.approved) {
      asked.push({ x, d });
      continue;
    }
    const neverLevel = (policy[x.level] ?? DEFAULT_POLICY[x.level]) === 'never';
    const frame = FRAMES.leave({ item: state.item, ticketed: verb === 'ticketed', fix: itemWords(ask, explain, x.ref).fix, LEAVE, FIX, directed: neverLevel ? directed : null, level: x.level, rated: ratedText(x) });
    const words = itemAsk(ask, explain, x.ref);
    const problems = askProblems(words, { choices: [LEAVE, FIX], labels: frame.labels, items: [x.ref], explain });
    if (problems.length) {
      unworded.push({ x, frame, problems });
      continue;
    }
    const made = createDecision(root, current, { kind: 'move-out-of-batch', key: `leave:${x.ref}`, summary: neverLevel ? `${questionText(x, verb, explain)} (Your rule fixes ${x.level} items in the delivery; you asked to leave this out: "${directed}".)` : questionText(x, verb, explain), choices: [LEAVE, FIX], ...composeAsk(words, frame, [LEAVE, FIX], { items: [{ ref: x.ref, ...itemWords(ask, explain, x.ref) }], itemNoun: 'issue' }), ...(neverLevel ? { personDirected: directed } : {}), what: plainWhat(x, explain) ?? itemWords(ask, explain, x.ref).what, options });
    asked.push({ x, d: made });
    current = { ...current, decisions: [...(current.decisions ?? []), made] };
  }
  if (unworded.length) {
    const refs = unworded.map(({ x }) => x.ref);
    const { frame } = unworded[0];
    throw askFirst(`letting ${refs.join(', ')} leave without a fix`, frame, [LEAVE, FIX], [...new Set(unworded.flatMap(({ x, problems }) => problems.map((p) => (refs.length > 1 ? `${x.ref}: ${p}` : p))))], unworded.map(({ x }) => questionText(x, verb, explain)).join(' | '), { items: refs });
  }
  if (answered.length) {
    const fixNow = answered.filter(({ d }) => d.approved.choice === FIX);
    const words = answered.filter(({ d }) => d.approved.choice !== FIX);
    throw refuse(`not ${verb}: ${[fixNow.length ? `the person chose to fix ${fixNow.map(({ x, d }) => `${x.ref} (${d.id})`).join(', ')} now` : '', words.length ? `the person answered ${words.map(({ x, d }) => `${x.ref} in their own words, "${d.approved.words ?? d.approved.choice}" (${d.id})`).join(', ')}, which is neither choice` : ''].filter(Boolean).join('; ')}`, `${fixNow.length ? 'fix what they chose to fix and leave it out of this command' : ''}${fixNow.length && words.length ? '; ' : ''}${words.length ? `follow their words: if they mean "fix now", fix it; if they mean "let it leave", withdraw the answer with their words as the reason (\`wf decisions withdraw <id> --reason "<their words>"\`) and ask again with the two options` : ''}`, { id: 'leave:person-answered' });
  }
  if (asked.length) {
    const fix = (x) => (typeof explain?.[x.ref]?.fix === 'string' && explain[x.ref].fix.trim() ? explain[x.ref].fix.trim() : 'fixed in this delivery (a fix pass, a delta review and the gate)');
    const lines = asked.map(({ x, d }) => `  ${d.id}  header "${x.ref}"\n      question: "${questionFor(state, d)}"\n      options: ${d.labels ? optionLines(d) : `"${LEAVE}" (${verb === 'ticketed' ? 'tracked as a follow-up ticket' : 'listed as a known issue in the delivery comment'}) | "${FIX}" (${fix(x)})`}\n      then: wf approve ${d.id} --from-question --attempt ${state.id}`);
    throw refuse(`the person decides ${asked.length > 1 ? 'these' : 'this'} (one short question per item; ask them together, as many questions in one panel as it allows):\n${lines.join('\n')}`, `ask exactly these questions with exactly these two options each, by their labels with what follows each as its description. Say in your reply, in plain words, what each item is and what fixing it takes. Ask them in your messages, one question per message, quoting it exactly with its two options, so the person can type each answer, or together in your question panel; a typed reply and a panel answer both count. Run its \`wf approve <id> --from-question\` after each answer (${READ_LINE}); or they run \`wf approve <id> --attempt ${state.id}\` in their own terminal (I-135). Then run this command again with the items they let leave`, { id: 'leave:ask' });
  }
  return decided;
}

// The rating facts of a discovered issue for the person's question: its reporter and every re-rating.
export const discoveredRating = (d) => ({ ratedBy: d.foundBy ? `${/^left by /.test(d.summary ?? '') ? 'its implementer ' : ''}${d.foundBy}` : d.by ?? null, ratings: (d.rated ?? []).map((r) => ({ from: r.from, to: r.to, by: r.by, reason: r.reason })), where: d.where ?? null });
