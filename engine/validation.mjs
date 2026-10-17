import { attemptAdapter, trustedAdapter, adapterFileAtCommit } from './config.mjs';
import { actor, openState, treeHashes } from './attempt.mjs';
import { append, listAttempts, loadState } from './ledger.mjs';
import { loadCatalog } from './secrets.mjs';
import { canonical, git, hashFile, hashValue, refuse, YAML } from './util.mjs';
import { approveHint, decisionFor, labelOf, requireYes } from './approve.mjs';
import { FRAMES } from './asking.mjs';
import fs from 'node:fs';

// Named failure: required HTTP/browser proof discovered after admission could
// only be run outside sealed evidence, or by replacing the frozen adapter.
// Additions never replace admission rules, step definitions, or their plugins.
export const validationDigest = (state) => state.validations?.length ? hashValue(state.validations) : null;
export const validationCommit = (state, id) => state.validations?.find((v) => v.steps.some((s) => s.id === id))?.commit ?? state.adapterBase;
export const validationIds = (state) => (state.validations ?? []).flatMap((v) => v.steps.map((s) => s.id));

export function validationReviewProblems(records, closure) {
  const problems = [];
  for (const record of records ?? []) for (const step of record.steps) {
    const entries = (closure.validationChecked ?? []).filter((v) => v.id === step.id);
    const v = entries[0];
    if (entries.length !== 1 || v.commit !== record.commit || !v.evidence?.trim() || !['complies', 'finding'].includes(v.verdict) || (v.verdict === 'finding' && !closure.findings?.some((f) => f.id === v.finding))) problems.push(`supplemental validation ${step.id} needs one pinned-definition review verdict in validationChecked`);
  }
  return problems;
}

export function gateAdapter(root, state) {
  const frozen = trustedAdapter(root, state);
  const steps = [...frozen.gate.steps];
  for (const record of state.validations ?? []) {
    const candidate = trustedAdapter(root, state, record.commit);
    for (const selected of record.steps) {
      const step = candidate.gate.steps.find((s) => s.id === selected.id);
      // I-138: corrections recorded by an earlier local build (before 0.7.8 required the person's decision) marked the
      // corrected step itself (`steps[].admission`) and kept the original in `from` unmarked; reviewed since, they blocked
      // every check and correction of their attempt. That exact shape counts; the engine writes it no more (a new admission
      // correction marks `from` and carries the person's decision).
      // 0.7.29 (I-204): a correction a batch carried from a member says so in its own carried record (`correctedFrom`).
      const wasAdmission = (record.carriedFrom && (record.correctedFrom ?? []).some((f) => f.id === selected.id && f.admission)) || (state.validationCorrections ?? []).some((c) => (c.from ?? []).some((f) => f.id === selected.id && f.admission) || ((c.steps ?? []).some((x) => x.id === selected.id && x.admission === true) && !(c.from ?? []).some((f) => f.admission)));
      if (!step || canonical(step) !== canonical(selected.definition)) throw refuse('supplemental validation no longer matches its recorded committed definition');
      // I-125: an admission step the person let the attempt correct runs at its corrected definition, in its place.
      const at = steps.findIndex((s) => s.id === step.id);
      // 0.7.29 (I-204): a corrected admission step runs where a registered one does, in the attempt's own gate. Named failure
      // (found reproducing I-204): a member admitted with --defer-heavy that corrected a heavy admission check deferred it, while
      // its gate required every registered or corrected check to pass, so no gate of that member could pass short of `--full`.
      if (at >= 0) {
        if (!wasAdmission) throw refuse('supplemental validation no longer matches its recorded committed definition');
        steps[at] = { ...step, deferrable: false };
      } else steps.push({ ...step, deferrable: false });
    }
  }
  return { ...frozen, gate: { ...frozen.gate, steps } };
}

