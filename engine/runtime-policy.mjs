import { refuse } from './util.mjs';

export const runtimeOfOwner = (owner) => /^(codex|claude):/.exec(String(owner ?? ''))?.[1] ?? null;

// Named failure: recovery selected Claude for a Codex-origin attempt, exposing source to an unrequested provider.
// Admission owns the default; adoption, current environment and old handoffs never silently change it.
export const originRuntime = (state) => state.originRuntime ?? runtimeOfOwner(state.owners?.[0] ?? state.owner);

export function assertRuntimeLaunch(state, handoff) {
  const origin = originRuntime(state);
  const authority = handoff.runtimeAuthority;
  const authorized = authority?.phrase === `runtime ${state.id}:${handoff.runtime}`
    && ((authority.provenance === 'host-recorded' && authority.spent)
      || authority.provenance === 'interactive-terminal (unverified)');
  if (origin && handoff.runtime !== origin && !authorized) {
    throw refuse(`handoff runtime ${handoff.runtime} differs from origin runtime ${origin}; no owner-authorized provider change was recorded`, `create a fresh ${origin} handoff; to request another provider, the owner must say \`runtime ${state.id}:${handoff.runtime}\` before a fresh explicit --runtime handoff`);
  }
}
