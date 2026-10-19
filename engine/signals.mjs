// What an attempt is doing, read from the ledger, the git tree and the roles' activity (0.7.0), shown beside what the
// roles said they expected (engine/expectations.mjs). Which harness runs the agents is an execution detail: no signal
// reads a harness's usage or budget.
//
// Named failures: nothing showed rounds, scope growth, wall time or a quiet session while one ticket ran 47 review rounds
// (blocking findings flat for 18 of them), grew 131 amendments over 13 criteria and reviewers were handed bundles of
// 20 MB; a review round sat open for 745 minutes after its session died. The first answer judged these against numbers the
// engine picked; this module only measures and shows the plan, an implementer or a reviewer against what happened, and the
// owner agent judges the course (the owner skill). Nothing here allows or blocks a command.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedFiles, treeHashes } from './attempt.mjs';
import { familyRecurrenceLine, familyRecurrences, recurrenceLine, recurringCauses } from './causes.mjs';
import { causeOverlaps, correctionLines } from './diagnosis.mjs';
import { ownerTranscript } from './host-record.mjs';
import { home as hostHome } from './provenance.mjs';
import { blockingOpen, blockingSeries, earlierBlocking, observations, placementLevel, unreachedOf } from './review-policy.mjs';
import { expectOf, readStatement } from './expectations.mjs';
import { planPaths, scopeFiles, scopeNoise } from './scope.mjs';
import { findHost, optional, ownerString } from './hosts/index.mjs';
import { canonical, git } from './util.mjs';
import { impact } from './topology.mjs';
import { kindsOf } from './file-kinds.mjs';
import { readLedger } from './ledger.mjs';

export const SIGNALS_SCHEMA = 'agentic-workflow/signals@1';

// One entry per review round that has a recorded closure (a round recorded twice, blind and then with its prior-finding
// verdicts, counts once, at its latest record), in the order the rounds were first recorded.
export function recordedRounds(state) {
  const by = new Map();
  for (const r of state.reviews ?? []) by.set(r.handoff ?? `reviewer:${r.reviewer}`, r);
  return [...by.values()];
}

// Every review round handed, recorded or not (a review group counts once): what the person's escalation counts.
// Named failure (final review of 0.7.0): ten reviewers handed and never recorded (dead sessions, a tree moved under them)
// showed "recorded rounds: 0" and the escalation never fired; one ticket had 21 of its 47 rounds without a closure.
// `until` (an instant): the rounds handed by then (0.7.29, I-214: the round count at which the person answered the escalation).
export function handedRounds(state, until = null) {
  return new Set((state.handoffs ?? []).filter((h) => h.role === 'reviewer' && (!until || String(h.at) <= String(until))).map((h) => h.reviewGroup?.id ?? h.bundle)).size;
}

const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);

// Findings of a round as the review policy classifies them now: total, blocking and observations.
function roundCounts(state, r, home = null) {
  const view = { ...state, review: { closure: r.closure } };
  const findings = r.closure?.findings ?? [];
  const blocking = blockingOpen(view);
  const observed = observations(view);
  const families = {};
  for (const f of [...blocking, ...observed]) families[f.family ?? '(none)'] = (families[f.family ?? '(none)'] ?? 0) + 1;
  // The round's wall time (handed to recorded) beside what its reviewer expected, from its closure.
  const handed = (state.handoffs ?? []).find((h) => h.bundle === r.handoff);
  const spent = handed && r.at ? (Date.parse(r.at) - Date.parse(handed.at)) / 60000 : NaN;
  const scope = typeof r.closure?.scope === 'string' && r.closure.scope.trim() ? r.closure.scope.trim().slice(0, 600) : null;
  // Named failure (I-69): `notReached` was written by every reviewer and read by nothing, so a round that stopped early
  // looked like one that finished. Shown beside `scope`; such a round does not count as the full audit (review-policy.mjs).
  const notReached = unreachedOf(r.closure).map((x) => x.slice(0, 300)).slice(0, 20);
  return { n: 0, handoff: idOf(r.handoff), reviewer: r.reviewer ?? null, at: r.at ?? null, findings: findings.length, blocking: blocking.length, observations: observed.length, families, minutes: Number.isFinite(spent) ? round1(spent) : null, activeUntilMinute: activeUntil(handed, home, Date.parse(r.at) || Date.now()), expectMinutes: expectOf(r.closure?.expect)?.minutes ?? null, scope, notReached };
}

// The round-derived numbers, from the list of rounds alone (so a prediction about "round N" is judged on the rounds up to N).
// `blocking` of a round is what that round raised itself, so `blockingLatest` and `roundsSinceDecrease` count new findings:
// recorded rounds since the new blocking findings last went down (the first round is the baseline); 0 once the latest round
// raised none. What earlier rounds raised and nothing has verified fixed is `open` (`blockingOpen`), never read from these (I-185).
export function roundMetrics(rounds) {
  const n = rounds.length;
  let lastDecrease = 0;
  for (let i = 1; i < n; i++) if (rounds[i].blocking < rounds[i - 1].blocking) lastDecrease = i;
  const latest = rounds.at(-1) ?? null;
  return { rounds: n, blockingLatest: latest?.blocking ?? 0, findingsLatest: latest?.findings ?? 0, roundsSinceDecrease: latest && latest.blocking > 0 ? n - 1 - lastDecrease : 0 };
}

export function filesSignal(state, cfg) {
  const perRepo = {};
  let changed = 0;
  for (const name of Object.keys(state.repos ?? {})) {
    let files = [];
    try {
      files = changedFiles(state, name).filter((f) => !cfg || !scopeNoise(cfg, name, f));
    } catch {}
    perRepo[name] = files.length;
    changed += files.length;
  }
  // The files the frozen plan names (anchors and tests); null when it names none, so there is nothing to compare with.
  const planned = state.plan ? planPaths(state.plan, scopeFiles(state)).length : 0;
  return { changed, planned: planned || null, perRepo };
}