// Only existing catalogued keys may acquire an explicit new step binding. Store
// locations, formats and values remain the original project's; never record values.
export function validationCatalog(root, state, id) {
  const selected = state.validations?.flatMap((v) => v.steps).find((s) => s.id === id);
  const catalog = loadCatalog(root);
  if (!selected) return catalog;
  const keys = new Set(selected.secretKeys);
  if ([...keys].some((key) => !catalog.some((e) => e.key === key))) throw refuse('supplemental validation requires an existing catalogued key that is no longer available');
  return catalog.filter((e) => keys.has(e.key)).map((e) => ({ ...e, usedBy: [id] }));
}

// 0.7.29 (I-204). Named failure (field): four accepted members, each admitted with `--defer-heavy`, were assembled into a batch.
// Their registered HTTP and browser checks (`wf validation add`) lived in the members' ledgers and adapter commits only: the
// batch was admitted on the base's adapter, `wf batch create` copied no member's registrations, and the batch's gate selected
// none of them. A gate on the combined tree could pass without the members' required proofs; only its reviewer noticed. A
// batch now carries every check a member registered or corrected, pinned where the member pinned it (its definition, its
// plugin code and the screenshots it collects), and its gate counts only once each of them passed on the combined tree.

// Each step a member registered or corrected: where it is pinned, what it is (definition and plugin code), and, for a
// correction of one of the member's own admission steps, the admission definition it replaced.
function memberSteps(root, member) {
  if (!member.validations?.length) return [];
  const admission = trustedAdapter(root, member).gate.steps;
  return member.validations.flatMap((record) => record.steps.map((step) => ({
    member: member.id, item: member.item, commit: record.commit, step, criteria: record.criteria ?? [], reason: record.reason ?? null,
    original: admission.find((s) => s.id === step.id) ?? null,
    identity: correctionIdentity(root, member, record.commit, step),
  })));
}

// Two members that pinned one step id to different definitions or plugin code: the batch can run only one of them under
// that id, so carrying either drops the other's proof. Checked before the batch exists.
export function batchValidationConflicts(root, members) {
  const first = new Map();
  const conflicts = [];
  for (const m of members) for (const x of memberSteps(root, m)) {
    const seen = first.get(x.step.id);
    if (!seen) first.set(x.step.id, x);
    else if (!x.identity || x.identity !== seen.identity) conflicts.push(`${x.step.id} (${seen.member} pinned it at ${seen.commit.slice(0, 10)}, ${x.member} at ${x.commit.slice(0, 10)}, with a different definition or plugin)`);
  }
  return conflicts;
}

// The records the batch carries, and the member checks it does not carry with why. A member's own registration is carried
// unless the batch's admission adapter (the base it was admitted on) already has a step of that id, which then runs as the
// batch admitted it. A member's correction of one of its admission steps is carried when the batch admitted that step as the
// member had it (the person approved that correction there, `approvedIn`); when the base already holds the corrected
// definition there is nothing to carry, and when the base changed it otherwise the batch runs its own.
export function carriedValidations(root, batch, members) {
  const admission = trustedAdapter(root, batch).gate.steps;
  const byId = new Map();
  const notCarried = [];
  for (const m of members) for (const x of memberSteps(root, m)) {
    const from = { attempt: x.member, item: x.item, commit: x.commit, criteria: x.criteria, reason: x.reason };
    const have = byId.get(x.step.id);
    if (have) {
      have.carriedFrom.push(from);
      continue;
    }
    const own = admission.find((s) => s.id === x.step.id);
    const record = { commit: x.commit, steps: [x.step], criteria: (batch.criteria ?? []).map((c) => c.id), reason: `carried from ${x.member}${x.reason ? `: ${x.reason}` : ''}`, carriedFrom: [from] };
    if (x.original) {
      if (own && canonical(own) === canonical(x.step.definition)) continue;
      if (!own || canonical(own) !== canonical(x.original)) {
        notCarried.push({ id: x.step.id, member: x.member, why: own ? `the batch's admission adapter defines ${x.step.id} differently from the definition ${x.member} corrected; the batch runs its own` : `the batch's admission adapter has no step ${x.step.id}` });
        continue;
      }
      const decision = (m.validationCorrections ?? []).filter((c) => (c.steps ?? []).some((s) => s.id === x.step.id)).at(-1);
      byId.set(x.step.id, { ...record, correctedFrom: [{ id: x.step.id, commit: batch.adapterBase, definition: own, admission: true }], ...(decision?.decision ? { approvedIn: { attempt: x.member, decision: decision.decision } } : decision?.approvedIn ? { approvedIn: decision.approvedIn } : {}) });
      continue;
    }
    if (own) {
      if (canonical(own) !== canonical(x.step.definition)) notCarried.push({ id: x.step.id, member: x.member, why: `the batch's admission adapter now defines ${x.step.id} itself, differently; the batch runs its own` });
      continue;
    }
    byId.set(x.step.id, record);
  }
  return { records: [...byId.values()], notCarried };
}

