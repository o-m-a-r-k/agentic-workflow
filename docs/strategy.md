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
| `reach` | a fix round's or a planned pass's own commits (first-parent, no merges, from its handoff to its close) changed a contract file (one the components' `provides` or `dependsOn` contracts name) or a migration (never a documentation or test file, nor a migrations folder's index) that nothing it was handed accounts for: no handed item is located on it, no stated fix names it (by its path, or a migration's folder), a component's own spec follows only a covered change to its contract, and, in a round handed no non-blocking item without a stated fix, the attempt's own earlier commits had not already changed it. A round that only builds planned work for the first time is not counted; one that also fixes findings or items is judged by those. A work item handed again after a review whose context or own text names an open finding or discovered issue is judged as handed it (`fixes.named`). Implementers open at once in one repo are named together, once. The line names what was handed and which handed items no reviewer stated a fix for (unbounded). A work item handed again after an amendment that restated it after its last build closed is planned work for the files the amendment explains: a contract file named by the endpoints or error codes its `scope` states (the spec its own component provides, or a file whose own name, not its folders, shares two distinctive words with a name; counts alone explain every contract file), named in its words, or found in its repo by the queries of an impact-addendum change for the item; a migration named by path or folder, or planned by such a change. A criterion reworded under `impact: { unchanged }` explains nothing. Rounds open at once in one repo share what explains a file. Measured on one project's ledgers, counting only handoffs whose implementer closed with its heads: 1 of 229 rounds handed after a first review (the named failure itself, a true positive), against 9 for the first form of the signal; of the 67 work items handed again with words naming an open item, none fires. 51 more rounds never closed and cannot be measured from the main checkouts |

While one stands that no strategist decision answered, a next step that hands an implementer or a new code-review round
is the strategist's handoff (`wf resume` and `wf advance` say `strategy`, with the signals and no "continue" offered beside
them; its bundle carries them as `courseSignals`, with the `outstanding` items for a pass). A gate, an evidence review, a
verification a reviewer owes, the acceptance and delivery are not held, with one exception: the gate after a planned pass or after an
evidence review's fixes, which no code review precedes, waits for the strategist on `reach` (nothing else looks at what that work
reached before a gate is spent on it). Until 0.7.34 nothing was refused: a handoff made past it printed a
note; since 0.7.34 four of them hold the next implementer and code-review round (below). A decision answers the signals it saw (`course` on the recorded decision), and its action drives the next step:
`consolidate` (one planned pass for all remaining work, with an expectation), `split`, or `continue` with a new `expect`,
which is what the course is compared with from then on. It applies to every attempt in flight; `roles.strategist: false` or
`strategy.enabled: false` turns it off with the round count.

### Signals that hold the next round (0.7.34, I-234)

Named failure (field): between the round count at 10 and the person's hold at 20, one attempt ran eleven handed rounds with no
strategist decision, while each wording fix caused the next finding (four in a row) and base drift opened rounds of their own.
Those rounds ran before 0.7.28 was released, so no course signal existed; replayed with today's signals, `rounds` stood
unanswered from the sixth round until the first strategist decision, and `regression` fired before rounds 15 and 17. Under
0.7.28 to 0.7.33 both would only have named the strategist as the next step, and the owner could hand the next round anyway.

Four signals now hold the next implementer and code-review round until a strategist decision answers them, as the round count
does (`strategy:course`); an evidence review of a gated tree, a gate, the acceptance and delivery go on:

| Signal | Why it is a fact, not a threshold |
| --- | --- |
| `rounds` | rounds handed past the latest expectation an agent stated (the plan's, a re-plan's, a strategist's `continue`): the agent's own number, never the engine's. Answered by a decision recorded after the round that passed it (one an earlier engine recorded too) or by the person's own direction given after it (their answer to a round question, a hold they lifted) |
| `regression` | the latest round's findings sit on lines the fix round before it wrote (`git blame`) |
| `recurring` | a finding a reviewer linked (`sameCauseAs`) to one already marked fixed, or one found open again after being verified fixed. A label match only (`familyRecurrences`) does not hold |
| `reraised` | a finding raised by a round handed after a strategist decision, with the family and criterion (or invariant) of a finding that decision's diagnosis cited, and no `sameCauseAs`: by the strategist's own grouping, the cause it accounted for came back and no reviewer said so |

Size does not hold anything (`files`, `amended`: a large ticket going well crosses those lines too, the D9 failure), nor an
implementer's estimate or re-plan request (the owner answers those with an amendment), nor `reach` (it already holds the gate after
a planned pass). `roles.strategist: false` or `strategy.enabled: false` turns the hold off with the round count. It applies to every
attempt being worked: like the round count it replaces the owner's judgement with one strategist decision and reopens nothing.

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

