# agentic-workflow — design

Status: v0.1 implemented. Scenario tests in `scenarios/` are the executable form of this design; where they differ, the tests win and this file is fixed.

agentic-workflow runs software changes through a fixed lifecycle with AI coding agents:
admit a ticket → isolated worktree → plan → implement → gate → independent review → deliver → tracker handoff.
It ships as one user-level plugin for Claude Code and Codex. Each project opts in with an adapter
(`.workflow/`) that describes its repos, components, commands, tracker and delivery.

## Principles

Each principle comes from a failure seen while running agent-driven delivery on real projects.

1. **One trust boundary.** Authority to deliver = the ticket was admitted with implementation intent and no hold is recorded. The engine never parses prompts or transcripts to decide what is allowed; doing so produced rotating false refusals and collapsed throughput.
2. **Evidence, not statements.** Every lifecycle step reads evidence files the engine wrote. No step accepts an agent saying it did something.
3. **Independent review.** The reviewer is never the owner, planner or an implementer (checked from the ledger). The planner leaves the tree unchanged; the tree is unchanged between review handoff and acceptance.
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
  skills/          # onboard, work, quick-fix, resume, status, secrets guide
  agents/          # role templates: planner, implementer, reviewer (tester: opt-in)
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
- The hook and every skill check `wf status --quiet` first; not enabled ⇒ exit 0 / "not enabled here, run onboarding".
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
| Criteria | frozen before implementation (planner's plan, or owner-written from the issue); changes only via `wf criteria amend --reason`, shown to the reviewer | — |
| Roles | planner, implementer, reviewer, optional tester; independence checks | lanes per role, appendices, model/effort per runtime |
| Gate | plan (`--prepare-only`), run, suite-level reuse, stop/resume, dead-runner harvest, newer failure supersedes older pass, unknown paths count as dependencies | steps, step plugins |
| Evidence | immutable, hash-bound, under `.wf-evidence/` | extra artifact kinds |
| Review | bundle, attestation, closure (every finding fixed or verified-nonissue), criteria → evidence mapping, reviewer inspects gate screenshots and test output | pre-review check command |
| Delivery | authorization, cross-repo ordering, partial-delivery resume, base-advance carry-forward | delivery adapter |
| Tracker | lifecycle events → actions, readback verification | tracker adapter, statuses, templates |
| Follow-ups | `reopen` for amendments and visual feedback after delivery | — |
| Takeover | `adopt` a live attempt from a new session | — |
| Holds | `hold` / `release`, the only delivery veto | — |

Commands: `init`, `doctor`, `sync`, `status [--all]`, `enable|disable`, `topology`, `entry`, `plan`, `criteria amend`, `handoff <role>`, `gate`, `stop`, `review`, `accept`, `deliver`, `tracker record`, `reopen`, `adopt`, `hold|release`, `resume`, `abandon`, `batch create|eject|deliver`, `secrets init|set|guide|status`, `skills update`, `report`.

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
roles:
  planner:     { lanes: [standard], appendix: .workflow/roles/planner.md }
  implementer: { appendix: .workflow/roles/implementer.md }
  reviewer:    { appendix: .workflow/roles/reviewer.md }
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
    - { id: web-e2e, repo: frontend, run: "npx playwright test --workers={workers} --reporter=junit", report: { junit: results.xml }, workers: { auto: true, min: 2, max: 8, perWorkerGiB: 1 }, tier: heavy, lease: browser }
invariants: .workflow/AGENTS.invariants.md
requires: { skills: [], connectors: [linear], tools: [{ name: docker, check: "docker info" }] }
```

A step without `inputs` reruns every gate (no reuse).

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

## Parallelism and workers

- **Steps:** `gate.maxParallelSteps`; `lease` names a resource (`docker`, `db`, `browser`, `simulator`) and `gate.leases` sets holders per lease. Leases are held while running, never queued across gates.
- **Inside a step:** `workers` is a number or `auto` (`min`, `max`, `perWorkerGiB`): free memory minus a reserve, divided per worker, capped by performance cores, never below `min`; probe failure ⇒ `min`. `shards` splits a step into shard processes. Placeholders `{workers}`, `{shard}`, `{shards}`; overrides `WF_WORKERS_<STEP>`, `WF_SHARDS_<STEP>`. Each run records the chosen numbers and why.

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

1. The engine lists pending actions; `wf resume` shows them.
2. The agent performs them through a connector (or the adapter through an API), reusing a matching comment instead of duplicating.
3. `wf tracker record` normalizes the saved response and checks: status equals the mapped name; the comment was written after delivery, has the template's fixed opening and UAT scope, and contains nothing from `commentRules.forbid`; every attested screenshot is attached with a matching filename.
4. Until the `delivered` readback passes, the attempt is `handoff-pending`.
5. A rejected status write is reported; it never blocks implementation.

Screenshots come only from the gate's attested visual artifacts. They go to the tracker and are shown in the session, captioned with the state they show.

## Tracker adapters

`kind` is a built-in name (`linear`, `none`) or a path (`./.workflow/tracker/<name>.mjs`). Each operation runs `via: agent` (MCP connector; no credentials in the engine) or `via: adapter` (HTTP API; token is a `provided` secret in the keychain store).

```js
export default {
  idPattern,
  operations: { readIssue, setStatus, comment, attach, readBack },
  normalize(rawCapture), // → { id, title, status, comments[], attachments[], updatedAt, url }
  rules: {},             // tracker quirks
}
```

## Telemetry

- **Engine events:** the attempt ledger (`.wf-evidence/attempts/<id>/ledger.jsonl`) is the event log: every `wf` command appends a timestamped, hash-chained entry; gate entries carry per-step and per-suite status, reuse, duration and chosen workers.
- **Agent usage:** `wf handoff <role>` records the agent's session id; `wf report` reads that session's transcript afterwards for model, tokens, wall time and tool calls. Measurement only — never grants or blocks anything.
- **Cost:** tokens × a user-editable price table.
- **Live:** `wf status --all` across enabled projects.
- **Report:** time per phase/step, reuse rate, repair rounds, findings per role, tokens and cost per role and model. CSV + one HTML page.
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

- **It catches mistakes.** The ledger is hash-chained, writes are serialised, gate results are bound to the exact tree and to the adapter committed at base, and the guard hook blocks careless edits of `.wf-evidence/` from Edit/Write and common shell writes. An agent that misremembers, skips a step or edits the wrong file is stopped.
- **It does not stop a determined forger on the same machine.** The chain is unkeyed and agent identities (`--agent`, `--owner`) are names the owner supplies. An agent with shell access that sets out to fake a passing gate or a reviewer can. Independence and evidence are only as strong as the agents and the person running them.
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
