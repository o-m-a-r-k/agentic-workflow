import { gateAdapter, validationReviewProblems } from './validation.mjs';
import { captureWarning } from './captures.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { blockingIn, classifyFinding, closureMissingGuidance, deltaLines, dispositionOf, earlierBlocking, observations, openAcrossRounds, placementLevel, reviewerDiscovered, roundMode, severityLevel, sinceOf, stampClosure, stripStamp, unreachedSince } from './review-policy.mjs';
import { observationLines } from './scope-decisions.mjs';
import { GROUP_INSTRUCTIONS, assignedVerdicts, changedWeights, currentReviewGroup, divideReview, findingIds, impactCatalog, isCurrentReviewer, mergeParts, reviewSnapshot, reviewDivisionOptions } from './review-groups.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { actor, addRepoWorktree, baseRef, branchName, onTarget, changedFiles, cleanupWorktrees, entry, missingWorktrees, openState, treeHashes, worktreeDir } from './attempt.mjs';
import { channelOf, discoveredVerdicts, openDiscovered, seamVerdicts, unacknowledged, reportsForReview, reportedIssueVerdicts } from './discovered.mjs';
import { executionSettings, rejectModelOverrides } from './models.mjs';
import { detectOwner, findHost, fragment, hostChoice, isHost, lastFencedYaml, optional } from './hosts/index.mjs';
import { defaultRuntime } from './runtime-policy.mjs';
import { ADAPTER_DIR, adapterFileAtCommit, agentTypeFor, attemptAdapter, declared, loadConfig, repoDir, roleClass, trustedAdapter } from './config.mjs';
import { focusedSkips, gateBusy, gatePassedForCurrentTree, gateRunningRefusal, screenshots, withReviewLock } from './gate.mjs';
import { append, attemptDir, evidenceRoot, keptFiles, listAttempts, loadState, openEvidence } from './ledger.mjs';
import { assertUnchanged, readEvidenceFile, seal, withEvidenceTransaction } from './evidence.mjs';
import { implementerAcks, lessonPrompts, lessonVerdicts, owesLesson, recur, relevantLessons } from './lessons.mjs';
import { canonical as canonicalPath, isInside, touchesEvidence } from './paths.mjs';
import { changedForStep, deliveryOrder, impact, inside, packageOf } from './topology.mjs';
import { findSkill } from './skills.mjs';
import { outsidePlan, outsideVerdicts } from './scope.mjs';
import { commentFile, emitTrackerEvent, needsSummary, recordSummary, writeDeliveredComment } from './tracker.mjs';
import { designChecks, designVerdicts, requiredSkills, reviewDocumentProblems, reviewRules, ruleVerdicts, skillFiles, writeRuleDocuments } from './rules.mjs';
import { expectOf, expectProblems, PLAN_EXPECT, ROLE_EXPECT } from './expectations.mjs';
import { obligationSince } from './versions.mjs';
import { requireOwnerDecision, strategistHandoff, strategistWaiting, strategyHold } from './strategy.mjs';
import { requireYes } from './approve.mjs';
import { home, startPromptFor, verifyAgent } from './provenance.mjs';
import { allRecordedQueries, buildSweeps, deriveFromDiff, impactRequired, inventory, readSweepFile, rerun, staleRestrictionLines, staleRestrictions, sweepAnswers, validateAmendImpact, validatePlanImpact } from './impact.mjs';
import { WfError, YAML, assertEngine, assertSafeId, canonical, git, hashFile, hashValue, matchesAny, readJson, refuse, run, sha256, writeImmutable, writeJson } from './util.mjs';

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
    trusted = trustedAdapter(root, state);
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
  return withAttempt(root, state, `${files.length} changed file(s) outside the plan: ${files.join(', ')} — amend the criteria (\`wf criteria amend --file <f> --reason "why"\`) for an intended change, or fix it, before the review; the reviewer sees the list as context (covered by a criterion, or a finding)`);
}

// Design-system hits on the lines this attempt added, for the owner (gate, check, status). Never a refusal here: the
// reviewer answers each one, and its closure is refused without.
export function designWarning(root, state) {
  let trusted;
  try {
    trusted = trustedAdapter(root, state);
  } catch {
    return null;
  }
  const d = designChecks(root, trusted, state);
  if (!d?.hits.length) return null;
  return `${d.hits.length} design-system hit(s) on added lines; the reviewer judges them against the design system, so fix any that are not deliberate before the review:\n${d.hits.slice(0, 10).map((h) => `    - ${h.id}: ${h.description}${h.missing ? ` (file lacks ${h.missing.join(', ')})` : ''}`).join('\n')}${d.hits.length > 10 ? `\n    … ${d.hits.length - 10} more` : ''}`;
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

// Evidence a command writes and the ledger entry that records it are one transaction, sealed before it ends. Named failure
// (I-109): the files were written first, outside any transaction, and entered in the manifest when the process ended, so a
// `wf status` run in between was refused with "extra file (not written by wf)"; a handoff that failed after its write left
// the file behind. A reader now sees none of it or all.
export function recordedTogether(root, id, fn) {
  return withEvidenceTransaction(root, id, () => {
    const out = fn();
    seal(append, { root, id });
    return out;
  });
}

// The plan file's schema. `wf plan` once read only `plan`, so a contract, anchors or test selectors written as
// top-level keys were dropped from the frozen plan and never reached the implementers. Plan sections may sit under
// `plan:` (a mapping, or plain text for the summary) or at the top level beside `criteria` and `work`, as the planner
// template writes them; any other top-level key is refused with this list. The sections themselves are open.
export const PLAN_SECTIONS = ['summary', 'contract', 'anchors', 'tests', 'doNotRun', 'externalServices', 'agentSplit', 'expect'];
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
  // `expect` is the planner's prediction ({ files, rounds, minutes }); the engine shows it beside what happened (engine/expectations.mjs).
  const problems = expectProblems(plan.expect, PLAN_EXPECT, 'plan.expect');
  if (problems.length) throw refuse(`the plan's expectation cannot be compared:\n  - ${problems.join('\n  - ')}`, 'state your own numbers: `expect: { files: <n>, rounds: <n>, minutes: <n> }`', { id: 'plan:expect-unreadable' });
  return Object.keys(plan).length ? plan : null;
}

// A refusal that is the planner's own output being unreadable as a plan (no fenced block, YAML that does not parse), as
// against the owner's mistakes (an agent that was never handed the planning, a transcript from another harness). It carries
// the text that was read, so `wf plan` keeps it with the refusal (I-114).
const plannerOutputDefect = (error, text, where = null) => Object.assign(error, { plannerOutput: { text, where } });

// The planner's own output, so the owner never retypes it: the last fenced YAML block in the transcript of the planner the
// handoff names. A role the engine launched is checked against its launch receipt; one the owner started by agent type
// is found by the name it was started under (the harness adapter reads its own records, as `wf report` does).
function planFromAgent(root, state, agent) {
  const handoff = state.handoffs.filter((h) => h.role === 'planner' && h.agent === agent).at(-1);
  if (!handoff) throw refuse(`\`${agent}\` was not handed this attempt as its planner${state.roles.planner.length ? ` (planners: ${state.roles.planner.join(', ')})` : ''}`, 'run `wf handoff planner --agent <id>` and start that agent with the printed line');
  // Named failure I-39: a handoff imported the last YAML from an unrelated, same-named agent of another harness.
  const check = verifyAgent(handoff);
  if (check.status === 'mismatch') throw refuse(`the planner transcript does not match its handoff: ${check.reason}`);
  const host = findHost(handoff.runtime);
  if (host && (host.spawnMode === 'engine-only' || handoff.launch)) {
    const runtimeName = host.name;
    if (check.status !== 'verified' || handoff.launch?.status !== 'completed') throw refuse(`${runtimeName} planner output needs an engine-launched completed handoff; run wf handoff run --agent <id>, or use wf plan --file <file> with the unchanged reply`, check.reason);
    const text = lastFencedYaml(check.entries);
    if (text === null) throw plannerOutputDefect(refuse(`the ${runtimeName} planner transcript has no fenced YAML block`), null, check.transcript);
    let doc;
    try { doc = YAML.parse(text); } catch (e) { throw plannerOutputDefect(refuse(`the ${runtimeName} planner YAML does not parse: ${e.message.split('\n')[0]}`), text); }
    return { doc, text, source: { agent, transcript: check.transcript, agentType: handoff.agentType, model: handoff.model, provenance: check.status } };
  }
  const read = optional(host, 'roleOutput');
  if (!read) throw refuse('planner output cannot be imported from another runtime; use `wf plan --file <file>`');
  const output = read(handoff, { home: home(), check });
  if (output.problem) throw refuse(output.problem, `check the agent id (${fragment(host, 'howToStart', handoff)}), or save the planner's YAML unchanged to a file and use \`wf plan --file <file>\``);
  const text = lastFencedYaml(output.entries);
  if (text === null) throw plannerOutputDefect(refuse(`the transcript of ${agent} (${output.file}) has no fenced YAML block`, 'ask the planner to return its plan in one ```yaml block, or save it to a file and use `wf plan --file <file>`'), null, output.file);
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    throw plannerOutputDefect(refuse(`the last YAML block in ${agent}'s transcript does not parse: ${error.message.split('\n')[0]}`), text);
  }
  return { doc, text, source: { agent, transcript: output.file, agentType: output.agentType, model: output.model, provenance: check.status } };
}

