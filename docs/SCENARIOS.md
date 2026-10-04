# Behaviour scenarios

Each scenario runs the real `wf` CLI against temporary git repositories with bare remotes. `npm test` runs them all.

| Area | Scenario | File |
| --- | --- | --- |
| Lifecycle | Standard lifecycle delivers to the remote and removes worktrees | lifecycle |
| Independence | Owner, planner and implementer cannot review; planner must leave the tree unchanged; closure must come from the handed reviewer | lifecycle |
| Criteria | Frozen before implementation; every criterion mapped; n/a needs a reason; amendments recorded | lifecycle |
| Review | Open findings block acceptance; a change after acceptance needs a new review | lifecycle |
| Authority | Analysis intent never implements or delivers; a hold vetoes delivery until released | lifecycle |
| Gate truth | A newer failure supersedes an older pass; uncommitted changes refuse the gate | lifecycle |
| Ownership | One open attempt per item; `adopt` transfers ownership | lifecycle |
| Evidence | A hand-edited ledger is detected; a newer schema is refused with the version to use | lifecycle, gate |
| Follow-ups | Reopen after delivery links the new attempt; quick fixes number themselves and close on delivery | lifecycle |
| Reuse | Unchanged inputs reuse; changed inputs rerun; steps without inputs always run | gate |
| Workers | Auto sizing recorded; overrides honoured; invalid override exits 2 | gate |
| Adapter trust | A ticket that edits `.workflow/` still gets the base adapter's steps and a full gate | gate |
| Suites | JUnit suites recorded; `select` reruns only failed or changed suites | gate |
| Scheduling | Parallel up to the limit; steps holding the same lease never overlap | gate |
| Recovery | A killed runner is recovered: finished steps carried, its processes stopped, no duplicate gate while alive | gate |
| Stop | `wf stop` pauses a gate and keeps finished steps | delivery |
| Secrets | Missing secrets refuse the gate; format checked; values masked in logs and status; `.env.local` is 0600; generated and test keys filled by `secrets init` | gate, onboarding |
| Base advance | Unrelated base movement is merged and the gate carried; movement touching the change or shared infra reopens the gate | delivery |
| Topology | A changed contract pulls dependents into the gate; the reviewer is told which contract is crossed; providers deliver first | delivery |
| Partial delivery | One repo delivered, the next fails; rerunning delivers only the rest | delivery |
| Batch | Members defer heavy steps and cannot deliver alone; the batch runs heavy steps once and delivers every member | delivery |
| Tracker | Status, comment (template lines, UAT bullets, no internals) and screenshot attachments verified from the readback; reviewer must inspect every screenshot | delivery |
| Merge requests | A project delivery adapter waits for merge (ticket moves to In Review), then reads back | delivery |
| Onboarding | `wf init` detects repos, packages, components, steps and secrets; never overwrites; doctor tells config errors from red tests and cleans up | onboarding |
| Enable | Enable writes the AGENTS.md block and role agents without touching other content; disable removes only the block; disabled projects refuse work | onboarding |
| Skills | `sync` vendors skills for every runtime; a reviewer handoff needs them | onboarding |
| Report | CSV and HTML report per attempt | onboarding |
| Review fixes | Stale suite reuse refused when code under test changed; concurrent gates (one runs, ledger intact); batch member hold, author independence and post-join change; previous owner cannot review after adopt; landed push recovered only for the accepted commit; hand push after acceptance refused; `delivery.order` keeps unlisted repos; absolute JUnit globs; split-chunk secret masking; tracker reopen and UUID rules; unsafe ids; reviewer closure writable under the guard hook | review-findings |
