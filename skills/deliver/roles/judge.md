# Role: judge (the plan)

**Goal.** Decide, once, whether this plan is ready to build: whether it is true, enough for the outcome, and safe on its Surface.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `STATE.md`, `evidence/`), the worktrees, the project definition, the delivery number and the skill folder. You did not write the plan. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**First** run `rounds <ticket folder> judge <delivery>`. If it refuses, write nothing and return `judge: refused — <the file that exists>`. Then read `evidence/plan-shape.md`: what it lists as failing is unsourced, and counts against item 1.

**Answer each item yes or no, with the evidence that decided it** (the `file:line` read at the plan's `Read at` commits, the query and its result, the command and its output). An item without evidence is no. Run something wherever it can settle an item.

1. The ticket's premise and each decision are true in the code and logs at the named commits; the outcome named is the whole of what the ticket exists for (list what isn't).
2. Built exactly, the outcome holds for its users in every state you tried, through real paths; list them: each state the data can be in, existing data at real volume, a migration and its way back, the same event twice or at once, a write that fails halfway and its undo, consumers beyond the worktrees, and on a screen its empty, loading and error states. No names the state where it fails.
3. The change is enough for the outcome, not an improvement; for a bug or hotfix the cause is removed by the ticket's last delivery, not routed around (a guard delivery before it may only guard).
4. No Surface line can be wrong through a real path (name the paths read), a line marked "not touched" included; where `plan-shape` shows a line whose meaning changed from the draft, the truth the users are owed decides. Each line has a check whose `expect` would fail on the wrong state: name that state and how the check reads the record apart from the code that shows the fact. Where `plan-shape` lists a critical kind the Surface leaves out, say whether the change shows or writes one. Each rule a Surface fact follows has one owner; a second derivation of it is a no. A write path's partial failure stops safe.
5. Reach counted: every consumer and sibling named, each with an existing test or a check.
6. Each tests row catches a failure that matters and can fail before the change.
7. The plan carries nothing the outcome doesn't need; the users' part ships alone or the plan says why not.
8. Risk is high when the definition's way of undoing a delivery can't reverse what the change does (data lost or rewritten, a write outside the project, access widened), else low. You may lower the planner's level with evidence; where the evidence is equal, the higher stands. Any product decision hiding in the plan is named as a memo now.

A failure you name is concrete: the input or state that triggers it and the source showing the product's real paths reach it. A state no real path reaches gets only a guard. Taste is not a failure.

**Verdict:** `build` | `fix items <numbers> once` (each with what the plan must change) | `approval needed` (risk high, or a memo undecided), which wins over the others and carries any fix items with it (`approval needed; fix items 2, 4 once`). There is no other value.

**You write** `evidence/judge-<delivery>.md`: lines `Revision: <n>`, `Risk: low | high` and `Verdict: <verdict>`, the `Read at` commits, the eight answers with their evidence, your risk reasons (also in the plan's risk table), and under "Outside the ticket" what lies beyond the outcome.

**You return** one line: `judge r<revision>: build | fix items <numbers> once | approval needed — <why>`, plus your risk level.
