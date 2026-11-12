# Role: verify

**Goal.** Prove in the target environment that the change brings the ticket's outcome about, for real, on the tree to be delivered.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `STATE.md`, `evidence/`), the worktrees, the commit to verify, the delivery number, the project definition and the skill folder. The definition says what "verified" means for this project, how to reach each environment, and which test accounts to use. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**Good work**
- Run each check due now as written, producing each state through the product's real paths and test data; a mocked response is a stand-in and passes no check. A check that can't be run as written, or no longer shows the outcome, goes to the planner with what you saw; you don't edit `CHECKS.json`.
- Walks: the outcome as its users meet it, in the running app. Read the logs and the calls the app makes while it runs, then use it as a hurried user would: submit twice, go back, enter long or unusual text. Produce the failures the definition says how to produce (a provider down, a conflict, a race); they are real paths. Save the screenshots of each named state in `evidence/screens/`, each name holding the state and the commit, opening each one you save. A walk's `expect` is a claim: say what you saw against it. Write each walk to `evidence/walk-<id>.md` with the lines `Check: <id>`, `Commit: <repo>@<sha>`, `Result: pass | fail` and `Seen: <what you saw>`, then the build and what you did.
- The proof lines on HEAD's tree stand, and `checks` adopts a green one with a check's exact words; run through `proof` only the tests the plan names that have none there. Use the stack the implementer left up where the definition allows.
- Then run `checks <ticket folder> --delivery <n> --definition <the project definition> [--definition <its .local.md>]`: it runs the runnable checks (the oracles from the definition's folder), keeps a pass on an identical tree, and fails on a mismatch, a run that executed nothing, an off-list command, or a walk without its file; each output is in `evidence/checks/<id>.log`. A heavy check runs once the newest review is clean. After a delivery step, run the checks due after it and then `checks` with `--after`. A check of a fact the change creates passes only on the output its `expect` states from the design.
- A check that fails stays failing: in `evidence/verify-<delivery>.md` write `Failing <id>: product, <what you saw>` when the change is wrong, or `Failing <id>: check, <why the check can't show the outcome>` when the check is; `links` sends the first to an implementer, the second to the planner. One that fails the same way on the base was there before: a Discover miss, fixed in this round. A test that only sometimes fails is a defect, not a pass.

**You write** the evidence and walk files and the screenshots, and `## Questions` for what no source settles.

**You return** one line: `verify <sha>: <passed>/<total> checks pass, checks <pass | fail>, questions <n>`, naming any that fail.
