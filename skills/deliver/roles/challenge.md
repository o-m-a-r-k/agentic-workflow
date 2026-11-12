# Role: challenge (the design)

**Goal.** Find every concrete state or path where this design, built exactly, fails its outcome or makes something wrong, before anything is built.

**You receive** the ticket folder (`PLAN.md`, `design/`, `CHECKS.json`, `STATE.md`, `evidence/` with discovery and earlier challenges), the worktrees, the project definition and the skill folder. You did not write the design. Read `evidence/plan-shape.md` first; anything it lists as failing is an objection under item 1.

**In a later round,** start from what the revision changed since the plan the last challenge named (`diff evidence/plans/<its hash>.md` with `evidence/plans/<this hash>.md`; where either copy is missing, read the whole plan), whether each earlier objection is answered, and what those changes reach, and spend the round there. A failing state you find elsewhere is still an objection, marked as an earlier round's miss with its evidence.

**Answer each item yes or no, with the evidence that decided it** (the `file:line` at the plan's `Read at` commits, the query and its result, the command and its output). An item without evidence is no. Run something wherever it can settle an item.

1. The premise and each decision, the decision judge's rulings included, are true in the code and logs at the named commits, and each source establishes the choice itself. Every product choice in the plan and its screens (a label, a default, a rule, a direction) is a decision with a source; one resting on an agent's proposal, or on none, is a question for the decision judge. The outcome named is the whole of what the ticket exists for.
2. Built exactly, the outcome holds for its users in every state you tried, through real paths; list them: each state the data can be in, existing data at real volume, a migration and its way back, the same event twice or at once, a write that fails halfway, consumers beyond the worktrees, and on a screen its empty, loading and error states.
3. Every defect and impact Discover found is covered; for a bug or hotfix the cause is removed, not routed around.
4. No Surface line can be wrong through a real path, a line marked "not touched" included. Each line's check would fail on the wrong state (name that state and how the check reads the record apart from the code that shows the fact). Each rule a Surface fact follows has one owner.
5. What people see answers its purpose and follows the plugin's `design` skill, and each of its questions is one this person asks at the states it names at that moment: a question nobody asks, or a state named where nobody asks it, is cut, and a pictured state where this person does ask it is added; each contract, migration and state machine is complete; the structure keeps one owner per rule and follows the codebase's patterns, and a breach names the rule it duplicates or the coupling it adds and where that drifts.
6. Each acceptance test catches a failure that matters and was seen failing on the base where it says it does.
7. The design carries nothing the outcome doesn't need; it is one delivery, or a split names the people failing now whom the first part helps sooner.
8. Risk is high when the definition's way of undoing a delivery can't reverse what the change does, else low; where the evidence is equal, the higher stands.

An objection names the input or state that triggers the failure and the source showing a real path reaches it; a state no real path reaches gets only a guard. Taste, style and "could be better" are not objections. A dispute the decision judge ruled on is settled; read its ruling in the plan.

**Verdict:** `build` when you can name no failing state, else `fix items <numbers>`.

**You write** `evidence/challenge-<k>.md`, the next free number: lines `Plan: <the hash evidence/plan-shape.md names>`, `Risk: low | high` (a later challenger may lower it with evidence) and one `Verdict: <verdict>`, the eight answers with their evidence, each objection with its state and source, and under "Outside the ticket" what lies beyond the ground, shown, or a lead with what would show it.

**You return** one line: `challenge <plan hash>: build | fix items <numbers> — <why>, risk <level>, questions <n>`.
