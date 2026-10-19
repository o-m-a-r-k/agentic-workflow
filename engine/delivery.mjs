// Delivery (design 0.8, section 5 "Stages"; stream 3). An attempt is delivered through the stage list snapshotted at
// `attempt.started` (the adapter is read live for everything else: order, authority, tracker). Stage kinds: land, push,
// merge-request, wait-merged, confirm-deployed, deploy (always the person's), status, comment, module.
//
// - Each repo's part is delivered separately, against its own base, in `delivery.order`.
// - push and merge-request record the accepted commit per repo; wait-merged matches it on the base by ancestry or by
//   patch-id (a squash or a rebase merge).
// - Push and merge-request authority come from `delivery.authority`: `agent` lets the engine (or the owner) act; anything
//   else is the person's, and the stage waits for the fact on the remote.
// - Every tracker write carries an idempotency marker (`wf:<attempt>:stage-<index>`), searched for before writing.
// - `when: { labels }` filters a stage by the item's labels; labels that could not be read are pending, never false.
// - `after: <item>` waits until that item has shipped.
// - Refusals: `hold` (any stage under a hold) and `stage:deploy` (a deploy without the person's decision).
import fs from 'node:fs';
import path from 'node:path';
import {
  WfError, append, answered, ask, attemptDir, attemptState, branchName, canonicalJson, land, listAttempts, loadAdapter,
  marker, mergeFacts, readEvents, refusal, worktreeDir,
} from './contract.mjs';
import { canonicalItem, connectorStep, git, loadModule, trackerOf, wordsFor } from './tracker.mjs';

export const STAGE_KINDS = ['land', 'push', 'merge-request', 'wait-merged', 'confirm-deployed', 'deploy', 'status', 'comment', 'module'];
const STATES = ['done', 'waiting', 'pending', 'skipped'];
const settled = (r) => r && (r.state === 'done' || r.state === 'skipped');

// ---- repos and git facts ----------------------------------------------------------------------------------------------

function repoInfo(ctx, name) {
  const spec = ctx.adapter.repos.find((r) => r.name === name);
  if (!spec) throw new WfError(`repo \`${name}\` is not in the adapter`);
  const rec = ctx.state.repos?.[name] ?? {};
  const checkout = path.join(ctx.root, spec.path);
  const wt = rec.worktree ?? worktreeDir(ctx.root, ctx.attempt, name);
  return {
    name,
    dir: fs.existsSync(wt) ? wt : checkout,
    branch: rec.branch ?? branchName(ctx.attempt),
    base: rec.base ?? spec.base,
    baseSha: rec.baseSha ?? null,
    remote: spec.remote ?? 'origin',
  };
}

