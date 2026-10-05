import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { actor, branchName, changedFiles, cleanupWorktrees, entry, openState, treeHashes, worktreeDir } from './attempt.mjs';
import { ADAPTER_DIR, adapterFileAtCommit, agentTypeFor, declared, loadConfig, loadConfigAtCommit, repoDir, roleClass } from './config.mjs';
import { focusedSkips, gatePassedForCurrentTree, screenshots } from './gate.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { changedForStep, deliveryOrder, impact, inside, packageOf } from './topology.mjs';
import { findSkill } from './skills.mjs';
import { lastFencedYaml, lastModel, readTranscript, sessionModel, subagentModel, subagentTranscripts } from './telemetry.mjs';
import { outsidePlan, outsideVerdicts } from './scope.mjs';
import { emitTrackerEvent } from './tracker.mjs';
import { requiredSkills, reviewRules, ruleVerdicts, skillFiles, unreadDocs } from './rules.mjs';
import { home, startPromptFor, verifyAgent } from './provenance.mjs';
import { WfError, YAML, canonical, git, hashFile, hashValue, matchesAny, readJson, refuse, run, sessionIdentity, writeImmutable, writeJson } from './util.mjs';

const readStructured = (file) => {
  let text = fs.readFileSync(path.resolve(String(file)), 'utf8');
  const fenced = text.match(/```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) text = fenced[1];
  return file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
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
const PLAN_FILE_KEYS = ['plan', 'criteria', 'work', ...PLAN_SECTIONS];

export function planFromDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new WfError(`the plan file must be a mapping with \`criteria\` (known keys: ${PLAN_FILE_KEYS.join(', ')})`);
  const unknown = Object.keys(doc).filter((k) => !PLAN_FILE_KEYS.includes(k));
  if (unknown.length) throw new WfError(`unknown top-level key(s) in the plan file: ${unknown.join(', ')}; known keys: ${PLAN_FILE_KEYS.join(', ')} (plan sections may also sit under \`plan:\`)`);
  const p = doc.plan;
  if (p !== undefined && p !== null && typeof p !== 'string' && (typeof p !== 'object' || Array.isArray(p))) throw new WfError('`plan` must be text (the summary) or a mapping of plan sections');
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
  const found = subagentTranscripts(home(), agent, handoff?.agentType ?? null, handoff?.at ?? null);
  if (!found.length) throw refuse(`no Claude Code subagent transcript named \`${agent}\`${handoff?.agentType ? ` (agent type ${handoff.agentType})` : ''}${handoff ? ' written after its handoff' : ''} under ${path.join(home(), '.claude', 'projects')}`, 'check the agent id, or save the planner\'s YAML unchanged to a file and use `wf plan --file <file>`');
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
  const doc = fromAgent ? fromAgent.doc : readStructured(options.file);
  const plan = planFromDoc(doc);
  validateCriteria(doc.criteria);
  const work = validateWork(cfg, doc.work, doc.criteria);
  if (needsPlanner(cfg, state)) {
    const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
    if (!planner) throw refuse(`the ${state.lane} lane needs a planner: run \`wf handoff planner --agent <id>\` first`);
    if (canonical(treeHashes(state)) !== canonical(planner.tree)) throw refuse('the planner changed the worktree; planning must be read-only');
  }
  if (state.handoffs.some((h) => h.role === 'implementer')) throw refuse('implementation already started; criteria must be frozen before implementation');
  let source = null;
  if (fromAgent) {
    source = { ...fromAgent.source, ...keepRaw(root, state.id, 'plans/plan-1.raw.yaml', fromAgent.text) };
  } else {
    // Where available, the model the planner ran on: an agent whose class pins no model inherits the session's.
    const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
    const model = planner && planner.runtime === 'claude' ? subagentModel(home(), planner.agent, planner.agentType, planner.at) : null;
    const from = path.resolve(String(options.file));
    source = { ...keepRaw(root, state.id, `plans/plan-1.raw.${extOf(from)}`, fs.readFileSync(from, 'utf8')), from, agent: planner?.agent ?? null, model };
  }
  append(root, state.id, 'criteria.frozen', { criteria: doc.criteria, plan, source, ...(work ? { work } : {}) }, actor(options));
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

export function amendCriteria(root, options) {
  const state = openState(root, options);
  if (!state.criteria) throw refuse('criteria are not frozen yet; use `wf plan`');
  if (!options.reason || options.reason === true) throw new WfError('--reason is required (say why the criteria change)');
  const doc = readStructured(options.file);
  const { criteria, changes } = mergeAmendment(state.criteria, doc.criteria);
  // Work items survive an amendment unless the file replaces them; either way they must name criteria that still exist.
  const work = validateWork(loadConfig(root), doc.work ?? state.work, criteria);
  const from = path.resolve(String(options.file));
  const raw = keepRaw(root, state.id, `plans/amend-${state.criteriaAmendments.length + 1}.raw.${extOf(from)}`, fs.readFileSync(from, 'utf8'));
  append(root, state.id, 'criteria.amended', { criteria, changes, reason: String(options.reason), previous: state.criteria, raw, ...(doc.work ? { work } : {}) }, actor(options));
  return { state: loadState(root, state.id), changes };
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
  // Review runs before the gate: every finding found after a gate costs another full gate. The gate may run in parallel.
  let gateNow = null;
  if (role === 'reviewer') {
    if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) throw refuse('nothing to review yet: hand the work to an implementer first (`wf handoff implementer --agent <id>`)');
    // Tracked changes only: a gate running in parallel writes untracked reports, and those are never the change.
    const dirty = Object.entries(treeHashes(state)).filter(([, t]) => t.includes('+dirty')).map(([n]) => n);
    if (dirty.length) throw refuse(`commit the change before the review (the reviewer reads the committed diff): uncommitted changes in ${dirty.join(', ')}`);
    if (authorsOf(root, state).has(agent)) throw refuse(`${agent} planned, wrote or owns this change and cannot review it`);
    // A resumed reviewer is anchored on its earlier findings; each round is judged by an agent that has seen none of them.
    if (state.roles.reviewer.includes(agent)) throw refuse(`${agent} already reviewed a round of this attempt; start a fresh reviewer agent with a new id; each review round uses a new agent`);
    gateNow = gatePassedForCurrentTree(state);
  }
  if (role === 'implementer' && state.roles.reviewer.includes(agent)) throw refuse(`${agent} reviewed this attempt and cannot implement it`);
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
  const cls = work?.class ?? roleClass(cfg, role);
  const agentType = agentTypeFor(cfg, role, cls);
  const { effort, model } = declared(cfg, cls, runtime);

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
    changed,
    impact: impact(trusted, changed),
    invariants: cfg.invariants ? path.resolve(root, ADAPTER_DIR, cfg.invariants) : null,
    roleAppendix: appendix && fs.existsSync(appendix) ? appendix : null,
    // Whether gate evidence exists for the tree under review. Without it the reviewer judges the diff; acceptance then
    // needs a later round written after a passing gate on this tree, which inspects the evidence.
    gate: role === 'reviewer'
      ? gateNow.ok
        ? { passedOnThisTree: true, runId: state.lastGate.runId, evidence: state.lastGate.evidence, screenshots: screenshots(state), artifacts: artifactsByStep(state, trusted), logs: state.lastGate.steps.filter((s) => s.log).map((s) => ({ step: s.id, log: s.log, status: s.status })) }
        : { passedOnThisTree: false, reason: gateNow.reason, screenshots: [], logs: [] }
      : null,
    // Project rule documents this change falls under, and the skills this round needs: a pure function of the adapter
    // at base and the changed files, the same for every reviewer. Each rule needs a verdict in the closure.
    rules: role === 'reviewer' ? reviewRules(root, trusted, state, changed) : undefined,
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
      planner: 'Read the issue and the code. Do not change any file. Return your plan as one ```yaml fenced block, last in your reply: { plan: { summary, contract, anchors, tests: { changed, run }, doNotRun, externalServices, agentSplit }, criteria: [{ id: C1, text, uat }], work: [{ id: W1, criteria: [C1], repos, class, why }] } (work is optional; classes: see your role file). The owner freezes it from your transcript unchanged. Leave no background command, monitor or sleep loop running when you report.',
      implementer: "Done means `check.command` passes for your repos (it runs the light steps listed under `check`; it never counts as the gate). Implement against the frozen criteria and the plan in the worktrees above: follow `plan.contract`, start from `plan.anchors`, while iterating run only `plan.tests.run` and the specs you changed, never what `plan.doNotRun` lists, and keep to `plan.externalServices` and `plan.agentSplit`. Write tests only for real behaviour. Before finishing run the repo's lint and full unit suite once, in the foreground. Commit at stage boundaries and everything when done. If `work` is set, do that work item only; if it turns out to touch something a stronger class covers, stop and tell the owner. Before you report, stop every background command, monitor or sleep loop you started: a waiter left running keeps notifying the owner after you are done.",
      reviewer: 'Review the whole change against the frozen criteria, and the gate evidence when `gate.passedOnThisTree` is true (then open every screenshot listed under `gate.screenshots`, which are exactly the files `gate.artifacts` lists per glob, and record the sha256 of each one you viewed; a file no glob lists is never required; a step whose package did not change needs nothing; a step marked `uncovered` matched nothing although this ticket changed its package: judge whether the ticket needed a capture there and add `noEvidence: [{ step, reason }]` saying why none is needed, or raise a finding). When it is false, no gate has passed on this tree yet: judge the diff and list no screenshots. You did not write this change. Everything you need is in this bundle; judge the whole change yourself. Read every document under `rules` (each `read` path) and every skill under `skills` (the Skill tool, or its file) in this bundle: they add to the whole review and never narrow it. Give each rule a verdict with one line of evidence (file:line or the document section): `rules: [{ rule, verdict: complies|finding|not-applicable, evidence, finding }]` (`finding` names your finding id when the verdict is finding); a rule marked `docChangedByTicket` had its document changed by this ticket: judge against the copy under `read`, which is the base version. Write the closure file: { reviewer, findings: [{ id, severity, summary, status: open|fixed|verified-nonissue, evidence, work }], criteria: [{ id, evidence: { kind: test|screenshot|output|not-applicable|dropped-with-reason, ref, reason } }] (a screenshot ref is the sha256 or source of a file in `gate.artifacts`), screenshotsInspected: [sha256], noEvidence: [{ step, reason }], rules: [{ rule, verdict, evidence, finding }], outsidePlan: [{ file, verdict: covered|finding, by, evidence }] } (one outsidePlan entry per file the bundle lists under `outsidePlan`: `covered` when a criterion covers that change, with its id in `by`; otherwise `finding` with your finding id in `by`). Then run `wf review --closure <file>`. Only after your closure is recorded, `wf review` may list findings from earlier rounds for you to verify against the code: then add `priorFindings: [{ round, id, status: fixed|verified-nonissue|open, evidence }]` to the same file, change nothing else, and run `wf review --closure <file>` again.',
      tester: 'Write requirement expectations from the issue before reading the implementation, then map each to gate tests.',
    }[role],
  };
  writeJson(file, bundle);
  if (bundle.reviewClosureFile) fs.mkdirSync(path.dirname(bundle.reviewClosureFile), { recursive: true });
  // The model the owner's session runs on now: an agent whose class pins no model inherits it (`wf report` shows it).
  let sessionModelNow = null;
  const owning = sessionIdentity();
  if (!model && owning?.runtime === 'claude') {
    try {
      sessionModelNow = sessionModel(home(), owning.session);
    } catch {}
  }
  append(root, state.id, 'handoff', { role, agent, runtime, session: options.session ?? null, agentType, class: cls, effort, model, sessionModel: sessionModelNow, startPrompt: startPromptFor(file), work: work?.id ?? null, bundle: file, tree: treeHashes(state), patch: patchIds(state), ...(role === 'reviewer' ? { gate: gateNow.ok ? state.lastGate.runId : null } : {}) }, actor(options));
  // Once per attempt: with parallel work items every implementer handoff queued another identical tracker read.
  const firstImplementer = role === 'implementer' && !state.handoffs.some((h) => h.role === 'implementer');
  if (firstImplementer && state.lane !== 'quick' && state.intent === 'implementation') emitTrackerEvent(root, cfg, state.id, 'implementing');
  return { bundle: file, startPrompt: startPromptFor(file), agentType, class: cls, effort, model, work: work?.id ?? null, state: loadState(root, state.id) };
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

