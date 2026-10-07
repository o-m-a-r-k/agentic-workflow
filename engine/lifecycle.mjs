import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { actor, addRepoWorktree, baseRef, branchName, changedFiles, cleanupWorktrees, entry, openState, treeHashes, worktreeDir } from './attempt.mjs';
import { channelOf, discoveredVerdicts, openDiscovered, seamVerdicts, unacknowledged, unrecordedInReports } from './discovered.mjs';
import { ADAPTER_DIR, adapterFileAtCommit, adapterLocation, agentTypeFor, declared, loadConfig, loadConfigAtCommit, repoDir, roleClass } from './config.mjs';
import { focusedSkips, gateBusy, gatePassedForCurrentTree, gateRunningRefusal, screenshots, withReviewLock } from './gate.mjs';
import { append, attemptDir, evidenceRoot, keptFiles, listAttempts, loadState, openEvidence } from './ledger.mjs';
import { assertUnchanged, readEvidenceFile } from './evidence.mjs';
import { implementerAcks, lessonPrompts, lessonVerdicts, owesLesson, recur, relevantLessons } from './lessons.mjs';
import { canonical as canonicalPath, isInside, touchesEvidence } from './paths.mjs';
import { changedForStep, deliveryOrder, impact, inside, packageOf } from './topology.mjs';
import { findSkill } from './skills.mjs';
import { childAgents, lastFencedYaml, lastModel, readTranscript, sessionModel, subagentModel, subagentTranscripts } from './telemetry.mjs';
import { outsidePlan, outsideVerdicts } from './scope.mjs';
import { commentFile, emitTrackerEvent, needsSummary, recordSummary, writeDeliveredComment } from './tracker.mjs';
import { designChecks, designVerdicts, requiredSkills, reviewRules, ruleVerdicts, skillFiles, unreadDocs } from './rules.mjs';
import { home, howToStart, roleChangedSinceSessionStart, startPromptFor, verifyAgent } from './provenance.mjs';
import { allRecordedQueries, buildSweeps, deriveFromDiff, impactCheckProblems, impactRequired, inventory, readSweepFile, rerun, staleRestrictionLines, staleRestrictions, sweepAnswers, validateAmendImpact, validatePlanImpact } from './impact.mjs';
import { WfError, YAML, assertEngine, assertSafeId, canonical, git, hashFile, hashValue, matchesAny, readJson, refuse, run, sessionIdentity, sha256, writeImmutable, writeJson } from './util.mjs';

// An input file is read once: the text parsed is the text kept raw (a file rewritten between two reads could otherwise
// be judged on one content and recorded with another).
const readOnce = (file) => fs.readFileSync(path.resolve(String(file)), 'utf8');
const parseStructured = (file, original) => {
  let text = original;
  const fenced = text.match(/```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) text = fenced[1];
  return String(file).endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
};

// Changed files the plan names nowhere (noise filtered with the adapter at base), or null when the plan names no paths.
export function outsideFiles(root, state) {
  if (!state.criteria) return null;
  let trusted = null;
  try {
    trusted = loadConfigAtCommit(root, loadConfig(root), state.adapterBase);
  } catch {}
  const changed = Object.fromEntries(Object.keys(state.repos).map((r) => {
    try {
      return [r, changedFiles(state, r)];
    } catch {
      return [r, []];
    }
  }));
  return outsidePlan(state.plan, changed, trusted);
}

// The owner's warning before a review: amend the criteria for an intentional change, or fix it. Never a refusal.
export function outsideWarning(root, state) {
  const files = outsideFiles(root, state);
  if (!files?.length) return null;
  return withAttempt(root, state, `${files.length} changed file(s) outside the plan: ${files.join(', ')} — amend the criteria (\`wf criteria amend --file <f> --reason "why"\`) for an intended change, or fix it, before the review; the reviewer must give each a verdict (covered by a criterion, or a finding)`);
}

// Design-system hits on the lines this attempt added, for the owner (gate, check, status). Never a refusal here: the
// reviewer answers each one, and its closure is refused without.
export function designWarning(root, state) {
  let trusted;
  try {
    trusted = loadConfigAtCommit(root, loadConfig(root), state.adapterBase);
  } catch {
    return null;
  }
  const d = designChecks(root, trusted, state);
  if (!d?.hits.length) return null;
  return `${d.hits.length} design-system hit(s) on added lines; the reviewer must give each a verdict (justified with evidence, or a finding), so fix any that are not deliberate before the review:\n${d.hits.slice(0, 10).map((h) => `    - ${h.id}: ${h.description}${h.missing ? ` (file lacks ${h.missing.join(', ')})` : ''}`).join('\n')}${d.hits.length > 10 ? `\n    … ${d.hits.length - 10} more` : ''}`;
}

// A handoff bundle as written (a missing or unreadable one reads as empty: nothing listed, nothing required).
export function readBundle(file) {
  try {
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

// Every raw output the owner or an agent produced is kept verbatim, write-once and hash-bound, at the moment the
// engine consumes it: nothing may exist only in chat.
function keepRaw(root, id, rel, content) {
  const file = path.join(attemptDir(root, id), rel);
  writeImmutable(file, content);
  return { file, sha256: hashFile(file) };
}
const extOf = (file) => (String(file).endsWith('.json') ? 'json' : 'yaml');

// The plan file's schema. `wf plan` once read only `plan`, so a contract, anchors or test selectors written as
// top-level keys were dropped from the frozen plan and never reached the implementers. Plan sections may sit under
// `plan:` (a mapping, or plain text for the summary) or at the top level beside `criteria` and `work`, as the planner
// template writes them; any other top-level key is refused with this list. The sections themselves are open.
export const PLAN_SECTIONS = ['summary', 'contract', 'anchors', 'tests', 'doNotRun', 'externalServices', 'agentSplit'];
// `survey` and `impact` (I-26) are the two stages of the impact analysis: top-level only, survey before the design,
// impact after it (engine/impact.mjs).
const PLAN_FILE_KEYS = ['survey', 'plan', 'criteria', 'work', ...PLAN_SECTIONS, 'impact'];

export function planFromDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new WfError(`the plan file must be a mapping with \`criteria\` (known keys: ${PLAN_FILE_KEYS.join(', ')})`);
  const unknown = Object.keys(doc).filter((k) => !PLAN_FILE_KEYS.includes(k));
  if (unknown.length) throw new WfError(`unknown top-level key(s) in the plan file: ${unknown.join(', ')}; known keys: ${PLAN_FILE_KEYS.join(', ')} (plan sections may also sit under \`plan:\`)`);
  const p = doc.plan;
  if (p !== undefined && p !== null && typeof p !== 'string' && (typeof p !== 'object' || Array.isArray(p))) throw new WfError('`plan` must be text (the summary) or a mapping of plan sections');
  if (p && typeof p === 'object' && ('survey' in p || 'impact' in p)) throw new WfError('`survey` and `impact` sit at the top level of the plan file (survey before `plan`, impact after it), not under `plan`');
  const plan = typeof p === 'string' ? { summary: p } : { ...(p ?? {}) };
  for (const k of PLAN_SECTIONS) {
    if (doc[k] === undefined) continue;
    if (plan[k] !== undefined) throw new WfError(`\`${k}\` is given both at the top level and under \`plan\`; keep one`);
    plan[k] = doc[k];
  }
  return Object.keys(plan).length ? plan : null;
}

// The planner's own output, so the owner never retypes it: the last fenced YAML block in the transcript of the Claude
// Code subagent started under this name (found by its meta.json, as `wf report` does).
function planFromAgent(root, state, agent) {
  const handoff = state.handoffs.filter((h) => h.role === 'planner' && h.agent === agent).at(-1);
  if (!handoff) throw refuse(`\`${agent}\` was not handed this attempt as its planner${state.roles.planner.length ? ` (planners: ${state.roles.planner.join(', ')})` : ''}`, 'run `wf handoff planner --agent <id>` and start that agent with the printed line');
  const check = verifyAgent(handoff);
  if (check.status === 'mismatch') throw refuse(`the planner transcript does not match its handoff: ${check.reason}`);
  let found = subagentTranscripts(home(), agent, handoff?.agentType ?? null, handoff?.at ?? null);
  // A planner started without a name, identified by its start line (verifyAgent, I-14).
  if (!found.length && check.status === 'verified' && check.identity === 'unnamed') found = [{ file: check.transcript, agentType: handoff.agentType ?? null }];
  if (!found.length) throw refuse(`no Claude Code subagent transcript named \`${agent}\`${handoff?.agentType ? ` (agent type ${handoff.agentType})` : ''}${handoff ? ' written after its handoff' : ''} under ${path.join(home(), '.claude', 'projects')}`, `check the agent id (${howToStart(handoff)}), or save the planner's YAML unchanged to a file and use \`wf plan --file <file>\``);
  const entries = readTranscript(found[0].file);
  const text = lastFencedYaml(entries);
  if (text === null) throw refuse(`the transcript of ${agent} (${found[0].file}) has no fenced YAML block`, 'ask the planner to return its plan in one ```yaml block, or save it to a file and use `wf plan --file <file>`');
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw refuse(`the last YAML block in ${agent}'s transcript does not parse: ${error.message.split('\n')[0]}`);
  }
  return { doc, text, source: { agent, transcript: found[0].file, agentType: found[0].agentType, model: lastModel(entries), provenance: check.status } };
}

const plannerLanes = (cfg) => cfg.roles?.planner?.lanes ?? ['standard'];
const needsPlanner = (cfg, state) => plannerLanes(cfg).includes(state.lane) && cfg.roles?.planner !== false;
// The adapter as committed at the attempt's base decides whether the impact analysis is required (a ticket cannot drop it).
const trustedOr = (root, cfg, state) => {
  try {
    return loadConfigAtCommit(root, cfg, state.adapterBase);
  } catch {
    return cfg;
  }
};
const impactNeeded = (cfg, state, work) => impactRequired(cfg, { plannerNeeded: needsPlanner(cfg, state), work, implementerClass: roleClass(cfg, 'implementer') });

// The ticket's own change, independent of where the base branch is: survives merging an advanced base.
export function patchIds(state) {
  const out = {};
  for (const [name, r] of Object.entries(state.repos)) {
    const mb = git(r.worktree, ['merge-base', r.baseRef ?? r.base, 'HEAD']);
    const diff = git(r.worktree, ['diff', '--binary', mb, 'HEAD']);
    out[name] = diff ? hashValue(diff) : 'empty';
  }
  return out;
}

function validateCriteria(list) {
  if (!Array.isArray(list) || !list.length) throw new WfError('criteria must be a non-empty list of { id, text }');
  const ids = new Set();
  for (const c of list) {
    if (!c.id || !c.text) throw new WfError('each criterion needs `id` and `text`');
    if (ids.has(c.id)) throw new WfError(`duplicate criterion id ${c.id}`);
    ids.add(c.id);
  }
}

// The planner's optional grouping of criteria into work items, each with a class. Refused only where the owner would
// otherwise be told to start an agent that does not exist or to cover a criterion that does not exist.
function validateWork(cfg, work, criteria) {
  if (work === undefined || work === null) return null;
  if (!Array.isArray(work)) throw new WfError('`work` must be a list of { id, criteria, repos, class, why }');
  const known = new Set(criteria.map((c) => c.id));
  const ids = new Set();
  const out = [];
  for (const w of work) {
    if (!w?.id) throw new WfError('each work item needs an `id`');
    if (ids.has(w.id)) throw new WfError(`duplicate work item id ${w.id}`);
    ids.add(w.id);
    const crit = Array.isArray(w.criteria) ? w.criteria.map(String) : [];
    const unknown = crit.filter((c) => !known.has(c));
    if (unknown.length) throw new WfError(`work item ${w.id} names unknown criteria ${unknown.join(', ')} (criteria: ${[...known].join(', ')})`);
    const cls = w.class ?? roleClass(cfg, 'implementer');
    if (!cfg.classes[cls]) throw new WfError(`work item ${w.id}: class \`${cls}\` is not a known class (known: ${Object.keys(cfg.classes).join(', ')})`);
    out.push({ ...w, criteria: crit, repos: Array.isArray(w.repos) ? w.repos : w.repos ? [w.repos] : [], class: cls });
  }
  return out;
}

// Criteria no work item covers. Shown to the owner, never refused.
export const uncovered = (state) => (state.work ? (state.criteria ?? []).map((c) => c.id).filter((id) => !state.work.some((w) => w.criteria.includes(id))) : []);

export function freezeCriteria(root, options) {
  const state = openState(root, options);
  const cfg = loadConfig(root);
  if (state.criteria) throw refuse('criteria are already frozen', 'change them with `wf criteria amend --file <f> --reason <why>`');
  if (typeof options.file !== 'string' && typeof options['from-agent'] !== 'string') throw new WfError('--file <plan.yaml|json> or --from-agent <planner agent id> is required');
  if (typeof options.file === 'string' && typeof options['from-agent'] === 'string') throw new WfError('pass --file or --from-agent, not both');
  const fromAgent = typeof options['from-agent'] === 'string' ? planFromAgent(root, state, options['from-agent']) : null;
  const fileText = fromAgent ? null : readOnce(options.file);
  const doc = fromAgent ? fromAgent.doc : parseStructured(options.file, fileText);
  const plan = planFromDoc(doc);
  validateCriteria(doc.criteria);
  const work = validateWork(cfg, doc.work, doc.criteria);
  if (needsPlanner(cfg, state)) {
    const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
    if (!planner) throw refuse(`the ${state.lane} lane needs a planner: run \`wf handoff planner --agent <id>\` first`);
    if (canonical(treeHashes(state)) !== canonical(planner.tree)) throw refuse('the planner changed the worktree; planning must be read-only');
  }
  if (state.handoffs.some((h) => h.role === 'implementer')) throw refuse('implementation already started; criteria must be frozen before implementation');
  const trusted = trustedOr(root, cfg, state);
  const impactRecord = validatePlanImpact(root, cfg, state, doc, { plan, criteria: doc.criteria, work, required: impactNeeded(trusted, state, work) });
  let source = null;
  if (fromAgent) {
    source = { ...fromAgent.source, ...keepRaw(root, state.id, 'plans/plan-1.raw.yaml', fromAgent.text) };
  } else {
    // Where available, the model the planner ran on: an agent whose class pins no model inherits the session's.
    const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
    const model = planner && planner.runtime === 'claude' ? subagentModel(home(), planner.agent, planner.agentType, planner.at) : null;
    const from = path.resolve(String(options.file));
    source = { ...keepRaw(root, state.id, `plans/plan-1.raw.${extOf(from)}`, fileText), from, agent: planner?.agent ?? null, model };
  }
  append(root, state.id, 'criteria.frozen', { criteria: doc.criteria, plan, source, ...(work ? { work } : {}), ...(impactRecord ? { impact: impactRecord } : {}) }, actor(options));
  return loadState(root, state.id);
}

// An amendment merges by criterion id: listed ids replace the frozen ones, new ids are added, ids not listed stay.
// Removing one needs an explicit `{ id, dropped: true, reason }` entry. Replacing the whole list silently dropped
// every criterion the amendment file did not repeat.
export function mergeAmendment(frozen, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new WfError('the amendment file needs `criteria`: the changed, added or dropped criteria only');
  const seen = new Set();
  const byId = new Map(frozen.map((c) => [c.id, c]));
  const changes = { changed: [], added: [], dropped: [] };
  for (const e of entries) {
    if (!e?.id) throw new WfError('each criterion needs `id`');
    if (seen.has(e.id)) throw new WfError(`duplicate criterion id ${e.id}`);
    seen.add(e.id);
    if (e.dropped === true) {
      if (!byId.has(e.id)) throw new WfError(`cannot drop ${e.id}: it is not a frozen criterion (criteria: ${[...byId.keys()].join(', ')})`);
      if (!String(e.reason ?? '').trim()) throw new WfError(`dropping ${e.id} needs a \`reason\``);
      byId.delete(e.id);
      changes.dropped.push({ id: e.id, reason: String(e.reason) });
      continue;
    }
    if (!e.text) throw new WfError(`criterion ${e.id} needs \`text\` (or \`dropped: true\` with a \`reason\` to remove it)`);
    const { dropped, reason, ...criterion } = e;
    if (!byId.has(e.id)) changes.added.push(e.id);
    else if (canonical(byId.get(e.id)) !== canonical(criterion)) changes.changed.push(e.id);
    byId.set(e.id, criterion);
  }
  const criteria = [...byId.values()];
  if (!criteria.length) throw new WfError('the amendment drops every criterion; abandon the attempt instead');
  return { criteria, changes };
}

// The optional `scope: { endpoints, errorCodes, repos }` block of an amendment file: each a count or a list of names.
export function scopeOf(scope) {
  if (scope === undefined || scope === null) return { endpoints: null, errorCodes: null, repos: null, stated: null };
  if (typeof scope !== 'object' || Array.isArray(scope)) throw new WfError('`scope` in the amendment file is { endpoints, errorCodes, repos }: each a count or a list of names');
  const unknown = Object.keys(scope).filter((k) => !['endpoints', 'errorCodes', 'repos'].includes(k));
  if (unknown.length) throw new WfError(`\`scope\` takes endpoints, errorCodes and repos only (not ${unknown.join(', ')})`);
  const out = { stated: {} };
  for (const k of ['endpoints', 'errorCodes', 'repos']) {
    const v = scope[k];
    if (v === undefined || v === null) out[k] = null;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim())) {
      out[k] = v.length;
      out.stated[k] = v;
    } else if (Number.isInteger(v) && v >= 0) out[k] = v;
    else throw new WfError(`\`scope.${k}\` must be a count (a whole number) or a list of names`);
  }
  return out;
}

