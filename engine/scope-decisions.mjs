// What happens to a review finding that is not fixed in this attempt (0.7.0, D1 and D2).
//
// Named failures: the four-boolean scope form on every finding made agents class 97% of findings "in scope", and
// "uncertain causality remains blocking" kept an owner decision loop (`wf scope ask`, `decide`) in front of every
// unrelated defect. The engine now computes what a finding is (engine/review-policy.mjs: blocking, or an observation) and
// this module only records where an unfixed one went: a follow-up ticket (a raw tracker readback) or a sibling attempt.
// Placement is not obligation: nothing broken is dropped, but where a fix lives can change. A defect the change caused or
// one on a critical boundary leaves the delivery batch only with the owner's `wf approve` (kind move-out-of-batch).
// 0.7.7 (D17): medium and high never leave; a low one leaves only with the person's yes (engine/leaving.mjs).
import path from 'node:path';
import { actor, openState } from './attempt.mjs';
import { append, attemptDir, loadState, recordedTogether } from './ledger.mjs';
import { requireYes } from './approve.mjs';
import { readRegular, withEvidenceTransaction } from './evidence.mjs';
import { blockingIn, dispositionOf, locationsOf, observations, openAcrossRounds, placementLevel } from './review-policy.mjs';
import { discoveredLevel, headsNow, ticketCommit } from './discovered.mjs';
import { discoveredRating, leavingDecision } from './leaving.mjs';
import { git, run } from './util.mjs';
import { hashFile, refuse, WfError, writeImmutable } from './util.mjs';

const text = (x) => (typeof x === 'string' ? x.trim() : '');

// Open findings of a recorded review that block the gate and acceptance (advance.mjs and the gate order read this).
export const blockingFindings = (state, review = state.review) => blockingIn(state, review);

// Every open finding with how it was classified and where it went: `wf scope list`.
export const scopeRows = (state) => openAcrossRounds(state).map((f) => {
  const d = dispositionOf(state, f.ref);
  return { ref: f.ref, id: f.id, round: f.round, family: f.family ?? null, severity: f.severity ?? null, placement: placementLevel(state, f), summary: f.summary ?? '', blocks: f.classified.blocks, reason: f.classified.reason, disposition: d ? { choice: d.choice, ticket: d.ticket?.url ?? null, sibling: d.sibling ?? null, commit: d.commit ?? null } : null };
});

// Unresolved observations, one line each, for the owner's next step.
export const observationLines = (state) => observations(state).map((f) => {
  const claimed = dispositionOf(state, f.ref)?.choice === 'fixed';
  return `${f.ref}${f.family ? ` [${f.family}]` : ''}: ${f.summary ?? ''}${claimed ? ' (claimed fixed: a fresh reviewer verifies it, `wf handoff reviewer --agent <new id>`)' : ''}`;
});

const find = (state, ref) => {
  const open = openAcrossRounds(state);
  const f = open.find((x) => x.ref === ref);
  if (!f) throw refuse(`${ref || '(no finding named)'} is not an open review finding of ${state.id} (open: ${open.map((x) => x.ref).join(', ') || 'none'})`);
  return f;
};

// A move within the delivery batch keeps the defect in this delivery (D1, D10), so it asks nobody; but the fix lives where
// the code is: a finding on a line this attempt changed is fixed here, because a sibling starts from the base and has no
// such line (the same rule as `wf split`). Refusal audit of 0.7.0: a move asked the person's approval although nothing
// left the delivery, and `wf split` and `wf scope move` answered the same finding differently.
function movable(f) {
  if (f.classified.onAttemptLines) throw refuse(`${f.ref} is on a line this attempt changed: its fix lives in this attempt's branch (a sibling starts from the base); fix it here`, null, { id: 'scope:move-own-line' });
}

// The items a placement names: review findings (`reviewer:F1`) and discovered issues (`D3`) together, so every low item
// that leaves is put to the person in one question (D17).
function leavingItems(state, refs) {
  return refs.map((ref) => {
    if (/^D\d+$/.test(ref)) {
      const d = (state.discovered ?? []).find((x) => x.id === ref);
      if (!d) throw new WfError(`no discovered issue ${ref} on ${state.id}${state.discovered?.length ? ` (${state.discovered.map((x) => x.id).join(', ')})` : ''}`);
      if (d.status !== 'open') throw refuse(`${ref} is already ${d.status}`);
      return { kind: 'discovered', ref, entry: d, level: discoveredLevel(d), blocks: false, severity: d.severity ?? null, summary: d.summary ?? '', raisedAt: d.at ?? null, ...discoveredRating(d) };
    }
    const f = find(state, ref);
    if (dispositionOf(state, f.ref)) throw refuse(`${f.ref} already went elsewhere`);
    const where = f.file && f.line !== undefined ? `${f.file}:${f.line}` : (typeof f.evidence === 'string' ? (f.evidence.match(/[\w./@~+-]+\.[A-Za-z0-9]+:\d+/)?.[0] ?? null) : null);
    return { kind: 'finding', ref: f.ref, entry: f, level: placementLevel(state, f), blocks: f.classified.blocks, severity: f.severity ?? null, summary: f.summary ?? '', raisedAt: raisedAt(state, [f]), ratedBy: `reviewer ${f.round}`, ratings: [], where };
  });
}