export const addValidation = (root, options) => registerValidation(root, options, false);

// Named failure (I-102): review found a defect in a supplemental validation's plugin, and registration had no remove,
// overwrite or repin: fixing and committing the plugin left the gate running the defective plugin pinned at registration,
// for ever. A correction re-pins steps that are already registered, at a later commit, and keeps every obligation
// registration carries (closed roles, a committed tree, a commit that descends from the admission commit and now from the
// previous pin, a recorded reason, existing catalogued secret keys, admitted repos); the ledger keeps both pins, and the
// changed digest and the later date make the gate wait for a fresh code review and run every step again.
export const correctValidation = (root, options) => registerValidation(root, options, true);

// What a corrected step is: its definition and the plugin code it runs, as committed.
function correctionIdentity(root, state, commit, step) {
  let pluginHash = null;
  try {
    pluginHash = step.definition.plugin ? hashFile(adapterFileAtCommit(root, state, commit, step.definition.plugin)) : null;
  } catch {
    return null;
  }
  return hashValue({ id: step.id, definition: step.definition, pluginHash });
}

// 0.7.27 (I-187), named failure (field): the person approved correcting two admission checks to the definitions committed at one
// commit; a base merge advanced the attempt's HEAD before the command ran again, and the question's key named that HEAD, so the
// same correction under the same definitions was asked a second time. What the person approves is the correction: the
// admission steps and the definitions (and plugin code) they are corrected to, whatever commit holds them. The key is made of
// exactly that. The reason is the agent's note in the record, not part of the question the person reads; another attempt's
// approval is taken whatever its reason (below), and so is this attempt's own. Where a plugin cannot be read the identity is
// unknown and the key names the commit, as before. A question an earlier release asked under its commit is the same question
// while the definitions at that commit are the ones asked for now (`askedUnderCommit`).
const sameIds = (list, of) => canonical([...list].sort()) === canonical([...of].sort());
const admissionIdentities = (root, state, commit, steps, admission) => steps.filter((s) => admission.includes(s.id)).map((s) => correctionIdentity(root, state, commit, s));
const admissionIdentity = (identities) => (identities.length && identities.every(Boolean) ? hashValue([...identities].sort()) : null);
const correctionKey = (admission, identity, commit) => `correct-admission:${[...admission].sort().join(',')}:${identity ? `identity-${identity}` : commit}`;
const KEY = /^correct-admission:([^:]+):(?:([0-9a-f]{7,40})|identity-([0-9a-f]{64}))$/;

// The identities of the named admission steps as committed at `commit`, or null when that commit's adapter or a step cannot be read.
function identitiesAt(root, state, commit, ids) {
  let candidate;
  try {
    candidate = trustedAdapter(root, state, commit);
  } catch {
    return null;
  }
  const have = ids.map((id) => { const definition = candidate.gate.steps.find((x) => x.id === id); return definition ? correctionIdentity(root, state, commit, { id, definition }) : null; });
  return have.every(Boolean) ? have : null;
}

