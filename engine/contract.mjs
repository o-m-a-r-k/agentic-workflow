// The 0.8 seam contract (docs/design-0.8.md, section 12, stream 0).
//
// Seven streams build 0.8 in parallel. This file is the only place one stream learns another's interface:
//   - the schema 2 ledger events and their payloads (EVENTS);
//   - the refusal ids (REFUSALS), the commands and their handlers (COMMANDS), the reserved decision kinds (DECISION_KINDS);
//   - the normalised adapter (typedef Adapter) and the onboarding-owned policy keys (POLICY_KEYS);
//   - every cross-stream function, as a facade bound to the module of the stream that owns it.
//
// Rules of the seam:
//   1. A stream calls another stream's function only through this file (`import { runTests } from './contract.mjs'`),
//      never by importing the other stream's module. Inside one stream, modules import each other freely.
//   2. Every cross-stream function is async: the facade loads the owning module on first call.
//   3. A stream implements its functions by exporting, from the module named in its facade, an object
//      `export const implements08 = { <name>: fn, ... }`. Until that export exists the facade throws NotBuiltError naming
//      the owning stream. Same-named 0.7 exports never satisfy a facade (0.7 `ledger.mjs` exports an `append` of its own);
//      a module is read for the word `implements08` before it is imported, so an unbuilt facade never loads the 0.7 engine.
//   4. Refusals are thrown with `refusal(id, message, hint)`, `id` one of REFUSALS. Other errors are `WfError` (exit 1).
//   5. Tests replace any facade with a double: `setDoubles({ name: fn })` in-process, or `WF_DOUBLES=<module file>` for a
//      spawned `wf` (its default export is `{ name: fn }`). Doubles are matched by facade name.
//   6. Ledger writes go only through `append` (stream 5); adapter reads only through `loadAdapter` (stream 6); only
//      stream 7 writes adapter files; only stream 1's cli.mjs wires commands, each to the handler named in COMMANDS.
//
// Terms: project (the set of repos one adapter describes), repo, attempt (one try at one item, id `<item>.<n>`), item (the
// tracker's id for the work), session (`{ runtime, id }`, one host conversation), the person (the human who owns the
// reserved decisions), owner (the agent session that runs an attempt).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTRACT_VERSION = '0.8.0';
export const SCHEMA = 2;

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

// Exit codes: 1 usage or configuration error, 75 refusal (the state does not allow the action). Same as 0.7, so hosts and
// skills that read exit codes keep working.
export class WfError extends Error {
  constructor(message, { code = 1, hint = null } = {}) {
    super(message);
    this.name = 'WfError';
    this.code = code;
    this.hint = hint;
  }
}

export class NotBuiltError extends Error {
  constructor(name, stream, module) {
    super(`${name} is not built: stream ${stream} (${STREAMS[stream]}) implements it in engine/${module}`);
    this.name = 'NotBuiltError';
    this.code = 'WF_NOT_BUILT';
    this.fn = name;
    this.stream = stream;
    this.module = module;
  }
}

// The 19 refusal ids (design section 2, "Refusals"). Each is a fact check with a named failure; adding one is rule-shaped
// and counted against budget.json.
export const REFUSALS = Object.freeze({
  'start:open': { stream: 1, when: 'the item already has an open or held attempt' },
  'criteria:max': { stream: 1, when: 'more than 6 criteria' },
  'review:tree': { stream: 1, when: 'the recorded review\'s tree is not HEAD' },
  'review:independent': { stream: 1, when: 'the reviewer\'s session implemented, or wf did not launch it' },
  'review:coverage': { stream: 1, when: 'product files in the diff are unread by the reviewer' },
  'review:size': { stream: 1, when: 'the product diff is above the split size for one reviewer (or a risk change above it)' },
  'finding:other-own': { stream: 1, when: '`other` on a line this attempt wrote' },
  'screens:width': { stream: 2, when: 'a capture\'s width differs from the requested viewport' },
  'screens:dup': { stream: 2, when: 'a capture\'s bytes duplicate a capture of a different screen' },
  'merge:open': { stream: 1, when: 'a `goal` or `regression` finding is open' },
  'merge:unreviewed': { stream: 1, when: 'anything other than git\'s automatic merge from the base changed since the last reviewed tree' },
  'merge:foreign': { stream: 1, when: 'a merge commit\'s second parent is not the base, or is reachable from another remote branch' },
  'merge:untested': { stream: 1, when: 'no passing `full` run on the landed tree, from the landing queue or CI' },
  'fix:no-progress': { stream: 1, when: 'an implementer handoff after a review that reopened a fixed finding or did not lower the blocker count, until the person decides' },
  'merge:risk': { stream: 1, when: 'a risk path is touched and a risk test, its merge-base failure or the second review is missing, or the diff-read is missing with diffRead: before' },
  'merge:waiver': { stream: 1, when: 'a waiver or a loosened criterion is unanswered' },
  'stage:deploy': { stream: 3, when: 'a production deploy without the person\'s decision' },
  hold: { stream: 3, when: 'any delivery step under a hold (stream 1 also refuses start/handoff/review steps that deliver)' },
  'answer:not-person': { stream: 4, when: 'the answer fails the answer rule' },
});