// 0.7.31 (I-217, D64): what a fix round's or a planned pass's own commits reached that nothing it was handed accounts for: a
// contract surface (`impact.contractsChanged` for the files they changed) or a critical boundary the engine can see by path (a
// migration). Named failure (field): a low item handed under `alsoFix`, with no fix any reviewer had stated, became a reshape of four
// API DTOs and a new failure path in a fix round; the implementer-estimate signal could not see it (the item states no fix, and 120
// minutes against the stated 60 is exactly twice, not more). Each implementer handed after a review carries what it was handed
// (`fixes` on its handoff); its own commits are the first-parent, non-merge commits from its handoff's heads to its close (or to
// HEAD while it works), so a base merged in is not counted as its reach.
// Review of 0.7.31 (M3). Named cost (a review's measurement on one project's ledgers): counting every contract change of a round
// handed after a first review fired on 35 of 155 rounds (an upper bound: old handoffs carry no `fixes`), mostly planned work
// regenerating an API baseline with a controller or DTO edit, and fixes located on the contract they changed. The signal is the
// unplanned reach only: a round that builds planned work for the first time is not counted (its reach is the plan's); a changed
// contract file is accounted for when a handed item is located on it or its stated fix names it, and a component's own spec
// (`provides`) follows a change to another of its contract files that is accounted for; a migration is accounted for when a handed
// item is located on it or its stated fix names its path or its folder (second review of 0.7.31: the bare word "migration", as in
// "no migration is needed", explained every migration of the round). A round handed no non-blocking item without a stated fix is also
// allowed the contract files and migrations this attempt's own earlier commits already changed (the plan's surface, adjusted). What
// is left (a contract or a migration reached from an item located elsewhere, or from one with no location or stated fix) is the
// named failure. Measured on the same ledgers (third review of 0.7.31: only handoffs whose implementer closed with its heads,
// since one never closed is measured by the engine against its own worktree, which is gone): 1 of 229 rounds handed after a first
// review fires, and that one is the named failure; 51 more never closed and cannot be measured from the main checkouts.
// Review of 0.7.31 (L7): a documentation or test file is never a migration (`docs/migration/notes.md` read as one).
// Review of 0.7.31 (L1): implementers open at once in a repo cannot be told apart by their commits: the line names them together,
// once, never one of them alone.
const isMigration = (f) => {
  const k = kindsOf(f);
  return k.has('migration') && !k.has('docs') && !k.has('test');
};
const repoPath = (cfg, name) => String(cfg?.repos?.find((r) => r.name === name)?.path ?? '.').replace(/^\.\/?$/, '').replace(/\/$/, '');
const rootOf = (cfg, name, file) => (repoPath(cfg, name) ? `${repoPath(cfg, name)}/${file}` : file);
const PATHS = /([A-Za-z0-9_@.][\w@.\-/]*\.[A-Za-z0-9]+)(?::\d+)?/g;
// The files a handed item is about: its located evidence (`path:line`, `file`, `where`) and the paths its stated fix names.
// Second review of 0.7.31: a migrations folder a stated fix names (`db/migrations/`) is a path too, so a new migration it says it adds
// is explained; the bare word "migration" ("no migration is needed") explains nothing.
const MIGRATION_DIRS = /((?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]*migrations?\/)/gi;
function itemFiles(state, ref) {
  const out = [];
  const dirs = [];
  const add = (v) => {
    if (typeof v !== 'string') return;
    for (const m of v.matchAll(PATHS)) out.push(m[1]);
    for (const m of v.matchAll(MIGRATION_DIRS)) dirs.push(m[1]);
  };
  if (/^D\d+$/.test(ref)) {
    const d = (state.discovered ?? []).find((x) => x.id === ref);
    add(d?.where);
    return { files: out, dirs };
  }
  let f = null;
  for (const r of state.reviews ?? []) for (const x of r.closure?.findings ?? []) if (`${r.closure?.reviewer ?? r.reviewer}:${x.id}` === ref) f = x;
  if (!f) return { files: out, dirs };
  add(f.file); add(f.evidence); add(f.location); add(f.where); add(f.fix?.what);
  return { files: out, dirs };
}
// Fifth review of 0.7.31: an entry written `<repo>:<path>` (as a query's files are) names that repo's file only; the prefix was
// stripped, so a portal file explained the api file of the same path.
const qualified = (cfg, l) => {
  const m = /^([\w.-]+):(.+)$/.exec(l);
  return m && (cfg?.repos ?? []).some((r) => r.name === m[1]) ? { repo: m[1], file: m[2] } : null;
};
const touches = (cfg, located, repo, file) => located.some((l) => {
  const q = qualified(cfg, l);
  if (q) return q.repo === repo && q.file === file;
  return l === file || l === rootOf(cfg, repo, file) || (cfg?.repos ?? []).some((r) => rootOf(cfg, r.name, l) === rootOf(cfg, repo, file));
});
// The amendments that restated this handoff's work item after its last build and before this handoff, each with its words, the
// contract scope it states and the changes of its impact addendum that are for the item (`planned`: each with its kind and the
// files its contract queries found). Fourth review of 0.7.31: "its last build" ends when that build's implementer closed (an
// amendment that lands while it is still open was built against, so it is not since); an item never built before starts at nothing.
function amendedSinceLastBuild(state, h) {
  if (!h?.work) return [];
  const previous = (state.handoffs ?? []).filter((x) => x.role === 'implementer' && x.at < h.at && (x.work === h.work || (x.covers ?? []).includes(h.work))).at(-1);
  const last = previous ? (state.implementers ?? []).find((y) => y.handoff === idOf(previous.bundle))?.closedAt ?? h.at : '';
  const w = (state.work ?? []).find((x) => x.id === h.work);
  return (state.workAmended?.[h.work] ?? []).filter((a) => a.at > last && a.at <= h.at).map((a) => {
    const addendum = (state.impact?.addenda ?? []).find((x) => x.amendment === a.amendment);
    const results = { ...(state.impact?.results ?? {}), ...Object.assign({}, ...(state.impact?.addenda ?? []).map((x) => x.results ?? {})) };
    const forItem = (Array.isArray(addendum?.changes) ? addendum.changes : []).filter((c) => [c.work].flat().includes(h.work) || [c.cites].flat().some((x) => (a.criteria ?? w?.criteria ?? []).includes(x)));
    // The files the change's own queries found (its contracts, consumers, flows and suites), and any it lists itself.
    const filesOf = (c) => [...[c.contracts].flat(), c.consumers, ...[c.flows].flat(), ...[c.suites].flat()].filter((x) => x && typeof x === 'object').flatMap((x) => [...(Array.isArray(x.files) ? x.files : []), ...(results[x.query]?.files ?? [])]).map(String);
    return { ...a, scope: state.criteriaAmendments?.[a.amendment - 1]?.scope ?? null, planned: forItem.map((c) => ({ kind: c.kind ?? null, files: filesOf(c) })) };
  });
}
// Fourth review of 0.7.31: whether an amendment's `scope` explains a changed contract file. With the endpoints or error codes it
// names, a file is explained when it is its component's own spec (the spec carries every endpoint) or shares at least two
// distinctive words with a name (`PUT /api/v1/resource-management/demands/:demandId/required-skills` and
// `resource-management/controllers/demand-required-skill.controller.ts`); the names were recorded and only their count was read,
// so one amendment's endpoint explained another endpoint's controller. A scope that states only counts explains every contract file.
// Fifth review of 0.7.31: whether a changed file is the spec its own component provides (the component whose repo and package hold
// it), never another component's spec that happens to end the same way.
function ownSpec(cfg, f) {
  const root = rootOf(cfg, f.repo, f.file);
  const pkg = (c) => String(c.package ?? '.').replace(/^\.\/?$/, '').replace(/\/$/, '');
  const holds = (c) => c.repo === f.repo && (!pkg(c) || f.file === pkg(c) || f.file.startsWith(`${pkg(c)}/`));
  // Sixth review of 0.7.31: every component tied at the longest package holding the file is a candidate (two packageless components
  // of one repo both hold its root; keeping the first declared lost the api's own spec when a web component came first).
  const holding = (cfg?.components ?? []).filter(holds);
  const longest = Math.max(-1, ...holding.map((c) => pkg(c).length));
  const own = holding.filter((c) => pkg(c).length === longest).find((c) => (c.provides ?? []).some((p) => p.spec && rootOf(cfg, f.repo, [pkg(c), p.spec].filter(Boolean).join('/')) === root));
  return own ? own.id : null;
}
const GENERIC = new Set(['api', 'v1', 'v2', 'v3', 'src', 'http', 'https', 'get', 'put', 'post', 'patch', 'delete', 'controller', 'dto', 'ts', 'js', 'mjs', 'json', 'yaml', 'yml', 'response', 'request', 'id', 'existing', 'the', 'and', 'for', 'with', 'index', 'module', 'service', 'lib', 'app', 'route', 'endpoint', 'meaning']);
const words = (t) => new Set(String(t ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((x) => (x.length > 3 && x.endsWith('s') ? x.slice(0, -1) : x)).filter((x) => x.length > 1 && !GENERIC.has(x)));
function scopeExplains(cfg, a, f) {
  if (!(Number(a.scope?.endpoints) > 0 || Number(a.scope?.errorCodes) > 0)) return false;
  const names = a.scope?.names ?? [];
  if (!names.length) return true;
  if (ownSpec(cfg, f)) return true;
  // Fifth review of 0.7.31: the words are the file's own name, never its folders (a two-word module folder, `resource-management`,
  // supplied both words, so one endpoint of a module explained 109 of a project's 415 contract files).
  const fw = words(path.basename(f.file));
  return names.some((n) => { const nw = words(n); return [...fw].filter((x) => nw.has(x)).length >= 2; });
}
// The implementer handoffs open at the same time as this one in a repo it changed (their commits cannot be told apart).
function overlappingHandoffs(state, impl, repos) {
  const overlap = (a, b) => String(a.openedAt) < String(b.closedAt ?? '9') && String(b.openedAt) < String(a.closedAt ?? '9');
  const reposOf = (x) => (state.work ?? []).find((w) => w.id === x.work)?.repos ?? Object.keys(state.repos ?? {});
  return (state.implementers ?? []).filter((x) => x !== impl && overlap(x, impl) && reposOf(x).some((n) => repos.includes(n))).map((x) => (state.handoffs ?? []).find((y) => y.role === 'implementer' && idOf(y.bundle) === x.handoff)).filter(Boolean);
}
function ownChanges(state, impl, repos) {
  const changed = {};
  for (const name of repos) {
    const r = state.repos?.[name];
    const from = String(impl.heads?.[name] ?? '').split('+')[0];
    const to = impl.closedAt ? String(impl.closedHeads?.[name] ?? '').split('+')[0] : 'HEAD';
    if (!r || !from || !to || from === to || !r.worktree || !fs.existsSync(r.worktree)) continue;
    let files = [];
    try {
      files = [...new Set(git(r.worktree, ['log', '--first-parent', '--no-merges', '--format=', '--name-only', `${from}..${to}`], { allowFail: true }).split('\n').map((x) => x.trim()).filter(Boolean))];
    } catch {}
    if (files.length) changed[name] = files;
  }
  return changed;
}
// What one handoff's own commits reached that nothing it was handed accounts for (for the signal, and for measuring it).
export function reachOf(state, cfg, h) {
  const impl = (state.implementers ?? []).find((x) => x.handoff === idOf(h.bundle));
  if (!impl || impl.outcome === 'stopped' || !h.fixes) return null;
  const work = (state.work ?? []).find((w) => w.id === h.work);
  const repos = work?.repos?.length ? work.repos.filter((n) => state.repos?.[n]) : Object.keys(state.repos ?? {});
  const changed = ownChanges(state, impl, repos);
  if (!Object.keys(changed).length) return null;
  const perFile = [];
  for (const [repo, files] of Object.entries(changed)) {
    for (const file of files) {
      let hit = [];
      try {
        hit = cfg ? impact(cfg, { [repo]: [file] }).contractsChanged : [];
      } catch {}
      if (hit.length) perFile.push({ repo, file, components: [...new Set(hit.map((c) => c.component))], contracts: [...new Set(hit.map((c) => c.contract))] });
    }
  }
  const migrationsAll = Object.entries(changed).flatMap(([repo, files]) => files.filter(isMigration).map((file) => ({ repo, file })));
  if (!perFile.length && !migrationsAll.length) return null;
  // Fourth review of 0.7.31: implementers open at once in a repo this round changed share what explains a file (their commits cannot
  // be told apart, so a file one of them was handed or planned is explained for both; named case: a work item handed again for named
  // items, beside another whose amendment stated the endpoint its commit changed).
  const sources = [h, ...overlappingHandoffs(state, impl, Object.keys(changed))];
  const items = sources.flatMap((x) => handedItems(x.fixes).map((ref) => itemFiles(state, ref)));
  const located = items.flatMap((x) => x.files);
  const dirs = items.flatMap((x) => x.dirs);
  // Third review of 0.7.31: a re-handoff of a work item an amendment restated since its last build is planned work for what the
  // amendment says it changes, file by file: a contract file when the amendment states endpoints or error codes (`scope`), names
  // the file, or carries an impact addendum whose change for the item crosses a contract its queries find in that file; a migration
  // when it names its path or folder, or its addendum's change for the item is a migration or finds that file. Named case (a
  // review's): an owner restated a work item 31 seconds before handing it again, stating the new response DTO of one endpoint.
  // Fourth review: a criterion changed under `impact: { unchanged }` (a reworded acceptance check) plans nothing, so the
  // criterion route goes only through the addendum's changes; items the amendment names but does not plan are still judged.
  const amended = sources.flatMap((x) => amendedSinceLastBuild(state, x));
  const amendedFiles = amended.flatMap((a) => [...String(a.why).matchAll(PATHS)].map((m) => m[1]));
  const amendedDirs = amended.flatMap((a) => [...String(a.why).matchAll(MIGRATION_DIRS)].map((m) => m[1]));
  const planned = amended.flatMap((a) => a.planned);
  const plannedFiles = planned.flatMap((c) => c.files);
  const plannedMigration = planned.some((c) => /migration/i.test(String(c.kind ?? '')));
  const spec = (c, f) => ownSpec(cfg, f) === c;
  // What explains each contract file, and through which round (this one, or one open beside it): kept for the measurement.
  const reasonOf = (f) => {
    for (const x of sources) {
      const who = x === h ? 'own' : `beside:${x.agent}`;
      if (handedItems(x.fixes).some((ref) => touches(cfg, itemFiles(state, ref).files, f.repo, f.file))) return `${who}:located`;
      const am = amendedSinceLastBuild(state, x);
      if (am.some((a) => scopeExplains(cfg, a, f))) return `${who}:scope`;
      if (am.some((a) => touches(cfg, [...String(a.why).matchAll(PATHS)].map((m) => m[1]), f.repo, f.file))) return `${who}:named-path`;
      if (am.some((a) => a.planned.some((c) => touches(cfg, c.files, f.repo, f.file)))) return `${who}:addendum`;
    }
    return null;
  };
  const direct = perFile.filter((f) => touches(cfg, located, f.repo, f.file) || amended.some((a) => scopeExplains(cfg, a, f)) || touches(cfg, amendedFiles, f.repo, f.file) || touches(cfg, plannedFiles, f.repo, f.file));
  const covered = perFile.filter((f) => direct.includes(f) || f.components.some((c) => spec(c, f) && direct.some((d) => d.components.includes(c))));
  const explained = covered.map((f) => ({ file: f.file, by: reasonOf(f) ?? 'spec-follows' }));
  const contracts = [...new Set(perFile.filter((f) => !covered.includes(f)).map((f) => f.file))];
  // Third review of 0.7.31: a folder is found in any case (the pattern that reads it ignores case), so it is compared the same way.
  const underNamedDir = (m, ds = dirs) => ds.some((d) => [d, ...(cfg?.repos ?? []).map((r) => rootOf(cfg, r.name, d))].some((c) => rootOf(cfg, m.repo, m.file).toLowerCase().startsWith(c.toLowerCase())));
  const migrations = migrationsAll.filter((m) => !plannedMigration && !touches(cfg, located, m.repo, m.file) && !underNamedDir(m) && !touches(cfg, amendedFiles, m.repo, m.file) && !underNamedDir(m, amendedDirs) && !touches(cfg, plannedFiles, m.repo, m.file)).map((m) => m.file);
  // The files this attempt's own earlier commits (from its base to this handoff) already changed: a surface the plan's work opened.
  const earlier = new Set(Object.entries(ownChanges(state, { heads: Object.fromEntries(Object.entries(state.repos ?? {}).map(([n, r]) => [n, r.base])), closedAt: true, closedHeads: impl.heads }, repos)).flatMap(([repo, files]) => files.map((f) => `${repo}:${f}`)));
  const fresh = (repo, file) => !earlier.has(`${repo}:${file}`);
  const repoOf = (file) => Object.entries(changed).find(([, files]) => files.includes(file))?.[0];
  // A round handed only findings that block (or items whose fix a reviewer stated) that edits a contract file or a migration this
  // attempt's own work already opened is adjusting the planned surface; one handed a non-blocking item with no stated fix gets no
  // such allowance (the named failure: what that item reached is nobody's plan).
  const nonBlocking = new Set([...(h.fixes.alsoFix ?? []), ...(h.fixes.pass ?? []), ...(h.fixes.named ?? [])]);
  const unboundedNonBlocking = (h.fixes.unbounded ?? []).filter((ref) => nonBlocking.has(ref));
  const keep = (f) => unboundedNonBlocking.length || fresh(repoOf(f), f);
  return { impl, repos, changed, unboundedNonBlocking, explained, all: { contracts: [...new Set(perFile.map((f) => f.file))], migrations: migrationsAll.map((m) => m.file) }, contracts: contracts.filter(keep), migrations: migrations.filter(keep) };
}
// What a round was handed besides planned work (second review of 0.7.31): a round that builds planned work and also fixes findings
// or items is judged by those; one that only builds planned work is the plan's.
export const handedItems = (fixes) => [...(fixes?.repair ?? []), ...(fixes?.alsoFix ?? []), ...(fixes?.pass ?? []), ...(fixes?.named ?? [])];
export function reachSignal(state, cfg) {
  const out = [];
  const impls = state.implementers ?? [];
  const overlap = (a, b) => String(a.openedAt) < String(b.closedAt ?? '9') && String(b.openedAt) < String(a.closedAt ?? '9');
  for (const h of (state.handoffs ?? []).filter((x) => x.role === 'implementer' && x.fixes && handedItems(x.fixes).length)) {
    const r = reachOf(state, cfg, h);
    if (!r || (!r.contracts.length && !r.migrations.length)) continue;
    const reposOf = (x) => {
      const w = (state.work ?? []).find((y) => y.id === x.work);
      return w?.repos?.length ? w.repos : Object.keys(state.repos ?? {});
    };
    const together = impls.filter((x) => x !== r.impl && overlap(x, r.impl) && reposOf(x).some((n) => Object.keys(r.changed).includes(n))).map((x) => x.agent);
    const agents = [...new Set([h.agent, ...together])];
    const same = out.find((o) => o.agents.length > 1 && o.agents.join() === [...agents].sort().join() && o.contracts.join() === r.contracts.join() && o.migrations.join() === r.migrations.join());
    if (same) continue;
    out.push({ handoff: h.bundle, agent: h.agent, agents: agents.length > 1 ? [...agents].sort() : [h.agent], repos: Object.keys(r.changed), kind: h.fixes.pass ? 'pass' : h.fixes.repair?.length || h.fixes.alsoFix?.length ? 'fix' : 'rehandoff', work: h.work ?? null, contracts: r.contracts, migrations: r.migrations, fixes: h.fixes, at: r.impl.closedAt ?? null });
  }
  return out;
}

// What the owner and the strategist read about one: what it changed that nothing handed accounts for, what it was handed and which
// handed items no reviewer stated a fix for (their size bounded by nobody).
export const reachLine = (r) => {
  const what = [r.contracts.length ? `changed the contract ${r.contracts.join(', ')}` : '', r.migrations.length ? `added or changed a migration (${r.migrations.join(', ')})` : ''].filter(Boolean).join(' and ');
  const handed = handedItems(r.fixes);
  const unbounded = r.fixes.unbounded ?? [];
  // Third review of 0.7.31: a work item handed again for the items its words name is a re-handoff, never "the fix round".
  const who = (r.agents ?? [r.agent]).length > 1 ? `the rounds of implementers ${r.agents.join(' and ')}, open at once in ${r.repos.join(', ')} (their commits cannot be told apart),` : r.kind === 'rehandoff' ? `the re-handoff of work item ${r.work ?? '(none)'} to implementer ${r.agent}` : `the ${r.kind === 'pass' ? 'planned pass' : 'fix round'} of implementer ${r.agent}`;
  return `${who} ${what}, where no handed item is located and no stated fix names it; handed ${handed.join(', ') || 'nothing named'}${unbounded.length ? `, with ${unbounded.length} handed item${unbounded.length > 1 ? 's' : ''} with no stated fix (unbounded): ${unbounded.join(', ')}` : ''}: a contract change, a new failure path or a migration is a re-plan, never built in a fix round or a pass; the strategist decides whether it stands (\`continue\`), is re-planned (\`consolidate\`) or goes back`;
};

function bundleSignal(state) {
  const h = state.handoffs.filter((x) => x.role === 'reviewer').at(-1);
  if (!h?.bundle) return { bytes: null, handoff: null, agent: null };
  let bytes = null;
  try {
    bytes = fs.statSync(h.bundle).size;
  } catch {}
  return { bytes, handoff: idOf(h.bundle), agent: h.agent };
}

// ---- Role sessions ----

// Where an agent's transcript is and when it was last written: the session file of a role with a session id, or what the
// harness adapter finds for a role that has none (a harness may record a sub-agent file under the name the owner started it
// with). mtime is enough: every turn appends to the file.
function activityOf(h, home) {
  try {
    if (h.session) {
      const t = ownerTranscript(ownerString(h.runtime, h.session), home);
      if (t.file) return { file: t.file, mtime: fs.statSync(t.file).mtimeMs };
    }
    return optional(findHost(h.runtime), 'roleActivity')?.(h, { home }) ?? null;
  } catch {}
  return null;
}

// Where a working role's time goes, from its transcript's shell commands: the one running now and the long ones (5 minutes
// or more each) it has run, with their total. Facts for the owner's judgement of what a role is doing, never a limit. Named
// failure (0.7.14): an implementer 266 minutes in had spent 201 of them in sleep loops waiting for its own background end-to-end
// runs, and the owner read "active within the last minute" as progress.
const LONG_RUN_MINUTES = 5;
function shellOf(h, file, nowMs) {
  try {
    const got = optional(findHost(h.runtime), 'shellRuns')?.(file);
    if (!got) return null;
    const long = got.runs.filter((r) => r.minutes >= LONG_RUN_MINUTES).sort((a, b) => b.minutes - a.minutes);
    const running = got.running ? { command: got.running.command.slice(0, 200), minutes: round1(Math.max(0, (nowMs - Date.parse(got.running.startedAt)) / 60000)) } : null;
    return { running, longRuns: long.length, longMinutes: round1(long.reduce((n, r) => n + r.minutes, 0)), longest: long.slice(0, 2).map((r) => ({ command: r.command.slice(0, 200), minutes: round1(r.minutes) })) };
  } catch {
    return null;
  }
}

// What a running role has said so far, from the file it writes early and completes at the end: an implementer's report,
// a reviewer's closure. Null when it has stated nothing (yet).
const statedBy = (h) => (h.role === 'implementer' ? readStatement(h.reportFile, 'approach') : h.role === 'reviewer' ? readStatement(h.closureFile, 'scope') : null);

// Role sessions that are working now: an engine-launched session whose launch has not finished, the latest reviewer round
// when it has neither a closure nor a refusal (the round the owner is waiting for), an implementer the owner has not closed
// and a strategist that has recorded no decision. Each with the time since it was handed, its last transcript activity and
// what it said it expects (its own words, never a limit).
// The machine's last sleep, when the host says (macOS: the kernel's last sleep and wake times), so time a role spent with the
// machine asleep is not read as the role going quiet. Named failure (audit of role launches): a reviewer 94 minutes into its
// work was stopped as stalled 11 seconds after the machine woke from a 68-minute sleep; "68 minutes since its last event"
// was the sleep. A seam for scenarios.
export const sleepSeams = { last: lastMachineSleep };
let sleepCache;
function lastMachineSleep() {
  if (sleepCache !== undefined) return sleepCache;
  sleepCache = null;
  if (process.platform !== 'darwin') return sleepCache;
  const r = spawnSync('sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8' });
  const secs = [...String(r.stdout ?? '').matchAll(/sec = (\d+)/g)].map((m) => Number(m[1]) * 1000);
  if (secs.length === 2 && secs[0] > 0 && secs[1] >= secs[0]) sleepCache = { sleptAt: secs[0], wokeAt: secs[1] };
  return sleepCache;
}
// Minutes of the stretch since `lastAt` the machine was asleep, and how long ago it woke; null when it did not sleep since.
export function asleepSince(lastAt, nowMs) {
  const s = sleepSeams.last();
  if (!s || !lastAt || s.wokeAt <= lastAt || s.wokeAt > nowMs) return null;
  return { asleepMinutes: round1((s.wokeAt - Math.max(s.sleptAt, lastAt)) / 60000), wokeMinutesAgo: round1((nowMs - s.wokeAt) / 60000) };
}

