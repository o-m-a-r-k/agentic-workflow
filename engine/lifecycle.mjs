import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { actor, branchName, changedFiles, cleanupWorktrees, entry, openState, treeHashes, worktreeDir } from './attempt.mjs';
import { ADAPTER_DIR, adapterFileAtCommit, loadConfig, loadConfigAtCommit, repoDir } from './config.mjs';
import { gatePassedForCurrentTree, screenshots } from './gate.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { deliveryOrder, impact, inside, packageOf } from './topology.mjs';
import { findSkill } from './skills.mjs';
import { emitTrackerEvent } from './tracker.mjs';
import { WfError, YAML, canonical, git, hashValue, matchesAny, readJson, refuse, run, sessionIdentity, writeJson } from './util.mjs';

const readStructured = (file) => {
  let text = fs.readFileSync(path.resolve(String(file)), 'utf8');
  const fenced = text.match(/```(?:ya?ml|json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) text = fenced[1];
  return file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
};

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

export function freezeCriteria(root, options) {
  const state = openState(root, options);
  const cfg = loadConfig(root);
  if (state.criteria) throw refuse('criteria are already frozen', 'change them with `wf criteria amend --file <f> --reason <why>`');
  if (typeof options.file !== 'string') throw new WfError('--file <criteria.yaml|json> is required');
  const doc = readStructured(options.file);
  validateCriteria(doc.criteria);
  if (needsPlanner(cfg, state)) {
    const planner = state.handoffs.filter((h) => h.role === 'planner').at(-1);
    if (!planner) throw refuse(`the ${state.lane} lane needs a planner: run \`wf handoff planner --agent <id>\` first`);
    if (canonical(treeHashes(state)) !== canonical(planner.tree)) throw refuse('the planner changed the worktree; planning must be read-only');
  }
  if (state.handoffs.some((h) => h.role === 'implementer')) throw refuse('implementation already started; criteria must be frozen before implementation');
  append(root, state.id, 'criteria.frozen', { criteria: doc.criteria, plan: doc.plan ?? null }, actor(options));
  return loadState(root, state.id);
}

