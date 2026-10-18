// 0.7.30 (I-151, D60): a live attempt follows the adapter as committed on the adapter repo's base branch.
//
// Named failure (field): an attempt admitted before its project scoped a step's evidence glob kept counting 4,008 other
// tickets' screenshots, and another project's attempt kept a leaving policy its project had changed. Every attempt read
// its adapter at the commit it was admitted on, for its whole life; a fix the project committed on its base branch (a
// gate step, a rule, a validation, a delivery setting) never reached the attempts already running, and the only route was
// `wf deliver --repin-adapter`, a fault recovery that needs the person's yes. The person's rule: live attempts follow
// updates delivered on main automatically.
//
// What follows: everything the attempt reads from its adapter (gate steps and their plugins, rules, skills, classes and
// models, the leaving policy, strategy, delivery and tracker settings and code), from the adapter repo's base branch as
// last fetched (the remote base, or the local branch where there is no remote), never from a worktree or the working
// copy. What stays: the frozen criteria, plan and work (the ledger's), the attempt's own registered and corrected checks
// (each at the commit it was pinned at), the classes its work items were handed at, handoffs already made, repos already
// recorded for the delivery and, once a delivery has started, its delivery adapter kind (a change of kind is not taken
// half way; `wf deliver --repin-adapter` remains for that, with the person's yes).
//
// When it is taken: before any command reads the attempt (`openState`, `wf status`), only forward along the base branch,
// never while a gate or check runs on the attempt or while it is on hold, and only when something the attempt reads
// changed. It is recorded in the ledger (`adapter.followed`) with both pins, the files and the commits that changed them:
// that record is the reason a project's new obligation (a step it added, a stricter rule) reaches an attempt admitted
// before it (D7). A tip that cannot be taken (its adapter does not parse, needs a newer engine, drops a repo of the
// attempt, lacks its delivery adapter, rewrote the branch, or holds this attempt's own change to its rules) is recorded
// once with why (`adapter.notFollowed`) and the attempt keeps its pin.
//
// A passed gate is bound to the pin it ran at (`gate.adapterBase`). It stops counting only when a follow since then
// changed what it ran or what this tree may need: a step it ran whose definition or plugin code changed (not its evidence
// globs, workers or scheduling: D21), a step added, a step it did not run whose planning changed (where, when or on what
// it runs), or gate settings that change results (`gate.env`, the quick lane's steps, components, the repos' packages).
// The next `wf gate` then runs those steps and reuses every other. An accepted attempt whose passing gate stops counting
// has its acceptance withdrawn with the follow (`withdrewAcceptance`), so the evidence the new run collects is accepted
// again; when it is the same evidence, `wf accept` takes the review already recorded.
import fs from 'node:fs';
import path from 'node:path';
import { adapterPin, attemptAdapter, repoDir, trustedAdapter } from './config.mjs';
import { append, loadState, recordedTogether } from './ledger.mjs';
import { assertEngine, canonical, git, hashValue, run } from './util.mjs';
import { liveGate, RESULT_NEUTRAL } from './gate.mjs';
import { validationIds } from './validation.mjs';

// Fields that decide where, when and on what a step runs: a change to one of them on a step the last gate did not run may
// make it apply to this tree.
const APPLY_FIELDS = ['repo', 'package', 'component', 'when', 'inputs', 'ignores', 'tier', 'deferrable', 'alsoInputs', 'specs'];
const without = (step, keys) => Object.fromEntries(Object.entries(step ?? {}).filter(([k]) => !keys.includes(k)));
const only = (step, keys) => Object.fromEntries(Object.entries(step ?? {}).filter(([k]) => keys.includes(k)));
const short = (c) => String(c ?? '').slice(0, 10);

// The branch an attempt's repo is based on and delivered to: its own target (I-201, `wf entry --target`), else the repo's base.
export const targetOf = (state, repo) => state?.repos?.[repo.name]?.target ?? repo.base;

function pluginBlob(dir, commit, folder, plugin) {
  if (!plugin) return null;
  return git(dir, ['rev-parse', '--verify', '--quiet', `${commit}:${path.posix.normalize(path.posix.join(folder, String(plugin)))}`], { allowFail: true }) || 'missing';
}

