// Obligations follow the version an attempt was admitted under (0.7.0, D7).
//
// Named failure: one ticket lived through 32 releases, and four of them changed what its next review or handoff owed
// (new reviewer verdict classes, scope metadata on every earlier item, reviews forced to run to completion). Each
// change reached the live attempt through its next fresh handoff and reopened settled work. From 0.7.0 a release that
// adds an obligation gates it with `obligationSince(state, '<version>')`; a relaxation applies to every attempt at once.
import { semverLt } from './util.mjs';

// The engine version recorded in the attempt's admission entry, or null for an attempt whose ledger predates it.
export const admittedVersion = (state) => state?.engineVersion ?? null;

// True when the attempt was admitted at `version` or later, so an obligation introduced in `version` applies to it.
export function obligationSince(state, version) {
  const v = admittedVersion(state);
  if (!v) return false;
  return !semverLt(v, version);
}
