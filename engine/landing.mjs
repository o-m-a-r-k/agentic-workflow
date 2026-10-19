// The landing queue (design-0.8 section 5; stream 2), for projects with no CI whose full suite is long. A merge train,
// not a bundled release:
//   1. the ready attempts (the caller's list; nothing waits for one that is not ready) are checked with mergeFacts;
//   2. per repo, in `delivery.order`, each is squashed onto the fetched tip of the base in a landing worktree, in order;
//   3. `full` runs once on the stack; on green the stack is pushed;
//   4. on red, the stack is bisected (each ticket is one commit) to the first ticket whose commit turns it red; that one
//      is returned to its implementer with the failing log, the rest are restacked, tested and pushed.
// A base that moved during the run is fetched again and the stack rebuilt and retested: only a tested tree is pushed.
//
// Named failures: the retest race without CI (parallel pushes each needing a fresh `full` run on a moved base), and
// push-to-main with no CI (merge:untested reads the `test.run` this records against the landed tree).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WfError, append, attemptState, listAttempts, loadAdapter, mergeFacts } from './contract.mjs';
import { acquireLock, execute, git, mkdirs, provisionFrom, releaseLock, repoSpec, stamp, testEnv, workingTree } from './tests.mjs';

const upstreamOf = (spec) => `refs/remotes/${spec.remote ?? 'origin'}/${spec.base}`;

function fetchBase(checkout, spec) {
  const remote = spec.remote ?? 'origin';
  git(checkout, ['fetch', '--quiet', remote, `+refs/heads/${spec.base}:${upstreamOf(spec)}`]);
  return git(checkout, ['rev-parse', upstreamOf(spec)]);
}

// Whether the attempt's branch changes this repo against the base.
function touches(checkout, spec, branch) {
  if (git(checkout, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true }).status !== 0) return false;
  const mb = git(checkout, ['merge-base', upstreamOf(spec), branch], { allowFail: true });
  if (mb.status !== 0) return true;
  return git(checkout, ['diff', '--quiet', mb.out, branch], { allowFail: true }).status !== 0;
}

function writeNote(dir, name, text) {
  const file = path.join(mkdirs(dir), name);
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  return file;
}

