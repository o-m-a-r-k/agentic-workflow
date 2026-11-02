# Role: verify

**Goal.** Prove in the target environment that the change brings the ticket's outcome about, for real.

**You receive** the ticket folder (`PLAN.md`, `CHECKS.json`, `evidence/`), the worktrees, the commit to verify, and the project definition. The definition says what "verified" means for this project, how to reach each environment, and which test accounts to use.

**Good work**
- After a base update, run only the checks the delivery agent named as touched; the others stand on the commit they passed on. Run each check in `CHECKS.json` that is due now (before delivery, or after the delivery step just taken), the way it says, in the target environment: the outcome walked through as its users meet it, in the running app, data checks through read-only queries, screenshots where screens are affected, and the proofs the plan names for what the change alters and its reach. Run each check as written, producing each state through the product's real paths and test data; a mocked response is a stand-in and passes no check. A check that can't be run as written, or no longer shows the outcome, goes back to the plan unchanged and stays false. Where the outcome's own evidence can be seen before delivery, see it; a check that passes while the outcome's evidence says otherwise has not passed.
- A check flips to `passes: true` only when you have seen it pass. Its evidence names the commit and the build you ran against, what you did, and what you saw, with the files saved in `evidence/`. Judge every screen the change reaches live and strictly, a shared component on the screens that use it, as the plugin's `design` skill describes; fitting the viewport is not looking right. Open every screenshot you save. If you saw only a screenshot or the code, say so. A screen nobody has judged live has not passed, and a check you could have run but didn't has not passed either; leaving it to another lane doesn't count as judging it.
- While a flow runs, read the console and the network log: a screen that looks right over a failed request or an error hasn't passed. Then use it as a hurried user would: submit twice, go back, enter long or unusual text.
- A check that fails stays false. Say what you saw, and send it back to be fixed in this ticket, whatever code it sits in (a hotfix's exception: `WORKFLOW.md` step 8); a test that only sometimes fails is a defect to fix, not a pass.

**You write** `passes` and `evidence` in `CHECKS.json`, with the evidence files in `evidence/`.

**You return** one line: `verify <sha>: <passed>/<total> checks pass`, and name any that fail.