export function recordReview(root, options) {
  const state = openState(root, options);
  if (typeof options.closure !== 'string') throw new WfError('--closure <file> is required');
  const closure = readJson(path.resolve(String(options.closure)));
  const reviewerHandoff = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  if (!reviewerHandoff) throw refuse('no reviewer handoff: run `wf handoff reviewer --agent <id>`');
  if (closure.reviewer !== reviewerHandoff.agent) throw refuse(`closure reviewer \`${closure.reviewer}\` is not the reviewer handed this attempt (\`${reviewerHandoff.agent}\`)`);
  if (!Array.isArray(closure.findings) || !Array.isArray(closure.criteria)) throw new WfError('closure needs `findings` and `criteria` lists');
  // Provenance: where transcripts exist, the closure must come from the agent handed this round, started with exactly
  // the printed line after its handoff. A steered reviewer, or a round run outside the engine, is refused.
  const provenance = verifyAgent(reviewerHandoff);
  if (provenance.status === 'mismatch') throw refuse(`review provenance: ${provenance.reason}`, 'start a fresh reviewer: `wf handoff reviewer --agent <new id>` and give it only the printed line');
  // Where the transcript exists, it must show a successful read of every rule document and skill in the bundle. It
  // proves the content reached the reviewer, not that it was understood. Without a transcript: recorded unverified.
  const handed = readBundle(reviewerHandoff.bundle);
  let reads = { status: 'unverified', reason: provenance.reason ?? null };
  if (provenance.status === 'verified' && (handed.rules?.length || handed.skills?.length)) {
    const missing = unreadDocs(readTranscript(provenance.transcript), handed.rules, handed.skills);
    if (missing.length) throw refuse(`the reviewer's transcript shows no successful read of ${missing.length} document(s) its bundle lists:\n  - ${missing.join('\n  - ')}`, 'start a fresh reviewer round: `wf handoff reviewer --agent <new id>` with only the printed line; it reads every document under `rules` and `skills`');
    reads = { status: 'verified', reason: null };
  } else if (provenance.status === 'verified') reads = { status: 'verified', reason: 'nothing to read' };
  // Commit, then reveal: the first closure of a round is blind. Earlier rounds' findings are shown only after it is
  // recorded, and a later closure of the same round may only add their verification.
  const round = reviewerHandoff.bundle;
  const revealed = (state.reviews ?? []).find((r) => r.handoff === round && r.revealed);
  if (!revealed && closure.priorFindings?.length) throw refuse('`priorFindings` are listed only after your own blind closure is recorded; record the closure without them first');
  if (revealed && canonical(revealed.closure.findings) !== canonical(closure.findings)) throw refuse('your own findings were recorded blind and cannot change after earlier rounds were revealed; only add `priorFindings`');
  const revealNow = !revealed && earlierOpenFindings(state, round).length > 0;
  const n = state.reviews.filter((r) => r.handoff === round).length + 1;
  const tag = `${String(state.handoffs.indexOf(reviewerHandoff) + 1).padStart(2, '0')}-${n}`;
  const raw = keepRaw(root, state.id, `review/closure-${tag}.raw.json`, fs.readFileSync(path.resolve(String(options.closure)), 'utf8'));
  const dest = path.join(attemptDir(root, state.id), 'review', `closure-recorded-${state.handoffs.length}.json`);
  writeJson(dest, closure);
  // The closure is for the tree the reviewer was handed. It inspected gate evidence only if a passing gate on that tree
  // was in its bundle (0.1.5 and earlier handed a reviewer only after such a gate, so their handoffs carry no field).
  const gateEvidenceInspected = 'gate' in reviewerHandoff ? Boolean(reviewerHandoff.gate) : true;
  const reviewerModel = reviewerHandoff.runtime === 'claude' ? subagentModel(home(), reviewerHandoff.agent, reviewerHandoff.agentType, reviewerHandoff.at) : null;
  append(root, state.id, 'review.recorded', { closure, file: dest, raw, handoff: round, revealed: Boolean(revealed) || revealNow, provenance: provenance.status, provenanceReason: provenance.reason ?? null, transcript: provenance.transcript ?? null, reads, tree: reviewerHandoff.tree, gateRun: reviewerHandoff.gate ?? null, gateEvidenceInspected, handoffTree: reviewerHandoff.tree, handoffPatch: reviewerHandoff.patch, reviewerModel }, closure.reviewer);
  const after = loadState(root, state.id);
  const toVerify = unverifiedPrior(after, after.review);
  let reveal = null;
  if (toVerify.length) {
    reveal = path.join(root, '.wf-worktrees', state.id, '_review', `prior-findings-${tag}.json`);
    writeJson(reveal, { note: 'Findings earlier review rounds left open. Check each against the current code; add priorFindings to your closure.', findings: toVerify });
  }
  return { state: after, reveal, toVerify };
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
  append(root, state.id, 'review.accepted', { reviewer: r.closure.reviewer, patch: patchIds(state), heads: treeHashes(state), gate: state.lastGate.runId, ...(verdicts.length ? { noEvidence: verdicts } : {}), ...(rv.verdicts.length ? { rules: rv.verdicts } : {}), ...(ov.verdicts.length ? { outsidePlan: ov.verdicts } : {}) }, actor(options));
  return loadState(root, state.id);
}

