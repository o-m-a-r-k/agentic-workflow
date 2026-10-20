# agentic-workflow 0.8 — the small core

Status: final design, ready to build. Nothing is built yet. It replaces the lifecycle in `docs/DESIGN.md` and keeps the decisions listed in section 4. Revision 2 folded in five pre-mortem reviews (regrowth, agent behaviour, speed, quality, configuration and migration). Revision 3 folds in the person's answers to every open question; none remain (section 13).

## 1. Why

Fifty real tickets were measured over two weeks on two projects.

- Most of the elapsed time was idle, caused by sequencing and bundled releases. About a sixth of the idle time came from the plugin stopping agents.
- 76% of the active time came after the first review.
- 73% of review rounds found nothing blocking, and more than half ran with no product code changed.
- The first review was shallow: about 8 minutes, a sample of the files, with 50–82% of its context taken by workflow paperwork.
- Implementers spent 8–12% of their time editing.
- Deliveries ran 2–6k lines (up to 192k) around fixes of 3–50 lines.
- Repairs created 41% of the later defects, and about half of all deliveries were reworked within two days.
- About 16k lines of workflow material sit in product repos, and no CI job runs any of it.

Two things worked:

- **The independent review:** 65% of its blocking findings were real defects.
- **Screenshots of the touched screens:** they caught about 27% of real defects, mostly right-to-left layout. Most of those defects (61 of 70) were in code that existed before the ticket. Screenshots are therefore a regression net for the screens a change reaches, as well as a check on the change itself. Section 2 picks screens for that purpose.

0.8 keeps those two things and the parts that make them possible: isolated worktrees, the ledger, tracker reach, secrets hygiene, telemetry and learning. It removes most of the rest. The engine goes from about 30,700 lines in 91 modules to an estimated 11,000 (stream sizes in section 12, kept modules included). Revision 1 estimated 8,000. Revision 2 added about 2,000 lines, all of them fact checks with a named failure. Revision 3 added about 450 for the onboarding scan (section 3, last table).

## 2. The flow

Every ticket goes through one flow. There are no lanes, batch lane, analysis attempts, planning panel or strategist. The work skill starts each admitted ticket as its own background attempt, as many as the machine's measured capacity allows. No attempt waits for another unless the project's delivery says so.

| # | Step | Who | What the engine records or checks |
|---|---|---|---|
| 1 | `wf start <item>` | owner | Normalises the item id through the tracker. Continues attempt numbers from old ledgers and branches. Fetches, then creates one worktree per repo at the fetched tip of each repo's base (the adapter's, or `--base`, recorded per attempt; every base read of the attempt uses it; `--base` is refused while the stage list holds `land`, which lands on the adapter's base). `--no-tracker` records `ticketing: none`. Provisions the worktrees. Snapshots the delivery stage list. Never merges staging or sibling branches. |
| 2 | `wf criteria --file` | planner (owner for a small fix) | 1–6 plain criteria and the touched areas, hashed. Edits are allowed and recorded. |
| 3 | Implement | implementer | Nothing. |
| 4 | `wf test fast` | implementer | Runs the repo's `fast` tests. The caller runs it as a host background command, which notifies on completion, so nobody polls (the engine has no notifier). Records exit code, minutes and tree hash. |
| 5 | `wf screens` | implementer | Picks screens by facts (below), captures them, and records each image with its tree, viewport, `lang`, `dir`, pixel size and hash. |
| 6 | `wf review` | engine launches a fresh reviewer | The bundle is the reviewer's entire prompt (below). The review runs **in parallel** with `wf test fast` on the same tree hash. When a first reviewer's risk judgement needs a second review, or names a need of its own, the next `wf review` launches a second reviewer on a different model on the whole diff. It waits until each reviewer is done or failed (`--no-wait` returns at launch); the caller runs it in the background. |
| 7 | Fix round, then the next review | implementer, then fresh reviewers | Only on a blocker. The next reviewer gets the whole diff again, with "verify these blockers, then re-read the whole change", and the criteria diff since the last review. |
| 8 | Findings outside the goal | engine and owner | Filed per the project's ticketing (below). |
| 9 | Landing | engine, the project's CI, the person | Through the project's delivery stages (section 5). Each repo's part is delivered separately by default, in the adapter's `order:`. |
| 10 | `wf close` | owner | Writes the telemetry row. Removes the worktrees and keeps the branches. A close with no commits is refused; one proven by patch-id (per commit, or the whole diff for a squash) with its stages not done records `outsideStages`, shown in the row and the digest. |

`wf status` always names exactly one next command per attempt.

**Review bundle.** The bundle contains, and contains only:

- the product diff;
- the criteria, plus the criteria diff on later rounds;
- the invariants file;
- the project rules for the touched paths;
- the consumers of changed contracts: the files that the adapter's `components.dependsOn` contract globs map to a changed route or DTO;
- the screenshot paths;
- the risk guidance (`templates/risk.md`), for every first seat; the second seat gets the needs it verifies instead.

Above about 1,500 product lines per reviewer, the engine splits the review by area. Each area reviewer also gets the list of shared files and the consumers. The implementer's and the reviewer's role texts say that tests must assert state or output, never call counts.

**Reviewer coverage.** The reviewer is launched through `wf`, so the engine knows its session. Recording is refused while product files in the diff do not appear among the files the reviewer's transcript read. Named failure: the first review sampled files for about 8 minutes. A host without readable transcripts records coverage as `unverified` and shows it to the person at the diff-read.

**Review file provenance.** The review file is the reviewer's own: its transcript holds a write of those bytes, or the review is its final message. A transcript that shows neither is refused (`review:independent`). A host without readable transcripts records provenance as `unverified`, the way coverage is: the person sees it at the diff-read and in the digest.

