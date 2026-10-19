// What happens to a review finding that is not fixed in this attempt (0.7.0, D1 and D2).
//
// Named failures: the four-boolean scope form on every finding made agents class 97% of findings "in scope", and
// "uncertain causality remains blocking" kept an owner decision loop (`wf scope ask`, `decide`) in front of every
// unrelated defect. The engine now computes what a finding is (engine/review-policy.mjs: blocking, or an observation) and
// this module only records where an unfixed one went: a follow-up ticket (a raw tracker readback) or a sibling attempt.
// Placement is not obligation: nothing broken is dropped, but where a fix lives can change. A defect the change caused or
// one on a critical boundary leaves the delivery batch only with the owner's `wf approve` (kind move-out-of-batch).
// 0.7.7 (D17): medium and high never leave; a low one leaves only with the person's answer, one short question per item (D18, engine/leaving.mjs).
import path from 'node:path';
import { actor, openState } from './attempt.mjs';
import { append, attemptDir, loadState, recordedTogether } from './ledger.mjs';
import { chose, createDecision, decisionFor, optionLines, panelNote, questionFor, READ_LINE, requireYes, settledBy, SHOW_TEXT } from './approve.mjs';
import { FRAMES, askFirst, askProblems, composeAsk, itemAsk, itemWords, readAsk } from './asking.mjs';
import { readRegular, withEvidenceTransaction } from './evidence.mjs';
import { blockingIn, dispositionOf, findingByRef, locationsOf, observations, openAcrossRounds, placementLevel } from './review-policy.mjs';
import { discoveredLevel, headsNow, ticketCommit } from './discovered.mjs';
import { discoveredRating, leavingDecisions, policyOf, provenDisposition } from './leaving.mjs';
import { trustedAdapter } from './config.mjs';
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
// that leaves is put to the person in the same panel, one short question per item (D18).
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
// The person's plain wording per item, when the owner gives it (`--explain <file.json>`: { "<ref>": { what, fix } }).
function explainOf(options) {
  if (typeof options.explain !== 'string') return {};
  const raw = readRegular(path.resolve(options.explain));
  if (!raw) throw refuse('--explain must be a regular JSON file');
  try {
    const doc = JSON.parse(raw.bytes.toString('utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc;
  } catch {
    throw refuse('--explain is { "<ref>": { "what": "<what is wrong, one line>", "fix": "<what fixing it now takes>" } }');
  }
}
// Who let each item leave, as recorded: the person's decision (and the channel they answered in) or the owner's reason.
const sourceOf = (state, id) => (id === 'owner' ? { provenance: 'owner-reason' } : { provenance: 'approved-decision', decision: id, ...((state.decisions ?? []).find((x) => x.id === id)?.approved?.via ? { via: state.decisions.find((x) => x.id === id).approved.via } : {}) });
export const decidedIds = (decided) => [...new Set(Object.values(decided).filter((v) => v !== 'owner'))];

// Each discovered issue of a placement, closed under what let it leave (with the follow-up ticket, if any).
function closeLeaving(root, state, items, decided, reason, options, ticket = null) {
  for (const x of items.filter((i) => i.kind === 'discovered')) {
    const by = decided[x.ref] === 'owner' ? 'on the owner\'s reason' : `with the person's decision ${decided[x.ref]}`;
    append(root, state.id, 'discovered.closed', { id: x.ref, outcome: 'deferred', decision: `${ticket ? `ticketed as ${ticket.id} (${ticket.url})` : 'left for later as a known issue'}, ${by}${reason ? `: ${reason}` : ''}`, source: sourceOf(state, decided[x.ref]), ...(ticket ? { ticket } : {}), attributedTo: text(options.by) || null }, actor(options));
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
  // 0.7.23 (I-177): so does the assembled batch itself, which contains this member's lines and is where a member's pinned HEAD
  // can still be repaired. Named failure (field): a member's observation the person answered "fix now" after the batch was
  // assembled had no home: the batch was never a sibling (its own `batchOf` is null), the member's commit could not be
  // recorded (the batch pins its HEAD), and the only advice was to eject it, which rebuilds the batch without its own commits.
  const intoOwnBatch = target.lane === 'batch' && !state.batchPending && state.batchOf === target.id;
  if (!intoOwnBatch && (!state.batchOf || state.batchOf !== target.batchOf)) throw refuse(`${sibling} is not in ${state.id}'s delivery batch (${state.batchOf ?? 'none'}); a moved finding would not be delivered with this change`, 'split the work first (`wf split`), or ticket the finding (`wf scope ticket`)', { id: 'scope:move-outside-batch' });
  // Security review (check-then-act): the disposition and approval checks and the append run in one evidence
  // transaction, so a concurrent `wf scope move|ticket` cannot record a second disposition between them.
  for (const ref of refs) withEvidenceTransaction(root, state.id, () => {
    const now = loadState(root, state.id);
    const f = find(now, ref);
    if (dispositionOf(now, ref)) throw refuse(`${ref} already went elsewhere`);
    // The own-line rule exists because a sibling starts from the base; the member's own batch contains the member's lines.
    if (!intoOwnBatch) movable(f);
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
// family), with the tracker's raw readback of the created issue. By default only low items leave, with the person's answer (D17, D18).
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
  const decided = leavingDecisions(root, state, items, { verb: 'ticketed', reason, options, policy: policyOf(trustedAdapter(root, state)), explain: explainOf(options) });
  if (typeof options.capture !== 'string') throw refuse(`${items.map((x) => x.ref).join(', ')} may leave as a follow-up ticket (${decidedIds(decided).join(', ') || 'your reason'}): create it in the tracker now, save its raw readback, and run this command again with \`--capture <raw.json>\``, null, { id: 'scope:ticket-capture' });
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
  if (found.length) append(root, state.id, 'scope.ticketed', { keys: found.map((f) => f.ref), choice: 'ticketed', raw: { file, sha256: hashFile(file) }, ticket: { id, url, title: issue.title, capture: file, provenance: 'agent-reported-raw-readback' }, reason: reason || null, placement: Object.fromEntries(found.map((f) => [f.ref, placementLevel(state, f)])), decisions: decidedIds(decided), decisionFor: Object.fromEntries(found.map((f) => [f.ref, decided[f.ref]])), blocked: false }, actor(options));
  closeLeaving(root, state, items, decided, reason, options, { id, url, title: issue.title, capture: file });
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

// `wf scope waive --finding R:F1[,R:F2] [--reason "..."] [--same-as A<n>] --ask <file>`: findings that block are set aside by
// the person's decision (kind waive-finding, `wf approve`), D4. Named failure (refusal audit of 0.7.0): the reserved kind
// existed and every message pointed to it, but no command created it, so a blocking finding could leave only by being fixed
// or ticketed.
// 0.7.23 (D29). The person's rules (2026-10-16): "separate findings as different questions", clear enough to understand, and
// "i don't want the same question asked multiple times". Each finding is its own question in the agent's plain words. A
// finding the person already decided is recorded under that answer and never asked again: one an escalation option they chose
// names (`settles`, listed in that option for them), or one a later review raised again about a gap they already accepted
// (`--same-as A<n>`: it must block for the same reason, the same frozen criterion or critical invariant). Named failure
// (field): after the person chose to ship without a proof, six findings from three review rounds asking for that proof were
// six more questions, each in the reviewer's own text.
// 0.7.33 (I-228, D85): `--person-said "<their words>"` records the person's explicit disposition, given before the findings that
// repeat it were raised, as their waiver of each finding named, with no question. Named failure (field): the person forbade a
// production configuration change, handed it to the client, acknowledged the ticket comment and then said to stop reporting it, it is
// closed; two later high findings and two discovered issues kept the same item open, `wf scope defer` with their words refuses a
// blocking finding, and `wf scope waive` asked the decision they had already made (or the agent had to call the data corrected). The
// engine proves the words are the person's (`personSaid`: verbatim in one of their own messages in this session, about this ticket)
// and records them with each waiver (`personSaid`), beside the finding's own severity and history, which stay as they are; that the
// words cover these findings is the agent's reading, stated in `--reason` and shown to the tester in the delivered comment. In the
// person's own terminal there is nothing to prove: they answer the question.
export async function waiveFinding(root, options, { env = process.env } = {}) {
  const opened = openState(root, options);
  let said = null;
  if (options['person-said'] !== undefined) {
    const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    said = await provenDisposition(root, opened, options, refs.map((ref) => ({ ref, kind: 'waive-finding', key: ref, yes: 'yes' })), { env, usage: 'usage: wf scope waive --finding <round:id>[,...] --person-said "<the person\'s words, exactly as they wrote them>" --reason "<how their words cover these findings>"' });
  }
  return withEvidenceTransaction(root, opened.id, () => {
    let state = loadState(root, opened.id);
    const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!refs.length) throw new WfError('usage: wf scope waive --finding <round:id>[,...] [--reason "..."] [--same-as A<n>] [--ask FILE.json]');
    const reason = text(options.reason);
    const recorded = (ref) => (state.scopeDecisions ?? []).some((d) => d.choice === 'waived' && (d.keys ?? []).includes(ref));
    // The person's yes already sets a finding aside (review-policy waivedRef); this records each waiver once.
    const yesFor = (ref) => {
      const d = decisionFor(state, 'waive-finding', ref);
      return d?.approved?.choice === 'yes' ? d : null;
    };
    for (const ref of refs.filter((r) => !recorded(r) && yesFor(r))) append(root, state.id, 'scope.waived', { keys: [ref], choice: 'waived', reason: reason || null, decision: yesFor(ref).id }, actor(options));
    const open = refs.filter((r) => !recorded(r) && !yesFor(r)).map((ref) => find(state, ref));
    const observation = open.filter((f) => !f.classified.blocks);
    if (observation.length) throw refuse(`${observation.map((f) => f.ref).join(', ')} ${observation.length > 1 ? 'do' : 'does'} not block: an observation is fixed, moved, deferred or ticketed (\`wf scope list\`)`, null, { id: 'scope:waive-observation' });
    const same = sameAsDecision(state, options['same-as']);
    if (same && !reason) throw refuse(`--same-as ${same.decision.id}: say how this is the gap the person accepted there`, 'pass `--reason "<how it is the same>"`', { id: 'scope:same-as' });
    const asked = [];
    for (const f of open) {
      // Decided by the person's answer to an escalation, or the same gap as one they already accepted: recorded under that
      // answer (`under`, not `decision`, which would spend it).
      if (said) {
        append(root, state.id, 'scope.waived', { keys: [f.ref], choice: 'waived', reason, personSaid: said }, actor(options));
        const pending = decisionFor(state, 'waive-finding', f.ref);
        if (pending && !pending.approved) append(root, state.id, 'decision.withdrawn', { id: pending.id, reason: `settled by the person's own words, "${said.quote}"` }, actor(options));
        continue;
      }
      const by = settledBy(state, f.ref);
      if (by) {
        append(root, state.id, 'scope.waived', { keys: [f.ref], choice: 'waived', reason: reason || null, under: by.id }, actor(options));
        continue;
      }
      if (same) {
        // The same criterion or invariant, and the same family on both (independent review and security review of 0.7.23: a
        // criterion names a whole behaviour, so another defect under it is not the same gap, and a finding with no family
        // says nothing about which gap it is). Anything else is its own question.
        const basis = basisOf(f);
        const match = same.findings.find((x) => basisOf(x) === basis && x.family && f.family && x.family === f.family);
        if (!basis || !match) throw refuse(`${f.ref} is not the same as what ${same.decision.id} decided: it blocks because it ${f.classified.reason}${f.family ? ` (family ${f.family})` : ''}, and ${same.decision.id} accepted ${same.findings.map((x) => `${x.ref} (it ${x.classified.reason}${x.family ? `, family ${x.family}` : ''})`).join(', ') || 'no finding'}`, 'a finding that blocks for another reason is its own question: run this again without `--same-as`', { id: 'scope:same-as' });
        append(root, state.id, 'scope.waived', { keys: [f.ref], choice: 'waived', reason: reason || null, under: same.decision.id, sameAs: match.ref }, actor(options));
        continue;
      }
      asked.push(f);
    }
    if (!asked.length) return loadState(root, state.id);
    state = loadState(root, state.id);
    const summaryOf = (f) => `waive ${f.ref} (${f.severity ?? 'unrated'}: ${f.summary ?? ''}); it blocks because it ${f.classified.reason}${reason ? `; why: ${reason}` : ''}`;
    if (asked.length === 1) {
      const [f] = asked;
      const decision = requireYes(root, state, { kind: 'waive-finding', key: f.ref, summary: summaryOf(f), what: `waiving ${f.ref}`, frame: FRAMES.waive({ item: state.item, n: 1 }), items: [f.ref], ask: itemAsk(readAsk(options), null, f.ref), options }).decision;
      append(root, state.id, 'scope.waived', { keys: [f.ref], choice: 'waived', reason: reason || null, decision }, actor(options));
      return loadState(root, state.id);
    }
    // Several findings: one question each, asked together.
    const frame = FRAMES.waive({ item: state.item, n: 1 });
    const answeredNo = asked.map((f) => ({ f, d: decisionFor(state, 'waive-finding', f.ref) })).filter(({ d }) => d?.approved && !d.spent);
    if (answeredNo.length) throw refuse(`not waived: ${answeredNo.map(({ f, d }) => `the person answered ${d.approved.words ? `in their own words, "${d.approved.words}"` : d.approved.choice} to ${f.ref} (${d.id})`).join('; ')}`, 'a finding they did not accept is fixed; to ask again after something changed, withdraw their answer with what changed (`wf decisions withdraw <id> --reason "..."`)', { id: 'scope:waive-answered' });
    const ask = readAsk(options);
    const fresh = asked.filter((f) => !decisionFor(state, 'waive-finding', f.ref));
    const problems = fresh.flatMap((f) => askProblems(itemAsk(ask, null, f.ref), { choices: ['yes', 'no'], labels: frame.labels, items: [f.ref] }).map((p) => `${f.ref}: ${p}`));
    if (problems.length) throw askFirst(`waiving ${fresh.map((f) => f.ref).join(', ')}`, frame, ['yes', 'no'], [...new Set(problems)], fresh.map(summaryOf).join(' | '), { items: fresh.map((f) => f.ref) });
    let current = state;
    const lines = [];
    for (const f of asked) {
      const words = itemAsk(ask, null, f.ref);
      const d = decisionFor(current, 'waive-finding', f.ref) ?? createDecision(root, current, { kind: 'waive-finding', key: f.ref, summary: summaryOf(f), ...composeAsk(words, frame, ['yes', 'no'], { items: [{ ref: f.ref, ...itemWords(ask, null, f.ref) }] }), options });
      current = loadState(root, state.id);
      lines.push(`  ${d.id}  header "${f.ref}"\n      question: "${questionFor(current, d)}"\n      options: ${optionLines(d)}\n      then: wf approve ${d.id} --from-question --attempt ${state.id}`);
    }
    throw refuse(`the person decides these (one question per finding; ask them together, as many questions in one panel as it allows):\n${lines.join('\n')}`, `ask exactly these questions with exactly these options, by their labels with what follows each (in the panel, ${panelNote()}); ${SHOW_TEXT}. Ask them in your messages, one question per message, quoting it exactly with its options, so the person can type each answer, or together in your question panel; a typed reply and a panel answer both count. Run its \`wf approve <id> --from-question\` after each answer (${READ_LINE}); then run this command again`, { id: 'scope:waive-ask' });
  });
}

// 0.7.32 (I-222, D71): a review finding that was never a defect closes as "not a defect", as a discovered issue does (D38): by an
// independent reviewer's `verified-nonissue`, or by the person's answer to the one question whether it is a defect at all (kind
// move-out-of-batch, key `nonissue:<ref>`, one per finding). Named failure (an audit of 0.7.31): an implementer and a reviewer
// disagreed on whether a finding's premise holds, the person was to decide, and a finding had no closure their "it is not a defect"
// could reach: `wf decide` only recorded it, and `wf scope waive` would list a defect nobody holds as accepted. Their "no" keeps it
// open: it goes back to the fix round (engine/premise.mjs `personHeld`). The finding and its claim stay in the record beside the
// reason; the delivered comment lists nothing for it.
export function closeFindingNotDefect(root, options) {
  const opened = openState(root, options);
  return withEvidenceTransaction(root, opened.id, () => {
    const state = loadState(root, opened.id);
    const refs = [...new Set(String(options.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!refs.length) throw new WfError('usage: wf scope not-a-defect --finding <round:id>[,...] --reason "<why it is not a defect>" [--person-directed "<their words>"]');
    const reason = text(options.reason);
    if (!reason) throw refuse('--reason says why it is not a defect (what the code is for, what the product intends)', 'pass `--reason "<why it is not a defect>"`; the finding stays in the record beside it. If the person told you so, add their words with `--person-directed "<their words>"`', { id: 'scope:not-a-defect-reason' });
    const directed = text(options['person-directed']).slice(0, 500) || null;
    const findings = refs.map((ref) => find(state, ref));
    const moved = findings.filter((f) => dispositionOf(state, f.ref));
    if (moved.length) throw refuse(`${moved.map((f) => `${f.ref} (${dispositionOf(state, f.ref).choice})`).join(', ')} already went somewhere: a finding that left the delivery or was recorded fixed is not closed again`, null, { id: 'scope:not-a-defect-placed' });
    const decided = {};
    const standing = [];
    for (const f of findings) {
      try {
        decided[f.ref] = requireYes(root, state, { kind: 'move-out-of-batch', key: `nonissue:${f.ref}`, summary: `close ${state.id}:${f.ref} as not a defect: ${f.summary ?? ''} (${reason})`, what: `closing ${f.ref} as not a defect`, frame: FRAMES.notDefect({ item: state.item, rated: `Rated ${f.severity ?? 'unrated'} by reviewer ${f.round}.`, directed }), items: [f.ref], options }).decision;
      } catch (error) {
        if (error.code !== 75) throw error;
        standing.push(error);
      }
    }
    if (standing.length === 1) throw standing[0];
    if (standing.length) throw refuse(standing.map((e) => e.message).join('\n'), standing.map((e) => e.hint).filter(Boolean).join('\n\n'), { id: standing[0].refusalId ?? 'approve:move-out-of-batch' });
    for (const f of findings) append(root, state.id, 'scope.notADefect', { keys: [f.ref], choice: 'not-a-defect', reason, decision: decided[f.ref], ...(directed ? { personDirected: directed } : {}) }, actor(options));
    return loadState(root, state.id);
  });
}

// What a finding blocks for: the frozen criterion or the critical invariant it names (null for anything else).
const basisOf = (f) => (f?.classified?.criterion ? `criterion ${f.classified.criterion}` : f?.classified?.invariant ? `invariant ${f.classified.invariant}` : null);

// The decision `--same-as` names: one the person answered by accepting findings (a waiver they said yes to, or an escalation
// whose chosen option settles findings), with those findings.
function sameAsDecision(state, id) {
  if (id === undefined || id === null || id === false) return null;
  const d = (state.decisions ?? []).find((x) => x.id === String(id));
  const accepted = d && !d.withdrawn ? (d.kind === 'waive-finding' && d.approved?.choice === 'yes' ? [d.key] : d.kind === 'escalation' && chose(d) ? d.settles?.[d.approved.choice] ?? [] : []) : [];
  const findings = accepted.map((ref) => findingByRef(state, ref)).filter(Boolean);
  if (!findings.length) throw refuse(`--same-as ${id}: not a decision of ${state.id} in which the person accepted a finding that blocks`, '`wf decisions --attempt <id> --all` lists them', { id: 'scope:same-as' });
  return { decision: d, findings };
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
    const decided = leavingDecisions(root, state, items, { verb: 'deferred', reason, options, policy: policyOf(trustedAdapter(root, state)), explain: explainOf(options) });
    if (found.length) append(root, state.id, 'scope.deferred', { keys: found.map((f) => f.ref), choice: 'deferred', reason: reason || null, placement: Object.fromEntries(found.map((f) => [f.ref, placementLevel(state, f)])), summaries: Object.fromEntries(found.map((f) => [f.ref, f.summary ?? ''])), decisions: decidedIds(decided), decisionFor: Object.fromEntries(found.map((f) => [f.ref, decided[f.ref]])) }, actor(options));
    closeLeaving(root, state, items, decided, reason, options);
    return loadState(root, state.id);
  });
}

// When the latest of these findings was raised (its review's record time), for the person's deliver-core scope.
function raisedAt(state, findings) {
  const at = findings.map((f) => (state.reviews ?? []).filter((r) => (r.closure?.reviewer ?? r.reviewer) === f.round).at(0)?.at).filter(Boolean).sort();
  return at.at(-1) ?? null;
}
