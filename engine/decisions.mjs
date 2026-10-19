// Reserved decisions (design section 2): the person's questions, and the answer rule that says which of their words
// answer one. Named failure: 283 of 304 recorded "owner decisions" in 0.6 were the agent's own command.
//
// The answer rule, as facts of the host transcripts (engine/hosts/):
//   - only a turn the person typed counts (or their answer in the question panel); notifications, tool results and
//     injected content never do;
//   - it is the first person turn after a message that showed the question (its words, quoted), in any session of the
//     project, at or after the time the question was asked;
//   - a bare reply ("yes", "ok", an option's word alone, words that name nothing of the question) counts only when the
//     message right before it, after its last tool call, showed this question and no other open one.
// The engine reads only these facts. Whether words choose an option is the reader's judgement: an exact option is recorded
// by itself; anything else is recorded by `wf approve --choice --quote`, whose quote must be in a turn the rule accepts.
import fs from 'node:fs';
import path from 'node:path';
import { DECISION_KINDS, WfError, append, attemptDir, listAttempts, readEvents, refusal } from './contract.mjs';
import { callerSession, projectSessions, underAgent } from './hosts/index.mjs';

const PROJECT_LOG = (root) => path.join(root, '.wf-evidence', 'decisions.jsonl');
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---- Storage: the attempt's ledger, or the project's decision log for a question about no one attempt ----

