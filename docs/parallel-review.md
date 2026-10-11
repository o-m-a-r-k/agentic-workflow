# Automatic review division

Every fresh reviewer handoff automatically selects parallel or single review from the committed change and recorded
flows. It keeps the existing code-review → gate → fresh evidence-review → acceptance order. Existing handoffs keep
their recorded assignments; installing an update or advancing them never changes an active round.

```sh
wf handoff reviewer --agent review-1 --attempt ENG-1.1
wf handoff run --agent review-1 --attempt ENG-1.1
# Or let the owning foreground runner create and run fresh groups:
wf advance --until-owner --attempt ENG-1.1
# Explicitly keep one reviewer for fresh rounds:
wf handoff reviewer --agent review-2 --single --attempt ENG-1.1
wf advance --until-owner --single --attempt ENG-1.1
```

When parallel review is selected, the default is two scoped reviewers plus integration. `--reviewers 3` permits
three scoped reviewers without any activation flag. The existing `--parallel` flag remains a compatibility alias
for automatic selection; it does not force a split that fails the flow checks. `--single` cannot be combined with
`--parallel`, `--reviewers` or `--division`, and affects only fresh handoffs. All reviewers use
the same frozen reviewer class, provider, model, effort, rules and skills. The group has one committed source
snapshot and one frozen obligation snapshot. No author summaries or earlier-round findings enter its blind inputs.

## Division

The engine derives flow ownership from the planner's recorded end-to-end flows and current committed query results.
Repeated actions using the same flow query, and areas with identical changed-file sets, are coalesced before division.
Impact flows include consumer, contract and suite queries, so their producers, consumers and tests stay together
across repositories. A file mentioned by several flows goes to integration. Unmapped files also go to integration.
Each changed file has exactly one primary owner. Crossing flows and textual outside callers require explicit
integration evidence on both sides. These are recorded relationships, not a resolved language import graph;
integration must investigate ambiguous names, omissions and scan caps.

Automatic division retains single review below 40 changed files, with fewer than two separable flow areas, when more
than half the files belong to integration, or when one indivisible scope would retain at least 80% of estimated review
cost. Whole areas are balanced by changed line counts, with a conservative cost for binary files; shared code dominating
that cost also retains single review. These are initial heuristics, not measured optimal thresholds. It never falls back
to arbitrary directory, repository, equal-size or
implementer-work splits when flow information is insufficient.

A proposed `--division file.json` may group recorded atomic flow IDs:

```json
{ "slices": [
  { "flowIds": ["change:feature-one:0"] },
  { "flowIds": ["change:feature-two:0"] }
] }
```

It cannot assign a flow twice, invent a flow, omit source files or remove crossing checks. Unassigned flows remain
with integration. The JSON handoff result contains the division and each member's exact frozen prompt; stderr
contains owner launch instructions. The integration ID is the supplied `--agent`; scope IDs append `-S1`, `-S2`, etc.

## Evidence and completion

Scopes record `filesReviewed` with direct source/test evidence for every owned file, applicable rule verdicts, and
their owned outside-plan and design-system verdicts. Scoped closures are immutable parts, not accepted reviews.
They never release the gate, reveal earlier rounds or authorize delivery.

The foreground handle runs scopes concurrently, observes their terminal results, and launches integration only after
each has recorded a valid report. Integration independently checks shared code, crossing flows, global criteria,
discovered/historical issues, impact queries, lessons, contract seams and gate evidence. `wf review parts` provides
only completed reports of the current group. Integration cites every exact report hash and its independent
verification evidence in `partReviews`, and every crossing interface in `interfacesReviewed`.

The engine unions all scoped findings and file/design verdicts, namespaces finding IDs by scope, and checks the
combined closure against the original full obligations. Integration cannot discard or vote away scoped findings.
Open findings block the normal gate and acceptance. The usual blind-then-reveal prior-finding protocol applies to
the combined round. Source or obligation changes invalidate the group; superseded groups cannot launch or record.

The current impact catalog includes the latest recorded value of every entry ID. Full impact history remains
immutable and hash-referenced for historical investigation. Catalog compaction does not waive any query, sample,
caller, discovery, criterion, rule, screenshot or seam obligation.

Failed or unknown launches stop advancement without retries. Completed reports stay in evidence for diagnosis.
Never duplicate a pending execution or treat a live PID or silence as a completed review. Recovery retains the
original handle or creates fresh authorized handoffs after diagnosis; the engine does not promise a background daemon.

## Evaluation

Compare optimized single review with two and three scopes plus integration on the same historical committed changes,
using fresh reviewers and validated defects, including cross-flow permission, financial, lifecycle and contract bugs.
Measure completion time (median and tail), failed runs, token cost, false positives, critical misses and coverage gaps.
Scenario tests prove concurrency and enforcement; they do not establish model defect recall or real-world speedup.
Use those measurements to tune the thresholds and scope count; use `--single` when a controlled single-review
comparison is needed. Automatic selection is the default, but real model speed and defect recall remain unbenchmarked.
