import { attemptAdapter, trustedAdapter, adapterFileAtCommit } from './config.mjs';
import { actor, openState, treeHashes } from './attempt.mjs';
import { append, loadState } from './ledger.mjs';
import { loadCatalog } from './secrets.mjs';
import { canonical, git, hashValue, refuse, YAML } from './util.mjs';
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
      if (!step || canonical(step) !== canonical(selected.definition) || steps.some((s) => s.id === step.id)) throw refuse('supplemental validation no longer matches its recorded committed definition');
      steps.push({ ...step, deferrable: false });
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

export async function addValidation(root, options) {
  const { withReviewLock } = await import('./gate.mjs');
  const { reviewInFlight, openImplementersOf } = await import('./lifecycle.mjs');
  const initial = openState(root, options);
  return withReviewLock(root, initial, () => {
    const state = loadState(root, initial.id);
    if (!state.criteria || ['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse('supplemental validation requires an open attempt with frozen criteria');
    if (reviewInFlight(state) || openImplementersOf(root, state).length) throw refuse('finish and close active roles before registering supplemental validation');
    if (!options.reason || options.reason === true) throw refuse('supplemental validation needs --reason');
    const ids = typeof options.steps === 'string' ? options.steps.split(',').map((s) => s.trim()) : [];
    const criteria = typeof options.criteria === 'string' ? options.criteria.split(',').map((s) => s.trim()) : [];
    if (!ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) || new Set(ids).size !== ids.length) throw refuse('--steps must name distinct supplemental step ids');
    if (!criteria.length || criteria.some((id) => !state.criteria.some((c) => c.id === id)) || new Set(criteria).size !== criteria.length) throw refuse('--criteria must name distinct frozen acceptance criteria');
    const frozen = gateAdapter(root, state);
    if (ids.some((id) => frozen.gate.steps.some((s) => s.id === id))) throw refuse('supplemental validation cannot replace an existing step');
    const trees = treeHashes(state);
    if (Object.values(trees).some((t) => t.includes('+dirty'))) throw refuse('commit the product tree and validation adapter before registering validation');
    const adapter = attemptAdapter(root, state);
    const own = state.repos[adapter.repo.name];
    if (!own?.worktree) throw refuse('the admission adapter repo must belong to this attempt');
    const commit = git(own.worktree, ['rev-parse', 'HEAD']);
    if (git(own.worktree, ['merge-base', state.adapterBase, commit]) !== state.adapterBase) throw refuse('supplemental adapter must descend from the admission commit');
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
    append(root, state.id, 'validation.added', { commit, steps, criteria, reason: String(options.reason), tree: trees }, actor(options));
    return loadState(root, state.id);
  });
}