// Squash one attempt's branch onto HEAD of the landing worktree. Returns { commit } (null: already on the base) or
// { conflict: text }.
function squash(dir, item, attempt, branch) {
  const r = git(dir, ['merge', '--squash', '--quiet', branch], { allowFail: true });
  if (r.status !== 0) {
    const text = `${r.err}\n${r.out}`.trim();
    git(dir, ['reset', '--hard', '--quiet', 'HEAD']);
    return { conflict: text };
  }
  if (git(dir, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return { commit: null };
  const subjects = git(dir, ['log', '--no-merges', '--reverse', '--format=%s', `HEAD..${branch}`]).split('\n').filter(Boolean);
  const author = git(dir, ['log', '-1', '--no-merges', '--format=%an <%ae>', branch]);
  const message = `${item}: ${subjects[0] ?? attempt}\n\n${subjects.map((s) => `- ${s}`).join('\n')}\n\nWf-Attempt: ${attempt}\n`;
  git(dir, ['commit', '--quiet', '--no-verify', `--author=${author}`, '-m', message]);
  return { commit: git(dir, ['rev-parse', 'HEAD']) };
}

function cherryPick(dir, commit) {
  const r = git(dir, ['cherry-pick', '--allow-empty', commit], { allowFail: true });
  if (r.status === 0) return { commit: git(dir, ['rev-parse', 'HEAD']) };
  git(dir, ['cherry-pick', '--abort'], { allowFail: true });
  return { conflict: `${r.err}\n${r.out}`.trim() };
}

// Land the ready attempts. Returns LandResult; appends `landing` (and `test.run`, source landing) to each attempt.
export async function land(root, ready, { onWait } = {}) {
  const adapter = await loadAdapter(root);
  if (adapter.delivery?.authority?.push === 'person') throw new WfError('the landing queue pushes to the base, but delivery.authority.push is `person`');
  const result = { landed: [], failed: [] };
  const ids = [...new Set(ready)];
  if (!ids.length) return result;
  const batch = `L-${stamp()}`;
  const notes = path.join(root, '.wf-evidence', 'landing', batch);
  const states = new Map();
  const blocked = new Map(); // attempt → reason it stops landing (later repos are not landed either)
  for (const a of ids) {
    const state = await attemptState(root, a);
    states.set(a, state);
    if (!state?.open) {
      blocked.set(a, 'the attempt is not open');
      continue;
    }
    const problems = (await mergeFacts(root, a)).filter((p) => p.id !== 'merge:untested');
    if (problems.length) blocked.set(a, problems.map((p) => `${p.id}: ${p.message}`).join('; '));
  }
  const order = adapter.delivery?.order?.length ? adapter.delivery.order : adapter.repos.map((r) => r.name);
  const lock = await acquireLock({ name: `landing-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}`, count: 1 }, { root, kind: 'landing' }, { onWait });
  try {
    for (const repo of order) {
      const spec = repoSpec(adapter, repo);
      const checkout = path.join(root, spec.path);
      const inRepo = ids.filter((a) => states.get(a)?.repos?.[repo]);
      if (!inRepo.length) continue;
      fetchBase(checkout, spec);
      const members = [];
      for (const a of inRepo) {
        if (!touches(checkout, spec, states.get(a).repos[repo].branch)) continue;
        if (blocked.has(a)) result.failed.push({ attempt: a, repo, reason: blocked.get(a), log: null });
        else members.push(a);
      }
      if (!members.length) continue;
      if (!spec.tests?.full) {
        for (const a of members) {
          result.failed.push({ attempt: a, repo, reason: `\`${repo}\` has no full tests, so no landed tree can be proven`, log: null });
          blocked.set(a, `its ${repo} part did not land`);
        }
        continue;
      }
      const out = await landRepo({ root, adapter, spec, checkout, repo, members, states, batch, notes });
      for (const l of out.landed) result.landed.push(l);
      for (const f of out.failed) {
        result.failed.push(f);
        blocked.set(f.attempt, `its ${repo} part did not land`);
      }
    }
  } finally {
    releaseLock(lock);
    fs.rmSync(path.join(root, '.wf-worktrees', '.landing', batch), { recursive: true, force: true });
  }
  return result;
}

async function landRepo({ root, adapter, spec, checkout, repo, members, states, batch, notes }) {
  const landed = [];
  const failed = [];
  const events = []; // [attempt, data], appended once the outcome is final
  const record = (a, data) => events.push([a, { batch, repo, attempts: members, ...data }]);
  const tipOf = (a) => git(checkout, ['rev-parse', states.get(a).repos[repo].branch]);
  const dir = path.join(root, '.wf-worktrees', '.landing', batch, repo);
  const env = testEnv(root, null, repo, 'full');
  const verdicts = new Map(); // tree → { pass, log, exitCode, ms }
  let bisects = 0;
  let pending = [...members];
  try {
    for (;;) {
      const baseSha = fetchBase(checkout, spec);
      git(checkout, ['worktree', 'remove', '--force', dir], { allowFail: true });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(checkout, ['worktree', 'add', '--detach', '--quiet', dir, baseSha]);
      provisionFrom(checkout, dir, spec.provision, env);
      // Stack: tips[k] is the base with the first k tickets.
      let stack = [];
      const tips = [baseSha];
      const already = [];
      for (const a of pending) {
        const s = squash(dir, states.get(a).item ?? a, a, states.get(a).repos[repo].branch);
        if (s.conflict) {
          const log = writeNote(notes, `${repo}-${a}-conflict.txt`, `${a} does not apply on ${spec.base} ${baseSha.slice(0, 12)} with the tickets before it (${stack.map((x) => x.attempt).join(', ') || 'none'}):\n${s.conflict}`);
          failed.push({ attempt: a, repo, reason: `conflicts with ${spec.base}${stack.length ? ` and ${stack.map((x) => x.attempt).join(', ')}` : ''}`, log });
          record(a, { result: 'failed', sha: tipOf(a), log });
        } else if (s.commit === null) already.push(a);
        else {
          stack.push({ attempt: a, commit: s.commit });
          tips.push(s.commit);
        }
      }
      // Run `full` on the tree at tips[k]; record the run on the attempts it contains.
      const test = async (k) => {
        git(dir, ['checkout', '--quiet', '--detach', tips[k]]);
        const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
        if (!verdicts.has(tree)) {
          const log = path.join(mkdirs(notes), `${repo}-full-${verdicts.size + 1}.log`);
          const lock = await acquireLock(spec.tests.full.lock, { root, attempt: batch, repo, kind: 'full' });
          let r;
          try {
            r = await execute({ spec: spec.tests.full, cwd: dir, log, env, ctx: { repo, kind: 'full', attempt: null }, root, adapter });
          } finally {
            releaseLock(lock);
          }
          if (workingTree(dir) !== tree) throw new WfError(`the full tests of \`${repo}\` changed tracked files in the landing worktree; nothing was landed`, { hint: 'Make the full tests leave the tree as they found it (.gitignore what they write).' });
          verdicts.set(tree, { ...r, log, tree });
          for (const x of stack.slice(0, k)) await append(root, x.attempt, 'test.run', { repo, kind: 'full', tree, pass: r.pass, exitCode: r.exitCode, ms: r.ms, source: 'landing', log, landing: batch }, null);
        }
        return verdicts.get(tree);
      };
      let top = stack.length ? await test(stack.length) : null;
      let baseRed = null;
      while (top && !top.pass) {
        let lo = 0;
        let hi = stack.length;
        let bad = top;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          bisects += 1;
          const v = await test(mid);
          if (v.pass) lo = mid;
          else {
            hi = mid;
            bad = v;
          }
        }
        if (hi === 1) {
          // The first ticket alone fails: tell its failure from a base that already fails.
          bisects += 1;
          const base = await test(0);
          if (!base.pass) {
            baseRed = base;
            break;
          }
        }
        const culprit = stack[hi - 1];
        failed.push({ attempt: culprit.attempt, repo, reason: `full fails with it on top of ${spec.base}`, log: bad.log });
        record(culprit.attempt, { result: 'returned', sha: tipOf(culprit.attempt), full: { tree: bad.tree, pass: false, log: bad.log }, bisects, log: bad.log });
        // Restack the tickets after it on the last green prefix.
        git(dir, ['checkout', '--quiet', '--detach', tips[hi - 1]]);
        const rest = stack.slice(hi);
        stack = stack.slice(0, hi - 1);
        tips.length = hi;
        for (const x of rest) {
          const c = cherryPick(dir, x.commit);
          if (c.conflict) {
            const log = writeNote(notes, `${repo}-${x.attempt}-conflict.txt`, `${x.attempt} does not apply once ${culprit.attempt} is taken out:\n${c.conflict}`);
            failed.push({ attempt: x.attempt, repo, reason: `does not apply without ${culprit.attempt}`, log });
            record(x.attempt, { result: 'failed', sha: tipOf(x.attempt), log });
          } else {
            stack.push({ attempt: x.attempt, commit: c.commit });
            tips.push(c.commit);
          }
        }
        top = stack.length ? await test(stack.length) : null;
      }
      if (baseRed) {
        for (const x of stack) {
          failed.push({ attempt: x.attempt, repo, reason: `full already fails on ${spec.base} ${baseSha.slice(0, 12)}; no ticket is to blame`, log: baseRed.log });
          record(x.attempt, { result: 'failed', sha: tipOf(x.attempt), full: { tree: baseRed.tree, pass: false, log: baseRed.log }, bisects, log: baseRed.log });
        }
        for (const a of already) landed.push({ attempt: a, repo, sha: baseSha });
        break;
      }
      if (stack.length) {
        git(dir, ['checkout', '--quiet', '--detach', tips[stack.length]]);
        const push = git(dir, ['push', '--quiet', spec.remote ?? 'origin', `HEAD:refs/heads/${spec.base}`], { allowFail: true });
        if (push.status !== 0) {
          const now = fetchBase(checkout, spec);
          if (now === baseSha) throw new WfError(`push of the landing stack to ${spec.base} failed: ${push.err}`);
          // The base moved while full ran: rebuild on the new tip and test again. Returned and failed tickets stay out.
          const out = new Set(failed.map((f) => f.attempt));
          pending = pending.filter((a) => !out.has(a));
          events.splice(0, events.length, ...events.filter(([, d]) => d.result !== 'landed'));
          continue;
        }
      }
      for (const x of stack) {
        landed.push({ attempt: x.attempt, repo, sha: x.commit });
        record(x.attempt, { result: 'landed', sha: x.commit, full: { tree: top.tree, pass: true, log: top.log }, bisects });
      }
      for (const a of already) {
        landed.push({ attempt: a, repo, sha: baseSha });
        record(a, { result: 'landed', sha: baseSha, bisects });
      }
      break;
    }
  } finally {
    git(checkout, ['worktree', 'remove', '--force', dir], { allowFail: true });
    git(checkout, ['worktree', 'prune'], { allowFail: true });
  }
  for (const [a, data] of events) await append(root, a, 'landing', data, null);
  return { landed, failed };
}

// The queue: open schema 2 attempts whose `land` stage waits, oldest first. An attempt the last run returned stays out
// until its branch moves (a fix); nothing waits for an attempt that is not in the queue.
export async function queue(root, adapter) {
  const out = [];
  for (const id of await listAttempts(root)) {
    let s;
    try {
      s = await attemptState(root, id);
    } catch {
      continue;
    }
    if (!s?.open || s.schema !== 2) continue;
    const i = (s.stages ?? []).findIndex((st) => st.do === 'land');
    const waiting = i >= 0 ? s.stageResults?.[i] : null;
    if (waiting?.state !== 'waiting') continue;
    const repos = Object.keys(s.repos ?? {});
    const lastFor = (repo) => [...(s.landings ?? [])].reverse().find((l) => l.repo === repo);
    if (repos.length && repos.every((r) => lastFor(r)?.result === 'landed')) continue;
    const stillReturned = repos.some((r) => {
      const l = lastFor(r);
      if (l?.result !== 'returned') return false;
      const spec = adapter.repos.find((x) => x.name === r);
      const tip = spec ? git(path.join(root, spec.path), ['rev-parse', s.repos[r].branch], { allowFail: true }) : null;
      return tip?.status === 0 && tip.out === l.sha;
    });
    if (stillReturned) continue;
    out.push({ id, at: waiting.at ?? '' });
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at))).map((x) => x.id);
}

// wf land [<attempt>...]: run the landing queue once.
export async function cmdLand(ctx, args) {
  if (!ctx.root) throw new WfError('no project here: wf land runs inside a project with an adapter');
  const adapter = await loadAdapter(ctx.root);
  let ready = args._ ?? [];
  if (!ready.length) {
    if (adapter.delivery?.landing !== 'queue') throw new WfError('delivery.landing is not `queue`: name the attempts to land, or let `wf deliver` land each one');
    ready = await queue(ctx.root, adapter);
  }
  if (!ready.length) return { text: 'The landing queue is empty.', data: { landed: [], failed: [] } };
  const r = await land(ctx.root, ready, { onWait: () => process.stderr.write('waiting for another landing run of this project\n') });
  const lines = [
    ...r.landed.map((l) => `landed ${l.attempt} ${l.repo} ${String(l.sha).slice(0, 12)}`),
    ...r.failed.map((f) => `not landed ${f.attempt} ${f.repo}: ${f.reason}${f.log ? ` (${f.log})` : ''}`),
  ];
  return { text: lines.join('\n') || 'Nothing to land.', data: r };
}

export const implements08 = { land, cmdLand };
