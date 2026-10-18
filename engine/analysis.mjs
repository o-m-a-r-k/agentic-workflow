// The route of an analysis attempt (0.7.31, I-216, D67): admitted with `wf entry --intent analysis`, planned (the criteria are
// the questions it answers, the work items its read-only investigation steps), investigated read-only by the owner or an agent
// it starts, recorded with its evidence (`wf analysis record`), and then either upgraded in place to an implementation
// (`wf intent implementation`) or closed (`wf analysis close`). What it found reaches whatever follows: the planner handed after
// an upgrade, and the planner of the item's next attempt, are given the latest recorded analysis; `wf analysis show` prints it
// for the person or a ticket.
//
// Named failure (I-216, field): an analysis attempt's plan was accepted with investigation-only work items; the next step then
// told the owner to hand an implementer, and that handoff refused ("analysis attempts are read-only; only a planner handoff is
// allowed"). There was no supported way to record what the analysis found or to finish it: an analysis not upgraded to an
// implementation could only be abandoned, its findings left in the chat.
import fs from 'node:fs';
import path from 'node:path';
import { actor, cleanupWorktrees, openState, treeHashes } from './attempt.mjs';
import { append, attemptDir, listAttempts, loadState, recordedTogether } from './ledger.mjs';
import { WfError, YAML, hashFile, refuse, writeImmutable } from './util.mjs';

export const ANALYSIS_KEYS = ['analyst', 'summary', 'criteria', 'findings', 'traced', 'notTraced', 'recommendation'];
const EVIDENCE_KEYS = ['kind', 'ref', 'result', 'note'];

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const isList = (v) => Array.isArray(v);

// What a record must hold to say what the analysis found: an answer with its evidence for every question the plan froze (or why
// it could not be answered), and nothing the engine would drop unread.
function evidenceProblems(list, where) {
  if (!isList(list) || !list.length) return [`${where}: \`evidence\` lists at least one item ({ kind, ref, result }: what was read, run or asked, and what it showed)`];
  const out = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return out.push(`${where}: evidence ${i + 1} is { kind, ref, result }`);
    if (!text(e.kind)) out.push(`${where}: evidence ${i + 1} needs \`kind\` (file, command, query, log, document, person, ...)`);
    if (!text(e.ref)) out.push(`${where}: evidence ${i + 1} needs \`ref\` (the file and line, the command, the query or the source)`);
    const extra = Object.keys(e).filter((k) => !EVIDENCE_KEYS.includes(k));
    if (extra.length) out.push(`${where}: evidence ${i + 1} carries ${extra.map((k) => `\`${k}\``).join(', ')}; an evidence item has ${EVIDENCE_KEYS.map((k) => `\`${k}\``).join(', ')}`);
  });
  return out;
}

export function analysisProblems(doc, criteria) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['the analysis file is one mapping: { summary, criteria, findings, traced, notTraced, recommendation }'];
  const p = [];
  const extra = Object.keys(doc).filter((k) => !ANALYSIS_KEYS.includes(k));
  if (extra.length) p.push(`${extra.map((k) => `\`${k}\``).join(', ')} ${extra.length > 1 ? 'are' : 'is'} not part of an analysis record (keys: ${ANALYSIS_KEYS.map((k) => `\`${k}\``).join(', ')})`);
  if (!text(doc.summary)) p.push('`summary` says in plain words what the analysis found');
  if (doc.analyst !== undefined && !text(doc.analyst)) p.push('`analyst`, when given, names who carried out the investigation');
  const frozen = (criteria ?? []).filter((c) => !c.dropped).map((c) => c.id);
  if (!isList(doc.criteria)) p.push(`\`criteria\` answers every frozen criterion (${frozen.join(', ')}): [{ id, answer, evidence }] or [{ id, unanswered: "<why>" }]`);
  else {
    const seen = new Set();
    doc.criteria.forEach((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c) || !text(c.id)) return p.push(`criteria entry ${i + 1} needs an \`id\``);
      if (!frozen.includes(c.id)) return p.push(`${c.id} is not a frozen criterion of this attempt (${frozen.join(', ')})`);
      if (seen.has(c.id)) return p.push(`${c.id} is answered twice`);
      seen.add(c.id);
      const extraC = Object.keys(c).filter((k) => !['id', 'answer', 'evidence', 'unanswered'].includes(k));
      if (extraC.length) p.push(`${c.id} carries ${extraC.map((k) => `\`${k}\``).join(', ')}; an answer has \`id\`, \`answer\` and \`evidence\`, or \`id\` and \`unanswered\``);
      if (c.unanswered !== undefined) {
        if (!text(c.unanswered)) p.push(`${c.id}: \`unanswered\` says why it could not be answered`);
        if (c.answer !== undefined) p.push(`${c.id}: an answer or \`unanswered\`, not both`);
        return;
      }
      if (!text(c.answer)) p.push(`${c.id} needs an \`answer\` (or \`unanswered: "<why>"\`)`);
      p.push(...evidenceProblems(c.evidence, c.id));
    });
    const missing = frozen.filter((id) => !seen.has(id));
    if (missing.length) p.push(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not answered: every frozen criterion gets an answer with its evidence, or \`unanswered: "<why>"\``);
  }
  if (doc.findings !== undefined) {
    if (!isList(doc.findings)) p.push('`findings` lists what else the analysis found: [{ summary, evidence }]');
    else doc.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f) || !text(f.summary)) return p.push(`finding ${i + 1} needs a \`summary\``);
      const extraF = Object.keys(f).filter((k) => !['id', 'summary', 'evidence'].includes(k));
      if (extraF.length) p.push(`finding ${i + 1} carries ${extraF.map((k) => `\`${k}\``).join(', ')}; a finding has \`id\`, \`summary\` and \`evidence\``);
      if (f.evidence !== undefined) p.push(...evidenceProblems(f.evidence, `finding ${f.id ?? i + 1}`));
    });
  }
  for (const k of ['traced', 'notTraced']) if (doc[k] !== undefined && (!isList(doc[k]) || doc[k].some((x) => !text(x)))) p.push(`\`${k}\` is a list of plain lines (${k === 'traced' ? 'what was followed: producers and consumers of the data, the business process, external systems' : 'what was not followed, and why'})`);
  if (doc.recommendation !== undefined && !text(doc.recommendation)) p.push('`recommendation`, when given, says what should follow in plain words');
  return p;
}