export function amendCriteria(root, options) {
  const state = openState(root, options);
  if (!state.criteria) throw refuse('criteria are not frozen yet; use `wf plan`');
  if (!options.reason || options.reason === true) throw new WfError('--reason is required (say why the criteria change)');
  const amendText = readOnce(options.file);
  const doc = parseStructured(options.file, amendText);
  // An amendment may carry only an impact update (I-26): the criteria then stay as frozen.
  const { criteria, changes } = doc?.criteria === undefined && doc?.impact !== undefined ? { criteria: state.criteria, changes: { changed: [], added: [], dropped: [] } } : mergeAmendment(state.criteria, doc.criteria);
  const scope = scopeOf(doc.scope);
  // Work items survive an amendment unless the file replaces them; either way they must name criteria that still exist.
  const cfg = loadConfig(root);
  const work = validateWork(cfg, doc.work ?? state.work, criteria);
  // I-19, named failure: a frozen "no change in repo X" criterion blocked a fix that needed an additive change there.
  // A fix that spans repos is ordinary work: the owner adds the repo and its work items in this one step.
  const addRepos = typeof options['add-repo'] === 'string' ? [...new Set(options['add-repo'].split(',').map((x) => x.trim()).filter(Boolean))] : [];
  if (options['add-repo'] !== undefined && !addRepos.length) throw new WfError('--add-repo needs a repo name (or several, comma-separated)');
  if (addRepos.length && ['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}; a repo is added only before delivery`);
  for (const name of addRepos) {
    if (!cfg.repos.some((r) => r.name === name)) throw new WfError(`unknown repo \`${name}\` (repos: ${cfg.repos.map((r) => r.name).join(', ')})`);
    if (state.repos[name]) throw refuse(`${name} is already in ${state.id}`);
    if (work?.length && !work.some((w) => w.repos.includes(name))) throw refuse(`no work item covers the added repo ${name}`, `add a work item with \`repos: [${name}]\` (and the criteria it builds) to the amendment file, so an implementer is handed the change there`);
  }
  // I-26, named failure: amendments added endpoints, error codes and a financial write path mid-ticket with no impact
  // analysis; six findings over five review rounds were consumers, contracts and tests of the added items. An amendment
  // that adds or changes criteria, work items or repos owes an impact update (`impact` in the amendment file, or
  // `impact: { unchanged: "<why>" }`) before the next implementer handoff.
  const trusted = trustedOr(root, cfg, state);
  const impactApplies = Boolean(state.impact) || impactNeeded(trusted, state, work);
  let impactAddendum = null;
  if (doc?.impact !== undefined) impactAddendum = validateAmendImpact(root, cfg, state, doc.impact, { plan: state.plan, criteria, work });
  const owedScope = { addedCriteria: changes.added, changedCriteria: changes.changed, addedRepos: addRepos, work: doc.work ? true : false };
  const addsScope = changes.added.length || changes.changed.length || addRepos.length || Boolean(doc.work);
  const impactOwed = impactApplies && addsScope && !impactAddendum ? owedScope : null;
  const from = path.resolve(String(options.file));
  const added = [];
  for (const name of addRepos) {
    const entryOf = addRepoWorktree(root, cfg, state, name);
    append(root, state.id, 'repo.added', { repo: name, entry: entryOf, reason: String(options.reason) }, actor(options));
    added.push({ repo: name, worktree: entryOf.worktree, base: entryOf.base });
  }
  const raw = keepRaw(root, state.id, `plans/amend-${state.criteriaAmendments.length + 1}.raw.${extOf(from)}`, amendText);
  append(root, state.id, 'criteria.amended', { criteria, changes, reason: String(options.reason), previous: state.criteria, raw, ...(doc.work ? { work } : {}), ...(added.length ? { addedRepos: added.map((a) => a.repo) } : {}), ...(impactAddendum ? { impact: impactAddendum } : {}), ...(impactOwed ? { impactOwed } : {}) }, actor(options));
  // Telemetry: how much the ticket grew with this amendment (criteria counts always; endpoints, error codes and repos
  // when the amendment file states them under `scope`).
  append(root, state.id, 'scope.changed', { amendment: state.criteriaAmendments.length + 1, reason: String(options.reason), criteria: { before: state.criteria.length, after: criteria.length, added: changes.added.length, changed: changes.changed.length, dropped: changes.dropped.length }, ...scope, addedRepos: added.map((a) => a.repo) }, actor(options));
  const after = loadState(root, state.id);
  return { state: after, changes, added, impactOwed, restrictions: restrictionWarnings(trusted, after) };
}

// Plan restrictions (doNotRun, externalServices) that name a repo or suite this attempt's diff now touches (I-25).
export function restrictionWarnings(cfg, state) {
  try {
    const changed = Object.fromEntries(Object.keys(state.repos).map((r) => [r, changedFiles(state, r)]));
    return staleRestrictionLines(staleRestrictions(cfg, state, changed));
  } catch {
    return [];
  }
}

// Everyone who owned, planned, implemented or tested the change, including batch members' authors.
export function authorsOf(root, state) {
  const set = new Set([...(state.owners ?? [state.owner]), ...state.roles.planner, ...state.roles.implementer, ...state.roles.tester]);
  for (const m of state.batch?.members ?? []) {
    const ms = loadState(root, m);
    for (const a of authorsOf(root, ms)) set.add(a);
  }
  return set;
}

// Every skill this role needs this round (same evaluation as the bundle's `skills`) must load for the runtime.
function skillProblems(root, cfg, role, runtime, state, changed) {
  const problems = [];
  for (const s of requiredSkills(cfg, role, state, changed)) {
    const found = findSkill(root, s.name, runtime);
    if (!found) problems.push(`skill \`${s.name}\` is not available to ${runtime}${s.vendor ? '; run `wf sync`' : '; install it for that runtime'}`);
    else if (found.broken) problems.push(`skill \`${s.name}\` is installed for ${runtime} but does not load: ${found.broken}`);
  }
  return problems;
}

export function handoff(root, role, options) {
  const state = openState(root, options);
  const cfg = loadConfig(root);
  const roles = ['planner', 'implementer', 'reviewer', 'tester'];
  if (!roles.includes(role)) throw new WfError(`role must be one of ${roles.join(', ')}`);
  if (!options.agent) throw new WfError('--agent <identity of the agent you are starting> is required');
  const agent = String(options.agent);
  const owner = state.owner;
  const runtime = options.runtime ?? sessionIdentity()?.runtime ?? 'claude';
  if (state.intent === 'analysis' && role !== 'planner') throw refuse('analysis attempts are read-only; only a planner handoff is allowed');
  if (role === 'implementer' && !state.criteria) throw refuse('freeze criteria first: `wf plan --file <criteria>`');
  if (role === 'tester' && !cfg.roles?.tester) throw refuse('this project has no tester role configured');
  // Order of work (I-27): code-review rounds run to clean with no gate, then one gate on that tree, then the evidence
  // review of the gated tree. A finding made while a gate runs makes that gate obsolete, so the two never overlap.
  let gateNow = null;
  if (role === 'reviewer') {
    const busy = gateBusy(root, state);
    if (busy) throw gateRunningRefusal(state, busy);
    // I-25: every pattern sweep a fix implementer was handed is answered in a commit trailer before the next review.
    const sw = sweepAnswers(state);
    if (sw.missing.length) throw refuse(`the fix implementer did not answer ${sw.missing.length} pattern sweep(s) it was handed: ${sw.missing.join(', ')}`, `add a commit trailer per sweep, one line each: \`Sweep <id>: fixed - <the other instances fixed>\` or \`Sweep <id>: clean - <why no hit is another instance>\` (for example \`git commit --allow-empty -m "Sweeps" -m "Sweep ${sw.missing[0]}: fixed - ..."\`)`);
    if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) throw refuse('nothing to review yet: hand the work to an implementer first (`wf handoff implementer --agent <id>`)');
    // Tracked changes only: a finished gate leaves untracked reports, and those are never the change.
    const dirty = Object.entries(treeHashes(state)).filter(([, t]) => t.includes('+dirty')).map(([n]) => n);
    if (dirty.length) throw refuse(`commit the change before the review (the reviewer reads the committed diff): uncommitted changes in ${dirty.join(', ')}`);
    if (authorsOf(root, state).has(agent)) throw refuse(`${agent} planned, wrote or owns this change and cannot review it`);
    // A resumed reviewer is anchored on its earlier findings; each round is judged by an agent that has seen none of them.
    if (state.roles.reviewer.includes(agent)) throw refuse(`${agent} already reviewed a round of this attempt; start a fresh reviewer agent with a new id; each review round uses a new agent`);
    // A reopened attempt records what the project learns before it is reviewed: the lesson is then in the reviewed diff.
    if (owesLesson(state)) throw refuse(lessonPrompts(state)[0]);
    // Every lesson the implementers were handed is acknowledged in a commit trailer: `Lesson <id>: applied - <why>` or
    // `Lesson <id>: not-applicable - <why>`. The reviewer sees these and still gives its own verdict.
    const ack = implementerAcks(state);
    if (ack.missing.length) throw refuse(`the implementer did not acknowledge ${ack.missing.length} lesson(s) it was handed: ${ack.missing.join(', ')}`, `add a trailer per lesson to a commit in the worktree, one line each: \`Lesson <id>: applied - <how>\` or \`Lesson <id>: not-applicable - <why>\` (for example \`git commit --allow-empty -m "Lessons" -m "Lesson ${ack.missing[0]}: applied - ..."\`)`);
    for (const a of ack.acks) if (!(state.lessons?.acknowledged ?? []).some((x) => x.lesson === a.lesson && x.commit === a.commit)) append(root, state.id, 'lesson.acknowledged', a, null);
    // I-18 (extended): an implementer's report never leaves an issue unfixed without its discovered entry.
    const unrecorded = unrecordedInReports(state);
    if (unrecorded.length) throw refuse(unrecorded.map((u) => `${u.agent}'s report leaves ${u.lines.length} issue(s) unfixed without a discovered entry:\n${u.lines.map((l) => `  - ${l}`).join('\n')}`).join('\n'), `the implementer that found it fixes it, in this attempt, in whatever file it lives in (continue it with SendMessage; the work-item brief is no reason to leave it, and the owner never fixes it); only when another work item is editing that file right now, the implementer records it: \`wf discovered add --summary "..." --where <file:line> --found-by ${unrecorded[0].agent} --blocked-by <work item>\` and names the D id in its report`);
    gateNow = gatePassedForCurrentTree(state);
  }
  if (role === 'implementer' && state.roles.reviewer.includes(agent)) throw refuse(`${agent} reviewed this attempt and cannot implement it`);
  if (role === 'implementer' && state.impact?.owed) throw refuse(`amendment ${state.impact.owed.amendment} ("${state.impact.owed.reason}") added scope (${describeScope(state.impact.owed.scope)}) without an impact update; no implementer starts on it until the impact map covers it`, 'run `wf criteria amend --file <f> --reason "impact of the added scope"` with an `impact` addendum: its new queries and survey entries, and `changes` (each citing the added criteria or work items) with consumers, flows, contracts and suites; or `impact: { unchanged: "<why the amendment adds no new element>" }`');
  if (options.sweep !== undefined && role !== 'implementer') throw new WfError('--sweep applies to implementer handoffs only');
  // Rules and skills come from the adapter at the attempt's base, so a ticket cannot drop its own rules.
  const trusted = loadConfigAtCommit(root, cfg, state.adapterBase);
  const changed = Object.fromEntries(Object.keys(state.repos).map((r) => [r, changedFiles(state, r)]));
  const skillIssues = skillProblems(root, trusted, role, runtime, state, changed);
  if (skillIssues.length) throw refuse(skillIssues.join('\n'));
  let work = null;
  if (options.work !== undefined) {
    if (role !== 'implementer') throw new WfError('--work applies to implementer handoffs only');
    work = (state.work ?? []).find((w) => w.id === String(options.work));
    if (!work) throw refuse(`no work item \`${options.work}\` in the frozen plan${state.work?.length ? ` (work items: ${state.work.map((w) => w.id).join(', ')})` : ''}`);
    if (!cfg.classes[work.class]) throw refuse(`work item ${work.id}: class \`${work.class}\` is no longer in the adapter (known: ${Object.keys(cfg.classes).join(', ')})`);
  }
  // I-25: a fix handoff (open review findings this implementer builds) carries a pattern sweep per finding.
  let sweeps = null;
  if (role === 'implementer') {
    const lastReview = state.reviews.at(-1)?.at ?? null;
    const swept = new Set(state.handoffs.filter((h) => h.role === 'implementer' && lastReview && h.at > lastReview).flatMap((h) => (h.sweeps ?? []).map((x) => x.finding)));
    const owed = earlierOpenFindings(state, null).filter((f) => !swept.has(`${f.round}:${f.id}`) && (!work || !f.work || f.work === work.id));
    if (owed.length && options.sweep === undefined) throw refuse(`this is a fix handoff for ${owed.length} open finding(s) (${owed.map((f) => `${f.round}:${f.id}`).join(', ')}): name the pattern to sweep for other instances of each`, `write a sweep file and pass \`--sweep <file>\`: \`sweeps: [{ finding: "${owed[0].round}:${owed[0].id}", why: "<the defect pattern>", query: { pattern: "<text or regex>", kind: literal|regex, repo: <repo>, paths: ["src/**"] } }]\`, one per finding`);
    if (options.sweep !== undefined) {
      if (typeof options.sweep !== 'string') throw new WfError('--sweep <file> names the sweep file');
      if (!owed.length) throw refuse('no open review finding is owed a sweep: --sweep is for fix handoffs');
      const startAt = state.handoffs.flatMap((h) => h.sweeps ?? []).length + 1;
      sweeps = buildSweeps(root, cfg, state, readSweepFile(options.sweep).doc, { owed, startAt });
    }
  }
  const cls = work?.class ?? roleClass(cfg, role);
  const agentType = agentTypeFor(cfg, role, cls);
  const { effort, model } = declared(cfg, cls, runtime);

  const selected = ['planner', 'implementer', 'reviewer'].includes(role) ? relevantLessons(root, role, state, changed, { work }) : null;
  const n = state.handoffs.length + 1;
  const file = path.join(attemptDir(root, state.id), 'handoffs', `${String(n).padStart(2, '0')}-${role}.json`);
  const appendix = cfg.roles?.[role]?.appendix ? path.resolve(root, ADAPTER_DIR, cfg.roles[role].appendix) : null;
  const bundle = {
    attempt: state.id,
    item: state.item,
    lane: state.lane,
    role,
    agent,
    // The agent type the owner starts; its generated file (wf sync) sets this effort and model.
    agentType,
    class: cls,
    effort,
    model,
    work,
    worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])),
    // Where the ticket's own change starts: after `wf base merge` this is the merged base, not the admission commit,
    // so a diff against it shows the ticket's change only.
    bases: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, git(v.worktree, ['merge-base', v.baseRef ?? v.base, 'HEAD'], { allowFail: true }) || v.base])),
    // What the planner (and every role) reads first: the issue as captured at entry and from the tracker.
    issue: { file: state.issue?.file ?? null, trackerCaptures: state.tracker.done.map((d) => d.capture?.path).filter(Boolean) },
    criteria: state.criteria,
    plan: state.plan,
    workItems: state.work,
    // The planner assigns each work item a class from these texts.
    classes: role === 'planner' ? Object.fromEntries(Object.entries(cfg.classes).map(([n, c]) => [n, { use: c.use, agentType: agentTypeFor(cfg, 'implementer', n) }])) : undefined,
    criteriaAmendments: state.criteriaAmendments,
    // Project lessons whose declared scope this change falls in (or whose tags the ticket mentions), most recurring
    // first, capped. The reviewer
    // gives each a verdict in `lessons`; they are project rules, not other agents' findings.
    // Lessons outside the change's scope are left out of the bundle (no verdict is owed on them); the handoff prints
    // their ids and `wf lesson preview` says why each was filtered.
    lessons: selected ? { apply: selected.apply, omitted: selected.omitted, more: selected.more, ...(role === 'reviewer' ? { acknowledged: implementerAcks(loadState(root, state.id)).acks } : {}) } : undefined,
    // Evidence files the owner accepted after they changed outside wf (`wf verify --accept-changes`): judge with that in mind.
    rebaselined: state.rebaselines ?? [],
    // Every issue found during the ticket (I-18): fixed by a commit of this ticket or deferred in the owner's words. The
    // implementer fixes the open ones; the reviewer gives each a verdict.
    discovered: ['implementer', 'reviewer'].includes(role) ? state.discovered : undefined,
    // Repos added to the attempt by an owner amendment for a fix (I-19): the reviewer judges each seam on both sides.
    addedRepos: ['implementer', 'reviewer'].includes(role) ? state.addedRepos : undefined,
    changed,
    impact: impact(trusted, changed),
    // I-26: the planner's survey and impact map with every addendum. For the reviewer, the inventory to sample and the
    // callers of symbols the final diff declares or edits that no listed file covers: each needs a verdict.
    impactMap: state.impact && ['implementer', 'reviewer'].includes(role) ? impactMapFor(root, cfg, state, role) : undefined,
    // I-25: the fix round's pattern sweeps (implementer: answer each in a commit trailer; reviewer: the answers, and the
    // hits then and now).
    sweep: role === 'implementer' && sweeps ? sweeps : undefined,
    sweeps: role === 'reviewer' ? sweepsForReviewer(root, cfg, state) : undefined,
    invariants: cfg.invariants ? path.resolve(root, ADAPTER_DIR, cfg.invariants) : null,
    roleAppendix: appendix && fs.existsSync(appendix) ? appendix : null,
    // Which round this is: a code review (no passing gate on this tree; the reviewer judges the diff and no gate runs
    // until a round comes back clean) or the evidence review (a gate passed on this tree after a clean code review; the
    // reviewer inspects its logs and screenshots). Acceptance needs the evidence review.
    round: role === 'reviewer' ? (gateNow.ok ? 'evidence-review' : 'code-review') : undefined,
    gate: role === 'reviewer'
      ? gateNow.ok
        ? { passedOnThisTree: true, runId: state.lastGate.runId, evidence: state.lastGate.evidence, screenshots: screenshots(state), artifacts: artifactsByStep(state, trusted), logs: state.lastGate.steps.filter((s) => s.log).map((s) => ({ step: s.id, log: s.log, status: s.status })) }
        : { passedOnThisTree: false, reason: gateNow.reason, screenshots: [], logs: [] }
      : null,
    // Project rule documents this change falls under, and the skills this round needs: a pure function of the adapter
    // at base and the changed files, the same for every reviewer. Each rule needs a verdict in the closure.
    rules: role === 'reviewer' ? reviewRules(root, trusted, state, changed) : undefined,
    // The project's shared components and design-system rules (adapter at base). For the reviewer, every rule hit on
    // the lines this attempt added: each needs a verdict in `designHits` (justified with evidence, or a finding).
    designSystem: ['planner', 'reviewer', 'implementer'].includes(role) ? (role === 'reviewer' ? designChecks(root, trusted, state) : trusted.designSystem ? { components: trusted.designSystem.components ?? [], rules: (trusted.designSystem.rules ?? []).map((r) => ({ id: r.id, description: r.description, read: r.read ?? null })) } : null) : undefined,
    skills: role === 'reviewer' ? skillFiles(root, requiredSkills(trusted, role, state, changed), runtime) : undefined,
    // Changed files no plan anchor or test path names (docs-only, ignored and evidence files left out). Each needs the
    // reviewer's verdict: covered by a criterion id, or a finding.
    outsidePlan: state.criteria ? outsidePlan(state.plan, changed, trusted) : null,
    // The implementer's definition of done: these light steps pass for its repos (`wf check`). Never counts as a gate.
    check: role === 'implementer' ? { command: `wf check --attempt ${state.id}${work?.repos?.length === 1 ? ` --repo ${work.repos[0]}` : ''}`, steps: trusted.gate.steps.filter((s) => (s.tier ?? 'light') === 'light' && state.repos[s.repo] && (!work?.repos?.length || work.repos.includes(s.repo))).map((s) => ({ id: s.id, repo: s.repo, run: s.run ?? `plugin ${s.plugin}` })) } : undefined,
    // Steps that failed and then passed with the same inputs and runner.
    flaky: role === 'reviewer' ? state.flaky : undefined,
    // Outside .wf-evidence/: the reviewer writes it, `wf review` copies it into the evidence.
    reviewClosureFile: role === 'reviewer' ? path.join(root, '.wf-worktrees', state.id, '_review', `closure-${n}.json`) : null,
    instructions: {
      planner: 'Read the issue and the code, in every repo the issue can reach. Do not change any file. First write the `survey` (stage 1, before any design): what exists around the issue: the components and consumers it touches (one row per affected component: endpoint and limit, write paths, paging kind, empty, loading, error, permission, mobile, RTL and public-API behaviour, sorting, reorder, client-side totals, raw enums, existing tests), the end-to-end flows including failure paths, and the defect patterns to sweep; every list entry names the query it came from (`survey.queries`: { id, pattern, kind: literal|regex, repo, paths, exclude, hits }) and its hit count; `wf impact run --attempt <id> --query <one query as JSON>` runs one as the engine will. Then the design (`plan`, `criteria`, `work`), then `impact` (stage 2, from the chosen design): every changed symbol, endpoint, DTO, error code and migration with `cites` (criteria, work items or anchor text), consumers, flows with failure paths, contracts crossed and suites that must run, and which survey entries it `covers`; every other survey entry goes under `impact.excluded` with a reason. `wf plan` re-runs every query and refuses a count that does not match. Every issue the survey finds is fixed in this ticket: give it a criterion and a work item; never defer it or note it as a follow-up. When the bundle has `designSystem` and the ticket changes a UI surface, add a criterion "uses the shared components: <the ones from designSystem.components this surface needs>" with a uat a person can check. Return your plan as one ```yaml fenced block, last in your reply, keys in this order: { survey: { queries, components, consumers, flows, patterns }, plan: { summary, contract, anchors, tests: { changed, run }, doNotRun, externalServices, agentSplit }, criteria: [{ id: C1, text, uat }], work: [{ id: W1, criteria: [C1], repos, class, why }], impact: { queries, changes, excluded } } (work is optional; classes: see your role file). The owner freezes it from your transcript unchanged. Never write a blanket "no change in <repo or component>" criterion: state the invariant instead (the contract seam stays matched; existing fields, permissions and tenant isolation are unchanged), so a fix that needs another repo is not fenced off. Leave no background command, monitor or sleep loop running when you report.',
      implementer: "When the bundle has `sweep` (a fix round), each entry is a pattern sweep for one open review finding: its `files` are the other places the defect pattern appears. Fix every real instance, not only the one the finding names, and answer each sweep in a commit trailer, one line each: `Sweep <id>: fixed - <the instances fixed>` or `Sweep <id>: clean - <why no other hit is an instance>`; the next review does not start without them. When the bundle has `impactMap`, keep the change inside it: a consumer, flow, contract or suite it does not list is scope the owner records with an impact update (`wf criteria amend` with `impact`) before you build it. Done means `check.command` passes for your repos (it runs the light steps listed under `check`; it never counts as the gate). Implement against the frozen criteria and the plan in the worktrees above: follow `plan.contract`, start from `plan.anchors`, while iterating run only `plan.tests.run` and the specs you changed, never what `plan.doNotRun` lists, and keep to `plan.externalServices` and `plan.agentSplit`. Write tests only for real behaviour. Before finishing run the repo's lint and full unit suite once, in the foreground. Commit at stage boundaries and everything when done. If `work` is set, build that work item; an issue you find anywhere while working is still yours to fix (below). If it turns out to touch something a stronger class covers, stop and tell the owner. For every lesson under `lessons.apply` (this project's lessons for the change, labelled enforced or advisory, with why each matched), follow it and acknowledge it in a commit message trailer, one line each: `Lesson <id>: applied - <how>` or `Lesson <id>: not-applicable - <why>`; the review does not start without them. A commit that fixes a review finding carries a trailer naming it: `Fixes-finding: <round>:<id>` (the reviewer id and finding id you were given; several comma-separated). Every issue you find while working, inside or outside your criteria, is fixed by you, in this attempt, in whatever file it lives in; the work-item brief is never a reason to leave it. The only exception: a file another work item is editing right now: record it with `wf discovered add --attempt <id> --summary \"...\" --where <file:line> --found-by <your agent id> --blocked-by <work item>` and name its D id in your report. A report line that leaves an issue unfixed without its D id refuses the review handoff. The open entries under `discovered` are yours to fix. Never defer one yourself or call it harmless or a follow-up: only the owner defers, in their own words. If a criterion, the plan or your work item's repos block the fix, stop and tell the owner: the owner amends the criteria (adding the repo when the fix needs one). Before you report, stop every background command, monitor or sleep loop you started: a waiter left running keeps notifying the owner after you are done.",
      reviewer: 'Review the whole change against the frozen criteria, and the gate evidence when `gate.passedOnThisTree` is true (then open every screenshot listed under `gate.screenshots`, which are exactly the files `gate.artifacts` lists per glob, and record the sha256 of each one you viewed; a file no glob lists is never required; a step whose package did not change needs nothing; a step marked `uncovered` matched nothing although this ticket changed its package: judge whether the ticket needed a capture there and add `noEvidence: [{ step, reason }]` saying why none is needed, or raise a finding). When it is false, no gate has passed on this tree yet: judge the diff and list no screenshots. You did not write this change. Everything you need is in this bundle; judge the whole change yourself. Read every document under `rules` (each `read` path) and every skill under `skills` (the Skill tool, or its file) in this bundle: they add to the whole review and never narrow it. Give each rule a verdict with one line of evidence (file:line or the document section): `rules: [{ rule, verdict: complies|finding|not-applicable, evidence, finding }]` (`finding` names your finding id when the verdict is finding); a rule marked `docChangedByTicket` had its document changed by this ticket: judge against the copy under `read`, which is the base version. Write the closure file: { reviewer, findings: [{ id, severity, summary, status: open|fixed|verified-nonissue, evidence, work }], criteria: [{ id, evidence: { kind: test|screenshot|output|not-applicable|dropped-with-reason, ref, reason } }] (a screenshot ref is the sha256 or source of a file in `gate.artifacts`), screenshotsInspected: [sha256], anomalies: "none seen" | [{ screenshots: [sha256], observation, cause, evidence, assertions, finding }], noEvidence: [{ step, reason }], rules: [{ rule, verdict, evidence, finding }], outsidePlan: [{ file, verdict: covered|finding, by, evidence }] } (one outsidePlan entry per file the bundle lists under `outsidePlan`: `covered` when a criterion covers that change, with its id in `by`; otherwise `finding` with your finding id in `by`). When you were handed screenshots, compare captures of the same state with each other and with the criteria (counts, dates, names, totals) and fill `anomalies`: "none seen", or per anomaly the screenshots, what differs, and either your `finding` id, or the `cause` you found with its `evidence` (file:line or the data you checked) and the `assertions` (test file:line) that pin the value and would fail if it were wrong; a value no test pins is a finding. Never call one cosmetic without that investigation. When the bundle has \`designSystem\`: for every changed UI file list each table, list, form and dialog it renders and name the shared component used (from \`designSystem.components\`) or the justified exception, and give every \`designSystem.hits\` entry a verdict: \`designHits: [{ id, verdict: justified|finding, evidence, finding }]\` (a closure missing one is refused). Give every entry under \`discovered\` (issues found during the ticket) a verdict: \`discovered: [{ id, verdict: fixed|deferred|open, evidence }]\` (\`fixed\` with the file:line of the fix you checked; \`deferred\` only for an entry the owner deferred; \`open\` when it is not fixed). For every repo under \`addedRepos\`, judge the contract seam on both sides: \`seams: [{ repo, verdict: matched|finding, evidence, finding }]\` (\`matched\` cites the producer file:line and the consumer file:line). Every issue you find is a finding, inside or outside the criteria: never out of scope, a follow-up or harmless on your own judgement. A criterion or scope fence that blocks a fix is a criteria defect (a finding with category \`criteria\`), never a reason to defer or to ship a cosmetic workaround. When the bundle has `impactMap`: run `wf impact run --attempt <id>` (it re-runs every recorded query on this tree) and list each in `impactChecked.queries: [{ query, hits, note }]`, judging every hit that is new or gone since the plan; sample at least `impactMap.sampleSize` inventory entries (`impactMap.inventory`) and check each against the code: `impactChecked.sampled: [{ entry, verdict: matches|finding, evidence, finding }]`; give every entry under `impactMap.derived.outside` (a caller of a symbol the final diff declares or edits, in a file the map lists nowhere) a verdict: `impactChecked.derived: [{ symbol, file, verdict: in-map|impact-gap, evidence, finding }]`. A finding about anything the impact map does not list carries `category: impact-gap`. When the bundle has `sweeps`, check each fix round sweep: its hits now and the answer the implementer gave. Then run `wf review --closure <file>`. Only after your closure is recorded, `wf review` may list findings from earlier rounds for you to verify against the code: then add `priorFindings: [{ round, id, status: fixed|verified-nonissue|open, evidence }]` to the same file, change nothing else, and run `wf review --closure <file>` again.',
      tester: 'Write requirement expectations from the issue before reading the implementation, then map each to gate tests.',
    }[role],
  };
  const record = () => {
    writeJson(file, bundle);
    if (bundle.reviewClosureFile) fs.mkdirSync(path.dirname(bundle.reviewClosureFile), { recursive: true });
    const tree = treeHashes(state);
    // Telemetry: implementers handed work and not closed (`wf handoff close`) while this reviewer starts: the tree may still move.
    const openImplementers = role === 'reviewer' ? state.implementers.filter((x) => !x.closedAt).map((x) => x.agent) : undefined;
    append(root, state.id, 'handoff', { ...(sweeps ? { sweeps } : {}), lessons: (bundle.lessons?.apply ?? []).map((l) => l.id), lessonsFiltered: (selected?.filtered ?? []).map((l) => l.id), role, agent, runtime, session: options.session ?? null, agentType, class: cls, effort, model, sessionModel: sessionModelNow, startPrompt: startPromptFor(file), work: work?.id ?? null, bundle: file, tree, patch: patchIds(state), ...(role === 'reviewer' ? { gate: gateNow.ok ? state.lastGate.runId : null, round: bundle.round, openImplementers } : {}) }, actor(options));
    if (role === 'implementer') append(root, state.id, 'implementer.opened', { handoff: handoffId(file), agent, work: work?.id ?? null, class: cls, heads: tree }, actor(options));
  };
  // The model the owner's session runs on now: an agent whose class pins no model inherits it (`wf report` shows it).
  let sessionModelNow = null;
  const owning = sessionIdentity();
  if (!model && owning?.runtime === 'claude') {
    try {
      sessionModelNow = sessionModel(home(), owning.session);
    } catch {}
  }
  // A reviewer round is recorded holding the gate lock: no gate can start between the check above and this record.
  if (role === 'reviewer') withReviewLock(root, state, record);
  else record();
  // Once per attempt: with parallel work items every implementer handoff queued another identical tracker read.
  const firstImplementer = role === 'implementer' && !state.handoffs.some((h) => h.role === 'implementer');
  if (firstImplementer && state.lane !== 'quick' && state.intent === 'implementation') emitTrackerEvent(root, cfg, state.id, 'implementing');
  // The agent type's role file changed after the owner's session loaded it (I-15): the agent would run the old role.
  let roleStale = null;
  try {
    roleStale = runtime === 'claude' ? roleChangedSinceSessionStart(root, agentType, owning) : null;
  } catch {}
  return { bundle: file, startPrompt: startPromptFor(file), agentType, agent, roleStale, sweeps, restrictions: restrictionWarnings(trusted, state), class: cls, effort, model, work: work?.id ?? null, lessons: bundle.lessons ? { ...bundle.lessons, filtered: selected.filtered } : null, state: loadState(root, state.id) };
}