// A refusal: exit 75, a stable id (counted by stream 5's refusal log), a message saying the fact, and a hint naming the
// one command that moves on. Throws on an id outside REFUSALS: a new id is a budget change, not a call site.
export function refusal(id, message, hint = null) {
  if (!Object.hasOwn(REFUSALS, id)) throw new Error(`unknown refusal id \`${id}\`: the 0.8 refusal ids are in engine/contract.mjs REFUSALS`);
  const e = new WfError(message, { code: 75, hint });
  e.refusalId = id;
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------
// Places (concrete: every stream needs the same answer)
// ---------------------------------------------------------------------------------------------------------------------

// The person's user folder: the user-folder adapters (`projects/<name>.yaml`, a git repo of its own), telemetry
// (`telemetry/<project>.jsonl`), proposals (`proposals/<project>.jsonl`), the digest, the machine-wide test locks
// (`locks/`). WF_USER_DIR moves it (scenarios point it into a temporary folder).
export const userDir = (env = process.env) => env.WF_USER_DIR || path.join(os.homedir(), '.agentic-workflow');
// The home folder host transcripts are read under (each host's own store below it, engine/hosts/). WF_HOST_HOME moves it.
export const hostHome = (env = process.env) => env.WF_HOST_HOME || os.homedir();
// Per-project state, the same place 0.7 used, so old ledgers stay readable and attempt numbers continue:
//   <root>/.wf-evidence/attempts/<attempt>/ledger.jsonl   (stream 5 writes it; nothing else does)
//   <root>/.wf-worktrees/<attempt>/<repo>/                 (stream 1 creates and removes them)
//   <root>/.wf-evidence/attempts/<attempt>/{tests,screens,reviews,decisions}/  (files the owning stream writes)
export const ledgerFile = (root, attempt) => path.join(root, '.wf-evidence', 'attempts', attempt, 'ledger.jsonl');
export const attemptDir = (root, attempt) => path.join(root, '.wf-evidence', 'attempts', attempt);
export const worktreeDir = (root, attempt, repo) => path.join(root, '.wf-worktrees', attempt, repo);
// Attempt ids continue 0.7's: `<item>.<n>`, n from 1, counted across every ledger of the item and every branch named
// `wf/<item>.<n>` (abandoned and superseded attempts included).
export const attemptId = (item, n) => `${item}.${n}`;
export const branchName = (attempt) => `wf/${attempt}`;
// The ledger of project-level decisions (stream 4's `ask` with no attempt). It is not an attempt: listAttempts never lists
// it, and telemetry never rows it.
export const PROJECT_LEDGER = 'wf-project';
// A finding's location: `<repo>/<path>:<line>`, path relative to the repo, line in the attempt's tree.
export const parseLocation = (loc) => {
  const m = /^([^/]+)\/(.+):(\d+)$/.exec(String(loc));
  return m ? { repo: m[1], path: m[2], line: Number(m[3]) } : null;
};
// The idempotency marker every tracker write carries (design section 5, "Stages").
export const marker = (attempt, stage) => `wf:${attempt}:${stage}`;

// ---------------------------------------------------------------------------------------------------------------------
// Shared types (JSDoc; every stream's inputs and outputs are built from these)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ runtime: string, id: string }} Session   runtime: the id of a host registered in engine/hosts/.
 * @typedef {{ repo: string, path: string }} ModuleRef    resolved in the attempt's worktree of `repo` (or the repo's
 *   checkout when there is no attempt).
 * @typedef {{ run?: string, module?: ModuleRef, lock?: { name: string, count: number } }} TestSpec
 *   exactly one of run/module. A module's default export is `async (ctx) => ({ pass: boolean, log?: string })`, ctx
 *   `{ cwd, repo, kind, attempt, env }`. `lock`: a machine-wide counted lock shared by every project on the machine.
 * @typedef {{ name: string, path: string, base: string, remote: string,
 *   provision: { clone: string[], fingerprint: string[], install: string|null, copyIgnored: string[] },
 *   tests: { fast: TestSpec|null, full: TestSpec|null },
 *   kinds: { tests: string[], other: string[] } }} RepoSpec
 *   path is relative to the project root. remote defaults to `origin` (git's own default), base has no default.
 * @typedef {{ labels?: string[] }} StageWhen
 * @typedef {{ do: 'land'|'push'|'merge-request'|'wait-merged'|'confirm-deployed'|'deploy'|'status'|'comment'|'module',
 *   branch?: string, to?: string, comment?: string, repos?: string[], where?: string, when?: StageWhen,
 *   after?: string, module?: ModuleRef }} Stage
 *   `comment` names a comment kind (`uat`, `deployed`, ...) whose text the owner writes; `after` names another item.
 * @typedef {{ id: string, paths: string[], reason: string, tests: string[] }} RiskPath
 *   paths and tests are globs relative to the project root (`<repo path>/...`).
 * @typedef {object} Adapter   the normalised schema 2 adapter, as loadAdapter returns it. Every key below is present
 *   (defaults filled); keys an adapter does not set are null or empty, never missing.
 * @property {2} version
 * @property {string} name
 * @property {string} root            absolute project root
 * @property {{ file: string, location: 'user'|'repo', hash: string }} source   the adapter file and its sha256
 * @property {{ connectors: string[], tools: string[], skills: string[] }} requires
 * @property {RepoSpec[]} repos
 * @property {{ id: string, repo: string, dependsOn: { contract: string }[] }[]} components
 * @property {string|null} invariants  path relative to root
 * @property {{ paths: string[], read: string[] }[]} rules
 * @property {{ routes: ModuleRef|null, shared: string[], sentinel: string[], langs: { lang: string, dir: 'ltr'|'rtl' }[],
 *   viewports: number[], capture: string|null }} screens
 *   routes module default export: `async (changedFiles: string[]) => string[]` (routes). capture placeholders:
 *   {out} {viewport} {lang} {dir} {routes}.
 * @property {{ diffRead: 'before'|'after' }} review
 * @property {{ confirmed: boolean, paths: RiskPath[] }} risk   `risk: none` → { confirmed: true, paths: [] };
 *   a missing key → { confirmed: false, paths: [] } (onboarding refuses to finish on it).
 * @property {{ tracker: string|{ module: ModuleRef }, via: 'connector'|'module'|'files'|'none', idPattern: string|null,
 *   take: { status: string }|null,
 *   followUps: { mode: 'file'|'digest'|'off', team?: string, status?: string, label?: string },
 *   operations: Record<string, string> }} ticketing
 *   via: `module` → the engine calls the tracker module's TrackerDriver methods; `connector` → the owner agent performs
 *   each operation through its host's connector, in the words of `operations` (merged over the module's own
 *   `operations` export when the tracker is a module), and the engine reads the result back (D68); `files` → a local
 *   folder of issue files; `none` → no tracker. operations: plain text per operation (fileFollowUp, search, readIssue,
 *   setStatus, comment, attach, readBack). A plain string tracker names a built-in tracker of stream 3.
 * @property {{ landing: 'queue'|'direct', order: string[], authority: { push: 'agent'|'person', mergeRequest: 'agent'|'person',
 *   merge: 'agent'|'person' }, stages: Stage[] }} delivery   order defaults to the repos' order.
 * @property {Record<string, string>} models   one model per role (planner, implementer, reviewer, secondReviewer, tester,
 *   drafter); a missing role uses the host's default.
 * @property {{ adapter: { rules: number, risk: number, modules: number, operationWords: number } }} budget
 * @property {{ at: string|null, engine: string|null, hashes: Record<string, string> }} onboarded   written by stream 7
 *   only: the hash of each POLICY_KEYS value as onboarding last wrote it; a current hash that differs is a hand edit.
 */

