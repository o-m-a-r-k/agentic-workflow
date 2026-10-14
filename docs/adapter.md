# Adapter schema

[Back to the README](../README.md) · [Docs map](../README.md#docs)

A project opts in with a committed `.workflow/` folder: `project.yaml` (below), `secrets.yaml` (key names only, never values), `AGENTS.invariants.md`, and any step plugins, role appendices or tracker adapters it names. `wf init` drafts it; `wf doctor` validates it; the engine reads it as committed at each attempt's base. Step fields: [gate.md](gate.md#gate-step-fields). Trackers: [delivery-and-tracker.md](delivery-and-tracker.md#where-tasks-live-and-how-wf-reaches-them). Work classes and roles: [lifecycle.md](lifecycle.md#work-classes).

## Example

```yaml
# .workflow/project.yaml
version: 1
enabled: true
engine: ">=0.1.10"          # or "0.x" (same major); wf entry and wf gate refuse an older engine
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
adapterRepo: backend           # the repo whose committed .workflow/ judges each attempt; a root .workflow may only link to <that repo>/.workflow
instructionFiles: [backend/AGENTS.md, frontend/AGENTS.md]
components: [...]
delivery: { kind: push-main }
tracker: { kind: linear, itemPattern: '^ENG-\d+$', statuses: { started: In Progress, delivered: Ready for UAT, done: Done } }
lanes: [quick, standard, batch]
classes:                     # merged over the plugin's full/light/review defaults by name; open list
  light: { use: "Screens on a frozen API contract, translations, fixtures.", claude: { effort: low }, codex: { effort: low } }
  review: { claude: { model: opus, effort: high } }   # the default: planning and review on the strongest model
roles:
  planner:     { lanes: [standard], class: review, appendix: .workflow/roles/planner.md }
  implementer: { class: full, appendix: .workflow/roles/implementer.md }
  reviewer:    { class: review, appendix: .workflow/roles/reviewer.md }
strategy:
  reviewRoundsEscalate: 10   # review rounds handed (recorded or not) before the person decides how to continue (the default); the one number the engine stops for
impact:                      # the planner's two-stage impact analysis (lifecycle.md, "Impact analysis")
  requiredFor: [full]        # classes whose work needs a survey and an impact map; [] turns the requirement off
  maxFileBytes: 2097152      # a larger file is skipped by every query (and listed)
  maxScanBytes: 536870912    # a query that reads more is refused: narrow its paths
  regexTimeoutMs: 20000      # a regex query that runs longer is stopped and refused
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

**Provisioning and secrets.** `provision` prepares each new worktree before any role starts: `clone` paths (copy-on-write), `copyIgnored` files, `fingerprint` lockfiles, `install` (run when a fingerprint file differs or a cloned path is missing) and `onWorktreeCreate`. The install runs with the project environment ([the step environment](gate.md#step-environment)) and **no secrets by default**. An install that needs one, such as a private registry's token, receives exactly the catalogued keys that list `provision:<repo>` in `usedBy`, the way a gate step lists its id:

```yaml
# .workflow/secrets.yaml (names only)
keys:
  - { key: REGISTRY_TOKEN, kind: provided, usedBy: ["provision:backend"], purpose: "private package registry" }
```

Only that repo's `install` gets the key (not another repo's, not `onWorktreeCreate`, not a step), the key counts as needed, so `wf secrets guide` asks for it, and `wf entry` refuses before the install runs when it is not filled (`secrets missing for provisioning of backend: REGISTRY_TOKEN`; the worktree it made is rolled back). A failing install prints its output with every catalogued value masked. A key with an empty `usedBy` still reaches nothing. (I-111; chosen as the narrowest form mirroring `usedBy`: a per-repo name, no blanket "all provisioning" and no way to receive every secret.)

**`docsOnly`.** A package's `docsOnly` globs (relative to the package) name files that are not product code: the gate does not rerun a step for them, the scope checks do not call them unplanned, and the reviewer's symbol scan of the final diff takes no declarations from them. (A review division leaves out prose, `docs` folders and `LICENSE`/`NOTICE` files by their own names: [parallel review](parallel-review.md#division).)

**Planning and review classes.** The planner and the reviewer default to the `review` class, which pins the Claude model `opus` with high effort. `wf doctor` fails when either role resolves to a class with no model for the selected runtime (`claude.model` or `codex.model`) (the planner is skipped when `roles.planner: false`): set the model on that class, or point the role back at `review`. Override `classes.review.claude.model` or `classes.review.codex.model` with an exact model id to pin a version. Doctor detects the current agent runtime; outside one it defaults to Claude. Select explicitly with `wf doctor --runtime codex` or `--runtime claude`. Codex has no default model pin: choose the strongest model available to your account.

**`impact`.** `requiredFor` lists the work classes whose plans must carry the survey and impact map (default `[full]`: a plan with any `full` work item, or with no work items while the implementer role is `full`); only lanes with a planner are checked. The byte caps bound what the engine's own query runner reads; queries never run through a shell. Details: [lifecycle.md](lifecycle.md#impact-analysis).

`wf gate --focused` (allowed only when every changed file matches `focused`) skips heavy steps and records `focused: true` and each skipped step's `skippedBy: focused`. It is repair proof only: accept and delivery need a passing gate on the current tree that skipped no step because of `--focused`. Steps skipped by `when.paths`, docs-only changes, a plugin's own `plan`, or deferred to a batch do not make a gate partial.

A step without `inputs` reruns every gate (no reuse). A passing result is reused only when every file changed in the package since that pass is in the step's `inputs`, its `ignores` (files the step provably does not depend on) or the package's `docsOnly`; otherwise the step reruns. A changed file that no step's `inputs` covers forces every step of its package to run (fail closed); a changed file in a package with no steps is listed as unchecked in the gate result. Files under the repo's `sharedInfra` (root lockfiles, shared config) force all of the repo's steps to run.

`wf doctor` warns (never fails) when a `run` command references a sibling repo (`../web`, `$WF_ROOT/web`, `$WF_ATTEMPT/web`) that `alsoInputs` does not list: a portal end-to-end pass was reused against old API code. `alsoInputs: [repo, ...]` names other repos a step reads, for example an end-to-end step in one repo that builds a sibling repo's service from its worktree. The step's reuse key then also covers each listed repo's tree (HEAD plus a hash of tracked changes, the same as the gate's tree binding: the attempt's worktree when the repo is in the attempt, else its main checkout), so any change there reruns the step, and a non-docs change there keeps the step from being skipped as "no changes in this repo". A listed repo whose tree cannot be read makes the step always run (fail closed).

## Step plugin contract

```js
export default {
  plan(ctx)    // → { run: boolean, reason, inputs: string[], runnerIdentity: string }
  run(ctx)     // → { status, suites: [{ id, inputsHash, status, durationMs }], artifacts: [] }
               //   interrupted: { status: 'interrupted', suites: [...finished only] }
  cleanup(ctx) // called on stop and dead-runner harvest; frees containers, leases
}
```

The engine owns suite merging, reuse eligibility (same `runnerIdentity` + same suite `inputsHash`) and harvest. Worker counts are not part of the reuse fingerprint.

Artifacts (0.7.0, I-100): a plugin writes captures into its scratch folder (`ctx.evidenceDir`) or its own package folder and returns them as `artifacts: [{ path, kind: 'screenshot' }]`. The engine copies each into the run's managed evidence and records the sealed copy, so `wf export screenshots --gate`, the evidence review and delivery read it. A returned path anywhere else, a symlink or a missing file fails the step. A plugin is never handed, and never writes to, the evidence folder itself.

A project whose adapter has no step with `artifacts` or a plugin cannot collect captures at all (0.7.0, I-94): the planner is told in `captureRoutes`, `wf plan` warns when a criterion needs screenshots, and the owner brings in captures made by hand on the committed tree with `wf captures import` ([the gate's captures](gate.md#captures-the-gate-cannot-collect-070-i-94)).

## Execution settings on existing attempts

`wf models refresh --attempt <id>` records the current committed tip of the admission adapter repo's configured base. Refreshing is bookkeeping: the owner agent records it as itself (0.7.0). A ticket config, uncommitted edit, arbitrary model/effort flag, unrelated commit or moved adapter location cannot provide execution settings.

Future handoffs resolve model and effort from this separate execution pin: implementers keep their frozen work class, and other roles use their class mapping at the execution pin solely to select model/effort. The admission class, its use text, role instructions and appendices, criteria, gate, tracker, review rules and skills stay frozen. Existing handoffs retain their own execution pin; refresh requires a fresh handoff for new settings. `wf doctor --runtime codex --attempt <id>` reports the attempt pin as well as the current setup. Resume distinguishes unlaunched, running, failed and completed native reviewers.