const describeScope = (s) => [s.addedCriteria?.length ? `criteria added: ${s.addedCriteria.join(', ')}` : null, s.changedCriteria?.length ? `criteria changed: ${s.changedCriteria.join(', ')}` : null, s.addedRepos?.length ? `repos added: ${s.addedRepos.join(', ')}` : null, s.work ? 'work items replaced' : null].filter(Boolean).join('; ');

function impactMapFor(root, cfg, state, role) {
  const recorded = Object.fromEntries(Object.entries(allRecordedQueries(state)).map(([id, q]) => [id, { query: q, hits: [state.impact.results?.[id], ...state.impact.addenda.map((a) => a.results?.[id])].find(Boolean)?.hits ?? null }]));
  const map = { survey: state.impact.survey, impact: state.impact.impact, addenda: state.impact.addenda, queries: recorded, rerun: `wf impact run --attempt ${state.id}` };
  if (role !== 'reviewer') return map;
  const inv = inventory(state);
  return { ...map, inventory: inv, sampleSize: Math.min(10, inv.length), derived: deriveFromDiff(root, cfg, state) };
}

function sweepsForReviewer(root, cfg, state) {
  const { answers } = sweepAnswers(state);
  if (!answers.length) return undefined;
  return answers.map((s) => {
    let now = null;
    try {
      now = rerun(root, cfg, state, { [s.id]: s.query })[s.id];
    } catch {}
    return { id: s.id, finding: s.finding, why: s.why, query: s.query, hitsAtHandoff: s.hits, filesAtHandoff: s.files, hitsNow: now?.hits ?? null, filesNow: now?.files ?? null, answer: s.answer };
  });
}

// Per step with `artifacts`: each glob as declared and as expanded for this attempt, and the files it matched, and the
// ticket's changed files in the step's package (`changedHere`, from the gate's recorded `changed`). A step whose globs
// matched nothing while its package changed is `uncovered`: a UI change whose tests wrote no capture for the ticket
// passed as "no screenshots for this ticket" and nothing flagged it, so acceptance needs the reviewer's verdict on it
// (a `noEvidence` entry with a reason, or a finding). A step whose package did not change requires nothing.
export function artifactsByStep(state, cfg) {
  const changed = state.lastGate?.changed ?? {};
  return (state.lastGate?.steps ?? []).filter((s) => s.artifactGlobs?.length).map((s) => {
    const globs = s.artifactGlobs.map((g) => ({ glob: g.glob, expanded: g.expanded, files: g.files.map((f) => ({ source: f.source, path: f.path, sha256: f.sha256, kind: f.kind })) }));
    const none = globs.every((g) => !g.files.length);
    const changedHere = cfg ? changedForStep(cfg, s.id, s.repo, changed) : [];
    const uncovered = none && changedHere.length > 0;
    const where = globs.flatMap((g) => g.expanded).join(', ');
    const note = !none ? undefined : uncovered
      ? `no captures for this ticket (globs: ${where}), though it changed ${changedHere.length} file(s) in this step's package: give a verdict in \`noEvidence\` ({ step, reason }) or raise a finding`
      : `no screenshots for this ticket (globs: ${where}); this step's package did not change, nothing is required`;
    return { step: s.id, globs, changedHere, uncovered, ...(note ? { note } : {}) };
  });
}

// The same, with the adapter the gate ran with (committed at the attempt's base). Without it nothing is uncovered.
export function evidenceSteps(root, state) {
  let cfg = null;
  try {
    cfg = loadConfigAtCommit(root, loadConfig(root), state.adapterBase);
  } catch {}
  return artifactsByStep(state, cfg);
}

const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The reviewer's verdict on each uncovered step: its `noEvidence` entry (needs a reason) or a finding that names the step.
export function noEvidenceVerdicts(steps, closure) {
  const entries = Array.isArray(closure?.noEvidence) ? closure.noEvidence : [];
  return steps.filter((a) => a.uncovered).map((a) => {
    const entry = entries.find((v) => v?.step === a.step && String(v.reason ?? '').trim());
    const named = new RegExp(`(^|[^\\w-])${escapeRe(a.step)}([^\\w-]|$)`);
    const finding = (closure?.findings ?? []).find((f) => f.step === a.step || named.test(`${f.summary ?? ''} ${f.evidence ?? ''}`));
    return { step: a.step, changed: a.changedHere.length, globs: a.globs.flatMap((g) => g.expanded), reason: entry ? String(entry.reason) : null, finding: finding?.id ?? null };
  });
}

const settled = (status) => ['fixed', 'verified-nonissue'].includes(status);
const roundKey = (r) => r.handoff ?? `reviewer:${r.reviewer}`;

// Findings earlier review rounds left open and no later round has verified, oldest first. A round's own findings are
// recorded blind; only after that does it see these, and acceptance needs each verified (fixed or verified-nonissue,
// with evidence) by a round after the one that found it.
export function earlierOpenFindings(state, currentHandoff) {
  const last = new Map();
  for (const r of state.reviews ?? []) last.set(roundKey(r), r);
  const open = new Map();
  for (const [key, r] of last) {
    if (key === currentHandoff) continue;
    for (const p of r.closure.priorFindings ?? []) if (settled(p.status) && p.evidence) open.delete(`${p.round}:${p.id}`);
    for (const f of r.closure.findings ?? []) if (!settled(f.status)) open.set(`${r.reviewer}:${f.id}`, { round: r.reviewer, id: f.id, severity: f.severity ?? null, summary: f.summary ?? '', evidence: f.evidence ?? null, work: f.work ?? null });
  }
  return [...open.values()];
}

function unverifiedPrior(state, review) {
  const required = earlierOpenFindings(state, roundKey(review));
  const verified = new Map((review.closure.priorFindings ?? []).map((p) => [`${p.round}:${p.id}`, p]));
  return required.filter((f) => {
    const v = verified.get(`${f.round}:${f.id}`);
    return !v || !settled(v.status) || !v.evidence;
  });
}

// The handoff id used by telemetry events: the bundle's file name (`05-implementer`).
export const handoffId = (bundle) => (bundle ? path.basename(String(bundle), '.json') : null);

// `Fixes-finding: <round>:<id>` trailers (several per line, comma-separated) in the attempt's commits: the commit a
// review finding was fixed in. <round> is the reviewer agent id that raised it, as `priorFindings` names it.
const FIXES = /^Fixes-finding:\s*(.+)$/i;
export function findingFixes(state) {
  const out = [];
  for (const [repo, r] of Object.entries(state.repos)) {
    if (!r.worktree || !fs.existsSync(r.worktree)) continue;
    const log = git(r.worktree, ['log', '--reverse', '--format=%H%n%B%n--wf-end--', `${r.base}..HEAD`], { allowFail: true }) ?? '';
    for (const chunk of log.split('--wf-end--')) {
      const lines = chunk.trim().split('\n');
      for (const line of lines.slice(1)) {
        const m = FIXES.exec(line.trim());
        if (!m) continue;
        for (const ref of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
          const i = ref.lastIndexOf(':');
          if (i > 0 && !out.some((x) => x.round === ref.slice(0, i) && x.id === ref.slice(i + 1))) out.push({ round: ref.slice(0, i), id: ref.slice(i + 1), repo, commit: lines[0] });
        }
      }
    }
  }
  return out;
}

// One `review.round` event (telemetry): the tree the reviewer judged, whether a gate had passed on it, who reviewed
// on which model, the outcome, each finding with its severity, and the commits earlier findings were fixed in.
function roundData(state, h, closure, { outcome, reason = null, reasonClass = null, model = null, revealed = false }) {
  const prior = Array.isArray(closure?.priorFindings) ? closure.priorFindings : [];
  let fixes = [];
  try {
    fixes = findingFixes(state);
  } catch {}
  return {
    handoff: handoffId(h.bundle),
    bundle: h.bundle,
    agent: h.agent,
    agentType: h.agentType ?? null,
    model: model ?? h.model ?? null,
    tree: h.tree ?? null,
    gatePassedOnTree: Boolean(h.gate),
    gateRun: h.gate ?? null,
    openImplementers: h.openImplementers ?? null,
    outcome,
    reasonClass,
    reason,
    revealed,
    findings: (Array.isArray(closure?.findings) ? closure.findings : []).map((f) => ({ id: f?.id ?? null, severity: f?.severity ?? null, status: f?.status ?? null, category: f?.category ?? null })),
    priorFindings: prior.map((p) => ({ round: p?.round ?? null, id: p?.id ?? null, status: p?.status ?? null, fixedIn: p?.fixedIn ?? fixes.find((x) => x.round === p?.round && x.id === p?.id)?.commit ?? null })),
    fixes,
  };
}

