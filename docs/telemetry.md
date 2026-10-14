# Telemetry

[Back to the README](../README.md) · [Docs map](../README.md#docs)

Telemetry is measurement only: nothing here allows or blocks a command, and missing telemetry never fails one. It has three sources.

- **Engine events:** every `wf` command appends to the attempt's hash-chained ledger. The events below are what the engine records for measurement.
- **Agent usage:** the model, tokens, time and tool calls of each agent are read after the fact from the runtime's own session logs (Claude Code transcripts under `~/.claude/projects`, Codex sessions under `~/.codex/sessions`).
- **Refusals:** every refusal a `wf` command prints is appended to the [refusal log](#refusal-log), outside every repo, so each check can be counted ([design principle 13](DESIGN.md#principles)).

Codex usage reads the single active rollout selected by its host index, including native `token_usage_record.thread_token_usage` snapshots. Cached input is a subset of input, and reasoning is a subset of output: each is counted once. Retained rollout copies are never summed. Cumulative Codex usage is attributed to the main observed session model; cost across model switches is an estimate. A handoff launched with `wf handoff run` records its session id for usage lookup; desktop spawns without a recorded session id still have no per-handoff usage.

`wf report` joins the two. `wf status --all` shows open work across every enabled project.

## Commands

| Command | What it records or shows |
|---|---|
| `wf report` | A text summary per attempt (phases, gates, review rounds, findings, scope, refusals, reviewer bundle sizes, observations, strategy tripwires, tokens, cost, failing tests, idle gaps) and, when a model has no price, the list of unpriced models with the files to add a price to |
| `wf refusals [--since ISO] [--json]` | The [refusal log](#refusal-log) counted by check id, most refusals first |
| `wf improve review [--uncited] [--since ISO] [--json]` | The same counts, each with the improvements and closures that cite the id (see [lessons and improvements](lessons-and-improvements.md)) |
| `wf report --json` | The same data in a versioned shape (below) |
| `wf report --csv F` / `--handoffs-csv F` / `--html F` | One row per attempt / one row per handoff / one HTML page with both and the phase table |
| `wf report --idle-minutes N` | The idle-gap threshold (default 30) |
| `wf report --all` | Every enabled project |
| `wf handoff close --agent ID [--outcome done\|stopped\|failed]` | The implementer finished: its commits since the handoff and its sub-agents. `wf handoff reviewer` refuses while an implementer handoff is open (`--reason` overrides, recorded as `review.override`) |
| `wf stop --class C --reason "..."` | Why a gate was stopped, as a class (required) and as text |
| `Fixes-finding: <round>:<id>` (commit trailer) | The commit a review finding was fixed in |
| `scope:` in an amendment file | What a criteria amendment adds: endpoints, error codes, repos |

## Refusal log

Every refusal (exit code 75) a `wf` command prints is appended as one JSON line to `~/.agentic-workflow/refusals.jsonl`, next to the improvement inbox (`WF_REFUSALS_FILE` overrides the path; a scenario's `WF_IMPROVEMENTS_DIR` puts it beside that folder). It is outside every repo and never read to allow or block anything.

| Field | Meaning |
|---|---|
| `id` | The check that refused: the stable id given to `refuse()` (for example `review:delta-outside`), or `<file>.mjs:<line>` of the call site for a refusal that has none |
| `at`, `version` | When, and the engine version |
| `cmd`, `sub` | The command and subcommand |
| `attempt`, `project` | The attempt the command targeted (`--attempt`, the worktree it ran in, or the only open attempt) and its project's folder name. Null when the refusal came before an attempt was found. An attempt id can repeat across projects, so `wf report` joins on both when `project` is present |
| `message` | The first line of the refusal text, at most 300 characters |

`wf refusals` counts by `id` with the number of attempts and the newest message as an example. `wf report` shows each attempt's own count, and `wf improve review` lists which ids an improvement or closure accounts for. A check with many refusals that no improvement or closure cites is one nobody has judged: fix it, or retire it (`wf improve close <id> --retire --reason "..."`). The log counts refusals, not catches: whether a refusal stopped a real mistake is a judgement the retire reason records.

## Ledger events

### `review.round`

One per `wf review` outcome on a reviewer handoff. A blind closure and its later re-record with `priorFindings` are two events for the same round; a refusal is recorded once per round and cause.

| Field | Meaning |
|---|---|
| `handoff` | The reviewer handoff id: the bundle file name, such as `05-reviewer` |
| `bundle` | The bundle path (joins the round to its `handoff` and `review.recorded` entries) |
| `agent`, `agentType` | The reviewer agent id and the agent type it was started as |
| `model` | The reviewer's model, read from its transcript where one exists; else the class's pinned model; else null |
| `tree` | Per repo, the commit the reviewer was handed (the tree it judged) |
| `gatePassedOnTree`, `gateRun` | Whether a passing full gate existed for that exact tree at the handoff, and its run id |
| `openImplementers` | Implementers handed work and not closed with `wf handoff close` when the reviewer started (the tree may still move) |
| `outcome` | `recorded` or `refused` |
| `reasonClass`, `reason` | For a refusal: `tree-changed` (the worktree changed during the round), `launch-failed` (the engine launch of the reviewer failed); and the refusal text. Rounds recorded before 0.7.0 may also carry `provenance` and `unread-documents`, which are no longer produced. A refusal you fix by editing the closure (a missing verdict) is not recorded: the round goes on |
| `revealed` | Whether earlier rounds' findings had been revealed to this round |
| `findings[]` | `{ id, severity, status, category }` for each finding of the round's closure |
| `priorFindings[]` | `{ round, id, status, fixedIn }` for each earlier finding this round verified. `fixedIn` is the closure's own `fixedIn` field when given, else the commit whose `Fixes-finding` trailer names it |
| `fixes[]` | `{ round, id, repo, commit }`: every `Fixes-finding` trailer in the attempt's commits at that moment |

### `gate.stopped`

| Field | Meaning |
|---|---|
| `runId`, `kind` | The run stopped, and whether it was a gate or a check |
| `reason` | The `--reason` text as written |
| `class` | `--class` (required): `major-finding`, `tree-change` or `owner-decision`. Any other value, or none, is refused |
| `stepsFinished` | How many steps had finished (passed or failed) when the run was stopped |
| `stepsInFlight[]` | `{ id, seconds }`: the steps running at the stop, interrupted, and how long each had run |
| `discardedSeconds`, `discardedMinutes` | The sum of those seconds: gate work thrown away. Finished passing steps are kept for reuse and are not counted |
| `wallSeconds`, `wallMinutes` | Time since the run started |
| `reviewerOpen` | A reviewer had been handed the attempt and had not recorded a closure or been refused: the gate was given up during a review |

Entries written before 0.5.0 carry `runId` and `reason` only.

### `implementer.opened` and `implementer.closed`

`implementer.opened` is written with every implementer `handoff`: `{ handoff, agent, work, class, heads }`, where `heads` is the tree per repo at the handoff.

`implementer.closed` is written by `wf handoff close --agent ID`: `{ handoff, agent, outcome, heads, commits }`. `outcome` is `done` (default), `stopped` or `failed`; `commits` is, per repo, the number of commits since the implementer's handoff. The engine cannot see an agent finish, so an implementer nobody closes stays open in the report and in every later reviewer's `openImplementers`, and no reviewer is handed the tree until it is closed or the owner records `wf handoff reviewer --reason` (`review.override`: `{ reason, openImplementers, agent }`).

### `subagents.attributed`

Written by `wf handoff close` when the implementer's agent started sub-agents: `{ handoff, children: [{ agentId, name, agentType, parentAgentId, depth, description }] }`. Claude Code writes `parentAgentId` and `spawnDepth` in each sub-agent's `.meta.json`; every transcript whose parent chain leads to the implementer's own transcript (its name and agent type, active after admission) is attributed, at any depth. `wf report` finds the same children again when it runs, so a handoff that was never closed still gets them; the ledger entry keeps the attribution when the transcripts are gone.

### `scope.changed`

One per `wf criteria amend`.

| Field | Meaning |
|---|---|
| `amendment` | Its number (1 for the first amendment) |
| `reason` | The `--reason` text |
| `criteria` | `{ before, after, added, changed, dropped }` counts |
| `endpoints`, `errorCodes`, `repos` | Counts from the amendment file's optional `scope` block, null when not stated |
| `stated` | The lists as written, for each field given as a list |
| `addedRepos` | Repos added with `--add-repo` |

The `scope` block takes a count or a list of names per field, and nothing else:

```yaml
criteria:
  - { id: C14, text: "Editing an invoice keeps each billed line by its id" }
scope:
  endpoints: ["PATCH /invoices/:id"]
  errorCodes: 2
  repos: 1
```

### Failing tests on a gate step

A failed step in `gate.step` and `gate.finished` carries `failures`:

| Field | Meaning |
|---|---|
| `source` | Where the names came from: `junit` (the step's `report.junit` files), `playwright-json` (its `report.playwright` files, Playwright's JSON reporter), `jest`, `playwright` (list or line reporter output), `node-test` (spec `✖` or TAP `not ok` lines), `suites` (failed suites a step plugin returned) or `exit-code` (nothing named a test) |
| `tests[]` | Up to 50 failing test names, secrets masked |
| `total` | How many were found |
| `exitCodes` | The step's exit codes (one per shard) |
| `tail[]` | For `exit-code` only: the last 20 non-empty lines of the step's output, secrets masked |

To get names from Playwright's JSON reporter, write it into the scratch folder and declare it: `report: { playwright: '{evidence}/results.json' }`.

### `strategy.decided` and `strategy.tripwire`

Written by the strategist role and the owner's round escalation (0.7.0): a decision the strategist recorded, and the round escalation (`tripwire: rounds-escalation`) the engine refused a handoff on. `wf report` reads them from the raw ledger entries and only counts them: `strategyDecisions`, `strategyTripwires`, and `tripwiresFired` (the distinct tripwire names, read from the entry's `tripwire`, `name`, `id`, `signal` or `kind`). A ledger without them, from an older engine, counts zero.

### Bookkeeping entries

These ledger entries keep the books and say nothing about when the attempt was worked on. `wf report` leaves them out of an attempt's end time, its wall minutes, its phases and its idle gaps:

| Entry | Why it can be written long after the work |
|---|---|
| `evidence.baseline`, `evidence.recorded`, `evidence.rebaselined` | Manifest upkeep, written by whichever command next opens the attempt (an old attempt adopted into the manifest, a re-baseline) |
| `lesson.recorded`, `lesson.recurred`, `lesson.acknowledged` | A later attempt files a lesson, or a recurrence, on the earlier attempt that triggered it |
| `authority.spent`, `discovered.acknowledged` | A later attempt's reopen or delivery records a waiver or an acknowledgement on an earlier attempt |
| `models.refreshed` | Maintenance of the execution pin on an attempt in flight |
| `exported`, `screenshots.exported` | A page or screenshots copied out of a finished attempt |

Named failure: an adopted-manifest entry written days later made a 6-minute abandoned attempt report 4,403 wall minutes. An attempt ends at `closed`, else at `abandoned`, else at its last entry that is not in this table; entries after `closed` or `abandoned` are ignored. Every other entry (handoffs, gates, reviews, delivery, holds, decisions, strategist events) still counts as work.

### Earlier events the report reads

`admitted`, `criteria.frozen`, `criteria.amended`, `handoff` (role, agent, class, effort, model, session model, tree; a reviewer handoff also `gate` and `openImplementers`), `gate.started`, `gate.step`, `gate.finished`, `check.finished`, `gate.flaky`, `review.recorded`, `review.accepted`, `delivered`, `closed`, `abandoned`.

## Agent usage

A Claude Code subagent is found by the name it was started with (the `--agent` id) and its agent type, so no session id is needed. Per handoff the report shows the work item, class, declared and observed effort, agent type, model, the owner session's model at the handoff, wall minutes, active minutes (wall time minus gaps of 5 minutes or more), rounds (a fresh prompt to a finished agent starts a new one), output tokens, cost, and its sub-agents with their tokens and cost. One agent measured 185 wall minutes for about 21 active, so compare active minutes. A transcript shared by several handoffs (the same agent resumed) and a sub-agent transcript count once in the attempt totals.

## Cost

Cost is tokens × price, per model and per request type (input, output, cache read, cache write). The plugin ships a default table, [`engine/prices.yaml`](../engine/prices.yaml), with the date its prices were taken and which values are derived. Each later file replaces a model's entry:

1. `engine/prices.yaml` (the plugin's default)
2. `~/.config/agentic-workflow/prices.yaml` (or `$WF_CONFIG_HOME/prices.yaml`): per user
3. `.workflow/prices.yaml`: per project

Shape: `models: { <model id prefix>: { input, output, cacheRead, cacheWrite } }` in US dollars per million tokens. A model id matches the longest key it starts with, so a dated id finds its family. A missing `cacheRead` or `cacheWrite` is priced as input. A model with tokens and no entry is never guessed: it has no cost and is listed under `unpricedModels`, and the attempt's `cost` covers the priced models only. Codex reports one running total per session, attributed to its main model.

**Unpriced models are listed, never silent.** Named failure: 58.6% of one project's tokens (the Codex models) had no price and the cost figure said nothing. `wf report` prints, after the attempts, every unpriced model with its tokens, the number of attempts it ran in and its share of all tokens, then the files to add a price to (your `prices.yaml` for every project, the project's `.workflow/prices.yaml`, or the plugin's shipped `engine/prices.yaml`, each with its absolute path where it has one) and the entry's shape. Each attempt's cost line says what share of its tokens the figure leaves out. The HTML page carries the same section; `--json` carries `unpriced` and, per attempt, `unpricedTokens` and `unpricedShare`. Adding a price removes the model from every list at the next report.

## What `wf report` derives

- **Phases:** wall-clock minutes from admission to close (or abandonment, or the last ledger entry that records work: [bookkeeping entries](#bookkeeping-entries) never extend it), each minute in exactly one phase. By priority: a reviewer round is open → `reviewing`; a full gate is running → `gating`; before the criteria froze → `planning`; after acceptance → `delivering`; before the first review round ended → `implementing`; otherwise → `fixing` (repairs and new work between rounds). A round ends at its first recorded closure or its refusal; a round with neither ends at the next reviewer handoff. Checks (`wf check`) count as implementing or fixing.
- **Idle gaps:** gaps between consecutive ledger entries that record work (bookkeeping entries are skipped) of at least `--idle-minutes` (default 30), longest first, each with the phase it fell in and the event before it. No ledger entry is not the same as no work: an implementer can work for an hour without running `wf`.
- **Gates:** runs started, passed, failed, stopped and recovered; stops by class; stops while a reviewer was open; minutes discarded by stops; steps run, reused, passed, failed, interrupted and not started; reuse rate; gate step time; slowest steps; failing tests per failed step. `wf check` runs are counted separately.
- **Review rounds:** one per reviewer handoff, regardless of repeated submissions. `recordedRounds` counts handoffs with a recorded closure; `roundsWithRefusal` includes a handoff that was refused and later recorded. `refusalReasons` counts each reason once per handoff. `failedLaunchRounds` counts engine-recorded failed native launches, and `failedStartRounds` separates failures before a session started. A superseded handoff without a recorded outcome is `unknownOutcomeRounds`, not established wasted review work. Each round has additive `result`, `resultEvidence`, `launchStatus` and `failedBeforeSession` diagnostics. A launch record is historical, not proof of current liveness. The legacy `outcome`, `refusedRounds`, `abandonedRounds`, `wastedReviewerRounds` and `wastedReviewerMinutes` fields remain for report@1 consumers; their inferred abandonment/waste labels must not be treated as observed history. Text and HTML use the observed diagnostics.
- **Findings:** one per finding id per recorded round, by severity; `findingsOpen` counts those neither settled in their own round nor verified `fixed` or `verified-nonissue` by a later one; each with `fixedIn` when known. `repairRounds` counts recorded rounds that raised at least one finding other than a verified non-issue. `gateFailures` counts failed gates (before 0.5.0 this was reported as repair rounds, and `findings` counted only the last closure).
- **Refusals:** `refusalCount` and `refusalsById` count the entries of the [refusal log](#refusal-log) whose attempt is this one (most frequent check first). They measure how often a check stopped a command, not whether it was right to.
- **Reviewer bundles:** `bundleBytes` is the size of each handoff's bundle file, on every `roles[]` entry and every `rounds[]` entry; `maxReviewerBundleBytes` is the largest reviewer bundle. Null when the file is gone. One ticket's reviewers were handed 20 MB bundles; this is where that shows.
- **Observations:** `openObservations` counts findings the review policy keeps open without blocking (`observations()` in `engine/review-policy.mjs`); 0 until a policy classifies any.
- **Strategy:** `strategyDecisions`, `strategyTripwires` and `tripwiresFired` count the strategist's [ledger events](#strategydecided-and-strategytripwire).
- **Impact gaps:** `impactGaps` counts review findings tagged `impact-gap` (one per finding per round), about something the planner's impact map did not list: a direct measure of the plan (see [lifecycle.md](lifecycle.md#impact-analysis)).
- **Scope:** criteria at freeze and now; amendments; criteria added, changed and dropped; endpoints, error codes and repos added as stated.
- **Tokens:** per model (input, output, cache read, cache write, total, cost), the attempt total, and the part spent by sub-agents.

## `wf report --json`

```json
{ "schema": "agentic-workflow/report@1", "generatedAt": "<ISO time>", "attempts": [ { ... } ] }
```

The schema name changes only when a field is renamed or removed; new fields can appear within `@1` (0.7.0 added `unpriced` beside `attempts` and, per attempt, `unpricedTokens`, `unpricedShare`, `refusalCount`, `refusalsById`, `maxReviewerBundleBytes`, `openObservations`, `strategyDecisions`, `strategyTripwires`, `tripwiresFired`, and `bundleBytes` on `roles[]` and `rounds[]`; nothing was renamed; the per-attempt CSV gained matching columns at its end, and the per-handoff CSV a final `bundleBytes`). `unpriced[]` is `{ model, tokens, attempts, share }` for each model with tokens and no price across the report, most tokens first. Each attempt has:

| Field | Type |
|---|---|
| `project`, `id`, `item`, `lane`, `phase` | strings |
| `admittedAt`, `endedAt` | ISO times |
| `timeToGateMs`, `timeToDeliverMs`, `timeToCloseMs` | ms or null |
| `phases` | `{ planning, implementing, gating, reviewing, fixing, delivering }` in minutes |
| `wallMinutes` | admission to end |
| `idleGaps[]` | `{ from, to, minutes, after, before, phase }` |
| `gateRuns` | number of full gate runs |
| `gates` | `{ started, passed, failed, stopped, recovered, stops, stopClasses, stoppedDuringReview, discardedMinutes, stepsRun, stepsReused, stepsPassed, stepsFailed, stepsInterrupted, stepsNotStarted }` |
| `checks` | `{ runs, passed, failed, stopped }` |
| `failingTests[]` | `{ runId, step, source, tests, total, exitCodes, tail }` |
| `repairRounds`, `gateFailures` | numbers |
| `stepRuns`, `stepReused`, `reuseRate`, `gateTimeMs`, `slowestSteps[]` | gate step totals |
| `reviewRounds`, `recordedRounds`, `refusedRounds`, `abandonedRounds`, `wastedReviewerRounds`, `wastedReviewerMinutes`, `roundsWithGreenGate`, `roundsOnUnsettledTree` | numbers |
| `roundsWithRefusal`, `failedLaunchRounds`, `failedStartRounds`, `unknownOutcomeRounds` | numbers; observed refusal/launch events and explicitly unknown superseded outcomes |
| `refusalReasons` | reason code to number of affected handoffs |
| `rounds[]` | `{ handoff, agent, agentType, model, startedAt, endedAt, minutes, bundleBytes, outcome, result, resultEvidence, launchStatus, failedBeforeSession, refusedFor, tree, gatePassedOnTree, openImplementers, findings[], priorFindings[] }` |
| `findings`, `findingsOpen`, `impactGaps` | numbers |
| `findingsBySeverity` | `{ <severity or "unrated">: count }` |
| `findingList[]` | `{ round, id, severity, status, category, settled, fixedIn }` |
| `criteria`, `criteriaAtFreeze`, `criteriaAmendments` | numbers |
| `scope` | `{ amendments, criteriaAdded, criteriaChanged, criteriaDropped, endpoints, errorCodes, repos }` |
| `implementers` | `{ opened, closed, open: [agent ids] }` |
| `holds` | number |
| `observedModels[]` | every model seen |
| `tokensByModel` | `{ <model>: { input, output, cacheRead, cacheWrite, total, cost } }` |
| `tokens`, `subagentTokens` | numbers |
| `cost` | US dollars for the priced models, or null |
| `unpricedModels[]` | models with tokens and no price |
| `unpricedTokens`, `unpricedShare` | tokens of those models, and their share of the attempt's tokens (0 to 1; null with no tokens) |
| `refusalCount`, `refusalsById` | refusals logged against the attempt, and `{ <check id>: count }` most frequent first |
| `maxReviewerBundleBytes` | the largest reviewer bundle handed, in bytes (null when no bundle file is left) |
| `openObservations` | findings kept open without blocking |
| `strategyDecisions`, `strategyTripwires`, `tripwiresFired[]` | strategist events; 0 and `[]` without them |
| `roles[]` | per handoff: `handoff, at, role, agent, runtime, session, work, class, declaredEffort, observedEffort, effortMismatch, agentType, model, wallMinutes, activeMinutes, rounds, roundDetail[], sessionModel, bundleBytes, outputTokens, tokens, sharedTranscript, cost, unpricedModels[], children[], childCost, tokensByModel, toolCalls` |

Each `children[]` entry: `{ agentId, name, agentType, depth, model, outputTokens, tokens, cost, unpricedModels }`. Transcript paths and raw usage records are left out.

## What telemetry cannot tell

- **Why a finding happened.** Whether it was a reviewer miss, a regression from an earlier fix or a defect in added scope is a judgement. The ledger links a finding to the commit that fixed it (when a trailer or the closure names it), never to the commit that introduced it.
- **Fixes nobody names.** A fix commit without a `Fixes-finding` trailer, and a verification without `fixedIn`, leave `fixedIn` empty.
- **When an agent really finished.** Implementers are closed only by `wf handoff close`, which the owner runs when the agent reports; an unclosed implementer looks open forever and blocks the next reviewer handoff. Nothing proves the agent stopped editing when it was closed; the review is still bound to the tree it was handed. Who edited the tree during a review is not recorded, only that it changed.
- **The owner's decisions.** Scope rulings survive only as amendment reasons and stated `scope`; a stop reason is as good as its text and class. Nothing records a decision made in conversation.
- **Scope the amendment does not state.** Endpoints, error codes and repos are counted only when the amendment's `scope` block names them; nothing checks them against the code.
- **Agents outside the attempt.** Sub-agents are attributed only through Claude Code's `parentAgentId` chain from an implementer's transcript. Agents the owner starts without a handoff, sub-agents of reviewers or planners (not recorded in the ledger, though the report still finds them for any Claude handoff it can read) and other runtimes' child agents are not.
- **Concurrency.** Overlap between agents, gates and reviews is visible only through timestamps: which agents ran at the same time is not recorded.
- **What a reviewer actually looked at.** `gatePassedOnTree` says gate evidence was available; the closure's `screenshotsInspected` says which screenshots it claims to have opened; neither proves understanding.
- **Exact cost.** Cost is list price × tokens from transcripts. Discounts, batch pricing, fast mode, partner platforms and anything outside the transcripts are not seen; derived cache prices are estimates; an unpriced model has no cost.
- **Failing tests a runner never printed.** Names come only from JUnit or Playwright JSON reports a step declares, or from output in a format listed above; otherwise only the exit code and the last lines.
- **Time inside an agent.** Phases come from ledger timestamps, so an agent's own idle time inside a phase is not split out; compare active minutes per handoff for that.
- **Resources.** Memory and CPU peaks are not sampled.
