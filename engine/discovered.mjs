// The discovered-issue ledger (I-18). Named failure: implementers, reviewers and the owner agent noted real defects found
// during a ticket (a pager summing only the current page, a table with no phone view, an implicit default, a failed step
// that strands the user) and parked them as follow-ups or "harmless today" without the owner deciding. Every issue found
// during a ticket is recorded here by whoever finds it; it ends fixed by a commit of this ticket or deferred by the
// person's rule (D17, engine/leaving.mjs: medium and high are fixed here; a low one waits only with the person's yes);
// delivery refuses an open one and the reviewer gives each a verdict.
import { isBookkeeping, legacyWaived, severityLevel } from './review-policy.mjs';
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import crypto from 'node:crypto';
import { home } from './provenance.mjs';
import { findHost, optional } from './hosts/index.mjs';
import { WfError, git, refuse, run } from './util.mjs';
import { requireYes } from './approve.mjs';
import { discoveredRating, leavingDecision } from './leaving.mjs';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const OPEN = (s) => !['done', 'abandoned'].includes(s.phase);

// (An entry the owner waived under the old extra-scope flow, before 0.7.0, stays settled.)
export const openDiscovered = (state) => (state.discovered ?? []).filter((d) => d.status === 'open' && !legacyWaived(state, d));

export function addDiscovered(root, options) {
  const state = openState(root, options);
  if (!OPEN(state) || state.delivery.completedAt) throw refuse(`${state.id} is ${state.delivery.completedAt && OPEN(state) ? 'delivered' : state.phase}; record the issue on a new attempt (\`wf reopen\` or \`wf entry\`)`);
  const summary = text(options.summary);
  if (!summary) throw new WfError('usage: wf discovered add --summary "<what is wrong, in one line>" [--severity high|medium|low] [--kind defect|bookkeeping] [--where <file:line>] [--found-by <agent id>]');
  const severity = text(options.severity) || null;
  if (severity && !severityLevel(severity)) throw new WfError('--severity is high, medium or low (critical, major, minor and nit are read as their level)');
  // A tenant-isolation, authorization or money defect names the invariant it breaks: it is high whatever it is rated.
  const invariant = text(options.invariant) || null;
  // The one exception to "the role that found it fixes it": the file is another work item's at that moment. The entry
  // names that work item, and the owner routes it to its implementer.
  const blockedBy = text(options['blocked-by']) || null;
  if (blockedBy && !(state.work ?? []).some((w) => w.id === blockedBy)) throw new WfError(`--blocked-by: no work item ${blockedBy} in the frozen plan${state.work?.length ? ` (work items: ${state.work.map((w) => w.id).join(', ')})` : ''}`);
  // Named failure (0.7.0): 512 of 595 discovered items were an implementer's own lint or fixture fixes, closed within
  // minutes; each became a verdict item for the next reviewer and grew the bundle. `bookkeeping` marks one: it still has
  // to be closed, but no reviewer is handed it.
  const kind = options.kind === undefined ? 'defect' : text(options.kind);
  if (!['defect', 'bookkeeping'].includes(kind)) throw new WfError('--kind is defect (default) or bookkeeping');
  const id = `D${(state.discovered?.length ?? 0) + 1}`;
  append(root, state.id, 'discovered.added', { id, summary, kind, severity, ...(invariant ? { invariant } : {}), where: text(options.where) || null, foundBy: text(options['found-by']) || null, blockedBy, raisedOn: headsNow(state) }, actor(options));
  return { state: loadState(root, state.id), id };
}

// Each repo's HEAD when an issue is recorded: a commit already in that tree cannot be the issue's fix (independent review
// of 0.7.7: `wf discovered close --fixed` took the first implementation commit, older than the issue).
export const headsNow = (state) => Object.fromEntries(Object.entries(state.repos ?? {}).map(([name, r]) => [name, (r.worktree && git(r.worktree, ['rev-parse', 'HEAD'], { allowFail: true })) || null]));