export function runningSessions(state, nowMs, home) {
  const lastReviewer = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  const ended = (h) => (state.reviews ?? []).some((r) => r.handoff === h.bundle) || (state.reviewsRefused ?? []).some((r) => r.handoff === h.bundle);
  const lastOf = (role, agent) => state.handoffs.filter((x) => x.role === role && x.agent === agent).at(-1);
  const openImplementers = new Set((state.implementers ?? []).filter((x) => !x.closedAt).map((x) => lastOf('implementer', x.agent)?.bundle));
  const decidedAt = state.strategy.decisions.at(-1)?.at ?? null;
  let tree = null;
  const out = [];
  for (const h of state.handoffs) {
    const launched = ['starting', 'running'].includes(h.launch?.status);
    let waitedFor = false;
    if (!launched && h === lastReviewer && !h.launch && !h.reviewGroup && !ended(h)) {
      try {
        tree ??= canonical(treeHashes(state));
        waitedFor = !h.tree || canonical(h.tree) === tree;
      } catch {}
    }
    const open = h.role === 'implementer' && openImplementers.has(h.bundle);
    // A strategist handed before the last recorded decision is superseded by it (engine/strategy.mjs strategistWaiting).
    const deciding = h.role === 'strategist' && h.launch?.status !== 'failed' && !state.strategy.decisions.some((d) => d.handoff === h.bundle) && !(decidedAt && h.at && h.at <= decidedAt);
    if (!launched && !waitedFor && !open && !deciding) continue;
    const seen = activityOf(h, home);
    const shell = seen?.file ? shellOf(h, seen.file, nowMs) : null;
    const since = Math.max(Date.parse(h.at) || 0, Date.parse(h.launch?.startedAt) || 0);
    const lastAt = seen ? Math.max(seen.mtime, since) : null;
    const said = statedBy(h);
    // I-137: a launch that finished (an implementer the owner has not closed yet) is observed execution up to its end and then
    // time the owner has not acted; the two are never one number. `minutes` is the first for it, `waitingMinutes` the second.
    const endedAt = ['completed', 'failed'].includes(h.launch?.status) ? Date.parse(h.launch.finishedAt) || null : null;
    out.push({ agent: h.agent, role: h.role, work: h.work ?? null, runtime: h.runtime, handoff: idOf(h.bundle), handedAt: h.at, launch: h.launch?.status ?? null, located: Boolean(seen), lastActivityAt: lastAt ? new Date(lastAt).toISOString() : null, idleMinutes: lastAt ? Math.max(0, round1((nowMs - lastAt) / 60000)) : null, minutes: since ? Math.max(0, round1(((endedAt ?? nowMs) - since) / 60000)) : null, ...(endedAt ? { finished: h.launch.status, finishedAt: h.launch.finishedAt, waitingMinutes: Math.max(0, round1((nowMs - endedAt) / 60000)) } : {}), expectMinutes: said?.minutes ?? null, said: said?.said ?? null , ...(shell ? { shell } : {}), ...(asleepSince(lastAt, nowMs) ?? {}) });
  }
  return out;
}

