# Automatic review division

Every fresh full-mode reviewer handoff (the first code review of an attempt, and the evidence review) automatically selects
parallel or single review from the committed change and recorded flows. A `delta` round (the code reviews in between:
the diff since the last reviewed tree and the findings still open) is always a single
reviewer; see [review rounds](lifecycle.md#review-rounds-blocking-findings-and-observations). It keeps the existing code-review → gate → fresh evidence-review → acceptance order. Existing handoffs keep
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
across repositories. Complete flows are grouped before files are assigned: a file mentioned by several flows within
one scope remains with that reviewer. Files crossing scopes, files referenced by an unassigned flow, and unmapped
files go to integration. An area with no individually exclusive files is not discarded before grouping.
Each changed file has exactly one primary owner. Crossing flows and textual outside callers require explicit
integration evidence on both sides. These are recorded relationships, not a resolved language import graph;
integration must investigate ambiguous names, omissions and scan caps.

Automatic division retains single review below 40 changed product files, with fewer than two separable flow areas, when more
than half the files belong to integration, or when one indivisible scope would retain at least 80% of estimated review
cost. Whole areas are balanced by changed line counts, with a conservative cost for binary files. When overlap would
leave work in integration, an additional candidate groups areas by weighted overlap, retaining the eligible candidate
with the smaller integration-plus-largest-scope estimate (the original candidate wins ties). A ubiquitous helper
does not merge the entire connected graph. Shared code dominating that cost still retains single review.
The optional overlap search has deterministic limits: 1,000,000 initial pair contributions, 250,000 distinct
pairs, 500,000 lifetime queued pairs, and 1,000,000 merge-neighbor visits. Initial contributions are estimated
before constructing the pair map. Exhaustion discards the search and retains the fully evaluated balanced
candidate; it does not relax efficiency checks. Owner diagnostics identify `optimization-budget-exceeded`.
Manual divisions do not invoke this optimization.

Documentation and provenance files (0.7.4, I-96) are not product code and do not decide any of that. A changed file is
documentation when it is prose by its extension (`.md`, `.mdx`, `.rst`, `.adoc`), lies in a `docs`, `doc` or
`documentation` folder whatever it is (a manifest, a capture), or is a `LICENSE` or `NOTICE`. Such files are left out of
the 40-file count, the cost, the unmapped count and the flows; they stay with the integration reviewer, who is handed every
changed file (`integration.files`, `primaryFiles`), and the plan lists them under `documentation`. `divideReview` also
takes a `documentation(repo, file)` predicate for a caller that knows more (`documentationMatcher(adapter)`, from
`engine/impact.mjs`, builds one from the packages' `docsOnly` globs). Named failure: twelve 500-line documentation files
in a 48-file change of two separable flows, read as unmapped integration work, turned a parallel division into one reviewer.

These are initial heuristics, not measured optimal thresholds. It never falls back
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
with integration, including their dependencies that also occur in assigned flows. A proposed scope with no primary
files is refused. A manual proposal may retain an inefficient split, but prints a warning and never bypasses coverage
or interface checks. The JSON handoff result contains the division and each member's exact frozen prompt; stderr
contains owner launch instructions. The integration ID is the supplied `--agent`; scope IDs append `-S1`, `-S2`, etc.

Owner diagnostics distinguish unmapped files, dependencies of unassigned areas, and cross-scope shared files. They
retain the proposed workload and exact efficiency thresholds even when automatic selection falls back to single
review. Bounded query-origin examples distinguish flow, consumer, contract and suite queries in the JSON result.
Diagnostics never enter the blind one-line launch prompt. New divisions validate group-based ownership and every
required interface; already frozen version-one handoffs retain their recorded assignments and original checks.

## Evidence and completion

A scope records its findings for its assigned flows. Scoped closures are immutable parts, not accepted reviews: the
integration reviewer owns the criteria and the earlier rounds, so criteria or prior-finding verdicts in a part are
ignored. Parts never release the gate, reveal earlier rounds or authorize delivery. (0.7.0: the per-file
`filesReviewed` coverage list, the per-interface `interfacesReviewed` list and the `partReviews` hash citations are no
longer required; they measured compliance with a form, not defects. Given, they are kept as context.)

The foreground handle runs scopes concurrently, observes their terminal results, and launches integration only after
each has recorded a valid report. Integration independently checks shared code, crossing flows, global criteria,
discovered/historical issues, impact queries, lessons, contract seams and gate evidence. `wf review parts` provides
only completed reports of the current group; the integration reviewer reads them critically and adds what they missed.

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