// The commit is part of this ticket's change in one of its repos: reachable from the worktree's HEAD and not from the
// base the change starts at.
export function ticketCommit(state, sha, repo) {
  const names = repo ? [repo] : Object.keys(state.repos);
  if (repo && !state.repos[repo]) throw new WfError(`--repo ${repo} is not in ${state.id} (repos: ${Object.keys(state.repos).join(', ')})`);
  const found = [];
  for (const name of names) {
    const wt = state.repos[name].worktree;
    const full = git(wt, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { allowFail: true });
    if (!full) continue;
    const start = git(wt, ['merge-base', state.repos[name].baseRef ?? state.repos[name].base, 'HEAD'], { allowFail: true }) || state.repos[name].base;
    const inHead = run('git', ['merge-base', '--is-ancestor', full, 'HEAD'], { cwd: wt, allowFail: true }).status === 0;
    const inBase = run('git', ['merge-base', '--is-ancestor', full, start], { cwd: wt, allowFail: true }).status === 0;
    if (inHead && !inBase) found.push({ repo: name, commit: full });
  }
  if (!found.length) throw refuse(`${sha} is not a commit of this ticket in ${names.join(', ')} (it must be on the attempt's branch, after its base)`, 'commit the fix in the attempt\'s worktree, then close the entry with that commit');
  if (found.length > 1) throw new WfError(`${sha} is a commit of this ticket in ${found.map((f) => f.repo).join(' and ')}; pass --repo`);
  return found[0];
}

// Where a discovered issue may go (the person's rule, D17): one that breaks a critical invariant (tenant
// isolation, authorization, money; `invariant`) is high whatever it is rated; unrated is high.
// Named failure (second final review of 0.7.0): a tenant defect an implementer rated medium was deferred on the agent's
// reason alone, against D1.
export const discoveredLevel = (d) => (text(d?.invariant) ? 'high' : severityLevel(d?.severity) ?? 'high');

