import { refuse } from './util.mjs';

export const runtimeOfOwner = (owner) => /^(codex|claude):/.exec(String(owner ?? ''))?.[1] ?? null;

// Admission runtime is audit history and a fallback for owners without a recorded host.
export const originRuntime = (state) => state.originRuntime ?? runtimeOfOwner(state.owners?.[0] ?? state.owner);

const authorized = (state, runtime, authority) => authority?.phrase === `runtime ${state.id}:${runtime}`
  && ((authority.provenance === 'host-recorded' && authority.spent)
    || authority.provenance === 'interactive-terminal (unverified)');

// Named failure: adoption kept the old provider and required the same runtime approval for every repair.
// The recorded owning host supplies the default, never a child process's environment. A deliberate provider
// selection persists for this ownership period; adoption resets it. Old per-handoff receipts remain per-handoff.
export function defaultRuntime(state) {
  const preference = state.runtimePreference;
  if (preference && preference.owner === state.owner && authorized(state, preference.runtime, preference.authority)) return preference.runtime;
  return runtimeOfOwner(state.owner) ?? originRuntime(state);
}

export function assertRuntimeLaunch(state, handoff) {
  const expected = defaultRuntime(state);
  const sameOwner = handoff.runtimeSelectionOwner === undefined || handoff.runtimeSelectionOwner === state.owner;
  if (expected && handoff.runtime !== expected && !(sameOwner && authorized(state, handoff.runtime, handoff.runtimeAuthority))) {
    throw refuse(`handoff runtime ${handoff.runtime} differs from owning runtime ${expected}; no owner-authorized provider change was recorded`, `create a fresh ${expected} handoff; to request another provider, the owner must say \`runtime ${state.id}:${handoff.runtime}\` once before a fresh explicit --runtime handoff`);
  }
}
