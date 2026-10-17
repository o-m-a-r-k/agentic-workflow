// Review policy (0.7.0, D2): which findings block, which are observations, and whether the next round is a full blind
// audit or a delta review. Shared by the review stream (lifecycle.mjs, scope-decisions.mjs), the strategist and the
// signals; this module reads the ledger state and git and writes nothing.
//
// Named failure: the exit condition "a fresh blind reviewer finds nothing on the whole tree" never held on a large
// change. Reviewers found about 2 issues per 100 tool calls on every model, so effort, not defects, set the count, and
// one ticket ran 47 rounds; the last rounds raised findings on older code the ticket merely touched (none of 24 on
// lines changed since the previous round). A finding now blocks only for a reason the engine can check:
//   (a) it cites a frozen criterion the change fails (`criterion: "C2"`),
//   (b) it is a regression on lines this attempt changed (the finding's file:line falls inside the attempt's diff; in a
//       delta round, inside the lines changed since the last reviewed tree), or
//   (c) it is tagged as breaking a critical invariant (`invariant: "<which one>"`).
// Every other open finding is an observation: it never opens a round, and it is fixed, ticketed or moved to a sibling
// attempt before delivery. Severity alone never blocks.
import fs from 'node:fs';
import { git, hashValue, run } from './util.mjs';
import { gatePassedForCurrentTree } from './gate.mjs';
import { obligationSince } from './versions.mjs';

// 'moved': a finding `wf split` handed to a sibling attempt of the batch (the sibling carries the obligation).
const SETTLED = new Set(['fixed', 'verified-nonissue', 'moved']);
export const settled = (f) => SETTLED.has(f?.status);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// D2 taken literally: a full blind audit runs at most twice per attempt, at its first review and at its first evidence
// review (a gate passed on this tree); every other round, an evidence review after a fix included, is a delta: the diff
// since the last reviewed tree, the open findings handed up front, and (for an evidence review) the new gate evidence.
// A round that was handed but never recorded (refused, tree moved) was not an audit, so it does not count. Handoffs
// recorded before 0.7 carry no mode: they were full rounds.
// Named failure (final review of 0.7.0): the evidence review stayed a full blind audit after every fix, so each fix
// returned to a fresh audit of the whole change, which finds about two issues per hundred tool calls whatever the code;
// acceptance was the old unreachable exit, moved to the last stage.
const isEvidenceRound = (h) => h.round === 'evidence-review' || (!h.round && Boolean(h.gate));

// What a recorded closure says it did not reach: a list of strings (a lone string is one item; "none" and the like are
// an empty list). The reviewer states it honestly (templates/agents/reviewer.md); the engine never judges the words.
const NOTHING = /^(none|nothing|n\/a|na|-|--)\.?$/i;
export function unreachedOf(closure) {
  const v = closure?.notReached;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return list.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.what ?? x.scope ?? x.item ?? x.area ?? JSON.stringify(x) : String(x ?? ''))).map((x) => String(x).trim()).filter((x) => x && !NOTHING.test(x));
}

// Rounds with a recorded closure, once each (a round recorded twice, blind and then with its prior-finding verdicts,
// counts at its latest record), in the order they were first recorded.
export function recordedRoundsOf(state) {
  const by = new Map();
  for (const r of state.reviews ?? []) by.set(r.handoff ?? `reviewer:${r.reviewer}`, r);
  return [...by.values()];
}

// Scope earlier rounds said they did not reach and no complete full audit has covered since: what the owner and the next
// reviewer should see beside the course. A complete full audit judged the whole change, so everything before it is moot.
// Named failure (I-69): a launched reviewer stopped early and recorded `notReached`; the round counted as the attempt's one
// full audit and nothing showed the owner, the next reviewer or the delivered comment what was never looked at.
// A recorded round that counts as an audit: an evidence round the engine found covered, or one that named nothing unreached.
// A round the engine kept from a reviewer that did not finish (I-152) is never an audit, whatever it mapped.
export const auditReached = (r) => r.partial !== true && (r.covered === true || !unreachedOf(r.closure).length);