// What a move of the adapter changes in the gate, per step id. The attempt's own registered and corrected checks run at
// their own pins and are left out.
function gateChanges(state, dir, folder, before, from, after, to) {
  const own = new Set(validationIds(state));
  const was = new Map(before.gate.steps.map((s) => [s.id, s]));
  const now = new Map(after.gate.steps.map((s) => [s.id, s]));
  const out = { rerun: [], applies: [], added: [], removed: [], settings: [] };
  for (const [id, s] of now) {
    if (own.has(id)) continue;
    const p = was.get(id);
    if (!p) {
      out.added.push(id);
      continue;
    }
    if (pluginBlob(dir, from, folder, p.plugin) !== pluginBlob(dir, to, folder, s.plugin) || canonical(without(p, RESULT_NEUTRAL)) !== canonical(without(s, RESULT_NEUTRAL))) out.rerun.push(id);
    if (canonical(only(p, APPLY_FIELDS)) !== canonical(only(s, APPLY_FIELDS))) out.applies.push(id);
  }
  for (const id of was.keys()) if (!now.has(id) && !own.has(id)) out.removed.push(id);
  if (canonical(before.gate.env ?? null) !== canonical(after.gate.env ?? null)) out.settings.push('gate.env');
  if (state.lane === 'quick' && (before.gate.quickLane ?? 'light') !== (after.gate.quickLane ?? 'light')) out.settings.push('gate.quickLane');
  if (canonical(before.components ?? []) !== canonical(after.components ?? [])) out.settings.push('components');
  for (const name of Object.keys(state.repos)) {
    const a = before.repos.find((r) => r.name === name);
    const b = after.repos.find((r) => r.name === name);
    if (canonical(only(a, ['packages', 'sharedInfra'])) !== canonical(only(b, ['packages', 'sharedInfra']))) out.settings.push(`repos.${name}`);
  }
  return out;
}

const ranBy = (g) => new Set((g?.steps ?? []).filter((s) => ['passed', 'reused', 'failed'].includes(s.status)).map((s) => s.id));

// What in `changes` bears on the gate `g`: steps it ran that changed, steps added, steps it did not run whose planning
// changed, settings that change results. Empty when the move leaves its proof standing.
function touching(changes, g) {
  const ran = ranBy(g);
  return {
    rerun: changes.rerun.filter((id) => ran.has(id)),
    added: changes.added,
    applies: changes.applies.filter((id) => !ran.has(id)),
    settings: changes.settings,
  };
}
const anyOf = (t) => t.rerun.length + t.added.length + t.applies.length + t.settings.length > 0;
const describe = (t) => [t.rerun.length && `steps it ran changed (${t.rerun.join(', ')})`, t.added.length && `steps were added (${t.added.join(', ')})`, t.applies.length && `steps it did not run may now apply (${t.applies.join(', ')})`, t.settings.length && `gate settings changed (${t.settings.join(', ')})`].filter(Boolean).join('; ');

// Why the passing gate `g` no longer counts after the adapter moved, or null. Read from the ledger only: each follow
// recorded what it changed, and the gate the pin it ran at.
export function adapterMovedSince(state, g) {
  const pin = adapterPin(state);
  const at = g?.adapterBase ?? state.adapterBase;
  if (!g || !pin || at === pin) return null;
  const follows = state.adapterFollows ?? [];
  const from = follows.findIndex((f) => f.from === at);
  if (from < 0) return null;
  const sum = { rerun: [], added: [], applies: [], settings: [] };
  for (const f of follows.slice(from)) {
    if (!f.gate) continue;
    const t = touching(f.gate, g);
    for (const k of Object.keys(sum)) sum[k] = [...new Set([...sum[k], ...t[k]])];
  }
  if (!anyOf(sum)) return null;
  const last = follows.at(-1);
  return `the adapter on ${last.ref} moved from ${short(at)} to ${short(pin)} after this gate passed, and ${describe(sum)}; \`wf gate\` runs what changed and reuses the rest`;
}

// The files the attempt reads from the adapter repo at its pin: the adapter folder, and review rule documents kept in that repo.
function followedPaths(loc, cfgs) {
  const paths = new Set([loc.relative || '.']);
  for (const cfg of cfgs) for (const r of cfg?.review?.rules ?? []) if (!r.repo || r.repo === loc.repo.name) for (const d of r.read ?? []) paths.add(path.posix.normalize(d));
  return [...paths];
}

const realDir = (root, repo) => {
  try {
    return fs.realpathSync(repoDir(root, repo));
  } catch {
    return null;
  }
};