const plannerLanes = (cfg) => cfg.roles?.planner?.lanes ?? ['standard'];
const needsPlanner = (cfg, state) => plannerLanes(cfg).includes(state.lane) && cfg.roles?.planner !== false;
// The adapter as committed at the attempt's base decides whether a planner and the impact analysis are required and which
// classes exist (a ticket cannot drop them). Named failure (0.5.0 adversarial review): this fell back to the working copy
// when the adapter at base could not be read, so an uncommitted `adapterRepo` edit plus `impact.requiredFor: []` (or
// `roles.planner: false`, or a class of its own) skipped the impact analysis or the planner. Nothing falls back now.
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
  const cfg = trustedAdapter(root, state);
  if (state.criteria) throw refuse('criteria are already frozen', 'change them with `wf criteria amend --file <f> --reason <why>`');
  if (typeof options.file !== 'string' && typeof options['from-agent'] !== 'string') throw new WfError('--file <plan.yaml|json> or --from-agent <planner agent id> is required');
  if (typeof options.file === 'string' && typeof options['from-agent'] === 'string') throw new WfError('pass --file or --from-agent, not both');
  let fromAgent = null, fileText = null, doc, plan, work, impactRecord;
  // What the planner's output said when it could not be read as a plan: kept with the refusal (below).
  let unreadable = null;
  try {
    // Named failure (I-114): reading the planner's output ran outside this block, so a transcript with no fenced YAML block
    // and YAML that does not parse were refused and left no record, and the next planner's bundle (`priorPlanRefusals`)
    // carried no word of it, as it carries a plan the validators refused (I-84, I-87). The same for a `--file` that does not
    // parse. A refusal about who was handed the planning, or a file that cannot be opened, is the owner's and is not kept.
    if (typeof options['from-agent'] === 'string') {
      try {
        fromAgent = planFromAgent(root, state, options['from-agent']);
      } catch (error) {
        if (error.plannerOutput) unreadable = error.plannerOutput;
        throw error;
      }
      doc = fromAgent.doc;
    } else {
      fileText = readOnce(options.file);
      try {
        doc = parseStructured(options.file, fileText);
      } catch (error) {
        unreadable = { text: fileText, where: path.resolve(String(options.file)) };
        throw error;
      }
    }
    plan = planFromDoc(doc);
    // D9 (0.7.0): the plan's prediction is the input the owner agent compares the course against; without it every course
    // line reads "the plan states no expectation" and the comparison is inert (final review of 0.7.0). The number is the
    // planner's own; no limit is derived from it.
    if (obligationSince(state, '0.7.0') && state.intent === 'implementation' && !expectOf(plan?.expect)) throw refuse('the plan states no expectation: how many files the change will touch, how many review rounds and minutes to delivery', 'add `expect: { files: <n>, rounds: <n>, minutes: <n> }` to the plan (your own prediction: the owner agent compares the course against it; no limit is derived from it)', { id: 'plan:no-expect' });
    validateCriteria(doc.criteria);
    work = validateWork(cfg, doc.work, doc.criteria);
    if (needsPlanner(cfg, state)) {
      const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
      if (!planner) throw refuse(`the ${state.lane} lane needs a planner: run \`wf handoff planner --agent <id>\` first`);
      if (canonical(treeHashes(state)) !== canonical(planner.tree)) throw refuse('the planner changed the worktree; planning must be read-only');
    }
    if (state.handoffs.some((h) => h.role === 'implementer')) throw refuse('implementation already started; criteria must be frozen before implementation');
    impactRecord = validatePlanImpact(root, cfg, state, doc, { plan, criteria: doc.criteria, work, required: impactNeeded(cfg, state, work) });
  } catch (error) {
    // Named failure (I-84, I-87): a refused plan left nothing behind, so the replacement planner started blind and made the
    // same mistake (component paths with a repository prefix). The refused report and the validator's message are kept
    // as evidence and handed to the next planner's bundle.
    try {
      const n = (state.planRefusals?.length ?? 0) + 1;
      // The output a refusal could not read is kept as it was found; a transcript with no block has none, so the report says so.
      const text = unreadable ? unreadable.text ?? `# the planner's output had no fenced YAML block${unreadable.where ? ` (${unreadable.where})` : ''}\n` : fromAgent ? fromAgent.text : fileText;
      if (text !== null && text !== undefined) {
        recordedTogether(root, state.id, () => {
          const kept = keepRaw(root, state.id, `plans/refused-${n}.raw.${typeof options['from-agent'] === 'string' ? 'yaml' : extOf(options.file)}`, text);
          append(root, state.id, 'plan.refused', { agent: fromAgent?.source.agent ?? state.handoffs.filter((h) => h.role === 'planner' && (typeof options['from-agent'] !== 'string' || h.agent === options['from-agent'])).at(-1)?.agent ?? null, report: kept.file, sha256: kept.sha256, error: String(error.message).slice(0, 4000) }, actor(options));
        });
      }
    } catch {}
    throw error;
  }
  let model = null;
  // Where available, the model the planner ran on: an agent whose class pins no model inherits the session's.
  const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
  if (!fromAgent) model = planner ? optional(findHost(planner.runtime), 'roleModel')?.(planner, { home: home() }) ?? null : null;
  recordedTogether(root, state.id, () => {
    let source;
    if (fromAgent) source = { ...fromAgent.source, ...keepRaw(root, state.id, 'plans/plan-1.raw.yaml', fromAgent.text) };
    else {
      const from = path.resolve(String(options.file));
      source = { ...keepRaw(root, state.id, `plans/plan-1.raw.${extOf(from)}`, fileText), from, agent: planner?.agent ?? null, model };
    }
    append(root, state.id, 'criteria.frozen', { criteria: doc.criteria, plan, source, ...(work ? { work } : {}), ...(impactRecord ? { impact: impactRecord } : {}) }, actor(options));
  });
  const frozen = loadState(root, state.id);
  // Named failure (I-94): criteria needing screenshots were frozen although no gate step collects any, and acceptance found
  // the missing route at the end. Said now, while the owner can still import captures or register a collecting step.
  const route = captureWarning(root, frozen);
  if (route) process.stderr.write(`warning: ${route}\n`);
  return frozen;
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
  const stated = doc?.expect;
  const expectIssues = expectProblems(stated, PLAN_EXPECT, 'expect');
  if (expectIssues.length) throw new WfError(`the amendment's expectation cannot be compared:\n  - ${expectIssues.join('\n  - ')}`);
  const { criteria, changes } = doc?.criteria === undefined && (doc?.impact !== undefined || stated !== undefined) ? { criteria: state.criteria, changes: { changed: [], added: [], dropped: [] } } : mergeAmendment(state.criteria, doc.criteria);
  const scope = scopeOf(doc.scope);
  // Work items survive an amendment unless the file replaces them; either way they must name criteria that still exist.
  // Classes and repos are the base adapter's: a repo the working copy adds is unknown here.
  const cfg = trustedAdapter(root, state);
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
  const trusted = cfg;
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
  // Named failure (I-107): an amendment on an accepted attempt added a criterion and left the acceptance standing, so
  // `wf deliver` shipped it with no evidence mapped to it (`wf accept` would have refused). An amendment that adds or
  // changes a criterion, or adds a repo, withdraws the acceptance, as a supplemental validation does: the attempt is
  // reviewed and accepted again on its tree (a new gate when the code moved). D7: this is an obligation a release adds to
  // an attempt that was already accepted, so it applies to attempts admitted at 0.7.4 or later; for an earlier one the
  // acceptance stands, the amendment says so, and `wf resume` warns until a fresh review maps the criteria.
  // The decision is written into the event, so folding an older ledger again changes nothing.
  const reopensScope = Boolean(changes.added.length || changes.changed.length || addRepos.length);
  const acceptedNow = Boolean(state.accepted) && !state.delivery.completedAt && !['handoff-pending', 'done', 'abandoned'].includes(state.phase);
  const withdrewAcceptance = reopensScope && acceptedNow && obligationSince(state, '0.7.4');
  recordedTogether(root, state.id, () => {
    const raw = keepRaw(root, state.id, `plans/amend-${state.criteriaAmendments.length + 1}.raw.${extOf(from)}`, amendText);
    append(root, state.id, 'criteria.amended', { criteria, changes, reason: String(options.reason), previous: state.criteria, raw, ...(expectOf(stated) ? { expect: expectOf(stated) } : {}), ...(doc.work ? { work } : {}), ...(added.length ? { addedRepos: added.map((a) => a.repo) } : {}), ...(impactAddendum ? { impact: impactAddendum } : {}), ...(impactOwed ? { impactOwed } : {}), ...(withdrewAcceptance ? { withdrewAcceptance: true } : {}) }, actor(options));
    // Telemetry: how much the ticket grew with this amendment (criteria counts always; endpoints, error codes and repos
    // when the amendment file states them under `scope`).
    append(root, state.id, 'scope.changed', { amendment: state.criteriaAmendments.length + 1, reason: String(options.reason), criteria: { before: state.criteria.length, after: criteria.length, added: changes.added.length, changed: changes.changed.length, dropped: changes.dropped.length }, ...scope, addedRepos: added.map((a) => a.repo) }, actor(options));
  });
  const after = loadState(root, state.id);
  const route = captureWarning(root, after); // I-94, as at `wf plan`
  const ids = [...changes.added, ...changes.changed];
  const acceptance = withdrewAcceptance
    ? `acceptance withdrawn: ${ids.length ? `${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} added or changed` : 'a repo was added'} after the review that was accepted, so no review mapped ${ids.length ? 'it' : 'its seam'} to evidence; next: ${nextAction(root, after)}`
    : reopensScope && acceptedNow ? `${state.id} was admitted before 0.7.4, so its acceptance stands and \`wf deliver\` would ship ${ids.join(', ') || 'the added repo'} with no review having mapped it to evidence; hand a fresh reviewer (\`wf handoff reviewer --agent <new id>\`) and \`wf accept\` again before delivering` : null;
  return { state: after, changes, added, impactOwed, acceptanceWithdrawn: withdrewAcceptance, restrictions: [...restrictionWarnings(trusted, after), ...(route ? [route] : []), ...(acceptance ? [acceptance] : [])] };
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
  rejectModelOverrides(options);
  if (['parallel', 'single', 'division', 'reviewers'].some(key => options[key] !== undefined) && role !== 'reviewer') throw refuse('review division options apply only to reviewer handoffs');
  const divisionOptions = reviewDivisionOptions(options);
  const state = openState(root, options);
  // Rules, skills, roles, classes and agent types come from the adapter at the attempt's base, so a ticket cannot drop
  // its own rules or pick its own class.
  const trusted = trustedAdapter(root, state);
  const cfg = trusted;
  const roles = ['planner', 'implementer', 'reviewer', 'tester', 'strategist'];
  if (!roles.includes(role)) throw new WfError(`role must be one of ${roles.join(', ')}`);
  // 0.7.0 (D3): the strategist's bundle is built in engine/strategy.mjs; no implementer or reviewer starts while the
  // person's round escalation or a strategist's escalation awaits their decision.
  if (role === 'strategist') return strategistHandoff(root, state, options);
  if (['implementer', 'reviewer'].includes(role)) requireOwnerDecision(root, state, role);
  if (!options.agent) throw new WfError('--agent <identity of the agent you are starting> is required');
  const agent = String(options.agent);
  const owner = state.owner;
  const preferred = defaultRuntime(state);
  const runtime = options.runtime ?? preferred ?? detectOwner()?.runtime;
  if (!isHost(runtime)) throw refuse(`choose --runtime ${hostChoice(' or ')}: this attempt has no recorded owning runtime`);
  if (state.intent === 'analysis' && role !== 'planner') throw refuse('analysis attempts are read-only; only a planner handoff is allowed');
  if (role === 'implementer' && !state.criteria) throw refuse('freeze criteria first: `wf plan --file <criteria>`');
  if (role === 'tester' && !cfg.roles?.tester) throw refuse('this project has no tester role configured');
  // Order of work (I-27): code-review rounds run to clean with no gate, then one gate on that tree, then the evidence
  // review of the gated tree. A finding made while a gate runs makes that gate obsolete, so the two never overlap.
  let gateNow = null;
  let reviewOverride = null;
  let historicalReports = [];
  // Review policy (D2): a full blind audit (the first code-review round, the evidence review) or a delta review.
  let mode = null;
  if (options.reason !== undefined && role !== 'reviewer') throw new WfError('--reason applies to reviewer handoffs only (to hand the tree while an implementer is still open)');
  if (role === 'reviewer') {
    const busy = gateBusy(root, state);
    if (busy) throw gateRunningRefusal(state, busy);
    if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) throw refuse('nothing to review yet: hand the work to an implementer first (`wf handoff implementer --agent <id>`)');
    // Tracked changes only: a finished gate leaves untracked reports, and those are never the change.
    const dirty = Object.entries(treeHashes(state)).filter(([, t]) => t.includes('+dirty')).map(([n]) => n);
    if (dirty.length) throw refuse(`commit the change before the review (the reviewer reads the committed diff): uncommitted changes in ${dirty.join(', ')}`);
    // Named failure (I-23): two review rounds were refused because implementers were still editing the tree the reviewer
    // had been handed. An implementer handoff stays open until `wf handoff close`; while one is open the tree may still
    // move, so no review round starts. `--reason` hands the tree anyway and records the override.
    const openImpl = openImplementersOf(root, state);
    if (openImpl.length) {
      const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
      if (!reason) throw refuse(`implementer handoff(s) still open on ${state.id}: ${openImpl.map(implementerLabel).join(', ')}: the tree may still move under the reviewer`, `when each implementer has reported done and its work is committed, close it: ${openImpl.map((x) => `\`wf handoff close --agent ${x.agent}\``).join(', ')} (\`--outcome stopped\` for one you stopped); then hand the tree to the reviewer, or hand it anyway with \`wf handoff reviewer --agent <id> --reason "<why>"\`, which records the override`);
      // Bookkeeping since 0.7.0 (engine/owner.mjs): the owner agent records the override as itself.
      reviewOverride = { reason, openImplementers: openImpl.map(implementerLabel) };
    }
    if (authorsOf(root, state).has(agent)) throw refuse(`${agent} planned, wrote or owns this change and cannot review it`);
    // A resumed reviewer is anchored on its earlier findings; each round is judged by an agent that has seen none of them.
    if (state.roles.reviewer.includes(agent)) throw refuse(`${agent} already reviewed a round of this attempt; start a fresh reviewer agent with a new id; each review round uses a new agent`);
    // A reopened attempt records what the project learns before it is reviewed: the lesson is then in the reviewed diff.
    if (owesLesson(state)) throw refuse(lessonPrompts(state)[0]);
    // Lesson acknowledgement trailers (`Lesson <id>: applied - <why>`) are recorded and shown to the reviewer when an
    // implementer wrote them, and never required (0.7.0, named failure: the refusal caught nothing in the field; the
    // reviewer's per-lesson verdict is the check that stays).
    const ack = implementerAcks(state);
    for (const a of ack.acks) if (!(state.lessons?.acknowledged ?? []).some((x) => x.lesson === a.lesson && x.commit === a.commit)) append(root, state.id, 'lesson.acknowledged', a, null);
    // I-18 (extended): an implementer's report never leaves an issue unfixed without its discovered entry.
    const reports = reportsForReview(state);
    // Before 0.7.0 the engine read the implementer's prose for issues it left; from 0.7.0 its structured report does that.
    const unrecorded = obligationSince(state, '0.7.0') ? [] : reports.current;
    historicalReports = obligationSince(state, '0.7.0') ? [] : reports.historical;
    if (unrecorded.length) throw refuse(unrecorded.map((u) => `${u.agent}'s report leaves ${u.lines.length} issue(s) unfixed without a discovered entry:\n${u.lines.map((l) => `  - ${l}`).join('\n')}`).join('\n'), `the implementer that found it fixes it, in this attempt, in whatever file it lives in (continue it with SendMessage; the work-item brief is no reason to leave it, and the owner never fixes it); only when another work item is editing that file right now, the implementer records it: \`wf discovered add --summary "..." --where <file:line> --found-by ${unrecorded[0].agent} --blocked-by <work item>\` and names the D id in its report`);
    // 0.7.0, named failure: work items built in parallel met each other for the first time in a review round, so every
    // round found a new batch of cross-cutting breakage (one ticket ran 47 rounds; the 0.7.0 integration itself, six
    // parallel streams, broke 21 tests only visible on the combined tree). With more than one work item, the combined tree
    // passes `wf check` (the adapter's light steps, minutes) before a code review is handed it.
    if (integrationCheckOwed(cfg, state)) throw refuse(`the combined tree of ${state.work.length} work items has no passing \`wf check\`: review is never the first place the parts meet`, `run \`wf check --attempt ${state.id}\` and fix what it finds through the implementers, then hand the reviewer`, { id: 'review:integration-check' });
    gateNow = gatePassedForCurrentTree(state);
    mode = roundMode(state, { evidence: gateNow.ok });
  }
  if (role === 'implementer' && state.roles.reviewer.includes(agent)) throw refuse(`${agent} reviewed this attempt and cannot implement it`);
  if (options.sweep !== undefined && role !== 'implementer') throw new WfError('--sweep applies to implementer handoffs only');
  const changed = Object.fromEntries(Object.keys(state.repos).map((r) => [r, changedFiles(state, r)]));
  const preparedTree = role === 'reviewer' ? treeHashes(state) : null;
  // Named failure: division and symbol derivation repeated every impact query within one frozen handoff.
  const reviewQueries = role === 'reviewer' && mode === 'full' && state.impact ? rerun(root, cfg, state) : null;
  const skillIssues = skillProblems(root, trusted, role, runtime, state, changed);
  if (skillIssues.length) throw refuse(skillIssues.join('\n'));
  let work = null;
  if (options.work !== undefined) {
    if (role !== 'implementer') throw new WfError('--work applies to implementer handoffs only');
    work = (state.work ?? []).find((w) => w.id === String(options.work));
    if (!work) throw refuse(`no work item \`${options.work}\` in the frozen plan${state.work?.length ? ` (work items: ${state.work.map((w) => w.id).join(', ')})` : ''}`);
    if (!cfg.classes[work.class]) throw refuse(`work item ${work.id}: class \`${work.class}\` is no longer in the adapter (known: ${Object.keys(cfg.classes).join(', ')})`);
  }
  // Named failure (I-63): an implementer handed without --work while the plan's work items were unstarted built them all,
  // settled and was closed, and `wf advance` still reported every item unstarted because no handoff named one; the way on
  // was a bookkeeping handoff per item. From 0.7.0 such a handoff is refused up front.
  // Refusal audit of 0.7.0: refusing it made the owner amend the plan to satisfy bookkeeping. Such a handoff now covers
  // every work item no implementer has started, and is recorded so.
  let covers = null;
  if (role === 'implementer' && !work && state.lane !== 'batch' && obligationSince(state, '0.7.0')) {
    const open = unstartedWork(state);
    if (open.length) covers = open.map((w) => w.id);
  }
  // I-25: a fix handoff (open review findings this implementer builds) carries one pattern sweep per family: findings that
  // share a `family` are one defect pattern, so one query and one mechanical proof answer all of them. Only findings that
  // block are repaired here; observations wait for the strategist.
  let sweeps = null;
  let repair = null;
  if (role === 'implementer') {
    const lastReview = state.reviews.at(-1)?.at ?? null;
    const swept = new Set(state.handoffs.filter((h) => h.role === 'implementer' && lastReview && h.at > lastReview).flatMap((h) => (h.sweeps ?? []).flatMap((x) => x.findings ?? [x.finding])));
    const mine = earlierOpenFindings(state, null).filter((f) => f.blocks && (!work || !f.work || f.work === work.id));
    const owed = mine.filter((f) => !swept.has(`${f.round}:${f.id}`));
    repair = mine.length ? familiesOf(mine) : null;
    const groups = familiesOf(owed);
    // 0.7.0 (goals, not methods): the sweep is optional. The implementer finds the other instances of each family and
    // answers it with one proof in its report; an owner-written query steered its search (final review of 0.7.0).
    if (options.sweep !== undefined) {
      if (typeof options.sweep !== 'string') throw new WfError('--sweep <file> names the sweep file');
      if (!owed.length) throw refuse('no open review finding is owed a sweep: --sweep is for fix handoffs');
      const startAt = state.handoffs.flatMap((h) => h.sweeps ?? []).length + 1;
      sweeps = buildSweeps(root, cfg, state, readSweepFile(options.sweep).doc, { owed, startAt });
    }
  }
  // Delta round: the diff since the tree the last round judged. A repo whose earlier head no longer leads to HEAD counts the
  // attempt's whole diff.
  let deltaInfo = null;
  let deltaFrom = null;
  if (role === 'reviewer' && mode === 'delta') {
    deltaFrom = state.review?.tree ?? state.review?.handoffTree ?? {};
    deltaInfo = { since: {}, diff: {}, changed: {}, lines: deltaLines(state, deltaFrom) };
    for (const [name, r] of Object.entries(state.repos)) {
      const from = sinceOf(r, deltaFrom[name]);
      deltaInfo.since[name] = from;
      const baseSha = git(r.worktree, ['merge-base', r.baseRef ?? r.base, 'HEAD'], { allowFail: true }) || r.base;
      deltaInfo.diff[name] = `git -C ${r.worktree} diff ${from ?? baseSha} HEAD`;
      // The attempt's own files changed since then: files a base merge brought in are not this attempt's change.
      deltaInfo.changed[name] = from ? git(r.worktree, ['diff', '--name-only', `${from}..HEAD`]).split('\n').filter((f) => f && (changed[name] ?? []).includes(f)) : changed[name];
    }
  }
  // A strategist's model decision (D3) names the class the role's next handoffs run at.
  const chosenClass = state.strategy?.classFor?.[role];
  const cls = (chosenClass && cfg.classes?.[chosenClass] ? chosenClass : null) ?? work?.class ?? roleClass(cfg, role);
  const agentType = agentTypeFor(cfg, role, cls);
  const { effort, model, sourceClass, runtimeAdapterBase } = executionSettings(root, state, role, cls, runtime);
  // A provider other than the owner's is a recorded choice (bookkeeping since 0.7.0), not an authority claim.
  const runtimeAuthority = preferred && runtime !== preferred ? { runtime, from: preferred, by: actor(options) } : null;

  const selected = ['planner', 'implementer', 'reviewer'].includes(role) && !(role === 'reviewer' && mode === 'delta') ? relevantLessons(root, role, state, changed, { work }) : null;
  // Trusted copies of the rule documents the bundle lists: collected while it is built, written when it is recorded.
  const ruleDocs = [];
  const n = state.handoffs.length + 1;
  let file = path.join(attemptDir(root, state.id), 'handoffs', `${String(n).padStart(2, '0')}-${role}.json`);
  const appendix = cfg.roles?.[role]?.appendix ? path.resolve(root, ADAPTER_DIR, cfg.roles[role].appendix) : null;
  const repairNow = role === 'implementer' && Boolean(repair);
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
    sourceClass,
    runtimeAdapterBase,
    work,
    worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])),
    // Where the ticket's own change starts: after `wf base merge` this is the merged base, not the admission commit,
    // so a diff against it shows the ticket's change only.
    bases: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, git(v.worktree, ['merge-base', v.baseRef ?? v.base, 'HEAD'], { allowFail: true }) || v.base])),
    // What the planner (and every role) reads first: the issue as captured at entry and from the tracker.
    issue: { file: state.issue?.file ?? null, trackerCaptures: state.tracker.done.map((d) => d.capture?.path).filter(Boolean) },
    criteria: state.criteria,
    // The planner's `expect` is a prediction for the owner and the strategist to compare, not a target: an implementer or a
    // reviewer reading it would build or judge toward a number.
    plan: role === 'reviewer' && mode === 'delta' ? undefined : ['implementer', 'reviewer'].includes(role) && state.plan ? Object.fromEntries(Object.entries(state.plan).filter(([k]) => k !== 'expect')) : state.plan,
    workItems: state.work,
    // The planner assigns each work item a class from these texts.
    classes: role === 'planner' ? Object.fromEntries(Object.entries(cfg.classes).map(([n, c]) => [n, { use: c.use, agentType: agentTypeFor(cfg, 'implementer', n) }])) : undefined,
    // The attempt's amendment history is not a reviewer's input: the criteria above are the amended, current ones.
    criteriaAmendments: role === 'reviewer' ? undefined : state.criteriaAmendments,
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
    // Only defects still open or deferred: a fixed one is history, and an implementer's own lint or fixture fix
    // (`--kind bookkeeping`) is never a reviewer's verdict item.
    discovered: ['implementer', 'reviewer'].includes(role) ? reviewerDiscovered(state.discovered, state) : undefined,
    // I-42: unresolved historical observations require a current-tree reviewer verdict.
    historicalReports: role === 'reviewer' && mode === 'full' ? historicalReports : undefined,
    // Repos added to the attempt by an owner amendment for a fix (I-19): the reviewer judges each seam on both sides.
    // Every reviewer round, delta included: acceptance checks the accepted round was handed every added repo (repair
    // review of 0.7.0: an evidence review after a fix is a delta, and without them acceptance was unreachable).
    addedRepos: ['implementer', 'reviewer'].includes(role) ? state.addedRepos : undefined,
    changed: deltaInfo ? deltaInfo.changed : changed,
    // Delta round: the diff since the last reviewed tree, never the attempt's history.
    delta: deltaInfo ?? undefined,
    // Delta round: the findings still open, handed up front (no second submission after a blind closure). Observations are
    // handed too, so a reviewer can settle one that was fixed; one the owner recorded fixed carries the commit.
    openFindings: role === 'reviewer' && mode === 'delta' ? earlierOpenFindings(state, null) : undefined,
    // Findings that left this delivery (a follow-up ticket, a sibling attempt) and why: a reviewer raises one again as a
    // finding when it should not have left (final review of 0.7.0: the evidence reviewer never saw them).
    followUps: role === 'reviewer' ? followUpsOf(state) : undefined,
    // Named failure (I-69): scope an earlier recorded round said it did not reach (`notReached`) reached no later reader, so
    // the next reviewer could not know what was never looked at. Coverage, not findings: a full round stays blind.
    unreachedBefore: role === 'reviewer' && unreachedSince(state).length ? { note: 'Scope an earlier recorded round said it did not reach, and no complete full audit has covered since; none of these rounds counted as an audit. It adds to your goal and narrows nothing: what an earlier reviewer did not reach was not cleared.', rounds: unreachedSince(state) } : undefined,
    mode: role === 'reviewer' ? mode : undefined,
    // A repair handoff: the open findings that block, grouped by family.
    repair: role === 'implementer' ? repair ?? undefined : undefined,
    impact: impact(trusted, changed),
    // I-26: the planner's survey and impact map with every addendum. For the reviewer, the inventory to sample and the
    // callers of symbols the final diff declares or edits that no listed file covers: each needs a verdict.
    impactMap: state.impact && (role === 'implementer' || (role === 'reviewer' && mode === 'full')) ? impactMapFor(root, cfg, state, role, reviewQueries) : undefined,
    // I-25: the fix round's pattern sweeps (implementer: answer each in a commit trailer; reviewer: the answers, and the
    // hits then and now).
    sweep: role === 'implementer' && sweeps ? sweeps : undefined,
    sweeps: role === 'reviewer' ? sweepsForReviewer(root, cfg, state) : undefined,
    invariants: cfg.invariants ? path.resolve(root, ADAPTER_DIR, cfg.invariants) : null,
    roleAppendix: appendix && fs.existsSync(appendix) ? appendix : null,
    // Which round this is: a code review (no passing gate on this tree; the reviewer judges the diff and no gate runs
    // until a round comes back clean) or the evidence review (a gate passed on this tree after a clean code review; the
    // reviewer inspects its logs and screenshots). Acceptance needs the evidence review.
    // Named failure (I-102): a corrected supplemental validation re-pins a step the last review already judged, and a delta
    // reviewer, handed none, could not tell that the plugin it reads in the diff is the one the gate now runs.
    supplementalValidation: mode === 'delta' ? (state.validations ?? []).filter((v) => v.correctedFrom && v.at > (state.review?.at ?? '')) : state.validations ?? [],
    round: role === 'reviewer' ? (gateNow.ok ? 'evidence-review' : 'code-review') : undefined,
    gate: role === 'reviewer'
      ? gateNow.ok
        ? { passedOnThisTree: true, runId: state.lastGate.runId, evidence: state.lastGate.evidence, screenshots: screenshots(state).map((a) => ({ ...a, inspectedBefore: inspectedEver(state).has(a.sha256) })), artifacts: artifactsByStep(state, gateAdapter(root, state)), logs: state.lastGate.steps.filter((s) => s.log).map((s) => ({ step: s.id, log: s.log, status: s.status })) }
        : { passedOnThisTree: false, reason: gateNow.reason, screenshots: [], logs: [] }
      : null,
    // The project's quality bar (adapter `quality:`): standing goals, context for every role (0.7.0).
    qualityBar: ['planner', 'implementer', 'reviewer'].includes(role) ? trusted.quality ?? [] : undefined,
    // Project rule documents this change falls under, and the skills this round needs: a pure function of the adapter
    // at base and the changed files, the same for every reviewer. Context for the review; no verdict form is owed.
    rules: role === 'reviewer' && mode === 'full' ? reviewRules(root, trusted, state, changed, ruleDocs) : undefined,
    // Named failure (I-94): UI criteria requiring screenshots were frozen although no gate step of the adapter collects any,
    // and only acceptance found the missing route. The planner is told which steps can produce captures.
    // Named failure (I-84, I-87): the plans `wf plan` refused earlier, unchanged, with the validator's message. Planners only: a
    // reviewer is never steered by an earlier planner's mistakes.
    priorPlanRefusals: role === 'planner' && state.planRefusals?.length ? { note: 'An earlier plan for this attempt was refused. Read each report (`wf evidence show <report>`), fix the cause and check the same thing in your own plan before reporting; in particular every component `file` and path you name must be one of the files its query returns, written repo-relative exactly as `wf impact run` prints it.', refusals: state.planRefusals.slice(-3).map((r) => ({ agent: r.agent, at: r.at, report: r.report, sha256: r.sha256, error: r.error })) } : undefined,
    captureRoutes: role === 'planner' ? { steps: trusted.gate.steps.filter((x) => x.artifacts?.length || x.plugin).map((x) => ({ id: x.id, repo: x.repo, ...(x.artifacts?.length ? { artifacts: x.artifacts } : {}), ...(x.plugin ? { plugin: x.plugin } : {}) })) } : undefined,
    // The project's shared components and design-system rules (adapter at base). For the reviewer, every rule hit on
    // the lines this attempt added: context for the review (cite one in a finding; no verdict form is owed).
    // A delta round gets the hits on the files changed since the last reviewed tree (repair review of 0.7.0: an evidence
    // review after a fix is a delta and lost the hits a full round had).
    designSystem: ['planner', 'reviewer', 'implementer'].includes(role) ? (role === 'reviewer' ? deltaDesign(designChecks(root, trusted, state), deltaInfo) : trusted.designSystem ? { components: trusted.designSystem.components ?? [], rules: (trusted.designSystem.rules ?? []).map((r) => ({ id: r.id, description: r.description, read: r.read ?? null })) } : null) : undefined,
    skills: role === 'reviewer' && mode === 'full' ? skillFiles(root, requiredSkills(trusted, role, state, changed), runtime) : undefined,
    // Changed files no plan anchor or test path names (docs-only, ignored and evidence files left out): context for the
    // reviewer, who judges whether each serves the goal.
    outsidePlan: state.criteria && !(role === 'reviewer' && mode === 'delta') ? outsidePlan(state.plan, changed, trusted) : null,
    // 0.7.0: information, not a stop. Named failure (I-25) behind the old refusal: consumers were found one at a time.
    impactOwed: role === 'implementer' && state.impact?.owed ? { amendment: state.impact.owed.amendment, reason: state.impact.owed.reason, note: 'this amendment added scope without an impact map: find the consumers and flows it reaches as you build, and report them' } : undefined,
    // The implementer's definition of done: these light steps pass for its repos (`wf check`). Never counts as a gate.
    // Every repo, not only the work item's: its goal is the criteria on the whole combined tree (final review of 0.7.0: a
    // one-repo command here was the "run only your own tests" brief that broke the 0.7.0 build's own integration).
    check: role === 'implementer' ? { command: `wf check --attempt ${state.id}`, steps: trusted.gate.steps.filter((s) => (s.tier ?? 'light') === 'light' && state.repos[s.repo]).map((s) => ({ id: s.id, repo: s.repo, run: s.run ?? `plugin ${s.plugin}` })) } : undefined,
    // Steps that failed and then passed with the same inputs and runner.
    flaky: role === 'reviewer' && mode === 'full' ? state.flaky : undefined,
    // Outside .wf-evidence/: the reviewer writes it, `wf review` copies it into the evidence.
    reviewClosureFile: role === 'reviewer' ? path.join(root, '.wf-worktrees', state.id, '_review', `closure-${n}.json`) : null,
    // Outside the evidence: the implementer writes its report here; `wf handoff close` records it (0.7.0).
    implementerReportFile: role === 'implementer' ? path.join(root, '.wf-worktrees', state.id, '_reports', `report-${n}.json`) : undefined,
    // What the implementers reported: what they changed and why, what they ran, their proofs and what they left. Context.
    implementerReports: role === 'reviewer' && (state.implementerReports ?? []).length ? state.implementerReports.slice(-10) : undefined,
    // Goals, not methods (0.7.0): the role file says what good looks like and what the engine checks.
    instructions: {
      planner: 'Your goal: targets an implementer can build and a person can check, complete enough that no consumer or flow surprises anyone later; the quality bar (`qualityBar`) turned into targets for this ticket.',
      implementer: `Your goal: the criteria you were handed hold on the whole combined tree, and nothing you touched regresses.${repairNow ? ' This is a fix round: find the cause of each family in `repair` and fix it once, with one proof.' : ''} Early in your work write your report to \`implementerReportFile\` with your \`approach\` and \`expect: { minutes }\` (how long you expect to take), and complete it before you finish.`,
      reviewer: mode === 'delta' ? (gateNow.ok ? REVIEWER_EVIDENCE_DELTA : REVIEWER_DELTA) : REVIEWER_FULL,
      tester: 'Write requirement expectations from the issue before reading the implementation, then map each to gate tests.',
    }[role],
  };
  if (role === 'reviewer' && bundle.historicalReports?.length) bundle.instructions += ' Historical reports are observations from earlier implementations, not proof of current unresolved work. Judge each historicalReports entry on the current tree and add reportedIssues: [{ id, verdict: fixed|verified-nonissue|open, evidence, fixedIn, repo, rationale, finding }]. A fixed verdict names a fix commit of this attempt; verified-nonissue gives a purpose-based rationale; open names an open finding. Missing verdicts refuse the closure, and open findings block the full gate and delivery.';
  if (role === 'reviewer' && bundle.impactMap) bundle.instructions += ' Impact discovery under impactMap.derived is textual, not structurally resolved consumer analysis, and bounded (its `incomplete` and `symbolsTruncated` say how far it got): a hit is a lead to judge against the real imports and behaviour, and a missing hit is no proof of coverage.';
  if (role === 'reviewer') {
    const problems = reviewDocumentProblems(bundle, ruleDocs);
    if (problems.length) throw refuse(`review readiness refused:\n  - ${problems.join('\n  - ')}`);
  }
  // Named failure: independent flows waited behind one reviewer, or file-count splits omitted shared dependencies.
  let division = null, groupMembers = null;
  if (role === 'reviewer' && mode === 'full' && divisionOptions.enabled) {
    const proposed = options.division === undefined ? null : JSON.parse(readOnce(options.division));
    division = divideReview(bundle, reviewQueries ?? {}, { reviewers: divisionOptions.reviewers, division: proposed, weights: () => changedWeights(state, bundle) });
    if (division.mode === 'parallel') {
      const id = `review-${n}`, snapshot = reviewSnapshot(state), members = [...division.slices.map(s => `${agent}-${s.id}`), agent];
      const planFile = path.join(attemptDir(root, state.id), 'review', `division-${n}.json`);
      const historyFile = path.join(attemptDir(root, state.id), 'review', `impact-history-${n}.json`);
      const planText = JSON.stringify(division, null, 2) + '\n';
      const historyText = JSON.stringify(bundle.impactMap, null, 2) + '\n';
      const compact = { ...bundle.impactMap, survey: undefined, impact: undefined, addenda: undefined,
        catalog: impactCatalog(bundle.impactMap), history: { file: historyFile, sha256: sha256(historyText) } };
      groupMembers = division.slices.map((slice, index) => {
        const memberAgent = `${agent}-${slice.id}`;
        assertSafeId(memberAgent, 'reviewer');
        if (authorsOf(root, state).has(memberAgent) || state.roles.reviewer.includes(memberAgent)) throw refuse(`reviewer ${memberAgent} is not fresh and independent`);
        const memberFile = path.join(attemptDir(root, state.id), 'handoffs', `${String(n + index).padStart(2, '0')}-reviewer.json`);
        const owned = new Set(slice.files);
        return { file: memberFile, bundle: { ...bundle, agent: memberAgent,
          criteria: [], criteriaContext: bundle.criteria, primaryFiles: slice.files,
          changed: Object.fromEntries(Object.entries(bundle.changed).map(([repo, paths]) => [repo, paths.filter(p => owned.has(`${repo}:${p}`))])),
          outsidePlan: bundle.outsidePlan?.filter(f => owned.has(f)) ?? null,
          designSystem: bundle.designSystem ? { ...bundle.designSystem, hits: (bundle.designSystem.hits ?? []).filter(h => owned.has(h.file) || [...owned].some(f => f.endsWith(`:${h.file}`))) } : null,
          impactMap: null, discovered: [], historicalReports: [], addedRepos: [], lessons: { ...bundle.lessons, apply: [] }, sweeps: [],
          gate: { passedOnThisTree: false, screenshots: [], logs: [], reason: 'integration owns gate evidence' },
          reviewGroup: { id, slot: slice.id, mode: 'scoped', snapshot, members, plan: { file: planFile, sha256: sha256(planText) } }, division,
          reviewClosureFile: path.join(root, '.wf-worktrees', state.id, '_review', `closure-${n + index}.json`),
          instructions: GROUP_INSTRUCTIONS + '\n\nApplicable documents and closure fields below are restricted to the handed assignment.\n' + bundle.instructions } };
      });
      file = path.join(attemptDir(root, state.id), 'handoffs', `${String(n + division.slices.length).padStart(2, '0')}-reviewer.json`);
      Object.assign(bundle, { primaryFiles: division.integration.files, impactMap: compact, division,
        reviewGroup: { id, slot: 'integration', mode: 'integration', snapshot, members, plan: { file: planFile, sha256: sha256(planText) } },
        reviewClosureFile: path.join(root, '.wf-worktrees', state.id, '_review', `closure-${n + division.slices.length}.json`),
        instructions: GROUP_INSTRUCTIONS + '\n\n' + bundle.instructions });
      groupMembers.push({ file, bundle });
      // Written inside the same gate lock as every group handoff; no partially prepared group can authorize a gate.
      division = { ...division, evidence: { planFile, planText, historyFile, historyText } };
    }
  }
  const record = () => {
    if (preparedTree && canonical(treeHashes(state)) !== canonical(preparedTree)) throw refuse('the tree changed while preparing the review handoff; prepare a fresh handoff');
    if (groupMembers) {
      return withEvidenceTransaction(root, state.id, () => {
      if (reviewSnapshot(loadState(root, state.id)) !== reviewSnapshot(state)) throw refuse('review obligations changed while preparing the group; prepare a fresh handoff');
      const { planFile, planText, historyFile, historyText } = division.evidence;
      writeRuleDocuments(ruleDocs);
      writeImmutable(planFile, planText); writeImmutable(historyFile, historyText);
      const tree = treeHashes(state), patch = patchIds(state);
      if (reviewOverride) append(root, state.id, 'review.override', { ...reviewOverride, agent }, actor(options));
      for (const member of groupMembers) {
        writeJson(member.file, member.bundle);
        mkdirStateDirectory(path.dirname(member.bundle.reviewClosureFile), { recursive: true });
        append(root, state.id, 'handoff', { ...(runtimeAuthority ? { runtimeAuthority, runtimeSelected: true, runtimeSelectionOwner: owner } : {}),
          role, agent: member.bundle.agent, runtime, session: null, agentType, class: cls, effort, model, sourceClass, runtimeAdapterBase,
          sessionModel: sessionModelNow, startPrompt: startPromptFor(member.file), work: null, bundle: member.file, closureFile: member.bundle.reviewClosureFile, tree, patch,
          gate: gateNow.ok ? state.lastGate.runId : null, round: bundle.round, mode,
          reviewGroup: { ...member.bundle.reviewGroup, bundleSha256: sha256(JSON.stringify(member.bundle, null, 2) + '\n') } }, actor(options));
      }
      seal(append, { root, id: state.id });
      });
    }
    writeRuleDocuments(ruleDocs);
    writeJson(file, bundle);
    if (bundle.reviewClosureFile) mkdirStateDirectory(path.dirname(bundle.reviewClosureFile), { recursive: true });
    if (bundle.implementerReportFile) mkdirStateDirectory(path.dirname(bundle.implementerReportFile), { recursive: true });
    const tree = treeHashes(state);
    // Telemetry: implementers handed work and not closed (`wf handoff close`) while this reviewer starts: the tree may still move.
    const openImplementers = role === 'reviewer' ? state.implementers.filter((x) => !x.closedAt).map((x) => x.agent) : undefined;
    // The owner handed the tree while an implementer was open (I-23): recorded before the round it opens.
    if (reviewOverride) append(root, state.id, 'review.override', { ...reviewOverride, agent }, actor(options));
    append(root, state.id, 'handoff', { ...(runtimeAuthority ? { runtimeAuthority, runtimeSelected: true, runtimeSelectionOwner: owner } : {}), ...(sweeps ? { sweeps } : {}), lessons: (bundle.lessons?.apply ?? []).map((l) => l.id), lessonsFiltered: (selected?.filtered ?? []).map((l) => l.id), role, agent, runtime, session: options.session ?? null, agentType, class: cls, effort, model, sourceClass, runtimeAdapterBase, sessionModel: sessionModelNow, startPrompt: startPromptFor(file), work: work?.id ?? null, ...(covers ? { covers } : {}), bundle: file, ...(bundle.implementerReportFile ? { reportFile: bundle.implementerReportFile } : {}), ...(bundle.reviewClosureFile ? { closureFile: bundle.reviewClosureFile } : {}), tree, patch: patchIds(state), ...(role === 'reviewer' ? { gate: gateNow.ok ? state.lastGate.runId : null, round: bundle.round, mode, ...(deltaFrom ? { deltaFrom } : {}), openImplementers } : {}) }, actor(options));
    if (role === 'implementer') append(root, state.id, 'implementer.opened', { handoff: handoffId(file), agent, work: work?.id ?? null, class: cls, heads: tree }, actor(options));
  };
  // The model the owner's session runs on now: an agent whose class pins no model inherits it (`wf report` shows it).
  let sessionModelNow = null;
  const owning = detectOwner();
  const ownerModel = !model && owning ? optional(findHost(owning.runtime), 'ownerModel') : null;
  if (ownerModel) {
    try {
      sessionModelNow = ownerModel(owning.session, { home: home() });
    } catch {}
  }
  // A reviewer round is recorded holding the gate lock: no gate can start between the check above and this record.
  // Named failure (I-50): the bundle was written, and only later (when this process ended) recorded in the manifest, so a
  // `wf` command another session ran in between found an unrecorded handoff file and refused with "evidence does not
  // match what wf recorded". Written, entered in the ledger and recorded in one transaction: a reader sees none of it or all.
  const publish = () => withEvidenceTransaction(root, state.id, () => {
    record();
    seal(append, { root, id: state.id });
  });
  if (role === 'reviewer') withReviewLock(root, state, publish);
  else publish();
  // Once per attempt: with parallel work items every implementer handoff queued another identical tracker read.
  const firstImplementer = role === 'implementer' && !state.handoffs.some((h) => h.role === 'implementer');
  if (firstImplementer && state.lane !== 'quick' && state.intent === 'implementation' && !state.splitFrom) emitTrackerEvent(root, loadConfig(root), state.id, 'implementing');
  // The agent type's role file changed after the owner's session loaded it (I-15): the agent would run the old role.
  let roleStale = null;
  try {
    roleStale = optional(findHost(runtime), 'roleStale')?.(root, agentType, owning, { home: home() }) ?? null;
  } catch {}
  return { bundle: file, startPrompt: startPromptFor(file), agentType, agent, roleStale, sweeps, division: division ? { ...division, evidence: undefined } : undefined,
    members: groupMembers?.map(m => ({ agent: m.bundle.agent, slot: m.bundle.reviewGroup.slot, bundle: m.file, startPrompt: startPromptFor(m.file) })),
    restrictions: restrictionWarnings(trusted, state), class: cls, effort, model, work: work?.id ?? null, lessons: bundle.lessons ? { ...bundle.lessons, filtered: selected.filtered } : null, state: loadState(root, state.id) };
}

