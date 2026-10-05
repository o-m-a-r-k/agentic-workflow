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
| Work classes | `wf sync` writes one implementer per class with its effort (Claude frontmatter, Codex TOML) and removes stale generated agents; unknown classes, undocumented efforts and old per-role fields are refused | classes |
| Work items | Duplicate ids, unknown criteria and unknown classes are refused; uncovered criteria are shown; `--work` handoffs name the agent type and record class and effort; `wf resume` lists open work items | classes |
| Amendments | Amendments merge by id: unmentioned criteria survive; a drop needs `dropped: true` and a reason | classes |
| Agent telemetry | Subagent transcripts are found by name and agent type; declared vs observed effort, model, wall minutes and output tokens per handoff | classes |
| Onboarding | `wf init` detects repos, packages, components, steps and secrets; never overwrites; doctor tells config errors from red tests and cleans up | onboarding |
| Enable | Enable writes the AGENTS.md block and role agents without touching other content; disable removes only the block; disabled projects refuse work | onboarding |
| Skills | `sync` vendors skills for every runtime; a reviewer handoff needs them | onboarding |
| Report | CSV and HTML report per attempt | onboarding |
| Review fixes | Stale suite reuse refused when code under test changed; concurrent gates (one runs, ledger intact); batch member hold, author independence and post-join change; previous owner cannot review after adopt; landed push recovered only for the accepted commit; hand push after acceptance refused; `delivery.order` keeps unlisted repos; absolute JUnit globs; split-chunk secret masking; tracker reopen and UUID rules; unsafe ids; reviewer closure writable under the guard hook | review-findings |
| Field fixes | Plan file keeps top-level sections and refuses unknown keys; `--from-agent` reads the planner's transcript; admitted capture needs the description; recycled captures refused; `implementing` queued once; `--attempt` in every printed command with two open attempts; stale stop reason hidden; `wf review` prints a receipt only; base status and `wf base merge` (overlap, conflict aborted); doctor warns on sibling paths without `alsoInputs` and on several unpinned models; step environment allowlist; active minutes and rounds | field-fixes |
| Durable and provenance | Raw plan, amendment and closure kept byte for byte; export at any phase, self-contained and secret-masked, `--json`; steered, unknown and wrong-type reviewers refused where transcripts exist, `unverified` elsewhere; commit-then-reveal of earlier findings | durable, review-order |
| Checks and gates | `wf check` runs light steps, never counts, is reused by the gate; light-first, longest-heavy-first scheduling; flaky steps recorded; `--rerun-failed` never counts | durable |
| Scope, leases, hygiene, secrets | `outsidePlan` listed and counted; `wf run --lease` holds and waits for a slot; doctor lists untracked paths; only needed secrets asked; init drafts no unused keys | durable |
| Tracker API | `tracker.via: api` performs and reads back admitted, implementing and delivered against a fake Linear server; falls back without the key | durable |
| Per-ticket evidence | `{item}`/`{itemLower}`/`{attempt}` in `artifacts` collect only the ticket's files, listed per glob in the bundle; a matched file not inspected blocks accept; a step that matched nothing while its package changed needs a `noEvidence` reason or a finding naming it (empty reason refused; verdict ledgered and exported); a step whose package did not change needs nothing; a screenshot criterion ref the gate did not collect is refused; steps get `WF_ITEM`/`WF_ITEMS` for one attempt and for a batch; `wf init` drafts `<testDir>/.evidence/{itemLower}/**/*.png` for Playwright and Cypress, nothing for other runners; unknown placeholders refused; doctor warns statically on a placeholder-less glob, prints per-glob counts and warns on one matching files the ticket did not touch | evidence |
| Engine pin | `>=x.y.z` refused at `wf entry` and `wf gate` on an older engine, accepted when equal or newer, `N.x` kept; other forms fail validation; the ledger records the released version | evidence |
| Game day | One ticket across a backend/frontend pair through every fault seen on real tickets | gameday |
| End to end | From `wf init`: drafted adapter fails the gate when source breaks; narrow inputs fail closed per step; `wf` works inside worktrees; failed entry rolls back; gate and install output do not block gates; monorepo and multi-repo init; machine-wide leases across gates; review hints; guard hook resolves relative paths after `cd` | e2e |
