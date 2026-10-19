// Attempts (design section 2, steps 1 and 10). Stream 1.
//
// `wf start <item>` normalises the item id through the tracker, continues the attempt numbers of old ledgers and branches,
// fetches each repo and creates one worktree per repo at the fetched tip of its base, provisions it, snapshots the delivery
// stages and records `attempt.started`. It never merges staging or sibling branches. `wf hold` records the person's veto
// at once; only the person lifts it (`wf release`, on their answer). `wf close` closes a shipped attempt (its stages are
// done, or its commits are on the base by patch-id), writes the telemetry row, removes the worktrees and keeps the branches.
// `wf abandon` does the same for work that will not ship.
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_LEDGER, WfError, answered, append, ask, attemptId, attemptState, branchName, listAttempts, loadAdapter, normaliseId, readEvents,
  refusal, row, runStage, worktreeDir, writeRow,
} from './contract.mjs';
import { baseRef, dirtyRepos, fetchBase, specOf } from './base.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { ENGINE_VERSION, assertPlainGit, assertSafeId, git, hashFile, run } from './util.mjs';

// --- shared reads (used by flow.mjs too) -------------------------------------------------------------------------------

// Stream 4's reserved ledger of project-level decisions: not an attempt (listAttempts never lists it).
export { PROJECT_LEDGER };

export const schema2 = (events) => events.filter((e) => e.schema === 2);

// The hold in force, from the attempt's own hold/release events: { reason, quote, at } or null.
export function holdOf(events) {
  let hold = null;
  for (const e of events) {
    if (e.type === 'hold') hold = { reason: e.data.reason, quote: e.data.quote, at: e.at };
    else if (e.type === 'release') hold = null;
  }
  return hold;
}

const numberOf = (id) => Number(/\.(\d+)$/.exec(id)?.[1] ?? 0);

// The item's attempts, oldest first, each with its schema 2 events.
export async function itemHistory(root, item) {
  const out = [];
  for (const id of await listAttempts(root, { item })) out.push({ id, n: numberOf(id), events: schema2(await readEvents(root, id)) });
  return out.sort((a, b) => a.n - b.n);
}

// Every decision asked in the item's attempts, with its answer (read through stream 4 for one not yet answered).
export async function decisionsOf(root, history, { kinds = null } = {}) {
  const out = [];
  for (const a of history) {
    const answers = new Map(a.events.filter((e) => e.type === 'decision.answered').map((e) => [e.data.id, e.data]));
    for (const e of a.events) {
      if (e.type !== 'decision.asked' || (kinds && !kinds.includes(e.data.kind))) continue;
      let answer = answers.get(e.data.id) ?? null;
      if (!answer) answer = (await answered(root, e.data.id, { attempt: a.id })) ?? null;
      out.push({ ...e.data, attempt: a.id, askedAt: e.at, answer });
    }
  }
  return out;
}

export function projectRoot(ctx) {
  if (!ctx.root) throw new WfError(`no project here: no .workflow/project.yaml above ${ctx.cwd}, and no user-folder adapter whose root contains it`, { hint: '`wf init` onboards the project' });
  return ctx.root;
}