// The keys onboarding owns (design section 5). A value's hash is sha256 of its canonical JSON (canonicalJson below).
export const POLICY_KEYS = Object.freeze(['risk', 'review.diffRead', 'delivery.stages', 'ticketing.operations', 'tests', 'screens']);

// Canonical JSON: keys sorted, undefined dropped (as JSON writes it), so equal values hash equally in every stream.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Findings and reviews.
 * @typedef {'low'|'medium'|'high'|'critical'} Severity
 * @typedef {'goal'|'regression'|'other'} FindingClass
 * @typedef {{ id: string, location: string, what: string, why: string, severity: Severity, class: FindingClass }} Finding
 *   id: assigned by recordReview (`F<n>`, unique per item across attempts); a reviewer's input omits it. location: see
 *   parseLocation. `goal` and `regression` block the merge at every severity.
 * @typedef {{ seat: 'whole'|'second'|`area:${string}`, attempt: string, tree: string, round: number,
 *   prompt: string, files: { diff: string, criteria: string, criteriaDiff: string|null, invariants: string|null,
 *   rules: string[], consumers: string[], screens: string[], riskChecklist: string|null, sharedFiles: string[] },
 *   verify: string[], productFiles: string[], productLines: number, model: string|null }} ReviewBundle
 *   prompt: the reviewer's whole prompt (role text + the bundle's paths). verify: ids of open blockers the reviewer
 *   verifies first on a later round. productFiles: `<repo>/<path>` the coverage check requires read.
 * @typedef {{ session: Session, seat: ReviewBundle['seat'], tree: string,
 *   findings: Omit<Finding, 'id'>[], verified: { id: string, status: 'fixed'|'open' }[] }} ReviewInput
 * @typedef {{ id: keyof typeof REFUSALS, message: string }} Problem   a fact that refuses a merge (mergeFacts).
 * @typedef {{ repo: string, path: string, kind: 'product'|'tests'|'other', added: number, removed: number, status: 'A'|'M'|'D'|'R' }} ChangedFile
 */

/**
 * Tests, screens, landing.
 * @typedef {'fast'|'full'|'risk-base'} TestKind   risk-base: the repo's `fast` tests run on a worktree at the merge-base
 *   with the attempt's changed `risk.tests` files applied; it must fail (design section 2, "Higher-risk paths").
 * @typedef {{ pass: boolean, tree: string, ms: number, exitCode: number|null, log: string }} TestResult   log: a file path.
 * @typedef {{ route: string, viewport: number, lang: string|null, dir: 'ltr'|'rtl'|null, width: number, height: number,
 *   file: string, sha256: string, sentinel: boolean }} ScreenImage
 * @typedef {{ landed: { attempt: string, repo: string, sha: string }[],
 *   failed: { attempt: string, repo: string, reason: string, log: string|null }[] }} LandResult
 */

/**
 * Tracker and delivery.
 * @typedef {{ id: string, title: string, status: string|null, labels: string[]|null, url: string|null, body?: string }} Issue
 *   labels null: the tracker could not be read; every `when: labels` filter on it is `pending`, never false.
 * @typedef {{ state: 'done', value: any } | { state: 'pending', operation: string, marker: string }} TrackerResult
 *   pending: a connector operation the owner agent performs (`operation` is the adapter's own words, D68); the engine
 *   reads the result back from the owner's transcript (connectorCalls) on the next call.
 * @typedef {object} TrackerDriver   what a tracker module exports by default (`ticketing.tracker: { module }`), and what
 *   the built-in trackers implement. Every method is async; `null` from read means not found.
 * @property {(id: string) => Promise<Issue|null>} read
 * @property {(q: { text?: string, marker?: string }) => Promise<Issue[]>} search   open issues whose title or body
 *   contains `text`, or any issue or comment carrying `marker`.
 * @property {(i: { title: string, body: string, team?: string, status?: string, label?: string, marker: string }) =>
 *   Promise<{ id: string }>} create   body carries the marker.
 * @property {(id: string, status: string) => Promise<void>} setStatus
 * @property {(id: string, c: { body: string, marker: string, files?: string[] }) => Promise<void>} comment
 * @property {(raw: string) => Promise<string|null>} [normalise]   the tracker's canonical id for `raw`, or null.
 * @typedef {{ state: 'done'|'waiting'|'pending'|'skipped', evidence: any, next: string|null, waitedMin?: number }} StageResult
 *   waiting: a fact the engine checks again later (a merge, a label, the landing queue); pending: the owner performs an
 *   operation (`next` says it); skipped: `when:` did not match. A refused stage throws (refusal `stage:deploy` or `hold`).
 */

/**
 * Decisions and hosts.
 * @typedef {'deploy'|'waiver'|'loosen'|'diff-read'|'foreign-merge'|'no-progress'|'release'|'priority-other'} DecisionKind
 * @typedef {{ kind: DecisionKind, question: string, options: string[], refs: string[], blocking: boolean }} Question
 *   question: plain words; refs: finding ids, criterion ids or a stage index. blocking: also asked at once (else digest).
 * @typedef {{ id: string, choice: string, quote: string, via: 'turn'|'panel', session: Session, at: string }} Answer
 * @typedef {{ turns: { at: string, human: boolean }[], tokens: { input: number, output: number, cacheRead: number,
 *   cacheWrite: number }, cost: number|null, model: string|null }} SessionActivity
 */

