# The project adapter (schema 2)

[Back to the README](../README.md) · [Docs map](../README.md#docs)

The adapter is the project's settings. `wf init` writes it from a scan of the repos and the person's confirmation ([onboarding.md](onboarding.md)); a hand edit is allowed, and a later `wf init` shows it before changing anything.

## Where it lives

- In a repo, as `.workflow/project.yaml`; or
- in the user folder, as `~/.agentic-workflow/projects/<name>.yaml`, with an explicit `root:`. The engine keeps that folder in a git repository of its own, so every version that judged an attempt is kept.

Both at once is refused, naming both files. Module paths are always `{ repo: <name>, path: <file> }`, and a module loads as the repo's fetched base holds it, never from an attempt's worktree: a ticket cannot change the code that judges or delivers it.

## A push-to-main project with no CI

```yaml
version: 2
name: example
root: ~/src/example                    # only in the user-folder copy
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
components:                            # consumers of changed contracts, listed in the review bundle
  - { id: web, repo: web, dependsOn: [{ contract: "api/src/**/*.controller.ts" }, { contract: "api/src/**/dto/**" }] }
invariants: api/.workflow/AGENTS.invariants.md
rules: [{ paths: ["web/src/**"], read: [web/DESIGN_SYSTEM.md] }]
screens:
  routes: { repo: web, path: scripts/routes-of.mjs }      # changed files -> routes
  shared: ["web/src/common/**", "web/src/styles/**"]
  sentinel: ["/", "/settings", "/items/new"]
  langs: [{ lang: <code>, dir: <ltr|rtl> }]               # each language and direction the project ships
  viewports: [390, 1440]
  capture: { module: { repo: web, path: scripts/capture.mjs } }   # or { run: "<command>" }, which runs as the attempt has it
review: { diffRead: before }           # or after
ticketing:
  tracker: <the tracker, through its connector>
  via: connector
  idPattern: '^ENG-\d+$'
  take: { status: In Progress }
  followUps: { mode: file, team: ENG, status: Backlog, label: found-in-review }
  operations: { fileFollowUp: "Create an issue in team ENG ...; read it back.", search: "Search open issues for ..." }
delivery:
  landing: queue
  order: [api, web]                    # each repo's part lands separately, in this order
  stages:
    - { do: land, branch: main }
    - { do: status, to: Ready for UAT, comment: uat }
budget: { adapter: { rules: 4, modules: 1, operationWords: 120 } }
```

## A merge-request project whose tests, tracker and delivery are its own modules

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
  via: module
  followUps: { mode: off }
delivery:
  authority: { push: agent, mergeRequest: agent, merge: person }
  order: [app, mobile]
  stages:
    - { do: merge-request, repos: [app, mobile] }   # each against its own base
    - { do: wait-merged }                           # matched by patch-id
    - { do: status, to: In UAT, comment: uat }
    - { do: confirm-deployed, where: production, when: { labels: [Hotfix] } }
    - { do: status, to: Done, when: { labels: [Hotfix] }, comment: deployed }
```

## Keys

| Key | What it says |
| --- | --- |
| `version`, `name`, `root` | Schema 2; the project's name; its root (user-folder copy only). |
| `requires` | `connectors`, `tools` (plain command names) and `skills` the project needs; `wf doctor` and `wf sync` check them. |
| `repos[]` | `name`, `path`, `base` (an attempt may start from another branch with `wf start --base`, and keeps that base), `remote` (default `origin`), `provision` (what a new worktree clones, copies and installs), `tests.fast` and `tests.full` (a command or a module, with an optional counted `lock`), `kinds` (which paths are tests and which are neither tests nor product, for the diff and the row). |
| `components[]` | Consumers of changed contracts: a component in `repo` that `dependsOn` the files a `contract` glob names. |
| `invariants` | The project's invariants file; reviewers get it and the session rules quote it. |
| `rules[]` | Documents to read for changes under `paths`. |
| `screens` | How screens are picked and captured: a `routes` module, `shared` paths that add the `sentinel` set, `langs`, `viewports` and `capture`: either `{ module: { repo, path } }`, loaded as the base holds it with `ctx.cwd` set to the attempt folder, or `{ run: "<command>" }` with `{out}`, `{viewport}`, `{lang}`, `{dir}` and `{routes}`, run from the attempt folder as the attempt has it, so the ticket under review can change it (prefer the module). With `capture` set, a change to a `shared` path requires the `sentinel` screens even with no `routes`; `wf doctor` warns when `routes` is unset. Screens are optional: with `capture` unset, or `screens: none`, there are no screens, and `wf doctor` notes it once. |
| `review.diffRead` | `before` or `after`: whether the person's diff-read, when a reviewer's `risk.needs` asks for it, comes before or after the merge. There are no risk paths: each change's first reviewer judges its risk ([design](design-0.8.md), D94); a `risk` key is refused as dropped. |
| `ticketing` | `tracker` (a name, which with `via: connector` is only a label in the operation texts; a module; or `files`), `via` (`connector`, `module`, `files`), `idPattern`, `take` (the status set at start), `followUps` (`file`, `digest` or `off`) and `operations` (the adapter's own words for each connector step, keyed by the engine's operations: `read`, `search`, `fileFollowUp`, `setStatus`, `comment`, `mergeRequest`). One attempt can run without the tracker: `wf start --no-tracker`. |
| `delivery` | `landing` (`direct` or `queue`), `order`, `authority` (who pushes, opens merge requests and merges) and `stages` ([delivery-and-tracker.md](delivery-and-tracker.md)). |
| `models` | A model per role: `planner`, `implementer`, `reviewer`, `secondReviewer`, `drafter`. |
| `budget.adapter` | Limits on the adapter's rules, modules and operation words; `wf doctor` reports the counts. |
| `onboarded` | Written by `wf init`: when, by which engine, and the hash of each key it wrote, so a hand edit is seen. |

Keys schema 2 dropped (lanes, classes, panel, strategy, impact, leaving, severity, gate, quality, designSystem and the rest) are named as dropped, with where they went, when an adapter still has them. A schema 1 adapter is refused with `wf init --from-07`.

## Secrets

Secrets are catalogued in `secrets.yaml` beside the adapter (`.workflow/secrets.yaml` in the repo, or next to the user-folder adapter), a list of keys with `usedBy` and `purpose`, and filled by the person with `wf secrets guide` in their own terminal ([onboarding.md](onboarding.md#secrets)).