## The diagnosis and the correction (0.7.34, I-232)

Named failure (field): 23 review rounds. Five evidence reviews in a row asked again for screen-recording proof the local simulator
cannot make, each under fresh finding ids; then each wording fix caused the next finding, under four family labels; then base
merges and toolchain drift opened rounds of their own. The two strategist decisions carried an action, a rationale and a
prediction; the second said "no recurring causes are recorded" and that the base would be taken in once, and it was merged twice
more. The person: "the strategist should also look at what went wrong and correct course so we don't go into infinite loop".

What this adds makes the decision at each count accountable; on its own it stops nothing. What breaks a loop is the round count's
cadence, the signals that hold the next round (above) and the roles following the corrections.

A strategist handed from 0.7.34 (its handoff records `owes: ["diagnosis"]`) adds to its closure:

- `diagnosis`: one entry per cause of what kept going wrong (an empty list when nothing did): `cause` (one of `capability`,
  `assumption`, `regression`, `one-at-a-time`, `base`, `tooling`, `scope`, `review`, `other`; the bundle's `closureSchema.causes`
  gives each in plain words), `what` in plain words, the review rounds it cost (`rounds`, by reviewer id) and what shows it
  (`refs`: findings `<round>:<id>`, `D<n>`, `S<n>`, `A<n>`, `base:<n>`, `gate:<runId>`), and either `correction: { lever, change }`
  (`lever`: `person`, `one-pass`, `root-cause`, `review-scope`, `base-timing`, `repair-tooling`, `routing`, `replan`, `split`,
  `model`, `other`; `change` in plain words: what the owner and the roles do differently) or `settledBy` (the earlier decision or
  the person's answer that already deals with it). The lever is the change to how the work runs, apart from the action (the next
  step): in the field the same action carried different changes, and the refusal below compares the change.
- `progressed`: the rounds since the previous decision that did what they were handed.
- `review`: for each correction still open, `outcome` (`held`, `failed`, `not-applied`, `too-early`, `dropped`), `refs`, `why`,
  and for a correction a workflow rule kept from being carried out, `improvement: "I-<n>"` (an item of the inbox).

The bundle carries what it cites: `history` (every review round with its status and kind, every finding as `findingHistory` shows it,
every event), `roundsToAccount`, `roundsInFlight`, `openCorrections`, `corrections` and `causeOverlaps`.

`wf strategy record` checks facts only (`strategy:diagnosis`): every cited round and ref exists (an unknown one is named with the
nearest known one); every round recorded or died since the previous decision (since admission for the first) is in an entry's
`rounds` or in `progressed`, any member of a divided review covering it, and rounds still in flight are outside it; a round in
`progressed` neither died nor named scope it did not reach; every open correction is reviewed; `held` and `failed` cite something
dated after the correction; `failed` comes with an entry for that cause (another lever, `settledBy`) or an escalation; `not-applied`
and `dropped` say why; what `settledBy` settled is dated before it and nothing cited is after it; a correction reported `held` or
`too-early` while the diagnosis cites its cause after it is a contradiction. Given by a strategist that does not owe them, these
keys are checked and recorded all the same; coverage and the review are asked only when owed.

A correction is open until a later decision reports it `held`, `failed` or `dropped`, or makes a new correction for the same cause
(then it is `superseded`): one correction per cause is in force. `wf resume`, `wf status` and `wf signals` show each in force in plain
words, how many decisions found it too early to tell, when corrections for that cause were reported not carried out twice or more in
a row, and each outcome once reported. Implementers and reviewers are handed the corrections in force (`courseCorrections`) and say
when one cannot be followed. Rounds or refs two decisions put under different causes are shown (`causeOverlaps`), never refused.

