# Telemetry and learning

[Back to the README](../README.md) · [Docs map](../README.md#docs)

Every closed ticket writes one row. Learning changes the workflow only through proposals judged against those rows, and a hard budget stops the plugin from growing a rule after each incident (D98).

## The ledger

Each attempt's ledger is `.wf-evidence/attempts/<id>/ledger.jsonl`: one event per line, hash-chained, written only through the engine. Schema 2 events: `attempt.started` (with the stage snapshot), `criteria.set` (with its hash), `test.run`, `screens.captured`, `handoff`, `review.recorded` (with coverage), `finding.filed`, `decision.asked`, `decision.answered`, `hold`, `release`, `base.updated`, `stage`, `landing`, `attempt.closed`. Schema 1 (0.7) ledgers stay readable.

## The per-ticket row

`wf close` writes the row to `~/.agentic-workflow/telemetry/<project>.jsonl` (schema `wf-ticket@1`). Each row can be rebuilt from the ledgers, git and the host transcripts.

| Field | Definition |
|---|---|
| `wallMin`, `activeMin` | From start to close. Active time is the union of gaps of 30 minutes or less between activity (ledger events and transcript turns). |
| `unexplainedGaps[]` | Gaps over 30 minutes with no event and no pending decision. |
| `personWaitMin`, `holdMin`, `stageWaitMin{}` | Time waiting on the person's decisions, time under hold, and time per stage. |
| `reviews`, `blockingReviews`, `emptyReviews`, `fixRounds`, `coverage` | `fixRounds` is counted per item. |
| `testRuns.{fast,full}`, `testMin`, `landing.{batches,bisects}` | Test runs and the landing queue. |
| `diff.{product,tests,other}` | Classed by the adapter's `kinds`. |
| `findings.{goal,regression,other,filed,digested}`, `introducedByRepair` | Findings by class, and those blamed to a fix round. |
| `refusals.{count,byId}`, `screens`, `riskTouched` | |
| `rework.{lines,share,commits}` | Filled 48 hours after delivery: lines the delivery wrote that a later commit not belonging to this ticket rewrote. |
| `tokens`, `cost` | From the host transcripts. |

0.7 ledgers map onto the same row (the first terminal event is the end; batch members roll up into their tickets), so 0.7 and 0.8 compare on the same fields.

`wf report` shows medians per project and per engine version, and lists commits on the base that no attempt covers.

## Proposals

Every change of shape needs a measured proposal, whatever its source. A proposal has:

- `source`: `telemetry`, `incident` or `person`;
- `scope`: `project` or `plugin`;
- `change`, and `replaces` (required: what it takes the place of);
- `metric` and `guard`: row fields;
- `expires` and `status`.

The rules:

- **Drafting.** `wf learn` drafts a proposal only when a metric leaves its baseline band: the median ± spread over the project's last 8 tickets. An incident becomes a proposal once it recurs. A rule the person gives becomes a proposal with `source: person`; it skips drafting but still needs a metric, what it replaces and an expiry.
- **Minimum move.** The engine sets it from the baseline spread.
- **Concurrency.** One active proposal per metric per project, and one plugin proposal per release.
- **Judging.** After 8 tickets or 21 days, whichever comes later: kept if the metric moved by the minimum and the guard held, reverted otherwise. Missing data means revert. A kept proposal expires after 90 days and is judged again; a reverted one cannot be proposed again for 60 days.
- **Applying.** Project proposals are applied and reverted automatically, and change only what roles read (D19). Nothing is committed into product repos. Plugin proposals go to the maintainer.

## The budget

A change is rule-shaped when it adds a refusal id, a command, an adapter key, an event type, or words in a text agents read (role texts, skills, the session rules, the risk checklist). `budget.json` in the plugin holds the counts; `scripts/release.mjs` counts the release commit against `budget.json` on main, and a net increase fails the release unless a kept or active plugin proposal committed under `proposals/` accounts for it. A replacement (one refusal for another) is rule-shaped but no increase. Each role text also stays under its word limit.

A project's adapter has its own budget (`budget.adapter`: rules, risk areas, modules, operation words); `wf doctor` reports it, and a net increase needs a project proposal.
