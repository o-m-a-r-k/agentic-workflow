// The discovered-issue ledger (I-18). Named failure: implementers, reviewers and the owner agent noted real defects found
// during a ticket (a pager summing only the current page, a table with no phone view, an implicit default, a failed step
// that strands the user) and parked them as follow-ups or "harmless today" without the owner deciding. Every issue found
// during a ticket is recorded here by whoever finds it; it ends fixed by a commit of this ticket or deferred with the
// owner's own words; delivery refuses an open one and the reviewer gives each a verdict.
import { waivedFinding, effectiveDiscoveries, scopeProblems } from './scope-decisions.mjs';
import { actor, openState } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { maxTranscriptBytes, ownerTranscript } from './host-record.mjs';
import { home } from './provenance.mjs';
import { readTranscript, subagentTranscripts } from './telemetry.mjs';
import { WfError, git, refuse, run } from './util.mjs';
import { codexOwnerReplies } from './codex-owner-reply.mjs';

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const OPEN = (s) => !['done', 'abandoned'].includes(s.phase);

export const openDiscovered = (state) => (state.discovered ?? []).filter((d) => d.status === 'open' && !waivedFinding(state, d));

export function addDiscovered(root, options) {
  const state = openState(root, options);
  if (!OPEN(state) || state.delivery.completedAt) throw refuse(`${state.id} is ${state.delivery.completedAt && OPEN(state) ? 'delivered' : state.phase}; record the issue on a new attempt (\`wf reopen\` or \`wf entry\`)`);
  const summary = text(options.summary);
  if (!summary) throw new WfError('usage: wf discovered add --summary "<what is wrong, in one line>" [--where <file:line>] [--found-by <agent id>]');
  // The one exception to "the role that found it fixes it": the file is another work item's at that moment. The entry
  // names that work item, and the owner routes it to its implementer.
  const blockedBy = text(options['blocked-by']) || null;
  if (blockedBy && !(state.work ?? []).some((w) => w.id === blockedBy)) throw new WfError(`--blocked-by: no work item ${blockedBy} in the frozen plan${state.work?.length ? ` (work items: ${state.work.map((w) => w.id).join(', ')})` : ''}`);
  let scope;
  if (typeof options['scope-file'] === 'string') {
    scope = JSON.parse(fs.readFileSync(options['scope-file'], 'utf8'));
    const problems = scopeProblems([{ id: 'discovered', scope }]);
    if (problems.length) throw refuse(problems.join('; '));
  }
  const id = `D${(state.discovered?.length ?? 0) + 1}`;
  // The engine's anchor on the owner session's transcript (0.4.5): its size and the sha256 of its bytes now. A deferral
  // taken from the transcript must come from an owner turn after this offset, with these bytes unchanged.
  append(root, state.id, 'discovered.added', { id, summary, ...(scope ? { scope } : {}), where: text(options.where) || null, foundBy: text(options['found-by']) || null, blockedBy, anchor: transcriptAnchor(state.owner) }, actor(options));
  const after = loadState(root, state.id);
  const anchored = Boolean(after.discovered.find((d) => d.id === id)?.anchor);
  return { state: after, id, anchored, anchorProblem: anchored ? null : ownerTranscript(state.owner).problem ?? 'the owner session\'s transcript could not be read' };
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
  if (Boolean(fixed) === deferred) throw new WfError(`close ${id} with either --fixed <commit> or --deferred (after the owner started a message with \`${deferPhrase(state.id, id)}\`); the owner can also run \`wf discovered defer ${id} --reason "..."\` in their own terminal`);
  if (fixed) {
    const c = ticketCommit(state, fixed, typeof options.repo === 'string' ? options.repo : null);
    append(root, state.id, 'discovered.closed', { id, outcome: 'fixed', repo: c.repo, commit: c.commit, evidence: text(options.evidence) || null }, actor(options));
    return { state: loadState(root, state.id), outcome: 'fixed', ...c };
  }
  // Deferral is the owner's decision. Named failure (0.4.5, security review of 0.4.4): it was refused only when the
  // caller-typed `--by` named a role agent, so an agent that left `--by` out deferred with words it invented. The words
  // now come from the host's record: a real user turn in the transcript of the session that owns the attempt, written
  // after the entry was recorded. `--decision` (free text) is refused; `--by` is attribution only.
  if (options.decision !== undefined || options.quote !== undefined) throw refuse(`--${options.decision !== undefined ? 'decision' : 'quote'} is not accepted: a deferral is taken from the owner's own message, which starts with \`${deferPhrase(state.id, id)}\`, never from text passed on the command line`, `ask the owner; once they have written \`${deferPhrase(state.id, id)}: <reason>\` in the owner session, run \`wf discovered close ${id} --deferred --attempt ${state.id}\`; otherwise fix it in this ticket`);
  const found = ownerDecision(state, entry);
  append(root, state.id, 'discovered.closed', { id, outcome: 'deferred', decision: found.text, source: found.source, attributedTo: text(options.by) || null }, actor(options));
  return { state: loadState(root, state.id), outcome: 'deferred' };
}