// The adapter at a commit and the ref its repo's base branch is read from, once per command: `wf status` asks for every open
// attempt, and attempts admitted together share a pin.
const pinned = new Map();
function atPin(root, state, loc, from) {
  const key = `${loc.dir}\0${from}\0${canonical(state.repos?.[loc.repo.name]?.target ?? null)}`;
  if (!pinned.has(key)) {
    const cfg = trustedAdapter(root, state, from);
    const repo = cfg.repos.find((r) => r.name === loc.repo.name) ?? null;
    const remote = repo ? git(loc.dir, ['remote']).split('\n').includes(repo.remote) : false;
    pinned.set(key, { cfg, repo, ref: repo ? (remote ? `${repo.remote}/${targetOf(state, repo)}` : targetOf(state, repo)) : null });
  }
  return pinned.get(key);
}

// The change a commit makes to a file: the lines it removes and adds, without context or line numbers, so the same change made
// on another base, cherry-picked, rebased or pushed by hand reads the same.
function changeOf(cwd, commit, file) {
  const diff = git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', `${commit}^`, commit, '--', file], { allowFail: true }) || '';
  const lines = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l));
  return lines.length ? hashValue(lines) : null;
}
// The commits `args` select that touch some of `paths`, each with the files of `paths` it touches. Merges are left out.
function commitsIn(cwd, args, paths) {
  const out = git(cwd, ['log', '--no-merges', '--format=@%H', '--name-only', ...args, '--', ...paths], { allowFail: true }) || '';
  const list = [];
  for (const l of out.split('\n')) {
    if (l.startsWith('@')) list.push({ commit: l.slice(1), files: [] });
    else if (l.trim() && list.length) list.at(-1).files.push(l.trim());
  }
  return list;
}

// What the attempt authored in the files it follows, not recorded yet: each file's change in each of its commits that the base
// branch does not hold (`HEAD --not <tip>`). Second review of 0.7.30. Named failure: its change was read from its branch's
// first-parent line, so base commits a hand fast-forward or a `git pull --rebase` brought in counted as its own, and main's
// adapter change was held for good as "this attempt's own change". A base commit is on the base branch, so it is never here;
// the record (`adapter.authored`) keeps a change once the base branch holds it too (a hand push, a merge of the branch).
function authoredNow(state, loc, tip, paths) {
  const own = state.repos[loc.repo.name];
  if (!own?.worktree || !fs.existsSync(own.worktree) || !tip) return [];
  const known = new Set((state.adapterAuthored ?? []).map((a) => `${a.file}\0${a.change}`));
  const out = [];
  for (const c of commitsIn(own.worktree, ['HEAD', '--not', tip], paths)) {
    for (const file of c.files) {
      const change = changeOf(own.worktree, c.commit, file);
      if (!change || known.has(`${file}\0${change}`)) continue;
      known.add(`${file}\0${change}`);
      out.push({ file, change, commit: c.commit });
    }
  }
  return out;
}

// What following the base branch would do now: null (nothing to take), { held } (a tip that cannot be taken, and why) or
// { data } (the follow to record), with `authored`: the attempt's own changes to the files it follows not recorded yet. Reads
// git and the committed adapter only; writes nothing.
export function followPlan(root, state) {
  if (!state?.adapterBase || ['done', 'abandoned'].includes(state.phase)) return null;
  const loc = attemptAdapter(root, state);
  const from = adapterPin(state);
  const pinned = atPin(root, state, loc, from);
  if (!pinned.repo) return null;
  const tip = git(loc.dir, ['rev-parse', '--verify', '--quiet', `${pinned.ref}^{commit}`], { allowFail: true });
  const authored = authoredNow(state, loc, tip, followedPaths(loc, [pinned.cfg]));
  const plan = decide(root, state, { loc, from, pinned, tip, authored: [...(state.adapterAuthored ?? []), ...authored] });
  return authored.length ? { ...(plan ?? {}), authored } : plan;
}

