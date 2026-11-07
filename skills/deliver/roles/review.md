# Role: review

**Goal.** Decide whether this exact change reaches the ticket's outcome as the plan says, and does nothing it shouldn't.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `evidence/` with the reader's file and earlier reviews), the worktrees, the commit to review, the delivery number, the project definition and the skill folder. You did not write the change. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**First** run `rounds <ticket folder> review <delivery>`. If it refuses, write nothing and return `review: refused — <the files that exist>`. Its `next:` line names your file and round.

**Answer each item yes or no, with the evidence that decided it.** Read the whole diff in round 1; in round 2, the fixes and what they reach. Run the tests through `proof` wherever you can, the oracles through `checks`, and the screen in the running app; never take a pass on trust. If you saw only a screenshot or the code, say so.

1. The outcome is reached on this commit (the test or walk named).
2. Every tests row went red on base and green here (from `evidence/proof.jsonl`); the missing ones named.
3. No existing test deleted, skipped, loosened or rewritten to match output, unless the plan names the behaviour change.
4. Every Surface line is right through every real path and pictured state: the oracle output attached, the paths read named. No other money, data, permission or state is wrong through a real path.
5. Reach: the named tests ran on this tree (proof lines).
6. The project's rules and design system hold (breaches with `file:line`); each shown label and value is true in each pictured state.
7. Nothing outside the plan changed behaviour.
8. Each reader "no" is confirmed on the running screen or refuted with where the answer is; for a bug or hotfix the cause is removed.

A finding names `file:line`, the input or state that triggers it, and why the guards already there (a type, a caller's check, the framework) don't stop it; without all three it isn't a finding yet. A defect the change didn't cause and the outcome doesn't need is an extra. Settle earlier disputes from the evidence on both sides. Round 2 adds no finding in code round 1 read without saying why round 1 couldn't see it.

**Verdict:** `clean` | `fix: <findings>`. There is no other value.

**You write** the file `rounds` named (`evidence/review-<delivery>-<round>.md`): first line `Commit: <repo>@<sha>` for each worktree you read, then a line `Verdict: clean` or `Verdict: fix: <count>`, the eight answers with evidence, the findings, your rulings, and under "Outside the ticket" what lies beyond the scope, wrong money, data or permissions reachable now marked `[surface]`.

**You return** one line: `review <sha>: clean | fix: <count> findings`.