// The owner's own terminal (0.4.5): `wf discovered defer <id> --reason "..."` asks the person at an interactive terminal
// to type the id. The Bash tool of an agent runtime has no terminal, so a plain agent call is refused. Limit, plainly: a
// process that allocates a pseudo-terminal (`script`, `expect`) can answer it; this proves an interactive terminal, not
// a person.
export async function deferInTerminal(root, id, options, { input = process.stdin, output = process.stdout } = {}) {
  const state = openState(root, options);
  const entry = (state.discovered ?? []).find((d) => d.id === id);
  if (!entry) throw new WfError(`no discovered issue ${id ?? ''} on ${state.id}`);
  if (entry.status !== 'open') throw refuse(`${id} is already ${entry.status}`);
  const reason = text(options.reason);
  if (!reason) throw new WfError(`usage: wf discovered defer ${id} --reason "<why it waits>" (run by the owner in their own terminal)`);
  if (!input.isTTY || !output.isTTY) throw refuse(`not an interactive terminal: \`wf discovered defer\` is run by the owner in their own terminal, where it asks them to type ${id}`, `ask the owner to run \`wf discovered defer ${id} --reason "..." --attempt ${state.id}\` themselves, or to start a message in this session with \`${deferPhrase(state.id, id)}: <reason>\` (then \`wf discovered close ${id} --deferred --attempt ${state.id}\`); otherwise fix it in this ticket`);
  output.write(`${state.id} ${id}: ${entry.summary}\nDefer it with the reason "${reason}"? Type ${id} to confirm: `);
  const rl = readline.createInterface({ input, output, terminal: true });
  // End of input (Ctrl-D) or a closed terminal is no answer: refused, never a silent success (review of 6ca2338).
  const answer = await new Promise((resolve) => {
    rl.once('line', (l) => resolve(l));
    rl.once('close', () => resolve(null));
  });
  rl.close();
  if (answer === null) throw refuse(`not confirmed (the input ended before ${id} was typed); nothing recorded`);
  if (String(answer).trim() !== id) throw refuse(`not confirmed (typed ${JSON.stringify(String(answer).trim())}, not ${id}); nothing recorded`);
  append(root, state.id, 'discovered.closed', { id, outcome: 'deferred', decision: reason, source: { provenance: 'interactive-terminal (unverified)', confirmed: id } }, actor(options));
  return { state: loadState(root, state.id), outcome: 'deferred' };
}

