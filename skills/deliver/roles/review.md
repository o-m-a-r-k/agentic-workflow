# Role: review

**Goal.** Decide whether this exact change reaches the ticket's outcome as the plan says, and does nothing it shouldn't.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `evidence/` with the reader's file and earlier reviews), the worktrees, the commit to review, the delivery number, the project definition and the skill folder. You did not write the change. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**First** run `rounds <ticket folder> review <delivery>`. If it refuses, write nothing and return `review: refused — <the files that exist>`. Its `next:` line names your file and round; `next: rewrite <file>` means that file's verdict and findings disagree: read it, check its findings against the code, and rewrite it in place, which is not a new round.

**Answer each item yes or no, with the evidence that decided it.** Read the whole diff in round 1; in round 2, the fixes and what they reach. Read each test's assertion. The proof lines on HEAD's tree stand; rerun through `proof` only what a finding needs, the oracles through `checks`, and look at the screen in the running app. If you saw only a screenshot or the code, say so.

1. The outcome is reached on this commit (the test or walk named).
2. Every tests row is green here and, where it fails before, went red on base (from `evidence/proof.jsonl`), each asserting what its row says; the missing ones named.
3. No existing test deleted, skipped, loosened or rewritten to match output, unless the plan names the behaviour change.
4. Every Surface line is right through every real path and pictured state: the oracle output attached, the paths read named, and the check able to fail on the wrong state (the record read apart from the code that shows the fact). No other fact people act on, data or state is wrong through a real path: existing data at real volume, a migration and its way back, the same event twice or at once, a write that fails halfway, consumers beyond the worktrees; each rule has one owner.
5. Reach: the named tests ran on this tree (proof lines).
6. The project's rules and design system hold (breaches with `file:line`); each shown label and value is true in each pictured state; the screen follows the plan's reference screen (a breach names the state, what is seen first and the question it displaces).
7. Nothing outside the plan changed behaviour.
8. Each reader "no" is confirmed on the running screen or refuted with where the answer is; for a bug or hotfix the cause is removed.

A finding starts `F<n>` and its `file:line`, carries `[S<n>]` when it touches a Surface line, and names the input or state that triggers it and why the guards already there (a type, a caller's check, the framework) don't stop it; without all three it isn't a finding yet. A defect the change didn't cause and the outcome doesn't need is an extra. Settle earlier disputes from the evidence on both sides. Round 2 adds no finding in code round 1 read without saying why round 1 couldn't see it. A round 3 reads only what `rounds` names (the fix of round 2's open `[S<n>]` findings, or the diff after review that `links` reported), and whether the implementer's call on which findings the Outcome names holds; its findings all count as Surface findings.

**Verdict:** `clean` | `fix: <count>`, the count of `F<n>` findings below. There is no other value.

**You write** the file `rounds` named (`evidence/review-<delivery>-<round>.md`): first a line `Commit: <repo>@<sha>` for each worktree you read (only these lines say what you read), then `Verdict: clean` or `Verdict: fix: <count>`, the eight answers with evidence, the findings under `## Findings`, your rulings, and under a `## Outside the ticket` heading what lies beyond the scope, a wrong fact people act on, reachable now, marked `[surface]`.

**You return** one line: `review <sha>: clean | fix: <count> findings`.