// The implementers of the attempt, finished and open: time from handed to closed (or to now) beside what each expected.
// The minute (since it was handed) a finished role was last active in its transcript, when the transcript is found: wall
// minutes include nights and waits, so "took 300 min" beside "last active at minute 42" says the work was 42 minutes.
// Named failure (final review of 0.7.0): elapsed minutes counted idle time, so an owner agent reading an overnight round
// would misjudge it.
function activeUntil(h, home, end) {
  if (!h || !home) return null;
  const seen = activityOf(h, home);
  const from = Date.parse(h.at);
  if (!seen || !Number.isFinite(from)) return null;
  return Math.max(0, round1((Math.min(seen.mtime, end) - from) / 60000));
}

function implementersSignal(state, nowMs, sessions, home) {
  return (state.implementers ?? []).map((x) => {
    const report = [...(state.implementerReports ?? [])].reverse().find((r) => r.agent === x.agent && r.handoff === x.handoff);
    const running = x.closedAt ? null : sessions.find((s) => s.role === 'implementer' && s.agent === x.agent);
    const end = Date.parse(x.closedAt ?? '') || nowMs;
    const spent = (end - Date.parse(x.openedAt)) / 60000;
    const h = x.closedAt ? (state.handoffs ?? []).find((y) => y.role === 'implementer' && idOf(y.bundle) === x.handoff) : null;
    return { agent: x.agent, work: x.work, handoff: x.handoff, open: !x.closedAt, outcome: x.outcome ?? null, minutes: Number.isFinite(spent) ? round1(spent) : null, activeUntilMinute: activeUntil(h, home, end), expectMinutes: report?.expect?.minutes ?? running?.expectMinutes ?? null, approach: report?.approach ?? running?.said ?? null };
  });
}