// Reviewer instructions by round mode (0.7.0, D2). A full round is the blind audit (the first code review, the evidence
// review); a delta round reviews what changed since the last reviewed tree and the findings still open.
const REVIEWER_FULL = 'This is a full review of the whole change, blind. Your goal: the truth about whether it meets its goals (the frozen criteria, `qualityBar`, the invariants) and what it broke. When `gate.passedOnThisTree` is true this is the evidence review: open every screenshot under `gate.screenshots` (exactly the files `gate.artifacts` lists) and record the sha256 of each one you viewed in `screenshotsInspected`; compare captures of the same state and record `anomalies` ("none seen", or each with the cause you found); a step marked `uncovered` needs `noEvidence: [{ step, reason }]` or a finding. When it is false, judge the diff and list no screenshots. Rules, skills, lessons, design-system hits, discovered issues, seams, supplemental validations, implementer reports and files outside the plan in this bundle are context for your judgement: cite them in findings; no verdict form is owed. Every finding is located (`path:line`) and rated honestly on the one scale (`severity`: high = a user, a tenant or the business is harmed or blocked: wrong or lost data, a broken flow, security, money, a visible defect on a primary screen; medium = degraded but usable; low = polish: wording, spacing, naming, style; a tenant, authorization or money defect is always high). The rating decides two things: a finding rated low never opens a round, and an unfixed high one is fixed in this delivery unless the person approves. `followUps` lists findings that already left this delivery: raise one again as a finding if it should not have. The engine decides what blocks: a frozen criterion the change fails (`criterion`), a regression on a line this attempt changed, a critical invariant (`invariant`), or a finding that cites none of these in a full round. Everything else is an observation. Early in your work write your plan into the closure file (`scope`: what you will cover; `expect: { minutes }`: how long you expect it to take) and add `findings` and `criteria` only when you have them, saying what you did not reach in `notReached`; end with a recorded closure (`wf review --closure`), since a round with none counts toward nothing, and a closure that names unreached scope is not counted as the full audit (`unreachedBefore` in a bundle lists scope earlier rounds did not reach). Write the closure to `reviewClosureFile`: { reviewer, scope, expect, findings: [{ id, severity, summary, status, evidence, work, family, criterion, invariant }], criteria: [{ id, evidence: { kind: test|screenshot|output|not-applicable|dropped-with-reason, ref, reason } }], screenshotsInspected, anomalies, noEvidence, notReached }.';
const REVIEWER_EVIDENCE_DELTA = 'This is the evidence review of a tree a gate passed on, as a delta: an earlier evidence review audited the whole change, so your scope is the diff since the last reviewed tree (`delta`), the findings still open (`openFindings`) and this gate\'s evidence. Your goal: every frozen criterion is proven by this gate\'s evidence, and the changes since the last review fix what they set out to fix and break nothing. Map every frozen criterion to its evidence in `criteria`. Open every screenshot under `gate.screenshots` that is not marked `inspectedBefore` (an earlier review saw those exact bytes; look again at any you judge useful) and record the sha256 of each one you viewed in `screenshotsInspected`; compare captures of the same state and record `anomalies` ("none seen", or each with the cause you found); a step marked `uncovered` needs `noEvidence: [{ step, reason }]` or a finding. Verify the open findings against the current code: `priorFindings: [{ round, id, status: fixed|verified-nonissue|open, evidence, severity }]`, every one that blocks and every observation you can settle (one with `claimedFixed` names the commit said to fix it); give `severity` when you rate one differently from its reviewer. A defect outside the changed lines is an observation (report it located, with its `severity` and a `family` where it repeats), never a blocker unless it fails a frozen criterion (`criterion`) or breaks a critical invariant (`invariant`). `followUps` lists findings that left this delivery: raise one again as a finding if it should not have. Early in your work write your plan into the closure file (`scope`; `expect: { minutes }`) and say what you did not reach in `notReached`; end with a recorded closure (`wf review --closure`). Write the closure to `reviewClosureFile`: { reviewer, scope, expect, findings, priorFindings, criteria: [{ id, evidence: { kind: test|screenshot|output|not-applicable|dropped-with-reason, ref, reason } }], screenshotsInspected, anomalies, noEvidence, notReached }.';
const REVIEWER_DELTA = 'This is a delta review: the diff since the last reviewed tree (`delta`: the diff commands, the changed files and their line ranges) and the findings still open (`openFindings`, each with whether it blocks). Your goal: whether the changes since then fix what they set out to fix and break nothing. Verify the open findings against the current code: `priorFindings: [{ round, id, status: fixed|verified-nonissue|open, evidence, severity }]`, every one that blocks and every observation you can settle (one with `claimedFixed` names the commit said to fix it); give `severity` when you rate one differently from its reviewer. A defect you notice outside the changed lines is an observation (report it located, with its `severity` and a `family` where it repeats), never a blocker unless it fails a frozen criterion (`criterion`) or breaks a critical invariant (`invariant`). When the bundle has `sweeps`, a family proof (a command and the result it must give) is evidence: run it. Early in your work write your plan into the closure file (`scope`: what you will cover; `expect: { minutes }`: how long you expect it to take) and add `findings` and `criteria` only when you have them, saying what you did not reach in `notReached`; end with a recorded closure (`wf review --closure`). Write the closure to `reviewClosureFile` with `criteria: []`.';