export function amendCriteria(root, options) {
  const state = openState(root, options);
  if (!state.criteria) throw refuse('criteria are not frozen yet; use `wf plan`');
  if (!options.reason || options.reason === true) throw new WfError('--reason is required (say why the criteria change)');
  const doc = readStructured(options.file);
  validateCriteria(doc.criteria);
  append(root, state.id, 'criteria.amended', { criteria: doc.criteria, reason: String(options.reason), previous: state.criteria }, actor(options));
  return loadState(root, state.id);
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

function skillProblems(root, cfg, role, runtime, state) {
  const problems = [];
  const visual = screenshots(state).length > 0;
  for (const s of cfg.requires.skills ?? []) {
    if (!(s.roles ?? []).includes(role)) continue;
    if (s.when === 'visual' && !visual) continue;
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
  if (role === 'reviewer') {
    const g = gatePassedForCurrentTree(state);
    if (!g.ok) throw refuse(`review needs a passing gate on the current code: ${g.reason}`);
    if (authorsOf(root, state).has(agent)) throw refuse(`${agent} planned, wrote or owns this change and cannot review it`);
  }
  if (role === 'implementer' && state.roles.reviewer.includes(agent)) throw refuse(`${agent} reviewed this attempt and cannot implement it`);
  const skillIssues = skillProblems(root, cfg, role, runtime, state);
  if (skillIssues.length) throw refuse(skillIssues.join('\n'));

  const trusted = loadConfigAtCommit(root, cfg, state.adapterBase);
  const changed = Object.fromEntries(Object.keys(state.repos).map((r) => [r, changedFiles(state, r)]));
  const n = state.handoffs.length + 1;
  const file = path.join(attemptDir(root, state.id), 'handoffs', `${String(n).padStart(2, '0')}-${role}.json`);
  const appendix = cfg.roles?.[role]?.appendix ? path.resolve(root, ADAPTER_DIR, cfg.roles[role].appendix) : null;
  const bundle = {
    attempt: state.id,
    item: state.item,
    lane: state.lane,
    role,
    agent,
    worktrees: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.worktree])),
    bases: Object.fromEntries(Object.entries(state.repos).map(([k, v]) => [k, v.base])),
    // What the planner (and every role) reads first: the issue as captured at entry and from the tracker.
    issue: { file: state.issue?.file ?? null, trackerCaptures: state.tracker.done.map((d) => d.capture?.path).filter(Boolean) },
    criteria: state.criteria,
    plan: state.plan,
    criteriaAmendments: state.criteriaAmendments,
    changed,
    impact: impact(trusted, changed),
    invariants: cfg.invariants ? path.resolve(root, ADAPTER_DIR, cfg.invariants) : null,
    roleAppendix: appendix && fs.existsSync(appendix) ? appendix : null,
    gate: role === 'reviewer' ? { evidence: state.lastGate.evidence, screenshots: screenshots(state), logs: state.lastGate.steps.filter((s) => s.log).map((s) => ({ step: s.id, log: s.log, status: s.status })) } : null,
    // Outside .wf-evidence/: the reviewer writes it, `wf review` copies it into the evidence.
    reviewClosureFile: role === 'reviewer' ? path.join(root, '.wf-worktrees', state.id, '_review', `closure-${n}.json`) : null,
    instructions: {
      planner: 'Read the issue and the code. Do not change any file. Return a plan and criteria as YAML: { plan: <text>, criteria: [{ id: C1, text, uat }] }.',
      implementer: 'Implement against the frozen criteria in the worktrees above. Write tests only for real behaviour. Commit everything when done.',
      reviewer: 'Review the diff and the gate evidence. You did not write this change. Write the closure file: { reviewer, findings: [{ id, severity, summary, status: open|fixed|verified-nonissue, evidence }], criteria: [{ id, evidence: { kind: test|screenshot|output|not-applicable|dropped-with-reason, ref, reason } }], screenshotsInspected: [sha256] }. Then run `wf review --closure <file>`.',
      tester: 'Write requirement expectations from the issue before reading the implementation, then map each to gate tests.',
    }[role],
  };
  writeJson(file, bundle);
  if (bundle.reviewClosureFile) fs.mkdirSync(path.dirname(bundle.reviewClosureFile), { recursive: true });
  append(root, state.id, 'handoff', { role, agent, runtime, session: options.session ?? null, bundle: file, tree: treeHashes(state), patch: patchIds(state) }, actor(options));
  if (role === 'implementer' && state.lane !== 'quick' && state.intent === 'implementation') emitTrackerEvent(root, cfg, state.id, 'implementing');
  return { bundle: file, state: loadState(root, state.id) };
}

export function recordReview(root, options) {
  const state = openState(root, options);
  if (typeof options.closure !== 'string') throw new WfError('--closure <file> is required');
  const closure = readJson(path.resolve(String(options.closure)));
  const reviewerHandoff = state.handoffs.filter((h) => h.role === 'reviewer').at(-1);
  if (!reviewerHandoff) throw refuse('no reviewer handoff: run `wf handoff reviewer --agent <id>`');
  if (closure.reviewer !== reviewerHandoff.agent) throw refuse(`closure reviewer \`${closure.reviewer}\` is not the reviewer handed this attempt (\`${reviewerHandoff.agent}\`)`);
  if (!Array.isArray(closure.findings) || !Array.isArray(closure.criteria)) throw new WfError('closure needs `findings` and `criteria` lists');
  const dest = path.join(attemptDir(root, state.id), 'review', `closure-recorded-${state.handoffs.length}.json`);
  writeJson(dest, closure);
  append(root, state.id, 'review.recorded', { closure, file: dest, handoffTree: reviewerHandoff.tree, handoffPatch: reviewerHandoff.patch }, closure.reviewer);
  return loadState(root, state.id);
}

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
  const shots = screenshots(state).map((s) => s.sha256);
  const inspected = new Set(r.closure.screenshotsInspected ?? []);
  const unseen = shots.filter((h) => !inspected.has(h));
  if (unseen.length) problems.push(`${unseen.length} gate screenshot(s) not inspected by the reviewer`);
  if (canonical(patchIds(state)) !== canonical(r.handoffPatch)) problems.push('the change was modified after the review handoff; hand it to a reviewer again');
  const g = gatePassedForCurrentTree(state);
  if (!g.ok) problems.push(`gate: ${g.reason}`);
  if (problems.length) throw refuse(`review not accepted:\n  - ${problems.join('\n  - ')}`);
  append(root, state.id, 'review.accepted', { reviewer: r.closure.reviewer, patch: patchIds(state), heads: treeHashes(state), gate: state.lastGate.runId }, actor(options));
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