// A closure refused in a way that ends the round (a fresh reviewer is needed): recorded once per round and cause.
function refusedRound(root, state, h, closure, reasonClass, reason) {
  if ((state.reviewRounds ?? []).some((r) => r.bundle === h.bundle && r.outcome === 'refused' && r.reasonClass === reasonClass)) return;
  try {
    append(root, state.id, 'review.round', roundData(state, h, closure, { outcome: 'refused', reason, reasonClass }), null);
  } catch {}
}

// `wf handoff close --agent ID`: the implementer finished (or was stopped). Telemetry: the tree is settled once every
// implementer is closed, and its sub-agents (Claude Code transcripts whose parent is its transcript) are attributed.
export function closeImplementer(root, options) {
  const state = openState(root, options);
  if (!options.agent || options.agent === true) throw new WfError('--agent <implementer id> is required');
  const agent = String(options.agent);
  const open = state.implementers.filter((x) => x.agent === agent && !x.closedAt).at(-1);
  if (!open) throw refuse(`no open implementer \`${agent}\` on ${state.id}${state.implementers.length ? ` (open: ${state.implementers.filter((x) => !x.closedAt).map((x) => x.agent).join(', ') || 'none'})` : ''}`);
  const outcome = options.outcome && options.outcome !== true ? String(options.outcome) : 'done';
  if (!['done', 'stopped', 'failed'].includes(outcome)) throw new WfError('--outcome must be done, stopped or failed');
  const heads = treeHashes(state);
  const commits = {};
  for (const [name, r] of Object.entries(state.repos)) {
    const from = String(open.heads?.[name] ?? '').split('+')[0];
    const n = from ? git(r.worktree, ['rev-list', '--count', `${from}..HEAD`], { allowFail: true }) : null;
    commits[name] = n === null || n === undefined || n === '' ? null : Number(n);
  }
  const h = state.handoffs.filter((x) => x.role === 'implementer' && x.agent === agent).at(-1);
  let children = [];
  if (h?.runtime === 'claude') {
    try {
      children = childAgents(home(), agent, h.agentType, h.at);
    } catch {}
  }
  if (children.length) append(root, state.id, 'subagents.attributed', { handoff: open.handoff, children }, actor(options));
  append(root, state.id, 'implementer.closed', { handoff: open.handoff, agent, outcome, heads, commits }, actor(options));
  return { state: loadState(root, state.id), handoff: open.handoff, outcome, commits, children };
}

export function recordReview(root, options) {
  const state = openState(root, options);
  if (typeof options.closure !== 'string') throw new WfError('--closure <file> is required');
  const closureText = readOnce(options.closure);
  let closure;
  try {
    closure = JSON.parse(closureText);
  } catch (error) {
    throw new WfError(`invalid JSON in ${options.closure}: ${error.message}`);
  }
  const reviewerHandoff = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  if (!reviewerHandoff) throw refuse('no reviewer handoff: run `wf handoff reviewer --agent <id>`');
  if (closure.reviewer !== reviewerHandoff.agent) throw refuse(`closure reviewer \`${closure.reviewer}\` is not the reviewer handed this attempt (\`${reviewerHandoff.agent}\`)`);
  if (!Array.isArray(closure.findings) || !Array.isArray(closure.criteria)) throw new WfError('closure needs `findings` and `criteria` lists');
  // The review is bound to the tree the reviewer was handed: a write anywhere in the worktrees during the round
  // (the reviewer may write only its closure file, outside them) invalidates it.
  if (reviewerHandoff.tree && canonical(treeHashes(state)) !== canonical(reviewerHandoff.tree)) {
    const moved = Object.keys({ ...treeHashes(state), ...reviewerHandoff.tree }).filter((k) => treeHashes(state)[k] !== reviewerHandoff.tree[k]);
    // Named failure (I-23): two review rounds were refused because implementers were still editing, and nothing in the
    // ledger showed it. The refused round is recorded; it is over, and the next round starts on the committed tree.
    append(root, state.id, 'review.refused', { handoff: reviewerHandoff.bundle, reviewer: reviewerHandoff.agent, reason: 'tree-changed', moved, handedTree: reviewerHandoff.tree, tree: treeHashes(state) }, String(closure.reviewer ?? reviewerHandoff.agent));
    refusedRound(root, state, reviewerHandoff, closure, 'tree-changed', `the worktree changed during the review round (${moved.join(', ')})`);
    throw refuse(`the worktree changed during the review round (${moved.join(', ')}): the closure no longer describes the tree under review; a reviewer writes only the file in \`reviewClosureFile\``, 'restore or commit the change through the implementer, then start a fresh reviewer: `wf handoff reviewer --agent <new id>`');
  }
  // Provenance: where transcripts exist, the closure must come from the agent handed this round, started with exactly
  // the printed line after its handoff. A steered reviewer, or a round run outside the engine, is refused.
  const provenance = verifyAgent(reviewerHandoff);
  if (provenance.status === 'mismatch') refusedRound(root, state, reviewerHandoff, closure, 'provenance', provenance.reason);
  if (provenance.status === 'mismatch') throw refuse(`review provenance: ${provenance.reason}`, `start a fresh reviewer: \`wf handoff reviewer --agent <new id>\`, then start it as the agent type that command prints, named <new id> (the Agent tool's name), with only the printed line as its prompt`);
  // Where the transcript exists, it must show a successful read of every rule document and skill in the bundle. It
  // proves the content reached the reviewer, not that it was understood. Without a transcript: recorded unverified.
  const handed = readBundle(reviewerHandoff.bundle);
  let reads = { status: 'unverified', reason: provenance.reason ?? null };
  if (provenance.status === 'verified' && (handed.rules?.length || handed.skills?.length)) {
    const missing = unreadDocs(readTranscript(provenance.transcript), handed.rules, handed.skills);
    if (missing.length) refusedRound(root, state, reviewerHandoff, closure, 'unread-documents', `${missing.length} document(s) in the bundle not read`);
    if (missing.length) throw refuse(`the reviewer's transcript shows no successful read of ${missing.length} document(s) its bundle lists:\n  - ${missing.join('\n  - ')}`, 'start a fresh reviewer round: `wf handoff reviewer --agent <new id>` with only the printed line; it reads every document under `rules` and `skills`');
    reads = { status: 'verified', reason: null };
  } else if (provenance.status === 'verified') reads = { status: 'verified', reason: 'nothing to read' };
  // Every lesson injected into the reviewer's bundle needs a verdict before the closure is recorded.
  const lv = lessonVerdicts(handed.lessons?.apply ?? [], closure);
  if (lv.problems.length) throw refuse(`closure refused: ${lv.problems.length} lesson(s) in your bundle have no valid verdict:\n  - ${lv.problems.join('\n  - ')}`, 'add `lessons: [{ "lesson": "<id>", "verdict": "complied|not-applicable|finding", "evidence": "...", "finding": "<finding id when a finding>" }]` and run `wf review --closure <file>` again');
  // Every design-system hit in the reviewer's bundle needs a verdict before the closure is recorded.
  const dv = designVerdicts(handed.designSystem?.hits ?? [], closure);
  if (dv.problems.length) throw refuse(`closure refused: ${dv.problems.length} design-system hit(s) on lines this attempt added have no valid verdict:\n  - ${dv.problems.join('\n  - ')}`, 'add `designHits: [{ "id": "<hit id>", "verdict": "justified|finding", "evidence": "...", "finding": "<finding id when a finding>" }]` to the closure and run `wf review --closure <file>` again');
  // Every issue found during the ticket (I-18) and every seam to a repo added for a fix (I-19) needs a verdict.
  const xv = discoveredVerdicts(handed.discovered ?? [], closure);
  if (xv.problems.length) throw refuse(`closure refused: ${xv.problems.length} discovered issue(s) in your bundle have no valid verdict:\n  - ${xv.problems.join('\n  - ')}`, 'add `discovered: [{ "id": "D1", "verdict": "fixed|deferred|open", "evidence": "<file:line of the fix, or what is still wrong>" }]` to the closure and run `wf review --closure <file>` again');
  const sv = seamVerdicts(handed.addedRepos ?? [], closure);
  if (sv.problems.length) throw refuse(`closure refused: ${sv.problems.length} repo(s) added during the attempt have no valid seam verdict:\n  - ${sv.problems.join('\n  - ')}`, 'add `seams: [{ "repo": "<added repo>", "verdict": "matched|finding", "evidence": "<producer file:line>; <consumer file:line>", "finding": "<finding id when a finding>" }]` to the closure and run `wf review --closure <file>` again');
  // I-26: the reviewer re-ran every recorded query on this tree, sampled the inventory and judged every caller of a
  // changed symbol outside the map; findings outside the map are tagged impact-gap.
  if (handed.impactMap) {
    const ip = impactCheckProblems(handed.impactMap, closure, rerun(root, loadConfig(root), state));
    if (ip.length) throw refuse(`closure refused: the impact check is incomplete:\n  - ${ip.join('\n  - ')}`, 'add `impactChecked: { "queries": [{ "query": "<id>", "hits": <n>, "note": "..." }], "sampled": [{ "entry": "<survey or impact id>", "verdict": "matches|finding", "evidence": "file:line", "finding": "<id>" }], "derived": [{ "symbol", "file", "verdict": "in-map|impact-gap", "evidence", "finding" }] }` (hits from `wf impact run --attempt <id>`), and run `wf review --closure <file>` again');
  }
  const av = reviewAnomalies(handed.gate, closure);
  if (av.length) throw refuse(`closure refused: the anomalies seen in the screenshots are not accounted for:\n  - ${av.join('\n  - ')}`, `add \`anomalies\` to the closure: "none seen" after comparing the captures, or [{ "screenshots": ["<sha256>"], "observation": "<what differs>", "cause": "<the cause you found>", "evidence": "<file:line or data you checked>", "assertions": "<test file:line that pins this value and fails when it is wrong>" }] or, when it is a defect or no test pins it, { ..., "finding": "<your finding id>" }; then \`wf review --closure <file>\` again`);
  // Commit, then reveal: the first closure of a round is blind. Earlier rounds' findings are shown only after it is
  // recorded, and a later closure of the same round may only add their verification.
  const round = reviewerHandoff.bundle;
  const revealed = (state.reviews ?? []).find((r) => r.handoff === round && r.revealed);
  if (!revealed && closure.priorFindings?.length) throw refuse('`priorFindings` are listed only after your own blind closure is recorded; record the closure without them first');
  if (revealed && canonical(revealed.closure.findings) !== canonical(closure.findings)) throw refuse('your own findings were recorded blind and cannot change after earlier rounds were revealed; only add `priorFindings`');
  const revealNow = !revealed && earlierOpenFindings(state, round).length > 0;
  const n = state.reviews.filter((r) => r.handoff === round).length + 1;
  const tag = `${String(state.handoffs.indexOf(reviewerHandoff) + 1).padStart(2, '0')}-${n}`;
  const raw = keepRaw(root, state.id, `review/closure-${tag}.raw.json`, closureText);
  const dest = path.join(attemptDir(root, state.id), 'review', `closure-recorded-${state.handoffs.length}.json`);
  writeJson(dest, closure);
  // The closure is for the tree the reviewer was handed. It inspected gate evidence only if a passing gate on that tree
  // was in its bundle (0.1.5 and earlier handed a reviewer only after such a gate, so their handoffs carry no field).
  const gateEvidenceInspected = 'gate' in reviewerHandoff ? Boolean(reviewerHandoff.gate) : true;
  let reviewerModel = reviewerHandoff.runtime === 'claude' ? subagentModel(home(), reviewerHandoff.agent, reviewerHandoff.agentType, reviewerHandoff.at) : null;
  if (!reviewerModel && provenance.identity === 'unnamed') reviewerModel = lastModel(readTranscript(provenance.transcript));
  append(root, state.id, 'review.recorded', { closure, file: dest, raw, handoff: round, revealed: Boolean(revealed) || revealNow, provenance: provenance.status, provenanceReason: provenance.reason ?? null, identity: provenance.identity ?? null, transcript: provenance.transcript ?? null, reads, tree: reviewerHandoff.tree, gateRun: reviewerHandoff.gate ?? null, gateEvidenceInspected, handoffTree: reviewerHandoff.tree, handoffPatch: reviewerHandoff.patch, reviewerModel, impactGaps: (closure.findings ?? []).filter((f) => f?.category === 'impact-gap').length }, closure.reviewer);
  append(root, state.id, 'review.round', roundData(state, reviewerHandoff, closure, { outcome: 'recorded', model: reviewerModel, revealed: Boolean(revealed) }), null);
  const after = loadState(root, state.id);
  const toVerify = unverifiedPrior(after, after.review);
  let reveal = null;
  if (toVerify.length) {
    reveal = path.join(root, '.wf-worktrees', state.id, '_review', `prior-findings-${tag}.json`);
    safeWriteJson(root, reveal, { note: 'Findings earlier review rounds left open. Check each against the current code; add priorFindings to your closure.', findings: toVerify });
  }
  return { state: after, reveal, toVerify };
}

// The review round handed last when no closure has been recorded for it, it was not refused, and the tree is still the
// one it was handed: that reviewer is still at work. Null otherwise.
export function reviewInFlight(state) {
  const last = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  if (!last) return null;
  const ended = (x) => (x.handoff ? x.handoff === last.bundle : x.reviewer === last.agent);
  if ((state.reviews ?? []).some(ended) || (state.reviewsRefused ?? []).some(ended)) return null;
  if (last.tree && canonical(last.tree) !== canonical(treeHashes(state))) return null;
  return last;
}

// Whether a recorded review round covers the tree as it is now: the same tree, or the same change of the ticket (a base
// merged in without touching it keeps the reviewed change).
function reviewCovers(state, r) {
  const t = r.tree ?? r.handoffTree;
  if (t && canonical(t) === canonical(treeHashes(state))) return true;
  const reviewed = r.handoffPatch ?? null;
  if (!reviewed) return false;
  try {
    return canonical(patchIds(state)) === canonical(reviewed);
  } catch {
    return false;
  }
}

// Named failure (I-27): gates ran beside review rounds and on unreviewed trees, and each finding made the gate obsolete
// (15 of 16 gates stopped on one ticket, about 175 of 271 gate minutes discarded). The order is: code-review rounds
// until one comes back clean, then one gate on that tree, then the evidence review. What stands between this tree and
// its gate, as lines; empty when the gate may run.
export function gateOrderProblems(state) {
  const problems = [];
  const busy = reviewInFlight(state);
  if (busy) problems.push(`reviewer ${busy.agent} was handed this tree and has recorded no closure: review and gate never run side by side; wait for its closure`);
  const r = state.review;
  if (!r || !reviewCovers(state, r)) {
    if (!busy) problems.push(`no review round covers the current tree: run the code review first (\`wf handoff reviewer --agent <new id>\`); the gate runs once a round on this tree comes back clean`);
    return problems;
  }
  const open = openFindings(r);
  if (open.length) problems.push(`the latest review round (${r.closure.reviewer}) has open findings (${open.map((f) => f.id).join(', ')}): fix them through the implementer, commit, and run the next code-review round until one comes back clean`);
  const toVerify = unverifiedPrior(state, r);
  if (toVerify.length) problems.push(`the latest review round (${r.closure.reviewer}) has not verified ${toVerify.length} earlier-round finding(s) (${toVerify.map((f) => `${f.round}:${f.id}`).join(', ')})`);
  return problems;
}

// `wf gate` checks the order under the gate lock; `--reason` runs it anyway and records the override in the ledger.
export function gateOrderCheck(root, options) {
  return (state) => {
    const problems = gateOrderProblems(state);
    if (!problems.length) return;
    const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
    if (!reason) throw refuse(`the gate runs after a clean code review, never beside or before it:\n  - ${problems.join('\n  - ')}`, 'follow the order (`wf resume` names the next step), or run it anyway with `wf gate --reason "<why>"`, which records the override in the ledger');
    append(root, state.id, 'gate.override', { reason, problems, tree: treeHashes(state) }, actor(options));
  };
}

// I-12. Named failure: a cross-locale difference in screenshot numbers was dismissed as cosmetic without checking; it
// came from shared test data and hid vacuous assertions (tests that passed whatever the value was). A reviewer handed
// screenshots now accounts for what it saw: `anomalies` is "none seen" after comparing the captures (counts, dates,
// names, totals, between captures of the same state and against the criteria), or each anomaly with the screenshots it
// was seen in and either a finding, or the investigated cause with its evidence and the test assertion that pins the
// value (a value no test pins is a test gap, so a finding). No wording is judged: the fields are required.
export function reviewAnomalies(gate, closure) {
  const shots = gate?.passedOnThisTree ? gate.screenshots ?? [] : [];
  if (!shots.length) return [];
  const v = closure.anomalies;
  if (v === undefined || v === null) return ['no `anomalies` key: compare the captures of the same state with each other and with the criteria (counts, dates, names, totals) and say what you saw'];
  if (typeof v === 'string') return /^\s*none seen\s*\.?\s*$/i.test(v) ? [] : ['`anomalies` must be "none seen" or a list'];
  if (!Array.isArray(v)) return ['`anomalies` must be "none seen" or a list'];
  const problems = [];
  const known = new Set(shots.flatMap((a) => [a.sha256, a.source, a.path].filter(Boolean)));
  const findings = new Set((closure.findings ?? []).map((f) => f.id));
  const text = (x) => String(x ?? '').trim();
  for (const [i, a] of v.entries()) {
    const label = `anomaly ${i + 1}`;
    const seen = Array.isArray(a?.screenshots) ? a.screenshots.map(String) : a?.screenshots ? [String(a.screenshots)] : [];
    if (!seen.length) problems.push(`${label}: name the screenshot(s) it was seen in (\`screenshots\`: sha256)`);
    else if (seen.some((x) => !known.has(x))) problems.push(`${label}: ${seen.filter((x) => !known.has(x)).join(', ')} is not a screenshot of this gate`);
    if (!text(a?.observation)) problems.push(`${label}: \`observation\` says what differs or contradicts a criterion`);
    if (text(a?.finding)) {
      if (!findings.has(text(a.finding))) problems.push(`${label}: finding ${text(a.finding)} is not among your findings`);
      continue;
    }
    if (!text(a?.cause)) problems.push(`${label}: investigate it to a \`cause\`, or raise it as a \`finding\`; an anomaly is never left unexplained or called cosmetic unchecked`);
    if (!text(a?.evidence)) problems.push(`${label}: \`evidence\` says what you checked (file:line, the test data, the query) that shows the cause`);
    if (!text(a?.assertions)) problems.push(`${label}: \`assertions\` names the test assertion (file:line) that pins this value and would fail if it were wrong; when none does, the value is unchecked: raise a \`finding\``);
  }
  return problems;
}