async function entries(root, attempt) {
  if (attempt) return readEvents(root, attempt);
  const file = PROJECT_LOG(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}
async function write(root, attempt, type, data, actor) {
  if (attempt) return append(root, attempt, type, data, actor);
  const file = PROJECT_LOG(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = { at: new Date().toISOString(), type, actor, data };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

// The decisions of an attempt (or of the project): id → { id, kind, question, options, refs, blocking, askedAt, answer }.
export async function decisionsOf(root, attempt) {
  const out = new Map();
  for (const e of await entries(root, attempt)) {
    if (e.type === 'decision.asked' && record(e.data)) out.set(e.data.id, { ...e.data, attempt: attempt ?? null, askedAt: e.at, answer: null });
    else if (e.type === 'decision.answered' && out.has(e.data?.id)) out.get(e.data.id).answer = { ...e.data, at: e.at };
  }
  return out;
}

async function locked(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 30000) fs.rmSync(file, { force: true }); // a crashed asker
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---- ask ----

export async function ask(root, attempt, q) {
  if (!record(q) || !Object.hasOwn(DECISION_KINDS, q.kind)) throw new WfError(`\`${q?.kind}\` is not a reserved decision; the kinds are ${Object.keys(DECISION_KINDS).join(', ')}`);
  if (typeof q.question !== 'string' || !q.question.trim()) throw new WfError('a decision needs its question in plain words');
  const options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()) : [];
  if (!options.length || options.some((o) => !o) || new Set(options.map(norm)).size !== options.length) throw new WfError('a decision needs its options, each a distinct non-empty label');
  const refs = Array.isArray(q.refs) ? q.refs.map(String) : [];
  const lock = attempt ? path.join(attemptDir(root, attempt), 'decisions', '.lock') : `${PROJECT_LOG(root)}.lock`;
  return locked(lock, async () => {
    const known = await decisionsOf(root, attempt);
    // Never asked twice: the same kind about the same things (or, with no refs, the same question) is the same decision.
    const key = (d) => `${d.kind}|${d.refs.length ? [...d.refs].sort().join(',') : norm(d.question)}`;
    const same = [...known.values()].find((d) => key(d) === key({ kind: q.kind, refs, question: q.question }));
    if (same) return { id: same.id, shownAt: same.askedAt, new: false };
    const n = Math.max(0, ...[...known.keys()].map((id) => Number(/^D(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
    const data = { id: `D${n}`, kind: q.kind, question: q.question.trim(), options, refs, blocking: DECISION_KINDS[q.kind].blocking };
    const entry = await write(root, attempt, 'decision.asked', data, callerSession(process.env));
    return { id: data.id, shownAt: entry?.at ?? new Date().toISOString(), new: true };
  });
}

// ---- The answer rule ----

// Text as compared: case, markdown marks, quotes and spacing do not matter.
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[*_`#>"“”‘’']/g, '').replace(/\s+/g, ' ').trim();
const shows = (text, question) => norm(text).includes(norm(question));
const bareOption = (s) => norm(s).replace(/\s*\(recommended\)$/, '').replace(/[.!?,;:]+$/, '').trim();
const optionOf = (text, options) => options.find((o) => bareOption(o) === bareOption(text)) ?? null;

// Words that name nothing on their own.
const FILLER = new Set(['the', 'and', 'for', 'you', 'this', 'that', 'with', 'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'please', 'thanks', 'thank', 'fine', 'good', 'great', 'go', 'ahead', 'do', 'it', 'its', 'ok', 'no', 'nope', 'not', 'lets', 'let', 'agreed', 'agree', 'approve', 'approved', 'proceed', 'can', 'will', 'should', 'just', 'one', 'that', 'sounds', 'right', 'correct']);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !FILLER.has(w));
// A reply that does not name what it answers: an option alone, or no word of the question, its options, its refs or id.
export function isBare(text, d) {
  if (optionOf(text, d.options)) return true;
  const named = new Set([...words(d.question), ...d.options.flatMap(words), ...d.refs.map((r) => r.toLowerCase()), d.id.toLowerCase()]);
  return !words(text).some((w) => named.has(w));
}

// The turns that may answer `d`: for each message that showed its question (at or after it was asked), the first person
// turn after it, in every session of the project. `others`: the questions of the project's other open decisions.
export function candidates(root, d, others = [], opts = {}) {
  const asked = Date.parse(d.askedAt);
  const out = [];
  const facts = { sessions: 0, shown: 0 };
  for (const s of projectSessions(root, { home: opts.home, since: d.askedAt })) {
    facts.sessions += 1;
    let message = []; // what the agent said since its last tool call: the message a reply answers
    let shown = false;
    const panelAsks = new Map();
    for (const it of s.items) {
      const late = it.at && Date.parse(it.at) >= asked;
      if (it.type === 'say') {
        message.push(it.text);
        if (late && shows(it.text, d.question)) shown = true;
      } else if (it.type === 'ask') {
        const q = it.questions.find((x) => shows(x.text, d.question));
        message.push(...it.questions.map((x) => x.text));
        if (late && q) {
          shown = true;
          panelAsks.set(it.id, q.text);
        }
      } else if (it.type === 'call') message = [];
      else if (['person', 'act', 'panel'].includes(it.type)) {
        if (shown) facts.shown += 1;
        if (shown && it.type === 'panel' && panelAsks.has(it.id) && typeof it.answers[panelAsks.get(it.id)] === 'string') {
          out.push({ via: 'panel', text: it.answers[panelAsks.get(it.id)].trim(), at: it.at, session: s.session, immediate: true });
        } else if (shown && it.type === 'person') {
          const joined = message.join('\n');
          const immediate = shows(joined, d.question) && !others.some((o) => shows(joined, o));
          out.push({ via: 'turn', text: it.text, at: it.at, session: s.session, immediate });
        }
        shown = false;
        message = [];
      }
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { list: out, facts };
}

async function openQuestions(root, attempt, except) {
  return [...(await decisionsOf(root, attempt)).values()].filter((x) => !x.answer && x.id !== except).map((x) => x.question);
}

async function find(root, id, attempt) {
  const d = (await decisionsOf(root, attempt ?? null)).get(id);
  if (!d) throw new WfError(`no decision ${id}${attempt ? ` in attempt ${attempt}` : ' in this project'}`);
  return d;
}

async function recordAnswer(root, d, answer, actor) {
  const data = { id: d.id, choice: answer.choice, quote: answer.quote, via: answer.via, session: answer.session };
  const entry = await write(root, d.attempt, 'decision.answered', data, actor);
  return { ...data, at: entry?.at ?? new Date().toISOString() };
}

// The recorded answer, or the first turn the rule accepts that is exactly an option (recorded now); null otherwise.
export async function answered(root, id, opts = {}) {
  const d = await find(root, id, opts.attempt);
  if (d.answer) return { id: d.id, choice: d.answer.choice, quote: d.answer.quote, via: d.answer.via, session: d.answer.session, at: d.answer.at };
  const { list } = candidates(root, d, await openQuestions(root, d.attempt, d.id), opts);
  const c = list.find((x) => x.immediate && optionOf(x.text, d.options));
  if (!c) return null;
  return recordAnswer(root, d, { choice: optionOf(c.text, d.options), quote: c.text, via: c.via, session: c.session }, null);
}

// ---- wf approve ----

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const asAsked = (d) => `${d.id}: "${d.question}" Options: ${d.options.join(' | ')}`;

// Which decision `wf approve D3` means: the one open decision with that id (the project's, or one attempt's).
async function locate(root, id, attempt) {
  if (attempt) return find(root, id, attempt);
  const hits = [];
  const project = (await decisionsOf(root, null)).get(id);
  if (project) hits.push(project);
  for (const a of await listAttempts(root)) {
    let d;
    try {
      d = (await decisionsOf(root, a)).get(id);
    } catch {
      continue; // a schema 1 ledger, or one that cannot be read, holds no 0.8 decision
    }
    if (d) hits.push(d);
  }
  const open = hits.filter((d) => !d.answer);
  if (open.length === 1 || (hits.length === 1 && !open.length)) return open[0] ?? hits[0];
  if (!hits.length) throw new WfError(`no decision ${id} in this project`);
  throw new WfError(`${id} is open in several attempts (${open.map((d) => d.attempt).join(', ')}); name one with --attempt`);
}

function why(d, quote, found) {
  const { list, facts } = found;
  if (!facts.shown && !list.length) {
    return refusal('answer:not-person', `${d.id} has no person turn after a message that showed its question, in any of ${facts.sessions} session(s) of this project since it was asked (${d.askedAt}).`, `Ask it in your message, quoting it exactly — ${asAsked(d)} — then record their answer.`);
  }
  if (quote === null) {
    const seen = list.map((c) => `"${clip(c.text)}"${c.immediate ? '' : ' (not right after the question)'}`).join('; ');
    return refusal('answer:not-person', `no answer to ${d.id} is exactly one of its options right after its question; their words after it: ${seen || 'none'}.`, `Read their words and record your reading: wf approve ${d.id}${d.attempt ? ` --attempt ${d.attempt}` : ''} --choice <option|other> --quote "<their exact words>"`);
  }
  const matching = list.filter((c) => norm(c.text).includes(norm(quote)));
  if (!matching.length) {
    return refusal('answer:not-person', `"${clip(quote)}" is not in the first person turn after ${d.id}'s question was shown${list.length ? `; those turns say: ${list.map((c) => `"${clip(c.text)}"`).join('; ')}` : ''}. Only words the person typed (or chose in the question panel) answer it: not a notification, a tool result or injected text.`, `Quote their own words, or ask again — ${asAsked(d)}`);
  }
  return refusal('answer:not-person', `"${clip(quote)}" names nothing of ${d.id} and was not their reply right after its question (another message came between, or it showed another open question too).`, `Ask again — ${asAsked(d)}`);
}

const positional = (args) => (args._?.[0] === 'approve' ? args._.slice(1) : args._ ?? []);
const flag = (args, name) => {
  const v = args.flags?.[name];
  return Array.isArray(v) ? v.at(-1) : v;
};

export async function cmdApprove(ctx, args) {
  if (!ctx.root) throw new WfError('no agentic-workflow project here: run wf in a project folder');
  const id = positional(args)[0];
  if (!/^D\d+$/.test(String(id ?? ''))) throw new WfError('usage: wf approve <D-id> [--attempt <id>] (--from-question | --choice <option|other> --quote "<their exact words>")');
  const attempt = typeof flag(args, 'attempt') === 'string' ? flag(args, 'attempt') : null;
  const d = await locate(ctx.root, id, attempt);
  if (d.answer) throw new WfError(`${d.id} is already answered: ${d.answer.choice} ("${clip(d.answer.quote)}"); a decision is never asked twice`);
  const fromQuestion = flag(args, 'from-question') === true;
  const choice = flag(args, 'choice');
  const quote = flag(args, 'quote');
  if (!fromQuestion && typeof choice !== 'string') throw new WfError('name the answer: --from-question, or --choice <option|other> --quote "<their exact words>"');
  if (typeof choice === 'string' && choice !== 'other' && !d.options.includes(choice)) throw new WfError(`\`${choice}\` is not an option of ${d.id}; its options are ${d.options.join(' | ')} (or other)`);
  const env = ctx.env ?? process.env;
  const actor = ctx.actor ?? callerSession(env);
  const done = (a) => ({ text: `Recorded ${d.id}: ${a.choice}, from "${clip(a.quote)}" (${a.via === 'panel' ? 'the question panel' : 'their turn'}${a.session?.runtime === 'terminal' ? ' at the terminal' : `, ${a.session.runtime} session ${a.session.id}`}).`, data: { decision: d.id, attempt: d.attempt, answer: a } });

  // The person at their own terminal: their command is their turn.
  if (!actor && !underAgent(env)) {
    if (typeof choice !== 'string') throw new WfError(`at your terminal, name your answer: wf approve ${d.id} --choice <${d.options.join('|')}|other>`);
    return done(await recordAnswer(ctx.root, d, { choice, quote: typeof quote === 'string' && quote.trim() ? quote : choice, via: 'turn', session: { runtime: 'terminal', id: 'person' } }, null));
  }
  if (fromQuestion) {
    const a = await answered(ctx.root, d.id, { attempt: d.attempt ?? undefined });
    if (a) return done(a);
    throw why(d, null, candidates(ctx.root, d, await openQuestions(ctx.root, d.attempt, d.id)));
  }
  if (typeof quote !== 'string' || !quote.trim()) throw new WfError('--quote takes the person\'s exact words');
  const found = candidates(ctx.root, d, await openQuestions(ctx.root, d.attempt, d.id));
  const c = found.list.find((x) => norm(x.text).includes(norm(quote)) && (x.immediate || !isBare(x.text, d)));
  if (!c) throw why(d, quote, found);
  return done(await recordAnswer(ctx.root, d, { choice, quote: quote.trim(), via: c.via, session: c.session }, actor));
}

export const implements08 = { ask, answered, cmdApprove };