function decide(root, state, { loc, from, pinned, tip, authored }) {
  const { cfg: before, ref } = pinned;
  const dir = loc.dir;
  // An attempt whose own change to its rules reached the base branch keeps its pin for good (review of 0.7.30).
  if (!tip || tip === from || state.adapterHeld?.tip === tip || state.adapterOwnHeld) return null;
  const held = (why, extra = {}) => ({ held: { tip, ref, why, ...extra } });
  if (run('git', ['merge-base', '--is-ancestor', from, tip], { cwd: dir, allowFail: true }).status !== 0) return held(`${ref} (${short(tip)}) does not contain the pin ${short(from)}: the adapter is followed only forward along the base branch`);
  const first = followedPaths(loc, [before]);
  const quick = git(dir, ['diff', '--name-only', from, tip, '--', ...first]).split('\n').filter(Boolean);
  let after;
  try {
    after = trustedAdapter(root, state, tip);
    assertEngine(after);
  } catch (error) {
    // Nothing the attempt reads changed: an unreadable tip elsewhere is not this attempt's concern.
    if (!quick.length) return null;
    return held(`the adapter at ${ref} (${short(tip)}) cannot be used: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  const paths = followedPaths(loc, [before, after]);
  const changed = paths.length === first.length ? quick : git(dir, ['diff', '--name-only', from, tip, '--', ...paths]).split('\n').filter(Boolean);
  if (!changed.length) return null;
  for (const name of Object.keys(state.repos)) {
    const a = before.repos.find((r) => r.name === name);
    const b = after.repos.find((r) => r.name === name);
    if (!b || realDir(root, b) !== realDir(root, a)) return held(`the adapter at ${ref} (${short(tip)}) ${b ? `lists repo \`${name}\` at another folder (${b.path})` : `no longer lists repo \`${name}\``}, which this attempt works in`);
  }
  // An attempt is never judged by its own change to its rules: once the base branch holds a change this attempt authored to a
  // file it follows (the same change in a commit since the pin: its delivery, a hand push, a cherry-pick, a merge outside the
  // workflow), or that file exactly as the attempt has it, the attempt keeps the pin it has, for good (`own` on the record).
  // Review of 0.7.30: "its change" was the diff against the merge base, which a base merge empties, and the hold lasted for that
  // tip only. Second review: then it was the files on its first-parent line, which counted base commits a hand fast-forward or a
  // rebase brought in. It is now what the attempt authored (`authoredNow`, recorded as `adapter.authored`).
  if (authored.length) {
    const files = new Set(authored.map((a) => a.file));
    const mine = new Set(authored.map((a) => `${a.file}\0${a.change}`));
    const ownFiles = changed.filter((f) => files.has(f));
    const byChange = ownFiles.length ? commitsIn(dir, [`${from}..${tip}`], ownFiles).flatMap((c) => c.files.filter((f) => mine.has(`${f}\0${changeOf(dir, c.commit, f)}`))) : [];
    const own = state.repos[loc.repo.name];
    const blob = (cwd, commit, f) => git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${f}`], { allowFail: true }) || null;
    const byContent = own?.worktree && fs.existsSync(own.worktree) ? ownFiles.filter((f) => blob(dir, tip, f) === blob(own.worktree, 'HEAD', f)) : [];
    const same = [...new Set([...byChange, ...byContent])].sort();
    if (same.length) return held(`the base branch now holds this attempt's own change to ${same.join(', ')}; an attempt is never judged by its own change to its rules`, { own: same });
  }
  // Once a delivery has started, its adapter kind stays (a different module would not know the integration in flight).
  const started = Object.keys(state.delivery?.repos ?? {}).length > 0 || Object.keys(state.delivery?.integrating ?? {}).length > 0;
  const deliveryFrom = state.deliveryAdapterBase ?? from;
  const kindFrom = trustedAdapter(root, state, deliveryFrom).delivery.kind;
  const kindTo = after.delivery.kind;
  const mode = started && kindFrom !== kindTo ? 'kept' : 'followed';
  // Read from git, never written out: a command that only lists the attempt writes nothing into the evidence folder.
  if (mode === 'followed' && kindTo !== 'push-main' && pluginBlob(dir, tip, loc.relative || '.', kindTo) === 'missing') return held(`the delivery adapter \`${kindTo}\` is not committed at ${ref} (${short(tip)})`);
  const gate = gateChanges(state, dir, loc.relative || '.', before, from, after, tip);
  const g = state.lastGate;
  // An acceptance stands on a gate that counted when it was given (`wf accept` refuses otherwise), so only this move can
  // take that gate's proof away. Review of 0.7.30: a delivery that has started keeps its acceptance (withdrawing it sent an
  // attempt with a repo already delivered back to "implementing"); the stale gate still runs again before the rest is delivered.
  const withdrew = Boolean(state.accepted) && !started && g?.status === 'passed' && anyOf(touching(gate, g));
  const commits = git(dir, ['log', '--format=%H%x09%s', `${from}..${tip}`, '--', ...paths], { allowFail: true }).split('\n').filter(Boolean).map((l) => ({ commit: l.slice(0, 40), subject: l.slice(41) }));
  const runtime = Boolean(state.runtimeAdapterBase) && run('git', ['merge-base', '--is-ancestor', state.runtimeAdapterBase, tip], { cwd: dir, allowFail: true }).status === 0;
  return {
    data: {
      from, to: tip, ref, repo: loc.repo.name, changed, commits, gate,
      delivery: { mode, from: kindFrom, to: kindTo, pin: mode === 'kept' ? deliveryFrom : tip },
      ...(runtime ? { runtime: true } : {}),
      ...(withdrew ? { withdrewAcceptance: true } : {}),
    },
  };
}