**The same course again** (`strategy:same-course`, a design guard with no field case yet: the field's decisions carried no correction
to compare). Refused when the closure corrects a cause with the same lever as an earlier correction of that cause that came back
(reported `failed`, or the diagnosis cites the cause after it), unless the action is `escalate`. The lever `other` never counts as
the same, and a correction reported `not-applied` was never tried, so the same change may be proposed again.

Out of scope: corrections do not cross a `split` (a sibling starts with none), and a strategist's grouping does not feed the
reviewers' cause groups (`causeGroups`).

A prediction names a signal, a comparison and a number, and a round or time by which it should hold. It is the strategist's
own: two missed predictions in a row make its next decision an escalation (`predictions.escalateRequired` in the bundle;
`wf strategy record` refuses anything else, and an escalation starts the count again). A strategist the owner agent handed
and that has not decided is waited for (`wf resume` says `strategy`); no handoff is refused for it.

## What stops the engine

Four things, none of them a number the engine picked:

- the round count (below), the one number left, adapter-configurable (`strategy: { reviewRoundsEscalate }`): at it the strategist decides first (0.7.33, D84);
- a strategist's escalation awaiting the person's `wf approve` (when the owner withdraws it with `wf decisions withdraw`, it holds the handoffs until a strategist's decision is recorded, which supersedes it (the next implementer or reviewer handoff asks the question again only when no strategist handed after the withdrawal is still to decide); `wf resume` names both, and the waiting strategist beside the person's round question when that is due too (with none handed since, that one is to be handed and to decide before the next handoff, or the withdrawn question is asked again as it was; the handoff that asks it again names the way out), and a question answered in the person's own words is followed or withdrawn first);
- the strategist's own rule above;
- a course signal that holds the next round (rounds past an agent's own prediction, a regression of the last fix, a confirmed
  recurring cause, a finding re-raised that a strategist's diagnosis accounted for) until a strategist decides (0.7.34, I-234).

Everything else the engine checks is a fact: the tree, evidence, reviewer independence, the gate, approvals and the combined-tree
check. `strategy: { enabled: false }` or `roles: { strategist: false }` turns the round count off for a project. Both
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

## The round count

At the project's round count (`strategy.reviewRoundsEscalate`, 10 by default) of handed review rounds (recorded or not: a round whose reviewer died still cost a round) no implementer or reviewer starts
until the course is settled again. Named failure: one ticket ran 47 review rounds before anyone stepped back, and an automatic stop
at round 3 was too early. The person's first rule was "make it 10 and then raise it to me"; since 0.7.33 (I-229, D84) their rule is
that the strategist decides first. Named failure (field): the round question at 20 was withdrawn when the person held the attempt to
rethink it; they lifted the hold with a direction, the strategist decided to consolidate, and two minutes later the engine asked the
same round question again, recommending what the person had said ("why is the strategist not reviewing this first").

So at the count the owner agent hands the strategist with the count as the reason (its bundle says `roundCount`) and records its
decision. Any decision settles the count, which comes back as many handed rounds after it; the person is asked only when the
strategist escalates, and two of its predictions missed in a row still force that: a decision recorded at the count predicts by the
next count at the latest (`prediction.by` no later than the rounds recorded plus the count, `strategy:prediction-past-count`), so
two counts in a row that do not hold reach the person (review of 0.7.33, H3: a design guard, no field case yet). The person's own
stop at the count settles it as well: a hold they placed after the count was reached and lifted (`wf release`, confirmed by them),
or their answer to the round question an earlier release asked for that count (or answered after it was reached). A product
decision (`wf decide`) answers a product question, not the course, and settles nothing; nor does a question the agent withdrew. `wf resume`, the refusal of the
next handoff (`strategy:round-count`) and `wf signals` (`settledBy`) say which applies. A round question an earlier release asked
and the person has not answered stays theirs (its choices are on it: `continue`, `split`, `deliver-core`, `hold`, `stop`); a
strategist's decision settles it too, and it is then withdrawn with that reason.

The count comes back as many rounds after what settled it, whatever that chose: it is due at the handed round count at which it
was settled plus 10, never at the next multiple of 10 (0.7.29, I-214). Named failure (field): the person answered
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