const readOnce = (file) => fs.readFileSync(path.resolve(String(file)), 'utf8');
function parse(file, original) {
  const fenced = original.match(/```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/);
  const body = fenced ? fenced[1] : original;
  return String(file).endsWith('.json') ? JSON.parse(body) : YAML.parse(body);
}

// `wf analysis record --file <analysis.yaml>`: what the investigation found, with its evidence, kept raw and recorded. A later
// record is the latest one; the earlier stay in the record.
export function recordAnalysis(root, options) {
  if (typeof options.file !== 'string') throw new WfError('usage: wf analysis record --file <analysis.yaml> [--attempt ID]');
  const state = openState(root, options);
  // I-216: only an analysis attempt records an analysis; an implementation's findings are its review's.
  if (state.intent !== 'analysis') throw refuse(`${state.id} is an ${state.intent} attempt; an analysis is recorded on an analysis attempt (\`wf entry --intent analysis\`)`, null, { id: 'analysis:not-analysis' });
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}; its analysis is final (\`wf analysis show --attempt ${state.id}\`)`, null, { id: 'analysis:closed' });
  // I-216: the record answers the questions the plan froze, so the plan comes first.
  if (!state.criteria) throw refuse(`${state.id} has no frozen plan: the analysis answers its criteria`, '`wf resume` names the planner, or `wf plan --file <plan.yaml>`', { id: 'analysis:no-plan' });
  if (!fs.existsSync(path.resolve(options.file))) throw new WfError(`--file not found: ${path.resolve(options.file)}`);
  const original = readOnce(options.file);
  let doc;
  try {
    doc = parse(options.file, original);
  } catch (error) {
    throw new WfError(`the analysis file does not parse: ${error.message.split('\n')[0]}`);
  }
  const problems = analysisProblems(doc, state.criteria);
  if (problems.length) throw new WfError(`the analysis record is incomplete:\n  - ${problems.join('\n  - ')}`, { hint: 'fix the file and run `wf analysis record --file <it>` again; nothing was recorded' });
  const id = `A${(state.analyses ?? []).length + 1}`;
  const ext = String(options.file).endsWith('.json') ? 'json' : 'yaml';
  let tree = null;
  try {
    tree = treeHashes(state);
  } catch {}
  recordedTogether(root, state.id, () => {
    const file = path.join(attemptDir(root, state.id), 'analysis', `${id.toLowerCase()}.raw.${ext}`);
    writeImmutable(file, original);
    append(root, state.id, 'analysis.recorded', {
      id,
      analyst: doc.analyst ?? null,
      summary: doc.summary.trim(),
      criteria: doc.criteria,
      findings: doc.findings ?? [],
      traced: doc.traced ?? null,
      notTraced: doc.notTraced ?? null,
      recommendation: doc.recommendation ?? null,
      raw: { file, sha256: hashFile(file) },
      tree,
    }, actor(options));
  });
  return loadState(root, state.id);
}