// The attempt a command means: --attempt (an attempt id, or an item with one open attempt), else the attempt whose
// worktree holds the current folder, else the only open attempt.
export async function resolveAttempt(ctx, args) {
  const root = projectRoot(ctx);
  const all = (await listAttempts(root)).filter((id) => id !== PROJECT_LEDGER);
  const flag = args.flags?.attempt;
  const openOf = async (ids) => {
    const out = [];
    for (const id of ids) {
      const s = await attemptState(root, id);
      if (s.open && s.schema === 2) out.push(id);
    }
    return out;
  };
  if (typeof flag === 'string') {
    if (all.includes(flag)) return flag;
    const mine = await openOf(all.filter((id) => id.startsWith(`${flag}.`)));
    if (mine.length === 1) return mine[0];
    throw new WfError(`no attempt \`${flag}\`${mine.length ? ` (open: ${mine.join(', ')})` : ''}`, { hint: all.length ? `attempts here: ${all.join(', ')}` : '`wf start <item>` starts one' });
  }
  const wtRoot = path.join(root, '.wf-worktrees') + path.sep;
  let cwd = ctx.cwd;
  try {
    cwd = fs.realpathSync(ctx.cwd);
  } catch {}
  const realWt = fs.existsSync(wtRoot) ? fs.realpathSync(wtRoot) + path.sep : wtRoot;
  if ((cwd + path.sep).startsWith(realWt)) {
    const id = (cwd + path.sep).slice(realWt.length).split(path.sep)[0];
    if (all.includes(id)) return id;
  }
  const open = await openOf(all);
  if (open.length === 1) return open[0];
  if (!open.length) throw new WfError('no open attempt', { hint: '`wf start <item>` starts one' });
  throw new WfError(`several open attempts (${open.join(', ')}); pass --attempt <id>`);
}

// The session a flag names: `<runtime>:<id>`, or a bare id in the caller's runtime.
export function sessionFlag(value, actor, what = '--session') {
  if (typeof value !== 'string' || !value.trim()) throw new WfError(`${what} <runtime>:<session id> is required`);
  const i = value.indexOf(':');
  return i > 0 ? { runtime: value.slice(0, i), id: value.slice(i + 1) } : { runtime: actor?.runtime ?? 'unknown', id: value };
}

export const flagText = (args, name, { required = false } = {}) => {
  const v = args.flags?.[name];
  if (Array.isArray(v)) throw new WfError(`--${name} is given more than once`);
  if (v === undefined || v === true) {
    if (required) throw new WfError(`--${name} "<text>" is required`);
    return null;
  }
  return String(v);
};

// --- start -------------------------------------------------------------------------------------------------------------

