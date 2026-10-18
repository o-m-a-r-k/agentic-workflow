// A product or design decision the person made outside the engine, recorded (0.7.31, I-217, D65).
//
// Named failure (field): the owner recorded a decision with the person before any research, then asked them through the host's
// question panel, seven seconds after a research report, a question whose two options both built a change. Nothing recorded the
// question, what the recommendation rested on or what the person said; the research had no "not checked" list, and what it did
// say (nothing in production writes the field) never reached the person. The change was built and reverted.
//
// `wf decide` records such a decision: the question as it was asked, the recommendation, what it rests on (what was traced and the
// evidence), what was not checked, the option the person chose and their own words, proven theirs as a reading of an answer is
// (D41: verbatim in one of their own messages in this session, about this ticket; or typed in their own terminal). It is a record,
// never a gate and never a refusal of work: no step waits for it and none is refused without it. It shows in `wf resume`, and every
// later planner, implementer and reviewer bundle carries it as `decisions` (a blind reviewer without the person's words). When an
// analysis changes the picture, the owner withdraws it with what changed (`wf decide withdraw`) and asks the person again. Reserved
// decisions are not this: they are asked and recorded through the engine (`wf approve`), and nothing here grants one.
import fs from 'node:fs';
import readline from 'node:readline';
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import { personSaid, underAgent } from './approve.mjs';
import { productAsk } from './asking.mjs';
import { projectItemIds } from './leaving.mjs';
import { WfError, refuse } from './util.mjs';

const text = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const FIELDS = [
  ['question', 'question', 'the question as you asked it, in the plain words the person read'],
  ['recommend', 'recommend', 'what you recommended and why'],
  ['basis', 'basis', 'what the recommendation rests on: what you traced (who writes the data in production, who reads it, the business process and external systems that depend on it, what happens when it is absent) and the evidence (path:line)'],
  ['notChecked', 'not-checked', 'what you did not check ("nothing" only when nothing was left)'],
  ['choice', 'choice', 'the option the person chose, as you offered it (or other)'],
];
export const DECIDE_USAGE = 'wf decide --question "<as asked>" --options "<option 1> | <option 2>" --recommend "<what you recommended and why>" --basis "<what you traced, with the evidence>" --not-checked "<what you did not check>" --choice "<the option they chose, or other>" --quote "<their words, exactly as they typed them>" [--attempt ID] (or --file <decision.json> with question, options, recommend, basis, notChecked, choice, quote)';
// Review of 0.7.31 (M2). Named failure (the incident behind D65): the question's two options both built the change, and a record of
// the question, the recommendation and the answer alone would not show it. The options offered are part of the record, and the
// choice is one of them (or `other`: words that choose none, kept as the person's, D41).
const optionsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('|') : []).map((x) => text(String(x ?? ''))).filter(Boolean).slice(0, 10);
const same = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