// 0.1.5 and earlier recorded no flag: their reviewers were handed the attempt only after a passing gate on that tree.
const reviewedAfterGate = (r) => r.gateEvidenceInspected ?? true;
const openFindings = (r) => r.closure.findings.filter((f) => !['fixed', 'verified-nonissue'].includes(f.status));

const EVIDENCE_KINDS = new Set(['test', 'screenshot', 'output', 'not-applicable', 'dropped-with-reason']);

export function acceptReview(root, options) {
  const state = openState(root, options);
  const r = state.review;
  if (!r) throw refuse('no review recorded: `wf review --closure <file>`');
  const problems = [];
  if (authorsOf(root, state).has(r.closure.reviewer)) problems.push(`reviewer ${r.closure.reviewer} also planned, wrote or owns this change`);
  for (const f of r.closure.findings) {
    if (!['fixed', 'verified-nonissue'].includes(f.status)) problems.push(`finding ${f.id} is ${f.status ?? 'open'}`);
    if (!f.evidence) problems.push(`finding ${f.id} has no evidence`);
  }
  const mapped = new Map(r.closure.criteria.map((c) => [c.id, c]));
  for (const c of state.criteria ?? []) {
    const m = mapped.get(c.id);
    if (!m) {
      problems.push(`criterion ${c.id} is not mapped to evidence`);
      continue;
    }
    // A criterion kept only because of precedent (a past merge, an existing test, an earlier verdict) needs a
    // purpose-based rationale naming the user of the surface, or a `precedent-only` finding.
    if (m.precedentOnly === true && !String(m.rationale ?? c.rationale ?? '').trim() && !r.closure.findings.some((f) => f.category === 'precedent-only')) problems.push(`criterion ${c.id}: kept only on precedent; give a purpose-based \`rationale\` (who uses this surface and what they need) or raise a \`precedent-only\` finding`);
    const kind = m.evidence?.kind;
    if (!EVIDENCE_KINDS.has(kind)) problems.push(`criterion ${c.id}: evidence kind must be one of ${[...EVIDENCE_KINDS].join(', ')}`);
    else if (['not-applicable', 'dropped-with-reason'].includes(kind) && !m.evidence.reason?.trim()) problems.push(`criterion ${c.id}: ${kind} needs a reason`);
    else if (!['not-applicable', 'dropped-with-reason'].includes(kind) && !m.evidence.ref) problems.push(`criterion ${c.id}: ${kind} evidence needs a ref`);
  }
  const collected = screenshots(state);
  for (const c of state.criteria ?? []) {
    const ev = mapped.get(c.id)?.evidence;
    if (ev?.kind !== 'screenshot' || !ev.ref) continue;
    const ref = String(ev.ref).trim();
    if (!collected.some((a) => [a.sha256, a.source, a.path].includes(ref))) problems.push(`criterion ${c.id}: screenshot \`${ref}\` is not one the gate collected for this ticket; reference a file in the bundle's \`gate.artifacts\` by sha256 or source path`);
  }
  const verdicts = noEvidenceVerdicts(evidenceSteps(root, state), r.closure);
  for (const v of verdicts) {
    if (!v.reason && !v.finding) problems.push(`step ${v.step}: its artifacts globs (${v.globs.join(', ')}) matched nothing though this ticket changed ${v.changed} file(s) in its package; the reviewer gives a verdict: \`noEvidence: [{ "step": "${v.step}", "reason": "<why no capture is needed>" }]\` in the closure, or a finding`);
  }
  // Every changed file outside the plan the reviewer's bundle listed needs a verdict: covered by a criterion, or a finding.
  const ov = outsideVerdicts(readBundle(r.handoff)?.outsidePlan ?? [], r.closure, state.criteria);
  if (ov.problems.length) problems.push(`${ov.problems.length} changed file(s) outside the plan without a valid verdict:\n    - ${ov.problems.join('\n    - ')}\n    the reviewer adds \`outsidePlan: [{ "file", "verdict": "covered|finding", "by": "<criterion or finding id>", "evidence" }]\`; for an intended change, amend the criteria (\`wf criteria amend\`) and hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  // Every rule the reviewer's bundle listed needs a verdict with evidence (a finding verdict names a finding).
  const rv = ruleVerdicts(readBundle(r.handoff)?.rules ?? [], r.closure);
  for (const p of rv.problems) problems.push(`${p}; the reviewer adds \`rules: [{ "rule", "verdict": "complies|finding|not-applicable", "evidence", "finding" }]\` to its closure: hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  const lv = lessonVerdicts(readBundle(r.handoff)?.lessons?.apply ?? [], r.closure);
  for (const p of lv.problems) problems.push(`${p}; hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  const dv = designVerdicts(readBundle(r.handoff)?.designSystem?.hits ?? [], r.closure);
  for (const p of dv.problems) problems.push(`${p}; hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  // I-18: every issue found during the ticket was judged by this round, and none was found open.
  const reviewedBundle = readBundle(r.handoff);
  const handedIds = new Set((reviewedBundle?.discovered ?? []).map((d) => d.id));
  for (const d of state.discovered ?? []) if (!handedIds.has(d.id)) problems.push(`discovered ${d.id} was recorded after this review round was handed (${d.summary}); hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  const xv = discoveredVerdicts(reviewedBundle?.discovered ?? [], r.closure);
  for (const p of xv.problems) problems.push(`discovered ${p}; hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  for (const v of xv.verdicts) if (v.verdict === 'open') problems.push(`discovered ${v.id}: the reviewer found it open (${v.evidence}); fix it in this ticket through the implementer (or record the owner's deferral: \`wf discovered close ${v.id} --deferred\` once the owner's message starts with \`defer ${state.id}:${v.id}\`), then hand the tree to a fresh reviewer`);
  // I-19: every repo added for a fix had its seam judged on both sides by this round.
  const handedRepos = new Set((reviewedBundle?.addedRepos ?? []).map((a) => a.repo));
  for (const a of state.addedRepos ?? []) if (!handedRepos.has(a.repo)) problems.push(`repo ${a.repo} was added after this review round was handed; hand the tree to a fresh reviewer`);
  const sv = seamVerdicts(reviewedBundle?.addedRepos ?? [], r.closure);
  for (const p of sv.problems) problems.push(`seam ${p}; hand the tree to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`)`);
  if (reviewedBundle?.impactMap && !r.closure.impactChecked) problems.push('the closure has no `impactChecked` for the impact map in its bundle; hand the tree to a fresh reviewer (`wf handoff reviewer --agent <new id>`)');
  if (state.impact?.owed) problems.push(`amendment ${state.impact.owed.amendment} added scope without an impact update; record it (\`wf criteria amend\` with an \`impact\` addendum) and hand the tree to a fresh reviewer`);
  const shots = collected.map((s) => s.sha256);
  const inspected = new Set(r.closure.screenshotsInspected ?? []);
  const unseen = shots.filter((h) => !inspected.has(h));
  if (unseen.length) problems.push(`${unseen.length} gate screenshot(s) not inspected by the reviewer (the gate's expanded artifacts globs matched them for this ticket): ${collected.filter((a) => !inspected.has(a.sha256)).slice(0, 5).map((a) => a.source ?? a.path).join(', ')}${unseen.length > 5 ? ' …' : ''}`);
  const pending = unverifiedPrior(state, r);
  if (pending.length) problems.push(`earlier-round finding(s) not verified: ${pending.map((f) => `${f.round}:${f.id}`).join(', ')}; the reviewer of this round adds \`priorFindings\` (fixed or verified-nonissue, with evidence) after its blind closure and records it again`);
  // Acceptance needs three things on the current tree: a passing full gate, a clean closure written for this tree, and
  // that closure written after the gate passed on it, so the reviewer inspected the gate evidence.
  const g = gatePassedForCurrentTree(state);
  if (!g.ok) problems.push(`gate: ${g.reason}; run \`wf gate\``);
  const fresh = 'hand it to a fresh reviewer: `wf handoff reviewer --agent <new id>`, start it with only the printed line, then `wf review --closure <file>`';
  const reviewedTree = r.tree ?? r.handoffTree;
  if (canonical(treeHashes(state)) !== canonical(reviewedTree)) problems.push(`no closure for the current tree: the code changed after the last review; ${fresh}`);
  else if (g.ok && !reviewedAfterGate(r)) problems.push(`the closure was written before a passing gate on this tree, so no reviewer has inspected the gate evidence; for the evidence pass ${fresh}`);
  if (problems.length) throw refuse(`review not accepted:\n  - ${problems.join('\n  - ')}`);
  // Nothing verified when this command opened the attempt may have changed while it decided.
  const moved = assertUnchanged(root, state.id);
  if (moved.length) throw refuse(`review not accepted: the evidence changed while it was checked:\n  - ${moved.slice(0, 10).join('\n  - ')}`);
  append(root, state.id, 'review.accepted', { reviewer: r.closure.reviewer, patch: patchIds(state), heads: treeHashes(state), gate: state.lastGate.runId, ...(verdicts.length ? { noEvidence: verdicts } : {}), ...(rv.verdicts.length ? { rules: rv.verdicts } : {}), ...(ov.verdicts.length ? { outsidePlan: ov.verdicts } : {}), ...(dv.verdicts.length ? { designHits: dv.verdicts } : {}), ...(lv.verdicts.length ? { lessons: lv.verdicts } : {}), ...(xv.verdicts.length ? { discovered: xv.verdicts } : {}), ...(sv.verdicts.length ? { seams: sv.verdicts } : {}) }, actor(options));
  // A lesson the change did not comply with recurred: its mechanism failed (once per lesson per attempt).
  const already = new Set((state.lessons?.recurred ?? []).map((x) => x.id));
  for (const v of lv.verdicts) if (v.verdict === 'finding' && !already.has(v.lesson)) recur(root, v.lesson, state.id, actor(options), `review finding ${v.finding}`);
  return loadState(root, state.id);
}

// The states an adapter's `observe` reports (docs/DESIGN.md). Only the pending ones wait.
const ADAPTER_STATES = ['integrated', 'awaiting-merge', 'ci-running', 'ci-failed', 'rejected'];
const PENDING = ['awaiting-merge', 'ci-running'];
// The commit the delivery adapter is read at: the admission pin, or the owner's re-pin (I-21). Only delivery reads it.
export const deliveryPin = (state) => state.deliveryAdapterBase ?? state.adapterBase;

async function loadDeliveryAdapter(root, cfg, state) {
  const trusted = loadConfigAtCommit(root, cfg, deliveryPin(state));
  if (trusted.delivery.kind === 'push-main') return null;
  return (await import(pathToFileURL(adapterFileAtCommit(root, cfg, deliveryPin(state), trusted.delivery.kind)).href)).default;
}

// The state an adapter reported, as the owner acknowledges it: `none` when it reported none.
const stateLabel = (observed) => (observed?.state === undefined || observed?.state === null || observed?.state === '' ? 'none' : String(observed.state));
const describeState = (observed) => (stateLabel(observed) === 'none' ? 'no state' : ADAPTER_STATES.includes(observed.state) ? observed.state : `an unknown state ${JSON.stringify(String(observed.state))}`);

// Whether the worktree's HEAD is on the repo's target branch (fetched now).
function onTarget(r, repo) {
  if (!git(r.worktree, ['remote']).split('\n').includes(repo.remote)) return null;
  run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: r.worktree, allowFail: true });
  const head = git(r.worktree, ['rev-parse', 'HEAD']);
  const landed = head !== r.base && run('git', ['merge-base', '--is-ancestor', head, `${repo.remote}/${repo.base}`], { cwd: r.worktree, allowFail: true }).status === 0;
  return landed ? { head, target: `${repo.remote}/${repo.base}` } : null;
}

// I-20. Named failure: an adapter whose integrate pushes straight to the target branch and whose observe then reports
// anything but `integrated` (CI that fails after the merge, a missing state) was counted as delivered on the next
// `wf deliver` from git ancestry alone, and the adapter was never asked again. Now the adapter is asked again; a
// pending state waits; any other state after the merge is shown and counts only once the owner acknowledges that repo
// and that state (`--acknowledge-adapter-state <repo>:<state>`), recorded with the delivery like a deferral.
function postMerge(options, name, landed, observed, integrated) {
  const label = `${name}:${stateLabel(observed)}`;
  const given = typeof options['acknowledge-adapter-state'] === 'string' ? options['acknowledge-adapter-state'].split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (given.includes(label)) return { repo: name, commit: landed.head, target: landed.target, ...(integrated ?? {}), adapterState: stateLabel(observed), observed: observed ?? null, acknowledged: label };
  const url = integrated?.url ? ` (${integrated.url})` : '';
  throw refuse(`not delivered: ${name}: ${landed.head.slice(0, 10)} is already on ${landed.target}, but the delivery adapter reports ${describeState(observed)} after the merge${url}${observed?.evidence ? `: ${observed.evidence}` : ''}; being on the target branch alone does not count as a clean delivery`, `show this to the owner: the change is on ${landed.target} and the adapter says ${stateLabel(observed)}. ${stateLabel(observed) === 'ci-failed' ? 'Read that CI run. ' : ''}Once the owner has seen it and decides the delivery stands (anything to fix goes into a new attempt, \`wf reopen\`), run \`wf deliver --acknowledge-adapter-state ${label}\`; it is recorded and shown with the delivery. An adapter that reports a wrong state is fixed on the base branch, then \`wf deliver --repin-adapter --reason "<why>"\``);
}

// I-21. Named failure: an attempt is pinned to the adapter as committed at its admission; when the delivery adapter
// faulted after another repo of the same attempt was delivered, every `wf deliver` refused, `wf abandon` refused because
// the attempt was partly delivered, and the fixed adapter on the base branch never reached it. `wf deliver
// --repin-adapter <commit> --reason "..."` re-reads the delivery adapter from the current tip of the base branch the
// adapter lives on (never the working tree), only forward along that branch, only while something is still to deliver.
// Without the commit it refuses and shows the owner what changes (old and new pin, the adapter files that differ, what is
// already delivered); the owner's confirmation is that commit typed back. Recorded in the ledger (`adapter.repinned`)
// with both pins and the reason. The gate, the review and the tracker stay on the admission pin.
function repinAdapter(root, cfg, state, options) {
  const want = typeof options['repin-adapter'] === 'string' ? options['repin-adapter'].trim() : '';
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  const { repo, relative } = adapterLocation(root, cfg);
  const dir = repoDir(root, repo);
  const ref = baseRef(dir, repo);
  const tip = git(dir, ['rev-parse', ref]);
  const pinned = deliveryPin(state);
  // Run again after a later step refused: the re-pin an earlier try recorded is accepted again.
  if (want.length >= 7 && tip.startsWith(want) && pinned === tip && state.adapterRepins.some((x) => x.to === tip)) return state;
  if (tip === pinned) throw refuse(`not re-pinned: the delivery adapter of ${state.id} is already read at the tip of ${ref} (${tip.slice(0, 10)})`, `commit and push the fixed adapter on ${repo.base} in ${repo.name} first`);
  if (run('git', ['merge-base', '--is-ancestor', pinned, tip], { cwd: dir, allowFail: true }).status !== 0) throw refuse(`not re-pinned: ${ref} (${tip.slice(0, 10)}) does not contain the current pin ${pinned.slice(0, 10)}; the adapter is re-pinned only forward along the base branch`);
  let kinds;
  try {
    const now = loadConfigAtCommit(root, cfg, tip);
    if (now.delivery.kind !== 'push-main') adapterFileAtCommit(root, cfg, tip, now.delivery.kind);
    assertEngine(now);
    kinds = { from: loadConfigAtCommit(root, cfg, pinned).delivery.kind, to: now.delivery.kind };
  } catch (error) {
    throw refuse(`not re-pinned: the adapter at ${repo.name}@${tip.slice(0, 10)} cannot be used: ${error.message.split('\n')[0]}`);
  }
  const changed = git(dir, ['diff', '--name-only', pinned, tip, '--', relative || '.']).split('\n').filter(Boolean);
  if (!changed.length) throw refuse(`not re-pinned: the adapter files at the tip of ${ref} (${tip.slice(0, 10)}) are the same as at the current pin ${pinned.slice(0, 10)}; nothing would change`, `commit and push the fixed adapter on ${repo.base} in ${repo.name} first (a fix only in the working tree, or committed but not pushed, is never read)`);
  const delivered = Object.fromEntries(Object.values(state.delivery.repos).map((d) => [d.repo, d.skipped ? `skipped (${d.skipped})` : `delivered ${String(d.commit ?? '').slice(0, 10)}`]));
  if (want.length < 7 || !tip.startsWith(want) || !reason) {
    const done = Object.entries(delivered).map(([n, v]) => `${n} ${v}`).join('; ') || 'nothing yet';
    const left = Object.keys(state.repos).filter((n) => !delivered[n]).join(', ');
    throw refuse(`not re-pinned${want && !tip.startsWith(want) ? `: ${want} is not the tip of ${ref} (${tip.slice(0, 10)})` : ''}${!reason ? ': --reason is required' : ''}. Re-pinning ${state.id}'s delivery adapter:\n  from: ${repo.name}@${pinned.slice(0, 10)} (delivery kind ${kinds.from})\n  to:   ${repo.name}@${tip.slice(0, 10)}, the tip of ${ref} (delivery kind ${kinds.to})\n  adapter files that differ: ${changed.join(', ') || 'none'}\n  recorded so far: ${done}\n  still to deliver: ${left}\n  the gate, the review and the tracker stay on the admission pin ${state.adapterBase.slice(0, 10)}`, `show this to the owner; once they confirm, \`wf deliver --repin-adapter ${tip.slice(0, 12)} --reason "<why>"\``);
  }
  append(root, state.id, 'adapter.repinned', { from: pinned, to: tip, ref, repo: repo.name, reason, changed, delivered, kinds }, actor(options));
  return loadState(root, state.id);
}

function sharedInfraTouched(repo, files) {
  return files.filter((f) => {
    const pkg = packageOf(repo, f);
    return pkg && matchesAny(pkg.path === '.' ? f : f.slice(pkg.path.length + 1), pkg.sharedInfra);
  });
}

// push-main: fast-forward the base branch. If the base moved, merge it in; reopen the gate only when the
// new base commits touch this change's files or shared infrastructure.
function pushMain(root, state, repo) {
  const r = state.repos[repo.name];
  const wt = r.worktree;
  const hasRemote = git(wt, ['remote']).split('\n').includes(repo.remote);
  if (!hasRemote) throw refuse(`repo ${repo.name} has no remote \`${repo.remote}\` to deliver to`);
  run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: wt });
  const remoteHead = git(wt, ['rev-parse', `${repo.remote}/${repo.base}`]);
  const ownBase = git(wt, ['merge-base', 'HEAD', remoteHead]);
  let mainAdvance = null;
  if (ownBase !== remoteHead) {
    const delta = git(wt, ['diff', '--name-only', ownBase, remoteHead]).split('\n').filter(Boolean);
    const mine = changedFiles(state, repo.name);
    const overlap = delta.filter((f) => mine.includes(f));
    const infra = sharedInfraTouched(repo, delta);
    const merge = run('git', ['merge', '--no-edit', '-m', `Merge ${repo.base} into ${branchName(state.id)}`, remoteHead], { cwd: wt, allowFail: true });
    if (merge.status !== 0) {
      run('git', ['merge', '--abort'], { cwd: wt, allowFail: true });
      throw refuse(`${repo.base} moved and conflicts with this change in ${repo.name}; resolve by merging ${repo.remote}/${repo.base} in the worktree, then rerun the gate`);
    }
    mainAdvance = { from: ownBase, to: remoteHead, delta: delta.length, overlap, infra };
    if (overlap.length || infra.length) {
      append(root, state.id, 'gate.reopened', { repo: repo.name, mainAdvance }, null);
      throw refuse(`${repo.base} moved and touches ${[...overlap, ...infra].slice(0, 5).join(', ')}${overlap.length + infra.length > 5 ? '…' : ''}; merged into the worktree. ${overlap.length ? 'The change itself moved: hand it to a fresh reviewer for the code review first, then `wf gate`, then the evidence review, before `wf deliver`' : 'Rerun `wf gate`, then `wf deliver`'}`);
    }
  }
  run('git', ['push', '--quiet', repo.remote, `HEAD:refs/heads/${repo.base}`], { cwd: wt });
  run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: wt });
  const head = git(wt, ['rev-parse', 'HEAD']);
  const onRemote = run('git', ['merge-base', '--is-ancestor', head, `${repo.remote}/${repo.base}`], { cwd: wt, allowFail: true }).status === 0;
  if (!onRemote) throw refuse(`pushed ${repo.name} but ${head.slice(0, 10)} is not on ${repo.remote}/${repo.base}`);
  return { repo: repo.name, commit: head, target: `${repo.remote}/${repo.base}`, mainAdvance, localBase: fastForwardLocalBase(root, state, repo) };
}

