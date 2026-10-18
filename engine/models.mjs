// Named failure I-44: doctor inspected live models while an adopted attempt launched with its admission settings.
// A handoff keeps the execution settings it was made with. Since 0.7.30 (I-151, D60) the attempt follows its base branch's
// adapter by itself (engine/adapter-follow.mjs), models included; `wf models refresh` takes the base tip's execution settings
// alone, for a tip the attempt has not followed yet (one it could not take, or one not fetched when it last read the attempt).
import { actor, baseRef, openState } from './attempt.mjs';
import { adapterPin, attemptAdapter, declared, roleClass, trustedAdapter } from './config.mjs';
import { append, loadState } from './ledger.mjs';
import { git, refuse } from './util.mjs';

export function executionSettings(root, state, role, cls, runtime, commit = state.runtimeAdapterBase ?? adapterPin(state)) {
  const source = trustedAdapter(root, state, commit);
  // A strategist's model decision names a work class for the role's next handoffs (0.7.0); the class still pins the models.
  const chosen = state.strategy?.classFor?.[role];
  // A planner's handoff already resolved its class (a strategist's choice for a single planner, or a panel seat's class).
  const sourceClass = role === 'planner' ? cls : chosen && source.classes?.[chosen] ? chosen : role === 'implementer' ? cls : roleClass(source, role);
  return { ...declared(source, sourceClass, runtime), sourceClass, runtimeAdapterBase: commit };
}

export function rejectModelOverrides(options) {
  for (const field of ['model', 'effort', 'class', 'runtime-adapter', 'commit']) {
    if (options[field] !== undefined) throw refuse('arbitrary execution overrides are refused; commit role model/effort settings on the adapter base, then run `wf models refresh --attempt <id>`');
  }
}

export function refreshModels(root, options) {
  rejectModelOverrides(options);
  const state = openState(root, options);
  if (['done', 'abandoned'].includes(state.phase)) throw refuse('closed attempts cannot refresh execution settings');
  if (state.activeHold) throw refuse('this attempt is on hold: ' + state.activeHold.reason);
  const { repo: location, dir } = attemptAdapter(root, state);
  const repo = trustedAdapter(root, state).repos.find((r) => r.name === location.name);
  if (!repo) throw refuse('the admission adapter does not name its own repo');
  const ref = baseRef(dir, repo);
  const tip = git(dir, ['rev-parse', ref]);
  if (git(dir, ['merge-base', state.adapterBase, tip]) !== state.adapterBase) throw refuse('execution settings must come from a descendant of the admission adapter on its base branch');
  trustedAdapter(root, state, tip);
  if (tip === (state.runtimeAdapterBase ?? adapterPin(state))) return { state, from: tip, to: tip, changed: false };
  // Bookkeeping since 0.7.0 (engine/owner.mjs): the settings come from the committed adapter base, the caller is the actor.
  append(root, state.id, 'models.refreshed', { from: state.runtimeAdapterBase ?? adapterPin(state), to: tip, ref }, actor(options));
  return { state: loadState(root, state.id), from: state.runtimeAdapterBase ?? adapterPin(state), to: tip, changed: true };
}