/**
 * Ledger, telemetry, learning.
 * @typedef {{ seq: number, at: string, type: string, actor: Session|null, data: object, prev: string|null, hash: string,
 *   schema?: 2 }} LedgerEntry   schema-1 entries (0.7) have no `schema` and 0.7 types; readEvents returns both.
 * @typedef {object} AttemptState   attemptState's fold of the ledger (schema 2 events; a schema-1 ledger folds to
 *   { schema: 1, open, outcome, item, id } only).
 * @property {string} id
 * @property {string} item
 * @property {number} n
 * @property {1|2} schema
 * @property {boolean} open
 * @property {'shipped'|'abandoned'|'superseded'|null} outcome
 * @property {Session|null} owner
 * @property {Record<string, { branch: string, base: string, baseSha: string, worktree: string }>} repos
 * @property {Stage[]} stages   the snapshot taken at start
 * @property {{ list: { id: string, text: string }[], areas: string[], hash: string|null, history: object[] }} criteria
 * @property {object[]} tests     test.run payloads, with `at`
 * @property {object[]} screens   screens.captured payloads, with `at`
 * @property {object[]} handoffs  handoff payloads, with `at`
 * @property {object[]} reviews   review.recorded payloads, with `at`
 * @property {Record<string, Finding & { status: 'open'|'fixed'|'reopened'|'filed'|'waived', review: number,
 *   history: { at: string, status: string, review: number }[] }>} findings
 * @property {Record<string, Question & { id: string, askedAt: string, answer: Answer|null }>} decisions
 * @property {{ reason: string, quote: string, at: string }|null} hold
 * @property {Record<number, StageResult & { at: string }>} stageResults   the last result per stage index
 * @property {object[]} landings
 * @property {object[]} baseUpdates
 * @typedef {object} TicketRow   schema `wf-ticket@1`, one per attempt (design section 7). Every field is present; a value
 *   the sources do not hold is null.
 * @property {'wf-ticket@1'} schema
 * @property {string} project
 * @property {string} item
 * @property {string} attempt
 * @property {string} engine
 * @property {'shipped'|'abandoned'|'superseded'|null} outcome
 * @property {number} wallMin
 * @property {number} activeMin
 * @property {{ from: string, to: string, min: number }[]} unexplainedGaps
 * @property {number} personWaitMin
 * @property {number} holdMin
 * @property {Record<string, number>} stageWaitMin   by stage `do`
 * @property {number} reviews
 * @property {number} blockingReviews
 * @property {number} emptyReviews
 * @property {number} fixRounds
 * @property {'complete'|'unverified'|null} coverage
 * @property {{ fast: number, full: number }} testRuns
 * @property {number} testMin
 * @property {{ batches: number, bisects: number }} landing
 * @property {{ product: number, tests: number, other: number }} diff
 * @property {{ goal: number, regression: number, other: number, filed: number, digested: number }} findings
 * @property {number} introducedByRepair
 * @property {{ count: number, byId: Record<string, number> }} refusals
 * @property {number} screens
 * @property {boolean} riskTouched
 * @property {{ lines: number, share: number, commits: number }|null} rework   null until 48 hours after delivery
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} tokens
 * @property {number|null} cost
 * @typedef {{ id: string, source: 'telemetry'|'incident'|'person', scope: 'project'|'plugin', project: string|null,
 *   change: string, replaces: string, metric: keyof TicketRow, guard: keyof TicketRow, minMove: number,
 *   baseline: { median: number, spread: number, n: number }, created: string, expires: string,
 *   status: 'proposed'|'active'|'kept'|'reverted'|'expired' }} Proposal
 *   minMove and baseline are set by the engine from the last 8 rows, never by the drafter.
 */

/**
 * Onboarding.
 * @typedef {'decimal-type'|'currency-type'|'rounding'|'auth'|'permission'|'outbound-client'|'webhook-handler'|
 *   'queue-consumer'|'migration'|'schema'|'mobile-app'|'ci-file'|'test-script'|'instruction-doc'|'invariants-doc'} FactKind
 *   structural facts only: the plugin ships no domain vocabulary; the project's own documents name its areas.
 * @typedef {{ root: string, repos: { name: string, path: string, dirs: string[], modules: string[],
 *   facts: { kind: FactKind, path: string, evidence: string }[] }[] }} ScanFacts
 * @typedef {{ key: string, from: any, to: any, reason: string, handEdited: boolean }} PolicyChange
 *   key: one of POLICY_KEYS (or a dotted key below one). reason cites ScanFacts paths.
 * @typedef {{ changes: PolicyChange[], unchanged: string[] }} PolicyDiff
 */