// Attempt numbers already used by the item: ledgers and `wf/<item>.<n>` branches (local and remote) in every repo.
function usedNumbers(root, adapter, item, ids) {
  const used = ids.map(numberOf);
  const re = new RegExp(`(?:^|/)wf/${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  for (const spec of adapter.repos) {
    const dir = path.join(root, spec.path);
    if (!fs.existsSync(dir)) continue;
    for (const ref of git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/wf/', 'refs/remotes/'], { allowFail: true }).split('\n').filter(Boolean)) {
      const m = re.exec(ref);
      if (m) used.push(Number(m[1]));
    }
  }
  return used;
}

function cloneTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tries = process.platform === 'darwin' ? [['-c', '-R'], ['-R']] : [['--reflink=auto', '-R'], ['-R']];
  for (const flags of tries) if (run('cp', [...flags, src, dest], { allowFail: true }).status === 0) return;
  throw new WfError(`could not copy ${src} to ${dest}`);
}

function missingNodeDependencies(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).filter((n) => !fs.existsSync(path.join(pkgDir, 'node_modules', n, 'package.json')));
}

// Provision a new worktree from the repo's checkout: clone the listed folders, copy ignored files, and install when the
// fingerprint files differ, a cloned folder is missing, or a declared node dependency is absent.
export async function provision(root, adapter, spec, wt) {
  const p = { clone: [], fingerprint: [], install: null, copyIgnored: [], ...(spec.provision ?? {}) };
  const source = path.join(root, spec.path);
  const report = { cloned: [], copied: [], installed: false };
  for (const rel of p.clone) {
    const src = path.join(source, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(wt, rel))) {
      cloneTree(src, path.join(wt, rel));
      report.cloned.push(rel);
    }
  }
  for (const rel of p.copyIgnored) {
    const src = path.join(source, rel);
    if (fs.existsSync(src) && !fs.existsSync(path.join(wt, rel))) {
      fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(wt, rel));
      fs.chmodSync(path.join(wt, rel), fs.statSync(src).mode);
      report.copied.push(rel);
    }
  }
  const drift = p.fingerprint.some((rel) => {
    const a = path.join(source, rel);
    const b = path.join(wt, rel);
    return fs.existsSync(b) && (!fs.existsSync(a) || hashFile(a) !== hashFile(b));
  });
  const missingClone = p.clone.some((rel) => !fs.existsSync(path.join(wt, rel)));
  const stale = p.clone.filter((rel) => path.basename(rel) === 'node_modules').some((rel) => missingNodeDependencies(path.join(wt, path.dirname(rel))).length > 0);
  if (p.install && (drift || missingClone || stale)) {
    const { projectEnv } = await import('./env.mjs');
    let secrets = {};
    // A catalogued secret that lists `provision:<repo>` reaches this repo's install, and nothing else (0.7 I-111).
    const { secretsCatalogFile } = await import('./config.mjs');
    const catalogFile = secretsCatalogFile(adapter, root);
    if (fs.existsSync(catalogFile)) {
      const s = await import('./secrets.mjs');
      const cfg = { name: adapter.name, catalogFile, repos: adapter.repos, secrets: adapter.secrets ?? { store: 'env-file', file: null } };
      const use = s.provisionUse(spec.name);
      const missing = s.missingFor(root, cfg, use);
      if (missing.length) throw new WfError(`secrets missing for provisioning ${spec.name}: ${missing.join(', ')}`, { hint: 'the person runs `wf secrets guide` in their terminal, then `wf start` again' });
      secrets = s.stepEnv(root, cfg, use);
    }
    const r = run('sh', ['-c', p.install], { cwd: wt, env: projectEnv(null, { ...secrets, WF_ROOT: root, WF_REPO: spec.name }), allowFail: true, sensitive: Object.keys(secrets).length > 0 });
    if (r.status !== 0) throw new WfError(`provisioning ${spec.name} failed: \`${p.install}\` exited ${r.status} in ${wt}${Object.keys(secrets).length ? '' : `:\n${(r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n')}`}`);
    report.installed = true;
  }
  return report;
}

// `bases`: { <repo>: <branch> } or { '*': <branch> } from `--base`. `noTracker`: the item is not a tracker id; the attempt
// records `ticketing: none`, sets no tracker status and snapshots no stage that needs the tracker.
async function startAttempt(root, rawItem, { actor = null, repos = null, bases = null, noTracker = false } = {}) {
  const adapter = await loadAdapter(root);
  // `item` names attempts, folders and branches (it may be an older spelling found in a ledger); `canonical` is the tracker's.
  const item = noTracker ? String(rawItem ?? '').trim() : (await normaliseId(root, String(rawItem ?? ''))).item;
  assertSafeId(item, 'item');
  const ids = await listAttempts(root, { item });
  for (const id of ids) {
    const s = await attemptState(root, id);
    if (s.open) {
      const held = s.schema === 2 ? holdOf(schema2(await readEvents(root, id))) : s.hold ?? null;
      const hint = held ? 'only the person lifts the hold (`wf release` on their answer)' : s.schema === 1 ? `it is a 0.7 attempt: \`wf migrate attempts\` closes it as superseded or shipped` : `continue it (\`wf resume --attempt ${id}\`), or close it first (\`wf abandon --attempt ${id} --reason "<why>"\`)`;
      throw refusal('start:open', `${item} already has an ${held ? `attempt held by the person ("${held.reason}")` : 'open attempt'}: ${id}`, hint);
    }
  }
  const wanted = repos?.length ? repos : adapter.repos.map((r) => r.name);
  for (const name of [...wanted, ...Object.keys(bases ?? {}).filter((k) => k !== '*')]) if (!adapter.repos.some((r) => r.name === name)) throw new WfError(`unknown repo \`${name}\` (repos: ${adapter.repos.map((r) => r.name).join(', ')})`);
  for (const b of Object.values(bases ?? {})) if (run('git', ['check-ref-format', '--branch', b], { cwd: root, allowFail: true }).status !== 0) throw new WfError(`--base: \`${b}\` is not a branch name`);
  // The attempt's own base per repo: every base read of the attempt takes it from `attempt.started`.
  const specFor = (name) => {
    const spec = adapter.repos.find((r) => r.name === name);
    return { ...spec, base: bases?.[name] ?? bases?.['*'] ?? spec.base };
  };
  const n = Math.max(0, ...usedNumbers(root, adapter, item, ids)) + 1;
  const id = attemptId(item, n);
  const branch = branchName(id);

  // Fetch every repo first: nothing is created unless every base could be fetched.
  const tips = {};
  for (const name of wanted) {
    const spec = specFor(name);
    const dir = path.join(root, spec.path);
    if (!fs.existsSync(dir)) throw new WfError(`repo ${name} is not checked out at ${dir}`);
    assertPlainGit(dir);
    try {
      tips[name] = fetchBase(dir, spec);
    } catch (error) {
      throw new WfError(`${error.message}; the attempt starts only from a freshly fetched base`, { hint: 'check the network and the remote, then `wf start` again' });
    }
    if (git(dir, ['branch', '--list', branch])) throw new WfError(`branch ${branch} already exists in ${name}`, { hint: `inspect it, then delete it (git -C ${dir} branch -D ${branch})` });
  }

  const made = [];
  const recorded = {};
  const provisioned = {};
  try {
    for (const name of wanted) {
      const spec = specFor(name);
      const dir = path.join(root, spec.path);
      const wt = worktreeDir(root, id, name);
      mkdirStateDirectory(path.dirname(wt), { recursive: true });
      run('git', ['worktree', 'add', '--quiet', '--no-track', '-b', branch, wt, tips[name]], { cwd: dir });
      made.push({ dir, wt });
      provisioned[name] = await provision(root, adapter, spec, wt);
      recorded[name] = { branch, base: spec.base, baseSha: tips[name], worktree: wt };
    }
    const from = ids.length ? ids[ids.length - 1] : null;
    const stages = (adapter.delivery?.stages ?? []).filter((st) => !noTracker || (!['status', 'comment'].includes(st.do) && !st.when?.labels));
    await append(root, id, 'attempt.started', {
      item, n, repos: recorded, stages,
      adapter: { file: adapter.source?.file ?? null, hash: adapter.source?.hash ?? null }, engine: ENGINE_VERSION,
      ...(from ? { from } : {}), ...(noTracker ? { ticketing: 'none' } : {}),
    }, actor);
  } catch (error) {
    for (const m of made.reverse()) {
      run('git', ['worktree', 'remove', '--force', m.wt], { cwd: m.dir, allowFail: true });
      run('git', ['branch', '-D', branch], { cwd: m.dir, allowFail: true });
    }
    fs.rmSync(path.join(root, '.wf-worktrees', id), { recursive: true, force: true });
    throw error;
  }

  // The tracker's "taken" status, as stage -1 (stream 3). A failure here leaves the attempt started and says so.
  let take = null;
  if (adapter.ticketing?.take?.status && !noTracker) {
    try {
      take = await runStage(root, id, { do: 'status', to: adapter.ticketing.take.status, status: adapter.ticketing.take.status });
    } catch (error) {
      take = { state: 'failed', evidence: null, next: null, error: error.message };
    }
  }
  return { state: await attemptState(root, id), take, provisioned, tips };
}

async function start(root, rawItem, opts = {}) {
  return (await startAttempt(root, rawItem, opts)).state;
}

// `--base <branch>` (every repo) or `--base <repo>=<branch>,...`.
export function basesFlag(value) {
  if (!value) return null;
  const out = {};
  for (const part of value.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    else out['*'] = part;
  }
  return out;
}

async function cmdStart(ctx, args) {
  const root = projectRoot(ctx);
  // `--no-tracker <id>` takes the id as its value.
  const nt = args.flags['no-tracker'];
  const noTracker = nt !== undefined;
  const raw = args._[0] ?? (typeof nt === 'string' ? nt : null);
  if (!raw) throw new WfError('wf start <item> [--repos a,b] [--base <branch>|<repo>=<branch>,..] [--no-tracker]: the id of the work is required');
  const repos = flagText(args, 'repos')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const bases = basesFlag(flagText(args, 'base'));
  const { state, take, provisioned, tips } = await startAttempt(root, raw, { actor: ctx.actor, repos, bases, noTracker });
  const lines = [`started ${state.id} from fresh bases:`];
  for (const [name, r] of Object.entries(state.repos)) {
    const p = provisioned[name];
    const extra = [p.cloned.length ? `cloned ${p.cloned.join(', ')}` : null, p.copied.length ? `copied ${p.copied.join(', ')}` : null, p.installed ? 'installed' : null].filter(Boolean);
    lines.push(`  ${name}: ${r.worktree} (branch ${r.branch} at ${r.base} ${String(tips[name]).slice(0, 10)})${extra.length ? `; ${extra.join('; ')}` : ''}`);
  }
  if (take) lines.push(take.state === 'failed' ? `tracker status not set: ${take.error}` : take.state === 'pending' ? `tracker status: do this now: ${take.next}` : `tracker status: ${take.state}`);
  if (noTracker) lines.push('no tracker: no status is set and nothing is filed for this attempt');
  lines.push(`next: wf criteria --file <criteria file> --attempt ${state.id}`);
  return { text: lines.join('\n'), data: { attempt: state.id, item: state.item, repos: state.repos, take } };
}

// --- hold, release -----------------------------------------------------------------------------------------------------

async function cmdHold(ctx, args) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  const reason = flagText(args, 'reason', { required: true });
  const quote = flagText(args, 'quote') ?? reason;
  const s = await attemptState(root, id);
  if (!s.open) throw new WfError(`${id} is closed (${s.outcome}); there is nothing to hold`);
  await append(root, id, 'hold', { reason, quote }, ctx.actor);
  return { text: `hold recorded on ${id}: "${reason}". Review launches, handoffs, delivery and closing are refused until the person lifts it.`, data: { attempt: id, reason, quote } };
}

export const RELEASE = { lift: 'lift the hold', keep: 'keep the hold' };

async function cmdRelease(ctx, args) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  // Every hold and release of the ledger, a 0.7 attempt's included: a held 0.7 attempt is lifted the same way.
  const hold = holdOf(await readEvents(root, id));
  if (!hold) throw new WfError(`${id} is not held`);
  const q = await ask(root, id, { kind: 'release', question: `Lift the hold on ${id} ("${hold.reason}")?`, options: [RELEASE.lift, RELEASE.keep], refs: [`hold:${hold.at}`], blocking: true });
  const answer = await answered(root, q.id, { attempt: id });
  if (!answer) return { text: `asked the person (${q.id}): Lift the hold on ${id} ("${hold.reason}")? Options: ${RELEASE.lift} | ${RELEASE.keep}.\nnext: wf approve ${q.id} --attempt ${id} --choice "<their choice>" --quote "<their words>", then wf release --attempt ${id}`, data: { attempt: id, decision: q.id, released: false }, exitCode: 0 };
  if (answer.choice !== RELEASE.lift) return { text: `the person chose to keep the hold on ${id} ("${answer.quote}")`, data: { attempt: id, decision: q.id, released: false } };
  await append(root, id, 'release', { decision: q.id }, ctx.actor);
  return { text: `hold lifted on ${id} by the person's answer ${q.id} ("${answer.quote}")`, data: { attempt: id, decision: q.id, released: true } };
}

