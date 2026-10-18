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
    review round 3 (rev-3): took 18 min; it expected 25 min; scope: ...; did not reach: ...
    reviewer rev-4 is working: 12 min since handed, it expects 20 min; last activity 2 min ago; scope: ...
    strategist S1 (delta-review) predicted blockingLatest <= 2 by round 5: pending
```

`wf signals` adds the numbers behind it: review rounds handed and recorded, the recorded ones with the blocking findings each raised
(`blocking`, and `blockingLatest` for the latest) and, of the findings of the rounds up to it, how many block and are open now (`open`: today's waivers and dispositions apply, so it is not what stood open when that round was recorded), their observation counts, families and the scope the reviewer said it did not reach (`notReached`: the round is
not counted as the full audit, I-69),
rounds since the new blocking findings last decreased, the blocking findings open now (`blockingOpen`, every round's, with how many an earlier round raised: `blockingCarried`; a round that raises nothing new has cleared nothing an earlier round raised, I-185), criteria at freeze and now, amendments, the causes that came back after a fix (`recurringCauses`: a finding still open that a reviewer linked, with `sameCauseAs`, to one already marked fixed; `familyRecurrences`: one with only the family of a finding already marked fixed, a label match to check), the files the plan's anchors name,
the latest reviewer bundle size, each working role's last transcript activity, open observations and the strategist's
predictions that held or missed. Which harness runs the agents is an execution detail: no signal reads a harness's usage
or budget.

## The owner agent judges

At each round boundary (a review round recorded, an implementer closed, before a repair round) the owner agent reads the
comparison and analyzes it: what explains the difference, and is the approach converging? Signs it is not: blocking
findings that did not go down, a diff that widens with every fix, consumers found one at a time, a role far past its own
estimate with no recent activity. When the course diverged and it cannot explain why, it changes the approach: it hands the
strategist, or re-plans (`wf criteria amend`, with a new `expect`), and records why (the handoff's `--reason`, the
amendment's `--reason`). The owner skill says this in goal terms.

## Course signals: the strategist as the next step (0.7.28, D44)

Seven signals are not the owner's to judge away (six from 0.7.28, `reach` from 0.7.31, D64). Named failure: in a three-ticket batch (47 review rounds against 11 planned)
the owner wrote "converging, not calling the strategist" six times and handed no strategist while files ran two to four
times the plan and the criteria were amended upward four times. `engine/course.mjs` names them:

| Signal | When |
| --- | --- |
| `files` | files changed are more than twice the latest expectation that states files (the plan's, a re-plan's or a strategist's) |
| `rounds` | review rounds handed are past the latest expectation that states rounds (counted from a re-plan's or a strategist's when that is the latest) |
| `amended` | an amendment added criteria after implementation started (not the one that carries out a strategist's `consolidate` or the re-plan an implementer asked for) |
| `recurring` | a cause came back after a fix (a reviewer's `sameCauseAs`, or the family of a finding already marked fixed) |
| `regression` | the latest round's findings sit on lines the fix round before it wrote (`git blame`) |
| `divergence`, `replan` | an implementer expects more than twice the fix the reviewers stated for what it was handed (`fix: { what, minutes }` on each finding), by more than the plan's minutes per review round, or its report asks for a re-plan |
| `reach` | a fix round's or a planned pass's own commits (first-parent, no merges, from its handoff to its close) changed a contract file (one the components' `provides` or `dependsOn` contracts name) or a migration (never a documentation or test file) that nothing it was handed accounts for: no handed item is located on it, no stated fix names it, a component's own spec follows only a covered change to its contract, and, in a round handed no non-blocking item without a stated fix, the attempt's own earlier commits had not already changed it. A round that builds planned work for the first time is not counted. Implementers open at once in one repo are named together, once. The line names what was handed and which handed items no reviewer stated a fix for (unbounded). Measured on one project's ledgers: 1 of 279 rounds handed after a first review (the named failure itself), against 9 for the first form of the signal |

While one stands that no strategist decision answered, a next step that hands an implementer or a new code-review round
is the strategist's handoff (`wf resume` and `wf advance` say `strategy`, with the signals and no "continue" offered beside
them; its bundle carries them as `courseSignals`, with the `outstanding` items for a pass). A gate, an evidence review, a
verification a reviewer owes, the acceptance and delivery are not held, with one exception: the gate after a planned pass or after an
evidence review's fixes, which no code review precedes, waits for the strategist on `reach` (nothing else looks at what that work
reached before a gate is spent on it). Nothing is refused: a handoff made past it prints a
note. A decision answers the signals it saw (`course` on the recorded decision), and its action drives the next step:
`consolidate` (one planned pass for all remaining work, with an expectation), `split`, or `continue` with a new `expect`,
which is what the course is compared with from then on. It applies to every attempt in flight; `roles.strategist: false` or
`strategy.enabled: false` turns it off with the round escalation.

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
| continue | recorded; with `expect`, the course is compared with it from then on (0.7.28) |
| consolidate | recorded: one amendment that restates all remaining work as one planned pass with an expectation follows (0.7.28) |
| cluster | recorded: findings are fixed by family, one mechanical proof each |
| delta-review | the next reviewer round is a delta round |
| split | `wf split` for the items (below) |
| ticket | the listed observations and discovered issues are owed as follow-up tickets (`toTicket`); only low items may be queued, and filing each is the person's decision (medium and high are fixed in the delivery; a finding that blocks never leaves) |
| model | `model: { role, class }`: the next handoffs of that role run at that work class of the adapter, with the models and effort it pins |
| escalate | a reserved decision the person answers: a plain `question`, 2-3 `options` each `{ label, then }` (plain words and what follows), and a `recommend` when there is one (0.7.11; attempts admitted earlier may keep 2-3 short option tokens) |

A prediction names a signal, a comparison and a number, and a round or time by which it should hold. It is the strategist's
own: two missed predictions in a row make its next decision an escalation (`predictions.escalateRequired` in the bundle;
`wf strategy record` refuses anything else, and an escalation starts the count again). A strategist the owner agent handed
and that has not decided is waited for (`wf resume` says `strategy`); no handoff is refused for it.

## What stops the engine

Three things, none of them a number the engine picked:

- the person's own round escalation (below), the one number left, adapter-configurable (`strategy: { reviewRoundsEscalate }`);
- a strategist's escalation awaiting the person's `wf approve` (when the owner withdraws it with `wf decisions withdraw`, it holds the handoffs until a strategist's decision is recorded, which supersedes it (the next implementer or reviewer handoff asks the question again only when no strategist handed after the withdrawal is still to decide); `wf resume` names both, and the waiting strategist beside the person's round question when that is due too (with none handed since, that one is to be handed and to decide before the next handoff, or the withdrawn question is asked again as it was; the handoff that asks it again names the way out), and a question answered in the person's own words is followed or withdrawn first);
- the strategist's own rule above.

Everything else the engine checks is a fact: the tree, evidence, reviewer independence, the gate, approvals and the combined-tree
check. `strategy: { enabled: false }` or `roles: { strategist: false }` turns the round escalation off for a project. Both
stops are the person's own and apply to every implementation attempt still being worked, whichever release admitted it (D34);
the obligations a release adds to a handoff apply only to attempts admitted from it (D7).

## Split

`wf split --items <ids> --reason "..."` moves work items, criteria, observations (`reviewer:F1`) or discovered issues
into a sibling attempt of the same item, joined with the parent in one batch (`BATCH-<parent>`). The parent's own
delivery is refused; once every member is accepted, `wf batch create --members <parent>,<siblings>` assembles the
batch, which is gated, reviewed, accepted and delivered as one. A split asks nobody, because what moved is still
delivered with the parent; ejecting a member of a split batch needs the person's `wf approve`. A split moves obligations,
not code: a work item that already has an implementer cannot move, and a finding on a line the attempt changed stays
in this attempt (a sibling starts from the base and has no such line; fix it here).

## The owner's escalation

The round escalation is answered by the person, not the strategist. At 10 handed review rounds (recorded or not: a round
whose reviewer died still cost a round) the next implementer or reviewer handoff opens a reserved decision (`wf approve <id>`, kind escalation). Named failure: one ticket ran 47 review
rounds before anyone stepped back, and an automatic stop at round 3 was too early. The owner agent brings the person the
brief from `wf signals`: rounds, blocking findings per round, the families that keep coming back, changed files against what
the plan expected, amendments, with 2-3 options and a recommendation. Choices: `continue` (another 10 rounds before asking
again), `split` (unstarted work items, observations and discovered issues move to a sibling attempt; code already built
stays), `deliver-core` (what the criteria need and what blocks stays; every other finding or discovered issue recorded before the
answer may be ticketed under this one decision, never one raised after it), `hold` ("It needs a product or legal answer first:
hold": the attempt is held in those words until the person lifts it; 0.7.28, after an escalation whose answer was a product
question stayed open 390 minutes overnight with no option for it), `stop` (the attempt is held in the person's words). Batch attempts count too.

The next question comes as many rounds after the person's answer, whatever they chose: it is due at the handed round count
at which they answered plus 10, never at the next multiple of 10 (0.7.29, I-214). Named failure (field): the person answered
"Keep going as now" at 17 handed rounds, on an attempt an earlier release had let run past 10 unasked, and at 20 the next
implementer handoff asked the same question again, three rounds later. The count at which they answered is read from the
ledger (the rounds handed by the time of the answer), so an attempt in flight replays the same way. A round question already
asked and not yet answered stays the one question, whatever round an earlier release keyed it to; one an earlier release
opened before it was due again is withdrawn by the engine, with the reason, as soon as any command opens the attempt (`wf
status`, `wf resume`, `wf decisions`, a handoff), so nothing lists it or tells the agent to ask it. It is judged again inside
the ledger's transaction, so two commands at once withdraw it once, and nothing is withdrawn while the adapter cannot be read
(the defaults would judge a project that asks at another count, and a question due there would be asked again). `wf signals` shows when the question is next due and the answer it counts from. The other
"comes back" rules already count from the answer: a course signal on review rounds counts from the latest expectation (a
re-plan's, or the strategist's `continue` with a new `expect`), and the two-missed-predictions rule counts only the
strategist's decisions after its last escalation, which cannot be recorded before the person answers it.