/**
 * Commands.
 * @typedef {{ cwd: string, root: string|null, env: Record<string, string>, actor: Session|null, json: boolean }} CommandContext
 *   root: null when no adapter was found (init and doctor accept that). actor: callerSession(env).
 * @typedef {{ _: string[], flags: Record<string, string|true|string[]> }} ParsedArgs   cli.mjs parses `--k v`, `--k`
 *   (true) and repeated `--k` (array); handlers validate their own flags and throw WfError on a bad one.
 * @typedef {{ text: string, data?: object, exitCode?: number }} CommandResult   text for people; data for `--json`.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Ledger events (schema 2). Payload: the required data fields. `append` refuses a type outside this list or a payload
// missing a required field; optional fields are listed after `|`.
// ---------------------------------------------------------------------------------------------------------------------
export const EVENTS = Object.freeze({
  // stages: the delivery stage list snapshotted at start. repos: { <name>: { branch, base, baseSha, worktree } }.
  'attempt.started': { stream: 1, required: ['item', 'n', 'repos', 'stages', 'adapter', 'engine'], optional: ['from'] },
  // criteria: [{ id: 'C1'.., text }], 1–6. hash: sha256 of canonicalJson(criteria). previous: the prior hash or null.
  // loosened: criterion ids an edit after a blocker loosened or dropped (each also gets a `waiver`/`loosen` decision).
  'criteria.set': { stream: 1, required: ['criteria', 'areas', 'hash', 'previous'], optional: ['loosened', 'diff'] },
  // kind: TestKind. source: 'attempt'|'landing'|'ci'. log: a file path.
  'test.run': { stream: 2, required: ['repo', 'kind', 'tree', 'pass', 'exitCode', 'ms', 'source'], optional: ['log', 'lock', 'landing'] },
  // images: ScreenImage[]. tree: the attempt's tree hash over all repos.
  'screens.captured': { stream: 2, required: ['tree', 'images'], optional: ['routes', 'refused'] },
  // role: planner|implementer|reviewer|tester. launchedBy: 'wf' (stream 4 launched it) | 'owner'. A reviewer is always 'wf'.
  handoff: { stream: 1, required: ['role', 'session', 'launchedBy'], optional: ['seat', 'model', 'tree', 'round'] },
  // review: 1.. per attempt. findings: Finding[] (ids assigned). verified: [{ id, status }]. blockers: open goal+regression
  // after this review. coverage: 'complete'|'unverified' (a host with no readable transcript).
  'review.recorded': { stream: 1, required: ['review', 'round', 'seat', 'tree', 'session', 'coverage', 'findings', 'verified', 'blockers'], optional: ['model', 'filesRead', 'unread'] },
  // mode: file|digest|off. state: done|pending. ticket: the filed id, or null (pending, digest, off, or a duplicate found).
  'finding.filed': { stream: 1, required: ['finding', 'mode', 'state', 'marker'], optional: ['ticket', 'duplicateOf', 'priority'] },
  // Question fields plus id ('D<n>' per attempt).
  'decision.asked': { stream: 4, required: ['id', 'kind', 'question', 'options', 'refs', 'blocking'], optional: [] },
  // Answer fields. Only written when the answer rule holds. turnAt: when the person's turn was written, so the answer is
  // checked against the transcript again at use.
  'decision.answered': { stream: 4, required: ['id', 'choice', 'quote', 'via', 'session'], optional: ['turnAt'] },
  // The person's words. A hold is recorded at once on their request.
  hold: { stream: 1, required: ['reason', 'quote'], optional: [] },
  // decision: the answered 'release' decision id.
  release: { stream: 1, required: ['decision'], optional: [] },
  // git's automatic merge of the base into the attempt branch. merge: the merge commit.
  'base.updated': { stream: 1, required: ['repo', 'from', 'to', 'merge'], optional: [] },
  // index: into the snapshot (-1 for the `ticketing.take` status at start). state: StageResult state.
  stage: { stream: 3, required: ['index', 'do', 'state'], optional: ['repo', 'evidence', 'next', 'waitedMin', 'marker'] },
  // Written to every attempt in the batch. result: landed|failed|returned (returned: bisect found this one).
  landing: { stream: 2, required: ['batch', 'repo', 'attempts', 'result'], optional: ['sha', 'full', 'bisects', 'log'] },
  // outcome: shipped|abandoned|superseded. shipped by patch-id carries patchIds; outsideStages: true when its delivery
  // stages were not done (D16), also on the row.
  'attempt.closed': { stream: 1, required: ['outcome', 'reason'], optional: ['patchIds', 'outsideStages', 'row'] },
});

// Reserved decisions (design section 2). Each kind's owner asks it through `ask` (stream 4).
export const DECISION_KINDS = Object.freeze({
  deploy: { asker: 3, blocking: true },
  waiver: { asker: 1, blocking: true },
  loosen: { asker: 1, blocking: true },
  'diff-read': { asker: 1, blocking: true },
  'foreign-merge': { asker: 1, blocking: true },
  'no-progress': { asker: 1, blocking: true },
  release: { asker: 1, blocking: true },
  'priority-other': { asker: 1, blocking: false },
});

// ---------------------------------------------------------------------------------------------------------------------
// Facades
// ---------------------------------------------------------------------------------------------------------------------

export const STREAMS = Object.freeze({
  1: 'flow',
  2: 'tests, screens, landing',
  3: 'tracker, delivery',
  4: 'decisions, hosts',
  5: 'telemetry, learning',
  6: 'config and texts',
  7: 'onboarding and migration',
});

/** Every cross-stream function: name → { stream, module, signature }. Filled by `seam` below. */
export const SIGNATURES = {};

const doubles = new Map();
let envDoubles = null;
export function setDoubles(map) {
  for (const [k, v] of Object.entries(map)) {
    if (!Object.hasOwn(SIGNATURES, k)) throw new Error(`no facade named \`${k}\` in engine/contract.mjs`);
    doubles.set(k, v);
  }
}
export function clearDoubles() {
  doubles.clear();
}
// WF_DOUBLES is honoured only in a test run (WF_TEST=1): production never loads doubled facts.
async function doubleOf(name) {
  if (doubles.has(name)) return doubles.get(name);
  const file = process.env.WF_DOUBLES;
  if (!file || process.env.WF_TEST !== '1') return null;
  envDoubles ??= import(pathToFileURL(path.resolve(file)).href).then((m) => m.default ?? {});
  const map = await envDoubles;
  return typeof map[name] === 'function' ? map[name] : null;
}

const ENGINE = path.dirname(fileURLToPath(import.meta.url));
async function implementation(name, stream, module) {
  const file = path.join(ENGINE, module);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new NotBuiltError(name, stream, module);
  }
  if (!text.includes('implements08')) throw new NotBuiltError(name, stream, module);
  const impl = (await import(pathToFileURL(file).href)).implements08?.[name];
  if (typeof impl !== 'function') throw new NotBuiltError(name, stream, module);
  return impl;
}

function seam(stream, module, name, signature) {
  SIGNATURES[name] = { stream, module, signature };
  const facade = async (...args) => (await doubleOf(name) ?? await implementation(name, stream, module))(...args);
  Object.defineProperty(facade, 'name', { value: name });
  return facade;
}

// ---- Stream 1: flow ---------------------------------------------------------------------------------------------------

/** Start an attempt. Refuses `start:open`. Calls normaliseId (3), loadAdapter (6), append (5), runStage (3) for
 * `ticketing.take`. Fetches each repo's remote, creates `branchName(id)` at the fetched tip of its base in
 * `worktreeDir`, provisions it, snapshots `delivery.stages`, appends `attempt.started`.
 * @type {(root: string, rawItem: string, opts: { actor: Session|null, repos?: string[] }) => Promise<AttemptState>} */
export const start = seam(1, 'attempt.mjs', 'start', '(root, rawItem, { actor, repos? }) → AttemptState');

/** Set or edit the criteria. Refuses `criteria:max`. An edit after a blocker that loosens or drops a cited criterion
 * asks a `loosen` decision (via ask, 4) and returns its id; it does not refuse.
 * @type {(root: string, attempt: string, input: { criteria: { id?: string, text: string }[], areas: string[] }, opts: { actor: Session|null })
 *   => Promise<{ hash: string, loosened: string[], decision: string|null }>} */
export const setCriteria = seam(1, 'flow.mjs', 'setCriteria', '(root, attempt, { criteria, areas }, { actor }) → { hash, loosened, decision }');

/** The reviewer bundles for HEAD: one `whole` (plus `second` on a risk path), or `area:<name>` bundles above the split
 * size. Refuses `review:size` for a risk change above the size. Writes the bundle files under attemptDir/reviews/.
 * @type {(root: string, attempt: string) => Promise<{ tree: string, bundles: ReviewBundle[] }>} */
export const bundle = seam(1, 'flow.mjs', 'bundle', '(root, attempt) → { tree, bundles: ReviewBundle[] }');