// The longest stretch with no ledger entry since admission (to now): how much of the wall time nobody worked on the attempt.
function longestQuiet(root, state, nowMs) {
  try {
    const times = readLedger(root, state.id).map((e) => Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i <= times.length; i += 1) gap = Math.max(gap, (i < times.length ? times[i] : nowMs) - times[i - 1]);
    return times.length ? round1(gap / 60000) : null;
  } catch {
    return null;
  }
}

// ---- The signals ----

// Everything `wf signals` shows: the numbers, and the plan's expectation beside them. `cfg` is the attempt's adapter at
// base (scope noise, nothing else); `home` the host home the engine already reads transcripts from (WF_HOME in tests).
export function computeSignals(root, state, { nowMs = Date.now(), cfg = null, home = hostHome() } = {}) {
  const finals = recordedRounds(state);
  // `blocking` is what a round raised itself; `open` how many of the blocking findings of the rounds up to it are open now (today's waivers apply), the ones earlier rounds raised
  // included (0.7.27, I-185: a round that raises nothing new has not cleared what earlier rounds raised).
  const openAfter = blockingSeries(state);
  const rounds = finals.map((r, i) => ({ ...roundCounts(state, r, home), n: i + 1, open: openAfter[i] }));
  const metrics = roundMetrics(rounds);
  const blocking = (state.reviews ?? []).length ? earlierBlocking(state, null) : [];
  const latest = finals.at(-1);
  const latestReviewer = latest?.closure?.reviewer ?? latest?.reviewer ?? null;
  const observed = state.review ? observations(state) : [];
  const ref = (f) => ({ ref: f.ref ?? `${state.review?.closure?.reviewer ?? '?'}:${f.id}`, severity: f.severity ?? null, placement: placementLevel(state, f), summary: f.summary ?? '', family: f.family ?? null, work: f.work ?? null });
  const blockRef = (f) => ({ ...ref(f), carried: f.round !== latestReviewer });
  const sessions = runningSessions(state, nowMs, home);
  return {
    schema: SIGNALS_SCHEMA,
    attempt: state.id,
    item: state.item,
    at: new Date(nowMs).toISOString(),
    admittedAt: state.admittedAt,
    engineVersion: state.engineVersion,
    // Up to its delivery or close for an attempt that ended (audit of one project: a delivered attempt read 1,818 minutes,
    // counted to the moment `wf signals` ran).
    wallMinutes: state.admittedAt ? round1(((Date.parse(state.delivery?.completedAt ?? state.closedAt ?? state.abandoned?.at ?? '') || nowMs) - Date.parse(state.admittedAt)) / 60000) : null,
    // The plan's own prediction ({ files, rounds, minutes }; a re-plan's replaces it), null when it states none.
    expect: state.expect ?? null,
    // The first prediction, kept beside a re-plan's (final review of 0.7.0: a re-plan replaced the baseline it is judged by).
    firstExpect: state.expectations?.[0]?.expect ?? null,
    // The expectation the plan itself stated, if it stated one (a re-plan's never stands for the whole attempt).
    planExpect: (state.expectations ?? []).find((x) => x.source === 'plan')?.expect ?? null,
    rounds,
    roundsRecorded: metrics.rounds,
    roundsHanded: handedRounds(state),
    blockingLatest: metrics.blockingLatest,
    findingsLatest: metrics.findingsLatest,
    roundsSinceDecrease: metrics.roundsSinceDecrease,
    // Every blocking finding open across the rounds (what the gate and the acceptance wait for), and how many of them an
    // earlier round raised. `blockingLatest` is only what the latest round raised.
    blockingOpen: blocking.length,
    blockingCarried: blocking.filter((f) => f.round !== latestReviewer).length,
    observationsOpen: observed.map(ref),
    blockingFindings: blocking.map(blockRef),
    // 0.7.27 (I-191): a finding still open that shares its cause with one already marked fixed (the reviewer's `sameCauseAs`).
    recurringCauses: recurringCauses(state),
    // 0.7.34 (I-232): the strategist's corrections to how the work runs, each in force or with what became of it, and what two
    // decisions put under different causes; plain lines.
    corrections: correctionLines(state),
    causeOverlaps: causeOverlaps(state),
    // A finding still open with the family of one already marked fixed, no cause confirmed: a possible recurrence.
    familyRecurrences: familyRecurrences(state),
    criteria: { atFreeze: state.criteriaAtFreeze, now: (state.criteria ?? []).length },
    amendments: (state.criteriaAmendments ?? []).length,
    discoveredFamilies: (state.discovered ?? []).filter((d) => d.status === 'open' && d.family).reduce((n, d) => ({ ...n, [d.family]: (n[d.family] ?? 0) + 1 }), {}),
    // How much the criteria moved, not only how many there are (lessons of one attempt: the count went from 22 to 27 while
    // 163 criterion texts were rewritten over 138 amendments, and nothing the owner read showed it).
    churn: (state.criteriaAmendments ?? []).reduce((n, a) => ({ changed: n.changed + (a.changes?.changed?.length ?? 0), added: n.added + (a.changes?.added?.length ?? 0), dropped: n.dropped + (a.changes?.dropped?.length ?? 0) }), { changed: 0, added: 0, dropped: 0 }),
    // A re-plan's expectation is measured from the re-plan: a small repair's 65 minutes was compared with five days.
    replan: (() => {
      const last = (state.expectations ?? []).at(-1);
      if (last?.source !== 'amendment') return null;
      const end = Date.parse(state.delivery?.completedAt ?? state.closedAt ?? state.abandoned?.at ?? '') || nowMs;
      return { at: last.at, amendment: last.amendment, minutes: round1(Math.max(0, (end - Date.parse(last.at)) / 60000)), rounds: (state.reviews ?? []).filter((r) => r.at > last.at).length };
    })(),
    files: filesSignal(state, cfg),
    // 0.7.31 (I-217, D64): what fix rounds and planned passes reached (a contract, a migration).
    reach: reachSignal(state, cfg),
    bundle: bundleSignal(state),
    implementers: implementersSignal(state, nowMs, sessions, home),
    longestQuietMinutes: longestQuiet(root, state, nowMs),
    sessions,
  };
}