async function loadDeliveryAdapter(root, cfg, state) {
  const trusted = loadConfigAtCommit(root, cfg, state.adapterBase);
  if (trusted.delivery.kind === 'push-main') return null;
  return (await import(pathToFileURL(adapterFileAtCommit(root, cfg, state.adapterBase, trusted.delivery.kind)).href)).default;
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
      throw refuse(`${repo.base} moved and touches ${[...overlap, ...infra].slice(0, 5).join(', ')}${overlap.length + infra.length > 5 ? '…' : ''}; merged into the worktree. Rerun \`wf gate\`; ${overlap.length ? 'the change itself moved, so hand it to a reviewer again before `wf deliver`' : 'then `wf deliver`'}`);
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
  // A push that landed before the process died is recognised from the remote, not redone or refused.
  for (const [name, r] of Object.entries(state.repos)) {
    if (state.delivery.repos[name] || !git(r.worktree, ['diff', '--name-only', r.base, 'HEAD'])) continue;
    const repo = cfg.repos.find((x) => x.name === name);
    if (!git(r.worktree, ['remote']).split('\n').includes(repo.remote)) continue;
    run('git', ['fetch', '--quiet', repo.remote, repo.base], { cwd: r.worktree, allowFail: true });
    const head = git(r.worktree, ['rev-parse', 'HEAD']);
    const landed = head !== r.base && run('git', ['merge-base', '--is-ancestor', head, `${repo.remote}/${repo.base}`], { cwd: r.worktree, allowFail: true }).status === 0;
    if (!landed) continue;
    // Only the exact commit that was accepted and gated counts as a recovered delivery.
    if (head !== state.accepted.heads?.[name] || head !== state.lastGate?.tree?.[name]) {
      throw refuse(`${name}: ${head.slice(0, 10)} is already on ${repo.remote}/${repo.base} but is not the accepted, gated commit; it was pushed outside wf`, 'review and gate the pushed change in a new attempt (`wf reopen`)');
    }
    append(root, state.id, 'repo.delivered', { repo: name, commit: head, target: `${repo.remote}/${repo.base}`, recovered: true }, actor(options));
  }
  state = loadState(root, state.id);
  // Repos already delivered are on the target branch; compare only what is still to deliver.
  const now = patchIds(state);
  const changedAfter = Object.keys(state.repos).filter((r) => !state.delivery.repos[r] && now[r] !== state.accepted.patch[r]);
  if (changedAfter.length) throw refuse(`the change was modified after acceptance (${changedAfter.join(', ')}); gate and review it again`);
  const g = gatePassedForCurrentTree(state);
  if (!g.ok) throw refuse(`delivery needs a passing gate on the current code: ${g.reason}`);
  const adapter = await loadDeliveryAdapter(root, cfg, state);
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
      if (observed.state !== 'integrated') {
        append(root, state.id, 'repo.integrating', { repo: name, ...integrated, observed }, actor(options));
        if (!state.tracker.done.some((d) => d.event === 'integrating')) emitTrackerEvent(root, cfg, state.id, 'integrating', { url: integrated.url ?? '' });
        return { state: loadState(root, state.id), waiting: { repo: name, ...observed, url: integrated.url } };
      }
      const rb = await adapter.readback({ ...ctx, ...integrated });
      if (!rb.ok) throw refuse(`${name}: readback failed: ${rb.reason ?? 'change not on the target branch'}`);
      result = { repo: name, ...integrated, ...rb };
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

export const shownDraftFile = (root, id) => path.join(attemptDir(root, id), 'delivery', 'shown-draft.json');

// The owner still has to show the delivered screenshots and record it (`wf shown`). An attempt delivered before
// 0.1.11 has no recorded set and owes nothing.
export const needsShown = (state) => Boolean(state.delivery.screenshots?.screenshots?.length) && !state.delivery.shown;

function finishDelivered(root, cfg, state) {
  if (state.lane !== 'batch') {
    const set = deliveredSet(root, state);
    const none = set.length ? null : noScreenshotsReason(root, state);
    append(root, state.id, 'delivery.screenshots', { screenshots: set, none }, null);
    // Nothing to show: the statement of why is the record, no acknowledgement of images is owed.
    if (!set.length) append(root, state.id, 'delivery.shown', { screenshots: [], none, auto: true }, null);
    else writeJson(shownDraftFile(root, state.id), { attempt: state.id, item: state.item, note: 'Copy this file outside .wf-evidence, view each image, replace each caption with what the image shows (which screen, which state), then `wf shown --file <copy>`.', screenshots: set.map((f) => ({ sha256: f.sha256, title: f.title, path: f.path, proposed: f.proposed, caption: f.proposed })) });
    state = loadState(root, state.id);
  }
  const set = state.delivery.screenshots?.screenshots ?? [];
  const actions = state.lane === 'quick' || state.lane === 'batch' ? [] : emitTrackerEvent(root, cfg, state.id, 'delivered', { screenshots: set });
  if (!actions.length && !needsShown(state)) {
    append(root, state.id, 'closed', { reason: cfg.tracker.kind === 'none' || state.lane !== 'standard' ? 'no tracker handoff for this lane' : 'no tracker actions configured' }, null);
    cleanupWorktrees(root, loadState(root, state.id));
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
  if (problems.length) throw refuse(`screenshots not acknowledged:\n  - ${problems.join('\n  - ')}`);
  const n = (state.delivery.shownRecords ?? 0) + 1;
  const kept = keepRaw(root, state.id, `delivery/shown-${n}.raw.json`, text);
  append(root, state.id, 'delivery.shown', { screenshots: shown, none: null, raw: { path: kept.file, sha256: kept.sha256 } }, actor(options));
  return loadState(root, state.id);
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
  if (keep.length === from) throw refuse(`all ${from} delivered files are kept; nothing to narrow`);
  const kept = source.files.filter((f) => keep.includes(f.sha256));
  const plan = { keep, from, to: keep.length, dropped: from - keep.length, reason, legacy: source.legacy, kept: kept.map((f) => ({ sha256: f.sha256, title: f.title ?? path.basename(f.path), path: f.path })) };
  if (options['dry-run']) return { state, dryRun: plan };
  const raw = Array.isArray(parsed) ? null : keepRaw(root, state.id, 'delivery/narrow.raw.json', parsed.text);
  append(root, state.id, 'delivery.narrowed', { keep, from, to: keep.length, dropped: from - keep.length, reason, legacy: source.legacy, raw: raw ? { path: raw.file, sha256: raw.sha256 } : null }, actor(options));
  const after = loadState(root, state.id);
  // A legacy attempt has no draft and owes no `wf shown`: its kept uploads are checked by title only, as before.
  if (!source.legacy) writeJson(shownDraftFile(root, state.id), { attempt: state.id, item: state.item, note: 'Copy this file outside .wf-evidence, view each image, replace each caption with what the image shows (which screen, which state), then `wf shown --file <copy>`.', screenshots: after.delivery.screenshots.screenshots.map((f) => ({ sha256: f.sha256, title: f.title, path: f.path, proposed: f.proposed, caption: f.proposed })) });
  return { state: after, dryRun: null };
}

export function closeAfterHandoff(root, state) {
  if (state.phase === 'handoff-pending' && !state.tracker.pending.length && !needsShown(state)) {
    append(root, state.id, 'closed', { reason: state.tracker.done.some((d) => d.event === 'delivered') ? 'tracker handoff verified' : 'delivered screenshots shown' }, null);
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
  const cfg = loadConfig(root);
  if (s.lane !== 'quick') emitTrackerEvent(root, cfg, s.id, 'reopened');
  return loadState(root, s.id);
}

export function batchCreate(root, options) {
  const cfg = loadConfig(root);
  if (!cfg.lanes.includes('batch')) throw refuse('the batch lane is not enabled for this project');
  const members = String(options.members ?? '').split(',').filter(Boolean);
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
  const member = String(options.member ?? '');
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
  if (state.phase === 'abandoned') return 'nothing: this attempt was abandoned';
  const holdNote = state.activeHold ? ` (on hold: "${state.activeHold.reason}"; \`wf release\` lifts it)` : '';
  const show = needsShown(state) ? `show the owner, in the chat, each of the ${state.delivery.screenshots.screenshots.length} delivered screenshot(s) listed under "delivered screenshots" with a caption saying which screen and state it shows, then record it: \`wf shown --file <copy of ${shownDraftFile(root, state.id)} with your captions>\`` : null;
  if (show && state.phase === 'handoff-pending') {
    const later = state.tracker.pending.length ? `; then the tracker (${state.tracker.pending[0].event}) actions` : '';
    return `${show}${later}`;
  }
  if (state.tracker.pending.length) {
    const ev = state.tracker.pending[0].event;
    const ops = state.tracker.pending.filter((a) => a.event === ev).map((a) => (a.op === 'setStatus' ? `set status to "${a.status}"` : a.op === 'comment' ? 'post the comment (body in `wf status --json`)' : a.op === 'attach' ? `upload and attach ${a.files.length} screenshot(s) as files (title = the name, subtitle = its caption; listed under "delivered screenshots")` : a.op)).join(', ');
    const tracker = `tracker (${ev}): ${ops}; save the readback and run \`wf tracker record --event ${ev} --capture <file>\``;
    if (state.phase === 'handoff-pending') return tracker;
    return `${phaseAction(cfg, state)}${holdNote}. Pending ${tracker}`;
  }
  return `${phaseAction(cfg, state)}${holdNote}`;
}

function phaseAction(cfg, state) {
  // The stop reason is the owner's note about the tree it stopped on; once the code changed it is stale and, shown to a
  // later reviewer, it carried an earlier round's findings into a blind review.
  if (state.stops.length && state.lastGate?.status === 'stopped' && canonical(state.lastGate.tree) === canonical(treeHashes(state))) return `gate stopped (${state.stops.at(-1).reason}); run \`wf gate\` to continue with finished steps carried`;
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
  if (state.accepted) return state.batchOf ? `waiting for batch ${state.batchOf}` : 'deliver: `wf deliver`';
  // Order: review the committed change (the gate may run in parallel), fix findings, gate, then an evidence pass.
  const g = state.lastGate;
  const tree = treeHashes(state);
  const onTree = (t) => t && canonical(t) === canonical(tree);
  const pass = gatePassedForCurrentTree(state);
  const fresh = `a fresh reviewer (new id, never one from an earlier round; start it with only the printed line): \`wf handoff reviewer --agent <new id>\` [${agentTypeFor(cfg, 'reviewer')}]`;
  const focused = g?.status === 'passed' && onTree(g.tree) ? focusedSkips(g) : [];
  const gateRun = focused.length ? `the last gate was focused (skipped ${focused.join(', ')}): run \`wf gate\` without --focused` : 'run `wf gate`';
  const gateHint = pass.ok ? '' : `; the gate can run in parallel (${gateRun}; never edit the worktrees while it runs)`;
  const uncommittedWork = Object.values(tree).some((t) => t.includes('+dirty')) || Object.keys(state.repos).every((n) => !changedFiles(state, n).length);
  if (uncommittedWork) return `commit the change, then hand to ${fresh}${gateHint}`;
  if (g?.status === 'failed' && onTree(g.tree)) return 'gate failed: fix and commit through the implementer that did that work, then `wf gate`';
  const r = state.review;
  const lastReviewer = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  if (lastReviewer && onTree(lastReviewer.tree) && r?.closure.reviewer !== lastReviewer.agent) return `waiting for reviewer ${lastReviewer.agent}: \`wf review --closure <its file>\`${gateHint}`;
  if (!r || !onTree(r.tree ?? r.handoffTree)) return `hand to ${fresh}${gateHint}`;
  const open = openFindings(r);
  if (open.length) return `fix the open findings (${open.map((f) => (f.work ? `${f.id} in ${f.work}` : f.id)).join(', ')}) through the implementer that did that work (continue it; do not start a new one), commit, then hand to ${fresh}; \`wf gate\` on the fixed tree`;
  const toVerify = unverifiedPrior(state, r);
  if (toVerify.length) return `reviewer ${r.closure.reviewer} must verify ${toVerify.length} earlier-round finding(s) (${toVerify.map((f) => `${f.round}:${f.id}`).join(', ')}): it adds \`priorFindings\` to its closure and runs \`wf review --closure <its file>\` again; if it is gone, hand to ${fresh}`;
  if (!pass.ok) return `clean review on this tree: ${gateRun}`;
  if (!reviewedAfterGate(r)) return `evidence pass: the gate passed after the review, so hand to ${fresh} to inspect the gate evidence and screenshots`;
  return 'accept the review: `wf accept`';
}