// --- close, abandon ----------------------------------------------------------------------------------------------------

// The patch-ids of an attempt's own commits in one repo, and whether each is on the base (`git cherry`). Read from the
// attempt's worktree, or, when the worktree is gone, from its branch `wf/<attempt>` in the repo's checkout. Fails closed:
// with neither, nothing proves what the attempt wrote, so it is refused (named failure: a removed worktree let an
// unshipped attempt close as shipped, because the repo was skipped).
export function patchFacts(root, state, adapter, name) {
  const r = state.repos[name];
  const spec = specOf(adapter, name, r);
  let cwd = r.worktree;
  let head = 'HEAD';
  if (!fs.existsSync(cwd)) {
    const checkout = path.join(root, spec.path);
    const branch = r.branch || branchName(state.id);
    const tip = fs.existsSync(checkout) ? git(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { allowFail: true }) : '';
    if (!tip) throw new WfError(`${state.id} cannot be proven shipped in ${name}: its worktree ${r.worktree} is gone and its branch ${branch} is not in ${checkout}, so what the attempt wrote cannot be compared with the base`, { hint: `restore the branch ${branch} (or the worktree), or close the work as not shipped: \`wf abandon --attempt ${state.id} --reason "<why>"\`` });
    cwd = checkout;
    head = tip;
  }
  const base = baseRef(cwd, spec, null);
  // The attempt's own commits: the first-parent line since the commit it started from (base merges excluded).
  const fork = r.baseSha;
  const commits = git(cwd, ['rev-list', '--first-parent', '--no-merges', `${fork}..${head}`]).split('\n').filter(Boolean);
  if (!commits.length) return { commits: 0, unshipped: [], patchIds: [] };
  const cherry = base ? git(cwd, ['cherry', base, head, fork], { allowFail: true }).split('\n').filter(Boolean) : [];
  let unshipped = cherry.filter((l) => l.startsWith('+ ')).map((l) => l.slice(2));
  // A squashed landing: one commit on the base carries the attempt's whole change.
  if (base && unshipped.length && squashedOnBase(cwd, base, head)) unshipped = [];
  const patch = run('git', ['log', '-p', '--first-parent', '--no-merges', '--format=commit %H', `${fork}..${head}`], { cwd }).stdout;
  const ids = run('git', ['patch-id', '--stable'], { cwd, input: patch, allowFail: true }).stdout.split('\n').filter(Boolean).map((l) => {
    const [pid, commit] = l.split(' ');
    return { repo: name, commit, patchId: pid };
  });
  return { commits: commits.length, unshipped: base ? unshipped : commits, patchIds: ids };
}

