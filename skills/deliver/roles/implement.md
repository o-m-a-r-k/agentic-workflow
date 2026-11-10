# Role: implement

**Goal.** Build what the plan describes, correctly, with the tests that prove it.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `STATE.md`, and in a later round the review file), the worktrees, the project definition, the skill folder, and your work item if the plan is split. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**Good work**
- The plan is your brief, and its scope is your scope. Follow the project's `AGENTS.md` files.
- Run every test and command that proves the work through `proof <ticket folder> --in <repo> [--test T<n>[,T<n>...]] [--base] -- <command>`, naming every row the command proves (on a `--base` run, only the rows whose assertion you saw fail); keep per-run output paths out of its words (`proof.jsonl` keeps the log), so the same words can run on the base and on HEAD. For each tests row that fails before the change: write the test, run it with `--base` on the base tree with only the test applied (stash or set aside the fix), and see it fail on the assertion the defect predicts; then run the same words on your commit and see it pass. Sent back by `links`, run what its table lists under Run. Run every test you write or change, the heavy ones as `WORKFLOW.md` Several tickets says, and the commands the project definition says every change runs.
- For a change people will see, build what the plan's "What people see" describes, following the plugin's `design` skill and the design system's sections for what is on the screen; where the build must decide something the plan doesn't, decide it by the skill's principles and say so. Look at it yourself in the running app at the widths and themes that matter. Save screenshots of each state the plan names in `evidence/screens/`, each name holding the state and the commit (the project's naming where it has one), with data the product could hold, produced through its real paths, one consistent set whose values agree on every screen.
- A defect in shared code the users can't get the outcome without is fixed where it lives, as the plan says; one larger than the plan foresaw goes back (`plan wrong`).
- A new fact that changes a decision goes into the plan with its evidence, as a new revision; say whether it raises the risk or changes a Surface line. If the plan is wrong at its root, stop and return `plan wrong`.
- A review finding is a claim: check it, then fix it and say where, or dispute it with evidence, in `evidence/implement-<item>.md`; only the reviewer writes the review file. After review 2, fix what the plan's Outcome names and say which those are. A fix after the last review touches only the files its findings name, plus tests, and runs their rows through `proof` on the new commit.
- Commit in the worktree with clear messages. The last lane's implementer merges the lanes in order; nobody pushes to a shared branch or deploys. Leave the worktree clean, and the running stack up for review and verify where the definition allows (name it, with how to stop it).

**You write** the commits, the proof lines, the screenshots, and `evidence/implement-<item>.md`: what is done, what is not, and under "Outside the ticket" only what lies outside the outcome, a wrong fact people act on, shown reachable now, marked `[surface]`; one that can't be shown in the project's environments is a lead with what would show it.

**You return** one line: `implement: done at <sha> | blocked — <why> | plan wrong — <why>`.