/** Record one reviewer's review. Refuses `review:tree`, `review:independent`, `review:coverage` (via filesRead, 4),
 * `finding:other-own` (via blameToAttempt, 5). Files `other` findings (search/fileFollowUp, 3; priority ones via ask, 4).
 * @type {(root: string, attempt: string, input: ReviewInput) => Promise<{ review: number, findings: Finding[], blockers: number,
 *   coverage: 'complete'|'unverified' }>} */
export const recordReview = seam(1, 'flow.mjs', 'recordReview', '(root, attempt, ReviewInput) → { review, findings, blockers, coverage }');

/** The no-progress fact for an item, across its attempts: a fixed finding reopened, or the last review's blocker count
 * not lower than the one before. `decision`: the open or answered `no-progress` decision, if any.
 * @type {(root: string, item: string) => Promise<{ stop: boolean, reason: string|null, findings: string[], decision: string|null }>} */
export const noProgress = seam(1, 'flow.mjs', 'noProgress', '(root, item) → { stop, reason, findings, decision }');

/** Every fact that refuses a merge of `repo` (or every repo): merge:open, merge:unreviewed, merge:foreign,
 * merge:untested (when `landedTree` is given, else skipped: the landing run supplies it), merge:risk, merge:waiver, hold.
 * Never throws for a fact; returns them.
 * @type {(root: string, attempt: string, opts?: { repo?: string, landedTree?: string }) => Promise<Problem[]>} */
export const mergeFacts = seam(1, 'flow.mjs', 'mergeFacts', '(root, attempt, { repo?, landedTree? }) → Problem[]');

/** The attempt's product diff against its merge-base, per repo, classed by `kinds`.
 * @type {(root: string, attempt: string) => Promise<{ tree: string, files: ChangedFile[] }>} */
export const changedFiles = seam(1, 'base.mjs', 'changedFiles', '(root, attempt) → { tree, files: ChangedFile[] }');

// ---- Stream 2: tests, screens, landing --------------------------------------------------------------------------------

/** Run a repo's `fast`, `full` or `risk-base` tests and append `test.run`. Waits for the machine-wide lock when the spec
 * names one. `opts.cwd` runs in another worktree (the landing worktree; source 'landing').
 * @type {(root: string, attempt: string, repo: string, kind: TestKind, opts?: { cwd?: string, source?: 'attempt'|'landing'|'ci' })
 *   => Promise<TestResult>} */
export const runTests = seam(2, 'tests.mjs', 'runTests', '(root, attempt, repo, kind, { cwd?, source? }) → { pass, tree, ms, exitCode, log }');

/** Pick screens (reverse imports → `screens.routes`; `screens.shared` adds the sentinel set in every lang at the narrowest
 * viewport), capture them, append `screens.captured`. Refuses `screens:width`, `screens:dup`.
 * @type {(root: string, attempt: string) => Promise<ScreenImage[]>} */
export const capture = seam(2, 'screens.mjs', 'capture', '(root, attempt) → ScreenImage[]');

/** Land ready attempts: stack them on the current base in a landing worktree, run `full` once, push on green; on red
 * bisect, land the rest, return the failing one. Per repo, in `delivery.order`. Appends `landing` and `test.run`.
 * Calls mergeFacts (1) per attempt first; an attempt with a problem other than merge:untested is not landed.
 * @type {(root: string, ready: string[]) => Promise<LandResult>} */
export const land = seam(2, 'landing.mjs', 'land', '(root, ready: attempt[]) → { landed, failed }');

// ---- Stream 3: tracker, delivery --------------------------------------------------------------------------------------

/** The tracker's canonical id for a raw item: `ticketing.idPattern`, then the driver's `normalise` when it has one.
 * Throws WfError when the raw id does not match. verified: the tracker confirmed it (false through a connector).
 * @type {(root: string, raw: string) => Promise<{ item: string, verified: boolean }>} */
export const normaliseId = seam(3, 'tracker.mjs', 'normaliseId', '(root, raw) → { item, verified }');

/** Search the tracker (open issues by text, or anything carrying a marker).
 * @type {(root: string, q: { text?: string, marker?: string }) => Promise<TrackerResult>} value: Issue[] */
export const search = seam(3, 'tracker.mjs', 'search', '(root, { text?, marker? }) → TrackerResult<Issue[]>');

/** File one `other` finding per `ticketing.followUps` after searching for a duplicate and for its marker
 * (`marker(attempt, 'finding:<id>')`). mode digest/off files nothing and returns value null.
 * @type {(root: string, attempt: string, finding: Finding) => Promise<TrackerResult>} value: { id: string|null, duplicateOf: string|null } */
export const fileFollowUp = seam(3, 'tracker.mjs', 'fileFollowUp', '(root, attempt, Finding) → TrackerResult<{ id, duplicateOf }>');

/** Run one delivery stage: an index into the attempt's snapshot, or a Stage (start's `take`, index -1). Appends `stage`.
 * Refuses `hold`, `stage:deploy`. A `land` stage calls mergeFacts (1) and, with `landing: queue`, waits for a `landing`
 * event; with `direct`, calls land (2) with this attempt alone.
 * @type {(root: string, attempt: string, stage: number|Stage) => Promise<StageResult>} */
export const runStage = seam(3, 'delivery.mjs', 'runStage', '(root, attempt, stage: index|Stage) → { state, evidence, next }');

// ---- Stream 4: decisions, hosts ---------------------------------------------------------------------------------------

/** Ask the person one question (or return the id of the same open question: never asked twice). Appends
 * `decision.asked`; a non-blocking kind goes to the digest only.
 * @type {(root: string, attempt: string|null, q: Question) => Promise<{ id: string, shownAt: string, new: boolean }>} */
export const ask = seam(4, 'decisions.mjs', 'ask', '(root, attempt|null, Question) → { id, shownAt, new }');

/** The answer to a decision under the answer rule, read from host transcripts and the question panel; appends
 * `decision.answered` the first time it finds one. null while unanswered. A reading that fails the rule is null, never
 * a refusal; `wf approve` with such words refuses `answer:not-person`.
 * @type {(root: string, decision: string, opts?: { attempt?: string }) => Promise<Answer|null>} */
export const answered = seam(4, 'decisions.mjs', 'answered', '(root, decision, { attempt? }) → Answer|null');

/** The daily digest: sign-offs, priority `other` findings, stops, open questions, across the project's attempts.
 * @type {(root: string, opts?: { since?: string }) => Promise<{ items: object[], text: string }>} */
export const digest = seam(4, 'digest.mjs', 'digest', '(root, { since? }) → { items, text }');