const patchIdOf = (cwd, patch) => run('git', ['patch-id', '--stable'], { cwd, input: patch, allowFail: true }).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));

// Whether a commit on the base since the attempt's merge-base has the patch-id of the attempt's whole diff.
function squashedOnBase(cwd, base, head) {
  const mb = git(cwd, ['merge-base', base, head], { allowFail: true });
  if (!mb) return false;
  const whole = patchIdOf(cwd, run('git', ['diff', '--no-color', mb, head], { cwd, allowFail: true }).stdout)[0]?.[0];
  if (!whole) return false;
  const onBase = run('git', ['log', '-p', '--no-merges', '--format=commit %H', `${mb}..${base}`], { cwd, allowFail: true }).stdout;
  return patchIdOf(cwd, onBase).some(([pid]) => pid === whole);
}

function stagesDone(state, events) {
  const stages = state.stages ?? [];
  if (!stages.length) return false;
  const last = new Map();
  for (const e of events) if (e.type === 'stage' && e.data.index >= 0) last.set(e.data.index, e.data.state);
  return stages.every((_, i) => ['done', 'skipped'].includes(last.get(i)));
}

// The telemetry row, built by stream 5 while the worktrees still exist (it reads their diff), with the outcome closing it;
// it is kept in `attempt.closed` so the row survives the worktrees.
async function buildRow(root, id, outcome, extra = {}) {
  try {
    return { row: { ...(await row(root, id)), outcome, ...extra }, error: null };
  } catch (error) {
    return { row: null, error: error.message };
  }
}

