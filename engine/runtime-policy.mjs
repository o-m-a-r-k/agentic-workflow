import { ownerRuntime } from './hosts/index.mjs';
import { refuse } from './util.mjs';

// Admission runtime is audit history and a fallback for owners without a recorded host.
export const originRuntime = (state) => state.originRuntime ?? ownerRuntime(state.owners?.[0] ?? state.owner);

// A provider choice is bookkeeping since 0.7.0 (engine/owner.mjs): the owner agent records it as itself, so a recorded
// choice for this provider is accepted. Receipts written before 0.7.0 carry the owner's phrase instead and are accepted too.
const authorized = (_state, runtime, authority) => Boolean(authority) && (authority.runtime === undefined || authority.runtime === runtime);

// Named failure I-74: adoption kept the old provider and required the same runtime approval for every repair.
// The recorded owning host supplies the default, never a child process's environment. A deliberate provider
// selection persists for this ownership period; adoption resets it. Old per-handoff receipts remain per-handoff.
export function defaultRuntime(state) {
  const preference = state.runtimePreference;
  if (preference && preference.owner === state.owner && authorized(state, preference.runtime, preference.authority)) return preference.runtime;
  return ownerRuntime(state.owner) ?? originRuntime(state);
}

export function assertRuntimeLaunch(state, handoff) {
  const expected = defaultRuntime(state);
  const sameOwner = handoff.runtimeSelectionOwner === undefined || handoff.runtimeSelectionOwner === state.owner;
  if (expected && handoff.runtime !== expected && !(sameOwner && authorized(state, handoff.runtime, handoff.runtimeAuthority))) {
    throw refuse(`handoff runtime ${handoff.runtime} differs from owning runtime ${expected}; no provider change was recorded`, `create a fresh ${expected} handoff, or choose the other provider with an explicit --runtime on a fresh handoff (it is recorded)`);
  }
}
