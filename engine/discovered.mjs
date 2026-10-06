// The discovered-issue ledger (I-18). Named failure: implementers, reviewers and the owner agent noted real defects found
// during a ticket (a pager summing only the current page, a table with no phone view, an implicit default, a failed step
// that strands the user) and parked them as follow-ups or "harmless today" without the owner deciding. Every issue found
// during a ticket is recorded here by whoever finds it; it ends fixed by a commit of this ticket or deferred with the
// owner's own words; delivery refuses an open one and the reviewer gives each a verdict.
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import { home } from './provenance.mjs';
import { readTranscript, subagentTranscripts } from './telemetry.mjs';
import { WfError, git, refuse, run } from './util.mjs';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const OPEN = (s) => !['done', 'abandoned'].includes(s.phase);

export const openDiscovered = (state) => (state.discovered ?? []).filter((d) => d.status === 'open');

export function addDiscovered(root, options) {
  const state = openState(root, options);
  if (!OPEN(state) || state.delivery.completedAt) throw refuse(`${state.id} is ${state.delivery.completedAt && OPEN(state) ? 'delivered' : state.phase}; record the issue on a new attempt (\`wf reopen\` or \`wf entry\`)`);
  const summary = text(options.summary);
  if (!summary) throw new WfError('usage: wf discovered add --summary "<what is wrong, in one line>" [--where <file:line>] [--found-by <agent id>]');
  // The one exception to "the role that found it fixes it": the file is another work item's at that moment. The entry
  // names that work item, and the owner routes it to its implementer.
  const blockedBy = text(options['blocked-by']) || null;
  if (blockedBy && !(state.work ?? []).some((w) => w.id === blockedBy)) throw new WfError(`--blocked-by: no work item ${blockedBy} in the frozen plan${state.work?.length ? ` (work items: ${state.work.map((w) => w.id).join(', ')})` : ''}`);
  const id = `D${(state.discovered?.length ?? 0) + 1}`;
  append(root, state.id, 'discovered.added', { id, summary, where: text(options.where) || null, foundBy: text(options['found-by']) || null, blockedBy }, actor(options));
  return { state: loadState(root, state.id), id };
}

// The commit is part of this ticket's change in one of its repos: reachable from the worktree's HEAD and not from the
// base the change starts at.
function ticketCommit(state, sha, repo) {
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

export function closeDiscovered(root, id, options) {
  const state = openState(root, options);
  const entry = (state.discovered ?? []).find((d) => d.id === id);
  if (!entry) throw new WfError(`no discovered issue ${id ?? ''} on ${state.id}${state.discovered?.length ? ` (${state.discovered.map((d) => d.id).join(', ')})` : ''}`);
  if (entry.status !== 'open') throw refuse(`${id} is already ${entry.status}`);
  const fixed = typeof options.fixed === 'string' ? options.fixed.trim() : '';
  const deferred = options.deferred === true;
  if (Boolean(fixed) === deferred) throw new WfError(`close ${id} with either --fixed <commit> or --deferred --decision "<the owner's own words>"`);
  if (fixed) {
    const c = ticketCommit(state, fixed, typeof options.repo === 'string' ? options.repo : null);
    append(root, state.id, 'discovered.closed', { id, outcome: 'fixed', repo: c.repo, commit: c.commit, evidence: text(options.evidence) || null }, actor(options));
    return { state: loadState(root, state.id), outcome: 'fixed', ...c };
  }
  // Deferral is the owner's decision: a role agent never makes it, and the owner's words are kept verbatim.
  const decision = text(options.decision);
  if (!decision) throw new WfError(`deferring ${id} needs --decision "<the owner's own words>": only the owner defers an issue found during the ticket; otherwise fix it in this ticket (amend the criteria when they block the fix)`);
  const by = text(options.by);
  if (by) {
    const role = ['planner', 'implementer', 'reviewer', 'tester'].find((r) => state.roles[r].includes(by));
    if (role) throw refuse(`${by} is ${role === 'implementer' ? 'an' : 'a'} ${role} of this attempt: only the owner defers an issue, in their own words`);
  }
  append(root, state.id, 'discovered.closed', { id, outcome: 'deferred', decision }, actor(options));
  return { state: loadState(root, state.id), outcome: 'deferred' };
}

// The reviewer's verdict per entry its bundle listed: `fixed` (with evidence in the code), `deferred` (only for an entry
// the owner deferred) or `open` (recorded honestly; acceptance then refuses).
export function discoveredVerdicts(entries, closure) {
  const given = Array.isArray(closure?.discovered) ? closure.discovered : [];
  const problems = [];
  const verdicts = [];
  for (const d of entries ?? []) {
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

export const discoveredLine = (d) => `${d.id}  ${d.status}  ${d.summary}${d.where || d.foundBy ? `  (${[d.where, d.foundBy ? `found by ${d.foundBy}` : null].filter(Boolean).join('; ')})` : ''}${d.blockedBy && d.status === 'open' ? `  blocked by ${d.blockedBy}: route it to that work item's implementer` : ''}${d.status === 'fixed' ? `  fixed in ${d.fixed.repo}@${d.fixed.commit.slice(0, 10)}` : d.status === 'deferred' ? `  deferred by ${d.deferred.by}: "${d.deferred.decision}"` : ''}`;

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: <a defect>" and handed the issue
// back to the owner agent to relay. A line of an implementer's final report that leaves an issue unfixed must name its
// discovered entry (D<n>); otherwise the next reviewer handoff is refused. It reads the report from the implementer's
// Claude Code transcript (by the name it was started under, after its handoff); without a transcript nothing is checked.
const UNFIXED = /\bnot (?:yet )?(?:fixed|addressed|handled|done)\b|\b(?:outside|beyond) (?:the|my|this) (?:brief|scope|work item|task)\b|\bout of (?:the )?scope\b|\bleft (?:it |them |this )?(?:as is|as-is|unchanged|for later|alone)\b|\bfollow-?ups?\b|\bdefer(?:red|ring)?\b|\bharmless\b|\bnot in (?:the )?scope\b|\bnot (?:my|our) (?:work item|brief|change)\b/i;
const NEGATED = /\b(?:no|nothing|none|zero|without)\b(?:\s+\S+){0,3}\s+(?:follow-?ups?|defer|left|unfixed|out of scope|outside)/i;

function finalReport(file) {
  const entries = readTranscript(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const c = e.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') : '';
    if (t.trim()) return t;
  }
  return '';
}

export function unrecordedInReports(state) {
  const known = new Set((state.discovered ?? []).map((d) => d.id));
  const out = [];
  const seen = new Set();
  for (const h of [...state.handoffs].reverse()) {
    if (h.role !== 'implementer' || h.runtime !== 'claude' || seen.has(h.agent)) continue;
    seen.add(h.agent);
    let found = [];
    try {
      found = subagentTranscripts(home(), h.agent, h.agentType ?? null, h.at);
    } catch {}
    if (!found.length) continue;
    const lines = finalReport(found[0].file).split('\n').map((l) => l.trim()).filter(Boolean);
    const bad = lines.filter((l) => UNFIXED.test(l) && !NEGATED.test(l) && !(l.match(/\bD\d+\b/g) ?? []).some((x) => known.has(x)));
    if (bad.length) out.push({ agent: h.agent, work: h.work ?? null, lines: bad });
  }
  return out;
}