// Stream 5 writes the telemetry file (its only writer).
async function storeRow(root, id) {
  try {
    const { file } = await writeRow(root, id);
    return `telemetry row written to ${file}`;
  } catch (error) {
    return `telemetry row not written: ${error.message}`;
  }
}

function removeWorktrees(root, adapter, state) {
  const left = [];
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!fs.existsSync(r.worktree)) continue;
    const dir = path.join(root, specOf(adapter, name, r).path);
    const res = run('git', ['worktree', 'remove', '--force', r.worktree], { cwd: dir, allowFail: true });
    if (res.status !== 0) left.push(`${r.worktree}: ${res.stderr.trim()}`);
  }
  const folder = path.join(root, '.wf-worktrees', state.id);
  try {
    if (fs.existsSync(folder) && !fs.readdirSync(folder).length) fs.rmdirSync(folder);
  } catch {}
  return left;
}

async function closeWith(ctx, args, outcome) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  const adapter = await loadAdapter(root);
  const state = await attemptState(root, id);
  if (!state.open) throw new WfError(`${id} is already closed (${state.outcome})`);
  const all = await readEvents(root, id);
  const events = schema2(all);
  const hold = holdOf(all); // a 0.7 attempt's hold counts too: migration leaves held attempts to the person
  if (hold) throw refusal('hold', `${id} is held by the person ("${hold.reason}")`, 'only the person lifts the hold (`wf release` on their answer)');
  const dirty = dirtyRepos(state);
  if (Object.keys(dirty).length && !(outcome === 'abandoned' && args.flags.discard === true)) {
    throw new WfError(`uncommitted changes would be lost: ${Object.entries(dirty).map(([r, f]) => `${r} (${f.slice(0, 5).join(', ')})`).join('; ')}`, { hint: outcome === 'abandoned' ? 'commit them to the branch (kept), or pass --discard' : 'commit them, deliver them, then close' });
  }
  let reason;
  let patchIds;
  let outsideStages = false;
  if (outcome === 'shipped') {
    const facts = Object.keys(state.repos).map((n) => ({ repo: n, ...patchFacts(root, state, adapter, n) }));
    if (!facts.some((f) => f.commits)) throw new WfError(`${id} has no commits, so nothing of it shipped`, { hint: `\`wf abandon --attempt ${id} --reason "<why>"\` closes work that will not ship` });
    patchIds = facts.flatMap((f) => f.patchIds);
    const byStages = stagesDone(state, events);
    // Shipped by patch-id with its stages not done: the change reached the base outside the delivery stages (D16).
    outsideStages = !byStages;
    const unshipped = facts.filter((f) => f.unshipped.length);
    if (!byStages && unshipped.length) {
      throw new WfError(`${id} is not shipped: its delivery stages are not done, and ${unshipped.map((f) => `${f.unshipped.length} commit(s) of ${f.repo}`).join(', ')} are not on the base by patch-id`, { hint: '`wf deliver` runs the next stage; `wf abandon --reason "<why>"` closes work that will not ship' });
    }
    reason = flagText(args, 'reason') ?? (byStages ? 'delivery stages done' : 'every commit is on the base (patch-id)');
  } else {
    reason = flagText(args, 'reason', { required: true });
  }
  const extra = outsideStages ? { outsideStages: true } : {};
  const built = await buildRow(root, id, outcome, extra);
  await append(root, id, 'attempt.closed', { outcome, reason, ...extra, ...(patchIds?.length ? { patchIds } : {}), ...(built.row ? { row: built.row } : {}) }, ctx.actor);
  const telemetry = await storeRow(root, id);
  const left = removeWorktrees(root, adapter, state);
  const branches = Object.values(state.repos).map((r) => r.branch);
  return {
    text: `${id} closed (${outcome}${outsideStages ? ', outside its delivery stages' : ''}): ${reason}. Worktrees removed${left.length ? `, except: ${left.join('; ')}` : ''}; branches kept (${[...new Set(branches)].join(', ')}). ${telemetry}.`,
    data: { attempt: id, outcome, reason, outsideStages, patchIds: patchIds ?? [], left },
  };
}

const cmdClose = (ctx, args) => closeWith(ctx, args, 'shipped');
const cmdAbandon = (ctx, args) => closeWith(ctx, args, 'abandoned');

export const implements08 = { start, cmdStart, cmdHold, cmdRelease, cmdClose, cmdAbandon };
