# agentic-workflow — design register

[Back to the README](../README.md) · [The 0.8 design](design-0.8.md)

This file is the register of the decisions that shape the engine. [design-0.8.md](design-0.8.md) is the design they come from: the measurements behind it, the flow, the adapter, telemetry, learning and the migration. The scenario tests in `scenarios/` are the executable form of both; where they differ, the tests win and this file is fixed.

A decision lives here, not in an agent's memory, a session's notes or a private plan. Named failure: the decision that the engine never launches agents lived only in one runtime's memory, and an agent on the other runtime reversed it without knowing it had been made. To change a decision, add an entry that supersedes it in the same change as the code, and read this register before reversing anything.

## What agentic-workflow is

One flow per ticket for AI coding agents: a fresh worktree per repo, plain criteria, an implementer, fresh independent reviewers that read the whole diff while the tests run, the project's own delivery stages, and a telemetry row per ticket that learning is judged by. It ships as one user-level plugin for Claude Code and Codex. Each project brings an adapter that names its repos, tests, screens, risk paths, ticketing and delivery.

## Principles

1. **One trust boundary.** Authority to deliver is an attempt with no hold. A short list of decisions is the person's (D95), and only the person's own turn answers one.
2. **Facts from git, the ledger and the host's records.** No step accepts an agent saying it did something.
3. **Independent review.** The reviewer never wrote the change, and `wf` launches it, so the engine knows its session and what it read.
4. **Criteria first, hashed, not frozen.** One to six plain criteria before the work; edits are allowed and recorded, and loosening one a blocker cites goes to the person.
6. **Interruptions keep work.** A run, a review or a launch that stops keeps what finished; a launch the model's capacity ended resumes in its own session (D61).
8. **A counted, machine-wide lock.** A heavy suite holds a counted slot shared by every project on the machine; a slot whose holder is gone is taken over.
9. **Isolation.** One worktree per repo per attempt, from the fetched base. Closing removes the worktrees and keeps the branches.
10. **Delivery is the project's.** It ends where the project's stages say, read back from the tracker.
11. **Versioned state.** Ledgers carry their schema; 0.8 reads 0.7 ledgers, and attempt numbers continue after them. A ledger takes no event after `attempt.closed`.
12. **Reproduce before blaming.** A risk test must fail on the merge-base before it proves anything.
13. **No ceremony without a named failure.** Every refusal names the failure it catches, and every rule-shaped change is counted against the budget (D98).
14. **Agents never handle secret values.**

Principles 5 (fast gates by reuse) and 7 (base movement is not a reset) are retired: there is no gate reuse and no base following; an attempt starts from a fresh base and the merge facts judge what moved (D97). The numbers keep their places so earlier references stay readable.

## Decisions that survive