// Findings grouped by `family` (a stable key a reviewer gives a defect pattern); a finding with none is its own group.
export function familiesOf(findings) {
  const by = new Map();
  for (const f of findings) {
    const key = typeof f.family === 'string' && f.family.trim() ? f.family.trim() : null;
    const group = by.get(key ?? `${f.round}:${f.id}`) ?? { family: key, findings: [] };
    group.findings.push({ ref: `${f.round}:${f.id}`, round: f.round, id: f.id, severity: f.severity ?? null, summary: f.summary ?? '', evidence: f.evidence ?? null, work: f.work ?? null });
    by.set(key ?? `${f.round}:${f.id}`, group);
  }
  return [...by.values()];
}

const describeScope = (s) => [s.addedCriteria?.length ? `criteria added: ${s.addedCriteria.join(', ')}` : null, s.changedCriteria?.length ? `criteria changed: ${s.changedCriteria.join(', ')}` : null, s.addedRepos?.length ? `repos added: ${s.addedRepos.join(', ')}` : null, s.work ? 'work items replaced' : null].filter(Boolean).join('; ');

function impactMapFor(root, cfg, state, role, queryResults = null) {
  const recorded = Object.fromEntries(Object.entries(allRecordedQueries(state)).map(([id, q]) => [id, { query: q, hits: [state.impact.results?.[id], ...state.impact.addenda.map((a) => a.results?.[id])].find(Boolean)?.hits ?? null }]));
  const map = { survey: state.impact.survey, impact: state.impact.impact, addenda: state.impact.addenda, queries: recorded, rerun: `wf impact run --attempt ${state.id}` };
  if (role !== 'reviewer') return map;
  const inv = inventory(state);
  return { ...map, inventory: inv, derived: deriveFromDiff(root, cfg, state, { queryResults }) };
}