// ---- The owner's words, from the host's record ----
// Lines the host or the runtime injects into the owner's conversation as user turns: notifications from background
// tasks and other agents, hook and command output, environment blocks. None of them is the owner speaking.
const INJECTED = /^\s*(?:<(?:task-notification|system-reminder|cross-session-message|teammate-message|relay|local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|environment_context|user_instructions|turn_aborted|subagent_notification|heartbeat|user_shell_command|wake|scheduled-task|external_[a-z_]+)\b|# AGENTS\.md instructions|Caveat: The messages below were generated by the user while running local commands|\[Request interrupted|\[\d+\] tool exec call)|<(?:task-notification|system-reminder|scheduled-task|cross-session-message|teammate-message|subagent_notification)\b/;
export const fold = (t) => String(t ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function readCapped(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw refuse(`${file} is not a regular file with one name; the owner's transcript is not read`);
    if (st.size > Math.min(maxTranscriptBytes(), 256 * 1024 * 1024)) throw refuse(`${file} is ${st.size} bytes, over the ${Math.min(maxTranscriptBytes(), 256 * 1024 * 1024)}-byte cap for owner turns (WF_TRANSCRIPT_MAX_BYTES)`);
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!r) break;
      n += r;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The transcript's size and prefix hash now, or null when the owner has no readable host transcript.
function transcriptAnchor(owner) {
  const t = ownerTranscript(owner);
  if (t.problem) return null;
  try {
    const b = readCapped(t.file);
    return { file: t.file, size: b.length, sha256: sha(b) };
  } catch {
    return null;
  }
}

// The shape of words a person typed: the turn opens with a letter or a digit. Named failure (0.5.0 adversarial review):
// owner turns were every user line minus a deny-list of injected tags, so a shape the list did not name (Codex
// `<user_action>` review results, `<recommended_plugins>`, `[12] tool exec call` lines) counted as the owner speaking.
// Only the known shapes count (below). Typed text must open as words; the sole markup exception is a bound human
// desktop question reply, decoded by codex-owner-reply.mjs. Other markup never grants authority.
const TYPED = /^[\p{L}\p{N}]/u;

// Every genuine owner turn: { text, at, line, offset, origin }. Only these shapes count. Claude Code: a `user` line that
// is not meta, not a sidechain, not a compact summary, not a tool result, whose `message.role` is user and whose content
// is a string or text blocks only, and, where the host records who produced it (`origin`, `turnOrigin`), a person.
// Codex: a `response_item` message with role user and `input_text` blocks only. In both the text opens as typed words
// and is no injected line. `origin` keeps the host's fields for the turn (decisions that need a plain interactive
// session read them: engine/owner.mjs).
export function ownerTurns({ runtime, file }, bytes = readCapped(file)) {
  const out = [];
  const replies = runtime === 'codex' ? codexOwnerReplies() : null;
  let offset = 0;
  bytes.toString('utf8').split('\n').forEach((raw, i) => {
    const start = offset;
    offset += Buffer.byteLength(raw) + 1;
    if (!raw) return;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    replies?.observe(e);
    let t = null;
    let origin = null;
    if (runtime === 'claude') {
      origin = { entrypoint: e?.entrypoint ?? null, promptSource: e?.promptSource ?? null, kind: e?.origin?.kind ?? null, turnOrigin: e?.turnOrigin ?? null, recorded: e?.origin !== undefined || e?.turnOrigin !== undefined };
      if (e?.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || e.toolUseResult !== undefined || e.message?.role !== 'user') return;
      // Where the host records who produced the turn, it must be the person (0.4.5 review: relayed agent messages,
      // task notifications and scheduled prompts are user lines too). Older transcripts carry no such fields.
      if (e.origin !== undefined && e.origin?.kind !== 'human') return;
      if (e.turnOrigin !== undefined && e.turnOrigin !== 'human') return;
      const c = e.message.content;
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c) && c.length && c.every((b) => b?.type === 'text')) t = c.map((b) => b.text ?? '').join('\n');
    } else {
      const p = e?.payload;
      if (e?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return;
      if (p.content.every((b) => b?.type === 'input_text')) t = p.content.map((b) => b.text ?? '').join('\n');
    }
    const words = replies?.answers(t, e.timestamp) ?? [{ text: t }];
    for (const word of words) {
      const text = word.text;
      if (!text || !text.trim() || !TYPED.test(text.trim()) || INJECTED.test(text.trim())) continue;
      // All answers in one envelope share the original line's spend identity: one owner message, one decision.
      out.push({ text: text.trim(), at: e.timestamp ?? null, line: i + 1, offset: start, origin, id: typeof e.uuid === 'string' && e.uuid ? `uuid:${e.uuid}` : `sha256:${sha(Buffer.from(raw))}`, ...(word.questionReply ? { questionReply: word.questionReply } : {}) });
    }
  });
  return out;
}

// The phrase the owner types to defer an entry (independent review of 0.4.5): a regex cannot judge intent ("D3 can't
// wait", "won't defer D3" both passed a word list), so the owner states it in a fixed form at the start of a message:
// `defer <attempt id>:<issue id>`, optionally followed by `: <reason>`. The attempt id keeps two attempts (batch members)
// with the same issue id apart. Matched case-folded, anchored at the start, in exactly one owner turn after the anchor.
export const deferPhrase = (attemptId, issueId) => `defer ${attemptId}:${issueId}`;
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ownerDecision(state, entry) {
  const phrase = deferPhrase(state.id, entry.id);
  const fix = `fix it in this ticket (amend the criteria when they block the fix); to defer it, the owner starts a message in this session with \`${phrase}\` (optionally \`: <reason>\`), or runs \`wf discovered defer ${entry.id} --reason "..." --attempt ${state.id}\` in their own terminal`;
  const t = ownerTranscript(state.owner);
  if (t.problem) throw refuse(`no deferral without the owner's own message: ${t.problem}`, fix);
  const a = entry.anchor;
  if (!a) throw refuse(`${entry.id} has no transcript anchor (the owner session had no readable transcript when it was recorded), so no message can be bound to it`, fix);
  if (a.file !== t.file) throw refuse(`the owner session's transcript is now ${t.file}, not ${a.file} as when ${entry.id} was recorded`, fix);
  const bytes = readCapped(t.file);
  if (bytes.length < a.size || sha(bytes.subarray(0, a.size)) !== a.sha256) throw refuse(`the owner session's transcript changed before the point where ${entry.id} was recorded (its first ${a.size} bytes no longer match the anchor); no deferral is taken from it`, fix);
  const start = new RegExp(`^${esc(phrase)}(?![a-z0-9_-]|\\.[a-z0-9])`, 'i');
  const found = ownerTurns(t, bytes).filter((m) => m.offset >= a.size && start.test(fold(m.text)));
  if (found.length > 1) throw refuse(`${found.length} owner messages after ${entry.id} was recorded start with \`${phrase}\` (lines ${found.map((m) => m.line).join(', ')}); a deferral is taken only from exactly one`, fix);
  if (!found.length) throw refuse(`no owner message after ${entry.id} was recorded starts with \`${phrase}\` in the owner session's transcript (${t.file}); tool results, notifications, scheduled tasks, injected lines and subagent transcripts never count`, fix);
  const m = found[0];
  return { text: m.text, source: { provenance: 'host-recorded', runtime: t.runtime, file: t.file, line: m.line, offset: m.offset, at: m.at, phrase, anchor: { size: a.size, sha256: a.sha256 } } };
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

export const discoveredLine = (d, attemptId) => `${d.id}  ${d.status}  ${d.summary}${d.where || d.foundBy ? `  (${[d.where, d.foundBy ? `found by ${d.foundBy}` : null].filter(Boolean).join('; ')})` : ''}${d.blockedBy && d.status === 'open' ? `  blocked by ${d.blockedBy}: route it to that work item's implementer` : ''}${d.status === 'fixed' ? `  fixed in ${d.fixed.repo}@${d.fixed.commit.slice(0, 10)}` : d.status === 'deferred' ? `  deferred (${channelOf(d)}): "${d.deferred.decision}"` : attemptId ? `\n    to defer it, the owner starts a message with: ${deferPhrase(attemptId, d.id)}: <reason>` : ''}`;

// I-18 (extended), named failure: an implementer reported "Not fixed, outside the brief: <a defect>" and handed the issue
// back to the owner agent to relay. A line of an implementer's final report that leaves an issue unfixed must name its
// discovered entry (D<n>); otherwise the next reviewer handoff is refused. It reads the report from the implementer's
// Claude Code transcript (by the name it was started under, after its handoff); without a transcript nothing is checked.
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

function finalReport(file) {
  const entries = readTranscript(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const c = e.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') : '';
    if (t.trim()) return { text: t, at: e.timestamp ?? null };
  }
  return { text: '', at: null };
}

// Reconcile an exact historical statement with a later ledger resolution. Mere
// "done", a later successful check, an unrelated commit or a similar summary proves
// no particular defect fixed. The ledger already validates a fix's ticket commit
// and a deferral's owner authority; a fix must still be present on the current HEAD.
function resolvedReportClause(state, clause, reportAt) {
  const when = Date.parse(reportAt);
  if (!Number.isFinite(when)) return false;
  const body = summaryText(clause.replace(/^(?:not (?:yet )?(?:fixed|addressed|handled|done)|follow-?up)(?:,\s*(?:outside|beyond) (?:the|my|this) (?:brief|scope|work item|task))?\s*:\s*/i, ''));
  return effectiveDiscoveries(state).some((d) => {
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
    if (h.role !== 'implementer' || h.runtime !== 'claude' || seen.has(h.agent)) continue;
    seen.add(h.agent);
    let found = [];
    try {
      found = subagentTranscripts(home(), h.agent, h.agentType ?? null, h.at);
    } catch {}
    if (!found.length) continue;
    const report = finalReport(found[0].file);
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
    if (v.verdict === 'open' && !(closure.findings ?? []).some((f) => f.id === v.finding && !['fixed', 'verified-nonissue'].includes(f.status) && text(f.evidence))) {
      problems.push(r.id + ': open needs a corresponding open finding with evidence'); continue;
    }
    verdicts.push(v);
  }
  return { problems, verdicts };
}