// ---- Plan against actual ----

// What is past the estimate its own role stated, one phrase each (empty when nothing is): `wf resume` puts it on the
// `next:` line the owner agent acts on, as a prompt to judge the course, never as a refusal (D9).
export function pastEstimates(sig) {
  const e = sig.expect ?? {};
  const out = [];
  // After a re-plan, its rounds and minutes are counted from it; files stay the whole attempt's, against the first plan's.
  const r = sig.replan ?? null;
  // After a re-plan, files are the whole attempt's and amendments record no tree to count them from: the course lines show
  // them against the first plan, and the prompt to judge the course does not repeat that every turn (independent review of
  // 0.7.15: right after a re-plan the prompt still asked for one).
  if (!r && typeof e.files === 'number' && sig.files.changed > e.files) out.push(`files changed ${sig.files.changed} (the plan expected ${e.files})`);
  const rounds = r ? r.rounds : Math.max(sig.rounds.length, sig.roundsHanded ?? 0);
  if (typeof e.rounds === 'number' && rounds > e.rounds) out.push(`review rounds ${rounds}${r ? ' since the re-plan' : ''} (${r ? 'it' : 'the plan'} expected ${e.rounds})`);
  const minutes = r ? r.minutes : sig.wallMinutes;
  if (r && typeof e.minutes === 'number' && minutes > e.minutes) out.push(`${Math.round(minutes)} minutes since the re-plan (it expected ${e.minutes})`);
  else if (!r && typeof e.minutes === 'number' && sig.wallMinutes !== null && sig.wallMinutes > e.minutes) out.push(`${Math.round(sig.wallMinutes)} minutes (the plan expected ${e.minutes}${typeof sig.longestQuietMinutes === 'number' && sig.longestQuietMinutes >= 1 ? `; ${Math.round(sig.longestQuietMinutes)} of them in one stretch with nothing recorded` : ''})`);
  for (const s of sig.sessions ?? []) if (s.expectMinutes && s.minutes > s.expectMinutes) out.push(`${s.role} ${s.agent} ${s.finished ? 'ran' : 'working'} ${Math.round(s.minutes)} min (it expected ${s.expectMinutes})`);
  return out;
}