function sweepsForReviewer(root, cfg, state) {
  const { answers } = sweepAnswers(state, { sinceReview: true });
  if (!answers.length) return undefined;
  return answers.map((s) => {
    // A sweep that cannot be re-run refuses the handoff (0.5.0 second review, fail-open: it was shown as no hits now).
    const now = rerun(root, cfg, state, { [s.id]: s.query })[s.id];
    return { id: s.id, finding: s.finding, findings: s.findings ?? [s.finding], family: s.family ?? null, why: s.why, query: s.query, hitsAtHandoff: s.hits, filesAtHandoff: s.files, hitsNow: now?.hits ?? null, filesNow: now?.files ?? null, answer: s.answer };
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

// The same, with the adapter the gate ran with (committed at the attempt's base). Acceptance and delivery decide from it,
// so an unreadable adapter refuses (0.5.0 adversarial review: it read as "nothing uncovered").
export function evidenceSteps(root, state) {
  return artifactsByStep(state, gateAdapter(root, state));
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

// `moved`: a split took the finding to a sibling attempt in the same batch (engine/ledger.mjs withMoved).
const settled = (status) => ['fixed', 'verified-nonissue', 'moved'].includes(status);
const roundKey = (r) => r.handoff ?? `reviewer:${r.reviewer}`;

// Findings earlier review rounds left open and no later round has verified, oldest first (engine/review-policy.mjs):
// each carries its family and whether it blocks. A full round records its own findings blind and sees these only after;
// a delta round is handed them up front. Acceptance needs each one that blocks verified (fixed or verified-nonissue,
// with evidence) by a round after the one that found it.
export function earlierOpenFindings(state, currentHandoff) {
  return openAcrossRounds(state, currentHandoff).flatMap((f) => {
    const d = dispositionOf(state, f.ref);
    if (d && d.choice !== 'fixed') return [];
    return [{ round: f.round, id: f.id, severity: f.severity ?? null, placement: placementLevel(state, f), summary: f.summary ?? '', evidence: f.evidence ?? null, work: f.work ?? null, family: f.family ?? null, blocks: f.classified.blocks, ...(d ? { claimedFixed: { repo: d.repo, commit: d.commit } } : {}) }];
  });
}

// The design-system hits of a delta round: those on the files changed since the last reviewed tree.
function deltaDesign(checks, deltaInfo) {
  if (!checks || !deltaInfo) return checks;
  const changed = new Set(Object.entries(deltaInfo.changed ?? {}).flatMap(([repo, files]) => files.map((f) => `${repo}:${f}`)));
  return { ...checks, hits: checks.hits.filter((h) => changed.has(`${h.repo}:${h.file}`)) };
}

// Every screenshot sha256 a recorded review listed as inspected, on any tree.
function inspectedEver(state) {
  return new Set((state.reviews ?? []).flatMap((r) => (Array.isArray(r.closure?.screenshotsInspected) ? r.closure.screenshotsInspected : [])));
}

// Findings that left the delivery, for the reviewer to see (`followUps`).
function followUpsOf(state) {
  const open = new Map(openAcrossRounds(state).map((f) => [f.ref, f]));
  return (state.scopeDecisions ?? []).filter((d) => ['ticketed', 'moved', 'deferred'].includes(d.choice)).flatMap((d) => (d.keys ?? []).map((ref) => ({ ref, went: d.choice, ticket: d.ticket?.url ?? null, sibling: d.sibling ?? null, reason: d.reason ?? null, summary: open.get(ref)?.summary ?? d.summaries?.[ref] ?? null, severity: open.get(ref)?.severity ?? null })));
}

// The earlier rounds' blocking findings a round must have verified.
function unverifiedPrior(state, review) {
  const required = earlierBlocking(state, roundKey(review));
  const verified = new Map((review.closure.priorFindings ?? []).map((p) => [`${p.round}:${p.id}`, p]));
  return required.filter((f) => {
    const v = verified.get(f.ref);
    if (v && v.status === 'open' && v.evidence && severityLevel(v.severity) === 'low' && !f.classified.criterion && !f.classified.invariant) return false;
    return !v || !settled(v.status) || !v.evidence;
  }).map((f) => ({ round: f.round, id: f.id, severity: f.severity ?? null, summary: f.summary ?? '', evidence: f.evidence ?? null, work: f.work ?? null, family: f.family ?? null }));
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
    mode: h.mode ?? 'full',
    findings: (Array.isArray(closure?.findings) ? closure.findings : []).map((f) => ({ id: f?.id ?? null, severity: f?.severity ?? null, status: f?.status ?? null, category: f?.category ?? null, family: f?.family ?? null, blocks: f?.classified?.blocks ?? null })),
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
// implementer is closed, and its sub-agents (the transcripts the harness recorded as started under it) are attributed.
// Implementer handoffs of this attempt not yet closed with `wf handoff close`. Ledgers from before 0.5.0 have no
// implementer events, so nothing of theirs is open. A batch has no implementers of its own: each member was reviewed
// before batching, its implementers closed or the override recorded in its ledger.
export function openImplementersOf(root, state) {
  return (state.implementers ?? []).filter((x) => !x.closedAt).map((x) => ({ attempt: state.id, agent: x.agent, work: x.work ?? null }));
}
const implementerLabel = (x) => `${x.agent}${x.work ? ` (${x.work})` : ''}`;

export function closeImplementer(root, options) {
  const state = openState(root, options);
  if (!options.agent || options.agent === true) throw new WfError('--agent <implementer id> is required');
  const agent = String(options.agent);
  const open = state.implementers.filter((x) => x.agent === agent && !x.closedAt).at(-1);
  if (!open) throw refuse(`no open implementer \`${agent}\` on ${state.id}${state.implementers.length ? ` (open: ${state.implementers.filter((x) => !x.closedAt).map((x) => x.agent).join(', ') || 'none'})` : ''}`);
  const outcome = options.outcome && options.outcome !== true ? String(options.outcome) : 'done';
  if (!['done', 'stopped', 'failed'].includes(outcome)) throw new WfError('--outcome must be done, stopped or failed');
  const heads = treeHashes(state);
  // A `done` close says the tree is settled for a review (I-23): uncommitted work means the implementer is not done.
  const dirty = Object.entries(heads).filter(([, t]) => String(t).includes('+dirty')).map(([n]) => n);
  // Bookkeeping since 0.7.0 (engine/owner.mjs): the owner agent closes the implementer as itself. The reviewer stays bound
  // to the tree it is handed, whoever closes.
  if (outcome === 'done' && dirty.length) throw refuse(`${agent} is not done: uncommitted changes in ${dirty.join(', ')}`, `have the implementer commit its work, then close it; for an implementer you stopped, \`wf handoff close --agent ${agent} --outcome stopped\``);
  // 0.7.0: the implementer's own report (its bundle's `implementerReportFile`) is how what it left reaches the ledger. Every
  // `left` item becomes a discovered issue, so nothing it saw is silently dropped, whichever harness ran it. Named failure
  // behind it: the engine scanned one harness's transcripts for prose about unfixed issues; the other's implementers went unchecked.
  const handed = state.handoffs.filter((x) => x.role === 'implementer' && x.agent === agent).at(-1);
  const report = readImplementerReport(handed?.reportFile ?? null, agent);
  if (outcome === 'done' && obligationSince(state, '0.7.0') && report.problem) throw refuse(`${agent} has not reported: ${report.problem}`, `the implementer writes its report to ${handed?.reportFile ?? 'its bundle\'s implementerReportFile'} ({ implementer, summary, approach, expect: { minutes }, ran, proofs, left }); then close it again`, { id: 'handoff:report-missing' });
  const commits = {};
  for (const [name, r] of Object.entries(state.repos)) {
    const from = String(open.heads?.[name] ?? '').split('+')[0];
    const n = from ? git(r.worktree, ['rev-list', '--count', `${from}..HEAD`], { allowFail: true }) : null;
    commits[name] = n === null || n === undefined || n === '' ? null : Number(n);
  }
  const h = state.handoffs.filter((x) => x.role === 'implementer' && x.agent === agent).at(-1);
  let children = [];
  const startedAgents = h ? optional(findHost(h.runtime), 'children') : null;
  if (startedAgents) {
    try {
      children = startedAgents(h, { home: home() });
    } catch {}
  }
  // Sub-agent metadata comes from files any agent can write: bounded before it enters the ledger.
  const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
  children = children.slice(0, 200).map((c) => ({ agentId: clip(c.agentId, 200), name: clip(c.name, 200), agentType: clip(c.agentType, 200), parentAgentId: clip(c.parentAgentId, 200), depth: Number.isInteger(c.depth) ? c.depth : null, description: clip(c.description, 500) }));
  if (children.length) append(root, state.id, 'subagents.attributed', { handoff: open.handoff, children }, actor(options));
  if (report.value) {
    const r = report.value;
    append(root, state.id, 'implementer.report', { handoff: open.handoff, agent, file: handed.reportFile, sha256: report.sha256, summary: r.summary, approach: r.approach ?? null, expect: r.expect ?? null, ran: r.ran ?? [], proofs: r.proofs ?? [], left: r.left ?? [] }, actor(options));
    let next = (loadState(root, state.id).discovered?.length ?? 0) + 1;
    for (const l of r.left ?? []) append(root, state.id, 'discovered.added', { id: `D${next++}`, summary: `left by ${agent}: ${l.what}`, kind: 'defect', severity: typeof l.severity === 'string' && l.severity.trim() ? l.severity.trim() : null, ...(typeof l.invariant === 'string' && l.invariant.trim() ? { invariant: l.invariant.trim() } : {}), where: l.where ?? null, foundBy: agent, blockedBy: null, why: l.why ?? null }, actor(options));
  }
  append(root, state.id, 'implementer.closed', { handoff: open.handoff, agent, outcome, heads, commits }, actor(options));
  return { state: loadState(root, state.id), handoff: open.handoff, outcome, commits, children };
}

// The implementer's report, validated: { value, sha256 } or { problem }. Fields are bounded before they reach the ledger.
function readImplementerReport(file, agent) {
  if (!file) return { problem: 'no report file was handed' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { problem: `no report at ${file}` };
  }
  if (raw.length > 256 * 1024) return { problem: 'the report is larger than 256 KB' };
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    return { problem: 'the report is not JSON' };
  }
  const str = (v, n = 4000) => (typeof v === 'string' ? v.slice(0, n) : null);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { problem: 'the report is not a JSON object' };
  // Refusal audit of 0.7.0: only an unreadable report refuses the close (then nothing it left can be recorded); its shape
  // is read leniently, because each slip cost a round trip to an implementer that had already finished.
  // The file is the one handed to this handoff (its path names it), so a report that names its author differently is still
  // this implementer's (final review of 0.7.0: a subagent that named itself otherwise cost a resend).
  const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const minutes = Number(r.expect?.minutes);
  const leftItem = (x) => (typeof x === 'string' ? { what: x } : x && typeof x === 'object' ? x : null);
  const value = {
    summary: str(r.summary) ?? '(no summary)', approach: str(r.approach), expect: expectOf(Number.isFinite(minutes) ? { minutes } : null),
    ran: listOf(r.ran).slice(0, 100).map((x) => ({ command: str(x?.command, 500) ?? str(x, 500), result: str(x?.result, 500) })),
    proofs: listOf(r.proofs).slice(0, 100).map((x) => ({ family: str(x?.family, 200), command: str(x?.command, 500) ?? str(x, 500), expected: str(x?.expected, 500) })),
    // An item it left is never dropped: one with no `what` keeps its `why` or `where` as the summary.
    left: listOf(r.left).map(leftItem).filter(Boolean).slice(0, 100).map((x) => ({ what: str(x.what, 1000) ?? str(x.why, 1000) ?? str(x.where, 1000) ?? 'an issue the implementer left (no description)', where: str(x?.where, 500), why: str(x?.why, 1000), severity: str(x?.severity, 40), invariant: str(x?.invariant, 300) })),
  };
  return { value, sha256: sha256(raw) };
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
  const latestReviewer = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  const reviewerHandoff = latestReviewer?.reviewGroup ? state.handoffs.find(h => h.role === 'reviewer' && h.agent === closure.reviewer && isCurrentReviewer(state, h)) : latestReviewer;
  if (!reviewerHandoff) throw refuse('no reviewer handoff: run `wf handoff reviewer --agent <id>`');
  if (closure.reviewer !== reviewerHandoff.agent) throw refuse(`closure reviewer \`${closure.reviewer}\` is not the reviewer handed this attempt (\`${reviewerHandoff.agent}\`)`);
  if (!Array.isArray(closure.findings) || !Array.isArray(closure.criteria)) throw new WfError('closure needs `findings` and `criteria` lists');
  // A reviewer's stated expectation is optional context: one the engine cannot read is dropped, never a reason to refuse a
  // round's closure (refusal audit of 0.7.0).
  if (expectProblems(closure.expect, ROLE_EXPECT, 'expect').length) closure = { ...closure, expect: undefined };
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
  // 0.7.0, named failure: the closure was checked against the reviewer's transcript (agent type, start time and exactly
  // the printed start line, then a successful read of every rule and skill document). It refused 4 rounds in the field,
  // all benign, and it made the engine parse transcripts for authority, which DESIGN.md principle 1 forbids. The
  // fresh-reviewer rule is kept by ledger names (the reviewer is not the owner, the planner, an implementer or an earlier
  // round's reviewer: `wf handoff reviewer`), and the session id of an engine-launched round (`wf handoff run`) stays on
  // the handoff. Telemetry may still read transcripts; nothing here does.
  // A round the engine launched (`wf handoff run`) says so, from the engine's own launch record; one whose launch failed is
  // refused (the engine knows it produced nothing), whatever a transcript might show.
  if (reviewerHandoff.launch?.status === 'failed') {
    refusedRound(root, state, reviewerHandoff, closure, 'launch-failed', 'the engine launch of this reviewer failed');
    throw refuse(`the engine launch of reviewer ${reviewerHandoff.agent} failed; no closure is taken from it`, `create a fresh reviewer handoff: \`wf handoff reviewer --agent <new id>\``);
  }
  const provenance = { status: reviewerHandoff.launch ? 'engine-launched' : 'ledger-names' };
  // Named failure (0.5.0 second review, fail-open): an unreadable bundle read as {}, so every check that depends on
  // what the reviewer was handed (impact map, screenshots, discovered issues, rules) was skipped. It refuses instead.
  const mode = reviewerHandoff.mode ?? 'full';
  let handed;
  try {
    handed = JSON.parse(fs.readFileSync(reviewerHandoff.bundle, 'utf8'));
  } catch (error) {
    throw refuse(`the reviewer's bundle ${reviewerHandoff.bundle} cannot be read (${error.code ?? error.message}); no closure is judged without it`, `\`wf verify --attempt ${state.id}\`; hand a fresh reviewer the tree`);
  }
  if (reviewerHandoff.reviewGroup && hashFile(reviewerHandoff.bundle) !== reviewerHandoff.reviewGroup.bundleSha256) throw refuse('review group bundle changed from its frozen hash; create a fresh group');
  if (reviewerHandoff.reviewGroup && reviewSnapshot(state) !== reviewerHandoff.reviewGroup.snapshot) throw refuse('review group obligations changed; create a fresh group on the new snapshot');
  if (state.impact && mode === 'full' && !handed.impactMap && reviewerHandoff.reviewGroup?.mode !== 'scoped') throw refuse(`the reviewer's bundle has no impact map although ${state.id} recorded one; no closure is judged without it`, 'hand a fresh reviewer the tree: `wf handoff reviewer --agent <new id>`');
  // 0.7.0 (goals, not forms): a group's facts are checked (every part recorded on the current snapshot, parts immutable,
  // the integration closure after them, the criteria evidence); the coverage lists (`filesReviewed` per file,
  // `interfacesReviewed` per interface, `partReviews` citing each part's hash) measured compliance with a form, not
  // defects, and are context when given (final review of 0.7.0).
  if (reviewerHandoff.reviewGroup) {
    findingIds(closure);
    if (reviewerHandoff.reviewGroup.mode === 'scoped') {
      // A part is the scoped reviewer's findings; the integration reviewer owns the criteria and the earlier rounds.
      closure = { ...closure, criteria: [], priorFindings: undefined };
      if ((state.reviewParts ?? []).some(p => p.handoff === reviewerHandoff.bundle)) throw refuse('this scoped closure is already recorded; parts are immutable');
      return withEvidenceTransaction(root, state.id, () => {
      const current = loadState(root, state.id);
      if (!isCurrentReviewer(current, reviewerHandoff) || reviewSnapshot(current) !== reviewerHandoff.reviewGroup.snapshot || canonical(treeHashes(current)) !== canonical(reviewerHandoff.tree)) throw refuse('review group changed before recording the scoped closure');
      if (current.reviewParts.some(p => p.handoff === reviewerHandoff.bundle)) throw refuse('this scoped closure is already recorded; parts are immutable');
      const raw = keepRaw(root, state.id, `review/part-${state.handoffs.indexOf(reviewerHandoff) + 1}.raw.json`, closureText);
      append(root, state.id, 'review.part.recorded', { handoff: reviewerHandoff.bundle, group: reviewerHandoff.reviewGroup.id, closure, raw,
        provenance: provenance.status, session: reviewerHandoff.session ?? null, tree: reviewerHandoff.tree }, closure.reviewer);
      seal(append, { root, id: state.id });
      return { state: loadState(root, state.id), part: true, reveal: null, toVerify: [] };
      });
    }
    const group = currentReviewGroup(state), parts = (state.reviewParts ?? []).filter(p => p.group === group.id);
    for (const part of parts) readEvidenceFile(root, state.id, { path: part.raw.file, sha256: part.raw.sha256 });
    closure = mergeParts(group, parts, closure);
    assignedVerdicts(state.criteria.map(c => c.id), closure.criteria, 'id', 'criteria');
    const incomplete = closure.criteria.filter(c => !EVIDENCE_KINDS.has(c.evidence?.kind) ||
      (['not-applicable', 'dropped-with-reason'].includes(c.evidence?.kind) ? !String(c.evidence.reason ?? '').trim() : !String(c.evidence?.ref ?? '').trim()));
    if (incomplete.length) throw refuse('group criterion evidence is incomplete: ' + incomplete.map(c => c.id).join(', '));
  }
  // Every lesson injected into the reviewer's bundle needs a verdict before the closure is recorded.
  // 0.7.0 (goals, not forms): the reviewer's goal is the truth about whether the change meets its goals and what it broke.
  // Verdict forms for project rules, lessons, design-system hits, discovered items, seams, supplemental validations and
  // files outside the plan are context in the bundle, not obligations: they measured compliance with the form, not
  // defects, and a third of reviewer commands went to them. What stays: criteria evidence, located findings, prior
  // findings verified, anomalies when screenshots were handed, every gate screenshot inspected.
  // Every design-system hit in the reviewer's bundle needs a verdict before the closure is recorded.
  // Every issue found during the ticket (I-18) and every seam to a repo added for a fix (I-19) needs a verdict.
  const hv = reportedIssueVerdicts(handed.historicalReports ?? [], closure, state);
  if (hv.problems.length) throw refuse('closure refused: historical report observations have no valid verdict:\n  - ' + hv.problems.join('\n  - '), 'add reportedIssues: [{ id, verdict: fixed|verified-nonissue|open, evidence, fixedIn, repo, rationale, finding }]; judge the current code, never edit the old transcript');
  const av = reviewAnomalies(handed.gate, closure);
  if (av.length) throw refuse(`closure refused: the anomalies seen in the screenshots are not accounted for:\n  - ${av.join('\n  - ')}`, `add \`anomalies\` to the closure: "none seen" after comparing the captures, or [{ "screenshots": ["<sha256>"], "observation": "<what differs>", "cause": "<the cause you found>", "evidence": "<file:line or data you checked>" }] or, when it is a defect (a value no test pins included), { ..., "finding": "<your finding id>" }; then \`wf review --closure <file>\` again`);
  // Commit, then reveal: the first closure of a full round is blind. Earlier rounds' findings are shown only after it is
  // recorded, and a later closure of the same round may only add their verification. A delta round is handed them up
  // front (`openFindings`), so it answers them in the one closure.
  const round = reviewerHandoff.bundle;
  const delta = mode === 'delta';
  if (delta) {
    const owed = earlierBlocking(state, round).filter((f) => !(closure.priorFindings ?? []).some((p) => p?.round === f.round && p?.id === f.id && ['fixed', 'verified-nonissue', 'open'].includes(p.status) && String(p.evidence ?? '').trim()));
    if (owed.length) throw refuse(`closure refused: ${owed.length} open finding(s) the bundle handed you have no verdict: ${owed.map((f) => f.ref).join(', ')}`, 'add `priorFindings: [{ "round": "<reviewer id>", "id": "F1", "status": "fixed|verified-nonissue|open", "evidence": "path:line" }]` for each finding listed under `openFindings` that blocks, and run `wf review --closure <file>` again', { id: 'review:delta-prior-missing' });
  }
  // The engine classifies every finding against the tree and round it was recorded on (engine/review-policy.mjs); the
  // reviewer's own `classified` field is replaced.
  closure = stampClosure(state, closure, { mode, since: reviewerHandoff.deltaFrom ?? null });
  const revealed = (state.reviews ?? []).find((r) => r.handoff === round && r.revealed);
  if (!revealed && !delta && closure.priorFindings?.length) throw refuse('`priorFindings` are listed only after your own blind closure is recorded; record the closure without them first');
  if (revealed && canonical(stripStamp(revealed.closure.findings)) !== canonical(stripStamp(closure.findings))) throw refuse('your own findings were recorded blind and cannot change after earlier rounds were revealed; only add `priorFindings`');
  if (revealed && canonical(revealed.closure.reportedIssues ?? []) !== canonical(closure.reportedIssues ?? [])) throw refuse('historical report verdicts were recorded blind and cannot change after earlier rounds were revealed; only add priorFindings');
  // Only findings that block are revealed (and must be verified); observations wait for a ticket, a move or a fix.
  const revealNow = !revealed && !delta && earlierBlocking(state, round).length > 0;
  return withEvidenceTransaction(root, state.id, () => {
  const current = loadState(root, state.id);
  if (canonical(treeHashes(current)) !== canonical(reviewerHandoff.tree)) throw refuse('the worktree changed before recording the review closure');
  if (reviewerHandoff.reviewGroup && (!isCurrentReviewer(current, reviewerHandoff) || reviewSnapshot(current) !== reviewerHandoff.reviewGroup.snapshot)) throw refuse('review group changed before recording the integration closure');
  const n = state.reviews.filter((r) => r.handoff === round).length + 1;
  const tag = `${String(state.handoffs.indexOf(reviewerHandoff) + 1).padStart(2, '0')}-${n}`;
  const raw = keepRaw(root, state.id, `review/closure-${tag}.raw.json`, closureText);
  const dest = path.join(attemptDir(root, state.id), 'review', `closure-recorded-${state.handoffs.length}.json`);
  writeJson(dest, closure);
  // The closure is for the tree the reviewer was handed. It inspected gate evidence only if a passing gate on that tree
  // was in its bundle (0.1.5 and earlier handed a reviewer only after such a gate, so their handoffs carry no field).
  const gateEvidenceInspected = 'gate' in reviewerHandoff ? Boolean(reviewerHandoff.gate) : true;
  let reviewerModel = optional(findHost(reviewerHandoff.runtime), 'roleModel')?.(reviewerHandoff, { home: home() }) ?? null;
  append(root, state.id, 'review.recorded', { closure, file: dest, raw, handoff: round, mode, revealed: Boolean(revealed) || revealNow, provenance: provenance.status, session: reviewerHandoff.session ?? null, tree: reviewerHandoff.tree, gateRun: reviewerHandoff.gate ?? null, gateEvidenceInspected, handoffTree: reviewerHandoff.tree, handoffPatch: reviewerHandoff.patch, reviewerModel, impactGaps: (closure.findings ?? []).filter((f) => f?.category === 'impact-gap').length }, closure.reviewer);
  append(root, state.id, 'review.round', roundData(state, reviewerHandoff, closure, { outcome: 'recorded', model: reviewerModel, revealed: Boolean(revealed) }), null);
  const after = loadState(root, state.id);
  const toVerify = delta ? [] : unverifiedPrior(after, after.review);
  let reveal = null;
  if (toVerify.length) {
    reveal = path.join(root, '.wf-worktrees', state.id, '_review', `prior-findings-${tag}.json`);
    safeWriteJson(root, reveal, { note: 'Findings earlier review rounds left open. Check each against the current code; add priorFindings to your closure.', findings: toVerify });
  }
  seal(append, { root, id: state.id });
  return { state: after, reveal, toVerify };
  });
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
// After an evidence review raised findings, the fixes go straight to the gate when the tree is exactly what the implementers
// handed after that review left (each closed done): the evidence review after the gate is a delta that verifies every fix
// and the new evidence in one round. Named failure (second final review of 0.7.0): each post-gate fix cost a code-review
// delta, a gate and an evidence delta, and only the person could merge the two reviews (I-27's order rule).
export function evidenceFixReady(state) {
  const r = state.review;
  if (!r) return false;
  const h = (state.handoffs ?? []).find((x) => x.bundle === r.handoff);
  if (!h || !(h.round === 'evidence-review' || (!h.round && h.gate))) return false;
  // Only to fix what that review raised: it found blocking findings, and no scope was added since (verification of the
  // second final review: new scope went to the gate without a code review).
  if (!blockingIn(state, r).length) return false;
  if ((state.criteriaAmendments ?? []).some((a) => a.at > r.at)) return false;
  const after = (state.implementers ?? []).filter((x) => x.openedAt > r.at);
  if (!after.length || after.some((x) => !x.closedAt || x.outcome !== 'done')) return false;
  const last = [...after].sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt))).at(-1);
  try {
    const heads = treeHashes(state);
    return Object.entries(heads).every(([repo, t]) => !String(t).includes('+dirty') && String(t).split('+')[0] === String(last.closedHeads?.[repo] ?? '').split('+')[0]);
  } catch {
    return false;
  }
}

export function gateOrderProblems(state) {
  const problems = [];
  const busy = reviewInFlight(state);
  if (busy) problems.push(`reviewer ${busy.agent} was handed this tree and has recorded no closure: review and gate never run side by side; wait for its closure`);
  const r = state.review;
  const addedAt = state.validations?.at(-1)?.at;
  if (addedAt && (!r || r.at <= addedAt)) problems.push('required supplemental validation was added or corrected after the last code review: run a fresh code review before the gate');
  if (!r || !reviewCovers(state, r)) {
    if (!busy && !evidenceFixReady(state)) problems.push(`no review round covers the current tree: run the code review first (\`wf handoff reviewer --agent <new id>\`); the gate runs once a round on this tree comes back clean`);
    return problems;
  }
  const open = openFindings(r, state);
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
    if (!reason) throw refuse(`the gate runs after a clean code review, never beside or before it:\n  - ${problems.join('\n  - ')}`, `follow the order (\`wf resume\` names the next step); only the owner skips it: \`wf gate --reason "<why>"\` asks the owner to confirm the skip with \`wf approve\`, then records the override in the ledger`);
    // 0.7.0: skipping a check is reserved (engine/owner.mjs); the person confirms it for this tree with wf approve.
    const approval = requireYes(root, state, { kind: 'override-gate', key: `gate:${state.id}:${hashValue(treeHashes(state))}`, summary: `run the gate out of the order of work (${reason}): ${problems.join('; ')}`, what: 'running the gate out of the order of work', options });
    append(root, state.id, 'gate.override', { reason, problems, tree: treeHashes(state), decision: approval.decision }, actor(options));
  };
}

// I-12. Named failure: a cross-locale difference in screenshot numbers was dismissed as cosmetic without checking; it
// came from shared test data and hid vacuous assertions (tests that passed whatever the value was). A reviewer handed
// screenshots now accounts for what it saw: `anomalies` is "none seen" after comparing the captures (counts, dates,
// names, totals, between captures of the same state and against the criteria), or each anomaly with the screenshots it
// was seen in and either a finding, or the investigated cause with its evidence and the test assertion that pins the
// value (a value no test pins is a test gap, so a finding). No wording is judged. The test assertion that pins the value
// (`assertions`) is context when given, not a required field (second final review of 0.7.0: a form on every evidence round);
// the investigation to a cause, with its evidence, is what I-12 needs.
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
  }
  return problems;
}