export function unreachedSince(state) {
  const handoffs = new Map((state.handoffs ?? []).filter((h) => h.role === 'reviewer').map((h) => [h.bundle, h]));
  const rounds = recordedRoundsOf(state);
  const lastAudit = rounds.map((r) => handoffs.get(r.handoff)).findLastIndex((h, i) => h && (h.mode ?? 'full') === 'full' && !unreachedOf(rounds[i].closure).length);
  // What a round named as not reached is shown whether or not the round counted as the audit (I-133: a covered evidence
  // round still counts; the person and the next reviewer still see what it named).
  return rounds.slice(lastAudit + 1).map((r) => ({ round: r.handoff ? String(r.handoff).replace(/^.*\//, '').replace(/\.json$/, '') : null, reviewer: r.reviewer ?? r.closure?.reviewer ?? null, mode: handoffs.get(r.handoff)?.mode ?? 'full', notReached: unreachedOf(r.closure), ...(r.covered === true ? { covered: true } : {}) })).filter((x) => x.notReached.length);
}

// What the owner does when the reviewer it handed (and the engine launched) is gone and recorded no closure. Named failure
// (I-69): the line said "record its closure through the handed reviewer", which named no route; a second `wf handoff run`
// is refused (a handoff launches once), and nothing said that a round with no recorded closure is not an audit. Two routes
// exist: record the closure the reviewer wrote, when it is a complete one, or hand a fresh reviewer.
export function closureMissingGuidance(state, h) {
  const next = roundMode(state);
  const file = h.closureFile && fs.existsSync(h.closureFile) ? h.closureFile : null;
  return `reviewer ${h.agent} completed with no closure recorded (process completion does not prove a review). A round with no recorded closure is not an audit and counts toward nothing, so the next reviewer is handed a ${next} round. ${file ? `If its closure file is complete (\`findings\` and \`criteria\` as well as the plan it stated early), record it: \`wf review --closure ${file} --attempt ${state.id}\`; the engine refuses a file without them, and a closure that names scope it did not reach (\`notReached\`) is recorded as it is${obligationSince(state, '0.7.4') ? ' and does not count as the full audit' : ' (on this attempt, admitted before 0.7.4, it still counts as the full audit)'}. ` : 'It wrote no closure file. '}Otherwise hand a fresh reviewer with a new id: \`wf handoff reviewer --agent <new id> --attempt ${state.id}\`, then \`wf handoff run --agent <new id> --attempt ${state.id}\` (\`wf handoff run\` launches a handoff once; the new bundle lists any scope earlier rounds named as not reached, and a long input is no reason for a reviewer to end without a closure)`;
}

export function roundMode(state, { evidence } = {}) {
  const handoffs = new Map((state.handoffs ?? []).filter((h) => h.role === 'reviewer').map((h) => [h.bundle, h]));
  // Named failure (I-69): a closure that names scope it did not reach was recorded as the attempt's full audit, so every
  // later round was a delta and the unreached scope was never looked at. Only a round that reached everything is an audit.
  // D7: this makes the next round of an attempt that already recorded such a closure a full one, so it applies to attempts
  // admitted at 0.7.4 or later; the others keep counting it.
  // Named failure (I-133): an evidence round that mapped every criterion to the gate's evidence and opened every new
  // screenshot (what the engine checks: `covered`, stamped when it is recorded) wrote caveats under `notReached` (a check
  // its criteria exclude, "may not change the tree"), lost its audit status, and the next round after a one-family repair
  // was handed full, with 94 screenshots, 51 of them inspected before.
  const reached = obligationSince(state, '0.7.4') ? auditReached : (r) => r.partial !== true;
  const audits = recordedRoundsOf(state).filter(reached).map((r) => handoffs.get(r.handoff)).filter((h) => h && (h.mode ?? 'full') === 'full');
  if (evidence ?? gatePassedForCurrentTree(state).ok) return audits.some(isEvidenceRound) ? 'delta' : 'full';
  // A strategist's `delta-review` decision (state.strategy.nextRound) makes the next code review a delta, once a recorded
  // review gives it a tree to take the delta from. Read before the reviewer handoff is appended, which clears it.
  // A partial round (I-152) gives no tree to take it from: it stopped part-way (second review of 0.7.12).
  if (state.strategy?.nextRound === 'delta' && (state.reviews ?? []).some((r) => !r.partial)) return 'delta';
  return audits.length ? 'delta' : 'full';
}

// ---- Where a finding points, and which lines changed ----

// `path:line`, `path:line-line` and `repo:path:line` tokens in free text (the reviewer template asks for `path:line`).
const LOC = /(\/?(?:[A-Za-z0-9_.@~+-]+:)?(?:[A-Za-z0-9_.@~+-]+\/)*[A-Za-z0-9_.@~+-]+\.[A-Za-z0-9]+):(\d+)(?:[-–](\d+))?/g;

// Every location a finding cites: explicit `file` + `line` fields first, then the `path:line` tokens of `evidence`,
// `location` and `where`.
export function locationsOf(f) {
  const out = [];
  const add = (file, a, b) => {
    const start = Number(a);
    if (text(file) && Number.isInteger(start) && start > 0) out.push({ file: text(file), start, end: Number.isInteger(Number(b)) && Number(b) >= start ? Number(b) : start });
  };
  if (text(f?.file) && f.line !== undefined) {
    const m = /^(\d+)(?:[-–](\d+))?$/.exec(String(f.line).trim());
    if (m) add(f.file, m[1], m[2]);
  }
  for (const field of [f?.evidence, f?.location, f?.where]) {
    if (typeof field !== 'string') continue;
    for (const m of field.matchAll(LOC)) add(m[1], m[2], m[3]);
  }
  return out;
}

// { file: [[start, end], ...] } from a unified diff with no context: the new-side line ranges of each hunk. A pure
// deletion marks the two lines around it (a reviewer cites the line where the removed check used to be).
function rangesFromDiff(diff) {
  const files = {};
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, '');
    else if (file && line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      (files[file] ??= []).push(count === 0 ? [Math.max(1, start), start + 1] : [start, start + count - 1]);
    }
  }
  return files;
}

const diffRanges = (worktree, range) => rangesFromDiff(git(worktree, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', range], { allowFail: true }) ?? '');

// Lines this attempt changed against its base, per repo: { repo: { file: ranges } } (the merge-base diff `wf` uses
// everywhere else).
export function changedLines(state) {
  const out = {};
  for (const [name, r] of Object.entries(state.repos ?? {})) if (r.worktree) out[name] = diffRanges(r.worktree, `${r.baseRef ?? r.base}...HEAD`);
  return out;
}

const isAncestor = (dir, sha) => Boolean(sha) && run('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: dir, allowFail: true }).status === 0;
// The commit a repo was last judged at (`<sha>` or `<sha>+dirty:...` in a tree record), when it still leads to HEAD.
export const sinceOf = (r, tree) => {
  const from = text(tree).split('+')[0];
  return from && r.worktree && isAncestor(r.worktree, from) ? from : null;
};

// Lines changed since the tree a reviewer last judged (`since`: { repo: tree record }). A repo whose earlier head no
// longer leads to HEAD (the branch was rebuilt, a base merged) counts the whole attempt diff, so nothing is hidden.
// Only the attempt's own lines count: what `wf base merge` brought in from the base since then is not this attempt's change.
// Named failure (second final review of 0.7.0): after a base merge the delta was everything the base gained, so a defect
// another ticket wrote blocked this attempt and the delta reviewer was handed the base's files instead of the fix.
export function deltaLines(state, since) {
  const out = {};
  const own = changedLines(state);
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!r.worktree) continue;
    const from = sinceOf(r, since?.[name]);
    const raw = diffRanges(r.worktree, from ? `${from}..HEAD` : `${r.baseRef ?? r.base}...HEAD`);
    // Narrowed only when a base merge moved the merge-base since then: otherwise every line changed since is the attempt's
    // own, a revert to the base text included (verification of the second final review).
    const base = r.baseRef ?? r.base;
    const moved = from && git(r.worktree, ['merge-base', base, from], { allowFail: true }) !== git(r.worktree, ['merge-base', base, 'HEAD'], { allowFail: true });
    out[name] = moved ? intersectFiles(raw, own[name] ?? {}) : raw;
  }
  return out;
}

// The parts of `a`'s line ranges that also lie in `b`'s, per file.
function intersectFiles(a, b) {
  const out = {};
  for (const [file, ranges] of Object.entries(a)) {
    const other = b[file];
    if (!other) continue;
    const kept = [];
    for (const [s1, e1] of ranges) for (const [s2, e2] of other) if (Math.max(s1, s2) <= Math.min(e1, e2)) kept.push([Math.max(s1, s2), Math.min(e1, e2)]);
    if (kept.length) out[file] = kept;
  }
  return out;
}

// Whether a cited path names `file` of `repo`. A path may carry its repo (`app:src/a.ts`, `app/src/a.ts`) or be absolute into
// that repo's worktree; one that names another repo never matches this one, and a bare relative path matches by its tail.
const sameFile = (cited, repo, file, roots) => {
  let c = cited.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const [name, root] of Object.entries(roots)) {
    const dir = `${String(root).replace(/\\/g, '/').replace(/\/$/, '')}/`;
    if (root && c.startsWith(dir)) return name === repo && (c.slice(dir.length) === file);
  }
  for (const name of Object.keys(roots)) {
    if (c.startsWith(`${name}:`) || c.startsWith(`${name}/`)) {
      if (name !== repo) return false;
      c = c.slice(name.length + 1);
      break;
    }
  }
  return c === file || c.endsWith(`/${file}`) || file.endsWith(`/${c}`);
};

// The first cited location of `f` that falls inside `lines` ({ repo: { file: ranges } }): { repo, file, line, cited }, or
// null. `roots` maps each repo to its worktree.
function placeIn(lines, f, roots = {}) {
  const known = { ...Object.fromEntries(Object.keys(lines ?? {}).map((k) => [k, roots[k] ?? null])), ...roots };
  for (const loc of locationsOf(f)) {
    for (const [repo, files] of Object.entries(lines ?? {})) {
      for (const [file, ranges] of Object.entries(files)) {
        const hit = ranges.find(([a, b]) => loc.start <= b && loc.end >= a);
        if (sameFile(loc.file, repo, file, known) && hit) return { repo, file, line: Math.max(loc.start, hit[0]), cited: `${loc.file}:${loc.start}` };
      }
    }
  }
  return null;
}
// As `placeIn`, as `file:line` (the citation).
export const locationIn = (lines, f, roots = {}) => placeIn(lines, f, roots)?.cited ?? null;

// A batch (lane `batch`) combines members that were each reviewed and accepted. A line one member's accepted commits wrote
// is that member's; only a line no member wrote (a merge resolution, a batch-only commit) is the batch's own. `git blame`
// on the batch head names the commit; a commit inside a member's accepted head is the member's.
// Named failure (final review of 0.7.0): the batch's full review re-audited every member's code and blocked on any line
// of the combined diff, so a split made the end of the work longer, not shorter.
function memberLine(state, place) {
  const dir = state.repos?.[place.repo]?.worktree;
  const heads = Object.values(state.batch?.heads ?? {}).map((h) => text(h?.[place.repo]).split('+')[0]).filter(Boolean);
  if (!dir || !heads.length) return false;
  const out = run('git', ['blame', '--porcelain', '-L', `${place.line},${place.line}`, 'HEAD', '--', place.file], { cwd: dir, allowFail: true });
  const sha = /^([0-9a-f]{40}) /.exec(out.status === 0 ? out.stdout : '')?.[1];
  return Boolean(sha) && heads.some((h) => run('git', ['merge-base', '--is-ancestor', sha, h], { cwd: dir, allowFail: true }).status === 0);
}

// ---- Placement by severity (the person's rule, 2026-10-13) ----
// Where an unfixed finding or discovered issue may go is decided by its severity, not by whether it blocks a round:
// high (critical, high, major, or unrated) and medium are fixed in this delivery, in the attempt or a sibling attempt of
// its batch; a low one leaves only with the person's yes (D17, 2026-10-14, engine/leaving.mjs). A finding that fails a
// frozen criterion or breaks a critical invariant is high whatever its severity says.
// Named failure: the 0.7.0 draft let any finding a delta round classed as not caused be ticketed with no approval, so a
// major defect in code the attempt itself wrote in an earlier round could leave the delivery unasked; and every
// discovered issue, a nit included, needed the person's approval to wait.
const LEVELS = { critical: 'high', blocker: 'high', high: 'high', major: 'high', severe: 'high', medium: 'medium', moderate: 'medium', normal: 'medium', low: 'low', minor: 'low', nit: 'low', trivial: 'low', cosmetic: 'low', info: 'low' };
export const severityLevel = (severity) => LEVELS[text(severity).toLowerCase()] ?? null;
export function placementOf(f, cited = [], invariant = '') {
  const level = cited.length || invariant ? 'high' : severityLevel(f?.severity) ?? 'high';
  return { placement: level };
}
// The placement of an open finding or discovered issue: 'high' | 'medium' | 'low'.
export const placementLevel = (state, f) => {
  if (f?.classified?.placement) return f.classified.placement;
  const criteria = new Set((state.criteria ?? []).filter((c) => !c.dropped).map((c) => String(c.id)));
  const cited = [f?.criterion, ...(Array.isArray(f?.criteria) ? f.criteria : [])].map(text).filter((x) => criteria.has(x));
  return placementOf(f, cited, text(f?.invariant)).placement;
};

// ---- Classification ----

// { blocks, reason, causedByChange, ... } for one finding. `ctx` carries the lines already computed for the round:
// { mode, attempt: changedLines(state), delta: deltaLines(state, since) }.
export function classifyWith(state, f, ctx) {
  const criteria = new Set((state.criteria ?? []).filter((c) => !c.dropped).map((c) => String(c.id)));
  const cited = [f?.criterion, ...(Array.isArray(f?.criteria) ? f.criteria : [])].map(text).filter((x) => criteria.has(x));
  const invariant = text(f?.invariant);
  const roots = Object.fromEntries(Object.entries(state.repos ?? {}).map(([k, r]) => [k, r.worktree ?? null]));
  const attemptPlace = placeIn(ctx.attempt, f, roots);
  const onAttempt = attemptPlace?.cited ?? null;
  const batchMember = ctx.mode !== 'delta' && state.lane === 'batch' && attemptPlace ? memberLine(state, attemptPlace) : false;
  const onDelta = ctx.mode === 'delta' ? locationIn(ctx.delta, f, roots) : batchMember ? null : onAttempt;
  const base = { mode: ctx.mode, causedByChange: Boolean(onDelta), onAttemptLines: Boolean(onAttempt), ...(batchMember ? { memberLine: true } : {}), ...placementOf(f, cited, invariant) };
  if (cited.length) return { ...base, blocks: true, reason: `cites frozen criterion ${cited.join(', ')} that the change fails`, criterion: cited[0] };
  if (invariant) return { ...base, blocks: true, reason: `breaks a critical invariant (${invariant})`, invariant };
  // A finding its reviewer rates low never opens a round (a low one may leave only with the person's yes, D17). It is an observation: fixed in the
  // next pass, or deferred. Named failure (second final review of 0.7.0): a nit one line inside the diff forced a fix cycle,
  // a gate and another review, and could not be deferred, while the same nit one line outside was deferred freely.
  if (base.placement === 'low') return { ...base, blocks: false, reason: `observation: rated ${text(f?.severity)} (low)${onDelta ? ` on a changed line (${onDelta})` : ''}; it may be fixed in the next pass or wait` };
  if (onDelta) return { ...base, blocks: true, reason: `regression on a line this attempt changed (${onDelta})` };
  // Security review of the A1 merge (fail-open): a full-round finding that cites no location, criterion or invariant could
  // not be checked at all and became a non-blocking observation that could be ticketed without approval. In a full round it
  // blocks until a later round locates it or verifies it; a delta round keeps it an observation (the convergence rule).
  if (ctx.mode !== 'delta' && !locationsOf(f).length) return { ...base, blocks: true, reason: 'a full-round finding that cites no file:line, frozen criterion or critical invariant (locate it, or verify it as a non-issue)' };
  const where = batchMember ? `a line a batch member wrote (${onAttempt}); the member owes it` : onAttempt ? `a line changed in an earlier round (${onAttempt}), not in this delta` : 'no line this attempt changed';
  return { ...base, blocks: false, reason: `observation: cites ${where}, no failed frozen criterion and no critical invariant` };
}

export const stripStamp = (findings) => (findings ?? []).map(({ classified: _ignored, ...f }) => f);

// Stamps every finding of a closure with the classification computed for the tree and round it was recorded on. The stamp
// is the engine's: a `classified` field in the reviewer's own closure is replaced. Later rounds change the diff, but not
// what a finding was when it was raised. `since` is the tree record of the last reviewed tree (delta rounds).
export function stampClosure(state, closure, { mode, since = null }) {
  const ctx = { mode, attempt: changedLines(state), delta: mode === 'delta' ? deltaLines(state, since) : null };
  return { ...closure, findings: stripStamp(closure.findings).map((f) => ({ ...f, classified: classifyWith(state, f, ctx) })) };
}

// { blocks, reason, causedByChange } for one finding of a closure. A finding recorded by `wf review` carries the engine's
// stamp; one that does not (a ledger from before 0.7) is classified against the attempt's diff as it is now.
const linesOf = new WeakMap();
export function classifyFinding(state, f) {
  if (f?.classified && typeof f.classified.blocks === 'boolean') return f.classified;
  if (!linesOf.has(state)) linesOf.set(state, changedLines(state));
  return classifyWith(state, f, { mode: 'full', attempt: linesOf.get(state), delta: null });
}

// ---- Dispositions: waived, ticketed, moved ----

export const refOf = (round, id) => `${round}:${id}`;
// A finding the owner approved waiving (`wf approve`, kind waive-finding, key `<round>:<id>`).
export const waivedRef = (state, ref) => (state.decisions ?? []).filter((d) => d.kind === 'waive-finding' && d.key === ref).at(-1)?.approved?.choice === 'yes' || (state.scopeDecisions ?? []).some((d) => d.choice === 'waived' && (d.keys ?? []).includes(ref));
// A finding ticketed (`wf scope ticket`), moved to a sibling attempt (`wf scope move`) or recorded fixed by the owner with
// the attempt's commit (`wf scope fixed`, observations only).
// A `fixed` claim that a later reviewer found still open is undone (second final review of 0.7.0: the reviewer's `open` was
// ignored and the defect shipped).
const reopened = (state, d, ref) => d.choice === 'fixed' && (state.reviews ?? []).some((r) => r.at > d.at && (r.closure?.priorFindings ?? []).some((p) => refOf(p.round, p.id) === ref && p.status === 'open'));
export const dispositionOf = (state, ref) => {
  const d = (state.scopeDecisions ?? []).filter((x) => ['ticketed', 'moved', 'fixed', 'deferred'].includes(x.choice) && (x.keys ?? []).includes(ref)).at(-1) ?? null;
  return d && !reopened(state, d, ref) ? d : null;
};

// An attempt admitted before 0.7.0 may hold a finding the owner waived under the extra-scope flow (`wf scope decide` ignore,
// or a ticket readback), keyed by the hash of its four-boolean `scope` form. Such a finding stays settled (D7: a release
// does not reopen what a live attempt closed).
export const legacyWaived = (state, f) => {
  const x = f?.scope;
  if (x?.kind !== 'extra' || !text(x.issue) || !text(x.reason) || !text(x.baseEvidence) || !text(x.currentEvidence)) return false;
  if (x.requiredByRequest !== false || x.causedByChange !== false || x.affectsChangedContract !== false || x.requiredValidation !== false) return false;
  const key = hashValue({ issue: x.issue, base: x.baseEvidence, current: x.currentEvidence, reason: x.reason });
  return (state.scopeDecisions ?? []).some((d) => (d.keys ?? []).includes(key) && ['ignore', 'ticketed'].includes(d.choice));
};

// ---- Open findings across rounds ----

const roundKey = (r) => r.handoff ?? `reviewer:${r.reviewer}`;
const reviewerOf = (r) => r.closure?.reviewer ?? r.reviewer;

// Findings the recorded rounds left open (the newest recording of each round), minus those a later round verified or the
// owner waived. Each entry is the finding as recorded plus `round` (the reviewer id), `ref` (`round:id`) and its
// classification. `exceptRound` leaves one round out (a reviewer asking what the others left).
export function openAcrossRounds(state, exceptRound = null) {
  const last = new Map();
  for (const r of state.reviews ?? []) last.set(roundKey(r), r);
  const open = new Map();
  for (const [key, r] of last) {
    if (key === exceptRound) continue;
    for (const p of r.closure.priorFindings ?? []) {
      const ref = refOf(p.round, p.id);
      if (settled(p) && p.evidence) open.delete(ref);
      // A later, independent reviewer may re-rate a finding it verifies still open: the latest rating decides where it may
      // go, and a finding re-rated low stops blocking unless it cites a criterion or an invariant. Named failure (second
      // final review of 0.7.0): the work owed was set by one reviewer's self-rated severity, and models rate differently.
      else if (open.has(ref) && severityLevel(p.severity)) {
        const f = open.get(ref);
        const level = placementOf({ severity: p.severity }, f.classified.criterion ? [f.classified.criterion] : [], f.classified.invariant ?? '').placement;
        // Re-rated low, it stops opening rounds; where it may go keeps the higher of the two ratings, so a disagreement
        // between reviewers never lets a defect leave the delivery unasked (verification of the second final review:
        // a major re-rated low was deferred with no decision).
        const rank = { low: 0, medium: 1, high: 2 };
        const before = f.classified.placement ?? placementOf(f).placement;
        const placement = rank[level] >= rank[before] ? level : before;
        const classified = { ...f.classified, placement, ...(level === 'low' && f.classified.blocks && !f.classified.criterion && !f.classified.invariant ? { blocks: false, reason: `observation: re-rated ${text(p.severity)} by ${reviewerOf(r)} (placed by the higher rating, ${placement})` } : {}) };
        open.set(ref, { ...f, severity: p.severity, rerated: { by: reviewerOf(r), from: f.severity ?? null }, classified });
      }
    }
    for (const f of r.closure.findings ?? []) {
      const ref = refOf(reviewerOf(r), f.id);
      if (settled(f)) open.delete(ref);
      else if (!waivedRef(state, ref) && !legacyWaived(state, f)) open.set(ref, { ...f, round: reviewerOf(r), ref, classified: classifyFinding(state, f) });
    }
  }
  return [...open.values()];
}

// A finding by its ref, as the latest round that recorded it has it, with its classification (null when no round did).
export function findingByRef(state, ref) {
  let found = null;
  for (const r of state.reviews ?? []) for (const f of r.closure?.findings ?? []) if (refOf(reviewerOf(r), f.id) === ref) found = { ...f, ref, round: reviewerOf(r) };
  return found ? { ...found, classified: classifyFinding(state, found) } : null;
}

// What a finding said, by its ref, from the latest round that recorded it (null when no round did).
export function findingSummary(state, ref) {
  let summary = null;
  for (const r of state.reviews ?? []) for (const f of r.closure?.findings ?? []) if (refOf(reviewerOf(r), f.id) === ref && f.summary) summary = f.summary;
  return summary;
}

// Open findings of one recorded review that block the gate and acceptance.
// One that went to a sibling attempt or a ticket (a move the owner approved) no longer holds this attempt.
export const blockingIn = (state, review) => (review?.closure?.findings ?? []).filter((f) => {
  const ref = refOf(reviewerOf(review), f.id);
  return !settled(f) && !waivedRef(state, ref) && !legacyWaived(state, f) && !dispositionOf(state, ref) && classifyFinding(state, f).blocks;
});

// Open findings of the latest recorded review that block the gate and acceptance.
export const blockingOpen = (state) => blockingIn(state, state.review);

// Per recorded round (in the order the rounds were first recorded), how many of the findings of the rounds up to it are open now:
// those no later round verified fixed and the owner did not waive, ticket or move. Today's waivers and dispositions apply to every
// prefix, so it is not what stood open when that round was recorded. 0.7.27 (I-185). Named failure (field): a
// delta round that raised nothing of its own while two earlier blocking findings stayed open was counted as "0 blocking",
// because the per-round count is only what the round itself raised.
export function blockingSeries(state) {
  const rounds = recordedRoundsOf(state);
  return rounds.map((_, i) => earlierBlocking({ ...state, reviews: rounds.slice(0, i + 1) }, null).length);
}

// Open findings that do not block, from every round, not yet fixed, ticketed or moved: the strategist schedules them
// (a batch fix pass, a sibling attempt, or a ticket) and delivery waits for them.
// A high observation the owner recorded fixed (`wf scope fixed`) still waits for a reviewer's `fixed` (second final review
// of 0.7.0). A medium or low one is settled by the claim; one no reviewer saw is listed in the delivered comment's known
// limits (0.7.8: blocking delivery on it was a stop the person did not want).
export const observations = (state) => openAcrossRounds(state).filter((f) => {
  if (f.classified.blocks) return false;
  const d = dispositionOf(state, f.ref);
  return !d || (d.choice === 'fixed' && placementLevel(state, f) === 'high');
});

// Earlier rounds' blocking findings: what a later round must verify before the gate or acceptance.
export const earlierBlocking = (state, exceptRound) => openAcrossRounds(state, exceptRound).filter((f) => f.classified.blocks && !dispositionOf(state, f.ref));

// ---- Discovered issues a reviewer judges ----

// An implementer's own lint or fixture fix is bookkeeping: closed in the handoff that made it, never a verdict item.
export const isBookkeeping = (d) => d?.kind === 'bookkeeping';
// What a reviewer's bundle lists: defects still open or deferred, and those closed fixed since the last recorded review
// round (`fixedSinceReview`), so a reviewer sees the claimed fix and raises a finding if it does not hold (independent
// review of 0.7.7: a fixed claim never reached a reviewer). Older fixed defects and bookkeeping are the attempt's history.
// An entry the owner waived under the old extra-scope flow (before 0.7.0) stays settled.
// When the last recorded review round was handed its bundle (else when it was recorded): a fix closed after that time is
// one no reviewer was shown (independent review of 0.7.7: the recording time let a fix closed while a round ran pass).
export const lastReviewSeenAt = (state) => {
  const r = (state?.reviews ?? []).filter((x) => x.at).sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1);
  if (!r) return null;
  const h = (state.handoffs ?? []).filter((x) => x.role === 'reviewer' && r.handoff && x.bundle === r.handoff).at(-1);
  return h?.at ?? r.at;
};
// 0.7.27 (I-188): an entry closed as not a defect is shown to the next round once, as a fixed one is, so the claim can be raised
// again as a finding if it holds after all.
export const reviewerDiscovered = (entries, state = null) => {
  const lastReview = lastReviewSeenAt(state);
  return (entries ?? []).filter((d) => (!isBookkeeping(d) || (d.status === 'open' && d.claim)) && !(state && legacyWaived(state, d)) && (d.status !== 'fixed' || (state && (!lastReview || (d.fixed?.at && d.fixed.at > lastReview)))) && (d.status !== 'not-a-defect' || (state && (!lastReview || (d.notADefect?.at && d.notADefect.at > lastReview))))).map((d) => (d.status === 'fixed' ? { ...d, fixedSinceReview: true } : d.status === 'not-a-defect' ? { ...d, notADefectSinceReview: true } : d.claim ? { ...d, claimedFixed: { repo: d.claim.repo, commit: d.claim.commit, note: 'fixed by a commit made before it was recorded; the reviewer checks that commit and gives `discovered: [{ "id": "' + d.id + '", "verdict": "fixed" | "open", "evidence": "<file:line>" }]`, and its `fixed` closes the entry' } } : d));
};
