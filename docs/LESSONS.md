# Lessons: a learning path for a project

When something was not done right, or did not go as the user wanted, the project should learn so it does not happen
again. The content of a lesson is the project's; the plugin provides the harness: capture, apply, feedback,
visibility. Nothing here edits the adapter or any instruction file on its own: a lesson becomes enforced through a
normal, owner-approved commit.

## Named failures this is built from

Generic wording of what went wrong on real tickets:

| What happened | Cause class | Mechanism that now prevents it |
| --- | --- | --- |
| Screenshots were attached to the ticket but not visible in it | tooling | engine-change (the delivered comment embeds each image; the readback checks it) |
| UI tables did not use the shared design-system components and no reviewer caught it | design-system | designSystem-rule (forbid/requireWith over added lines) |
| A data value that differed between two captures of the same state was dismissed as cosmetic | review | reviewer-checklist (anomalies need a cause or a follow-up) |
| A hand-built tracker readback was accepted | tooling | engine-change (raw shape, comment equality) |
| The reviewer judged screenshots before the gate had produced them | process | engine-change (evidence pass after a passing gate) |
| A shared helper change broke another spec | test | gate-check or planner-criterion-template (dependents named in the plan) |
| A behaviour was kept because an earlier merge and its tests chose it, and an invariant about a different subject was cited | review | reviewer-checklist (shipped lesson P-1: precedent check, invariant scope check, `precedent-only` findings, `rationale` on kept criteria) |

## What the engine already has, reused

- `wf reopen --reason "<feedback>"`: the user's correction, verbatim, in the new attempt's ledger. It is the strongest
  trigger: a reopen without a lesson (or an explicit, ledgered "no lesson because ...") does not close.
- Review findings: a finding may carry a `category` (`process`, `tooling`, `criteria`, `review`, `test`,
  `design-system`); one of those prompts the owner to record a lesson.
- `wf shown` anomalies with a `followUp`: prompt a lesson.
- Criteria amendments (`wf criteria amend --reason`): history of what the plan missed; a lesson can point at one.
- `review.rules`, `designSystem` rules, role appendices (`roles.<role>.appendix`), gate steps: the mechanisms a lesson
  is enforced through. A lesson names one; `wf lesson apply` prints the snippet to add.
- Handoff bundles: relevant lessons are injected (planner, implementer, reviewer) as project rules, ordered by
  recurrence and capped; the reviewer gives each a verdict, like a review rule. They are project rules, not other
  agents' findings, so blind review is unchanged.
- The ledger (hash-chained, anchored): records which lessons were recorded, waived, injected, and judged per attempt.

## The lesson file

`.workflow/lessons/<id>.yaml` in the adapter repo, committed like the rest of the adapter:

```yaml
id: L-3
title: Data tables use the shared table and pagination components
trigger:
  what: A report page rendered a raw table without pagination; the review did not catch it.
  attempt: ENG-12.2          # where it was observed
  finding: F2                # optional
  quote: "why isn't this using our table?"   # the owner's words, verbatim, when they came from the owner
cause: design-system         # process | tooling | criteria | review | test | design-system | other
mechanism:
  kind: designSystem-rule    # review-rule | designSystem-rule | planner-criterion-template | reviewer-checklist | gate-check | engine-change | doc
  ref: table-has-pagination  # the rule id, step id or document that enforces it (required when enforced)
scope: project               # project | plugin (a plugin lesson is exported as a generic issue for the plugin)
status: proposed             # proposed | enforced | retired
tags: [ui, tables]
paths: ["web/**/*.tsx"]      # relevance: changed files matching these; none = every change
recurrence: 0                # times the mechanism failed and it happened again
created: 2026-01-01T00:00:00Z
```

## Flows

- **Capture**: `wf lesson add --file l.yaml` (or `--title --cause --mechanism --tags --paths --what --quote`) writes
  the file and records `lesson.recorded` in the attempt's ledger. A new lesson whose mechanism kind matches an existing
  one and shares a tag is a recurrence: the existing lesson's `recurrence` goes up, `wf status` says "lesson L-3
  recurred: its mechanism failed", and at 2 or more `wf lesson review` proposes promoting it to a gate check.
- **Close**: a reopened attempt's delivery is not closed until a lesson is recorded for it or the owner says why not
  (`--no-lesson "<reason>"` on `wf reopen` or `wf deliver`, or `wf lesson waive --reason`), all ledgered.
- **Apply**: `wf lesson apply L-3` prints the exact adapter snippet or template text for its mechanism; the owner
  commits it and sets `status: enforced` with `mechanism.ref`.
- **Inject**: handoff bundles carry `lessons: { apply: [...], more: n }`; the reviewer's closure needs
  `lessons: [{ lesson, verdict: complied|not-applicable|finding, evidence, finding }]` for each; a `finding` verdict
  counts as a recurrence when the review is accepted.
- **Review**: `wf lesson review` lists recurring lessons (promote), proposed lessons without a mechanism (apply), and
  lessons injected into none of the last N attempts (retire).
- **Plugin lessons**: `wf lesson export --plugin` prints scope-plugin lessons as generic issue text, with project names,
  repo names, ticket ids, paths, emails, URLs and the project's forbidden patterns stripped. It never posts anything.

## Deliberately left out

- No automatic edits of the adapter, instruction files or templates, and no auto-filed issues.
- No similarity scoring beyond tags and mechanism kind; no embedding or free-text matching.
- No per-lesson metrics beyond the recurrence counter and the injection history the ledgers already hold.
- Lessons are read from the main checkout's adapter folder (not the attempt's base commit), so a lesson added today
  applies to open attempts at their next handoff. Lessons only add requirements; nothing in a ticket's worktree can
  remove one.