// The decision's fields from `--file` (JSON) and the flags (a flag wins).
function fieldsOf(options) {
  let doc = {};
  if (typeof options.file === 'string') {
    try {
      doc = JSON.parse(fs.readFileSync(options.file, 'utf8'));
    } catch (error) {
      throw new WfError(`--file ${options.file}: not a JSON file (${String(error.message).split('\n')[0]})`, { hint: DECIDE_USAGE });
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new WfError(`--file ${options.file} is not a JSON object`, { hint: DECIDE_USAGE });
  }
  const out = {};
  for (const [key, flag] of FIELDS) out[key] = text(typeof options[flag] === 'string' ? options[flag] : doc[key] ?? doc[flag]);
  out.quote = typeof options.quote === 'string' ? options.quote.trim() : typeof doc.quote === 'string' ? doc.quote.trim() : '';
  out.options = optionsOf(typeof options.options === 'string' ? options.options : doc.options);
  const missing = FIELDS.filter(([key]) => !out[key]).map(([, flag, what]) => `--${flag} (${what})`);
  if (out.options.length < 2) missing.push('--options (the options you offered, at least two, separated by "|")');
  if (missing.length) throw new WfError(`not recorded: ${missing.join('; ')}`, { hint: DECIDE_USAGE });
  const picked = out.options.find((o) => same(o, out.choice));
  if (!picked && !same(out.choice, 'other')) throw refuse(`not recorded: "${out.choice}" is not one of the options offered (${out.options.map((o) => `"${o}"`).join(' | ')})`, 'give the option they chose exactly as you offered it, or `--choice other` when their words choose none of them (their words are recorded as theirs)', { id: 'decide:choice' });
  out.choice = picked ?? 'other';
  return out;
}

// `wf decide ...`: record the decision; from an agent's session the person's words are proven theirs.
export async function recordProductDecision(root, options, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const state = openState(root, options);
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}: a decision for its product is recorded on the attempt that builds it`, null, { id: 'decide:closed' });
  const f = fieldsOf(options);
  const id = `PD${(state.productDecisions ?? []).length + 1}`;
  const plain = productAsk(f);
  let said;
  if (underAgent(env)) {
    if (!f.quote) throw new WfError('not recorded: --quote "<the person\'s words, exactly as they typed them>" is how their answer is proven theirs', { hint: DECIDE_USAGE });
    const proven = await personSaid(f.quote, { sinceAt: state.admittedAt, item: state.item ?? null, attempt: state.id, ids: projectItemIds(root, state), env });
    if (proven.problem) throw refuse(`not recorded: ${proven.problem}`, `quote the words of theirs that answer this question, exactly as they typed them; when they have not answered it for this ticket, ask them (the question, your recommendation, what it rests on and what you did not check); or they run \`wf decide\` in their own terminal`, { id: 'decide:quote' });
    said = { quote: proven.quote, message: proven.message, said: proven.at, via: proven.via };
  } else {
    if (!input.isTTY || !output.isTTY) throw refuse('not an interactive terminal: `wf decide` without an agent session is the person\'s own command, where it asks them to confirm', `run it in a terminal`, { id: 'decide:terminal' });
    output.write(`${state.id}: record that you chose "${f.choice}". ${plain} Type yes to record it: `);
    const rl = readline.createInterface({ input, output, terminal: true });
    const typed = await new Promise((resolve) => rl.once('line', (l) => { rl.close(); resolve(String(l).trim()); }));
    if (typed.toLowerCase() !== 'yes') throw refuse('not recorded: the answer was not yes', null, { id: 'decide:terminal' });
    said = { quote: f.quote || f.choice, via: 'terminal' };
  }
  append(root, state.id, 'product.decided', { id, question: f.question.slice(0, 2000), options: f.options.map((o) => o.slice(0, 300)), recommend: f.recommend.slice(0, 2000), basis: f.basis.slice(0, 4000), notChecked: f.notChecked.slice(0, 2000), choice: f.choice.slice(0, 500), plain: plain.slice(0, 8000), ...said }, actor(options));
  return { state: loadState(root, state.id), id };
}

// `wf decide withdraw <id> --reason "<what changed>"`: the analysis changed the picture; the person is asked again.
export function withdrawProductDecision(root, id, options) {
  const state = openState(root, options);
  const d = (state.productDecisions ?? []).find((x) => x.id === id);
  if (!d) throw new WfError(`no product decision ${id ?? ''} on ${state.id} (recorded: ${(state.productDecisions ?? []).map((x) => x.id).join(', ') || 'none'})`);
  if (d.withdrawn) throw refuse(`${id} is already withdrawn ("${d.withdrawn.reason}")`, null, { id: 'decide:withdrawn' });
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!reason) throw new WfError('--reason says what changed (what the analysis found)');
  append(root, state.id, 'product.withdrawn', { id, reason: reason.slice(0, 2000) }, actor(options));
  return loadState(root, state.id);
}

// What a role's bundle carries: every decision with what it rested on. Review of 0.7.31 (L5): a reviewer gets only the question,
// the options, the choice and what was not checked: the incident was a reviewer absorbing the owner's framing, so neither the
// owner's recommendation nor its basis, nor the person's words, reach it.
export function productDecisionsFor(state, role) {
  const all = state.productDecisions ?? [];
  if (!all.length) return undefined;
  return all.map((d) => ({
    id: d.id, at: d.at, question: d.question, options: d.options ?? [],
    ...(role === 'reviewer' ? {} : { recommend: d.recommend, basis: d.basis }),
    notChecked: d.notChecked, choice: d.choice,
    ...(role === 'reviewer' ? {} : { quote: d.quote }),
    ...(d.withdrawn ? { withdrawn: { reason: d.withdrawn.reason, at: d.withdrawn.at } } : {}),
  }));
}

// The lines `wf resume` and `wf status` show.
export const productDecisionLines = (state) => (state.productDecisions ?? []).map((d) => (d.withdrawn
  ? `  product decision ${d.id} (withdrawn: ${d.withdrawn.reason}): "${d.question}" was answered "${d.choice}"; ask the person again with what changed`
  : `  product decision ${d.id}: "${d.question}"${d.options?.length ? ` (options: ${d.options.map((o) => `"${o}"`).join(' | ')})` : ''} -> "${d.choice}" (their words: "${d.quote}"), ${d.via ?? 'recorded'}; recommended: ${d.recommend}; rests on: ${d.basis}; not checked: ${d.notChecked}`));