// A question an earlier release asked under the commit it was asked at (`correct-admission:<ids>:<commit>`) is the question asked
// now when the definitions at that commit are the ones asked for now. Its answer holds, pending, declined or approved and not yet
// used, however far HEAD has moved since. The attempt's latest such question.
function askedUnderCommit(root, state, admission, wantAdmission) {
  for (const d of [...(state.decisions ?? [])].reverse()) {
    const m = d.kind === 'override-gate' && !d.withdrawn && !d.spent ? KEY.exec(String(d.key)) : null;
    if (!m?.[2] || !sameIds(m[1].split(','), admission)) continue;
    const have = identitiesAt(root, state, m[2], m[1].split(','));
    if (have && canonical([...have].sort()) === canonical([...wantAdmission].sort())) return d;
  }
  return null;
}

// What a question asked under the earlier key says now: asked as it is, a declined one stands, an approval is taken.
function standingAnswer(state, d) {
  if (!d.approved) throw refuse(`not done: correcting an admission check is the owner's decision (${d.id}: ${d.summary})`, approveHint(state, d), { id: 'approve:override-gate' });
  if (d.approved.choice !== 'yes') throw refuse(`not done: correcting the admission check: the person answered ${d.id} ${d.approved.words ? `in their own words, "${d.approved.words}"` : `"${labelOf(d, d.approved.choice)}"`}`, `follow their answer; it is not asked again. If something changed since they answered, withdraw it with what changed (\`wf decisions withdraw ${d.id} --attempt ${state.id} --reason "<what changed>"\`) and run this command again`, { id: 'approve:answered' });
  return d.id;
}

// The person's yes to this exact correction in another attempt of the project: the same admission steps corrected to the
// same definitions and plugin code. Named failure (audit of one project's tickets): two admission checks were corrected
// seven times across five parallel tickets, and each time the person was asked again and waited 28 to 147 minutes to
// answer the same question. The approval counts once for the project; the attempt still gets the fresh review and the gate.
// It counts only while it stands (independent review of 0.7.15): the correction is that attempt's latest of those steps (one
// the person replaced, because it was itself wrong, is not taken again), and a `no` the person gave to the same correction in
// any attempt, this one included, asks again.
function approvedElsewhere(root, state, steps, commit, ids, admission) {
  const want = steps.map((s) => correctionIdentity(root, state, commit, s));
  if (want.some((w) => !w)) return null;
  const same = (have) => have.every(Boolean) && canonical([...have].sort()) === canonical([...want].sort());
  const attempts = new Map();
  for (const id of listAttempts(root)) {
    try {
      attempts.set(id, id === state.id ? state : loadState(root, id));
    } catch {}
  }
  // A non-yes answer to the same admission correction, anywhere, asks again. The question names the admission steps only
  // (its key), so they are what is compared; one whose definitions cannot be read any more is taken as the same, and asks.
  const wantAdmission = admissionIdentities(root, state, commit, steps, admission);
  const asked = admissionIdentity(wantAdmission);
  for (const a of attempts.values()) {
    for (const d of a.decisions ?? []) {
      const m = d.kind === 'override-gate' ? KEY.exec(String(d.key)) : null;
      if (!m || !d.approved || d.approved.choice === 'yes' || !sameIds(m[1].split(','), admission)) continue;
      // Asked by this release: the key holds the identity of what was asked.
      if (m[3]) {
        if (m[3] === asked) return null;
        continue;
      }
      const have = identitiesAt(root, a, m[2], m[1].split(','));
      if (!have || canonical([...have].sort()) === canonical([...wantAdmission].sort())) return null;
    }
  }
  // An approval stands while the correction it approved is still its attempt's latest of those steps; one taken on another
  // attempt's approval stands only while that one does (independent review of 0.7.15: a chained approval outlived the
  // correction the person had since replaced).
  const stands = (attemptId, depth = 0) => {
    const other = attempts.get(attemptId);
    if (!other || depth > 10) return null;
    const latest = (other.validationCorrections ?? []).filter((c) => (c.steps ?? []).some((x) => ids.includes(x.id))).at(-1);
    if (!latest || !sameIds((latest.steps ?? []).map((x) => x.id), ids) || !same((latest.steps ?? []).map((x) => correctionIdentity(root, other, latest.commit, x)))) return null;
    const d = latest.decision ? (other.decisions ?? []).find((x) => x.id === latest.decision) : null;
    if (d?.approved?.choice === 'yes') return { attempt: other.id, decision: d.id, at: d.approved.at ?? latest.at };
    return latest.approvedIn ? stands(latest.approvedIn.attempt, depth + 1) : null;
  };
  for (const id of attempts.keys()) {
    if (id === state.id) continue;
    const approval = stands(id);
    if (approval) return approval;
  }
  return null;
}

