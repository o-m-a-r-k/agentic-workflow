// The planning panel (0.7.22, D28): two planners (or more) write their plans blind, one merges them into a single plan
// that names every point they differ on and what it chose, and the others agree or object point by point until they
// agree; then that plan is frozen as any plan is. Each step is a planner handoff and a recorded output, so the panel works
// the same on every harness and every step is in the evidence.
//
// Named failure: a weak plan is the most expensive thing the workflow measures (one ticket made 138 amendments; another
// ran 3 re-plans and 20 review rounds against an expected 1). The person's request (2026-10-16): "two agents do the
// planning; they discuss the plan between each other and come up with one solid plan".
import { roleClass } from './config.mjs';
import { findHost } from './hosts/index.mjs';
import { obligationSince } from './versions.mjs';

// The planner seats, as work classes (the class pins each seat's model and effort per runtime). A project names them with
// `roles.planner.panel: [<class>, ...]`; one class is a single planner. By default the planner role's class leads, and the
// host names the second seat's class (one harness seats `review`, another model) or repeats the lead's.
export function plannerPanel(cfg, runtime) {
  const set = cfg.roles?.planner?.panel;
  if (Array.isArray(set) && set.length) return set.map(String);
  const lead = roleClass(cfg, 'planner');
  const second = findHost(runtime)?.panelSecond;
  return [lead, second && cfg.classes?.[second] ? second : lead];
}

// Every class any harness's panel uses, for the role files `wf sync` writes.
export function panelClasses(cfg, runtimes) {
  return [...new Set(runtimes.flatMap((r) => plannerPanel(cfg, r)))];
}

// The planner's class for one attempt: the adapter's, or the engine default of the release the attempt was admitted under
// (D7: before 0.7.22 the planner ran at `review`).
export const plannerClassFor = (cfg, state) => (cfg.roles?.planner?.class ?? (obligationSince(state, '0.7.22') ? roleClass(cfg, 'planner') : 'review'));

// The panel applies to attempts admitted from 0.7.22 (D7: a live attempt keeps the planning it started with).
// Only in a lane that plans with a planner (independent review of 0.7.22: a quick fix that handed a planner was put on a
// panel its lane does not have).
export const panelActive = (cfg, state, runtime) => cfg.roles?.planner !== false && (cfg.roles?.planner?.lanes ?? ['standard']).includes(state.lane) && obligationSince(state, '0.7.22') && plannerPanel(cfg, runtime).length > 1;

// Where the panel of the plan being written stands, from the ledger. A plan replaced whole (an attempt upgraded to
// implementation) starts a new panel: `gen` counts the plans frozen.
export function panelStage(state, seats) {
  const gen = (state.plansFrozen ?? 0) + 1;
  const ev = (state.panel ?? []).filter((e) => e.gen === gen);
  const handed = (state.handoffs ?? []).filter((h) => h.role === 'planner' && h.panel?.gen === gen);
  const drafts = {};
  for (const e of ev.filter((x) => x.type === 'draft')) drafts[e.seat] = e;
  const draftHanded = {};
  for (const h of handed.filter((x) => x.panel.stage === 'draft')) draftHanded[h.panel.seat] = h;
  const merges = ev.filter((x) => x.type === 'merged');
  const lastMerge = merges.at(-1) ?? null;
  // A merged plan the engine refused at the freeze (its queries no longer match, an obligation it misses) counts as an
  // objection to that merge: the panel goes back to the merge with the engine's reason (independent review of 0.7.22: a
  // refusal there had no way back).
  const verdicts = lastMerge ? ev.filter((x) => ['agreed', 'objected', 'merge-refused'].includes(x.type) && x.round === lastMerge.round) : [];
  const base = { gen, seats, drafts, draftHanded, lastMerge, verdicts };
  const missing = [];
  for (let seat = 1; seat <= seats; seat++) if (!drafts[seat]) missing.push(seat);
  if (missing.length) return { ...base, stage: 'draft', missing, round: 0 };
  if (!lastMerge) return { ...base, stage: 'merge', seat: 1, round: 1 };
  const objected = verdicts.filter((v) => v.type === 'objected' || v.type === 'merge-refused');
  if (objected.length) return { ...base, stage: 'merge', seat: 1, round: lastMerge.round + 1, objections: objected };
  for (let seat = 2; seat <= seats; seat++) if (!verdicts.some((v) => v.seat === seat)) return { ...base, stage: 'confirm', seat, round: lastMerge.round };
  return { ...base, stage: 'agreed', round: lastMerge.round };
}

// What each stage asks of the planner, as a goal (the planner template says how its output is recorded).
export const STAGE_GOAL = {
  draft: 'Write your own complete plan for this change, as a single planner would. Another planner writes one at the same time, blind; neither sees the other until the merge.',
  merge: 'Write the one plan this change is built from, from the drafts (and, after a round of objections, from the objections). Take the stronger reasoning on each point whichever draft it came from, and list every point the drafts or the objections differ on that changes what is built or how it is proven, with what you chose and why, in `disagreements`.',
  confirm: 'Read the merged plan and its disagreements against your own draft. Agree when the plan is right; object only to points that would make it wrong or weaker than your draft, each with why. A preference is not an objection.',
};