**Screens.** Screens are picked from the reverse imports of the changed UI files, mapped to routes by the adapter's `screens.routes`. When a changed file matches `screens.shared` (shared components, global styles), the project's fixed `screens.sentinel` set is also captured, in every listed language and direction at the narrow viewport. A capture is refused when its width differs from the requested viewport (named failure I-117: cropped screens passed) or when its bytes duplicate another capture of a different screen (named failure: a stuck page passed as several screens).

**The findings rule (the person's ruling).** Every finding is one of three classes:

- **`goal`:** it affects the work, the bug or the feature of this ticket, in the changed lines or in code the change depends on. It is fixed in the ticket **at any severity, low included**.
- **`regression`:** something this change broke, anywhere, including a screen outside the goal. It is part of the work and blocks.
- **`other`:** anything else.

The engine refuses `other` on a finding whose `path:line` blames to this attempt's commits. 0.7's classifier already made this check, and repairs created 41% of later defects. `goal` and `regression` findings of every severity block the merge.

`other` findings are de-duplicated against the tracker by searching it first. They are then filed according to the project's `followUps` setting:

- `file`: a ticket is filed automatically.
- `digest`: the finding goes into the person's daily digest.
- `off`: nothing is filed; the finding stays in the attempt's ledger.

An `other` finding rated high or critical goes to the person as a priority question in the digest. It does not hold the ticket.

**Fix rounds.** Fix rounds are counted per item, across abandon and restart. A severity or class change on an earlier finding is shown to the next reviewer and in `wf resume`. There is no round cap. A ticket stops and comes to the person only on **no progress**: the same finding reopens after a fix, or a review leaves the number of open blockers no lower than the review before it. Both are facts in the ledger (finding ids, blocker counts per review). The person then decides how to go on.

**Criteria.** An edit after a blocker that loosens or drops the criterion the blocker cites counts as a waiver. It goes to the person. Named failure: 131 amendments grew one ticket's criteria.

**Risk (D94, revised in 0.8.1).** There are no risk paths. Every first reviewer (the whole seat, or each area seat above the split size) judges, for the change in front of it, how much harm it could do if it is wrong and what would make it confident it is not. It reasons from what it reads: what the change does, who and what depends on the changed code, how far a mistake would spread and how easily it could be undone, how well the tests cover the behaviour, the project's instructions and invariants, and its own confidence after reading. Money, irreversible external writes, data loss and access are examples in its guidance (`templates/risk.md`), not a checklist.

The reviewer's closure records `risk: { level: low|high, why, needs: [...] }`; a high level names at least one need. `needs` is the reviewer's own proportionate verification for this change. The engine never judges the risk; it checks that each listed need has its evidence:

| Need | Its evidence |
|---|---|
| `second-review` | A review recorded by the `second` seat (a different model, `models.secondReviewer`) on the reviewed tree. |
| `failing-test` | A `test.run` of kind `risk-base` that failed on the merge-base: the repo's `fast` tests run there with the attempt's changed test files (`kinds.tests`) applied. Named failure: tests that asserted nothing. |
| `diff-read` | The person's diff-read answer. It is asked once nothing blocks and every other need has its evidence; with `review.diffRead: before` the merge waits for it. |
| Any other text (a scenario to exercise, a case to check) | The second seat's verdict, `met: [{ need, met, how }]` in its closure. The second seat is launched for it and must give a verdict on each. |

The needs of every first-seat judgement in the attempt stand: a later round never drops an earlier need. A need without its evidence refuses the merge (`merge:risk`). Named failure (0.8.0): the scan-proposed risk paths of a real project covered 130 areas, almost the whole codebase (one matched a whole repo because a lint config named a currency), so nearly every change would have taken the slowest tier, and the person would not maintain or answer path lists.

**Reserved decisions.** These belong to the person:

- a production deploy;
- waiving a blocking finding of any class or severity;
- loosening criteria after a blocker;
- the diff-read a reviewer asks for;
- a merge whose history includes a branch other than main;
- the no-progress stop.

Holds are the person's own control. Sign-offs, priority `other` findings and stops are collected into one **daily digest**. A blocking question is also asked immediately. Whether the diff-read happens before or after the merge is a project setting chosen at onboarding (`review.diffRead: before | after`). With `after`, the merge proceeds and the person keeps the authority to revert.

**Answers.** An answer counts only when all of these hold:

- it comes from a human-typed turn: not a notification, a tool result or injected content;
- it is the first person turn after the question was shown, in any session of the project, or an answer in the question panel;
- if it is a bare "yes", "ok" or similar, it came immediately after that question.

This applies from day one. Named failure: 283 of 304 recorded "owner decisions" in 0.6 were the agent's own command.

### Refusals (each a fact check)

| Id | When | Named failure |
|---|---|---|
| `start:open` | The item already has an open or held attempt. | Id collision (D11c). |
| `criteria:max` | More than 6 criteria. | 131 amendments over 13 criteria. |
| `review:tree` | The recorded review's tree is not HEAD. | Stale reviews (principle 3). |
| `review:independent` | The reviewer's session implemented, or `wf` did not launch it, or its transcript contradicts the review file. | Steered or self review. |
| `review:coverage` | Product files in the diff are unread by the reviewer. | 8-minute sampled first review. |
| `finding:other-own` | `other` on a line this attempt wrote. | 41% of later defects came from repairs. |
| `screens:width` / `screens:dup` | A capture's width does not match, or its bytes duplicate another screen. | I-117; a stuck page. |
| `merge:open` | A `goal` or `regression` finding is open. | The person's findings rule. |
| `merge:unreviewed` | Anything other than git's automatic merge from main changed since the last reviewed tree. | Unreviewed edits after review; base-merge resolutions (I-233). |
| `merge:foreign` | A merge commit's second parent is not main, or is reachable from another remote branch. | Staging and sibling merges. |
| `merge:untested` | The `fast` tests are not green on HEAD, or no passing `full` run on the landed tree, from the landing queue or CI. | Push-to-main with no CI. |
| `fix:no-progress` | An implementer handoff after a review that reopened a fixed finding or did not lower the blocker count, until the person decides. | The person's stop rule; rounds with blockers flat for 18 rounds. |
| `merge:risk` | A need a first reviewer's `risk` names lacks its evidence: the second review, a test that fails on the merge-base, the second reviewer's verdict that a free-text need is met, or the diff-read with `diffRead: before`. | The person's risk tier. |
| `merge:waiver` | A waiver or a loosened criterion is unanswered. | Reserved decision. |
| `stage:deploy` | A production deploy without the person's decision. | Reserved decision. |
| `hold` | Any delivery step under a hold. | The person's veto. |
| `answer:not-person` | The answer fails the answer rule above. | 283 of 304. |

That is 18 refusal ids (19 in 0.8.0; 0.8.1 removed `review:size`, which refused a risk change above the split size), against more than 300 in 0.7.35.

## 3. Engine modules: keep, cut, rewrite

| Module(s) | Lines | Verdict | Reason |
|---|---|---|---|
| `lifecycle.mjs` | 4403 | **rewrite** → `flow.mjs` (~800) | Criteria, the bundle, review record, fix-round counting, merge preconditions. |
| `gate.mjs`, `machine.mjs`, `junit.mjs`, `failures.mjs` | 2512 | **cut** → `tests.mjs` (~300) | Runs `fast` and `full` with a machine-wide counted lock and a completion notification. Reuse, selection, quarantine, fair queues and worker sizing are gone; implementers waited on them instead of editing. |
| — | — | **new** `landing.mjs` (~400) | The landing queue (section 5). |
| `validation.mjs`, `captures.mjs`, `run-screenshots.mjs` | 883 | **cut** → `screens.mjs` (~350, keeps `image-size.mjs`) | Per-ticket proof steps stayed in the shared gate permanently. Screens are now per run. |
| `strategy.mjs`, `course.mjs`, `diagnosis.mjs`, `signals.mjs`, `expectations.mjs` | 2186 | **cut** | The strategist is removed. |
| `review-policy.mjs`, `scope-decisions.mjs`, `discovered.mjs`, `leaving.mjs`, `channels.mjs` | 1514 | **rewrite** → `findings.mjs` (~350) | The three classes, the blame check (taken from `introduced.mjs`), de-duplication and filing. These replace the severity-leaving policy (D10, D17, D18). |
| `review-groups.mjs` | 440 | **rewrite** → part of `flow.mjs` | The split by area only. Flow surveys are gone. |
| `causes.mjs`, `split.mjs`, `panel.mjs`, `impact.mjs`, `scope.mjs`, `premise.mjs`, `product-decisions.mjs`, `analysis.mjs`, `advance.mjs`, `role-progress.mjs` | 1927 | **cut** | Paperwork in 100–560 KB bundles, or a stop. |
| `approve.mjs`, `asking.mjs`, `owner.mjs`, `runtime-policy.mjs`, `hosts/questions.mjs` | 1204 | **rewrite** → `decisions.mjs` (~400) plus `digest.mjs` (~150) | Reserved decisions, the answer rule, the daily digest. Same-session binding, ownership and adoption are gone. |
| `evidence.mjs`, `evidence-read.mjs`, `paths.mjs`, `hooks/guard-evidence.mjs` | ~1700 | **cut** | Manifest, anchor and the guard hook (334 guard refusals, 69% naming no evidence folder). The threat model is D6. The ledger's hash chain stays. |
| `ledger.mjs` | 876 | **rewrite** (~300) | Schema 2 events. Reads schema 1. |
| `attempt.mjs` | 771 | **rewrite** (~500) | Start, id normalisation, numbering, provision, hold, abandon, close as shipped (patch-id), cleanup. |
| `base.mjs`, `merges.mjs` | 456 | **rewrite** → `base.mjs` (~250) | Fresh base at start. The `merge:unreviewed` and `merge:foreign` facts come from D87's merge-tree comparison. |
| `targets.mjs`, `adapter-follow.mjs`, `models.mjs` | 553 | **cut** | Ports belong in a project module. The adapter is read live, with the stage list snapshotted at start. |
| `tracker.mjs`, `status-route.mjs`, `host-record.mjs`, `hosts/codex-tool.mjs` | 1452 | **rewrite** → `tracker.mjs` (~550) | Connector operations (D68), idempotency markers, search before write, `pending` labels. |
| `deployment.mjs`, `deployment-step.mjs` | 367 | **rewrite** → `delivery.mjs` (~550) | Stages, per-repo bases and order, patch-id matching, authority flags. |
| `telemetry.mjs`, `introduced.mjs`, `refusals.mjs` | 852 | **rewrite** (~750) plus `legacy07.mjs` (~350) | Section 7. |
| `lessons.mjs`, `lessons-format.mjs`, `learning.mjs`, `improve.mjs` | 1678 | **rewrite** → `learn.mjs` (~400) | Section 8. Nothing is committed into product repos. |
| `config.mjs` | 670 | **rewrite** (~400) | Schema 2 and the adapter budget. |
| `onboard.mjs` | 940 | **rewrite** → `onboard.mjs` (~550) plus `scan.mjs` (~350) | Re-runnable onboarding (section 5), `doctor`, `sync`, registry. |
| — | — | **new** `migrate.mjs` (~300) | Section 9: attempts and material only. The adapter part is an onboarding run. |
| `cli.mjs` | 1818 | **rewrite** (~450) | About 20 commands. |
| `launch.mjs`, `hosts/*` | ~2400 | **rewrite** (~1,500) | Launch with the bundle as the whole prompt. Capacity resume (D61). The transcript store adds a "files read" reader for coverage and a "human-typed turn" reader for answers. `provenance.mjs` and start-prompt verification are cut. |
| `export.mjs` | 247 | **cut** | Replaced by `wf report`. |
| `versions`, `topology`, `rules` (paths → read only), `env`, `secrets`, `scrub`, `state-folders`, `util`, `skills`, `process-tree`, `image-size`, `hooks/session-rules` | ~1,300 | **keep** | `file-kinds` folds into `config`. Design-system patterns move to the repos' lint. |

**Removed commands:** `adopt advance analysis batch captures decide decisions discovered evidence export impact intent lesson(s) models plan scope shown signals split strategy summary target topology unlock validation verify`, and the `gate` family.

**Commands kept or new:** `start criteria test screens review handoff approve digest hold release land deliver status resume close abandon doctor init sync report learn migrate secrets`.

**Where revision 2 grew the core:**

| Addition | About | Pays for |
|---|---|---|
| Landing queue | +400 | The retest race without CI. |
| Coverage and answer readers in hosts | +300 | Shallow reviews; agent-made answers. |
| Screens selection, sentinel, width and duplicate checks | +200 | Screens are the second-best defect source. |
| Per-repo stages, patch-id, idempotency, `pending` | +350 | The real adapters' delivery. |
| Criteria hash, blame class, fix-round count per item, merge facts | +250 | Agent-behaviour failures. |
| Digest | +150 | The person's waiting time. |
| Budget and release counts | +150 | Regrowth. |
| Migration hard cases | +200 | The module-heavy project. |
| Onboarding scan and re-run diff | +450 | Per-project policy (revision 3; 0.8.1 removed the risk paths). |

## 4. DESIGN.md decisions

**Survive (30), most of them shortened:**

- **D4:** reduced to the reserved list in section 2.
- **D5, D6, D7, D8.**
- **D9:** the principle only. The engine judges no work against a number it picked. The person's numbers are theirs, and every engine number is derived from a baseline (section 8).
- **D12.**
- **D14.**
- **D16:** by patch-id.
- **D19:** project learning changes only what roles read.
- **D21:** rules live in the plugin.
- **D24:** the first half.
- **D26.**
- **D27:** an older copy runs the installed one.
- **D29:** plain questions, never asked twice.
- **D30.**
- **D34.**
- **D39 and D40:** folded into stages.
- **D41:** under the answer rule.
- **D42:** a stage.
- **D54.**
- **D60:** read live, with stages snapshotted at start.
- **D61.**
- **D63.**
- **D68.**
- **D73:** the first half.
- **D74.**
- **D83:** with the budget check.
- **D90.**

**Retired (60, plus the mechanism of D9):**

| Group | Decisions | Why |
|---|---|---|
| Strategist, course, escalation | D3, D33, D44, D84, D86 | The role stopped agents and added rounds. |
| Rounds, evidence and delta reviews, divided review | D2, D13, D20, D48, D50, D53, D69, D70, D76 | Replaced by D93. |
| Severity leaving, per-item questions, discovered issues, premise | D1, D10, D17, D18, D35, D38, D45, D71, D85 | Replaced by D92. These rules made unrelated defects mandatory work. |
| Fix-round content | D36, D46, D51, D64 | One line in a role text. |
| Gate reuse, light-only, needs, affects, leases, batches | D22, D23, D47, D49, D56, D57, D58, D59, D75 | Replaced by `fast`/`full`, the counted lock and landing. |
| Per-ticket proof and corrections | D11, D37, D78, D79, D80, D82, D88, D89 | Per-ticket steps are gone. |
| Plans, panels, briefs, analysis | D9 (mechanism), D28, D52, D65, D66, D67 | Plain criteria. |
| Evidence integrity | D15, D77 | The manifest and the guard are gone. |
| Base, targets, outside pushes | D31, D62, D72, D81, D87 (its comparison moves into D97) | Fresh base plus the merge facts. |
| Answers, screenshot ranking | D25, D32, D43, D55 | The answer rule; screens per run. |

**New decisions:**

- **D91:** the flow.
- **D92:** the three-class findings rule.
- **D93:** whole-diff reviews in parallel with tests, a split above the size limit, no round cap, and the no-progress stop (the same finding reopens, or the blocker count does not go down).
- **D94:** the risk tier, judged per change by its first reviewer, whose `risk.needs` the engine checks as facts; no risk paths (revised in 0.8.1).
- **D95:** reserved decisions, the answer rule and the digest.
- **D96:** ticketing and delivery are the project's.
- **D97:** no sequencing, the landing queue, and the merge facts.
- **D98:** measured learning and the budget.
- **D99:** nothing committed in product repos is required.
- **D100:** onboarding sets project policy and can be re-run at any time; migration from 0.7 is an onboarding run.

**Principles:**

- **Retired:** principles 5 and 7.
- **Reworded:** principle 2 reads "facts from git, the ledger and the host's records", and principle 4 reads "criteria first, hashed, not frozen". Principle 8 becomes the counted, machine-wide lock.

## 5. The project adapter (schema 2)

The adapter lives in one of two places:

- In the user folder, as `~/.agentic-workflow/projects/<name>.yaml`. This copy needs an explicit `root:`, and the engine keeps it in a git repository of its own, so it has a history.
- In a repo, as `.workflow/project.yaml`.

Having both copies is refused. `requires` (connectors, tools, skills) stays. Module paths are always `{ repo: <name>, path: <file> }`, resolved in the attempt's worktree of that repo.

**Adapter budget.** `doctor` reports the adapter's rules, modules and operation words against `budget.adapter`. A net increase needs a project proposal (section 8).

**A push-to-main project with no CI:**

```yaml
version: 2
name: example
root: ~/src/example
repos:
  - name: api
    path: api
    base: main
    provision: { clone: [node_modules], fingerprint: [yarn.lock], install: yarn install --immutable, copyIgnored: [.env.local] }
    tests:
      fast: { run: "yarn lint && yarn typecheck && yarn test" }
      full: { run: "bash scripts/gate.sh all", lock: { name: docker, count: 1 } }   # machine-wide, across projects
    kinds: { tests: ["test/**", "**/*.spec.ts"], other: ["docs/**", "**/*.md"] }
  - name: web
    path: web
    base: main
    tests:
      fast: { run: "yarn lint && yarn test" }
      full: { run: "yarn test:e2e", lock: { name: docker, count: 1 } }
components:                             # consumers of changed contracts, for the bundle
  - { id: web, repo: web, dependsOn: [{ contract: "api/src/**/*.controller.ts" }, { contract: "api/src/**/dto/**" }] }
invariants: api/.workflow/AGENTS.invariants.md   # the old `quality` lines move here
rules: [{ paths: ["web/src/**"], read: [web/DESIGN_SYSTEM.md] }]
screens:
  routes: { repo: web, path: scripts/routes-of.mjs }      # changed files -> routes
  shared: ["web/src/common/**", "web/src/styles/**"]
  sentinel: ["/", "/settings", "/items/new"]
  langs: [{ lang: <code>, dir: <ltr|rtl> }]   # each language and direction the project ships
  viewports: [390, 1440]
  capture: { module: { repo: web, path: scripts/capture.mjs } }   # or { run: "<command> --out {out} --viewport {viewport} {routes}" }; unset (or `screens: none`): no screens
review: { diffRead: before }           # or after: a project setting from onboarding
ticketing:
  tracker: <the tracker the project uses, through its connector or a module>
  via: connector
  idPattern: '^ENG-\d+$'
  take: { status: In Progress }
  followUps: { mode: file, team: ENG, status: Backlog, label: found-in-review }  # labels are never copied
  operations: { fileFollowUp: "Create an issue in team ENG ...; read it back.", search: "Search open issues for ..." }
delivery:
  landing: queue                        # see the landing queue below
  order: [api, web]                     # each repo's part lands separately, in this order
  stages:
    - { do: land, branch: main }
    - { do: status, to: Ready for UAT, comment: uat }
budget: { adapter: { rules: 4, modules: 1, operationWords: 120 } }
```

**A merge-request project whose tests, tracker and delivery are its own modules:**

```yaml
repos:
  - name: app
    path: app
    base: master
    tests:
      fast: { module: { repo: app, path: .workflow/steps/unit.mjs } }
      full: { module: { repo: app, path: .workflow/steps/e2e.mjs }, lock: { name: browser, count: 1 } }
  - { name: mobile, path: mobile, base: dev, tests: { fast: { run: "npm test" } } }
ticketing:
  tracker: { module: { repo: app, path: .workflow/tracker/pages.mjs } }
  via: connector
  followUps: { mode: off }              # opt-in per project
delivery:
  authority: { push: agent, mergeRequest: agent, merge: person }
  order: [app, mobile]
  stages:
    - { do: merge-request, repos: [app, mobile] }   # each against its own base; records the accepted commit per repo
    - { do: wait-merged }                           # matches by patch-id; CI and the project's reviewers decide
    - { do: status, to: In UAT, comment: uat }
    - { do: confirm-deployed, where: production, when: { labels: [Hotfix] } }   # read-only, then test there
    - { do: status, to: Done, when: { labels: [Hotfix] }, comment: deployed }
```

**Stages.** The stage kinds are `land`, `push`, `merge-request`, `wait-merged`, `confirm-deployed`, `deploy` (always reserved), `status`, `comment` and `module`. `when:` filters a stage by labels. A label the engine could not read is `pending`, never false, and the stage waits for it. `after: <item>` is the only cross-ticket wait. Every comment and filed ticket carries an idempotency marker (`wf:<attempt>:<stage>`), and the engine searches for the marker before writing. A `deploy` stage always asks the person; a project whose merge deploys leaves the merge to the person (`authority.merge: person`) and lists no `deploy` stage. Telemetry records the time spent waiting in each stage.

**Landing queue** (`delivery.landing: queue`, for projects with no CI where the full suite takes 40–70 minutes):

1. Tickets that are ready (reviewed, `fast` green, decisions answered) enter the queue.
2. The engine stacks every ready ticket onto the current main in a landing worktree and runs `full` once.
3. On green, it pushes them all.
4. On red, it bisects to find the failing ticket, lands the rest, and returns that ticket to its implementer with the failure.

The queue never holds a ticket for one that is not ready, so it is a merge train, not a bundled release. Without the queue, parallel pushes each need a fresh `full` run on the moved main, and they race.

**Onboarding sets the project's policy.** `wf init` (alias `wf onboard`) owns every policy key:

- `review.diffRead`;
- the delivery stages;
- the ticketing operations;
- the `fast`/`full` test split;
- the screens settings.

The steps:

1. `scan.mjs` reads the repos as facts, with no domain vocabulary of the plugin's own: CI files, test scripts and test files, mobile apps, and the project's own instruction and invariants documents. It reads no code shapes: what a change risks is judged per change by its reviewers (D94), never proposed as paths.
2. A cheap model drafts the policy from the scan.
3. The person confirms or edits the draft.

**Re-running onboarding.** Onboarding can be re-run at any time to re-evaluate the project.

- It re-scans, then shows a per-key diff against the current adapter, with the reason for each change.
- It writes only what the person confirms.
- Keys the person edited by hand are tracked by a hash in the adapter's own history. They are shown before any change and are never overwritten silently.
- A run with nothing to change writes nothing, so it is idempotent.
- Its output counts against the adapter budget.

**Dropped keys:** `lanes`, `classes` (only a model per role remains), `panel`, `strategy`, `impact`, `leaving`, `severity`, `learning.classifier`, the `gate.*` fields (select, affects, specs, needs, reads, artifacts, light/heavy), `quality` (moved into the invariants), `designSystem` (moved to lint), `adapterRepo`, `instructionFiles`, `delivery.deployment` and `tracker.statusByLabel` (both now stages).

## 6. Role texts

Each role text is under 150 words. The bundle carries the project's rules.

- **Work skill (owner):**
  - Start every admitted ticket as its own background attempt.
  - Write or get 1–6 plain criteria.
  - Hand off to an implementer, then run `wf review`, which launches reviewers with only the bundle.
  - Run fix rounds for blockers only.
  - Never fill a wait by polling; `wf` notifies.
  - Do what `wf status` names.
  - Ask the person only what `wf` names, in plain words, once.
- **Planner:**
  - Write 1–6 criteria that a user or a test can check, and name the touched areas.
  - Name each addition beyond the request and why (D54).
  - If more than six criteria are needed, propose a split.
- **Implementer:**
  - Make the smallest change that removes the cause.
  - Run `wf test fast` and `wf screens`, then commit.
  - Report anything outside the goal; do not fix it.
  - On a fix round, fix the cause wherever the change depends on it.
  - Tests assert state or output, not call counts.
  - When a review needs it, add a test that fails without the fix.
- **Reviewer:**
  - You did not write this change. Read every product file in the diff and the code it depends on, against the criteria, the invariants and the rules.
  - Open every screenshot.
  - Check the listed consumers of changed contracts.
  - Each finding needs `path:line`, what is wrong, why it matters, a severity, and a class: `goal`, `regression` or `other`.
  - On a later round, verify the listed blockers, then re-read the whole change.
  - Judge the risk as the risk guidance says, and give `risk` (first seats) or `met` (the second seat).
  - Do not fix.

Removed from every text: the strategist, evidence rounds, the closure's scope/expect/notReached, the priorFindings, premise and correction forms, baseMerge classes, the workflowRules dump and severity tables.

## 7. Telemetry

**Schema 2 ledger events:** `attempt.started` (carrying the stage snapshot), `criteria.set` (with its hash), `test.run`, `screens.captured`, `handoff`, `review.recorded` (with coverage), `finding.filed`, `decision.asked`, `decision.answered`, `hold`, `release`, `base.updated`, `stage`, `landing`, `attempt.closed`.

**Per-ticket row.** Rows are stored in `~/.agentic-workflow/telemetry/<project>.jsonl` with schema `wf-ticket@1`. Each row can be rebuilt from the ledgers, git and the host transcripts.

| Field | Definition |
|---|---|
| `wallMin`, `activeMin` | From start to close. Active time is the union of gaps of 30 minutes or less between activity (ledger events and transcript turns). |
| `unexplainedGaps[]` | Gaps over 30 minutes with no event and no pending decision. |
| `personWaitMin`, `holdMin`, `stageWaitMin{}` | Time waiting on the person's decisions, time under hold, and time per stage. |
| `reviews`, `blockingReviews`, `emptyReviews`, `fixRounds`, `coverage` | `fixRounds` is counted per item. |
| `testRuns.{fast,full}`, `testMin`, `landing.{batches,bisects}` | — |
| `diff.{product,tests,other}` | Classed by `kinds`. |
| `findings.{goal,regression,other,filed,digested}`, `introducedByRepair` | Blame to the fix round. |
| `refusals.{count,byId}`, `screens`, `riskTouched` | — |
| `rework.{lines,share,commits}` | Filled 48 hours after delivery. Lines the delivery wrote that a later commit not belonging to this ticket rewrote. |
| `tokens`, `cost` | — |

`wf report` shows medians per project and per engine version. It also lists commits on main that no attempt covers.

`legacy07.mjs` maps schema-1 ledgers onto the same row:

- It takes the first terminal event as the end.
- It rolls batch members up into their tickets.
- It keeps the old project names, which stay local and never reach the public repository.

The first test of this design is comparing 0.7 with 0.8 on the same fields.

## 8. Learning, and the budget against regrowth

The old plugin grew by adding a rule after each incident. In 0.8, every change of shape needs a measured proposal, whatever its source.

**What is rule-shaped is a fact of the diff.** A change is rule-shaped when it adds any of these:

- a refusal id;
- a command;
- an adapter key;
- an event type;
- words in a role, skill, hook or session-rules text.

`scripts/release.mjs` counts all five and compares them with `budget.json`, which is committed in the plugin repo and holds the last release's counts (0.8.1 lowered them: one refusal, one adapter key and words fewer). **Any net increase fails the release** unless a kept or active proposal accounts for it. Bug fixes are classified by the same facts: a fix that adds a refusal is rule-shaped.

**A proposal** has these fields:

- `source`: `telemetry`, `incident` or `person`;
- `scope`: project or plugin;
- `change`;
- `replaces`: required; the free-text escape `whyNotReplace` is removed;
- `metric` and `guard`: row fields;
- `expires`;
- `status`.

**Rules for proposals:**

- **Drafting.** `wf learn` drafts a proposal only when a metric leaves its baseline band, the median ± spread over the project's last 8 tickets. An incident becomes a proposal only once it recurs. A rule the person gives becomes a proposal with `source: person`. It skips drafting, but it still needs a metric, what it replaces and an expiry.
- **Minimum move.** The engine sets it from the baseline spread; the drafter does not choose it.
- **Concurrency.** One active proposal per metric per project, and one plugin proposal per release.
- **Judging.**
  1. A proposal is judged after 8 tickets or 21 days, whichever comes later.
  2. If the metric moved by the minimum and the guard held, it is kept. Otherwise it is reverted.
  3. Missing data means revert.
  4. A kept proposal expires after 90 days and must be judged again.
  5. A reverted proposal cannot be proposed again for 60 days.
- **Who applies it.** Project proposals are applied and reverted automatically, and change only what roles read (D19). Plugin proposals go to the maintainer, sanitised.

**Decided by the person.** The hard budget is accepted. It amends the person's standing rules: its named failure is the growth to 90 decisions, and the person's own rules enter the plugin as proposals with `source: person`.

## 9. Migration

Migration is prototyped first on the hard case: the project whose tests, tracker and delivery are modules inside `.workflow/` (stream F, day 1).

| What | Path |
|---|---|
| Open 0.7 attempts | `wf migrate attempts` skips held attempts and lists them for the person (one is held with "stop everything"). For every other open attempt, it appends `attempt.closed {outcome: superseded}`, removes clean worktrees and keeps the branches. For each attempt it prints the item, the branch, the unmerged commits and the last review state. Work already on its target, detected by patch-id (`git cherry`), is closed as shipped, and its pending tracker step is printed. Tracker statuses are left untouched. |
| Adapters | Migration of the adapter is an onboarding run seeded from the schema-1 adapter: `wf init --from-07`. It maps tests and tracker and delivery modules to `{ repo, path }` modules, and maps statuses and labels to stages. It drops per-ticket validation steps by name: those that 0.7 ledgers recorded as `validation.added`. It moves `quality` into the invariants. It proposes no risk and asks no risk question. Screens are optional: it seeds `screens.capture` from the old step that collected artifacts only when that command writes each screen to `{out}`, and otherwise says why none is proposed; with no capture there are no screens. Every dropped key is printed. The person confirms as in any onboarding run. |
| Material in product repos | 0.8 reads none of it. `wf migrate material` lists the tracked files under `.workflow/` that the new adapter does not reference. It also greps product code for imports into `.workflow/` (for example a capture helper under a product test folder), because removing those breaks product code. Decided: one removal ticket per repo right after 0.8 ships. Each ticket also fixes the product code that imports the material. |
| Lessons, improvements | The improvement inbox holds 223 items: 0 open, 209 closed and 14 retired. It is archived. A lesson with recorded recurrences becomes a `proposed` project proposal. |
| Old ledgers, numbering | They stay in place and remain readable. New attempt numbers continue after the old ones. |
| Instruction files | `wf doctor` lists lines that name removed commands (`--intent analysis`, `batch`, `--defer-heavy`, lanes). |

## 10. Tests

**Delete** every scenario for:

- strategist, course and batch;
- gate and validation;
- captures and discovered issues;
- scope and approve-question;
- deadlocks and base-merge;
- review rounds and evidence integrity;
- the `fix-07xx` regressions.

**Keep and adapt:** `privacy`, `release-script` (plus budget counting), `docs-links`, `host-boundary`, `host-plugin`, `codex-run`, `codex-runtime-compat`, `state-folders`, the secret parts of `security-0.5`, `text-payloads`, `tracker-files` and `tracker-github`.

**New scenarios, about 28 files and 6,000 lines:**

- start from a fresh base, with id normalisation and numbering;
- the criteria limit, hash and loosening waiver;
- bundle contents, including consumers and the split by size;
- coverage refusal from a fixture transcript;
- the three classes and `finding:other-own`;
- fix-round counting across restart;
- the no-progress stop;
- risk: each need a reviewer names has its evidence (a second review and its verdict, a test that fails on the merge-base, the diff-read);
- screens selection, sentinel, width and duplicate checks;
- `merge:unreviewed` and `merge:foreign`;
- the landing queue: batch, bisect, and no wait for an unready ticket;
- per-repo merge requests with patch-id matching;
- idempotent comments and search-first filing;
- `pending` labels;
- two parallel attempts with the machine-wide lock;
- the answer rule: a notification, a late "yes", and a panel answer;
- the digest;
- telemetry rows from 0.8 ledgers and from a 0.7 ledger with a batch;
- learning: the band, the judge, revert on missing data, expiry and the re-proposal block;
- the budget failing a release;
- each migration command, including the module-adapter case and held attempts;
- onboarding: the scan proposes no risk and needs no capture; a re-run on an unchanged project writes nothing; a hand-edited key is shown and kept unless confirmed; `--from-07` on the module-adapter fixture.

One end-to-end demo replaces `hello-ticket`.

## 11. Risks, and what would show the cut went too deep

Every response below either removes something or goes through section 8.

| Risk | Signal | Response |
|---|---|---|
| Whole-diff reviews miss what many rounds caught | `rework.share` or later defects above the 0.7 baseline | A proposal: a stronger review model, replacing the second risk reviewer's model or effort setting. |
| Landing bisects repeatedly on one flaky suite | `landing.bisects` per batch | A proposal that removes the flaky suite from `full`, owned by the project. |
| Filed `other` findings flood the tracker | `findings.filed` per ticket outside its band | The project switches `followUps.mode` to `digest`. No new mechanism. |
| The no-progress stop asks the person too often | `personWaitMin`, stops per ticket | A proposal on the stop rule (the person's call). |
| Parallel tickets collide in shared files | `merge:unreviewed` refusals per ticket | `after:` in the project. The engine still does no sequencing. |
| The coverage check burns reviewer time on generated files | `review:coverage` refusals | A proposal that replaces a coverage path rule by moving those files to `kinds.other`. |
| Tamper beyond the hash chain | A ledger edit found by `wf report` | Accepted under D6. |
| A ticket edits the capture script it is judged by | `screens.capture` is a shell command run from the attempt folder, unlike the test and routes modules, which load from the base | Accepted: captures stay guarded by the width and duplicate checks, and the reviewer judges every image. |

## 12. Build plan

There are eight streams. Each stream writes only the files it owns. Stream 0 lands first, and nothing else starts until it has.

**Stream 0, the seam contract (about 1 day, ~400 lines).** It writes:

- `engine/contract.mjs`: the schema 2 event catalogue and payload shapes, the normalised adapter type (including the onboarding-owned policy keys and their hashes), and every cross-stream signature in the table below, as stubs that throw "not built";
- `budget.json`, with the target 0.8.0 counts;
- `scenarios/helpers/` fixtures: a git repo pair, fake trackers, a fixture host transcript, and a 0.7 ledger with a batch.

**Streams 1–7 run in parallel after stream 0.**

| Stream | Owns (writes only these) | Exposes (in `contract.mjs`) | Size |
|---|---|---|---|
| 1 Flow | `flow.mjs`, `findings.mjs`, `attempt.mjs`, `base.mjs`, `cli.mjs`, `bin/wf`; `scenarios/flow-*` | `start`, `setCriteria`, `bundle`, `recordReview`, `noProgress(item)`, `mergeFacts(attempt) → problems[]` | ~3,100 |
| 2 Tests, screens, landing | `tests.mjs`, `screens.mjs`, `landing.mjs`, `env.mjs`, `process-tree.mjs`, `image-size.mjs`; `scenarios/tests-*`, `landing-*`, `screens-*` | `runTests(attempt, repo, kind) → {pass, tree, ms}`, `capture(attempt) → images[]`, `land(ready[]) → {landed, failed}` | ~1,100 |
| 3 Tracker, delivery | `tracker.mjs`, `delivery.mjs`, `adapters/tracker/*`; `scenarios/delivery-*` | `normaliseId`, `search`, `fileFollowUp → id`, `runStage(attempt, stage) → {state, evidence}` | ~1,100 |
| 4 Decisions, hosts | `decisions.mjs`, `digest.mjs`, `launch.mjs`, `hosts/*`, `hooks/*`; `scenarios/decisions-*`, host tests | `ask`, `answered(id)`, `launchReviewer(bundle) → session`, `filesRead(session) → paths[]` | ~2,050 |
| 5 Telemetry, learning | `ledger.mjs`, `telemetry.mjs`, `legacy07.mjs`, `introduced.mjs`, `refusals.mjs`, `learn.mjs`; `scenarios/telemetry-*`, `learn-*` | `append`, `row`, `blameToAttempt(path:line)`, `propose`, `judge` | ~1,800 |
| 6 Config and texts | `config.mjs`, `templates/**`, `skills/**` | `loadAdapter(root) → Adapter`, `adapterBudget(adapter)` | ~400 code, ~1,200 words of text |
| 7 Onboarding and migration | `onboard.mjs`, `scan.mjs`, `migrate.mjs`; `scenarios/onboard-*`, `migrate-*` | `scan(root) → facts`, `proposePolicy(facts, current) → diff`, `writeAdapter(diff, confirmed)` | ~1,200 |

**Stream 8, release, docs and deletion (last, ~200 lines plus docs).** It owns `scripts/release.mjs` (the five counts against `budget.json`), `docs/**` (DESIGN.md gets D91–D100 and the retirement table), `README.md` and `CHANGELOG.md`. It deletes the cut modules and scenarios once streams 1–7 are green.

**Order:**

1. Stream 0.
2. Streams 1–7 in parallel. Stream 7 prototypes the module-adapter conversion on day one, against stream 6's `loadAdapter` stub. Stream 1 runs against stubs from day one, and each other stream replaces its stub when its scenarios pass.
3. Integration: the full suite, then the 0.7 versus 0.8 telemetry comparison on the fixture ledgers.
4. Stream 8.
5. The first 0.8 tickets are the per-repo removal tickets (D99).

**Seams:**

- Only stream 1's `cli.mjs` wires commands, each to a handler the owning stream exports.
- Ledger writes go only through `append` (stream 5).
- Adapter reads go only through `loadAdapter` (stream 6).
- Only stream 7 writes adapter files.
- The full suite runs per stream before merging.

**Estimated total:** about 11,000 engine lines (the stream sizes summed, kept modules included), against 30,700 today, plus about 6,000 scenario lines, against 30,800 today.

## 13. Decided by the person (no open questions remain)

1. **The fix-round stop.** A ticket stops on no progress only: the same finding reopens after a fix, or the blocker count does not go down. There is no round cap (D93).
2. **Risk.** 0.8.0 had each project's risk paths proposed by the onboarding scan and confirmed by the person. On a real project that proposed 130 areas, and the person ruled it out: "For the risks, again, you are being very specific, which will lead to issues". 0.8.1 has the first reviewer judge each change's risk and name its needs; the engine checks only their evidence (D94).
3. **The growth budget.** It is accepted as a hard budget. The person's rules become proposals with `source: person` (D98).
4. **When the diff-read happens.** This is a project setting chosen at onboarding. Onboarding sets all project policy, can be re-run at any time to re-evaluate the project, and never drops a manual edit without showing it. Migration from 0.7 is an onboarding run (D100).
5. **The workflow material in product repos.** One removal ticket per repo right after 0.8 ships, fixing the product imports of it in the same change (D99).