const mins = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} min`);
const lastActive = (x) => (typeof x.activeUntilMinute === 'number' && typeof x.minutes === 'number' && x.minutes - x.activeUntilMinute >= 1 ? ` (last active at minute ${Math.round(x.activeUntilMinute)})` : '');
const ago = (n) => (n === null || n === undefined ? 'unknown' : n < 1 ? 'under a minute ago' : `${Math.round(n)} min ago`);

// The comparison the owner agent judges at each round boundary: what the plan, an implementer or a reviewer said it expected,
// beside what is. No threshold, no verdict: "expected" and "actual" side by side, or "states none". `predictions` are the
// strategist's decisions with whether each prediction held. The latest three finished implementers and rounds are listed
// (`wf signals --json` has every one).
// A command as the owner reads it: leading variable assignments and temporary paths dropped, so `S=/tmp/x; for ...; sleep 10`
// reads as the loop it is.
const oneLine = (c) => String(c).replace(/\s+/g, ' ').replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*;?\s*)+/, '').replace(/(\/private)?\/(tmp|var\/folders)\/\S*/g, '…').slice(0, 120);
const shellText = (x) => !x ? '' : `${x.running ? `; running now: \`${oneLine(x.running.command)}\` for ${mins(x.running.minutes)}` : ''}${x.longRuns ? `; ${mins(x.longMinutes)} of its time in ${x.longRuns} shell command(s) of ${LONG_RUN_MINUTES} min or more (longest: \`${oneLine(x.longest[0].command)}\`, ${mins(x.longest[0].minutes)}): judge whether those runs add anything the gate will not` : ''}`;

export function courseLines(sig, { predictions = [], shell = true } = {}) {
  const e = sig.expect ?? {};
  const first = sig.firstExpect ?? null;
  // "past its own estimate" marks an actual beyond the number its own role stated: information for the owner agent's
  // judgement, never a limit (D9).
  const past = (actual, expected) => (typeof actual === 'number' && typeof expected === 'number' && actual > expected ? ' (past its own estimate)' : '');
  const line = (what, actual, expected, unit = '', key = null) => `${what}: ${actual}${unit}; the plan ${expected === undefined ? 'states no expectation' : `expected ${expected}${unit}${past(actual, expected)}${key && first && first[key] !== undefined && first[key] !== expected ? ` (first predicted ${first[key]}${unit})` : ''}`}`;
  // After a re-plan the whole attempt is set against the first plan, and the re-plan against what happened since it.
  const total = sig.replan ? sig.planExpect ?? {} : e;
  const out = [
    line('files changed', sig.files.changed, total.files, '', sig.replan ? null : 'files'),
    `${line('review rounds recorded', sig.rounds.length, total.rounds, '', sig.replan ? null : 'rounds')}${sig.roundsHanded !== undefined && sig.roundsHanded > sig.rounds.length ? `; ${sig.roundsHanded} handed (${sig.roundsHanded - sig.rounds.length} never recorded)` : ''}`,
    `${line('minutes since admission', sig.wallMinutes === null ? 'n/a' : Math.round(sig.wallMinutes), total.minutes, '', sig.replan ? null : 'minutes')}${typeof sig.longestQuietMinutes === 'number' && sig.longestQuietMinutes >= 1 ? `; the longest stretch with nothing recorded was ${Math.round(sig.longestQuietMinutes)} min` : ''}`,
  ];
  if (sig.replan) out.push(`since the re-plan (amendment ${sig.replan.amendment}): ${Math.round(sig.replan.minutes)} minutes and ${sig.replan.rounds} review round(s); it expected ${e.minutes ?? 'n/a'} minutes and ${e.rounds ?? 'n/a'} round(s)${past(sig.replan.minutes, e.minutes) || past(sig.replan.rounds, e.rounds)}`);
  for (const r of sig.reach ?? []) out.push(reachLine(r));
  for (const r of sig.recurringCauses ?? []) out.push(recurrenceLine(r));
  for (const r of sig.familyRecurrences ?? []) out.push(familyRecurrenceLine(r));
  for (const l of sig.corrections ?? []) out.push(l);
  for (const l of sig.causeOverlaps ?? []) out.push(`${l}: information for the strategist, who judges which reading is right`);
  // A pattern found one place at a time is a class to fix in one sweep (lessons of one attempt: about 35 of 67 discovered
  // issues were callers needing the same new guard, each found and recorded separately).
  // 0.7.27 (I-185): findings an earlier round raised and no round has verified fixed are not shown as zero because the latest
  // round raised none of its own.
  if (sig.blockingCarried) out.push(`blocking findings open: ${sig.blockingOpen}, ${sig.blockingOpen - sig.blockingCarried ? `${sig.blockingOpen - sig.blockingCarried} raised by the latest round` : 'none raised by the latest round'}; carried from earlier rounds and not yet verified fixed: ${sig.blockingFindings.filter((f) => f.carried).map((f) => f.ref).join(', ')}`);
  for (const [family, n] of Object.entries(sig.discoveredFamilies ?? {})) if (n >= 2) out.push(`discovered issues of family ${family}: ${n} open; fix the class in one sweep (find every place it occurs) rather than one at a time`);
  if (sig.amendments) out.push(`plan amendments: ${sig.amendments} (${sig.churn?.changed ?? 0} criterion text(s) rewritten, ${sig.churn?.added ?? 0} added, ${sig.churn?.dropped ?? 0} dropped)`);
  for (const x of sig.implementers.filter((i) => !i.open).slice(-3)) out.push(`implementer ${x.agent}${x.work ? ` (${x.work})` : ''} ${x.outcome ?? 'closed'}: took ${mins(x.minutes)}${lastActive(x)}; it ${x.expectMinutes ? `expected ${x.expectMinutes} min${past(x.minutes, x.expectMinutes)}` : 'stated no expectation'}${x.approach ? `; approach: ${x.approach.slice(0, 200)}` : ''}`);
  for (const r of sig.rounds.slice(-3)) out.push(`review round ${r.n} (${r.reviewer ?? r.handoff}): took ${mins(r.minutes)}${lastActive(r)}; it ${r.expectMinutes ? `expected ${r.expectMinutes} min${past(r.minutes, r.expectMinutes)}` : 'stated no expectation'}${r.scope ? `; scope: ${r.scope.slice(0, 200)}` : ''}${r.notReached?.length ? `; did not reach: ${r.notReached.slice(0, 5).map((x) => x.slice(0, 150)).join('; ')}${r.notReached.length > 5 ? ` and ${r.notReached.length - 5} more` : ''}` : ''}`);
  for (const s of sig.sessions) out.push(s.finished
    ? `${s.role} ${s.agent}${s.work ? ` (${s.work})` : ''} ${s.finished === 'completed' ? 'finished' : 'ended (failed)'} after ${mins(s.minutes)} of observed execution, ${s.expectMinutes ? `it expected ${s.expectMinutes} min${past(s.minutes, s.expectMinutes)}` : 'it stated no expectation'}; ${mins(s.waitingMinutes)} since then it has waited for the owner to close it, which is waiting and not work (\`wf handoff close --agent ${s.agent}\`)${s.said ? `; approach: ${s.said.slice(0, 200)}` : ''}`
    : `${s.role} ${s.agent}${s.work ? ` (${s.work})` : ''} is working: ${mins(s.minutes)} since handed, ${s.expectMinutes ? `it expects ${s.expectMinutes} min${past(s.minutes, s.expectMinutes)}` : 'it stated no expectation'}; last activity ${s.located ? ago(s.idleMinutes) : 'unknown (transcript not found)'}${typeof s.asleepMinutes === 'number' && s.asleepMinutes >= 1 ? ` (${Math.round(s.asleepMinutes)} min of that with the machine asleep; it woke ${ago(s.wokeMinutesAgo)}: not a stall)` : ''}${shell ? shellText(s.shell) : ''}${s.said ? `; ${s.role === 'reviewer' ? 'scope' : 'approach'}: ${s.said.slice(0, 200)}` : ''}`);
  for (const d of predictions) out.push(`strategist ${d.id} (${d.action}) predicted ${d.prediction ? `${d.prediction.signal} by ${typeof d.prediction.by === 'number' ? `round ${d.prediction.by}` : d.prediction.by}` : 'nothing'}: ${d.prediction_status.status}${d.prediction_status.observed !== null && d.prediction_status.observed !== undefined ? ` (observed ${d.prediction_status.observed})` : ''}`);
  return out;
}