const hasRemote = (r) => git(r.dir, ['remote']).split('\n').includes(r.remote);
const sha = (r, ref) => {
  const out = git(r.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return out.status === 0 ? out.stdout.trim() : null;
};
// The remote copy of a branch, fetched (offline: the last fetched copy); a repo with no remote: the local branch.
function remoteRef(r, branch) {
  if (!hasRemote(r)) return sha(r, branch) ? branch : null;
  git(r.dir, ['fetch', '--quiet', r.remote, `+refs/heads/${branch}:refs/remotes/${r.remote}/${branch}`], { allowFail: true });
  const ref = `${r.remote}/${branch}`;
  return sha(r, ref) ? ref : null;
}
const isAncestor = (r, a, b) => git(r.dir, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).status === 0;
const hasChange = (r) => {
  const tip = sha(r, r.branch);
  if (!tip) return false;
  const from = r.baseSha ?? sha(r, r.base);
  return from ? Number(git(r.dir, ['rev-list', '--count', `${from}..${tip}`])) > 0 : true;
};

// patch-id per commit of a range (merges left out): Map<patchId, commit>.
function patchIds(r, range) {
  const log = git(r.dir, ['log', '-p', '--no-merges', '--format=commit %H', range], { allowFail: true });
  if (log.status !== 0 || !log.stdout.trim()) return new Map();
  const out = git(r.dir, ['patch-id', '--stable'], { input: log.stdout });
  return new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ')).map(([p, c]) => [p, c]));
}
function diffPatchId(r, from, to) {
  const diff = git(r.dir, ['diff', '--no-color', from, to], { allowFail: true });
  if (diff.status !== 0 || !diff.stdout.trim()) return null;
  return git(r.dir, ['patch-id', '--stable'], { input: diff.stdout }).split(' ')[0] || null;
}

// Whether `commit` is on `baseRef`: as an ancestor, as one commit with the same patch-id as its whole change (a squash),
// or as commits with every one of its commits' patch-ids (a rebase).
export function mergedOn(r, commit, baseRef) {
  if (isAncestor(r, commit, baseRef)) return { how: 'ancestor', sha: commit };
  const mb = git(r.dir, ['merge-base', commit, baseRef], { allowFail: true }).stdout?.trim();
  if (!mb) return null;
  const onBase = patchIds(r, `${mb}..${baseRef}`);
  if (!onBase.size) return null;
  const whole = diffPatchId(r, mb, commit);
  if (whole && onBase.has(whole)) return { how: 'patch-id', sha: onBase.get(whole) };
  const own = patchIds(r, `${mb}..${commit}`);
  if (own.size && [...own.keys()].every((p) => onBase.has(p))) return { how: 'patch-id', sha: onBase.get([...own.keys()][0]) };
  return null;
}

// The repos a stage delivers: the attempt's repos with a change, in `delivery.order` (then the rest in the attempt's
// order), narrowed to the stage's `repos:`.
function stageRepos(ctx) {
  const own = Object.keys(ctx.state.repos ?? {});
  const order = ctx.adapter.delivery?.order?.length ? ctx.adapter.delivery.order : ctx.adapter.repos.map((r) => r.name);
  let list = [...order.filter((n) => own.includes(n)), ...own.filter((n) => !order.includes(n))];
  if (ctx.stage.repos?.length) list = list.filter((n) => ctx.stage.repos.includes(n));
  return list.map((n) => repoInfo(ctx, n)).filter(hasChange);
}

// The accepted commit per repo an earlier stage recorded (the latest push or merge-request result).
function acceptedCommits(ctx) {
  const out = {};
  const results = Object.entries(ctx.state.stageResults ?? {}).filter(([i]) => Number(i) >= 0 && Number(i) < ctx.index).sort(([a], [b]) => a - b);
  for (const [, res] of results) for (const [repo, v] of Object.entries(res.evidence?.repos ?? {})) if (v?.accepted) out[repo] = v.accepted;
  return out;
}

const authorityOf = (ctx, what) => (ctx.adapter.delivery?.authority?.[what] === 'agent' ? 'agent' : 'person');

// ---- tracker reads ----------------------------------------------------------------------------------------------------

// The item's labels: an array, or null when they could not be read. Through a connector the owner reports them
// (`wf deliver --labels`); a report is kept in the stage's evidence.
async function itemLabels(ctx) {
  const tr = await ctx.tracker();
  if (tr.via === 'none') return { labels: [] };
  if (tr.driver) {
    try {
      const issue = await tr.driver.read(ctx.item);
      return { labels: issue ? issue.labels ?? null : null };
    } catch {
      return { labels: null };
    }
  }
  if (Array.isArray(ctx.opts.labels)) return { labels: ctx.opts.labels, reported: true };
  const reports = Object.values(ctx.state.stageResults ?? {}).filter((r) => Array.isArray(r.evidence?.labelsReported)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (reports.length) return { labels: reports.at(-1).evidence.labelsReported };
  return { labels: null, connector: true };
}

async function whenGate(ctx) {
  const want = ctx.stage.when?.labels;
  if (!want?.length) return null;
  const { labels, reported, connector } = await itemLabels(ctx);
  if (labels === null) {
    const tr = await ctx.tracker();
    const evidence = { when: { labels: want, read: 'pending' } };
    if (connector) return { state: 'pending', evidence, next: `${wordsFor(tr, 'read')} (${ctx.item}), then report its labels: wf deliver ${ctx.attempt} --labels "<label>,<label>"` };
    return { state: 'waiting', evidence, next: `the labels of ${ctx.item} could not be read; wf deliver ${ctx.attempt} checks again` };
  }
  const lower = labels.map((l) => String(l).toLowerCase());
  const hit = want.some((w) => lower.includes(String(w).toLowerCase()));
  const evidence = { when: { labels: want, read: labels }, ...(reported ? { labelsReported: labels } : {}) };
  return hit ? { pass: true, evidence } : { state: 'skipped', evidence, next: null };
}

async function afterGate(ctx) {
  const other = ctx.stage.after;
  if (!other) return null;
  for (const a of await listAttempts(ctx.root, { item: other })) {
    const s = await attemptState(ctx.root, a);
    if (s.outcome === 'shipped') return null;
  }
  return { state: 'waiting', evidence: { after: other }, next: `waits until ${other} has shipped` };
}

// ---- stage kinds ------------------------------------------------------------------------------------------------------

function refuseOnMergeFacts(problems) {
  const blocking = problems.filter((p) => p.id !== 'merge:untested');
  if (blocking.length) throw refusal(blocking[0].id, blocking.map((p) => p.message).join('; '));
}

async function stageLand(ctx) {
  refuseOnMergeFacts(await mergeFacts(ctx.root, ctx.attempt));
  const repos = stageRepos(ctx).map((r) => r.name);
  if (ctx.adapter.delivery?.landing === 'direct') {
    const res = await land(ctx.root, [ctx.attempt]);
    const failed = res.failed.filter((f) => f.attempt === ctx.attempt);
    const landed = Object.fromEntries(res.landed.filter((l) => l.attempt === ctx.attempt).map((l) => [l.repo, { accepted: l.sha }]));
    if (failed.length) return { state: 'waiting', evidence: { repos: landed, failed }, next: `landing failed in ${failed.map((f) => `${f.repo}: ${f.reason}`).join('; ')}; fix it, then wf deliver ${ctx.attempt}` };
    return { state: 'done', evidence: { repos: landed }, next: null };
  }
  const evidence = { repos: {} };
  const missing = [];
  for (const repo of repos) {
    const last = (ctx.state.landings ?? []).filter((l) => l.repo === repo && (l.attempts ?? []).includes(ctx.attempt)).at(-1);
    if (last?.result === 'landed') evidence.repos[repo] = { accepted: last.sha ?? null, batch: last.batch };
    else if (last) return { state: 'waiting', evidence: { ...evidence, failed: { repo, result: last.result, log: last.log ?? null } }, next: `the landing run returned ${ctx.attempt} in ${repo} (${last.result}${last.log ? `: ${last.log}` : ''}); fix it, then wf land` };
    else missing.push(repo);
  }
  if (missing.length) return { state: 'waiting', evidence: { ...evidence, queued: missing }, next: `in the landing queue (${missing.join(', ')}): wf land` };
  return { state: 'done', evidence, next: null };
}

// Push one repo's tip to `target` on its remote, unless the remote holds it already. null when done, else a result.
async function pushRepo(ctx, r, target, evidence) {
  const tip = sha(r, r.branch);
  if (!tip) throw new WfError(`${r.name}: branch ${r.branch} is missing`);
  const ref = remoteRef(r, target);
  if (ref && isAncestor(r, tip, ref)) {
    evidence.repos[r.name] = { accepted: tip, target, pushed: false };
    return null;
  }
  if (authorityOf(ctx, 'push') !== 'agent') {
    evidence.repos[r.name] = { accepted: tip, target, pushed: false, by: 'person' };
    return { state: 'waiting', evidence, next: `the person pushes ${r.branch} (${tip.slice(0, 12)}) to ${r.remote}/${target} in ${r.name}; wf deliver ${ctx.attempt} checks again` };
  }
  if (target === r.base) refuseOnMergeFacts(await mergeFacts(ctx.root, ctx.attempt, { repo: r.name, landedTree: git(r.dir, ['rev-parse', `${tip}^{tree}`]) }));
  const pushed = git(r.dir, ['push', '--quiet', r.remote, `${tip}:refs/heads/${target}`], { allowFail: true });
  if (pushed.status !== 0) throw new WfError(`push of ${r.name} to ${r.remote}/${target} failed: ${(pushed.stderr || pushed.stdout).trim()}`);
  evidence.repos[r.name] = { accepted: tip, target, pushed: true };
  return null;
}

async function stagePush(ctx) {
  const evidence = { repos: {} };
  for (const r of stageRepos(ctx)) {
    const stop = await pushRepo(ctx, r, ctx.stage.branch ?? r.branch, evidence);
    if (stop) return stop;
  }
  return { state: 'done', evidence, next: null };
}

async function stageMergeRequest(ctx) {
  const evidence = { repos: {}, marker: ctx.marker };
  const repos = stageRepos(ctx);
  for (const r of repos) {
    const stop = await pushRepo(ctx, r, r.branch, evidence);
    if (stop) return stop;
    evidence.repos[r.name].base = r.base;
  }
  const what = repos.map((r) => `${r.name}: ${r.branch} into ${r.base}`).join('; ');
  if (authorityOf(ctx, 'mergeRequest') !== 'agent') return { state: 'done', evidence: { ...evidence, by: 'person' }, next: `the person opens a merge request in ${what}` };
  const tr = await ctx.tracker();
  const r = await connectorStep(ctx.root, ctx.attempt, { op: 'mergeRequest', tr, match: ctx.marker, mark: ctx.marker });
  if (r.state === 'done') return { state: 'done', evidence: { ...evidence, call: { tool: r.value.tool, at: r.value.at } }, next: null };
  return { state: 'pending', evidence, next: `${r.operation} ${what}, each with "${ctx.marker}" in its description; then wf deliver ${ctx.attempt}` };
}

async function stageWaitMerged(ctx) {
  const accepted = acceptedCommits(ctx);
  const evidence = { repos: {} };
  const open = [];
  for (const r of stageRepos(ctx)) {
    const baseRef = remoteRef(r, r.base);
    if (!baseRef) throw new WfError(`${r.name}: its base ${r.base} cannot be read`);
    const candidates = [...new Set([accepted[r.name], sha(r, r.branch)].filter(Boolean))];
    let merged = null;
    for (const c of candidates) if ((merged = mergedOn(r, c, baseRef))) break;
    if (merged) evidence.repos[r.name] = { accepted: accepted[r.name] ?? candidates[0], merged: merged.sha, how: merged.how };
    else {
      evidence.repos[r.name] = { accepted: accepted[r.name] ?? candidates[0], merged: null };
      open.push(r.name);
    }
  }
  if (open.length) return { state: 'waiting', evidence, next: `waits for the merge of ${open.join(', ')}; wf deliver ${ctx.attempt} checks again` };
  return { state: 'done', evidence, next: null };
}

async function stageConfirmDeployed(ctx) {
  const where = ctx.stage.where ?? 'where it deploys';
  if (ctx.opts.observed) return { state: 'done', evidence: { where, observed: ctx.opts.observed }, next: null, usedObserved: true };
  return { state: 'pending', evidence: { where }, next: `confirm the merged change runs in ${where} and test the fix there, read-only; then wf deliver ${ctx.attempt} --observed "<what you saw>"` };
}

async function stageDeploy(ctx) {
  const where = ctx.stage.where ?? 'production';
  const q = { kind: 'deploy', question: `Deploy ${ctx.item} to ${where}?`, options: ['deploy', 'not now'], refs: [`stage:${ctx.index}`], blocking: true };
  const { id } = await ask(ctx.root, ctx.attempt, q);
  const a = await answered(ctx.root, id, { attempt: ctx.attempt });
  if (!a) throw refusal('stage:deploy', `deploying ${ctx.item} to ${where} is the person's decision; it is asked as ${id}`, `ask the person ${id}, then wf deliver ${ctx.attempt}`);
  const evidence = { where, decision: id, choice: a.choice };
  if (a.choice !== 'deploy') return { state: 'waiting', evidence, next: `the person chose "${a.choice}" for the deploy (${id}); the delivery stops here` };
  if (ctx.stage.module) return runModule(ctx, { decision: id });
  if (ctx.opts.observed) return { state: 'done', evidence: { ...evidence, observed: ctx.opts.observed }, next: null, usedObserved: true };
  return { state: 'pending', evidence, next: `deploy to ${where} as the person decided (${id}); then wf deliver ${ctx.attempt} --observed "<what you saw>"` };
}

// The comment of kind `kind`, written by the owner in product words, posted once (its marker searched first).
async function postComment(ctx, kind, m) {
  const tr = await ctx.tracker();
  if (tr.via === 'none') return { state: 'skipped', evidence: { comment: kind, tracker: 'none' }, next: null };
  const file = path.join(attemptDir(ctx.root, ctx.attempt), 'comments', `${kind}.md`);
  const evidence = { comment: kind, marker: m };
  if (tr.driver && (await tr.driver.search({ marker: m })).length) return { state: 'done', evidence: { ...evidence, written: false }, next: null };
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').trim()) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); // the folder the owner writes the comment into
    return { state: 'pending', evidence, next: `write the ${kind} comment for ${ctx.item} in product words (what to test; no file paths, commits or hashes) to ${file}; then wf deliver ${ctx.attempt}` };
  }
  const body = `${fs.readFileSync(file, 'utf8').trim()}\n\n${m}`;
  if (tr.driver) {
    await tr.driver.comment(ctx.item, { body, marker: m });
    if (!(await tr.driver.search({ marker: m })).length) throw new WfError(`the ${kind} comment on ${ctx.item} does not read back (marker ${m})`);
    return { state: 'done', evidence: { ...evidence, written: true }, next: null };
  }
  const r = await connectorStep(ctx.root, ctx.attempt, { op: 'comment', tr, match: m, mark: m });
  if (r.state === 'done') return { state: 'done', evidence: { ...evidence, call: { tool: r.value.tool, at: r.value.at } }, next: null };
  return { state: 'pending', evidence, next: `${r.operation} Item ${ctx.item}; the comment is ${file} and must end with "${m}". Then wf deliver ${ctx.attempt}` };
}

async function stageStatus(ctx) {
  const to = ctx.stage.to;
  if (!to) throw new WfError(`stage ${ctx.index} (status) names no status (\`to:\`)`);
  const evidence = { status: to };
  if (ctx.stage.comment) {
    const c = await postComment(ctx, ctx.stage.comment, `${ctx.marker}:comment`);
    if (!settled(c)) return { ...c, evidence: { ...evidence, ...c.evidence } };
    evidence.comment = c.evidence;
  }
  const tr = await ctx.tracker();
  if (tr.via === 'none') return { state: 'skipped', evidence: { ...evidence, tracker: 'none' }, next: null };
  if (tr.driver) {
    const issue = await tr.driver.read(ctx.item);
    if (!issue) throw new WfError(`no item ${ctx.item} in the tracker`);
    if (issue.status === to) return { state: 'done', evidence: { ...evidence, written: false }, next: null };
    await tr.driver.setStatus(ctx.item, to);
    const back = await tr.driver.read(ctx.item);
    if (back?.status !== to) throw new WfError(`${ctx.item} was set to "${to}" but reads back "${back?.status ?? 'nothing'}"`);
    return { state: 'done', evidence: { ...evidence, written: true, from: issue.status }, next: null };
  }
  const r = await connectorStep(ctx.root, ctx.attempt, { op: 'setStatus', tr, match: [ctx.item, to] });
  if (r.state === 'done') return { state: 'done', evidence: { ...evidence, call: { tool: r.value.tool, at: r.value.at } }, next: null };
  return { state: 'pending', evidence, next: `${r.operation} Item ${ctx.item} to "${to}"; then wf deliver ${ctx.attempt}` };
}

async function stageComment(ctx) {
  if (!ctx.stage.comment) throw new WfError(`stage ${ctx.index} (comment) names no comment kind (\`comment:\`)`);
  return postComment(ctx, ctx.stage.comment, ctx.marker);
}

async function runModule(ctx, extra = {}) {
  const mod = await loadModule(ctx.root, ctx.adapter, ctx.stage.module, ctx.attempt);
  const fn = mod.default;
  if (typeof fn !== 'function') throw new WfError(`stage module ${ctx.stage.module.repo}/${ctx.stage.module.path} has no default function`);
  const repos = Object.fromEntries(Object.keys(ctx.state.repos ?? {}).map((n) => {
    const r = repoInfo(ctx, n);
    return [n, { dir: r.dir, branch: r.branch, base: r.base, remote: r.remote, tip: sha(r, r.branch) }];
  }));
  const res = await fn({ root: ctx.root, attempt: ctx.attempt, item: ctx.item, index: ctx.index, stage: ctx.stage, marker: ctx.marker, repos, observed: ctx.opts.observed ?? null, ...extra });
  if (!res || !STATES.includes(res.state)) throw new WfError(`stage module ${ctx.stage.module.repo}/${ctx.stage.module.path} returned no state (one of ${STATES.join(', ')})`);
  return { state: res.state, evidence: res.evidence ?? null, next: res.next ?? null };
}

const KINDS = {
  land: stageLand,
  push: stagePush,
  'merge-request': stageMergeRequest,
  'wait-merged': stageWaitMerged,
  'confirm-deployed': stageConfirmDeployed,
  deploy: stageDeploy,
  status: stageStatus,
  comment: stageComment,
  module: (ctx) => runModule(ctx),
};

// ---- runStage ---------------------------------------------------------------------------------------------------------

async function waitedSince(root, attempt, index) {
  let events = [];
  try {
    events = await readEvents(root, attempt);
  } catch {}
  const first = events.find((e) => e.type === 'stage' && e.data?.index === index && !['done', 'skipped'].includes(e.data?.state));
  return first ? Math.round((Date.now() - Date.parse(first.at)) / 60000) : 0;
}

/**
 * Run one delivery stage (contract runStage): an index into the attempt's snapshot, or a Stage (start's `ticketing.take`,
 * index -1; `{ status }` is read as `{ do: status, to }`). Appends `stage` when the result changed. A settled stage
 * (done or skipped) is returned as recorded, never run again. opts (cmdDeliver): actor, observed, labels.
 */
export async function runStage(root, attempt, stage, opts = {}) {
  const adapter = await loadAdapter(root);
  const state = await attemptState(root, attempt);
  let index;
  let st;
  if (typeof stage === 'number') {
    index = stage;
    st = (state.stages ?? [])[index];
    if (!st) throw new WfError(`${attempt} has no delivery stage ${index}: its stage list (snapshotted at start) has ${(state.stages ?? []).length}`);
  } else {
    index = -1;
    st = stage?.do ? stage : { do: 'status', to: stage?.status };
  }
  if (!STAGE_KINDS.includes(st.do)) throw new WfError(`stage ${index}: unknown kind \`${st.do}\` (the kinds are ${STAGE_KINDS.join(', ')})`);
  if (state.hold) throw refusal('hold', `${attempt} is on hold ("${state.hold.quote || state.hold.reason}"); no delivery stage runs under a hold`, 'only the person lifts it: wf release');
  const prev = state.stageResults?.[index] ?? null;
  if (settled(prev)) return prev;

  let tracker = null;
  const ctx = {
    root, attempt, adapter, state, index, stage: st, opts,
    marker: marker(attempt, `stage-${index}`),
    tracker: async () => (tracker ??= await trackerOf(root, adapter, { attempt })),
  };
  ctx.item = await canonicalItem(root, adapter, state.item, await ctx.tracker()) ?? state.item;

  let result = await afterGate(ctx);
  let gateEvidence = null;
  if (!result) {
    const w = await whenGate(ctx);
    if (w?.pass) gateEvidence = w.evidence;
    else result = w;
  }
  if (!result) {
    result = await KINDS[st.do](ctx);
    if (gateEvidence) result = { ...result, evidence: { ...gateEvidence, ...(result.evidence ?? {}) } };
  }
  const usedObserved = Boolean(result.usedObserved);
  const out = { state: result.state, evidence: result.evidence ?? null, next: result.next ?? null };
  if (out.state === 'done') out.waitedMin = await waitedSince(root, attempt, index);
  const changed = !prev || prev.state !== out.state || canonicalJson(prev.evidence ?? null) !== canonicalJson(out.evidence) || (prev.next ?? null) !== out.next;
  if (changed) {
    const data = { index, do: st.do, state: out.state, evidence: out.evidence, next: out.next, marker: ctx.marker };
    if (out.waitedMin !== undefined) data.waitedMin = out.waitedMin;
    await append(root, attempt, 'stage', data, opts.actor ?? null);
  }
  return usedObserved ? { ...out, usedObserved } : out;
}

// ---- wf deliver -------------------------------------------------------------------------------------------------------

async function pickAttempt(root, named) {
  if (named) return named;
  const open = [];
  for (const a of await listAttempts(root)) {
    try {
      const s = await attemptState(root, a);
      if (s.schema === 2 && s.open) open.push(a);
    } catch {}
  }
  if (open.length === 1) return open[0];
  throw new WfError(open.length ? `name the attempt: ${open.join(', ')} are open` : 'no open attempt to deliver');
}

const flag = (args, k) => {
  const v = args.flags?.[k];
  return Array.isArray(v) ? v.at(-1) : v;
};

/** `wf deliver [<attempt>] [--stage <i>] [--observed "<what you saw>"] [--labels "<a>,<b>"]`: run the next stages. */
export async function cmdDeliver(ctx, args = { _: [], flags: {} }) {
  if (!ctx.root) throw new WfError('no project here: wf deliver runs inside a project with an adapter');
  const attempt = await pickAttempt(ctx.root, args._?.[0] ?? flag(args, 'attempt'));
  const observed = flag(args, 'observed');
  const labelsFlag = flag(args, 'labels');
  const opts = {
    actor: ctx.actor ?? null,
    observed: typeof observed === 'string' && observed.trim() ? observed.trim() : null,
    labels: typeof labelsFlag === 'string' ? labelsFlag.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
  const state = await attemptState(ctx.root, attempt);
  const stages = state.stages ?? [];
  const only = flag(args, 'stage');
  const indexes = only !== undefined ? [Number(only)] : stages.map((_, i) => i);
  if (indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= stages.length)) throw new WfError(`--stage must be 0..${stages.length - 1}`);
  const results = [];
  for (const i of indexes) {
    const r = await runStage(ctx.root, attempt, i, opts);
    if (r.usedObserved) opts.observed = null;
    results.push({ index: i, do: stages[i].do, state: r.state, next: r.next ?? null, evidence: r.evidence ?? null });
    if (!settled(r)) break;
  }
  const last = results.at(-1);
  const delivered = results.length === stages.length && results.every(settled) && only === undefined;
  const lines = results.map((r) => `${r.index} ${r.do}: ${r.state}${r.next ? ` — ${r.next}` : ''}`);
  const next = delivered ? 'delivered: every stage is done; wf close' : last?.next ?? null;
  return { text: [`${attempt}`, ...lines, ...(next && next !== last?.next ? [next] : [])].join('\n'), data: { attempt, results, delivered, next }, exitCode: 0 };
}

export const implements08 = { runStage, cmdDeliver };
