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
tracker: { kind: linear, idPrefix: ENG, statuses: { started: In Progress, delivered: Ready for UAT, done: Done } }
lanes: [quick, standard, batch]
classes:                     # merged over the plugin's full/light/review defaults by name; open list
  light: { use: "Screens on a frozen API contract, translations, fixtures.", claude: { effort: low }, codex: { effort: low } }
  review: { claude: { model: opus, effort: high } }   # the default: planning and review on the strongest model
roles:
  planner:     { lanes: [standard], class: review, appendix: .workflow/roles/planner.md }
  implementer: { class: full, appendix: .workflow/roles/implementer.md }
  reviewer:    { class: review, appendix: .workflow/roles/reviewer.md }
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

## Execution settings on existing attempts

`wf models refresh --attempt <id>` records the current committed tip of the admission adapter repo's configured base. Only the owner may refresh (a host-recorded exact owning-session command or a human terminal confirmation). A ticket config, uncommitted edit, arbitrary model/effort flag, unrelated commit or moved adapter location cannot provide execution settings.

Future handoffs resolve model and effort from this separate execution pin: implementers keep their frozen work class, and other roles use their class mapping at the execution pin solely to select model/effort. The admission class, its use text, role instructions and appendices, criteria, gate, tracker, review rules and skills stay frozen. Existing handoffs retain their own execution pin; refresh requires a fresh handoff for new settings. `wf doctor --runtime codex --attempt <id>` reports the attempt pin as well as the current setup. Resume distinguishes unlaunched, running, failed and completed native reviewers.