// Each discovered issue of a placement, closed under the decision that let it leave (with the follow-up ticket, if any).
function closeLeaving(root, state, items, decision, reason, options, ticket = null) {
  const via = (state.decisions ?? []).find((x) => x.id === decision)?.approved?.via ?? null;
  for (const x of items.filter((i) => i.kind === 'discovered')) {
    append(root, state.id, 'discovered.closed', { id: x.ref, outcome: 'deferred', decision: `${ticket ? `ticketed as ${ticket.id} (${ticket.url})` : 'left for later as a known issue'}, with the person's decision ${decision}${reason ? `: ${reason}` : ''}`, source: { provenance: 'approved-decision', decision, ...(via ? { via } : {}) }, ...(ticket ? { ticket } : {}), attributedTo: text(options.by) || null }, actor(options));
  }
}

// Moves open findings to a sibling attempt (`wf scope move`, and the strategist's split). The sibling carries the obligation.
export function moveOut(root, options, refs, { to, reason }) {
  const state = openState(root, options);
  const sibling = text(to);
  if (!sibling) throw new WfError('--sibling <sibling attempt id> is required');
  if (sibling === state.id) throw refuse('a finding cannot move to its own attempt');
  let target;
  try {
    target = loadState(root, sibling);
  } catch {
    throw refuse(`no attempt ${sibling} to move the finding to`);
  }
  if (['done', 'abandoned'].includes(target.phase)) throw refuse(`${sibling} is ${target.phase}; the finding would be dropped`, 'move it to an attempt that is still open', { id: 'scope:move-closed' });
  // A sibling carries the obligation only if it is delivered with this attempt: same batch (a `wf split` reserves one).
  if (!state.batchOf || state.batchOf !== target.batchOf) throw refuse(`${sibling} is not in ${state.id}'s delivery batch (${state.batchOf ?? 'none'}); a moved finding would not be delivered with this change`, 'split the work first (`wf split`), or ticket the finding (`wf scope ticket`)', { id: 'scope:move-outside-batch' });
  // Security review (check-then-act): the disposition and approval checks and the append run in one evidence
  // transaction, so a concurrent `wf scope move|ticket` cannot record a second disposition between them.
  for (const ref of refs) withEvidenceTransaction(root, state.id, () => {
    const now = loadState(root, state.id);
    const f = find(now, ref);
    if (dispositionOf(now, ref)) throw refuse(`${ref} already went elsewhere`);
    movable(f);
    // Independent review of 0.7.0 (HIGH): the move only dropped the finding from this attempt; the sibling never heard of
    // it. It now becomes an open defect of the sibling, which its reviewer judges and its delivery waits for (D1).
    const sib = loadState(root, sibling);
    const where = f.file && f.line !== undefined ? `${f.file}:${f.line}` : (typeof f.evidence === 'string' ? (f.evidence.match(/[\w./@~+-]+\.[A-Za-z0-9]+:\d+/)?.[0] ?? null) : null);
    const movedId = `D${(sib.discovered?.length ?? 0) + 1}`;
    withEvidenceTransaction(root, sibling, () => append(root, sibling, 'discovered.added', { id: movedId, summary: `moved from ${state.id} ${ref}: ${f.summary ?? ''}`.trim(), kind: 'defect', severity: f.severity ?? null, where, foundBy: f.round ?? null, blockedBy: null, movedFrom: { attempt: state.id, ref }, raisedOn: headsNow(sib) }, actor(options)));
    append(root, state.id, 'scope.moved', { keys: [ref], choice: 'moved', sibling, siblingIssue: movedId, reason: text(reason) || null, blocked: f.classified.blocks }, actor(options));
  });
  return loadState(root, state.id);
}