// 0.1.5 and earlier recorded no flag: their reviewers were handed the attempt only after a passing gate on that tree.
const reviewedAfterGate = (r) => r.gateEvidenceInspected ?? true;
// The open findings of a recorded review that block (engine/review-policy.mjs): observations never open a round.
const openFindings = (r, state) => blockingIn(state ?? {}, r);

const EVIDENCE_KINDS = new Set(['test', 'screenshot', 'output', 'not-applicable', 'dropped-with-reason']);

// Criteria the recorded round `r` did not judge in their present form. `added`: current criteria its closure maps no
// evidence for (an amendment added them after the round was handed; `wf accept` refuses these for every attempt).
// `changed`: criteria an amendment re-worded after the round was handed, which the round judged in their earlier wording;
// accepted on the old mapping, a changed criterion shipped unproven (I-107, same cause). The second list is an obligation
// of 0.7.4 (D7), so it is empty for an attempt admitted earlier.
export function criteriaAfterReview(state, r) {
  const handed = (state.handoffs ?? []).find((x) => x.bundle === r?.handoff);
  const since = handed?.at ?? r?.at ?? '';
  const mapped = new Set((r?.closure?.criteria ?? []).map((c) => c.id));
  const current = new Set((state.criteria ?? []).map((c) => c.id));
  const added = [...current].filter((id) => !mapped.has(id));
  const changed = obligationSince(state, '0.7.4') ? [...new Set((state.criteriaAmendments ?? []).filter((a) => a.at > since).flatMap((a) => a.changes?.changed ?? []))].filter((id) => current.has(id) && !added.includes(id)) : [];
  return { added, changed, since };
}

// An attempt admitted before 0.7.4 keeps its acceptance through an amendment (D7). The criteria such an amendment added or
// changed after the acceptance, so `wf resume` can say that delivery would ship them with no review having mapped them.
export function amendedAfterAcceptance(state) {
  if (!state.accepted || state.delivery?.completedAt) return [];
  const current = new Set((state.criteria ?? []).map((c) => c.id));
  return [...new Set((state.criteriaAmendments ?? []).filter((a) => a.at > state.accepted.at).flatMap((a) => [...(a.changes?.added ?? []), ...(a.changes?.changed ?? [])]))].filter((id) => current.has(id));
}

export function acceptReview(root, options) {
  const state = openState(root, options);
  const r = state.review;
  if (!r) throw refuse('no review recorded: `wf review --closure <file>`');
  const problems = [];
  if (authorsOf(root, state).has(r.closure.reviewer)) problems.push(`reviewer ${r.closure.reviewer} also planned, wrote or owns this change`);
  // Only a finding that blocks holds acceptance; an observation is fixed, ticketed or moved before delivery.
  const blocking = new Set(openFindings(r, state).map((f) => f.id));
  for (const f of r.closure.findings) {
    if (blocking.has(f.id)) problems.push(`finding ${f.id} is ${f.status ?? 'open'} and blocks: ${classifyFinding(state, f).reason}`);
    if (!f.evidence) problems.push(`finding ${f.id} has no evidence`);
  }
  const mapped = new Map(r.closure.criteria.map((c) => [c.id, c]));
  const late = criteriaAfterReview(state, r);
  const lateAmended = new Set((state.criteriaAmendments ?? []).filter((a) => a.at > late.since).flatMap((a) => [...(a.changes?.added ?? []), ...(a.changes?.changed ?? [])]));
  for (const c of state.criteria ?? []) {
    const m = mapped.get(c.id);
    if (!m) {
      problems.push(`criterion ${c.id} is not mapped to evidence${lateAmended.has(c.id) ? ' (an amendment added or changed it after this review round was handed): hand a fresh reviewer, which maps every criterion to the gate evidence' : ''}`);
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
    if (!collected.some((a) => [a.sha256, a.source, a.path].includes(ref))) problems.push(`criterion ${c.id}: screenshot \`${ref}\` is not one the gate collected for this ticket; reference a file in the bundle's \`gate.artifacts\` by sha256 or source path (captures made by hand are brought in with \`wf captures import\`, and the evidence review is then handed again)`);
  }
  const verdicts = noEvidenceVerdicts(evidenceSteps(root, state), r.closure);
  for (const v of verdicts) {
    if (!v.reason && !v.finding) problems.push(`step ${v.step}: its artifacts globs (${v.globs.join(', ')}) matched nothing though this ticket changed ${v.changed} file(s) in its package; the reviewer gives a verdict: \`noEvidence: [{ "step": "${v.step}", "reason": "<why no capture is needed>" }]\` in the closure, or a finding`);
  }
  // I-18: every issue found during the ticket was judged by this round, and none was found open.
  const reviewedBundle = readBundle(r.handoff);
  const reportedNow = reportsForReview(state);
  const reportedIds = new Set((reviewedBundle?.historicalReports ?? []).map((r) => r.id));
  if (!obligationSince(state, '0.7.0')) for (const r of reportedNow.historical) if (!reportedIds.has(r.id)) problems.push('historical report ' + r.id + ' was not handed to this reviewer; hand the tree to a fresh reviewer');
  if (!obligationSince(state, '0.7.0')) for (const r of reportedNow.current) problems.push(r.agent + ': current report leaves unrecorded unresolved work; record and fix it before review');
  const hv = reportedIssueVerdicts(reviewedBundle?.historicalReports ?? [], r.closure, state);
  problems.push(...hv.problems);
  for (const v of hv.verdicts) if (v.verdict === 'open') problems.push('historical report ' + v.id + ': reviewer found it open; fix its finding through an implementer, then start a fresh review');
  const handedIds = new Set((reviewedBundle?.discovered ?? []).map((d) => d.id));
  // I-19: every repo added for a fix had its seam judged on both sides by this round.
  const handedRepos = new Set((reviewedBundle?.addedRepos ?? []).map((a) => a.repo));
  for (const a of state.addedRepos ?? []) if (!handedRepos.has(a.repo)) problems.push(`repo ${a.repo} was added after this review round was handed; hand the tree to a fresh reviewer`);
  const shots = collected.map((s) => s.sha256);
  // A screenshot whose bytes an earlier recorded review already inspected need not be opened again (the same sha256 is the
  // same image). Named failure (second final review of 0.7.0): every evidence review re-opened every screenshot, so each
  // gate cycle re-sampled unchanged screens for new findings.
  const inspected = inspectedEver(state);
  const unseen = shots.filter((h) => !inspected.has(h));
  if (unseen.length) problems.push(`${unseen.length} gate screenshot(s) not inspected by the reviewer (the gate's expanded artifacts globs matched them for this ticket): ${collected.filter((a) => !inspected.has(a.sha256)).slice(0, 5).map((a) => a.source ?? a.path).join(', ')}${unseen.length > 5 ? ' …' : ''}`);
  // Named failure (I-107): a re-worded criterion kept the evidence a reviewer mapped to its earlier wording.
  for (const id of late.changed) problems.push(`criterion ${id} was re-worded by an amendment after this review round was handed, so the round judged its earlier wording: hand a fresh reviewer, which maps every criterion to the gate evidence`);
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
  // Verdicts a reviewer chose to give are recorded with the acceptance (and a lesson verdict `finding` counts as a
  // recurrence); none is required (0.7.0, goals not forms).
  const optional = (fn, ...args) => { try { return fn(...args); } catch { return { verdicts: [], problems: [] }; } };
  const rv = optional(ruleVerdicts, readBundle(r.handoff)?.rules ?? [], r.closure);
  const ov = optional(outsideVerdicts, readBundle(r.handoff)?.outsidePlan ?? [], r.closure, state.criteria);
  const lv = optional(lessonVerdicts, readBundle(r.handoff)?.lessons?.apply ?? [], r.closure);
  const dv = optional(designVerdicts, readBundle(r.handoff)?.designSystem?.hits ?? [], r.closure);
  const xv = optional(discoveredVerdicts, reviewedBundle?.discovered ?? [], r.closure);
  const sv = optional(seamVerdicts, reviewedBundle?.addedRepos ?? [], r.closure);
  if (problems.length) throw refuse(`review not accepted:\n  - ${problems.join('\n  - ')}`);
  // Nothing verified when this command opened the attempt may have changed while it decided.
  const moved = assertUnchanged(root, state.id);
  if (moved.length) throw refuse(`review not accepted: the evidence changed while it was checked:\n  - ${moved.slice(0, 10).join('\n  - ')}`);
  append(root, state.id, 'review.accepted', { reviewer: r.closure.reviewer, patch: patchIds(state), heads: treeHashes(state), gate: state.lastGate.runId, ...(verdicts.length ? { noEvidence: verdicts } : {}), ...(rv.verdicts.length ? { rules: rv.verdicts } : {}), ...(ov.verdicts.length ? { outsidePlan: ov.verdicts } : {}), ...(dv.verdicts.length ? { designHits: dv.verdicts } : {}), ...(lv.verdicts.length ? { lessons: lv.verdicts } : {}), ...(xv.verdicts.length ? { discovered: xv.verdicts } : {}), ...(sv.verdicts.length ? { seams: sv.verdicts } : {}), ...(hv.verdicts.length ? { reportedIssues: hv.verdicts } : {}) }, actor(options));
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
  const trusted = trustedAdapter(root, state, deliveryPin(state));
  if (trusted.delivery.kind === 'push-main') return null;
  return (await import(pathToFileURL(adapterFileAtCommit(root, state, deliveryPin(state), trusted.delivery.kind)).href)).default;
}

// The state an adapter reported, as the owner acknowledges it: `none` when it reported none.
const stateLabel = (observed) => (observed?.state === undefined || observed?.state === null || observed?.state === '' ? 'none' : String(observed.state));
const describeState = (observed) => (stateLabel(observed) === 'none' ? 'no state' : ADAPTER_STATES.includes(observed.state) ? observed.state : `an unknown state ${JSON.stringify(String(observed.state))}`);

// Named failure (0.5.0 integration review): a delivery adapter's integrate and readback results were spread into the
// `repo.delivered` record over the engine's own fields, so a result carrying `repo`, `commit`, `target` or `skipped`
// rewrote what the ledger says was delivered (a `skipped` record then let `wf abandon` take a delivered attempt back),
// and a recorded result could replace the worktree or attempt an adapter is called with. An adapter result keeps its own
// fields; these are the engine's, set by it alone.
const ENGINE_DELIVERY_KEYS = new Set(['repo', 'commit', 'target', 'skipped', 'recovered', 'adapterState', 'observed', 'acknowledged', 'onTarget', 'at', 'root', 'worktree', 'attempt', 'item']);
const adapterResult = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([k]) => !ENGINE_DELIVERY_KEYS.has(k))) : {});

