# Strategy: predictions, signals, the strategist and split

[Back to the README](../README.md) · [Docs map](../README.md#docs)

A ticket should converge: each review round leaves fewer blocking findings, and the files, rounds and minutes stay near
what the plan predicted, or the owner agent can say why they do not. Before 0.7.0 no role owned the question "is this still
converging, and what do we change if not". Agents proposed splitting a runaway ticket three times and nothing could act on it; one attempt ran 47
review rounds over seven days. Since 0.7.0 agents predict what they will do, the engine shows each prediction beside what
happened, the owner agent judges the course, and a strategist decides when the owner hands it one.

The engine judges no work against a number it picked. An earlier 0.7.0 design did: tripwires on amendments, changed files,
reviewer bundle size, wall minutes and a quiet role refused every handoff until a strategist decided, so a large ticket
that was going well hit the same line as one that was not. They are gone with the reviewer's effort budget (decision D9 in
the [register](DESIGN.md#decision-register)).

## Predictions

Each role states what it expects, in the place it already writes to. The engine reads the statements and shows them;
nothing is refused for being wrong.

| Who | Where | What |
| --- | --- | --- |
| The planner | `plan.expect` in the plan | `{ files, rounds, minutes }`: how many files the change will touch, how many review rounds and minutes to delivery |
| A re-plan | `expect` in a `wf criteria amend` file | the same, replacing the plan's from then on (the plan's stays in the history; the file may carry only `expect`) |
| An implementer | its report file (`implementerReportFile`), written early and completed at the end | `approach` and `expect: { minutes }` |
| A reviewer | its closure file (`reviewClosureFile`), written early and completed at the end | `scope` and `expect: { minutes }` |
| The strategist | its closure | `prediction: { signal, by }` (below) |

The engine reads the shape (positive numbers, known keys) of what a role states. A plan (and a re-plan) whose `expect` it
cannot compare is refused, and so is a plan that states none, because the comparison would then be inert; an implementer's
or a reviewer's `expect` it cannot read is dropped and shown as stating nothing, never a reason to refuse a report or a
round. A role that states nothing is shown as stating nothing. An implementer's report and a reviewer's closure are read
while the role works, so the comparison is there before the work ends; the planner's `expect` is not put in the
implementer's or the reviewer's bundle (a prediction, not a target). A role that cannot state one for itself (the planner,
the strategist) is given the owner's own at launch: `wf handoff run --minutes N`.

## The comparison

`wf resume`, `wf status` and `wf signals --attempt <id> [--json]` (schema `agentic-workflow/signals@1`) show plan against
actual, with no threshold:

```
  course (expected against actual; no limit applies, the owner agent judges it at each round boundary):
    files changed: 14; the plan expected 6
    review rounds recorded: 3; the plan expected 3
    minutes since admission: 74; the plan expected 60
    implementer impl-1 (W1) done: took 38 min; it expected 25 min; approach: ...
    review round 3 (rev-3): took 18 min; it expected 25 min; scope: ...
    reviewer rev-4 is working: 12 min since handed, it expects 20 min; last activity 2 min ago; scope: ...
    strategist S1 (delta-review) predicted blockingLatest <= 2 by round 5: pending
```

`wf signals` adds the numbers behind it: review rounds handed and recorded, the recorded ones with their blocking and observation counts and families,
rounds since blocking findings last decreased, criteria at freeze and now, amendments, the files the plan's anchors name,
the latest reviewer bundle size, each working role's last transcript activity, open observations and the strategist's
predictions that held or missed. Which harness runs the agents is an execution detail: no signal reads a harness's usage
or budget.

## The owner agent judges

At each round boundary (a review round recorded, an implementer closed, before a repair round) the owner agent reads the
comparison and analyzes it: what explains the difference, and is the approach converging? Signs it is not: blocking
findings that did not go down, a diff that widens with every fix, consumers found one at a time, a role far past its own
estimate with no recent activity. When the course diverged and it cannot explain why, it changes the approach: it hands the
strategist, or re-plans (`wf criteria amend`, with a new `expect`), and records why (the handoff's `--reason`, the
amendment's `--reason`). The owner skill says this in goal terms; the engine takes no part in the judgement.

## The strategist

`wf handoff strategist --agent <new id> [--reason "<what diverged>"]` hands the `wf-strategist` role a bundle whenever the
owner agent judges the course needs one. Its text says it was handed because the course diverged from what was predicted,
and `handedBecause` carries what the owner saw. The bundle holds that reason, the comparison (`course`), the signals,
criteria, work items, the plan's files and expectations, blocking findings and observations grouped by `family`, open
discovered issues and earlier decisions with whether their predictions held. Any agent that did not implement the attempt may
be the strategist (`roles.strategist` sets its class, runtime and appendix). It writes one closure and records it with
`wf strategy record --closure <file>`:

```json
{ "strategist": "<its agent id>", "action": "delta-review", "rationale": "...",
  "prediction": { "signal": "blockingLatest <= 2", "by": 5 } }
```

`by` is a review round later than the ones recorded so far, or an ISO time still ahead. Beyond these keys a closure carries
what its action needs: `items` (ticket, required: observation and discovered ids; cluster: families), `split`
(`{ items, reason }`, required by action split), `model` (`{ role, class }`, required by action model) and `options` (2 or
3 short choices, required by action escalate); keys the engine does not read, or that belong to another action, are
ignored.

| Action | Effect |
| --- | --- |
| continue | recorded |
| consolidate | recorded: one amendment for the whole dependency map follows |
| cluster | recorded: findings are fixed by family, one mechanical proof each |
| delta-review | the next reviewer round is a delta round |
| split | `wf split` for the items (below) |
| ticket | the listed observations and discovered issues are owed as follow-up tickets (`toTicket`); filing each follows the person's severity rule (high only with `wf approve`, medium with a reason, low freely), and a finding that blocks leaves only with `wf approve` whatever its severity |
| model | `model: { role, class }`: the next handoffs of that role run at that work class of the adapter, with the models and effort it pins |
| escalate | a reserved decision with 2-3 options the person confirms with `wf approve` |

A prediction names a signal, a comparison and a number, and a round or time by which it should hold. It is the strategist's
own: two missed predictions in a row make its next decision an escalation (`predictions.escalateRequired` in the bundle;
`wf strategy record` refuses anything else, and an escalation starts the count again). A strategist the owner agent handed
and that has not decided is waited for (`wf resume` says `strategy`); no handoff is refused for it.

## What stops the engine

Three things, none of them a number the engine picked:

- the person's own round escalation (below), the one number left, adapter-configurable (`strategy: { reviewRoundsEscalate }`);
- a strategist's escalation awaiting the person's `wf approve`;
- the strategist's own rule above.

Everything else the engine checks is a fact: the tree, evidence, reviewer independence, the gate, approvals and the combined-tree
check. `strategy: { enabled: false }` or `roles: { strategist: false }` turns the round escalation off for a project. The
escalation applies to attempts admitted at 0.7.0 or later.

## Split

`wf split --items <ids> --reason "..."` moves work items, criteria, observations (`reviewer:F1`) or discovered issues
into a sibling attempt of the same item, joined with the parent in one batch (`BATCH-<parent>`). The parent's own
delivery is refused; once every member is accepted, `wf batch create --members <parent>,<siblings>` assembles the
batch, which is gated, reviewed, accepted and delivered as one. A split asks nobody, because what moved is still
delivered with the parent; ejecting a member of a split batch needs the person's `wf approve`. A split moves obligations,
not code: a work item that already has an implementer cannot move, and a finding on a line the attempt changed stays
in this attempt (a sibling starts from the base and has no such line; fix it here, or ticket it by the severity rule).

## The owner's escalation

The round escalation is answered by the person, not the strategist. At 10 handed review rounds (recorded or not: a round
whose reviewer died still cost a round) the next implementer or reviewer handoff opens a reserved decision (`wf approve <id>`, kind escalation). Named failure: one ticket ran 47 review
rounds before anyone stepped back, and an automatic stop at round 3 was too early. The owner agent brings the person the
brief from `wf signals`: rounds, blocking findings per round, the families that keep coming back, changed files against what
the plan expected, amendments, with 2-3 options and a recommendation. Choices: `continue` (another 10 rounds before asking
again), `split` (unstarted work items, observations and discovered issues move to a sibling attempt; code already built
stays), `deliver-core` (what the criteria need and what blocks stays; every other finding or discovered issue recorded before the
answer may be ticketed under this one decision, never one raised after it), `stop` (the attempt is held in the person's words). Batch attempts count too.