// `wf discovered close D1[,D2] --fixed <commit> | --deferred --reason "..."`: several issues under one command, and the
// high ones under one decision of the person (second final review of 0.7.0: one approval per id).
export function closeDiscovered(root, idArg, options) {
  const state = openState(root, options);
  const ids = [...new Set(String(idArg ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  const entries = ids.map((id) => {
    const entry = (state.discovered ?? []).find((d) => d.id === id);
    if (!entry) throw new WfError(`no discovered issue ${id} on ${state.id}${state.discovered?.length ? ` (${state.discovered.map((d) => d.id).join(', ')})` : ''}`);
    if (entry.status !== 'open') throw refuse(`${id} is already ${entry.status}`);
    return entry;
  });
  if (!entries.length) throw new WfError('name the discovered issue(s): `wf discovered close D1[,D2] --fixed <commit> | --deferred --reason "..."`');
  const fixed = typeof options.fixed === 'string' ? options.fixed.trim() : '';
  const deferred = options.deferred === true;
  if (Boolean(fixed) === deferred) throw new WfError(`close ${ids.join(',')} with either --fixed <commit> or --deferred [--reason "<why it waits>"] (only a low issue may wait, with the person's yes; medium and high are fixed here)`);
  if (fixed) {
    const c = ticketCommit(state, fixed, typeof options.repo === 'string' ? options.repo : null);
    for (const e of entries) {
      const head = e.raisedOn?.[c.repo];
      // A repo added after the issue was recorded has no head in `raisedOn`: its commit must be dated after the issue.
      const committed = e.raisedOn && !head ? git(state.repos[c.repo].worktree, ['show', '-s', '--format=%cI', c.commit], { allowFail: true }) : null;
      if (committed && e.at && Date.parse(committed) < Date.parse(e.at)) throw refuse(`${c.commit.slice(0, 10)} was committed before ${e.id} was recorded: it cannot be the fix`, 'name the commit that fixed it, made after the issue was recorded', { id: 'discovered:fixed-before-issue' });
      if (head && run('git', ['merge-base', '--is-ancestor', c.commit, head], { cwd: state.repos[c.repo].worktree, allowFail: true }).status === 0) throw refuse(`${c.commit.slice(0, 10)} was already in the tree ${e.id} was recorded on: it cannot be the fix`, 'name the commit that fixed it, made after the issue was recorded', { id: 'discovered:fixed-before-issue' });
    }
    for (const e of entries) append(root, state.id, 'discovered.closed', { id: e.id, outcome: 'fixed', repo: c.repo, commit: c.commit, evidence: text(options.evidence) || null }, actor(options));
    return { state: loadState(root, state.id), outcome: 'fixed', ids, ...c };
  }
  // Deferral moves a defect out of this delivery: only a low one, with the person's yes (D17, engine/leaving.mjs; 0.7.6
  // and earlier let a medium one wait on the owner agent's reason and a low one freely). Named failure (0.7.0): the
  // owner-phrase grammar refused real deferrals after the person had said yes.
  const reason = text(options.reason);
  const decision = leavingDecision(root, state, entries.map((e) => ({ ref: e.id, level: discoveredLevel(e), blocks: false, severity: e.severity ?? null, summary: e.summary, raisedAt: e.at ?? null, ...discoveredRating(e) })), { verb: 'deferred', reason, options });
  // The channel the person used (their terminal or the question panel) travels with the deferral (0.7.3).
  const via = (state.decisions ?? []).find((x) => x.id === decision)?.approved?.via ?? null;
  for (const e of entries) {
    append(root, state.id, 'discovered.closed', { id: e.id, outcome: 'deferred', decision: reason || `left for later with the person's decision ${decision}`, source: { provenance: 'approved-decision', decision, ...(via ? { via } : {}) }, attributedTo: text(options.by) || null }, actor(options));
  }
  return { state: loadState(root, state.id), outcome: 'deferred', ids };
}

// `wf discovered rate D1 --severity <s> --reason "..."`: a discovered issue re-rated; raising needs no reason, lowering
// records one; an invariant issue stays high (second final review of 0.7.0: an implementer's rating could not be corrected).
export function rateDiscovered(root, id, options) {
  const state = openState(root, options);
  const entry = (state.discovered ?? []).find((d) => d.id === id);
  if (!entry) throw new WfError(`no discovered issue ${id ?? ''} on ${state.id}`);
  if (entry.status !== 'open') throw refuse(`${id} is already ${entry.status}`);
  const severity = text(options.severity);
  if (!severityLevel(severity)) throw new WfError('--severity is high, medium or low');
  const rank = { low: 0, medium: 1, high: 2 };
  const fromLevel = discoveredLevel(entry);
  const lowering = rank[severityLevel(severity)] < rank[fromLevel];
  if (lowering && !text(options.reason)) throw refuse(`lowering ${id} from ${entry.severity ?? 'unrated'} to ${severity} is a judgement: say why`, 'pass `--reason "..."`', { id: 'discovered:rate-reason' });
  // Out of high (or unrated), or into low, it is the person's decision: otherwise the agent that wants to deliver could rate
  // a defect down and defer it alone (verification of the second final review; into low since D17, where low is the only
  // level that may leave: independent review of 0.7.7). An invariant issue stays high whatever it is rated.
  const decision = lowering && (fromLevel === 'high' || severityLevel(severity) === 'low') ? requireYes(root, state, { kind: 'move-out-of-batch', key: `rate:${state.id}:${id}:${severity}`, summary: `rate ${state.id}:${id} down from ${entry.severity ?? 'unrated'} to ${severity}: ${entry.summary} (${text(options.reason)})`, what: `rating ${id} down`, options }).decision : null;
  append(root, state.id, 'discovered.rated', { id, severity, from: entry.severity ?? null, reason: text(options.reason) || null, ...(decision ? { decision } : {}) }, actor(options));
  return loadState(root, state.id);
}

export const fold = (t) => String(t ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// The reviewer's verdict per entry its bundle listed: `fixed` (with evidence in the code), `deferred` (only for an entry
// the owner deferred) or `open` (recorded honestly; acceptance then refuses).
export function discoveredVerdicts(entries, closure) {
  const given = Array.isArray(closure?.discovered) ? closure.discovered : [];
  const problems = [];
  const verdicts = [];
  // An implementer's own lint or fixture fix (`--kind bookkeeping`) is never a reviewer's verdict item.
  for (const d of (entries ?? []).filter((x) => !isBookkeeping(x))) {
    const v = given.find((x) => x?.id === d.id);
    if (!v) problems.push(`${d.id}: no verdict (${d.summary})`);
    else if (!['fixed', 'deferred', 'open'].includes(v.verdict)) problems.push(`${d.id}: verdict must be fixed, deferred or open, not \`${v.verdict}\``);
    else if (!text(v.evidence)) problems.push(`${d.id}: ${v.verdict} needs evidence (file:line of the fix, or what is still wrong)`);
    else if (v.verdict === 'deferred' && d.status !== 'deferred') problems.push(`${d.id}: \`deferred\` only acknowledges a deferral the owner recorded; ${d.id} is ${d.status}: give \`fixed\` with the file:line of the fix, or \`open\``);
    else verdicts.push({ id: d.id, verdict: v.verdict, evidence: text(v.evidence) });
  }
  return { problems, verdicts };
}

// Repos added to the attempt after admission (I-19): the reviewer judges the contract seam between the added repo and
// the rest of the change on both sides, producer and consumer, with evidence from each.
export function seamVerdicts(added, closure) {
  const given = Array.isArray(closure?.seams) ? closure.seams : [];
  const findings = new Set((closure?.findings ?? []).map((f) => f.id));
  const problems = [];
  const verdicts = [];
  for (const a of added ?? []) {
    const v = given.find((x) => x?.repo === a.repo);
    if (!v) problems.push(`${a.repo}: no verdict (added: ${a.reason})`);
    else if (!['matched', 'finding'].includes(v.verdict)) problems.push(`${a.repo}: verdict must be matched or finding, not \`${v.verdict}\``);
    else if (v.verdict === 'finding' && !findings.has(v.finding)) problems.push(`${a.repo}: a finding verdict names a finding id of this closure in \`finding\``);
    else if (v.verdict === 'matched' && (text(v.evidence).match(/[\w./-]+:\d+/g) ?? []).length < 2) problems.push(`${a.repo}: \`matched\` needs evidence from both sides of the seam (the producer's file:line and the consumer's file:line)`);
    else verdicts.push({ repo: a.repo, verdict: v.verdict, evidence: text(v.evidence), finding: v.verdict === 'finding' ? v.finding : null });
  }
  return { problems, verdicts };
}

export { CHANNEL, channelOf } from './channels.mjs';
import { channelOf } from './channels.mjs';

// The deferrals still owed the owner's acknowledgement at delivery, qualified by attempt for batch members.
export function unacknowledged(root, state, loadMember, { acknowledged = false } = {}) {
  const out = [];
  for (const x of [state, ...(state.batch?.members ?? []).map(loadMember)]) {
    for (const d of x.discovered ?? []) if (d.status === 'deferred' && Boolean(d.deferred.acknowledged) === acknowledged) out.push({ key: x.id === state.id ? d.id : `${x.id}:${d.id}`, attempt: x.id, d });
  }
  return out;
}

export const discoveredLine = (d, attemptId) => `${d.id}  ${d.status}${d.kind === 'bookkeeping' ? ' (bookkeeping)' : ''}${d.severity ? `  ${d.severity}` : ''}  ${d.summary}${d.where || d.foundBy ? `  (${[d.where, d.foundBy ? `found by ${d.foundBy}` : null].filter(Boolean).join('; ')})` : ''}${d.blockedBy && d.status === 'open' ? `  blocked by ${d.blockedBy}: route it to that work item's implementer` : ''}${d.status === 'fixed' ? `  fixed in ${d.fixed.repo}@${d.fixed.commit.slice(0, 10)}` : d.status === 'deferred' ? `  deferred (${channelOf(d)}): "${d.deferred.decision}"` : attemptId ? (discoveredLevel(d) === 'low' ? `\n    low: it may leave only with the person's yes, with every other low item in one question (wf scope defer --finding ${d.id}[,<ref>...])` : `\n    ${discoveredLevel(d)}: fixed in this delivery (here or in a sibling attempt of the batch); it never leaves`) : ''}`;

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: <a defect>" and handed the issue
// back to the owner agent to relay. A line of an implementer's final report that leaves an issue unfixed must name its
// discovered entry (D<n>); otherwise the next reviewer handoff is refused. It reads the report from the implementer's
// transcript (the harness adapter finds it by the name the role was started under); without a transcript nothing is checked.
const UNFIXED = /\bnot (?:yet )?(?:fixed|addressed|handled|done)\b|\b(?:outside|beyond) (?:the|my|this) (?:brief|scope|work item|task)\b|\bout of (?:the )?scope\b|\bleft (?:it |them |this )?(?:as is|as-is|unchanged|for later|alone)\b|\bfollow-?ups?\b|\bdefer(?:red|ring)?\b|\bharmless\b|\bnot in (?:the )?scope\b|\bnot (?:my|our) (?:work item|brief|change)\b/i;
const NEGATED = /\b(?:no|nothing|none|zero|without)\b(?:\s+(?!(?:but|however|except|and)\b)[\w-]+){0,3}?\s+(?:follow-?ups?|deferred|deferring|defer|left|unfixed|out of scope|outside)\b/gi;

// Named failure I-42: completed follow-ups and coordination in immutable older
// reports were treated as current defects. Recognise only whole completion/ownership
// clauses; a completion, negation or closed handoff never hides an unresolved clause.
const COMPLETED = /^(?:(?:both|all|the|these|those|two)\s+)?follow-?ups?\s+(?:are|is|were|was|have been|has been)\s+(?:now\s+|already\s+)?(?:done|complete|completed|fixed|addressed|resolved)(?:\s+and\s+committed)?[.!]?$/i;
const OWNERSHIP = /^left (?:alone|unchanged):?\s+([a-z0-9-]+)['\u2019]s files,\s+owned by (?:another|the other) (?:active )?implementer[.!]?$/i;
const COORDINATION = /^(?:I |we )?left (?:it|them|this) (?:alone|unchanged) because (?:another|the other) (?:active )?implementer (?:is|was) (?:editing|working on) (?:it|them|this|the files)[.!]?$/i;
const plainClause = (s) => s.replace(/^[\s>*-]+/, '').replace(/[*`]/g, '').trim();
const clausesOf = (s) => s.split(/;\s*|(?<=[.!?])\s+(?=[A-Z])|,\s*(?:but|however)\s+/).map(plainClause).filter(Boolean);
const summaryText = (s) => fold(s).replace(/[.!]$/, '').trim();

// Reconcile an exact historical statement with a later ledger resolution. Mere
// "done", a later successful check, an unrelated commit or a similar summary proves
// no particular defect fixed. The ledger already validates a fix's ticket commit
// and a deferral's owner authority; a fix must still be present on the current HEAD.
function resolvedReportClause(state, clause, reportAt) {
  const when = Date.parse(reportAt);
  if (!Number.isFinite(when)) return false;
  const body = summaryText(clause.replace(/^(?:not (?:yet )?(?:fixed|addressed|handled|done)|follow-?up)(?:,\s*(?:outside|beyond) (?:the|my|this) (?:brief|scope|work item|task))?\s*:\s*/i, ''));
  return (state.discovered ?? []).some((d) => {
    const resolution = d.status === 'fixed' ? d.fixed : d.status === 'deferred' ? d.deferred : null;
    if (!resolution || Date.parse(resolution.at) < when || !Number.isFinite(Date.parse(resolution.at))) return false;
    if (body !== summaryText(d.summary)) return false;
    if (d.status === 'deferred') return Boolean(resolution.source);
    const wt = state.repos[d.fixed.repo]?.worktree;
    return Boolean(wt && run('git', ['merge-base', '--is-ancestor', d.fixed.commit, 'HEAD'], { cwd: wt, allowFail: true }).status === 0);
  });
}

function unrecordedClause(state, handoff, clause, reportAt, known) {
  if (!UNFIXED.test(clause)) return false;
  if ((clause.match(/\bD\d+\b/g) ?? []).some((x) => known.has(x))) return false;
  if (COMPLETED.test(clause)) return false;
  const coordination = OWNERSHIP.exec(clause);
  if (coordination && state.handoffs.some((h) => h.role === 'implementer' && h.work === coordination[1])) return false;
  if (COORDINATION.test(clause) && state.handoffs.some((h) => h.role === 'implementer' && h.agent !== handoff.agent && h.work)) return false;
  // Remove only the negated marker, so 'no follow-ups, but not fixed' still blocks.
  if (!UNFIXED.test(clause.replace(NEGATED, ''))) return false;
  return !resolvedReportClause(state, clause, reportAt);
}

export function reportsForReview(state) {
  const known = new Set((state.discovered ?? []).map((d) => d.id));
  const current = [], historical = [];
  const seen = new Set();
  for (const h of [...state.handoffs].reverse()) {
    const read = h.role === 'implementer' && !seen.has(h.agent) ? optional(findHost(h.runtime), 'finalReport') : null;
    if (!read) continue;
    seen.add(h.agent);
    const report = read(h, { home: home() });
    if (!report) continue;
    const lines = report.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => clausesOf(l).some((c) => unrecordedClause(state, h, c, report.at, known)));
    if (!bad.length) continue;
    const when = Date.parse(report.at);
    const replacement = Number.isFinite(when) ? state.handoffs.filter((later) => {
      if (later.role !== 'implementer' || !Number.isFinite(Date.parse(later.at)) || Date.parse(later.at) <= when || (later.work && later.work !== h.work)) return false;
      const key = String(later.bundle).split(/[\\/]/).at(-1).replace(/\.json$/, '');
      return (state.implementers ?? []).some((i) => i.handoff === key && i.closedAt && i.outcome === 'done' && Date.parse(i.closedAt) >= when);
    }).at(-1) : null;
    if (!replacement) current.push({ agent: h.agent, work: h.work ?? null, lines: bad });
    else for (const statement of bad) historical.push({
      id: 'R' + crypto.createHash('sha256').update(JSON.stringify([h.agent, h.at, report.at, statement])).digest('hex').slice(0, 16),
      agent: h.agent, work: h.work ?? null, reportedAt: report.at, statement, supersededBy: replacement.agent,
    });
  }
  return { current, historical };
}

export const unrecordedInReports = (state) => reportsForReview(state).current;

// Named failure I-42: retirement is not proof of resolution. Old observations are
// judged afresh on the current tree, never waived by a later "done" or old verdict.
// Every fixed verdict names a commit of this attempt; open verdicts name an open
// finding, so the full gate, acceptance and delivery retain their existing guards.
export function reportedIssueVerdicts(reports, closure, state) {
  const entries = Array.isArray(closure.reportedIssues) ? closure.reportedIssues : [];
  const problems = [], verdicts = [];
  const expected = new Set(reports.map((r) => r.id));
  for (const v of entries) if (!expected.has(v?.id)) problems.push('unknown historical report ' + String(v?.id ?? ''));
  for (const r of reports) {
    const matches = entries.filter((v) => v?.id === r.id);
    if (matches.length !== 1) { problems.push(r.id + ': give exactly one verdict'); continue; }
    const v = matches[0];
    if (!['fixed', 'verified-nonissue', 'open'].includes(v.verdict) || !text(v.evidence)) {
      problems.push(r.id + ': verdict must be fixed|verified-nonissue|open with current-tree evidence'); continue;
    }
    if (v.verdict === 'fixed') {
      try {
        if (!text(v.fixedIn)) throw new Error('name the fix commit in fixedIn');
        ticketCommit(state, v.fixedIn, v.repo ?? null);
      } catch (error) { problems.push(r.id + ': ' + error.message); continue; }
    }
    if (v.verdict === 'verified-nonissue' && !text(v.rationale)) { problems.push(r.id + ': verified-nonissue needs a purpose-based rationale'); continue; }
    if (v.verdict === 'open' && !(closure.findings ?? []).some((f) => f.id === v.finding && !['fixed', 'verified-nonissue', 'moved'].includes(f.status) && text(f.evidence))) {
      problems.push(r.id + ': open needs a corresponding open finding with evidence'); continue;
    }
    verdicts.push(v);
  }
  return { problems, verdicts };
}