// I-20. Named failure: an adapter whose integrate pushes straight to the target branch and whose observe then reports
// anything but `integrated` (CI that fails after the merge, a missing state) was counted as delivered on the next
// `wf deliver` from git ancestry alone, and the adapter was never asked again. Now the adapter is asked again; a
// pending state waits; any other state after the merge is shown and counts only once the owner acknowledges that repo
// and that state (`--acknowledge-adapter-state <repo>:<state>`), recorded with the delivery like a deferral.
function postMerge(root, state, options, name, landed, observed, integrated) {
  const label = `${name}:${stateLabel(observed)}`;
  const given = typeof options['acknowledge-adapter-state'] === 'string' ? options['acknowledge-adapter-state'].split(',').map((x) => x.trim()).filter(Boolean) : [];
  if (given.includes(label)) {
    // 0.7.0 (engine/owner.mjs): accepting a state that is not a failure (none, an unknown state) is bookkeeping, recorded
    // with the caller as actor. Accepting a delivery whose adapter reports a failed check (ci-failed, rejected) is
    // overriding that check, and the person confirms it with `wf approve`.
    const failed = ['ci-failed', 'rejected'].includes(observed?.state);
    const approval = failed ? requireYes(root, state, { kind: 'override-gate', key: `acknowledge:${state.id}:${label}`, summary: `accept ${name} as delivered while its delivery adapter reports ${stateLabel(observed)} after the merge`, what: `accepting ${name} as delivered while its adapter reports ${stateLabel(observed)}`, options }) : null;
    return { ...adapterResult(integrated), repo: name, commit: landed.head, target: landed.target, adapterState: stateLabel(observed), observed: observed ?? null, acknowledged: label, ...(approval ? { decision: approval.decision } : {}) };
  }
  const url = integrated?.url ? ` (${integrated.url})` : '';
  throw refuse(`not delivered: ${name}: ${landed.head.slice(0, 10)} is already on ${landed.target}, but the delivery adapter reports ${describeState(observed)} after the merge${url}${observed?.evidence ? `: ${observed.evidence}` : ''}; being on the target branch alone does not count as a clean delivery`, `show this to the owner: the change is on ${landed.target} and the adapter says ${stateLabel(observed)}. ${stateLabel(observed) === 'ci-failed' ? 'Read that CI run. ' : ''}Once the owner has seen it and decides the delivery stands (anything to fix goes into a new attempt, \`wf reopen\`), \`wf deliver --acknowledge-adapter-state ${label}\` records it and shows it with the delivery${['ci-failed', 'rejected'].includes(observed?.state) ? '; a failed check also needs the owner to confirm it with \`wf approve\`' : ''}. An adapter that reports a wrong state is fixed on the base branch, then \`wf deliver --repin-adapter --reason "<why>"\``);
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
  const pinned = deliveryPin(state);
  // Named failure (0.5.0 integration review): where the new adapter is read from (the repo, its folder, base branch and
  // remote) came from the working tree's `.workflow/project.yaml`, which any agent can edit, so a re-pin could be pointed
  // at another repo's branch. It comes from the adapter as committed at the current pin; the confirmation shows the
  // remote it was fetched from.
  let pinnedCfg;
  let loc;
  try {
    loc = attemptAdapter(root, state);
    pinnedCfg = trustedAdapter(root, state, pinned);
  } catch (error) {
    throw refuse(`not re-pinned: the adapter at the current pin ${String(pinned).slice(0, 10)} cannot be read: ${error.message.split('\n')[0]}`);
  }
  const repo = pinnedCfg.repos.find((r) => r.name === loc.repo.name);
  const { relative, dir } = loc;
  const ref = baseRef(dir, repo);
  const tip = git(dir, ['rev-parse', ref]);
  // Shown without any user or token a remote url may carry.
  const remoteUrl = (git(dir, ['remote', 'get-url', repo.remote], { allowFail: true }) || 'no remote (the local branch)').replace(/\/\/[^/@\s]*@/, '//');
  // Run again after a later step refused: the re-pin an earlier try recorded is accepted again.
  if (want.length >= 7 && tip.startsWith(want) && pinned === tip && state.adapterRepins.some((x) => x.to === tip)) return state;
  if (tip === pinned) throw refuse(`not re-pinned: the delivery adapter of ${state.id} is already read at the tip of ${ref} (${tip.slice(0, 10)})`, `commit and push the fixed adapter on ${repo.base} in ${repo.name} first`);
  if (run('git', ['merge-base', '--is-ancestor', pinned, tip], { cwd: dir, allowFail: true }).status !== 0) throw refuse(`not re-pinned: ${ref} (${tip.slice(0, 10)}) does not contain the current pin ${pinned.slice(0, 10)}; the adapter is re-pinned only forward along the base branch`);
  let kinds;
  try {
    const now = trustedAdapter(root, state, tip);
    if (now.delivery.kind !== 'push-main') adapterFileAtCommit(root, state, tip, now.delivery.kind);
    assertEngine(now);
    kinds = { from: pinnedCfg.delivery.kind, to: now.delivery.kind };
  } catch (error) {
    throw refuse(`not re-pinned: the adapter at ${repo.name}@${tip.slice(0, 10)} cannot be used: ${error.message.split('\n')[0]}`);
  }
  const changed = git(dir, ['diff', '--name-only', pinned, tip, '--', relative || '.']).split('\n').filter(Boolean);
  if (!changed.length) throw refuse(`not re-pinned: the adapter files at the tip of ${ref} (${tip.slice(0, 10)}) are the same as at the current pin ${pinned.slice(0, 10)}; nothing would change`, `commit and push the fixed adapter on ${repo.base} in ${repo.name} first (a fix only in the working tree, or committed but not pushed, is never read)`);
  const delivered = Object.fromEntries(Object.values(state.delivery.repos).map((d) => [d.repo, d.skipped ? `skipped (${d.skipped})` : `delivered ${String(d.commit ?? '').slice(0, 10)}`]));
  if (want.length < 7 || !tip.startsWith(want) || !reason) {
    const done = Object.entries(delivered).map(([n, v]) => `${n} ${v}`).join('; ') || 'nothing yet';
    const left = Object.keys(state.repos).filter((n) => !delivered[n]).join(', ');
    throw refuse(`not re-pinned${want && !tip.startsWith(want) ? `: ${want} is not the tip of ${ref} (${tip.slice(0, 10)})` : ''}${!reason ? ': --reason is required' : ''}. Re-pinning ${state.id}'s delivery adapter:\n  from: ${repo.name}@${pinned.slice(0, 10)} (delivery kind ${kinds.from})\n  to:   ${repo.name}@${tip.slice(0, 10)}, the tip of ${ref}, fetched from ${remoteUrl} (delivery kind ${kinds.to})\n  adapter files that differ: ${changed.join(', ') || 'none'}\n  recorded so far: ${done}\n  still to deliver: ${left}\n  the gate, the review and the tracker stay on the admission pin ${state.adapterBase.slice(0, 10)}`, `show this to the owner, then \`wf deliver --repin-adapter ${tip.slice(0, 12)} --reason "<why>"\` asks the owner to confirm the re-pin with \`wf approve\``);
  }
  // 0.7.0: a re-pin changes which delivery checks run, so it is reserved (kind override-gate): the person confirms it.
  const approval = requireYes(root, state, { kind: 'override-gate', key: `repin:${state.id}:${tip}`, summary: `re-pin the delivery adapter of ${state.id} from ${pinned.slice(0, 10)} to ${tip.slice(0, 10)} (${reason})`, what: `re-pinning the delivery adapter of ${state.id} to ${tip.slice(0, 12)}`, options });
  append(root, state.id, 'adapter.repinned', { from: pinned, to: tip, ref, repo: repo.name, reason, changed, delivered, kinds, decision: approval.decision }, actor(options));
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
    // The transcript scan of implementer reports applies to attempts admitted before 0.7.0 only (D7); from 0.7.0 the
    // implementer's structured report puts what it left into the discovered issues checked just below. Named failure
    // (0.7.0 integration review): the scan still ran here, so a 0.7.0 attempt could pass review and acceptance and then
    // be refused at delivery by a transcript line no review was handed.
    if (!obligationSince(x, '0.7.0')) {
      const reports = reportsForReview(x);
      const bundle = readBundle(x.review?.handoff);
      const handed = new Set((bundle?.historicalReports ?? []).map((r) => r.id));
      const hv = reportedIssueVerdicts(bundle?.historicalReports ?? [], x.review?.closure ?? {}, x);
      if (reports.current.length || reports.historical.some((r) => !handed.has(r.id)) || hv.problems.length || hv.verdicts.some((v) => v.verdict === 'open')) throw refuse('not delivered: current or historical implementation reports need resolution and a fresh review on ' + x.id);
    }
    const open = openDiscovered(x);
    if (open.length) throw refuse(`not delivered: ${open.length} discovered issue(s) are open${x.id !== state.id ? ` in ${x.id}` : ''}: ${open.map((d) => `${d.id} ${d.summary}`).join('; ')}`, `fix it in this ticket and close it with the fix commit (\`wf discovered close <id> --fixed <commit>\`; a fix after acceptance needs the gate and a fresh review), or let it wait by the severity rule (\`wf discovered close <id>[,<id>] --deferred --reason "<why it waits>"\`: low freely, medium with your reason, high, unrated or an invariant only with the person's \`wf approve\`)`);
    // Named failure (0.7.0): a finding that does not block (D2) must not simply stay open past delivery. It ends fixed and
    // verified by a round, ticketed, or moved to a sibling attempt; the strategist schedules it.
    const obs = observations(x);
    if (obs.length) throw refuse(`not delivered: ${obs.length} review observation(s) are unresolved${x.id !== state.id ? ` in ${x.id}` : ''}: ${obs.slice(0, 8).map((f) => `${f.ref}${f.family ? ` [${f.family}]` : ''} ${f.summary ?? ''}`).join('; ')}${obs.length > 8 ? ` and ${obs.length - 8} more` : ''}`, `each is fixed (a later review round verifies it, or \`wf scope fixed\`), moved to a sibling attempt (\`wf scope move\`), ticketed (\`wf scope ticket --finding <ref>[,<ref>] --capture <raw readback>\`) or left for later as a known issue (\`wf scope defer --finding <ref>[,<ref>]\`), by the severity rule; \`wf scope list\` shows them with their severity`, { id: 'review:observations-open' });
  }
  // Every deferral is listed at delivery, in the delivery output and the delivered comment's known limits. 0.7.0: the
  // deferral was decided when it was recorded (the person's `wf approve` for a high one, the owner agent's recorded
  // judgement for a medium or low one, D10); the `--acknowledge-deferrals` list an agent typed again here proved nothing
  // and only added a step (final review of 0.7.0), so the listing is recorded with the caller as actor.
  const ackOwed = unacknowledged(root, state, (m) => loadState(root, m)).map((o) => ({ ...o }));
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
  // Where each repo's change lands (remote, base branch) and in what order: the adapter at the attempt's base, never the
  // working copy (0.5.0 adversarial review: an uncommitted edit could point a push at another branch or remote).
  const targets = trustedAdapter(root, state);
  for (const [name, r] of Object.entries(state.repos)) {
    if (state.delivery.repos[name] || !git(r.worktree, ['diff', '--name-only', r.base, 'HEAD'])) continue;
    const repo = targets.repos.find((x) => x.name === name);
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
    const integrated = adapterResult(last);
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
      append(root, state.id, 'repo.delivered', { ...integrated, ...adapterResult(rb), repo: name, commit: head, target: landed.target, recovered: true, adapterState: 'integrated' }, actor(options));
      continue;
    }
    append(root, state.id, 'repo.integrating', { ...integrated, repo: name, observed, onTarget: landed.target }, actor(options));
    if (PENDING.includes(observed?.state)) return { state: loadState(root, state.id), waiting: { repo: name, ...observed, url: integrated.url, onTarget: landed.target } };
    append(root, state.id, 'repo.delivered', { ...postMerge(root, state, options, name, landed, observed, integrated), recovered: true }, actor(options));
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
  const order = deliveryOrder(targets, Object.keys(state.repos));
  for (const name of order) {
    if (state.delivery.repos[name]) continue;
    if (changedFiles(state, name).length === 0) {
      append(root, state.id, 'repo.delivered', { repo: name, commit: null, skipped: 'no changes' }, actor(options));
      continue;
    }
    const repo = targets.repos.find((r) => r.name === name);
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
      const integrated = adapterResult(await adapter.integrate(ctx));
      const observed = await adapter.observe({ ...ctx, ...integrated });
      if (observed?.state !== 'integrated') {
        append(root, state.id, 'repo.integrating', { ...integrated, repo: name, observed }, actor(options));
        // I-20: an adapter that pushed straight to the target branch and then reports anything but a pending state is a
        // post-merge state: shown, and counted only with the owner's acknowledgement.
        const landed = PENDING.includes(observed?.state) ? null : onTarget(state.repos[name], repo);
        if (landed && (landed.head !== state.accepted.heads?.[name] || landed.head !== state.lastGate?.tree?.[name])) throw refuse(`${name}: ${landed.head.slice(0, 10)} is on ${landed.target} but is not the accepted, gated commit`);
        if (landed) result = postMerge(root, state, options, name, landed, observed, integrated);
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
        result = { ...integrated, ...adapterResult(rb), repo: name, commit: git(state.repos[name].worktree, ['rev-parse', 'HEAD']), target: `${repo.remote}/${repo.base}`, adapterState: 'integrated' };
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
  mkdirStateDirectory(parent, { recursive: true });
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
  mkdirStateDirectory(parent, { recursive: true });
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
  recordedTogether(root, state.id, () => {
    const kept = keepRaw(root, state.id, `delivery/shown-${n}.raw.json`, text);
    append(root, state.id, 'delivery.shown', { screenshots: shown, none: null, anomalies, raw: { path: kept.file, sha256: kept.sha256 } }, actor(options));
  });
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
  recordedTogether(root, state.id, () => {
    const raw = Array.isArray(parsed) ? null : keepRaw(root, state.id, 'delivery/narrow.raw.json', parsed.text);
    append(root, state.id, 'delivery.narrowed', { keep, from, to: kept.length, dropped: from - kept.length, reason, legacy: source.legacy, raw: raw ? { path: raw.file, sha256: raw.sha256 } : null }, actor(options));
  });
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
  const waiver = typeof options['no-lesson'] === 'string' && options['no-lesson'].trim() ? options['no-lesson'].trim() : null;
  const s = entry(root, { ...options, lane: delivered.lane === 'quick' ? 'quick' : 'standard', repos: Object.keys(delivered.repos).join(','), reopenedFrom: delivered.id });
  append(root, s.id, 'reopen.reason', { reason: String(options.reason), from: delivered.id }, actor(options));
  // Bookkeeping since 0.7.0 (engine/owner.mjs): the waiver and its reason are recorded with the caller as actor.
  if (waiver) append(root, s.id, 'lesson.waived', { reason: waiver, on: 'reopen' }, actor(options));
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
  // A batch a `wf split` reserved (0.7.0): its members are the parent and every sibling, together; their heavy steps
  // may have run in each, which costs time and never correctness.
  const reserved = [...new Set(states.map((s) => (s.batchPending ? s.batchOf : null)).filter(Boolean))];
  if (reserved.length > 1) throw refuse(`the members wait for different batches (${reserved.join(', ')})`, null, { id: 'batch:split-mixed' });
  if (reserved[0]) {
    if (options.id && options.id !== reserved[0]) throw refuse(`${reserved[0]} was reserved for these members by a split; use that id`, null, { id: 'batch:split-id' });
    const group = new Set(members);
    for (const id of group) for (const x of [loadState(root, id)].flatMap((st) => [...st.splits.flatMap((sp) => sp.siblings.map((y) => y.id)), ...(st.splitFrom ? [st.splitFrom.attempt] : [])])) group.add(x);
    const missing = [...group].filter((id) => !members.includes(id) && loadState(root, id).batchOf === reserved[0] && !['abandoned', 'done'].includes(loadState(root, id).phase));
    if (missing.length) throw refuse(`${reserved[0]} also waits for ${missing.join(', ')}: the members of a split are delivered together`, `add them: \`wf batch create --members ${[...members, ...missing].join(',')}\``, { id: 'batch:split-members' });
  }
  for (const s of states) {
    if (!s.deferHeavy && !reserved[0]) throw refuse(`${s.id} was not admitted with --defer-heavy, so its heavy steps already ran or must run alone`);
    if (!s.accepted) throw refuse(`${s.id} is not accepted yet`);
    if (s.batchOf && !(reserved[0] && s.batchOf === reserved[0] && s.batchPending)) throw refuse(`${s.id} is already in ${s.batchOf}`);
    if (s.activeHold) throw refuse(`${s.id} is on hold: "${s.activeHold.reason}"`);
    if (['abandoned', 'done', 'handoff-pending'].includes(s.phase)) throw refuse(`${s.id} is ${s.phase}`);
  }
  const n = listAttempts(root).filter((id) => /^BATCH-\d+/.test(id)).length + 1;
  const id = reserved[0] ?? options.id ?? `BATCH-${n}`;
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
  // A batch a split reserved and nobody assembled has no attempt yet: only the member's record leaves it.
  if (options.batch && !listAttempts(root).includes(String(options.batch))) {
    const waiting = openState(root, { attempt: assertSafeId(options.member ?? '', 'attempt id') });
    if (!(waiting.batchPending && waiting.batchOf === options.batch)) throw refuse(`${waiting.id} is not waiting for ${options.batch}`);
    // D1: placement is not obligation. A split put these members in one batch so that what moved is still delivered; one
    // leaving it is the owner's decision (`wf approve`).
    const approval = requireYes(root, waiting, { kind: 'move-out-of-batch', key: `${options.batch}:${waiting.id}`, summary: `${waiting.id} leaves ${options.batch}, which a split reserved for it and its siblings`, what: `ejecting ${waiting.id} from ${options.batch}`, options });
    append(root, waiting.id, 'batch.ejected', { batch: options.batch, reason: options.reason ?? null, decision: approval.decision }, actor(options));
    return loadState(root, waiting.id);
  }
  const batch = openState(root, { attempt: options.batch });
  const member = assertSafeId(options.member ?? '', 'attempt id');
  const members = batchMembers(root, batch.id);
  if (!members.includes(member)) throw refuse(`${member} is not in ${batch.id}`);
  if (batch.delivery.completedAt || Object.keys(batch.delivery.repos).length) throw refuse(`${batch.id} is already being delivered`);
  // Independent review of 0.7.0 (HIGH): the split guarantee was removable after assembly. A member that came from, or made,
  // a split leaves the batch only on the person's one-use approval.
  const ms0 = loadState(root, member);
  const ejectDecision = (ms0.splitFrom || ms0.splits?.length) ? requireYes(root, ms0, { kind: 'move-out-of-batch', key: `eject:${batch.id}:${member}:${(ms0.batchJoins ?? 0)}`, summary: `${member} leaves the assembled ${batch.id}, which carries work a split moved`, what: `ejecting ${member} from ${batch.id}`, options }).decision : null;
  const remaining = members.filter((m) => m !== member);
  for (const [name, r] of Object.entries(batch.repos)) {
    run('git', ['checkout', '--quiet', '-B', branchName(batch.id), r.base], { cwd: r.worktree });
    for (const m of remaining) {
      const ms = loadState(root, m);
      if (ms.repos[name]) run('git', ['merge', '--no-edit', '-m', `Batch ${batch.id}: merge ${m}`, branchName(m)], { cwd: r.worktree });
    }
  }
  append(root, member, 'batch.ejected', { batch: batch.id, reason: options.reason ?? null, ...(ejectDecision ? { decision: ejectDecision } : {}) }, actor(options));
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

// The frozen plan's work items no implementer handoff has started. Named failure (I-63): an attempt admitted before 0.7.0
// could hand one implementer without --work for the whole plan; it was never recorded against a work item, so the items
// stayed unstarted for good. Such a unified implementer (no handoff names a work item) now counts for all of them: a
// relaxation, so it applies to every attempt.
// 0.7.0, named failure: work items built in parallel met each other for the first time in a review round, so every round
// found a new batch of cross-cutting breakage (one ticket ran 47 rounds; the 0.7.0 integration itself, six parallel streams,
// broke 21 tests only visible on the combined tree). With more than one work item, the combined tree passes `wf check` (the
// adapter's light steps, minutes) before a code review is handed it. A check limited to some repos (`--repo`) never ran the
// others' steps on the combined tree (independent review of 0.7.0).
export function integrationCheckOwed(cfg, state) {
  if (!obligationSince(state, '0.7.0') || state.lane === 'batch' || (state.work?.length ?? 0) < 2 || cfg.review?.integrationCheck === false) return false;
  if (!(cfg.gate?.steps ?? []).some((x) => (x.tier ?? 'light') === 'light') || gatePassedForCurrentTree(state).ok) return false;
  const here = canonical(treeHashes(state));
  return !(state.checks ?? []).some((c) => c.status === 'passed' && !c.repos && c.tree && canonical(c.tree) === here);
}

export function unstartedWork(state) {
  const handoffs = state.handoffs.filter((h) => h.role === 'implementer');
  const named = new Set(handoffs.flatMap((h) => (h.work ? [h.work] : h.covers ?? [])));
  if (!named.size && handoffs.length && !obligationSince(state, '0.7.0')) return [];
  return (state.work ?? []).filter((w) => !named.has(w.id));
}

// Named failure: prose-only next steps could not safely drive runtime-independent execution.
// An open attempt whose worktree folder is gone (missingWorktrees in attempt.mjs): decided before any git call, shown as
// orphaned with its missing paths, and left for `wf abandon` (or a restored folder). Named failures: one such attempt made
// `wf status`, `wf status --all` and `wf resume` fail with "git failed to start: spawnSync git ENOENT" for all of them; and,
// with that guard kept in the CLI's status lines only, `wf approve` and `wf release` recorded the person's decision on an
// orphan and then failed with "worktree missing" while printing what comes next (0.7.0, an orphan with an open
// integration), which reads as the decision not taken. The guard is here, the one place every next line is decided.
export const orphansOf = (s) => (['done', 'abandoned'].includes(s.phase) ? [] : missingWorktrees(s));
export function orphanNext(root, s, gone) {
  let cfg = null;
  try {
    cfg = loadConfig(root);
  } catch {}
  const restore = gone.map((m) => {
    const repo = cfg?.repos.find((r) => r.name === m.repo);
    return repo ? `git -C ${repoDir(root, repo)} worktree prune && git -C ${repoDir(root, repo)} worktree add ${m.worktree} ${m.branch}` : null;
  }).filter(Boolean);
  return `ORPHANED, worktree missing: ${gone.map((m) => m.worktree).join(', ')}. Nothing runs in a missing folder. If it was removed by mistake, put it back from the branch (committed work only): ${restore.join(' ; ') || 'git worktree add <path> <branch> from the repo checkout'}. Otherwise \`wf abandon --attempt ${s.id} --reason "<why>"\` (its branch is kept)`;
}

export function nextDecision(root, state) {
  const gone = orphansOf(state);
  if (gone.length) return { kind: 'orphaned', status: 'blocked', actor: 'owner', attempt: state.id, owner: state.owner, tree: null, guidance: orphanNext(root, state, gone), blockers: [`worktree missing: ${gone.map((m) => m.worktree).join(', ')}`], orphaned: gone };
  const guidance = legacyNextAction(root, state);
  const tree = ['done', 'abandoned'].includes(state.phase) ? null : treeHashes(state);
  const result = (kind, status, reason, extra = {}) => ({ kind, status, actor: status === 'ready' ? 'engine' : 'owner', attempt: state.id, owner: state.owner, tree, guidance: status === 'blocked' ? `blocked: ${reason}` : guidance, blockers: reason ? [reason] : [], ...extra });
  if (['done', 'abandoned'].includes(state.phase)) return result('complete', 'complete');
  if (state.activeHold) return result('hold', 'blocked', state.activeHold.reason, { guidance: `on hold: ${state.activeHold.reason}; only the owner lifts it. Pending sequence after release: ${guidance}` });
  // 0.7.0 (D3): the person's round escalation and a strategist's escalation stop the course until they decide (attempts
  // admitted at 0.7.0+); a strategist the owner agent handed is waited for.
  const held = strategyHold(root, state);
  if (held) return result('strategy', 'owner', held.owner ? held.owner.summary : `the strategist's escalation ${held.escalation.id} awaits the owner`, { guidance: withAttempt(root, state, held.guidance), escalation: held.escalation?.id ?? null });
  const waiting = strategistWaiting(state);
  if (waiting) {
    const gone = waiting.launch?.status === 'completed';
    const because = waiting.reason ? ` because: ${waiting.reason}` : '';
    const guidance = gone
      ? `Strategist ${waiting.agent} was handed${because} and its launch completed without recording a decision: hand a fresh strategist with a new id (\`wf handoff strategist --agent <new id>\`)`
      : `Strategist ${waiting.agent} was handed${because} (${waiting.launch ? `launch ${waiting.launch.status}` : 'not launched through wf'}) and has recorded no decision: wait for its completion notification${waiting.launch ? '' : ', or run it in the foreground (\`wf handoff run --agent ' + waiting.agent + '\`) if it was never started'}; never poll. \`wf signals\` shows its last activity: if it has stopped, hand a fresh strategist with a new id. It records its decision with \`wf strategy record --closure <file>\``;
    return result('strategy', 'owner', `strategist ${waiting.agent} was handed and has recorded no decision`, { guidance: withAttempt(root, state, guidance), handoff: waiting.bundle });
  }
  if (state.intent !== 'implementation' || state.lane === 'batch' || (state.batchOf && !state.batchPending)) return result('owner', 'owner', 'this trial advances standalone implementation attempts only');
  if (!state.criteria) return result('plan', 'owner', 'criteria must be frozen by the owner');
  if (state.accepted) return result('delivery', 'owner', 'accepted; delivery and presentation remain with the owning chat');
  if (state.tracker.pending.length) return result('tracker', 'owner', 'tracker actions require the owning chat');
  const unstarted = unstartedWork(state);
  if (unstarted.length) return result('implementation', 'owner', 'work items have not started', { guidance: guidance });
  if (openImplementersOf(root, state).length) return result('implementation', 'owner', 'the owner must close settled implementer handoffs');
  if (!state.handoffs.some((h) => h.role === 'implementer')) return result('implementation', 'owner', 'implementation has not started');
  if (openDiscovered(state).length) return result('repair', 'owner', 'discovered issues remain open');
  if (Object.values(tree).some((t) => t.includes('+dirty')) || Object.keys(state.repos).every((n) => !changedFiles(state, n).length)) return result('implementation', 'owner', 'a committed change is required');
  if (gateBusy(root, state)) return result('gate', 'blocked', 'a gate is already running');
  const h = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  const group = currentReviewGroup(state);
  if (group && !(state.reviews ?? []).some(r => r.handoff === group.integration.bundle)) {
    const members = group.members.map(m => ({ agent: m.agent, slot: m.reviewGroup.slot, runtime: m.runtime,
      status: m.launch?.status ?? 'unlaunched', recorded: (state.reviewParts ?? []).some(p => p.handoff === m.bundle) }));
    if (members.some(m => ['starting', 'running'].includes(m.status))) return result('review', 'blocked', 'review group runtime outcome is pending or liveness is unknown; retain the original handle', { group: group.id, members });
    if (members.some(m => m.status === 'failed' || (m.slot !== 'integration' && m.status === 'completed' && !m.recorded))) return result('review', 'owner', 'review group has a failed or incomplete member; diagnose before a fresh group', { group: group.id, members });
  }
  // A blind closure can be recorded before same-round prior-finding verification finishes.
  if (h?.launch && ['starting', 'running'].includes(h.launch.status)) return result('review', 'blocked', 'runtime outcome is pending or liveness is unknown; recover the original handle, never duplicate it', { handoff: h.bundle, runtime: h.runtime });
  if (h?.launch?.status === 'failed') return result('review', 'owner', 'role launch failed; diagnose before a fresh handoff', { handoff: h.bundle, guidance: `reviewer ${h.agent} launch failed; create a fresh reviewer handoff after diagnosis; no review is running` });
  const recorded = h && (state.reviews ?? []).filter((r) => r.handoff === h.bundle).at(-1);
  const refused = h && (state.reviewsRefused ?? []).some((r) => r.handoff === h.bundle);
  if (h && !recorded) {
    if (refused) return result('review', 'owner', 'the review was refused');
    if (canonical(h.tree) !== canonical(tree)) return result('review', 'owner', 'the handed tree changed');
    if (!h.launch) return result('review', 'owner', 'existing handoff has no native receipt; it may already be running externally', { handoff: h.bundle, runtime: h.runtime, guidance: guidance });
    return result('review', 'owner', 'process completed but a valid closure is missing', { handoff: h.bundle, guidance: withAttempt(root, state, closureMissingGuidance(state, h)) });
  }
  const r = state.review;
  if (state.lastGate?.status === 'stopped' && ['major-finding', 'tree-change'].includes(state.stops.at(-1)?.class) && canonical(state.lastGate.tree) === canonical(tree)) return result('repair', 'owner', 'gate stopped for a defect or tree change; repair and fresh review are required', { guidance: guidance });
  if (state.lastGate?.status === 'failed' && canonical(state.lastGate.tree) === canonical(tree)) return result('repair', 'owner', 'the normal gate failed; diagnose before continuing');
  // The combined-tree check comes before the review it guards: the next step names it, not the handoff's refusal (the
  // second final review's repair pass: `wf advance` stopped refused here).
  if ((!r || !reviewCovers(state, r)) && evidenceFixReady(state) && !gatePassedForCurrentTree(state).ok) return result('gate', 'ready', null, { guidance: withAttempt(root, state, 'the evidence review\'s findings are fixed by the implementers handed after it: run one `wf gate`; the evidence review after it verifies the fixes and the new evidence') });
  if ((!r || !reviewCovers(state, r)) && integrationCheckOwed(trustedAdapter(root, state), state)) return result('check', 'owner', `the combined tree of ${state.work.length} work items needs a passing \`wf check\` before its code review`, { guidance: `run \`wf check --attempt ${state.id}\` on the combined tree and fix what it finds through the implementers; then the code review` });
  if (!r || !reviewCovers(state, r)) return result('review', 'ready', null, { round: 'code-review' });
  if (r && (openFindings(r, state).length || unverifiedPrior(state, r).length)) return result('repair', 'owner', 'review findings or earlier-finding verification remain open');
  const passed = gatePassedForCurrentTree(state);
  if (!passed.ok) {
    const blockers = gateOrderProblems(state);
    return blockers.length ? result('gate', 'owner', blockers.join('; ')) : result('gate', 'ready', null, { guidance: canonical(r.tree ?? r.handoffTree) === canonical(tree) ? guidance : withAttempt(root, state, 'clean code review covers this change: run one `wf gate`; then the evidence review') });
  }
  if (!reviewedAfterGate(r)) return result('review', 'ready', null, { round: 'evidence-review' });
  // Named failure (I-107): criteria an amendment added or re-worded after this round was handed are mapped by no round, and
  // `wf accept` refuses; the next step is a reviewer, not the acceptance.
  const late = criteriaAfterReview(state, r);
  if (late.added.length || late.changed.length) return result('review', 'ready', null, { round: 'evidence-review' });
  return result('accept', 'ready');
}

export function nextAction(root, state) { return nextDecision(root, state).guidance; }

export const outstandingReviewFindings = (state) => state.review ? unverifiedPrior(state, state.review) : [];

function legacyNextAction(root, state) {
  const step = nextStep(root, state);
  // I-23: the reviewer handoff refuses while an implementer handoff is open; a step that hands a reviewer says so first.
  const openImpl = step.includes('wf handoff reviewer') ? openImplementersOf(root, state) : [];
  const close = openImpl.length ? `close the implementer(s) still open, once each has reported done and committed: ${openImpl.map((x) => `\`wf handoff close --agent ${x.agent}\``).join(', ')}; then ` : '';
  return withAttempt(root, state, `${close}${step}`);
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
    if (cfg?.tracker?.via === 'connector') return `${state.phase === 'handoff-pending' ? '' : `${phaseAction(root, cfg, state)}${holdNote}. Pending `}tracker (${ev}): through the connector: ${ops}; then read the issue${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' and its comments' : ''} back with the connector and run \`wf tracker record --event ${ev} --from-transcript\` (the readback as the host recorded it). Without a host transcript: \`--capture <saved tool result>\`, or \`--agent-reported --file reported.json${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' --comment-file <posted text>' : ''}\``;
    const reported = cfg?.tracker?.via === 'connector' ? `; or, when the tool results are only in the chat, write what the tracker showed to reported.json ({ issue, status, comment: { id, bodySha256, createdAt }, attachments: [{ title, subtitle, assetUrl }], readAt }) and run \`wf tracker record --event ${ev} --agent-reported --file reported.json${state.tracker.pending.some((a) => a.event === ev && a.op === 'comment') ? ' --comment-file <the posted comment text>' : ''}\` (recorded agent-reported, unverified)` : '';
    const tracker = `tracker (${ev}): ${ops}; ${raw} and run \`wf tracker record --event ${ev} --capture <file>\`${reported}`;
    if (state.phase === 'handoff-pending') return tracker;
    return `${phaseAction(root, cfg, state)}${holdNote}. Pending ${tracker}`;
  }
  return `${phaseAction(root, cfg, state)}${holdNote}`;
}