// Keeps the main checkout's base branch current after delivery, only when that is a safe fast-forward.
function fastForwardLocalBase(root, state, repo) {
  const dir = repoDir(root, repo);
  const target = `${repo.remote}/${repo.base}`;
  const local = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${repo.base}`], { allowFail: true });
  if (!local) return 'no local branch';
  if (run('git', ['merge-base', '--is-ancestor', local, target], { cwd: dir, allowFail: true }).status !== 0) return 'diverged; left as is';
  const current = git(dir, ['branch', '--show-current'], { allowFail: true });
  if (current === repo.base) {
    if (git(dir, ['status', '--porcelain', '--untracked-files=no'])) return 'checked out with local changes; left as is';
    return run('git', ['merge', '--ff-only', '--quiet', target], { cwd: dir, allowFail: true }).status === 0 ? 'fast-forwarded' : 'fast-forward failed';
  }
  return run('git', ['update-ref', `refs/heads/${repo.base}`, git(dir, ['rev-parse', target]), local], { cwd: dir, allowFail: true }).status === 0 ? 'fast-forwarded' : 'update failed';
}

export async function deliver(root, options) {
  let state = openState(root, options);
  const cfg = loadConfig(root);
  if (state.intent !== 'implementation') throw refuse(`${state.id} was admitted with intent \`${state.intent}\`; only implementation attempts deliver`);
  if (state.activeHold) throw refuse(`delivery is on hold: "${state.activeHold.reason}"`, 'lift it with `wf release` when the hold no longer applies');
  if (state.batchOf) throw refuse(`${state.id} is a member of ${state.batchOf}; deliver the batch instead`);
  if (!state.accepted) throw refuse('review not accepted: `wf accept`');
  // I-18: an issue found during the ticket ends fixed in it or deferred by the owner, never open at delivery.
  for (const x of [state, ...(state.batch?.members ?? []).map((m) => loadState(root, m))]) {
    const open = openDiscovered(x);
    if (open.length) throw refuse(`not delivered: ${open.length} discovered issue(s) are open${x.id !== state.id ? ` in ${x.id}` : ''}: ${open.map((d) => `${d.id} ${d.summary}`).join('; ')}`, `fix it in this ticket and close it with the fix commit (\`wf discovered close <id> --fixed <commit>\`; a fix after acceptance needs the gate and a fresh review), or, only on the owner's decision, \`wf discovered close <id> --deferred\` once the owner's message starts with \`defer ${x.id}:<id>\``);
  }
  // Every deferral counts only once the owner has seen it here and acknowledged it: no channel proves a person. It is
  // checked here and recorded after the pre-push checks; an acknowledgement recorded by an earlier try (one a later step
  // refused, or one that is still waiting for a merge, which is not a refusal) is accepted again, so the same command
  // is run again.
  let ackOwed = [];
  {
    const owed = unacknowledged(root, state, (m) => loadState(root, m));
    const given = typeof options['acknowledge-deferrals'] === 'string' ? options['acknowledge-deferrals'].split(',').map((x) => x.trim()).filter(Boolean) : [];
    const keys = new Set(owed.map((o) => o.key));
    // An id acknowledged by an earlier try is accepted again: after a later refusal (a push conflict, a failed adapter
    // readback) or a pending merge (exit 0, not a refusal), the same command is run again (review of 76ad8d8).
    const done = new Set(unacknowledged(root, state, (m) => loadState(root, m), { acknowledged: true }).map((o) => o.key));
    const stray = given.filter((g) => !keys.has(g) && !done.has(g));
    if (stray.length) throw refuse(`${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not a deferred issue of ${state.id} awaiting acknowledgement${owed.length ? ` (awaiting: ${[...keys].join(', ')})` : ''}`);
    const missing = owed.filter((o) => !given.includes(o.key));
    if (missing.length) {
      const list = owed.map((o) => `  - ${o.key}: ${o.d.summary}\n      owner's words: "${o.d.deferred.decision}"\n      channel: ${channelOf(o.d)}`).join('\n');
      throw refuse(`not delivered: ${owed.length} deferral(s) not acknowledged by the owner at delivery:\n${list}${given.length ? `\n  not acknowledged: ${missing.map((o) => o.key).join(', ')}` : ''}`, `show this list to the owner; once they confirm each is theirs, \`wf deliver --acknowledge-deferrals ${[...keys].join(',')}\` (anything they did not decide: reopen it with the fix instead)`);
    }
    ackOwed = owed;
  }
  if (state.batch) {
    for (const m of state.batch.members) {
      const ms = loadState(root, m);
      if (ms.activeHold) throw refuse(`batch member ${m} is on hold: "${ms.activeHold.reason}"`, `release it, or \`wf batch eject --batch ${state.id} --member ${m}\``);
      if (['abandoned', 'done'].includes(ms.phase)) throw refuse(`batch member ${m} is ${ms.phase}; eject it from ${state.id}`);
      if (ms.batchOf !== state.id) throw refuse(`${m} is no longer a member of ${state.id}`);
      for (const [n, head] of Object.entries(state.batch.heads?.[m] ?? {})) {
        if (git(ms.repos[n].worktree, ['rev-parse', 'HEAD']) !== head) throw refuse(`batch member ${m} changed in ${n} after it joined ${state.id}; eject and re-add it`);
      }
    }
  }
  if (state.deferHeavy && !state.batch) throw refuse(`${state.id} deferred its heavy steps to a batch; deliver it through \`wf batch create\``);
  if (state.phase === 'handoff-pending' || state.phase === 'done') throw refuse(`${state.id} is already delivered`);
  if (options['repin-adapter'] !== undefined) state = repinAdapter(root, cfg, state, options);
  if (typeof options['no-lesson'] === 'string' && options['no-lesson'].trim() && owesLesson(state)) {
    append(root, state.id, 'lesson.waived', { reason: options['no-lesson'].trim(), on: 'deliver' }, actor(options));
    state = loadState(root, state.id);
  }
  // The delivered comment carries the owner's plain-language summary; it is recorded before anything is pushed.
  if (options['summary-file'] && options['summary-file'] !== true) {
    if (state.batch) throw new WfError('a batch delivers no comment of its own: record each member\'s summary with `wf summary --file <f> --attempt <member>`');
    state = recordSummary(root, cfg, state, { ...options, actorId: actor(options) });
  }
  const unsummarised = (state.batch ? state.batch.members.map((m) => loadState(root, m)) : [state]).filter((x) => needsSummary(cfg, x) && !x.delivery.summary);
  if (unsummarised.length) throw refuse(`the delivered comment needs the owner's summary first: a few plain-language lines on what changed, for the person who tests it (the UAT scope, screenshots and known limits are added by \`wf\`)`, unsummarised.map((x) => (state.batch ? `\`wf summary --file <summary.md> --attempt ${x.id}\`` : `\`wf deliver --summary-file <summary.md>\` (or \`wf summary --file <summary.md>\` first)`)).join('; '));
  // A push that landed before the process died is recognised from the remote, not redone or refused. With a delivery
  // adapter, the adapter is asked again (I-20): ancestry alone is not its whole proof.
  const adapter = await loadDeliveryAdapter(root, cfg, state);
  for (const [name, r] of Object.entries(state.repos)) {
    if (state.delivery.repos[name] || !git(r.worktree, ['diff', '--name-only', r.base, 'HEAD'])) continue;
    const repo = cfg.repos.find((x) => x.name === name);
    const landed = onTarget(r, repo);
    if (!landed) continue;
    const head = landed.head;
    // Only the exact commit that was accepted and gated counts as a recovered delivery.
    if (head !== state.accepted.heads?.[name] || head !== state.lastGate?.tree?.[name]) {
      throw refuse(`${name}: ${head.slice(0, 10)} is already on ${repo.remote}/${repo.base} but is not the accepted, gated commit; it was pushed outside wf`, 'review and gate the pushed change in a new attempt (`wf reopen`)');
    }
    if (!adapter) {
      append(root, state.id, 'repo.delivered', { repo: name, commit: head, target: landed.target, recovered: true }, actor(options));
      continue;
    }
    const last = state.delivery.integrating[name] ?? null;
    const integrated = last ? Object.fromEntries(Object.entries(last).filter(([k]) => !['repo', 'observed', 'at'].includes(k))) : {};
    const ctx = { root, repo, worktree: r.worktree, attempt: state.id, item: state.item, branch: branchName(state.id) };
    let observed;
    try {
      observed = await adapter.observe({ ...ctx, ...integrated });
    } catch (error) {
      observed = { state: null, evidence: `observe failed: ${String(error?.message ?? error).split('\n')[0]}` };
    }
    if (observed?.state === 'integrated') {
      const rb = await adapter.readback({ ...ctx, ...integrated });
      if (!rb.ok) throw refuse(`${name}: readback failed: ${rb.reason ?? 'change not on the target branch'}`);
      append(root, state.id, 'repo.delivered', { repo: name, commit: head, target: landed.target, ...integrated, ...rb, recovered: true, adapterState: 'integrated' }, actor(options));
      continue;
    }
    append(root, state.id, 'repo.integrating', { repo: name, ...integrated, observed, onTarget: landed.target }, actor(options));
    if (PENDING.includes(observed?.state)) return { state: loadState(root, state.id), waiting: { repo: name, ...observed, url: integrated.url, onTarget: landed.target } };
    append(root, state.id, 'repo.delivered', { ...postMerge(options, name, landed, observed, integrated), recovered: true }, actor(options));
  }
  state = loadState(root, state.id);
  // Repos already delivered are on the target branch; compare only what is still to deliver.
  const now = patchIds(state);
  const changedAfter = Object.keys(state.repos).filter((r) => !state.delivery.repos[r] && now[r] !== state.accepted.patch[r]);
  if (changedAfter.length) throw refuse(`the change was modified after acceptance (${changedAfter.join(', ')}); gate and review it again`);
  const g = gatePassedForCurrentTree(state);
  if (!g.ok) throw refuse(`delivery needs a passing gate on the current code: ${g.reason}`);
  // Right before anything is pushed: nothing verified at open has changed since (members of a batch too).
  for (const id of [state.id, ...(state.batch?.members ?? [])]) {
    if (id !== state.id) openEvidence(root, id);
    const moved = assertUnchanged(root, id);
    if (moved.length) throw refuse(`not delivered: the evidence of ${id} changed while it was checked:\n  - ${moved.slice(0, 10).join('\n  - ')}`);
  }
  if (ackOwed.length) {
    const byAttempt = new Map();
    for (const o of ackOwed) byAttempt.set(o.attempt, [...(byAttempt.get(o.attempt) ?? []), o.d.id]);
    for (const [aid, ids] of byAttempt) append(root, aid, 'discovered.acknowledged', { ids }, actor(options));
    state = loadState(root, state.id);
  }
  const order = deliveryOrder(cfg, Object.keys(state.repos));
  for (const name of order) {
    if (state.delivery.repos[name]) continue;
    if (changedFiles(state, name).length === 0) {
      append(root, state.id, 'repo.delivered', { repo: name, commit: null, skipped: 'no changes' }, actor(options));
      continue;
    }
    const repo = cfg.repos.find((r) => r.name === name);
    let result;
    if (!adapter) {
      const before = treeHashes(state);
      result = pushMain(root, state, repo);
      if (result.mainAdvance) {
        // Base moved without touching this change: carry the gate result to the merged tree.
        const tree = treeHashes(loadState(root, state.id));
        append(root, state.id, 'gate.finished', { ...state.lastGate, runId: `${state.lastGate.runId}+carried`, carriedFrom: state.lastGate.runId, tree, previousTree: before, mainAdvance: result.mainAdvance }, null);
      }
    } else {
      const ctx = { root, repo, worktree: state.repos[name].worktree, attempt: state.id, item: state.item, branch: branchName(state.id) };
      const integrated = await adapter.integrate(ctx);
      const observed = await adapter.observe({ ...ctx, ...integrated });
      if (observed?.state !== 'integrated') {
        append(root, state.id, 'repo.integrating', { repo: name, ...integrated, observed }, actor(options));
        // I-20: an adapter that pushed straight to the target branch and then reports anything but a pending state is a
        // post-merge state: shown, and counted only with the owner's acknowledgement.
        const landed = PENDING.includes(observed?.state) ? null : onTarget(state.repos[name], repo);
        if (landed && (landed.head !== state.accepted.heads?.[name] || landed.head !== state.lastGate?.tree?.[name])) throw refuse(`${name}: ${landed.head.slice(0, 10)} is on ${landed.target} but is not the accepted, gated commit`);
        if (landed) result = postMerge(options, name, landed, observed, integrated);
        else {
          // Named failure (0.4.5, delta reviews of 40da633 and b28681a): every state but `integrated` took the waiting path,
          // so a rejected delivery, a failed CI, a typo or no state at all exited 0 and read as success. Only a pending state
          // (`awaiting-merge`, `ci-running`) waits; `rejected` and `ci-failed` refuse with what to do; anything else refuses
          // as an adapter that does not report a documented state (docs/DESIGN.md).
          if (!PENDING.includes(observed?.state) && !['rejected', 'ci-failed'].includes(observed?.state)) throw refuse(`not delivered: ${name}: the delivery adapter reported ${describeState(observed)}; it must report one of ${ADAPTER_STATES.join(', ')}`, `this attempt reads its delivery adapter as committed at ${deliveryPin(state).slice(0, 10)}, so a fix committed on the base branch does not reach it by itself. Once the fixed adapter is committed and pushed on the base branch, the owner re-pins this attempt's delivery adapter to it: \`wf deliver --repin-adapter --reason "<why>"\` shows what changes and asks for the owner's confirmation (docs/lifecycle.md, "Recovering from an adapter fault")`);
          if (observed.state === 'rejected' || observed.state === 'ci-failed') throw refuse(`not delivered: ${name}: the delivery adapter reports ${observed.state}${integrated.url ? ` (${integrated.url})` : ''}${observed.evidence ? `: ${observed.evidence}` : ''}`, observed.state === 'rejected' ? 'the change was rejected where it is integrated: find out why, fix it through the implementer (a new gate and review follow), or abandon the attempt; then `wf deliver` again' : 'its CI failed where it is integrated: read that CI run, fix the cause through the implementer, gate it, then `wf deliver` again');
          if (!state.tracker.done.some((d) => d.event === 'integrating')) emitTrackerEvent(root, cfg, state.id, 'integrating', { url: integrated.url ?? '' });
          return { state: loadState(root, state.id), waiting: { repo: name, ...observed, url: integrated.url } };
        }
      } else {
        const rb = await adapter.readback({ ...ctx, ...integrated });
        if (!rb.ok) throw refuse(`${name}: readback failed: ${rb.reason ?? 'change not on the target branch'}`);
        result = { repo: name, commit: git(state.repos[name].worktree, ['rev-parse', 'HEAD']), target: `${repo.remote}/${repo.base}`, ...integrated, ...rb, adapterState: 'integrated' };
      }
    }
    append(root, state.id, 'repo.delivered', result, actor(options));
    state = loadState(root, state.id);
  }
  append(root, state.id, 'delivered', { order }, actor(options));
  state = loadState(root, state.id);
  finishDelivered(root, cfg, state);
  if (state.batch) {
    for (const member of state.batch.members) {
      append(root, member, 'batch.member.delivered', { batch: state.id }, actor(options));
      finishDelivered(root, cfg, loadState(root, member));
    }
  }
  return { state: loadState(root, state.id) };
}

// ---- Delivered screenshots: shown to the owner in the chat, attached to the ticket as uploaded files ----
// Named failure: the owner session was told only "show the user every delivered screenshot", so whether the owner saw
// them, and what each one showed, existed nowhere; a link attachment or an earlier attempt's file with the same name
// passed the attachment check. The delivered set, each caption and the owner's acknowledgement are now in the ledger.

const stem = (file) => path.posix.basename(String(file)).replace(/\.[^.]+$/, '');

// A starting caption: the file name in words (sequence prefixes and the ticket id dropped), plus each criterion whose
// screenshot evidence is this file or whose text names it. The owner refines it after viewing the image.
export function proposeCaption(state, a) {
  const name = stem(a.source ?? a.path);
  const item = String(state.item ?? '').toLowerCase();
  let words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  if (item) words = words.split(item).join(' ');
  words = words.replace(/^([\d]+[-_. ]+)+/, '').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
  words = words.charAt(0).toUpperCase() + words.slice(1);
  const refs = new Set([a.sha256, a.source, a.path].filter(Boolean));
  const byEvidence = (state.review?.closure?.criteria ?? []).filter((c) => c.evidence?.kind === 'screenshot' && refs.has(String(c.evidence.ref ?? '').trim())).map((c) => c.id);
  const named = (state.criteria ?? []).filter((c) => `${c.text ?? ''} ${typeof c.uat === 'string' ? c.uat : ''}`.includes(name)).map((c) => c.id);
  const ids = [...new Set([...byEvidence, ...named])];
  const shows = ids.map((id) => state.criteria?.find((c) => c.id === id)).filter(Boolean).map((c) => `${c.id}: ${typeof c.uat === 'string' ? c.uat : c.text}`);
  return shows.length ? `${words} (shows ${shows.join('; ')})` : words;
}