// `wf analysis close --reason "<what follows>"`: the analysis is finished; its worktrees are removed (the branch stays) and what it
// found stays in its record for whatever follows.
export function closeAnalysis(root, options) {
  const state = openState(root, options);
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!reason) throw new WfError('--reason "<what follows: a ticket, a later attempt, the person\'s decision>" is required');
  if (state.intent !== 'analysis') throw refuse(`${state.id} is an ${state.intent} attempt; only an analysis attempt is closed with \`wf analysis close\``, state.intent === 'implementation' && (state.intentChanges ?? []).length ? 'it was upgraded to implementation, which delivers (or is abandoned)' : null, { id: 'analysis:not-analysis' });
  if (['done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is already ${state.phase}`, null, { id: 'analysis:closed' });
  // I-216: an analysis closed with nothing recorded would read as finished with its findings nowhere; that is an abandon.
  if (!(state.analyses ?? []).length) throw refuse(`${state.id} has no recorded analysis to close with`, `record what it found first (\`wf analysis record --file <analysis.yaml>\`), or, when it is given up, \`wf abandon --reason "<why>"\``, { id: 'analysis:not-recorded' });
  append(root, state.id, 'analysis.closed', { reason, analysis: state.analyses.at(-1).id }, actor(options));
  cleanupWorktrees(root, loadState(root, state.id));
  return loadState(root, state.id);
}

export const latestAnalysis = (state) => (state.analyses ?? []).at(-1) ?? null;

// What a role is given (D67). A planner: this attempt's latest analysis (an upgraded analysis), else the latest one recorded for the
// same item by another attempt (an analysis closed before this attempt was admitted, or one beside it). An implementer: an analysis
// another attempt of the item recorded after this attempt was admitted (the premise of a fix traced beside it, before the fix
// round); what came before reached its planner, and so its plan.
export function analysisFor(root, state, role = 'planner') {
  const view = (s, a) => ({ attempt: s.id, id: a.id, at: a.at, ...(a.analyst ? { analyst: a.analyst } : {}), summary: a.summary, criteria: a.criteria, findings: a.findings, traced: a.traced, notTraced: a.notTraced, recommendation: a.recommendation, file: a.raw?.file ?? null, ...(s.analysisClosed ? { closed: s.analysisClosed.reason } : {}) });
  const own = latestAnalysis(state);
  if (role === 'planner' && own) return view(state, own);
  const since = role === 'planner' ? '' : String(state.admittedAt ?? '');
  let best = null;
  for (const id of listAttempts(root).filter((x) => x !== state.id && x.startsWith(`${state.item}.`))) {
    try {
      const s = loadState(root, id);
      const a = s.item === state.item ? latestAnalysis(s) : null;
      if (a && String(a.at) > since && (!best || String(a.at) > String(best.a.at))) best = { s, a };
    } catch {}
  }
  return best ? view(best.s, best.a) : undefined;
}

const firstLine = (t) => String(t ?? '').trim().split('\n')[0];

// The analysis as the person reads it (`wf analysis show`): what it found, per question, with what each answer rests on.
export function analysisText(state, a) {
  const crit = new Map((state.criteria ?? []).map((c) => [c.id, c.text ?? '']));
  const ev = (list) => (list ?? []).map((e) => `      - ${e.kind}: ${e.ref}${e.result ? ` -> ${e.result}` : ''}${e.note ? ` (${e.note})` : ''}`);
  const lines = [`${state.id} analysis ${a.id} (${a.at}${a.analyst ? `, by ${a.analyst}` : ''})`, '', 'Summary:', `  ${a.summary.replace(/\n/g, '\n  ')}`, '', 'Questions:'];
  for (const c of a.criteria ?? []) {
    lines.push(`  ${c.id}${crit.get(c.id) ? ` (${firstLine(crit.get(c.id))})` : ''}:`);
    if (c.unanswered !== undefined) lines.push(`    not answered: ${c.unanswered}`);
    else lines.push(`    ${c.answer}`, '    evidence:', ...ev(c.evidence));
  }
  if ((a.findings ?? []).length) {
    lines.push('', 'Other findings:');
    for (const f of a.findings) lines.push(`  ${f.id ? `${f.id}: ` : ''}${f.summary}`, ...(f.evidence ? ev(f.evidence) : []));
  }
  lines.push('', 'Traced:', ...(a.traced ? (a.traced.length ? a.traced.map((x) => `  - ${x}`) : ['  (nothing listed)']) : ['  (not stated)']));
  lines.push('', 'Not traced:', ...(a.notTraced ? (a.notTraced.length ? a.notTraced.map((x) => `  - ${x}`) : ['  (nothing: every path named was followed)']) : ['  (not stated: what was not followed is unknown)']));
  if (a.recommendation) lines.push('', 'Recommendation:', `  ${a.recommendation.replace(/\n/g, '\n  ')}`);
  if (state.analysisClosed) lines.push('', `Closed ${state.analysisClosed.at}: ${state.analysisClosed.reason}`);
  return lines.join('\n');
}

// One `wf status` line.
export function analysisLine(state) {
  const a = latestAnalysis(state);
  if (!a) return null;
  return `analysis: ${a.id} recorded ${a.at}: ${firstLine(a.summary).slice(0, 200)}${state.analysisClosed ? `; closed ${state.analysisClosed.at} (${state.analysisClosed.reason})` : ''} (\`wf analysis show --attempt ${state.id}\`)`;
}

// The next step of an open analysis attempt once its plan is frozen (phaseStep in engine/lifecycle.mjs). It never names an
// implementer: an analysis hands none.
export function analysisStep(state) {
  const a = latestAnalysis(state);
  if (!a) {
    const ids = (state.criteria ?? []).filter((c) => !c.dropped).map((c) => c.id);
    const work = (state.work ?? []).map((w) => w.id);
    return `carry out the investigation the frozen plan states, read-only: its criteria (${ids.join(', ')}) are the questions it answers${work.length ? `, its work items (${work.join(', ')}) the steps` : ''}; you do it, or a read-only agent you start with the plan and the worktrees (an analysis hands no implementer and commits nothing). Then record what it found, with the evidence for each answer: \`wf analysis record --file <analysis.yaml>\` ({ summary, criteria: [{ id, answer, evidence: [{ kind, ref, result }] }, or { id, unanswered: "<why>" }], findings, traced, notTraced, recommendation }: \`traced\` and \`notTraced\` say which producers and consumers of the data, business processes and external systems were followed, and which were not)`;
  }
  return `the analysis is recorded (${a.id}): tell the person what it found, in plain words, with what it did not trace and its recommendation (\`wf analysis show\` prints it); what follows is theirs. To implement it in this attempt: \`wf intent implementation --reason "<their words>"\` (the planner handed next is given the analysis). Otherwise close it: \`wf analysis close --reason "<what follows: a ticket, a later attempt, their decision>"\`; what it found stays in its record, and is given to the planner of this item's next attempt and to the next implementers of an attempt of this item already open. Something new found before then: \`wf analysis record\` again (the latest record is the analysis)`;
}
