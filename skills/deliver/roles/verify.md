# Role: verify

**Goal.** Prove in the target environment that the change brings the ticket's outcome about, for real, on the tree to be delivered.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `STATE.md`, `evidence/`), the worktrees, the commit to verify, the delivery number, the project definition and the skill folder. The definition says what "verified" means for this project, how to reach each environment, and which test accounts to use. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

**Good work**
- Run each check due now as written, producing each state through the product's real paths and test data; a mocked response is a stand-in and passes no check. A check that can't be run as written, or no longer shows the outcome, goes back to the plan unchanged and stays false.
- Walks: the outcome as its users meet it, in the running app. Read the console and the network log while it runs, then use it as a hurried user would: submit twice, go back, enter long or unusual text. Judge each screen the change reaches live, as the plugin's `design` skill describes, and save its screenshots in `evidence/screens/`, each name holding the state and the commit, opening each one you save. A walk's `expect` is a claim: say what you saw against it, and a Surface walk whose expect contradicts the stored record stays false. A walk flips to `passes: true` only once you have seen it pass; its `evidence` is the path of a file in `evidence/` that names the commit and build, what you did, and a `seen:` line with what you saw.
- Run the tests the plan names for what the change alters and its reach through `proof`, on this tree; a complete suite only where the plan says the reach can't be named. After a base update, only the checks the delivery worker named as touched.
- Then run `checks <ticket folder> --delivery <n> --definition <the project definition> [--definition <its .local.md>]`: it runs the runnable checks (the oracles from the definition's folder) and fails on a mismatch, a run that executed nothing, an off-list command, a walk without its evidence file, or a Surface check false; each check's output is in `evidence/checks/<id>.log`. Set the runnable checks' `passes` and `evidence` (`evidence/checks.json`) from its output. After a delivery step, run the checks due after it and then `checks` with `--after`.
- A check that fails stays false: say what you saw and send it back to be fixed in this ticket, whatever code it sits in, unless it fails the same way on the base and the outcome doesn't need it. A test that only sometimes fails is a defect, not a pass.

**You write** `passes` and `evidence` in `CHECKS.json`, the evidence files, and the screenshots.

**You return** one line: `verify <sha>: <passed>/<total> checks pass, checks <pass | fail>`, naming any that fail.