| ID | Decision |
|---|---|
| D4 | **The person's authority is a short reserved list:** a production deploy, waiving a blocking finding, loosening criteria after a blocker, the diff-read on a risk path, a merge whose history holds a branch other than the base, and the no-progress stop. Holds are the person's own control. Everything else is the agents' work. |
| D5 | **The engine launches roles.** `wf review` launches every reviewer, and records the session it started and the tree and heads it was launched on. A review is recorded against the tree of its launch, never one the recording command names, and only while that tree is HEAD (`review:tree`). The review file is the reviewer's own: its transcript holds a write to that path with the same content hash, or the review is its final message, which the supervisor writes to the file when the reviewer wrote none. |
| D6 | **Threat model: agents are fallible, not adversarial.** Checks catch mistakes: an agent that misremembers, skips a step, edits the wrong file or reviews its own work. A process running as the person that sets out to defeat the engine is outside the model. A security finding that assumes an adversarial agent is closed as out of model unless an incident shows the behaviour. Named failure: an automated security review drove nine releases in 95 minutes with no incident behind any of them. |
| D7 | **Releases never add obligations to attempts in flight.** An attempt started on 0.7 is closed or migrated (`wf migrate attempts`), never judged by 0.8's rules halfway. |
| D8 | **The workflow knows no harness.** Everything about Claude Code and Codex lives in `engine/hosts/`: identity, launch and resume, the transcript store and its readers. Engine modules outside that folder name no harness (`scenarios/host-boundary.test.mjs`); a harness is added by registering one host module (`scenarios/host-plugin.test.mjs`), built in or from `<user folder>/hosts/*.mjs` (or `WF_HOSTS`), loaded at import so the supervisor launches through it too. |
| D9 | **The engine judges no work against a number it picked.** The person's numbers are theirs; every engine number is derived from a baseline (D98). |
| D12 | **The person may answer in the question panel.** A panel answer to the question as `wf` printed it counts as their turn. |
| D14 | **Provisioning gets only the secrets declared for it.** A catalogued key whose `usedBy` names `provision:<repo>` reaches that repo's install and nothing else; a missing one refuses the start; a failed install with a secret prints none of its output. |
| D16 | **An attempt whose change shipped outside the workflow closes as shipped,** proven by patch-id against the base, commit by commit or as one squashed diff. The close records `outsideStages: true` in `attempt.closed` and in the telemetry row, and the digest shows it; a "shipped" close with no commits is refused. |
| D19 | **Project learning changes only what roles read.** A project proposal changes the texts its roles get, never a rule of the engine. |
| D21 | **Rules live in the plugin.** The texts agents read come from the plugin; nothing is copied into a project's files. |
| D24 | **The person's rules live in the texts agents read,** as proposals with `source: person` (D98), never in a maintainer's private notes. |
| D26 | **The person may answer in the chat,** under the answer rule (D95). |
| D27 | **An older copy of `wf` runs the installed one.** The installed release is the copy `node scripts/install.mjs` linked into `~/.local/bin`; agents run `wf` from their PATH and never change the plugin from a ticket. |
| D29 | **Plain questions, never asked twice.** Each question says what is decided, in plain words, with plain choices; an answer stands. |
| D30 | **Standing rules reach sessions from the plugin.** The SessionStart and SubagentStart hooks give every Claude Code session in a project the session rules, filled from its adapter and invariants. Codex plugins carry no hooks, so this is Claude Code only. A project's instruction files are its own. |
| D34 | **The person's own stops apply to every attempt in flight.** The no-progress stop (D93) is the person's, whichever release started the attempt. |
| D39, D40 | **Status routing by label and screenshot handling are stages** (D96): `when: { labels }` filters a stage, and a tracker module says how it takes images. |
| D41 | **The agent reads the person's answer; the engine proves the words are theirs,** under the answer rule (D95). |
| D42 | **Waiting for the deployment is a stage:** `confirm-deployed`, read-only, then test there. |
| D54 | **A plan wider than the request names each addition and why.** The planner's text says so. |
| D60 | **The adapter is read live, with the stage list snapshotted at start.** A delivery runs the stages the attempt started with. |
| D61 | **A launch the model's capacity ended is resumed in its own session,** with the same model and prompt, after growing waits, for as long as the host reports capacity. |
| D63 | **A tracker reached through the agent's connector is the project's choice.** The engine prints what it needs done in the adapter's words and reads the result back from the session that did it. With `via: connector`, the tracker's name is a label, never a driver. An operation counts from a call made after the stage was first asked, with a result that is no error: a follow-up's input carries the marker and the title and its result the new id (so it needs `ticketing.idPattern`); a status change's result shows the new status. Labels come from the owner's read-call result; `wf deliver --labels` is refused. |
| D68 | **Through a connector, the adapter's own operation text comes first** (`ticketing.operations`), verbatim. The adapter's operation keys and the engine's operations are one list (`TRACKER_OPERATIONS` in `engine/contract.mjs`): `read`, `search`, `fileFollowUp`, `setStatus`, `comment`, `mergeRequest`. |
| D73 | **The plugin is never changed from a ticket.** A project's own modules change only through delivery, and load as the base holds them. That includes a screens capture given as `{ module: { repo, path } }`, run with `ctx.cwd` set to the attempt folder; a capture given as `{ run }` stays allowed and runs as the attempt has it, which the docs state as its limit. |
| D74 | **A refusal says what to do meanwhile and who can change it.** |
| D83 | **A maintainer release is one command:** `node scripts/release.mjs <version>`, with the budget check (D98) in its first step. |
| D90 | **A git call in a vanished attempt worktree names the missing worktree,** so a read can tell it from any other failure. |