async function registerValidation(root, options, correcting) {
  const { withReviewLock } = await import('./gate.mjs');
  const { reviewInFlight, openImplementersOf } = await import('./lifecycle.mjs');
  const initial = openState(root, options);
  const verb = correcting ? 'correcting' : 'registering';
  return withReviewLock(root, initial, () => {
    const state = loadState(root, initial.id);
    if (!state.criteria || ['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse('supplemental validation requires an open attempt with frozen criteria');
    if (reviewInFlight(state) || openImplementersOf(root, state).length) throw refuse(`finish and close active roles before ${verb} supplemental validation`);
    if (!options.reason || options.reason === true) throw refuse('supplemental validation needs --reason');
    const ids = typeof options.steps === 'string' ? options.steps.split(',').map((s) => s.trim()) : [];
    const registered = (state.validations ?? []).flatMap((v) => v.steps.map((s) => ({ id: s.id, commit: v.commit, criteria: v.criteria ?? [], secretKeys: s.secretKeys })));
    if (!ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) || new Set(ids).size !== ids.length) throw refuse('--steps must name distinct supplemental step ids');
    // I-125 (0.7.8): an admission step (frozen with the adapter at admission) may be corrected too, as the person's decision:
    // a frozen check that is itself wrong (it read a failed request as empty data) otherwise blocked the full gate for good.
    const base = trustedAdapter(root, state);
    // A step frozen at admission stays one through every correction (independent review of 0.7.8: a second correction was
    // taken for a supplemental one, skipped the person and left the gate refusing for good).
    const admission = correcting ? ids.filter((id) => base.gate.steps.some((s) => s.id === id)) : [];
    const unknown = correcting ? ids.filter((id) => !registered.some((r) => r.id === id) && !admission.includes(id)) : [];
    if (unknown.length) throw refuse(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} neither a registered supplemental validation step nor an admission step (registered: ${registered.map((r) => r.id).join(', ') || 'none'}); a new one is registered with \`wf validation add\``, undefined, { id: 'validation:correct-unregistered' });
    // A correction keeps the criteria its steps were registered for unless it names others; an admission step answers for
    // every frozen criterion.
    const criteria = typeof options.criteria === 'string' ? options.criteria.split(',').map((s) => s.trim()) : correcting ? [...new Set(ids.flatMap((id) => registered.find((r) => r.id === id)?.criteria ?? state.criteria.filter((c) => !c.dropped).map((c) => c.id)))] : [];
    if (!criteria.length || criteria.some((id) => !state.criteria.some((c) => c.id === id)) || new Set(criteria).size !== criteria.length) throw refuse('--criteria must name distinct frozen acceptance criteria');
    const frozen = gateAdapter(root, state);
    if (!correcting && ids.some((id) => frozen.gate.steps.some((s) => s.id === id))) throw refuse('supplemental validation cannot replace an existing step');
    const trees = treeHashes(state);
    if (Object.values(trees).some((t) => t.includes('+dirty'))) throw refuse('commit the product tree and validation adapter before registering validation');
    const adapter = attemptAdapter(root, state);
    const own = state.repos[adapter.repo.name];
    if (!own?.worktree) throw refuse('the admission adapter repo must belong to this attempt');
    const commit = git(own.worktree, ['rev-parse', 'HEAD']);
    if (git(own.worktree, ['merge-base', state.adapterBase, commit]) !== state.adapterBase) throw refuse('supplemental adapter must descend from the admission commit');
    const pinOf = (id) => registered.find((r) => r.id === id)?.commit ?? state.adapterBase;
    if (correcting) for (const pin of new Set(ids.map(pinOf))) {
      if (pin === commit) throw refuse(`the adapter repo is still at ${pin.slice(0, 10)}, where ${ids.filter((id) => pinOf(id) === pin).join(', ')} is already pinned: commit the corrected definition or plugin first`, undefined, { id: 'validation:correct-unchanged' });
      if (git(own.worktree, ['merge-base', pin, commit], { allowFail: true }) !== pin) throw refuse(`the corrected definition must descend from the commit it is pinned at (${pin.slice(0, 10)}); a correction moves a pin forward, never sideways or back`, undefined, { id: 'validation:correct-not-descendant' });
    }
    const candidate = trustedAdapter(root, state, commit);
    let catalog = [];
    const catalogText = git(own.worktree, ['show', `${commit}:${adapter.relative}/secrets.yaml`], { allowFail: true });
    if (catalogText) { const raw = YAML.parse(catalogText); catalog = raw?.keys ?? raw; if (!Array.isArray(catalog)) throw refuse('committed secret catalog must be a list'); }
    const existing = loadCatalog(root);
    const steps = ids.map((id) => {
      const step = candidate.gate.steps.find((s) => s.id === id);
      if (!step) throw refuse(`supplemental step ${id} is not committed in the attempt adapter`);
      const repo = frozen.repos.find((r) => r.name === step.repo);
      if (!repo || !state.repos[step.repo] || (step.package && !repo.packages.some((p) => p.path === step.package || p.name === step.package))) throw refuse(`supplemental step ${id} must use an admitted repo and package`);
      if ((step.alsoInputs ?? []).some((r) => !state.repos[r] || !frozen.repos.some((x) => x.name === r))) throw refuse(`supplemental step ${id} reads a repo outside the attempt`);
      if (step.plugin) fs.readFileSync(adapterFileAtCommit(root, state, commit, step.plugin));
      const secretKeys = catalog.filter((e) => e.usedBy?.includes(id)).map((e) => e.key);
      if (secretKeys.some((key) => !existing.some((e) => e.key === key))) throw refuse('supplemental steps may bind only existing catalogued keys');
      return { id, definition: step, secretKeys };
    });
    if (correcting) {
      // Changing a check frozen at admission is the person's decision (kind override-gate); the original stays in the ledger.
      const earlier = admission.length ? approvedElsewhere(root, state, steps, commit, ids, admission) : null;
      let decision = null;
      if (!earlier && admission.length) {
        const wantAdmission = admissionIdentities(root, state, commit, steps, admission);
        const key = correctionKey(admission, admissionIdentity(wantAdmission), commit);
        // 0.7.27 (I-187): the key holds what is asked, not the commit that holds it; a question an earlier release asked under its
        // commit is this one while the definitions are the same (the current key's own answer, if any, is read first).
        const before = key.includes(':identity-') && !decisionFor(state, 'override-gate', key) ? askedUnderCommit(root, state, admission, wantAdmission) : null;
        decision = before ? standingAnswer(state, before) : requireYes(root, state, { kind: 'override-gate', key, summary: `correct the admission check ${admission.join(', ')} to its definition committed at ${commit.slice(0, 10)}: ${String(options.reason)} (the original stays in the record; a fresh review and the full gate follow)`, what: `correcting the admission check ${admission.join(', ')}`, frame: FRAMES.correctCheck({ item: state.item }), options }).decision;
      }
      // Both pins stay in the ledger: what the step was, and what it is now.
      const current = (id) => state.validations.flatMap((v) => v.steps).find((s) => s.id === id)?.definition;
      const from = ids.map((id) => (admission.includes(id) ? { id, commit: pinOf(id), definition: current(id) ?? base.gate.steps.find((s) => s.id === id), admission: true } : { id, commit: pinOf(id), definition: current(id) }));
      append(root, state.id, 'validation.corrected', { commit, steps, criteria, reason: String(options.reason), tree: trees, from, ...(decision ? { decision } : {}), ...(earlier ? { approvedIn: earlier } : {}) }, actor(options));
    } else append(root, state.id, 'validation.added', { commit, steps, criteria, reason: String(options.reason), tree: trees }, actor(options));
    return loadState(root, state.id);
  });
}