// Takes the base branch's adapter when it can (see the top of this file). Never fails the command that reads the attempt:
// a follow that cannot be computed now is tried again by the next command.
export function followAdapter(root, state) {
  if (!state?.adapterBase || ['done', 'abandoned'].includes(state.phase)) return state;
  let plan;
  try {
    plan = followPlan(root, state);
  } catch {
    return state;
  }
  if (!plan) return state;
  let wrote = false;
  recordedTogether(root, state.id, () => {
    const current = loadState(root, state.id);
    // What the attempt authored is kept whatever else holds (a hold or a running gate stops the follow, not the record).
    const known = new Set((current.adapterAuthored ?? []).map((a) => `${a.file}\0${a.change}`));
    const fresh = (plan.authored ?? []).filter((a) => !known.has(`${a.file}\0${a.change}`));
    if (fresh.length) {
      append(root, state.id, 'adapter.authored', { changes: fresh }, null);
      wrote = true;
    }
    if (!plan.held && !plan.data) return;
    // Read again inside the transaction: a hold or a gate that started meanwhile wins.
    if (adapterPin(current) !== adapterPin(state) || current.activeHold || liveGate(root, current)) return;
    if (plan.held) {
      if (current.adapterHeld?.tip === plan.held.tip) return;
      append(root, state.id, 'adapter.notFollowed', plan.held, null);
    } else append(root, state.id, 'adapter.followed', plan.data, null);
    wrote = true;
  });
  return wrote ? loadState(root, state.id) : state;
}

// One line for `wf status` and `wf resume`: what the attempt follows, the latest move and a tip it could not take.
export function followLines(state, root = null) {
  const lines = [];
  const last = (state.adapterFollows ?? []).at(-1);
  if (last) {
    const g = last.gate ?? {};
    const parts = [g.rerun?.length && `steps changed: ${g.rerun.join(', ')}`, g.added?.length && `steps added: ${g.added.join(', ')}`, g.removed?.length && `steps removed: ${g.removed.join(', ')}`].filter(Boolean);
    lines.push(`  adapter: follows ${last.ref}; took ${short(last.to)} (${last.changed.slice(0, 4).join(', ')}${last.changed.length > 4 ? `, +${last.changed.length - 4} more` : ''})${parts.length ? `; ${parts.join('; ')}` : ''}${last.delivery?.mode === 'kept' ? `; the delivery started under \`${last.delivery.from}\` and keeps it (the base branch now names \`${last.delivery.to}\`)` : ''}${last.withdrewAcceptance ? '; the acceptance was withdrawn: gate and accept again (the evidence review already recorded counts when the evidence is the same)' : ''}`);
  }
  // Second review of 0.7.30: an attempt that keeps its pin for good says where the base branch is now, beside the reason.
  if (state.adapterOwnHeld && state.adapterHeld) {
    let now = null;
    try {
      if (root) now = git(attemptAdapter(root, state).dir, ['rev-parse', '--verify', '--quiet', `${state.adapterHeld.ref}^{commit}`], { allowFail: true }) || null;
    } catch {}
    lines.push(`  adapter: ${state.adapterHeld.ref} is now ${short(now ?? state.adapterHeld.tip)}; this attempt keeps ${short(adapterPin(state))} for good: the base branch held this attempt's own change to ${state.adapterOwnHeld.paths.join(', ')} at ${short(state.adapterOwnHeld.tip)}, and an attempt is never judged by its own change to its rules`);
  } else if (state.adapterHeld) lines.push(`  adapter: ${state.adapterHeld.ref} (${short(state.adapterHeld.tip)}) is not taken: ${state.adapterHeld.why}; this attempt keeps ${short(adapterPin(state))}`);
  return lines;
}