function finishDelivered(root, cfg, state) {
  const shots = screenshots(state.batch ? state : state.delivery.viaBatch ? loadState(root, state.delivery.viaBatch) : state);
  const actions = state.lane === 'quick' || state.lane === 'batch' ? [] : emitTrackerEvent(root, cfg, state.id, 'delivered', { screenshots: shots });
  if (!actions.length) {
    append(root, state.id, 'closed', { reason: cfg.tracker.kind === 'none' || state.lane !== 'standard' ? 'no tracker handoff for this lane' : 'no tracker actions configured' }, null);
    cleanupWorktrees(root, loadState(root, state.id));
  }
}

export function closeAfterHandoff(root, state) {
  if (state.phase === 'handoff-pending' && !state.tracker.pending.length) {
    append(root, state.id, 'closed', { reason: 'tracker handoff verified' }, null);
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

export function nextAction(root, state) {
  const cfg = loadConfig(root);
  if (state.phase === 'done') return 'nothing: this attempt is closed';
  if (state.phase === 'abandoned') return 'nothing: this attempt was abandoned';
  const holdNote = state.activeHold ? ` (on hold: "${state.activeHold.reason}"; \`wf release\` lifts it)` : '';
  if (state.tracker.pending.length) {
    const ev = state.tracker.pending[0].event;
    const ops = state.tracker.pending.filter((a) => a.event === ev).map((a) => (a.op === 'setStatus' ? `set status to "${a.status}"` : a.op === 'comment' ? 'post the comment (body in `wf status --json`)' : a.op === 'attach' ? `attach ${a.files.length} screenshot(s)` : a.op)).join(', ');
    const tracker = `tracker (${ev}): ${ops}; save the readback and run \`wf tracker record --event ${ev} --capture <file>\``;
    if (state.phase === 'handoff-pending') return tracker;
    return `${phaseAction(cfg, state)}${holdNote}. Pending ${tracker}`;
  }
  return `${phaseAction(cfg, state)}${holdNote}`;
}

function phaseAction(cfg, state) {
  if (state.stops.length && state.lastGate?.status === 'stopped') return `gate stopped (${state.stops.at(-1).reason}); run \`wf gate\` to continue with finished steps carried`;
  if (!state.criteria) {
    if (needsPlanner(cfg, state) && !state.handoffs.some((h) => h.role === 'planner')) return 'start the planner: `wf handoff planner --agent <id>`';
    return 'freeze the criteria: `wf plan --file <criteria.yaml>`';
  }
  if (state.lane !== 'batch' && !state.handoffs.some((h) => h.role === 'implementer')) return 'start the implementer: `wf handoff implementer --agent <id>`';
  const g = state.lastGate;
  if (!g || g.status !== 'passed') return g ? `gate ${g.status}: fix and commit, then \`wf gate\`` : 'commit the change, then `wf gate`';
  if (!state.review) return 'hand to an independent reviewer: `wf handoff reviewer --agent <id>`';
  if (!state.accepted) {
    const open = state.review.closure.findings.filter((f) => !['fixed', 'verified-nonissue'].includes(f.status));
    if (open.length) return `fix the open findings (${open.map((f) => f.id).join(', ')}) through the implementer, commit, \`wf gate\`, then hand to the reviewer again (\`wf handoff reviewer --agent <id>\`)`;
    return 'accept the review: `wf accept`';
  }
  if (state.batchOf) return `waiting for batch ${state.batchOf}`;
  return 'deliver: `wf deliver`';
}
