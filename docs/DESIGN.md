# agentic-workflow — design

Status: v0.1 implemented. Scenario tests in `scenarios/` are the executable form of this design; where they differ, the tests win and this file is fixed.

agentic-workflow runs software changes through a fixed lifecycle with AI coding agents:
admit a ticket → isolated worktree → plan → implement (committed) → independent review → fix → gate → evidence pass → accept → deliver → tracker handoff.
It ships as one user-level plugin for Claude Code and Codex. Each project opts in with an adapter
(`.workflow/`) that describes its repos, components, commands, tracker and delivery.

## Principles

Each principle comes from a failure seen while running agent-driven delivery on real projects.

1. **One trust boundary.** Authority to deliver = the ticket was admitted with implementation intent and no hold is recorded. The engine never parses prompts or transcripts to decide what is allowed; doing so produced rotating false refusals and collapsed throughput.
2. **Evidence, not statements.** Every lifecycle step reads evidence files the engine wrote. No step accepts an agent saying it did something.
3. **Independent review.** The reviewer is never the owner, planner or an implementer, and every review round is a new reviewer agent that reviewed no earlier round of the attempt (checked from the ledger). The planner leaves the tree unchanged; acceptance needs a clean closure written for the exact tree being accepted.
4. **Requirements first.** Acceptance criteria are frozen before implementation. At acceptance each criterion maps to evidence (a gate test, a screenshot, a command output) or a justified `not-applicable` / `dropped-with-reason`. One test per criterion is not required.
5. **Fast gates by reuse, not by skipping.** Suite-level content-hashed reuse; only related proof while repairing; one full gate per settled tree. No "break the fix to prove the test fails" steps.
6. **Interruptions keep work.** Stop/resume and recovery from a dead runner keep the suites that already finished.
7. **Base-branch movement is not a reset.** A gate reopens only when the new base touches the ticket's paths or shared infrastructure; otherwise the result carries forward.
8. **Single-machine friendly.** Workers sized from measured free memory; never touches processes it didn't start; leases are ownership while running, never a queue.
9. **Isolation.** One worktree per repo per attempt. Cleanup is part of delivery.
10. **Delivery is not a push.** An attempt is done only after the tracker handoff is written and read back.
11. **Versioned state.** Manifests record schema and engine version. The engine reads the previous schema and refuses older ones with the exact version to finish them on.
12. **Reproduce before blaming.** `wf doctor` runs the gate on a clean base before a change is blamed for an environment failure.
13. **No ceremony without a named failure.** A new refusal, limit or check needs a concrete incident it would have caught and a measured false-positive rate.
14. **Agents never handle secret values.**

## Shape

```
agentic-workflow/
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  engine/          # state machine, evidence, gate runner, review closure, delivery (Node, stdlib + YAML)
  bin/wf           # the one CLI every agent calls
  skills/          # onboard, work, quick-fix, resume, secrets
  templates/agents # role templates: planner, implementer, reviewer (tester: opt-in); `wf sync` writes project agents from them
  hooks/           # manifest edit guard only
  adapters/
    tracker/       # linear, none
    delivery/      # push-main
  templates/       # AGENTS.md block, project.yaml skeleton, comment templates
  scenarios/       # behaviour fixtures every release must pass
```

- The plugin holds no project rules. `AGENTS.md` is the only instruction file it writes (Claude Code and Codex both read it). It never creates or edits `CLAUDE.md`.
- The project adapter lives in the project, committed: `.workflow/project.yaml`, step plugins, invariants, role appendices, vendored skills, secrets catalog.
- The plugin never migrates anything from a previous workflow. Projects are onboarded; what they used before is their own business.

## Enable / disable