// A follow-up ticket for one or more open findings or discovered issues (`--finding a,b,D3`: one tracker issue may cover a
// family), with the tracker's raw readback of the created issue. Only low items leave, with the person's yes (D17).
export function completeScopeTicket(root, options) {
  const opened = openState(root, options);
  // Named failure (I-109): the follow-up ticket's readback was written inside the transaction but recorded in the manifest only when
  // the process ended (a reader in between saw an extra file); it is recorded with the decision that cites it.
  return recordedTogether(root, opened.id, () => ticketLocked(root, options, loadState(root, opened.id)));
}
function ticketLocked(root, options, state) {
  const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!refs.length) throw new WfError('usage: wf scope ticket --finding <round:id|D-id>[,...] [--capture <raw readback>] [--reason "..."] (without --capture it asks the person first)');
  const items = leavingItems(state, refs);
  const found = items.filter((x) => x.kind === 'finding').map((x) => x.entry);
  // The person is asked before the follow-up ticket exists (independent review of 0.7.7: the readback was required first,
  // so a `no` left an orphaned tracker issue and the question a formality). With their yes, create it and record it.
  const reason = text(options.reason);
  const decision = leavingDecision(root, state, items, { verb: 'ticketed', reason, options });
  if (typeof options.capture !== 'string') throw refuse(`the person let ${items.map((x) => x.ref).join(', ')} leave as a follow-up ticket (${decision}): create it in the tracker now, save its raw readback, and run this command again with \`--capture <raw.json>\``, null, { id: 'scope:ticket-capture' });
  const raw = readRegular(path.resolve(options.capture));
  if (!raw || raw.bytes.length > 1024 * 1024) throw refuse('ticket readback must be a regular file at most 1 MiB');
  let data;
  try {
    data = JSON.parse(raw.bytes.toString('utf8'));
  } catch {
    throw refuse('ticket readback is not JSON');
  }
  const issue = data.issue ?? data;
  const id = text(issue.identifier) || text(issue.id);
  const url = text(issue.url) || text(issue.web_url);
  if (!id || !text(issue.title) || !/^https:\/\//.test(url)) throw refuse('raw ticket readback must contain issue id/identifier, title and HTTPS url; failed creation leaves the finding unresolved');
  const file = path.join(attemptDir(root, state.id), 'scope', `${items[0].ref.replace(/[^\w.-]+/g, '_')}${items.length > 1 ? `+${items.length - 1}` : ''}.ticket.json`);
  writeImmutable(file, raw.bytes.toString('utf8'));
  if (found.length) append(root, state.id, 'scope.ticketed', { keys: found.map((f) => f.ref), choice: 'ticketed', raw: { file, sha256: hashFile(file) }, ticket: { id, url, title: issue.title, capture: file, provenance: 'agent-reported-raw-readback' }, reason: reason || null, placement: Object.fromEntries(found.map((f) => [f.ref, placementLevel(state, f)])), decision, blocked: false }, actor(options));
  closeLeaving(root, state, items, decision, reason, options, { id, url, title: issue.title, capture: file });
  return loadState(root, state.id);
}