function phaseAction(root, cfg, state) {
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
    const open = unstartedWork(state);
    if (open.length) return `start the implementers for the open work items (agent type in brackets; never general-purpose): ${open.map((w) => `${w.id} class ${w.class} [${agentTypeFor(cfg, 'implementer', w.class)}] \`wf handoff implementer --work ${w.id} --agent <id>\``).join('; ')}; one implementer handed without \`--work\` covers them all`;
  }
  if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) return `start the implementer: \`wf handoff implementer --agent <id>\` [${agentTypeFor(cfg, 'implementer')}]`;
  const openIssues = openDiscovered(state);
  if (openIssues.length) return `${openIssues.filter((d) => d.blockedBy).map((d) => `route ${d.id} to the implementer of ${d.blockedBy} (continue it with SendMessage); `).join('')}fix the discovered issue(s) ${openIssues.map((d) => `${d.id}${d.severity ? ` (${d.severity})` : ''}`).join(', ')} through the implementer that found each (never yourself) (\`wf discovered list\`), commit, then \`wf discovered close <id> --fixed <commit>\`; a criterion or scope that blocks the fix is amended (\`wf criteria amend --file <f> --reason "why"\`, \`--add-repo <repo>\` when the fix needs another repo). By the person's severity rule an issue may instead wait (\`wf discovered close <id> --deferred --reason "why"\`): high or unrated only when the person confirms it with \`wf approve\`, medium on your judgement, low freely; a split moves one to a sibling attempt of the batch (\`wf split\`)`;
  if (state.accepted && observations(state).length) return `${observations(state).length} review observation(s) are unresolved and delivery waits for them: ${observationLines(state).slice(0, 5).join('; ')}; each is fixed (the next reviewer verifies it, or \`wf scope fixed --finding <ref> --commit <sha>\`), moved to a sibling attempt (\`wf scope move\`), ticketed (\`wf scope ticket\`) or left for later as a known issue (\`wf scope defer\`); leaving the delivery follows the severity rule: high only with the person's \`wf approve\`, medium with your \`--reason\`, low freely; \`wf scope list\` shows each one's severity`;
  // An attempt admitted before 0.7.4 keeps its acceptance through an amendment (D7, I-107): say what delivery would ship.
  const unmapped = amendedAfterAcceptance(state);
  const unmappedNote = unmapped.length ? ` -- WARNING: ${unmapped.join(', ')} ${unmapped.length === 1 ? 'was' : 'were'} added or re-worded after the acceptance and no review mapped ${unmapped.length === 1 ? 'it' : 'them'} to evidence (this attempt was admitted before 0.7.4, so the engine leaves the acceptance standing): for the evidence, hand a fresh reviewer (\`wf handoff reviewer --agent <new id>\`) and \`wf accept\` again, then deliver` : '';
  if (state.accepted) return state.batchPending ? `accepted; ${state.batchOf} (reserved by a split) waits for the other members to be accepted, then \`wf batch create --members <every member of the split>\` assembles it` : state.batchOf ? `waiting for batch ${state.batchOf}` : `deliver: \`wf deliver\`${unmappedNote}`;
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
  const group = currentReviewGroup(state);
  if (inFlight && group) {
    const members = group.members.map(m => `${m.agent}: ${m.launch?.status ?? 'unlaunched'}${state.reviewParts.some(p => p.handoff === m.bundle) ? ', part recorded' : ''}`);
    return `review group ${group.id}: ${members.join('; ')}; retain its original execution handle; if none launched, run \`wf handoff run --agent ${group.integration.agent}\`; no gate until integration records the complete review`;
  }
  // Named failure I-44: a handoff without a process was presented as a running reviewer.
  if (findHost(inFlight?.runtime)?.spawnMode === 'engine-only') {
    if (!inFlight.launch) {
      if (!inFlight.model) return 'reviewer ' + inFlight.agent + ' has not launched: its attempt execution pin has no ' + findHost(inFlight.runtime).name + ' model; run \x60wf models refresh --attempt ' + state.id + '\x60, then create a fresh reviewer handoff';
      return 'reviewer ' + inFlight.agent + ' is ready but has not launched: \x60wf handoff run --agent ' + inFlight.agent + ' --attempt ' + state.id + '\x60';
    }
    if (inFlight.launch.status === 'failed') return 'reviewer ' + inFlight.agent + ' launch failed; create a fresh reviewer handoff and run it; no review is running';
    if (inFlight.launch.status === 'completed') return closureMissingGuidance(state, inFlight);
    // 0.7.0: the launcher hands control back once a role passes its own estimate; the role keeps running.
    if (inFlight.launch.pid) {
      const running = (() => { try { process.kill(inFlight.launch.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
      return running
        ? `reviewer ${inFlight.agent} is running (pid ${inFlight.launch.pid}): \`wf handoff wait --agent ${inFlight.agent} --attempt ${state.id} [--minutes N]\` follows it, \`wf handoff stop --agent ${inFlight.agent} --attempt ${state.id}\` ends it so a fresh reviewer can take over; no gate while it runs`
        : `reviewer ${inFlight.agent}'s process ended and its end is not recorded yet: \`wf handoff wait --agent ${inFlight.agent} --attempt ${state.id}\` records it`;
    }
  }
  if (inFlight) return `waiting for reviewer ${inFlight.agent}: \`wf review --closure <its file>\`; ${inFlight.round === 'evidence-review' || (!inFlight.round && inFlight.gate) ? 'evidence review of the gated tree' : 'code review'}, no gate while it runs`;
  if (g?.status === 'failed' && onTree(g.tree)) return 'gate failed: fix and commit through the implementer that did that work; the fixed tree then gets a code-review round by a fresh reviewer before the next `wf gate` (a failure that needed no code change: `wf gate` again)';
  const r = state.review;
  if (!r || !onTree(r.tree ?? r.handoffTree)) {
    if (evidenceFixReady(state) && !pass.ok) return `the evidence review's findings are fixed by the implementers handed after it: ${gateRun}; the evidence review after it verifies the fixes and the new evidence`;
  }
  if (!r || !onTree(r.tree ?? r.handoffTree)) return integrationCheckOwed(cfg, state) ? `the combined tree of ${state.work.length} work items needs a passing \`wf check --attempt ${state.id}\` first (fix what it finds through the implementers); then the code review: hand to ${fresh}; ${noGate}` : `code review: hand to ${fresh}; ${noGate}`;
  const open = openFindings(r, state);
  if (open.length) return `fix the open findings (${open.map((f) => (f.work ? `${f.id} in ${f.work}` : f.id)).join(', ')}): hand them to the implementer that did that work as a fix round (\`wf handoff implementer --agent <its id>${open.some((f) => f.work) ? ' --work <item>' : ''}\`, then continue it with the printed line), so its report and the defect history are recorded; then the next code-review round: hand to ${fresh}; ${noGate}`;
  const toVerify = unverifiedPrior(state, r);
  if (toVerify.length) return `reviewer ${r.closure.reviewer} must verify ${toVerify.length} earlier-round finding(s) (${toVerify.map((f) => `${f.round}:${f.id}`).join(', ')}): it adds \`priorFindings\` to its closure and runs \`wf review --closure <its file>\` again; if it is gone, hand to ${fresh}; ${noGate}`;
  // Observations are placed before the gate, while a fix still costs no extra gate (second final review of 0.7.0: they
  // were named only after acceptance, so each one placed then cost another gate cycle).
  const obsNow = observations(state);
  if (!pass.ok && obsNow.length) return `clean code review on this tree, with ${obsNow.length} open observation(s) to place first: ${observationLines(state).slice(0, 5).join('; ')}; fix them now in one pass through the implementer (then the next review round), or let them wait by the severity rule (\`wf scope defer\` or \`wf scope ticket\`); then ${gateRun}`;
  if (!pass.ok) return `clean code review on this tree: ${gateRun}; then the evidence review`;
  if (!reviewedAfterGate(r)) return `evidence review: the gate passed on the reviewed tree, so hand to ${fresh} to inspect the gate evidence (logs and screenshots)`;
  const late = criteriaAfterReview(state, r);
  if (late.added.length || late.changed.length) return `evidence review: ${[...late.added, ...late.changed].join(', ')} ${late.added.length + late.changed.length === 1 ? 'was' : 'were'} added or re-worded by an amendment after the last review round was handed, so no round mapped ${late.added.length + late.changed.length === 1 ? 'it' : 'them'} to this gate's evidence (\`wf accept\` would refuse): hand to ${fresh}; it maps every criterion`;
  return 'accept the review: `wf accept`';
}