- Enabled = `.workflow/project.yaml` exists with `enabled: true`. The plugin is always installed and never activates itself.
- `wf enable` / `wf disable` flip the flag and add/remove the generated block in every file listed in `instructionFiles` (default: each repo's root `AGENTS.md`).
- Skills check `wf status --quiet` first; not enabled ⇒ "not enabled here, run onboarding". The guard hook acts only on paths under `.wf-evidence/`, which exist only in onboarded projects.
- No tiers. A small project is just a small config: `tracker: none`, `lanes: [quick]`, `roles: { reviewer }`.

## Core model

| Concept | Engine owns | Adapter supplies |
| --- | --- | --- |
| Work item | id, lane, intent (implementation / analysis), owner, attempt | tracker kind, id prefix, status names |
| Workspace | repo = git root; one task worktree per repo per attempt; per-repo base branch | repos, each with `packages` (path, `sharedInfra`, `docsOnly`), base branch, provisioning |
| Components | impact across components, delivery order, briefs | components, kinds, `provides` / `dependsOn` contracts |
| Provisioning | prepares each worktree before any role starts | `clone` paths (copy-on-write), `fingerprint` lockfiles, `install`, `copyIgnored`, `onWorktreeCreate` |
| Adapter trust | gate plan reads the adapter at the adapter repo's base commit recorded at admission, never the ticket worktree; touching `.workflow/**` forces the full gate | which repo holds `.workflow/` |
| Manifest | append-only ledger per attempt, schema-versioned, guarded against hand edits | — |
| Lanes | `quick`, `standard`, `batch`; `focused` as a gate option | enabled lanes, focused-eligible paths |
| Criteria | frozen before implementation (planner's plan, or owner-written from the issue); changes only via `wf criteria amend --reason`, merged by id (drops need an explicit `dropped: true` + reason), shown to the reviewer | — |
| Work items | optional planner grouping of criteria `{ id, criteria, repos, class, why }`, frozen with the criteria; `wf handoff implementer --work` names the class's agent | — |
| Roles | planner, implementer, reviewer, optional tester; independence checks | lanes per role, appendices, `class` per role |
| Work classes | one generated agent per class; declared effort/model recorded per handoff | `classes`: `use` text, claude/codex `effort` and `model` |
| Gate | plan (`--prepare-only`), run, suite-level reuse, stop/resume, dead-runner harvest, newer failure supersedes older pass, unknown paths count as dependencies | steps, step plugins |
| Evidence | immutable, hash-bound, under `.wf-evidence/` | extra artifact kinds |
| Review | bundle (states whether a gate passed on the tree under review), closure bound to the tree it was handed, fresh reviewer per round, every finding fixed or verified-nonissue, criteria → evidence mapping, evidence pass after the gate (gate screenshots and test output inspected) | pre-review check command |
| Delivery | authorization, cross-repo ordering, partial-delivery resume, base-advance carry-forward | delivery adapter |
| Tracker | lifecycle events → actions, readback verification | tracker adapter, statuses, templates |
| Follow-ups | `reopen` for amendments and visual feedback after delivery | — |
| Takeover | `adopt` a live attempt from a new session | — |
| Holds | `hold` / `release`, the only delivery veto | — |

Commands: `install`, `init`, `doctor`, `sync`, `status [--all] [--attempt]`, `base [merge]`, `enable|disable`, `topology [--check]`, `entry`, `plan`, `criteria amend`, `handoff <role>`, `gate`, `stop`, `review`, `accept`, `deliver` (also delivers a batch), `tracker record`, `reopen`, `adopt`, `hold|release`, `resume`, `abandon`, `batch create|eject`, `secrets init|set|guide|status`, `skills update`, `report`.

## System topology

`repos` say where code lives; `components` say what the system is.

```yaml
components:
  - id: api
    kind: service            # open list: service | web | mobile-ios | mobile-android | worker | library | infra | desktop | cli
    repo: backend
    provides:
      - { contract: http, spec: openapi.json }
  - id: web
    kind: web
    repo: frontend
    dependsOn:
      - { component: api, via: http, contract: backend/openapi.json }
  - { id: billing, kind: service, repo: platform, package: services/billing,
      dependsOn: [{ component: users, via: grpc, contract: proto/users.proto }, { component: bus, via: events, contract: events/billing.*.json }] }
  - { id: ios, kind: mobile-ios, repo: ios, dependsOn: [{ component: api, via: http, contract: backend/openapi.json }] }
```

The engine uses it for:
- **Impact.** A change to a `provides` contract makes every dependent affected; their contract-consuming steps join the gate.
- **Delivery order.** Providers first, derived from `dependsOn`.
- **Briefs.** Role bundles name the affected components and the contracts crossed, so review checks the seam.
- **Steps** may target a component instead of repo/package.

## Adapter format

```yaml
# .workflow/project.yaml
version: 1
enabled: true
engine: "1.x"
name: example
repos:                       # git roots
  - name: backend
    path: backend
    base: main
    packages:
      - { path: ., sharedInfra: [package.json, yarn.lock, "docker-compose*.yml"], docsOnly: ["docs/**", "**/*.md"] }
    provision: { clone: [node_modules], fingerprint: [yarn.lock], install: yarn install --immutable, copyIgnored: [.env.local] }
  - name: frontend
    path: frontend
    base: main
    packages:
      - { path: ., sharedInfra: [package.json, yarn.lock], docsOnly: ["**/*.md"] }
    provision: { clone: [node_modules], fingerprint: [yarn.lock], install: yarn install --immutable }
adapterRepo: backend
instructionFiles: [backend/AGENTS.md, frontend/AGENTS.md]
components: [...]
delivery: { kind: push-main }
tracker: { kind: linear, idPrefix: ENG, statuses: { started: In Progress, delivered: Ready for UAT, done: Done } }
lanes: [quick, standard, batch]
classes:                     # merged over the plugin's full/light defaults by name; open list
  light: { use: "Screens on a frozen API contract, translations, fixtures.", claude: { effort: low }, codex: { effort: low } }
roles:
  planner:     { lanes: [standard], class: full, appendix: .workflow/roles/planner.md }
  implementer: { class: full, appendix: .workflow/roles/implementer.md }
  reviewer:    { class: full, appendix: .workflow/roles/reviewer.md }
gate:
  maxParallelSteps: 2
  leases: { docker: 1, browser: 1 }
  steps:
    - { id: backend-lint, repo: backend, run: yarn lint, inputs: ["src/**", "test/**"], tier: light }
    - id: backend-unit
      repo: backend
      run: yarn jest --maxWorkers={workers} {select}
      select: "--runTestsByPath {suites}"
      report: { junit: junit.xml }
      workers: { auto: true, min: 2, max: 8, perWorkerGiB: 2 }
      inputs: ["src/**", "test/**"]
      tier: light
    - { id: backend-e2e, repo: backend, plugin: ./steps/e2e.mjs, tier: heavy, deferrable: true, lease: docker }
    - { id: web-e2e, repo: frontend, run: "npx playwright test --workers={workers} --reporter=junit", report: { junit: results.xml }, workers: { auto: true, min: 2, max: 8, perWorkerGiB: 1 }, tier: heavy, lease: browser, alsoInputs: [backend] }
invariants: .workflow/AGENTS.invariants.md
requires: { skills: [], connectors: [linear], tools: [{ name: docker, check: "docker info" }] }
```

`wf gate --focused` (allowed only when every changed file matches `focused`) skips heavy steps and records `focused: true` and each skipped step's `skippedBy: focused`. It is repair proof only: accept and delivery need a passing gate on the current tree that skipped no step because of `--focused`. Steps skipped by `when.paths`, docs-only changes, a plugin's own `plan`, or deferred to a batch do not make a gate partial.

A step without `inputs` reruns every gate (no reuse). A passing result is reused only when every file changed in the package since that pass is in the step's `inputs`, its `ignores` (files the step provably does not depend on) or the package's `docsOnly`; otherwise the step reruns. A changed file that no step's `inputs` covers forces every step of its package to run (fail closed); a changed file in a package with no steps is listed as unchecked in the gate result. Files under the repo's `sharedInfra` (root lockfiles, shared config) force all of the repo's steps to run.

`wf doctor` warns (never fails) when a `run` command references a sibling repo (`../web`, `$WF_ROOT/web`, `$WF_ATTEMPT/web`) that `alsoInputs` does not list: a portal end-to-end pass was reused against old API code. `alsoInputs: [repo, ...]` names other repos a step reads, for example an end-to-end step in one repo that builds a sibling repo's service from its worktree. The step's reuse key then also covers each listed repo's tree (HEAD plus a hash of tracked changes, the same as the gate's tree binding: the attempt's worktree when the repo is in the attempt, else its main checkout), so any change there reruns the step, and a non-docs change there keeps the step from being skipped as "no changes in this repo". A listed repo whose tree cannot be read makes the step always run (fail closed).

### Step plugin contract

```js
export default {
  plan(ctx)    // → { run: boolean, reason, inputs: string[], runnerIdentity: string }
  run(ctx)     // → { status, suites: [{ id, inputsHash, status, durationMs }], artifacts: [] }
               //   interrupted: { status: 'interrupted', suites: [...finished only] }
  cleanup(ctx) // called on stop and dead-runner harvest; frees containers, leases
}
```

The engine owns suite merging, reuse eligibility (same `runnerIdentity` + same suite `inputsHash`) and harvest. Worker counts are not part of the reuse fingerprint.

## Commands in any language

The engine runs shell commands and knows no framework. Onboarding proposes steps from what it detects (`package.json`, `composer.json`, `phpunit.xml`, `pyproject.toml`, `go.mod`, Gradle, Xcode projects, compose files).

Suite-level results without a plugin: `report: { junit: <path or glob> }` (PHPUnit, Codeception, Jest, Vitest, Playwright, pytest, Gradle). Suite-level reuse also needs `select` (the engine substitutes the suites to rerun) and a suite → file mapping from JUnit `file`/`classname`; without `select` the step is reused or rerun as a whole. Xcode results need conversion to JUnit.

## Live gate output

`wf gate` writes one line per event as it happens: the run's plan (to run, reused, skipped), each step's start, and each finish with status and seconds; a failed step adds its first failing suite, or the last 5 lines of its log, through the redactor. Lines go to stdout, or stderr with `--json`. The gate never fails fast: independent steps keep running. The run's `progress.json` lists finished steps and the ones running now; `wf status` / `wf resume` read it (with the gate lock) and show both while the gate runs.

## Parallelism and workers

- **Steps:** `gate.maxParallelSteps`; `lease` names a resource (`docker`, `db`, `browser`, `simulator`) and `gate.leases` sets holders per lease. Leases are machine-wide: a step waits for a slot another gate holds, the gate itself always starts at once.
- **Inside a step:** `workers` is a number or `auto` (`min`, `max`, `perWorkerGiB`): free memory minus a reserve, divided per worker, capped by performance cores, never below `min`; probe failure ⇒ `min`. `shards` splits a step into shard processes. Placeholders `{workers}`, `{shard}`, `{shards}`; overrides `WF_WORKERS_<STEP>`, `WF_SHARDS_<STEP>`. Each run records the chosen numbers and why.

## Step environment

Gate steps, provisioning, doctor checks and secret `verify` commands run with `projectEnv` (engine/env.mjs): an open base list of toolchain variables, `WF_*`, the adapter's `gate.env.pass` (names, or prefixes ending in `*`, read from the adapter at base) and the step's catalogued secrets. Variables of agent runtimes (`CLAUDE_CODE_*`, `ANTHROPIC_*`, `CODEX_*`, `OPENAI_*`, `GROK_*`, `XAI_*`) pass only when a `pass` entry names that family. Named failure: every step received the owner's environment, session tokens included.

## Base movement before delivery

`wf status`/`wf resume` fetch each base (15 s timeout, failure noted) and show commits ahead, files overlapping the ticket's change and shared infrastructure touched. `wf base merge [--repo r]` refuses a dirty tree or a running gate, merges, aborts on conflict (worktree unchanged, conflicting files named), records `base.merged` and says the gate and review no longer count for the moved tree. Bundles give `bases` as the merge-base with the base ref, so a reviewer's diff is the ticket's change only.

## Delivery adapter

```js
export default {
  integrate(ctx) // push-main: merge base, fast-forward, push. PR/MR: push branch, open or update the request
  observe(ctx)   // → { state: 'integrated' | 'awaiting-merge' | 'ci-running' | 'ci-failed' | 'rejected', evidence }
  readback(ctx)  // proves the change is on the target branch
}
```

The engine owns authorization, repo ordering, partial-delivery resume and base advance. Built in: `push-main`. `kind` also takes a path to a project adapter.

## Ticket lifecycle

The engine emits events; the adapter maps them to tracker actions.

| Event | Typical actions |
| --- | --- |
| `admitted` | read the full issue → capture; set `started` unless already `started` or `done` |
| `implementing` | re-read; set `started` again if moved |
| `integrating` (PR/MR delivery) | set `inReview` if mapped; comment with request link if templated |
| `delivered` | comment from template; attach screenshots; set `delivered`; read back all |
| `reopened` | set `started` |
| never | `done` — a human sets it |

1. The engine lists pending actions; `wf resume` shows them. `implementing` is queued once per attempt.
2. The agent performs them through a connector (or the adapter through an API), reusing a matching comment instead of duplicating.
3. `wf tracker record` normalizes the saved response (the raw tracker JSON, never hand-written) and checks: for `admitted`, a non-empty description unless the capture says `"descriptionEmpty": true`; that the capture is not byte-identical to one recorded for another attempt or another event of this one (an `implementing` re-read of an unchanged issue excepted); status equals the mapped name; the comment was written after delivery, has the template's fixed opening and UAT scope, and contains nothing from `commentRules.forbid`; every attested screenshot is attached with a matching filename.
4. Until the `delivered` readback passes, the attempt is `handoff-pending`.
5. A rejected status write is reported; it never blocks implementation.

Screenshots come only from the gate's attested visual artifacts. They go to the tracker and are shown in the session, captioned with the state they show.

## Tracker adapters

`kind` is a built-in name (`linear`, `none`) or a path (`./.workflow/tracker/<name>.mjs`). Each operation runs `via: agent` (MCP connector; no credentials in the engine) or `via: adapter` (HTTP API; token is a `provided` secret in the keychain store).

```js
export default {
  idPattern,
  operations: { readIssue, setStatus, comment, attach, readBack },
  normalize(rawCapture), // → { id, title, description, status, comments[], attachments[], updatedAt, url }
  rules: {},             // tracker quirks
}
```

## Telemetry

- **Engine events:** the attempt ledger (`.wf-evidence/attempts/<id>/ledger.jsonl`) is the event log: every `wf` command appends a timestamped, hash-chained entry; gate entries carry per-step and per-suite status, reuse, duration and chosen workers. Resource sampling (memory/CPU peaks) is not built yet.
- **Agent usage:** `wf handoff <role>` records the agent's session id when known, its class, declared effort, model and agent type. `wf report` reads the transcript afterwards: by session id, or, for a Claude Code subagent (no session id of its own), by the `subagents/agent-*.meta.json` whose `name` is the `--agent` id and whose `agentType` is the recorded one, active after admission. Per handoff it reports class, declared and observed effort, agent type, model, the owner session's model recorded at the handoff (what an unpinned agent inherits), wall minutes, active minutes (gaps of 5 minutes or more between consecutive transcript entries left out), rounds (split at each fresh prompt) and output tokens (each API request counted once); the ledger also records the planner's model at `wf plan` and the reviewer's at `wf review` where transcripts exist, and `wf doctor` warns when no class pins a model and an attempt shows several; a declared/observed effort difference is shown, never enforced. A transcript shared by several handoffs (repair rounds on one agent) counts once in the attempt total. Measurement only — never grants or blocks anything.
- **Cost:** tokens × a user-editable price table.
- **Live:** `wf status --all` across enabled projects.
- **Report:** time per phase/step, reuse rate, repair rounds, findings per role, tokens and cost per role and model. CSV per attempt (`--csv`), CSV per handoff (`--handoffs-csv`), and one HTML page with both.
- Missing telemetry never fails anything.

## Secrets

Agents never see, type or move a secret value.

- **Catalog** `.workflow/secrets.yaml`, committed, names only: key, who needs it, kind (`generated`, `provided`, `test`), how to obtain it, format check, optional read-only `verify`.
- **Store:** `env-file` (the repo's ignored `.env.local`, mode 0600) or `keychain`.
- **Guided setup:** onboarding presents the list in chat, fills generated and test keys, then opens `wf secrets guide` in the user's terminal: key by key, purpose, where it's used, steps and link to obtain it, hidden prompt, format check, verify, retry/skip/resume, progress.
- **Redaction:** catalogued values are masked in step output, evidence and telemetry.

## Required skills, connectors and tools

```yaml
requires:
  skills:     [{ name: ui-review, roles: [reviewer], when: visual, vendor: .workflow/skills/ui-review, license: MIT }]
  connectors: [{ name: linear, for: tracker }]
  tools:      [{ name: docker, check: "docker info" }, { name: node, check: "node --version", version: ">=22" }]
```

- **Skills are vendored** into the project when the license allows, and `wf sync` places them for each runtime, so every agent applies the same bytes and updates go through review. Otherwise pinned install, checked per runtime.
- **Connectors** are checked with a read-only call; the user is told where to connect them.
- **Tools** are checked with their `check` command.
- `wf handoff <role>` refuses when a skill required for that role is missing in that role's runtime.

## Agents per project

`wf sync` generates each project's agent files for every runtime from the plugin template + the adapter's `roles` entry + appendix. Generated files carry a header and are never hand-edited.

- **Planner** returns `{ plan, criteria }` as the last ```` ```yaml ```` block of its reply; `wf plan --from-agent <id>` reads it from the subagent transcript (meta.json name, agent type, written after the handoff) and keeps the extracted block in the evidence with its sha256 and the planner's model. The file schema is closed at the top level (`plan`, `criteria`, `work`, and the plan sections, which may sit at the top level or under `plan:`; `plan:` may be text), because keys the engine did not read were silently dropped; the sections themselves are open; `plan` holds `summary`, `contract` (what repos share: routes, DTO fields, error codes, permission subjects), `anchors` (file:line of each function to change), `tests` (`changed` specs, targeted `run` selectors), `doNotRun`, `externalServices` (default test runs need no provider keys or internet; provider/sandbox tests are opt-in) and `agentSplit`. The engine stores it with the frozen criteria and passes it to every later role; it does not police its size.
- **Planner work items (optional):** `work: [{ id, criteria: [..], repos: [..], class, why }]` next to `criteria`. `wf plan` refuses duplicate work ids, criteria that do not exist and classes that do not exist (the owner would otherwise be told to start an agent that is not there); a criterion no work item covers is shown, not refused. An amendment keeps the work items unless its file replaces them, and they must still name existing criteria.
- **Implementers:** after the contract is committed, one implementer per work item (or per repo or area) can run in parallel (several implementer handoffs are allowed). `wf handoff implementer --work W1` records the work id, class, declared effort and model and the agent type in the bundle and ledger and prints the agent type to start; without `--work` the implementer role's class is used. They run only the specs they changed and targeted reruns while iterating, never broad sweeps, then the repo's lint and full unit suite once before finishing, and commit at stage boundaries.
- **Reviewer, blind and fresh:** its prompt is the one line `wf handoff reviewer` prints (the bundle path), with nothing from the owner or other agents; the bundle carries everything it needs. `wf handoff reviewer` refuses the owner, the planner, every implementer, and any agent id that already reviewed a round of this attempt: a resumed reviewer is anchored on its earlier findings. Each round is a new agent that reviews the whole attempt against the frozen criteria; it is not given earlier rounds' findings.

### Review order

A finding found after a full gate costs another full gate (about 40 minutes on the first real ticket), so review comes first:

1. **Review the committed change.** `wf handoff reviewer` is allowed once an implementer has committed work (no uncommitted tracked changes), with or without a passing gate. The bundle's `gate.passedOnThisTree` says whether gate evidence exists for this tree and lists the logs and screenshots only when it does. `wf review --closure` records the tree the reviewer was handed and whether its bundle carried a passing gate on that tree (`gateEvidenceInspected`).
2. **Fix** every open finding through the implementer of that work item, commit.
3. **Gate** the fixed tree. The owner may start it in parallel with the review; nobody edits the worktrees while it runs.
4. **Fresh reviewer** on the fixed tree. Once a passing gate exists on it, that round is also the evidence pass: it inspects the step logs and records every screenshot's sha256.
5. **`wf accept`** needs all three on the current tree, and names whichever is missing with the next command: a passing gate that skipped nothing for `--focused`; a clean closure written for this tree (any change after the review needs a new round); and that closure written after the gate passed on this tree (otherwise an evidence pass).

Review-first suits changes where findings are likely (money, authorization, migrations): each finding costs a fix and a light rerun instead of a full gate. Starting the review and the gate together suits changes where findings are rare: when the review comes back clean and the gate passes, only the short evidence pass remains. Attempts recorded by 0.1.5 or earlier, whose reviewers were handed the attempt only after a passing gate, count as evidence-inspected.
- Role agents registered by a runtime at session start may not include ones `wf sync` wrote later; the skills then ask for a session restart. They never substitute a general-purpose agent or pass a model on the spawn, since either overrides the agent file's effort and model.
- **Files:** Claude Code agents are Markdown with frontmatter (`name`, `description`, `effort`, `model`, `tools`) in `.claude/agents/`. Codex agents are TOML in `.codex/agents/<name>.toml` (`name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`). `wf sync` removes generated `wf-*` files it no longer produces (a removed class, the old Codex `.md` files); files without its generated marker are left alone.

## Work classes

Claude Code sets effort only in an agent file's frontmatter, not per spawn, so effort is chosen by choosing which generated agent to start. A class is `{ use, claude: { effort, model? }, codex: { effort, model? } }`:

- `full` (default: Claude effort `high`): money, payments, audit, authorization, tenant isolation, migrations, external protocols, and anything the project's invariants file calls a critical boundary.
- `light` (default: Claude effort `low`): UI wired to a frozen contract, translations, generated docs or OpenAPI output, test fixtures.

The adapter's `classes` merge over these by name and may add more. `roles.<role>.class` sets a role's class; planner, reviewer, implementer and tester default to `full`. Codex effort and every model are unset by default (inherited). The default effort values are unmeasured starting points. Effort values are checked against the sets each runtime documents today (Claude `low|medium|high|xhigh|max`, Codex `minimal|low|medium|high|xhigh`) so a typo fails at load instead of silently running at the inherited effort; a runtime that adds a value needs a plugin update. Per-role `model`/`effort` from 0.1.4 are refused with a pointer to `classes`.

`wf sync` writes `wf-planner` and `wf-reviewer` at their role's class, `wf-implementer` at the implementer role's class, and `wf-implementer-<class>` for every other class; each description carries the class's `use` text, and the planner's file lists every class. The planner assigns classes from that text; any work touching something `full` covers is `full`. An implementer whose work turns out to touch something a stronger class covers stops and tells the owner (text only; no engine check). Repair rounds continue the same agent and are not re-classified. Reviewer findings may carry the `work` id they belong to.

Not built: automatic classification, path globs for critical code, and any gate or review rule that depends on class. Classes change effort, never a guarantee.

## Onboarding (`wf init`)

1. **Detect:** repos, packages, base branches, package managers, scripts, test runners, compose files, specs and generated clients, mobile projects, trackers reachable, existing `AGENTS.md`.
2. **Topology:** component table + dependency diagram; the user confirms, renames, adds.
3. **Ask** only what can't be detected: tracker and statuses (or none), lanes, which invariants are real, product stage (pre-launch / live, written into the invariants).
4. **Secrets:** guided setup.
5. **Skills, connectors, tools:** present/missing per runtime; vendor confirmed skills; exact steps for the rest.
6. **Write** the adapter, the `AGENTS.md` block, generated agents.
7. **Prove** with `wf doctor` on a clean base: config errors are fixed by onboarding; tests already failing on a clean base are fixed as the first quick fix, or reported to the user when large.

## Trust model

What the evidence proves, and what it does not:

- **It catches mistakes.** The ledger is hash-chained, writes are serialised, gate results are bound to the exact tree and to the adapter committed at base, only a gate that ran every step the tree needs (not a `--focused` one) opens acceptance and delivery, acceptance needs a clean closure written for the exact tree after a passing gate on it, a step that reads another repo (`alsoInputs`) is reused only while that repo's tree is unchanged, and the guard hook blocks careless edits of `.wf-evidence/` from Edit/Write and common shell writes. An agent that misremembers, skips a step or edits the wrong file is stopped.
- **It does not stop a determined forger on the same machine.** The chain is unkeyed and agent identities (`--agent`, `--owner`) are names the owner supplies. An agent with shell access that sets out to fake a passing gate or a reviewer can. Independence and evidence are only as strong as the agents and the person running them.
- **Fresh reviewer per round is checked; blind is a rule.** The engine refuses a reviewer id that reviewed an earlier round, but the id is a name the owner supplies: resuming an old agent under a new id defeats it.
- **The blind reviewer is a rule, not a check.** The engine hands the reviewer only the bundle and prints a one-line start prompt, but it cannot see the prompt a runtime actually gives an agent, so it does not verify or record it. An owner who steers the reviewer (hints, focus areas, summaries of the work, other agents' findings) weakens the review without any refusal; the skills and the reviewer role forbid it, and the reviewer reports a prompt that carried more.
- **Classes do not change guarantees.** The gate, the blind independent review (always at the reviewer role's class, never a work item's), frozen criteria, evidence integrity and the hash-chained ledger are the same for every class. A class lowers only how hard an implementer thinks; a misclassified work item still meets the same gate and the same reviewer.
- **Steps never see agent session tokens** unless the adapter passes them by name.
- **Adapter code is trusted at base.** Step plugins, delivery and tracker adapters run as committed on the base branch, never the ticket's copy. A ticket can still change the project scripts a step calls (for example a test script in `package.json`); that is visible in the diff the reviewer inspects, and changes to `sharedInfra` files force the affected package's steps to run.

## Versioning

- agentic-workflow is delivered through itself (its own `.workflow/`).
- Releases are tagged; the scenario suite passes before a tag.
- Projects may pin `engine:`; `wf doctor` reports a mismatch. An update never changes an open attempt's frozen gate plan or criteria.

## Not built until a project needs it

- Trackers beyond `linear` / `none`; delivery beyond `push-main`.
- Shared `services:` (database, migrate, seed, dev server for the life of a lease).
- A separate tester role (available as opt-in template only).

## Open questions

- Whether Codex plugins can ship hooks and agents; fallback is `wf install` writing them.
- Whether a plugin's `bin/` lands on PATH for user-scope installs; fallback is a link into `~/.local/bin`.
- Transcript formats for runtimes other than Claude Code and Codex.