// An observation the attempt fixed, recorded by the owner with the fixing commit (`wf scope fixed --finding R:F1 --commit
// <sha>`): the commit is the attempt's (on its branch, after its base) and changes the file the finding cites. The next
// reviewer is handed it as fixed, to verify. A finding that blocks is verified by a review round, never by this.
// Named failure (final review of 0.7.0): a fixed observation was settled only when a later reviewer volunteered to verify
// it, so delivery could wait on a defect already fixed, and the way out was a follow-up ticket for fixed code.
export function recordFixed(root, options) {
  const opened = openState(root, options);
  const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!refs.length || typeof options.commit !== 'string') throw new WfError('usage: wf scope fixed --finding <round:id>[,<round:id>] --commit <sha> [--repo <repo>]');
  return withEvidenceTransaction(root, opened.id, () => {
    const state = loadState(root, opened.id);
    const c = ticketCommit(state, options.commit.trim(), typeof options.repo === 'string' ? options.repo : null);
    const touched = git(state.repos[c.repo].worktree, ['show', '--name-only', '--format=', c.commit]).split('\n').filter(Boolean);
    for (const ref of refs) {
      const f = find(state, ref);
      if (dispositionOf(state, ref)) throw refuse(`${ref} already went elsewhere`);
      if (f.classified.blocks) throw refuse(`${ref} blocks: a review round verifies its fix`, 'hand the next reviewer; it verifies the open findings it is handed', { id: 'scope:fixed-blocking' });
      // The fix comes after the finding: a commit already in the tree the finding was raised on cannot be its fix (second
      // final review of 0.7.0: the implementation commit that predated the finding settled it).
      const raisedOn = (state.reviews ?? []).filter((r) => (r.closure?.reviewer ?? r.reviewer) === f.round).at(0)?.tree?.[c.repo];
      const head = String(raisedOn ?? '').split('+')[0];
      if (head && run('git', ['merge-base', '--is-ancestor', c.commit, head], { cwd: state.repos[c.repo].worktree, allowFail: true }).status === 0) throw refuse(`${c.commit.slice(0, 10)} was already in the tree ${ref} was raised on: it cannot be the fix`, 'name the commit that fixed it, made after the finding', { id: 'scope:fixed-before-finding' });
    }
    // A fix may live in another file than the one a finding cites (a producer for a consumer's line), so a commit that does
    // not change the cited file is recorded with that fact, for the next reviewer who verifies it (refusal audit of 0.7.0).
    const elsewhere = refs.filter((ref) => {
      const files = locationsOf(find(state, ref)).map((l) => l.file.replace(/\\/g, '/').replace(/^\.\//, ''));
      return files.length && !files.some((x) => touched.some((t) => t === x || x.endsWith(`/${t}`) || t.endsWith(`/${x}`) || x.endsWith(`:${t}`)));
    });
    append(root, state.id, 'scope.fixed', { keys: refs, choice: 'fixed', repo: c.repo, commit: c.commit, ...(elsewhere.length ? { notInCitedFile: elsewhere } : {}) }, actor(options));
    return loadState(root, state.id);
  });
}

// `wf scope waive --finding R:F1 [--reason "..."]`: a finding that blocks is set aside by the person's decision (kind
// waive-finding, `wf approve`), D4. Named failure (refusal audit of 0.7.0): the reserved kind existed and every message
// pointed to it, but no command created it, so a blocking finding could leave only by being fixed or ticketed.
export function waiveFinding(root, options) {
  const opened = openState(root, options);
  return withEvidenceTransaction(root, opened.id, () => {
    const state = loadState(root, opened.id);
    const ref = text(options.finding);
    // The person's yes already sets the finding aside (review-policy waivedRef); this records the waiver once.
    const answered = (state.decisions ?? []).filter((d) => d.kind === 'waive-finding' && d.key === ref).at(-1);
    if (answered?.approved?.choice === 'yes') {
      if (!(state.scopeDecisions ?? []).some((d) => d.choice === 'waived' && (d.keys ?? []).includes(ref))) append(root, state.id, 'scope.waived', { keys: [ref], choice: 'waived', reason: text(options.reason) || null, decision: answered.id }, actor(options));
      return loadState(root, state.id);
    }
    const f = find(state, ref);
    if (!f.classified.blocks) throw refuse(`${f.ref} does not block: an observation is fixed, moved, deferred or ticketed (\`wf scope list\`)`, null, { id: 'scope:waive-observation' });
    const reason = text(options.reason);
    const decision = requireYes(root, state, { kind: 'waive-finding', key: f.ref, summary: `waive ${f.ref} (${f.severity ?? 'unrated'}: ${f.summary ?? ''}); it blocks because it ${f.classified.reason}${reason ? `; why: ${reason}` : ''}`, what: `waiving ${f.ref}`, options }).decision;
    append(root, state.id, 'scope.waived', { keys: [f.ref], choice: 'waived', reason: reason || null, decision }, actor(options));
    return loadState(root, state.id);
  });
}

// `wf scope defer --finding a,b,D3 [--reason "..."]`: low observations and discovered issues that wait without a follow-up
// ticket, listed in the delivered comment's known limits, under one decision of the person (D17); medium and high stay.
export function deferFindings(root, options) {
  const opened = openState(root, options);
  return withEvidenceTransaction(root, opened.id, () => {
    const state = loadState(root, opened.id);
    const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!refs.length) throw new WfError('usage: wf scope defer --finding <round:id|D-id>[,...] [--reason "..."]');
    const items = leavingItems(state, refs);
    const found = items.filter((x) => x.kind === 'finding').map((x) => x.entry);
    const reason = text(options.reason);
    const decision = leavingDecision(root, state, items, { verb: 'deferred', reason, options });
    if (found.length) append(root, state.id, 'scope.deferred', { keys: found.map((f) => f.ref), choice: 'deferred', reason: reason || null, placement: Object.fromEntries(found.map((f) => [f.ref, placementLevel(state, f)])), summaries: Object.fromEntries(found.map((f) => [f.ref, f.summary ?? ''])), decision }, actor(options));
    closeLeaving(root, state, items, decision, reason, options);
    return loadState(root, state.id);
  });
}

// When the latest of these findings was raised (its review's record time), for the person's deliver-core scope.
function raisedAt(state, findings) {
  const at = findings.map((f) => (state.reviews ?? []).filter((r) => (r.closure?.reviewer ?? r.reviewer) === f.round).at(0)?.at).filter(Boolean).sort();
  return at.at(-1) ?? null;
}