/** Launch a fresh reviewer whose entire prompt is `bundle.prompt`; appends `handoff` (role reviewer, launchedBy wf).
 * Resolves once launched, not when done.
 * @type {(root: string, attempt: string, bundle: ReviewBundle, opts?: { model?: string }) => Promise<{ session: Session, launchedAt: string }>} */
export const launchReviewer = seam(4, 'launch.mjs', 'launchReviewer', '(root, attempt, ReviewBundle, { model? }) → { session, launchedAt }');

/** The files a session's transcript shows it read (absolute paths, in order, unique). null: the host keeps no readable
 * transcript (coverage `unverified`).
 * @type {(session: Session, opts?: { home?: string }) => Promise<string[]|null>} */
export const filesRead = seam(4, 'hosts/index.mjs', 'filesRead', '(session, { home? }) → string[]|null');

/** The session running this process, from the host's environment variables; null at a plain terminal.
 * @type {(env: Record<string, string>) => Promise<Session|null>} */
export const callerSession = seam(4, 'hosts/index.mjs', 'callerSession', '(env) → Session|null');

/** Turn times (human or not), token use, cost and model of a session, for telemetry.
 * @type {(session: Session, opts?: { home?: string }) => Promise<SessionActivity|null>} */
export const sessionActivity = seam(4, 'hosts/index.mjs', 'sessionActivity', '(session, { home? }) → SessionActivity|null');

/** Connector tool calls in a session (tool name matched by suffix), with input and the result as the host stored it.
 * @type {(session: Session, tools: string[], opts?: { home?: string, since?: string }) => Promise<{ tool: string, input: object, result: string, at: string }[]>} */
export const connectorCalls = seam(4, 'hosts/index.mjs', 'connectorCalls', '(session, tools, { home?, since? }) → [{ tool, input, result, at }]');

// ---- Stream 5: ledger, telemetry, learning ----------------------------------------------------------------------------

/** Append a schema 2 event. Throws WfError for a type outside EVENTS or a missing required field. Hash-chained,
 * serialised per attempt. The first event of a new attempt must be `attempt.started`.
 * @type {(root: string, attempt: string, type: keyof typeof EVENTS, data: object, actor: Session|null) => Promise<LedgerEntry>} */
export const append = seam(5, 'ledger.mjs', 'append', '(root, attempt, type, data, actor) → LedgerEntry');

/** Every entry of an attempt's ledger, schema 1 or 2, chain checked. Throws WfError for an unknown attempt or a broken chain.
 * @type {(root: string, attempt: string) => Promise<LedgerEntry[]>} */
export const readEvents = seam(5, 'ledger.mjs', 'readEvents', '(root, attempt) → LedgerEntry[]');

/** The folded state of one attempt.
 * @type {(root: string, attempt: string) => Promise<AttemptState>} */
export const attemptState = seam(5, 'ledger.mjs', 'attemptState', '(root, attempt) → AttemptState');

/** Attempt ids in the project (schema 1 and 2), optionally of one item, in attempt-number order.
 * @type {(root: string, opts?: { item?: string }) => Promise<string[]>} */
export const listAttempts = seam(5, 'ledger.mjs', 'listAttempts', '(root, { item? }) → string[]');

/** The telemetry row of one attempt, rebuilt from the ledger (schema 2 via its own fold, schema 1 via legacy07), git and
 * host transcripts (sessionActivity, 4). A 0.7 batch rolls up into its member tickets.
 * @type {(root: string, attempt: string) => Promise<TicketRow>} */
export const row = seam(5, 'telemetry.mjs', 'row', '(root, attempt) → TicketRow');

/** Whether a line of the attempt's tree was written by this attempt's commits (git blame against the merge-base).
 * @type {(root: string, attempt: string, location: string) => Promise<{ own: boolean, commit: string|null }>} */
export const blameToAttempt = seam(5, 'introduced.mjs', 'blameToAttempt', '(root, attempt, "<repo>/<path>:<line>") → { own, commit }');

/** Write an attempt's telemetry row into `<userDir>/telemetry/<project>.jsonl`, replacing an earlier row of that attempt
 * (`wf close` calls it once the attempt is closed, while its worktrees still exist). Stream 5 is the file's only writer.
 * @type {(root: string, attempt: string) => Promise<{ row: TicketRow, file: string }>} */
export const writeRow = seam(5, 'telemetry.mjs', 'writeRow', '(root, attempt) → { row, file }');

/** Count one refusal (the cli calls it for every refusal it prints).
 * @type {(root: string|null, attempt: string|null, id: string) => Promise<void>} */
export const recordRefusal = seam(5, 'refusals.mjs', 'recordRefusal', '(root|null, attempt|null, refusalId) → void');

/** Record a proposal. Refuses (WfError) a second active proposal on one metric per project, one plugin proposal per
 * release, a reverted change re-proposed within 60 days, or a missing `replaces`/`metric`/`guard`/`expires`.
 * @type {(root: string|null, draft: Omit<Proposal, 'id'|'minMove'|'baseline'|'created'|'status'>) => Promise<Proposal>} */
export const propose = seam(5, 'learn.mjs', 'propose', '(root|null, draft) → Proposal');

/** Judge a proposal (after 8 tickets or 21 days, whichever is later): kept when the metric moved by minMove and the guard
 * held, reverted otherwise or on missing data; a kept one expires after 90 days.
 * @type {(root: string|null, id: string, opts?: { now?: string }) => Promise<{ verdict: 'kept'|'reverted'|'not-yet', reason: string }>} */
export const judge = seam(5, 'learn.mjs', 'judge', '(root|null, proposalId, { now? }) → { verdict, reason }');

// ---- Stream 6: config ---------------------------------------------------------------------------------------------

/** Find the project for a folder: `<dir>/.workflow/project.yaml` walking up (location repo, root = that dir), or a
 * user-folder adapter whose `root:` contains `cwd`. Throws WfError when both exist; null when neither does.
 * @type {(cwd: string, opts?: { env?: Record<string, string> }) => Promise<{ root: string, file: string, location: 'user'|'repo' }|null>} */
export const findProject = seam(6, 'config.mjs', 'findProject', '(cwd, { env? }) → { root, file, location }|null');

/** Read, validate and normalise the adapter (typedef Adapter). Throws WfError listing every problem, or for a schema-1
 * adapter (naming `wf init --from-07`).
 * @type {(root: string, opts?: { env?: Record<string, string> }) => Promise<Adapter>} */