// What this attempt delivers: its own gate's screenshots and, for a batch member, the batch gate's files that belong
// to it (never another member's). Each gets the attachment title (the file name; the source path when two share a
// name) and a proposed caption. A batch delivers nothing itself: each member shows and attaches its own.
export function deliveredSet(root, state) {
  if (state.lane === 'batch') return [];
  const mine = (a) => !a.units || a.units.includes(state.id);
  const batch = state.delivery.viaBatch ? loadState(root, state.delivery.viaBatch) : null;
  const seen = new Set();
  const files = [...screenshots(state), ...(batch ? screenshots(batch) : [])].filter(mine).filter((a) => !seen.has(a.sha256) && seen.add(a.sha256));
  const base = (a) => path.posix.basename(a.source ?? a.path);
  const count = {};
  for (const a of files) count[base(a)] = (count[base(a)] ?? 0) + 1;
  return files.map((a) => ({ path: a.path, sha256: a.sha256, source: a.source ?? null, title: count[base(a)] > 1 ? String(a.source ?? a.path).replace(/^\/+/, '').replace(/\//g, '-') : base(a), proposed: proposeCaption(state, a) }));
}

// Why an attempt delivers no screenshots, per step, from the gate's expanded globs and the reviewer's verdicts.
export function noScreenshotsReason(root, state) {
  const src = state.delivery.viaBatch ? loadState(root, state.delivery.viaBatch) : state;
  const steps = evidenceSteps(root, src);
  if (!steps.length) return 'no gate step declares `artifacts`, so the gate collected no screenshots';
  const verdicts = [...(state.accepted?.noEvidence ?? []), ...(src.accepted?.noEvidence ?? [])];
  return steps.map((st) => {
    const v = verdicts.find((x) => x.step === st.step);
    if (v?.reason) return `${st.step}: ${v.reason} (reviewer's verdict)`;
    if (v?.finding) return `${st.step}: no capture (reviewer's finding ${v.finding})`;
    const where = st.globs.flatMap((g) => g.expanded).join(', ');
    return `${st.step}: its globs (${where}) matched no screenshot of this ticket${st.changedHere.length ? '' : ' and its package did not change'}`;
  }).join('; ');
}

// Outside the evidence: the owner edits it (captions, anomalies) and passes it to `wf shown`.
export const shownDraftFile = (root, id) => path.join(root, '.wf-worktrees', '_exports', id, 'shown-draft.json');

// The owner still has to show the delivered screenshots and record it (`wf shown`). An attempt delivered before
// 0.1.11 has no recorded set and owes nothing.
export const needsShown = (state) => Boolean(state.delivery.screenshots?.screenshots?.length) && !state.delivery.shown;

// The draft `wf shown` starts from, with viewable copies: the delivered set is exported when it is recorded.
function writeDraft(root, state, draft) {
  let copies = [];
  try {
    copies = exportScreenshots(root, state).files;
  } catch (error) {
    process.stderr.write(`wf: delivered screenshots not exported: ${error.message}\n`);
  }
  try {
    safeWriteJson(root, shownDraftFile(root, state.id), { ...draft, screenshots: draft.screenshots.map((x) => ({ ...x, file: copies.find((c) => c.sha256 === x.sha256)?.file ?? null })) });
  } catch (error) {
    process.stderr.write(`wf: the \`wf shown\` draft was not written: ${error.message}\n`);
  }
}

// Every file the engine writes outside the evidence where an agent could have planted a link (the shown draft, the
// prior-findings reveal). Named finding (0.1.18 review): the draft was written with a plain write that follows
// symlinks, so a symlinked `_exports/<id>` folder or draft file sent it into the evidence. The parent is checked where
// it really points before and after it is created; an existing entry is replaced only when it is a regular file; the
// file is created exclusively without following a link and written through its descriptor.
export function safeWrite(root, file, content) {
  const parent = path.dirname(path.resolve(file));
  const refused = `${file}: not written; its folder really lies in .wf-evidence/ (a symlink?)`;
  if (underEvidence(root, parent)) throw refuse(refused);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (underEvidence(root, parentReal)) throw refuse(refused);
  const there = fs.lstatSync(file, { throwIfNoEntry: false });
  if (there && !there.isFile()) throw refuse(`${file}: exists and is ${there.isSymbolicLink() ? 'a symlink' : 'not a regular file'}; not followed or replaced`);
  if (there) fs.unlinkSync(file);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.realpathSync(parent) !== parentReal) {
    fs.rmSync(path.join(parentReal, path.basename(file)), { force: true });
    throw refuse(`${file}: its folder moved while it was written; removed`);
  }
  return file;
}
export const safeWriteJson = (root, file, value) => safeWrite(root, file, `${JSON.stringify(value, null, 2)}\n`);

function finishDelivered(root, cfg, state) {
  if (state.lane !== 'batch') {
    const set = deliveredSet(root, state);
    const none = set.length ? null : noScreenshotsReason(root, state);
    append(root, state.id, 'delivery.screenshots', { screenshots: set, none }, null);
    // Nothing to show: the statement of why is the record, no acknowledgement of images is owed.
    if (!set.length) append(root, state.id, 'delivery.shown', { screenshots: [], none, auto: true }, null);
    else writeDraft(root, loadState(root, state.id), { attempt: state.id, item: state.item, note: 'Edit this file in place (it is outside the evidence): view each image (the `file` copy, with the Read tool), replace each caption with what the image shows (which screen, which state), set `anomalies` ("none seen", or each value that differs between captures of the same state or contradicts a criterion, with its investigated cause or a follow-up), then `wf shown --file <this file>`.', anomalies: null, screenshots: set.map((f) => ({ sha256: f.sha256, title: f.title, path: f.path, proposed: f.proposed, caption: f.proposed })) });
    state = loadState(root, state.id);
  }
  const set = state.delivery.screenshots?.screenshots ?? [];
  const actions = state.lane === 'quick' || state.lane === 'batch' ? [] : emitTrackerEvent(root, cfg, state.id, 'delivered', { screenshots: set });
  if (actions.some((a) => a.rendered === 'delivered')) writeDeliveredComment(root, cfg, loadState(root, state.id));
  if (!actions.length && !needsShown(state) && !owesLesson(loadState(root, state.id))) {
    append(root, state.id, 'closed', { reason: cfg.tracker.kind === 'none' || state.lane !== 'standard' ? 'no tracker handoff for this lane' : 'no tracker actions configured' }, null);
    closeExport(root, loadState(root, state.id));
    cleanupWorktrees(root, loadState(root, state.id));
  }
}

// ---- Delivered screenshots stay viewable after close ----
// Named failure: at close the worktree was removed and the evidence guard refused the owner's copy out of
// .wf-evidence, so the delivered screenshots could not be shown again. `wf export screenshots` copies the delivered
// (kept) set, each named by its attachment title and checked against its sha256, to a folder outside the evidence;
// closing an attempt does it once to the default folder.
export const screenshotsExportDir = (root, id) => path.join(root, '.wf-worktrees', '_exports', id);

export function deliveredFiles(state) {
  if (state.delivery.screenshots) return state.delivery.screenshots.screenshots;
  const attach = state.tracker.pending.find((a) => a.event === 'delivered' && a.op === 'attach') ?? null;
  return (attach?.files ?? []).map((f) => ({ ...f, title: f.title ?? path.basename(f.path) }));
}

// One answer for every caller (engine/paths.mjs): any project's evidence, as written or as the OS resolves it, or below
// this project's evidence root.
const underEvidence = (root, p) => touchesEvidence(p) || isInside(p, evidenceRoot(root));

// An attachment title as a plain file name: never a path, never `.`/`..`, no control characters.
export function safeFileName(title) {
  const name = String(title ?? '').replace(/[\\/]/g, '-').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return !name || /^\.+$/.test(name) ? null : name;
}

// What the gate collected for the reviewer (one file per sha256), titled as the delivered set is titled.
export function gateFiles(state) {
  const seen = new Set();
  const files = screenshots(state).filter((a) => !seen.has(a.sha256) && seen.add(a.sha256));
  const base = (a) => path.posix.basename(a.source ?? a.path);
  const count = {};
  for (const a of files) count[base(a)] = (count[base(a)] ?? 0) + 1;
  return files.map((a) => ({ path: a.path, sha256: a.sha256, title: count[base(a)] > 1 ? String(a.source ?? a.path).replace(/^\/+/, '').replace(/\//g, '-') : base(a) }));
}

// Test seams: called just before a source is opened and just before a destination is created.
export const exportSeams = { beforeSourceOpen: null, beforeDestOpen: null };

// Copies out of the evidence are made by this process, never by a shell. Named failures (0.1.16/0.1.17 security
// reviews): the destination was checked as text only, then checked and written in separate steps, so a `--to` symlink
// into .wf-evidence/, a symlink planted or swapped in under a file name, or a swapped source could make the copy
// write into the evidence. Now: a fresh directory is created exclusively (mkdtemp) under the export root, and its real
// location is checked after creation; each source is opened without following a symlink, read once, and its sha256
// checked on the bytes that are written; each destination is created exclusively without following a symlink and
// written through its descriptor; the directory's identity is checked before every file and at the end.
export function exportScreenshots(root, state, to = null, { gate = false } = {}) {
  const files = gate ? gateFiles(state) : deliveredFiles(state);
  if (!files.length) throw refuse(gate ? `the last gate of ${state.id} collected no screenshots` : `no delivered screenshots for ${state.item}${state.delivery.screenshots?.none ? `: ${state.delivery.screenshots.none}` : state.delivery.completedAt ? '' : ' (not delivered yet)'}`);
  const parent = canonicalPath(String(to ?? screenshotsExportDir(root, state.id)));
  const outside = 'export outside .wf-evidence/ (checked where the folder really points): the evidence is written only by `wf`';
  if (underEvidence(root, parent)) throw refuse(outside);
  const names = new Map();
  const problems = [];
  for (const f of files) {
    const name = safeFileName(path.basename(String(f.title ?? '').replace(/\\/g, '/')) || f.title);
    if (!name) problems.push(`${JSON.stringify(f.title)}: not a usable file name`);
    else if (names.has(name)) problems.push(`${f.title} and ${names.get(name).title} would both be written as ${name}`);
    else names.set(name, f);
  }
  if (problems.length) throw refuse(`screenshots not exported:\n  - ${problems.join('\n  - ')}`);
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, `${gate ? 'gate' : 'screenshots'}-`));
  const dirReal = fs.realpathSync.native(dir);
  if (underEvidence(root, dir) || underEvidence(root, dirReal) || isInside(dir, attemptDir(root, state.id))) {
    fs.rmdirSync(dir);
    throw refuse(outside);
  }
  const ident = fs.lstatSync(dir);
  const same = () => {
    const now = fs.lstatSync(dir, { throwIfNoEntry: false });
    return Boolean(now && now.isDirectory() && !now.isSymbolicLink() && now.dev === ident.dev && now.ino === ident.ino && fs.realpathSync(dir) === dirReal);
  };
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const out = [];
  for (const [name, f] of names) {
    exportSeams.beforeSourceOpen?.(f.path);
    let bytes;
    try {
      bytes = readEvidenceFile(root, state.id, f).bytes;
    } catch (error) {
      problems.push(error.code === 'ESHA' ? `${f.title}: bytes differ from the recorded sha256 (${f.path})` : `${f.title}: source not readable as a regular file (${error.code ?? error.message}): ${error.message}`);
      continue;
    }
    const dest = path.join(dir, name);
    exportSeams.beforeDestOpen?.(dest, dir);
    if (!same()) {
      problems.push(`${dir}: the export folder was replaced or moved during the export; nothing more written`);
      break;
    }
    let fd;
    try {
      fd = fs.openSync(dest, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    } catch (error) {
      problems.push(`${dest}: not created (${error.code ?? error.message}); an existing file or link is never followed or replaced`);
      continue;
    }
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    out.push({ title: f.title, sha256: f.sha256, file: dest });
  }
  if (!same()) problems.push(`${dir}: the export folder was replaced or moved during the export`);
  if (problems.length) throw refuse(`screenshots not exported:\n  - ${problems.join('\n  - ')}`);
  if (!gate) append(root, state.id, 'screenshots.exported', { dir, files: out }, null);
  return { dir, files: out };
}

function closeExport(root, state) {
  const files = deliveredFiles(state);
  if (!files.length) return;
  const have = new Set((state.delivery.exported?.files ?? []).filter((f) => fs.existsSync(f.file)).map((f) => f.sha256));
  if (files.every((f) => have.has(f.sha256))) return;
  try {
    exportScreenshots(root, state);
  } catch (error) {
    process.stderr.write(`wf: delivered screenshots not exported at close: ${error.message}\n`);
  }
}

// `wf shown --file f`: the owner session showed every delivered screenshot in the chat and records the caption it gave
// each. Every file of the delivered set needs an entry with a caption the owner wrote after viewing it (the engine's
// proposal, from the file name, says nothing about the state shown, so it is refused unchanged); nothing else may be
// listed. Kept write-once; the tracker attachments carry these captions as their subtitles.
export function recordShown(root, options) {
  const state = openState(root, options);
  if (!state.delivery.completedAt) throw refuse('not delivered yet: `wf deliver` first');
  const set = state.delivery.screenshots;
  if (!set) throw refuse(`${state.id} was delivered before screenshots were recorded at delivery; nothing to acknowledge`);
  if (!set.screenshots.length) throw refuse(`no screenshots were delivered for ${state.item}; the statement is already recorded: ${set.none}`);
  if (state.tracker.done.some((d) => d.event === 'delivered')) throw refuse('the delivered handoff is already verified with the recorded captions');
  if (!options.file || options.file === true) throw new WfError('--file <shown.json> is required: { "screenshots": [{ "sha256", "caption" }] } (the draft `wf deliver` wrote is a starting point)');
  const text = fs.readFileSync(path.resolve(String(options.file)), 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WfError(`${options.file} is not JSON: ${error.message}`);
  }
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.screenshots) ? raw.screenshots : [];
  const match = (e, f) => e && (e.sha256 === f.sha256 || (!e.sha256 && e.title === f.title));
  const problems = [];
  const shown = [];
  for (const f of set.screenshots) {
    const e = entries.find((x) => match(x, f));
    const caption = String(e?.caption ?? '').trim();
    if (!e) problems.push(`${f.title} (${f.path}): not acknowledged; show it and give its caption`);
    else if (!caption) problems.push(`${f.title}: no caption; say which screen and state it shows`);
    else if (caption === f.proposed.trim()) problems.push(`${f.title}: the caption is the engine's proposal unchanged ("${f.proposed}"); view the image and say which screen and state it shows`);
    else shown.push({ sha256: f.sha256, title: f.title, source: f.source, caption, proposed: f.proposed });
  }
  for (const e of entries) if (!set.screenshots.some((f) => match(e, f))) problems.push(`${e?.sha256 ?? e?.title ?? JSON.stringify(e)}: not in the delivered set`);
  const anomalies = shownAnomalies(raw, set.screenshots, problems);
  if (problems.length) throw refuse(`screenshots not acknowledged:\n  - ${problems.join('\n  - ')}`);
  const n = (state.delivery.shownRecords ?? 0) + 1;
  const kept = keepRaw(root, state.id, `delivery/shown-${n}.raw.json`, text);
  append(root, state.id, 'delivery.shown', { screenshots: shown, none: null, anomalies, raw: { path: kept.file, sha256: kept.sha256 } }, actor(options));
  const after = loadState(root, state.id);
  try {
    writeDeliveredComment(root, loadConfig(root), after);
  } catch {}
  return after;
}

// Anomalies seen while viewing the delivered screenshots. Named failure: an owner called "3 active accounts in the
// French capture vs 1 in English" cosmetic without checking; test data had leaked between runs. Any value that differs
// between captures of the same state (counts, dates, names), or contradicts a criterion, is recorded with its cause
// (investigated; "cosmetic" needs evidence) or a follow-up. The key is required: `"anomalies": "none seen"` (or []) says
// the owner looked and saw none.
export function shownAnomalies(raw, set, problems) {
  const v = Array.isArray(raw) ? undefined : raw?.anomalies;
  const hint = 'add `"anomalies": "none seen"`, or `[{ "screenshots": [<title or sha256>], "observation": "<what differs>", "cause": "<investigated cause, with evidence>" | "followUp": "<follow-up filed>" }]`';
  if (v === undefined || v === null) {
    problems.push(`no \`anomalies\` key: while viewing the screenshots, compare values between captures of the same state (counts, dates, names) and against the criteria; ${hint}`);
    return [];
  }
  if (typeof v === 'string') {
    if (/^\s*none seen\s*\.?\s*$/i.test(v)) return [];
    problems.push(`\`anomalies\` must be "none seen" or a list; ${hint}`);
    return [];
  }
  if (!Array.isArray(v)) {
    problems.push(`\`anomalies\` must be "none seen" or a list; ${hint}`);
    return [];
  }
  const out = [];
  for (const [i, a] of v.entries()) {
    const label = `anomaly ${i + 1}`;
    const shots = Array.isArray(a?.screenshots) ? a.screenshots.map(String) : a?.screenshots ? [String(a.screenshots)] : [];
    const unknown = shots.filter((x) => !set.some((f) => f.sha256 === x || f.title === x));
    const observation = String(a?.observation ?? '').trim();
    const cause = String(a?.cause ?? '').trim();
    const followUp = String(a?.followUp ?? '').trim();
    if (!shots.length) problems.push(`${label}: name the screenshot(s) it was seen in (\`screenshots\`: titles or sha256)`);
    else if (unknown.length) problems.push(`${label}: ${unknown.join(', ')} not in the delivered set`);
    if (!observation) problems.push(`${label}: \`observation\` says what differs or contradicts a criterion`);
    if (!cause && !followUp) problems.push(`${label}: investigate it to a \`cause\`, or record a \`followUp\`; an anomaly is never left unexplained`);
    if (cause && /cosmetic/i.test(cause) && !String(a?.evidence ?? '').trim()) problems.push(`${label}: "cosmetic" needs \`evidence\` (what you checked that shows the values are right)`);
    out.push({ screenshots: shots, observation, cause: cause || null, followUp: followUp || null, evidence: a?.evidence ? String(a.evidence) : null });
  }
  return out;
}

// `wf delivery narrow --keep <sha256,...> | --file keep.json --reason "why"`: an over-broad `artifacts` glob put
// files of other tickets into the delivered set, and `wf shown` and the tracker readback require every one of them.
// Named failure: a delivered set of 1,320 files, 8 of them the ticket's, could only be finished by uploading the other
// 1,312 or by editing the hash-chained ledger. The owner keeps a subset, once, with a reason, after delivery and before
// the screenshots are acknowledged; the ledger records what was kept and how many were dropped, and the set and the
// pending attach action both derive from it on every replay.
function keepList(options) {
  if (options.keep && options.keep !== true) return String(options.keep).split(',').map((x) => x.trim()).filter(Boolean);
  if (!options.file || options.file === true) throw new WfError('--keep <sha256,...> or --file <keep.json> is required ({ "keep": [sha256...] }, a list of sha256, or { "screenshots": [{ "sha256" }] })');
  const text = fs.readFileSync(path.resolve(String(options.file)), 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WfError(`${options.file} is not JSON: ${error.message}`);
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.keep) ? raw.keep : Array.isArray(raw?.screenshots) ? raw.screenshots : null;
  if (!list) throw new WfError(`${options.file}: expected { "keep": [sha256...] }, a list of sha256, or { "screenshots": [{ "sha256" }] }`);
  return { keep: list.map((x) => String(typeof x === 'string' ? x : x?.sha256 ?? '').trim()).filter(Boolean), text };
}

// The set to narrow: the recorded delivered set, or, for an attempt delivered before 0.1.11 (no recorded set, no
// captions, attachments checked by title only), the pending `delivered` attach action's files.
function narrowSource(state) {
  const set = state.delivery.screenshots;
  if (set) return set.screenshots.length ? { files: set.screenshots, legacy: false } : null;
  const attach = state.tracker.pending.find((a) => a.event === 'delivered' && a.op === 'attach');
  return attach?.files?.length ? { files: attach.files, legacy: true } : null;
}

export function narrowDelivery(root, options) {
  const state = openState(root, options);
  const reason = String(options.reason ?? '').trim();
  if (!reason || options.reason === true) throw new WfError('--reason "<why the other files are not this ticket\'s>" is required');
  if (!state.delivery.completedAt) throw refuse('not delivered yet: `wf deliver` first');
  if (state.phase !== 'handoff-pending') throw refuse(`${state.id} is ${state.phase}; a delivered set can be narrowed only while the handoff is pending`);
  if (state.delivery.narrowed) throw refuse(`the delivered set was already narrowed (${state.delivery.narrowed.from} to ${state.delivery.narrowed.to}: ${state.delivery.narrowed.reason}); it is narrowed once`);
  if (state.delivery.shown && !state.delivery.shown.auto) throw refuse('the delivered screenshots are already acknowledged with `wf shown`; the set can no longer change');
  if (state.tracker.done.some((d) => d.event === 'delivered')) throw refuse('the delivered handoff is already verified');
  const source = narrowSource(state);
  if (!source) throw refuse(state.delivery.screenshots ? `no screenshots were delivered for ${state.item}; nothing to narrow` : `${state.id} has no recorded delivered set and no pending \`delivered\` attach action; nothing to narrow`);
  const parsed = keepList(options);
  const given = Array.isArray(parsed) ? parsed : parsed.keep;
  const keep = [...new Set(given)];
  if (!keep.length) throw refuse('keep at least one file: a delivery with no screenshots of its own is a different statement, not a narrowing');
  const unknown = keep.filter((k) => !source.files.some((f) => f.sha256 === k));
  if (unknown.length) throw refuse(`${unknown.length} kept sha256 not in the delivered set (full 64-character sha256 from \`wf status --json\` → ${source.legacy ? 'tracker.pending, the delivered attach action\'s files' : 'delivery.screenshots'}):\n  - ${unknown.join('\n  - ')}`);
  const from = source.files.length;
  const kept = keptFiles(source.files, keep);
  if (kept.length === from) throw refuse(`all ${from} delivered files are kept; nothing to narrow`);
  const plan = { keep, from, to: kept.length, dropped: from - kept.length, reason, legacy: source.legacy, kept: kept.map((f) => ({ sha256: f.sha256, title: f.title ?? path.basename(f.path), path: f.path })) };
  if (options['dry-run']) return { state, dryRun: plan };
  const raw = Array.isArray(parsed) ? null : keepRaw(root, state.id, 'delivery/narrow.raw.json', parsed.text);
  append(root, state.id, 'delivery.narrowed', { keep, from, to: kept.length, dropped: from - kept.length, reason, legacy: source.legacy, raw: raw ? { path: raw.file, sha256: raw.sha256 } : null }, actor(options));
  const after = loadState(root, state.id);
  // A legacy attempt has no draft and owes no `wf shown`: its kept uploads are checked by title only, as before.
  if (!source.legacy) writeDraft(root, after, { attempt: state.id, item: state.item, note: 'Edit this file in place (it is outside the evidence): view each image (the `file` copy, with the Read tool), replace each caption with what the image shows (which screen, which state), set `anomalies` ("none seen", or each value that differs between captures of the same state or contradicts a criterion, with its investigated cause or a follow-up), then `wf shown --file <this file>`.', anomalies: null, screenshots: after.delivery.screenshots.screenshots.map((f) => ({ sha256: f.sha256, title: f.title, path: f.path, proposed: f.proposed, caption: f.proposed })) });
  return { state: after, dryRun: null };
}

export function closeAfterHandoff(root, state) {
  if (state.phase === 'handoff-pending' && !state.tracker.pending.length && !needsShown(state) && !owesLesson(state)) {
    append(root, state.id, 'closed', { reason: state.tracker.done.some((d) => d.event === 'delivered') ? 'tracker handoff verified' : 'delivered screenshots shown' }, null);
    closeExport(root, loadState(root, state.id));
    cleanupWorktrees(root, loadState(root, state.id));
  }
  return loadState(root, state.id);
}

export function reopen(root, options) {
  if (!options.item || !options.reason) throw new WfError('--item and --reason are required');
  const delivered = listAttempts(root)
    .map((id) => loadState(root, id))
    .filter((s) => s.item === String(options.item) && s.delivery.completedAt)
    .at(-1);
  if (!delivered) throw refuse(`${options.item} has no delivered attempt to reopen`);
  const s = entry(root, { ...options, lane: delivered.lane === 'quick' ? 'quick' : 'standard', repos: Object.keys(delivered.repos).join(','), reopenedFrom: delivered.id });
  append(root, s.id, 'reopen.reason', { reason: String(options.reason), from: delivered.id }, actor(options));
  if (typeof options['no-lesson'] === 'string' && options['no-lesson'].trim()) append(root, s.id, 'lesson.waived', { reason: options['no-lesson'].trim(), on: 'reopen' }, actor(options));
  const cfg = loadConfig(root);
  if (s.lane !== 'quick') emitTrackerEvent(root, cfg, s.id, 'reopened');
  return loadState(root, s.id);
}

export function batchCreate(root, options) {
  const cfg = loadConfig(root);
  if (!cfg.lanes.includes('batch')) throw refuse('the batch lane is not enabled for this project');
  const members = String(options.members ?? '').split(',').filter(Boolean).map((m) => assertSafeId(m, 'attempt id'));
  if (members.length < 2) throw new WfError('--members needs at least two attempt ids');
  const states = members.map((m) => loadState(root, m));
  for (const s of states) {
    if (!s.deferHeavy) throw refuse(`${s.id} was not admitted with --defer-heavy, so its heavy steps already ran or must run alone`);
    if (!s.accepted) throw refuse(`${s.id} is not accepted yet`);
    if (s.batchOf) throw refuse(`${s.id} is already in ${s.batchOf}`);
    if (s.activeHold) throw refuse(`${s.id} is on hold: "${s.activeHold.reason}"`);
    if (['abandoned', 'done', 'handoff-pending'].includes(s.phase)) throw refuse(`${s.id} is ${s.phase}`);
  }
  const n = listAttempts(root).filter((id) => /^BATCH-\d+/.test(id)).length + 1;
  const id = options.id ?? `BATCH-${n}`;
  const repos = [...new Set(states.flatMap((s) => Object.keys(s.repos)))];
  const b = entry(root, { ...options, id, item: id, lane: 'batch', repos: repos.join(','), intent: 'implementation' });
  for (const s of states) {
    for (const name of Object.keys(s.repos)) {
      const merge = run('git', ['merge', '--no-edit', '-m', `Batch ${id}: merge ${s.id}`, branchName(s.id)], { cwd: worktreeDir(root, id, name), allowFail: true });
      if (merge.status !== 0) {
        run('git', ['merge', '--abort'], { cwd: worktreeDir(root, id, name), allowFail: true });
        throw refuse(`${s.id} conflicts with earlier batch members in ${name}; eject it or resolve in its own attempt`);
      }
    }
    append(root, s.id, 'batch.joined', { batch: id }, actor(options));
  }
  const heads = Object.fromEntries(states.map((s) => [s.id, Object.fromEntries(Object.entries(s.repos).map(([n, r]) => [n, git(r.worktree, ['rev-parse', 'HEAD'])]))]));
  append(root, id, 'batch.members', { members, heads }, actor(options));
  append(root, id, 'criteria.frozen', { criteria: [{ id: 'B1', text: `${members.join(', ')} integrate and pass the full gate together`, uat: false }], plan: null }, actor(options));
  return loadState(root, id);
}

export function batchEject(root, options) {
  const batch = openState(root, { attempt: options.batch });
  const member = assertSafeId(options.member ?? '', 'attempt id');
  const members = batchMembers(root, batch.id);
  if (!members.includes(member)) throw refuse(`${member} is not in ${batch.id}`);
  if (batch.delivery.completedAt || Object.keys(batch.delivery.repos).length) throw refuse(`${batch.id} is already being delivered`);
  const remaining = members.filter((m) => m !== member);
  for (const [name, r] of Object.entries(batch.repos)) {
    run('git', ['checkout', '--quiet', '-B', branchName(batch.id), r.base], { cwd: r.worktree });
    for (const m of remaining) {
      const ms = loadState(root, m);
      if (ms.repos[name]) run('git', ['merge', '--no-edit', '-m', `Batch ${batch.id}: merge ${m}`, branchName(m)], { cwd: r.worktree });
    }
  }
  append(root, member, 'batch.ejected', { batch: batch.id, reason: options.reason ?? null }, actor(options));
  append(root, batch.id, 'batch.members', { members: remaining, ejected: member }, actor(options));
  return loadState(root, batch.id);
}

export const batchMembers = (root, batchId) => loadState(root, batchId).batch?.members ?? [];

// With several open attempts a command without --attempt is refused, so every command the engine prints names it.
export function withAttempt(root, state, text) {
  let open = 0;
  for (const id of listAttempts(root)) {
    if (!['done', 'abandoned'].includes(loadState(root, id).phase)) open += 1;
    if (open > 1) break;
  }
  if (open < 2) return text;
  return text.replace(/`wf ([^`]*)`/g, (m, cmd) => (/(^|\s)--attempt(\s|=|$)/.test(cmd) ? m : `\`wf ${cmd} --attempt ${state.id}\``));
}

export function nextAction(root, state) {
  return withAttempt(root, state, nextStep(root, state));
}

function nextStep(root, state) {
  const cfg = loadConfig(root);
  if (state.phase === 'done') return 'nothing: this attempt is closed';
  if (state.phase === 'handoff-pending' && owesLesson(state) && !state.tracker.pending.length && !needsShown(state)) return lessonPrompts(state)[0];
  if (state.phase === 'abandoned') return 'nothing: this attempt was abandoned';
  const holdNote = state.activeHold ? ` (on hold: "${state.activeHold.reason}"; \`wf release\` lifts it)` : '';
  const show = needsShown(state) ? `show the owner, in the chat, each of the ${state.delivery.screenshots.screenshots.length} delivered screenshot(s) listed under "delivered screenshots" with a caption saying which screen and state it shows, then record it: \`wf shown --file <copy of ${shownDraftFile(root, state.id)} with your captions>\`` : null;
  if (show && state.phase === 'handoff-pending') {
    const later = state.tracker.pending.length ? `; then the tracker (${state.tracker.pending[0].event}) actions` : '';
    return `${show}${later}`;
  }
  if (state.tracker.pending.length) {
    const ev = state.tracker.pending[0].event;
    const comment = (a) => (a.rendered !== 'delivered' ? 'post the comment (body in `wf status --json`)' : state.delivery.summary ? `post the comment in ${commentFile(root, state.id)} unchanged, each {assetUrl:<title>} replaced by that upload's assetUrl, so every screenshot shows as an image on the ticket (an attachment alone is only a link row)` : 'record the owner\'s summary (`wf summary --file <summary.md>`), then post the comment it renders');
    const ops = state.tracker.pending.filter((a) => a.event === ev).map((a) => (a.op === 'setStatus' ? `set status to "${a.status}"` : a.op === 'comment' ? comment(a) : a.op === 'attach' ? `upload and attach ${a.files.length} screenshot(s) as files (title = the name, subtitle = its caption; listed under "delivered screenshots"), keeping each assetUrl` : a.op)).join(', ');
    const raw = ev === 'delivered' ? 'save the RAW get_issue and list_comments results unchanged (never rebuilt or abridged)' : 'save the readback';
    if (cfg?.tracker?.via === 'connector') return `${state.phase === 'handoff-pending' ? '' : `${phaseAction(cfg, state)}${holdNote}. Pending `}tracker (${ev}): through the connector: ${ops}; then read the issue${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' and its comments' : ''} back with the connector and run \`wf tracker record --event ${ev} --from-transcript\` (the readback as the host recorded it). Without a host transcript: \`--capture <saved tool result>\`, or \`--agent-reported --file reported.json${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' --comment-file <posted text>' : ''}\``;
    const reported = cfg?.tracker?.via === 'connector' ? `; or, when the tool results are only in the chat, write what the tracker showed to reported.json ({ issue, status, comment: { id, bodySha256, createdAt }, attachments: [{ title, subtitle, assetUrl }], readAt }) and run \`wf tracker record --event ${ev} --agent-reported --file reported.json${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' --comment-file <the posted comment text>' : ''}\` (recorded agent-reported, unverified)` : '';
    const tracker = `tracker (${ev}): ${ops}; ${raw} and run \`wf tracker record --event ${ev} --capture <file>\`${reported}`;
    if (state.phase === 'handoff-pending') return tracker;
    return `${phaseAction(cfg, state)}${holdNote}. Pending ${tracker}`;
  }
  return `${phaseAction(cfg, state)}${holdNote}`;
}

function phaseAction(cfg, state) {
  // The stop reason is the owner's note about the tree it stopped on; once the code changed it is stale and, shown to a
  // later reviewer, it carried an earlier round's findings into a blind review.
  if (state.stops.length && state.lastGate?.status === 'stopped' && canonical(state.lastGate.tree) === canonical(treeHashes(state))) {
    const stop = state.stops.at(-1);
    // A gate stopped for a finding or a tree change is not resumed: the tree changes first, and a code review comes
    // before the next gate (I-27). An owner's decision (or a stop recorded before classes existed) resumes it.
    if (['major-finding', 'tree-change'].includes(stop.class)) return `gate stopped (${stop.class}: ${stop.reason}); fix and commit through the implementer that did that work, then the code review of the new tree: hand it to a fresh reviewer (\`wf handoff reviewer --agent <new id>\`); the gate runs once a round comes back clean`;
    return `gate stopped (${stop.class ? `${stop.class}: ` : ''}${stop.reason}); run \`wf gate\` to continue with finished steps carried`;
  }
  if (!state.criteria) {
    if (needsPlanner(cfg, state) && !state.handoffs.some((h) => h.role === 'planner')) return 'start the planner: `wf handoff planner --agent <id>`';
    return 'freeze the criteria: `wf plan --file <criteria.yaml>`';
  }
  if (state.lane !== 'batch' && state.work?.length) {
    const started = new Set(state.handoffs.filter((h) => h.role === 'implementer' && h.work).map((h) => h.work));
    const open = state.work.filter((w) => !started.has(w.id));
    if (open.length) return `start an implementer per open work item (agent type in brackets; never general-purpose): ${open.map((w) => `${w.id} class ${w.class} [${agentTypeFor(cfg, 'implementer', w.class)}] \`wf handoff implementer --work ${w.id} --agent <id>\``).join('; ')}`;
  }
  if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) return `start the implementer: \`wf handoff implementer --agent <id>\` [${agentTypeFor(cfg, 'implementer')}]`;
  const openIssues = openDiscovered(state);
  if (openIssues.length) return `${openIssues.filter((d) => d.blockedBy).map((d) => `route ${d.id} to the implementer of ${d.blockedBy} (continue it with SendMessage); `).join('')}fix the discovered issue(s) ${openIssues.map((d) => d.id).join(', ')} in this ticket through the implementer that found each (never yourself) (\`wf discovered list\`), commit, then \`wf discovered close <id> --fixed <commit>\`; a criterion or scope that blocks the fix is amended (\`wf criteria amend --file <f> --reason "why"\`, \`--add-repo <repo>\` when the fix needs another repo); defer only on the owner's own decision (\`--deferred\` once the owner's message starts with \`defer ${state.id}:<id>\`)`;
  if (state.accepted) return state.batchOf ? `waiting for batch ${state.batchOf}` : 'deliver: `wf deliver`';
  // Order of work (I-27): code-review rounds until one comes back clean (no gate meanwhile), then one gate on that tree,
  // then the evidence review of the gated tree. Review and gate never run side by side.
  const g = state.lastGate;
  const tree = treeHashes(state);
  const onTree = (t) => t && canonical(t) === canonical(tree);
  const pass = gatePassedForCurrentTree(state);
  const fresh = `a fresh reviewer (new id, never one from an earlier round; start it with only the printed line): \`wf handoff reviewer --agent <new id>\` [${agentTypeFor(cfg, 'reviewer')}]`;
  const focused = g?.status === 'passed' && onTree(g.tree) ? focusedSkips(g) : [];
  const gateRun = focused.length ? `the last gate was focused (skipped ${focused.join(', ')}): run one \`wf gate\` without --focused` : 'run one `wf gate` (never edit the worktrees or hand a reviewer the tree while it runs)';
  const noGate = 'no gate until a code-review round on this tree comes back clean';
  const uncommittedWork = Object.values(tree).some((t) => t.includes('+dirty')) || Object.keys(state.repos).every((n) => !changedFiles(state, n).length);
  if (uncommittedWork) return `commit the change, then the code review: hand to ${fresh}; ${noGate}`;
  const inFlight = reviewInFlight(state);
  if (inFlight) return `waiting for reviewer ${inFlight.agent}: \`wf review --closure <its file>\`; ${inFlight.round === 'evidence-review' || (!inFlight.round && inFlight.gate) ? 'evidence review of the gated tree' : 'code review'}, no gate while it runs`;
  if (g?.status === 'failed' && onTree(g.tree)) return 'gate failed: fix and commit through the implementer that did that work; the fixed tree then gets a code-review round by a fresh reviewer before the next `wf gate` (a failure that needed no code change: `wf gate` again)';
  const r = state.review;
  if (!r || !onTree(r.tree ?? r.handoffTree)) return `code review: hand to ${fresh}; ${noGate}`;
  const open = openFindings(r);
  if (open.length) return `fix the open findings (${open.map((f) => (f.work ? `${f.id} in ${f.work}` : f.id)).join(', ')}) through the implementer that did that work (continue it; do not start a new one), commit, then the next code-review round: hand to ${fresh}; ${noGate}`;
  const toVerify = unverifiedPrior(state, r);
  if (toVerify.length) return `reviewer ${r.closure.reviewer} must verify ${toVerify.length} earlier-round finding(s) (${toVerify.map((f) => `${f.round}:${f.id}`).join(', ')}): it adds \`priorFindings\` to its closure and runs \`wf review --closure <its file>\` again; if it is gone, hand to ${fresh}; ${noGate}`;
  if (!pass.ok) return `clean code review on this tree: ${gateRun}; then the evidence review`;
  if (!reviewedAfterGate(r)) return `evidence review: the gate passed on the reviewed tree, so hand to ${fresh} to inspect the gate evidence (logs and screenshots)`;
  return 'accept the review: `wf accept`';
}