## New in 0.8

| ID | Decision | Why |
|---|---|---|
| D91 | **One flow:** `start`, `criteria`, implement, `test fast`, `screens`, `review` (reviewers in parallel with the tests), fix rounds for blockers, delivery stages, `close`. No lanes, batch lane, analysis attempts, planning panel or strategist. `wf status` names one next command per attempt. `wf review` waits until every seat is done or failed and the tests have ended (`--no-wait` returns early), and the owner runs `wf review`, `wf land` and `wf test` in the background, so nobody polls. | Fifty tickets measured over two weeks: most elapsed time was idle, about a sixth of it the plugin stopping agents; 76% of active time came after the first review. |
| D92 | **Three finding classes.** `goal` (affects this ticket's work, in the changed lines or code they depend on) and `regression` (this change broke it, anywhere) block at any severity. `other` is filed per `ticketing.followUps` (`file`, `digest`, `off`), after a tracker search; `other` on a line this attempt wrote is refused (`finding:other-own`). | The severity-leaving rules made unrelated defects mandatory work; repairs created 41% of later defects. |
| D93 | **Whole-diff reviews.** Every review reads the whole product diff, in parallel with the fast tests on the same tree. Above the size limit the review splits by area; a risk change above it must be split. There is no round cap: a ticket stops only on no progress (a fixed finding reopens, or the blocker count does not go down), and the person decides. | The first review was shallow (about 8 minutes, a sample of the files); 73% of rounds found nothing blocking; one ticket ran 18 rounds with blockers flat. |
| D94 | **The risk tier.** Each project's risk paths come from onboarding, with reasons that cite files, confirmed by the person; the plugin ships no list. A change on a risk path needs a test that fails on the merge-base, a second reviewer on a different model, the risk checklist, and the person's diff-read. | Tests that asserted nothing; money and external writes cost the most when wrong. |
| D95 | **Reserved decisions, the answer rule and the digest.** An answer counts only from a human-typed turn (or the question panel), on one of two facts: it is the first person turn after a message that showed this question and no other open one, or it contains the decision id (`D3`) or one of its refs (`F3`), as an exact token the engine printed. No reply is judged by its words being few (the bare-reply guess is gone); `--choice` is refused when the quote is exactly another option. Sign-offs, priority `other` findings and stops collect into one daily digest; a blocking question is also asked at once. | 283 of 304 recorded "owner decisions" in 0.6 were the agent's own command. |
| D96 | **Ticketing and delivery are the project's.** Delivery is a list of stages (`land`, `push`, `merge-request`, `wait-merged`, `confirm-deployed`, `deploy`, `status`, `comment`, `module`), each repo's part in the adapter's order. Every comment and filed ticket carries a marker the engine searches for before writing; a label it cannot read is `pending`, never false. | The real projects' deliveries (merge requests per repo, label-routed statuses, deploy confirmation) needed special cases in 0.7. |
| D97 | **No sequencing.** No attempt waits for another unless the project says so (`after:`). Projects without CI land through the landing queue: ready tickets are stacked on the current base, `full` runs once, red bisects. The merge facts refuse `merge:unreviewed` (anything other than git's automatic merge changed since the reviewed tree) and `merge:foreign` (a merge of a branch other than the base). A landed or pushed tree on the base needs a passing `full` run on it (`merge:untested`), whether a `land` or a `push` stage delivers it, and every stage needs the `fast` tests green on HEAD. | Sequencing and bundled releases made most of the idle time; the full suite takes 40 to 70 minutes on projects with no CI. |
| D98 | **Measured learning and a hard budget.** A rule-shaped change (a refusal id, a command, an adapter key, an event type, words in a text agents read) is counted by `scripts/release.mjs` against `budget.json`; a net increase fails the release unless a kept or active proposal accounts for it. A proposal names its source, what it replaces, a metric and a guard, and is judged against the project's baseline band. | The plugin grew to 90 decisions and more than 300 refusals, a rule after each incident. |
| D99 | **Nothing committed in product repos is required.** The adapter may live in the user folder; 0.8 reads no workflow material in product repos. | About 16k lines of workflow material sat in product repos, and no CI job ran any of it. |
| D100 | **Onboarding sets project policy and can be re-run at any time.** `wf init` scans the repos as facts, proposes each policy key with reasons, shows a per-key diff, keeps hand edits unless confirmed, and writes only what the person confirms. Migration from 0.7 is an onboarding run (`wf init --from-07`). | Project policy (risk, diff-read timing, stages, test split, screens) was hand-written and drifted. |
| D101 | **The attempt owns its base and its scope.** `wf start --base <branch>` records the base per repo, and every base read (risk-base, landing, delivery, telemetry) takes the attempt's recorded base. `--repos` starts on some repos only; `--no-tracker` records `ticketing: none` for work with no ticket. | The review of the first 0.8 build: every base read took the adapter's base, so an attempt on another branch was tested, landed and measured against the wrong one; a migrated project with fewer repos or no ticket could not start. |
| D102 | **Role texts reach their agents through `wf handoff`.** `wf handoff <role>` prints the role text and the project's learned notes and returns them as `data.prompt`; the owner launches the role with that text. | The review of the first 0.8 build: the implementer and planner texts were never delivered to any agent. |
| D103 | **What `wf` writes is scrubbed.** Prefixed and bearer tokens, credentials in query strings and catalogued secret values are masked in findings when recorded, in comment and follow-up bodies when posted, and in digest lines. The catalogue is read beside the adapter. | The review of the first 0.8 build: the cut removed the scrub, so a token quoted in a finding would reach the ledger, the tracker and the digest as written. |

## Retired

Sixty decisions are retired, with the mechanism of D9. Each group in one line:

- **Strategist, course, escalation** (D3, D33, D44, D84, D86): the role stopped agents and added rounds.
- **Rounds, evidence and delta reviews, divided review** (D2, D13, D20, D48, D50, D53, D69, D70, D76): replaced by whole-diff reviews (D93).
- **Severity leaving, per-item questions, discovered issues, premise** (D1, D10, D17, D18, D35, D38, D45, D71, D85): replaced by the three classes (D92); they made unrelated defects mandatory work.
- **Fix-round content** (D36, D46, D51, D64): one line in the implementer's text.
- **Gate reuse, light-only, needs, affects, leases, batches** (D22, D23, D47, D49, D56, D57, D58, D59, D75): replaced by `fast`/`full`, the counted lock and the landing queue.
- **Per-ticket proof and corrections** (D11, D37, D78, D79, D80, D82, D88, D89): per-ticket steps are gone.
- **Plans, panels, briefs, analysis** (D9's mechanism, D28, D52, D65, D66, D67): plain criteria.
- **Evidence integrity** (D15, D77): the manifest and the guard hook are gone; the ledger's hash chain stays.
- **Base, targets, outside pushes** (D31, D62, D72, D81, D87): a fresh base at start and the merge facts (D97).
- **Answers, screenshot ranking** (D25, D32, D43, D55): the answer rule (D95); screens are picked per run.