export const loadAdapter = seam(6, 'config.mjs', 'loadAdapter', '(root, { env? }) → Adapter');

/** Problems of a raw (parsed, not normalised) adapter object; [] when valid. Stream 7 checks a draft before writing.
 * @type {(raw: object) => Promise<string[]>} */
export const checkAdapter = seam(6, 'config.mjs', 'checkAdapter', '(raw) → problems[]');

/** The adapter's rules, risk paths, modules and operation words against `budget.adapter`.
 * @type {(adapter: Adapter) => Promise<{ counts: { rules: number, risk: number, modules: number, operationWords: number },
 *   limits: Adapter['budget']['adapter'], over: string[] }>} */
export const adapterBudget = seam(6, 'config.mjs', 'adapterBudget', '(Adapter) → { counts, limits, over }');

// ---- Stream 7: onboarding and migration -------------------------------------------------------------------------------

/** Read the repos as structural facts (FactKind). Never writes.
 * @type {(root: string, opts?: { repos?: { name: string, path: string }[] }) => Promise<ScanFacts>} */
export const scan = seam(7, 'scan.mjs', 'scan', '(root, { repos? }) → ScanFacts');

/** The per-key policy diff against the current adapter (null: none yet). `draft`: the policy a cheap model drafted from
 * the facts (the onboard skill runs it); without one, a draft from the facts alone. Hand-edited keys
 * (Adapter.onboarded.hashes differ) are marked, never silently changed.
 * @type {(facts: ScanFacts, current: Adapter|null, draft?: object) => Promise<PolicyDiff>} */
export const proposePolicy = seam(7, 'onboard.mjs', 'proposePolicy', '(ScanFacts, Adapter|null, draft?) → PolicyDiff');

/** Write the confirmed keys of a diff into the adapter (repo or user location; the user folder is committed in its own
 * git repo) and update `onboarded.hashes`. Writes nothing when nothing is confirmed or nothing changes.
 * @type {(root: string, diff: PolicyDiff, confirmed: string[], opts?: { location?: 'user'|'repo' }) => Promise<{ written: boolean, file: string, keys: string[] }>} */
export const writeAdapter = seam(7, 'onboard.mjs', 'writeAdapter', '(root, PolicyDiff, confirmedKeys, { location? }) → { written, file, keys }');

// ---------------------------------------------------------------------------------------------------------------------
// Commands (design section 3): name → owning stream, module, handler. cli.mjs (stream 1) parses argv into ParsedArgs,
// builds the CommandContext, calls `handler(ctx, args)`, prints the result, and on a refusal calls recordRefusal (5).
// Handler type: (ctx: CommandContext, args: ParsedArgs) => Promise<CommandResult>.
// ---------------------------------------------------------------------------------------------------------------------
const C = (stream, module, handler, does) => ({ stream, module, handler, does });
export const COMMANDS = Object.freeze({
  start: C(1, 'attempt.mjs', 'cmdStart', 'start <item>: a fresh attempt'),
  criteria: C(1, 'flow.mjs', 'cmdCriteria', 'criteria --file <f>: set or edit the criteria'),
  test: C(2, 'tests.mjs', 'cmdTest', 'test fast|full [--repo r]: run tests on the attempt tree'),
  screens: C(2, 'screens.mjs', 'cmdScreens', 'screens: pick and capture the touched screens'),
  review: C(1, 'flow.mjs', 'cmdReview', 'review [--record <f>]: launch reviewers on HEAD (with fast tests in parallel), or record one'),
  handoff: C(1, 'flow.mjs', 'cmdHandoff', 'handoff <role> --session <s>: record a planner, implementer or tester'),
  approve: C(4, 'decisions.mjs', 'cmdApprove', 'approve <decision> --choice <c> --quote "<words>": record the person\'s answer'),
  digest: C(4, 'digest.mjs', 'cmdDigest', 'digest: the person\'s daily digest'),
  hold: C(1, 'attempt.mjs', 'cmdHold', 'hold --reason "<words>": the person\'s veto'),
  release: C(1, 'attempt.mjs', 'cmdRelease', 'release: lift a hold on the person\'s answer'),
  land: C(2, 'landing.mjs', 'cmdLand', 'land: run the landing queue once'),
  deliver: C(3, 'delivery.mjs', 'cmdDeliver', 'deliver: run the next delivery stages'),
  status: C(1, 'flow.mjs', 'cmdStatus', 'status: one next command per attempt'),
  resume: C(1, 'flow.mjs', 'cmdResume', 'resume: what is next, after an interruption'),
  close: C(1, 'attempt.mjs', 'cmdClose', 'close: write the telemetry row, remove worktrees, keep branches'),
  abandon: C(1, 'attempt.mjs', 'cmdAbandon', 'abandon --reason "<why>"'),
  doctor: C(7, 'onboard.mjs', 'cmdDoctor', 'doctor: check the setup, the adapter budget and instruction files'),
  init: C(7, 'onboard.mjs', 'cmdInit', 'init [--from-07]: onboard or re-evaluate the project (alias: onboard)'),
  sync: C(7, 'onboard.mjs', 'cmdSync', 'sync: re-register the project and its skills'),
  report: C(5, 'telemetry.mjs', 'cmdReport', 'report: medians per project and engine version, uncovered commits'),
  learn: C(5, 'learn.mjs', 'cmdLearn', 'learn: draft, judge and apply proposals'),
  migrate: C(7, 'migrate.mjs', 'cmdMigrate', 'migrate attempts|material'),
  secrets: C(7, 'onboard.mjs', 'cmdSecrets', 'secrets guide|check: enter or check secrets without showing them'),
});
export const COMMAND_ALIASES = Object.freeze({ onboard: 'init' });

/** The handler facade of a command (aliases resolved). Throws WfError for an unknown command.
 * @returns {(ctx: CommandContext, args: ParsedArgs) => Promise<CommandResult>} */
export function commandHandler(name) {
  const key = COMMAND_ALIASES[name] ?? name;
  const c = COMMANDS[key];
  if (!c) throw new WfError(`unknown command \`${name}\`; the commands are: ${Object.keys(COMMANDS).join(', ')}`);
  return handlers[c.handler];
}
const handlers = Object.fromEntries(Object.values(COMMANDS).map((c) => [c.handler, seam(c.stream, c.module, c.handler, '(ctx: CommandContext, args: ParsedArgs) → CommandResult')]));
