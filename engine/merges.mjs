// 0.7.34 (I-233): what a base merge did to an attempt's change, read from git facts only.
//
// Named failure (field): the work skill's "before the gate, merge a moved base" had no fixed point. On one attempt the base was
// merged seven times in three days (six `wf base merge`, one hand merge in an implementer's handoff), the owner stopped a
// running gate to merge again, and the strategist's correction "reconcile the base once" could not be followed. None of the six
// recorded merges changed the ticket's change (its `stablePatch` held), yet each changed a file the ticket changes
// (`project.yaml`, the adapter test) and no reviewer was ever asked about those edits; the one hand merge resolved conflicts in
// 13 of the ticket's files and its round judged the whole merged diff, not the resolution.
//
// A base merge is a commit on the attempt's first-parent line with two parents whose second parent is on the fetched base
// branch. For each one the engine reads:
//   touched  the attempt's files the merge changed (`git diff --name-only p1 m` within the attempt's files before and after)
//   resolved the paths where the committed merge differs from git's own automatic merge (`git merge-tree --write-tree p1 p2`):
//            a conflict resolution, an edit made in the merge commit, or a hook or merge driver that changed the result.
//            Null when git cannot compute it (older than 2.38): then the merge is judged as if it resolved everything.
//   ownSame  whether the attempt's change is the same before and after, without context or line numbers
// and classes it, `changed` over `context` over `none`:
//   changed  resolved is not empty (or unknown), or the change itself differs: judged before the gate (a `merge` round), or on
//            the direct routes by the evidence review after it
//   context  only other work edited the attempt's files: judged by the next review handed, whatever it is for; never holds the gate
//   none     it touched none of the attempt's files: nothing to judge
// The engine checks only these facts and that each merge it hands a reviewer is answered; what an edit means is the reviewer's.
import { git, hashValue, run } from './util.mjs';
import { append, listAttempts, loadState, recordedTogether } from './ledger.mjs';

const names = (wt, a, b) => {
  const out = git(wt, ['diff', '--name-only', '--no-renames', a, b], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
};
// The change between two commits without context or line numbers: per file its removed and added lines, in order.
const linesOf = (wt, a, b) => {
  const out = run('git', ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', a, b], { cwd: wt, allowFail: true }).stdout || '';
  return hashValue(out.split('\n').filter((l) => l.startsWith('diff --git ') || (/^[+-]/.test(l) && !/^(\+\+\+|---)( |$)/.test(l))).join('\n'));
};
const isAncestor = (wt, a, b) => run('git', ['merge-base', '--is-ancestor', a, b], { cwd: wt, allowFail: true }).status === 0;

export const classOf = (f) => (f.resolved === null || f.resolved === undefined || f.resolved.length || f.ownSame === false ? 'changed' : f.touched.length ? 'context' : 'none');

// The facts of one merge commit, or null when it is not a two-parent commit. Pure git, no ledger.
const factsCache = new Map();
export function mergeFacts(wt, merge) {
  const key = `${wt}\0${merge}`;
  if (factsCache.has(key)) return factsCache.get(key);
  const parents = git(wt, ['rev-list', '--parents', '-n', '1', merge], { allowFail: true }).split(' ').slice(1);
  if (parents.length !== 2) return null;
  const [p1, p2] = parents;
  const fork = git(wt, ['merge-base', p1, p2], { allowFail: true });
  if (!fork) return null;
  const own = new Set([...names(wt, fork, p1), ...names(wt, p2, merge)]);
  const touched = names(wt, p1, merge).filter((f) => own.has(f));
  const ownSame = linesOf(wt, fork, p1) === linesOf(wt, p2, merge);
  const mt = run('git', ['merge-tree', '--write-tree', '--no-messages', p1, p2], { cwd: wt, allowFail: true });
  const autoTree = [0, 1].includes(mt.status) && /^[0-9a-f]{40,64}$/.test(mt.stdout.split('\n')[0].trim()) ? mt.stdout.split('\n')[0].trim() : null;
  const resolved = autoTree ? names(wt, autoTree, merge) : null;
  const facts = { merge, p1, p2, fork, touched, resolved, ownSame, autoTree };
  const out = { ...facts, class: classOf(facts) };
  factsCache.set(key, out);
  return out;
}

// The recorded classification of a merge commit in a repo (`base.merged` with its facts, or `base.observed`), or null.
export const allBaseMerges = (state) => [...(state.baseMerges ?? []), ...(state.baseObserved ?? [])];
export const mergeRecord = (state, repo, sha) => allBaseMerges(state).find((m) => m.repo === repo && (m.merge === sha || m.headAfter === sha) && m.class) ?? null;

const baseRefOf = (r) => r.baseRef ?? r.base;
// Whether a two-parent commit brought the base in: its second parent is on the fetched base branch and not already in the first.
const bringsBase = (wt, r, p1, p2) => isAncestor(wt, p2, baseRefOf(r)) && !isAncestor(wt, p2, p1);

// A merge commit's classification: recorded, else read from git when it brings the base in (never recorded here), else null.
function classified(state, name, sha, parents) {
  const rec = mergeRecord(state, name, sha);
  if (rec) return rec;
  const r = state.repos[name];
  if (parents.length !== 2 || !bringsBase(r.worktree, r, parents[0], parents[1])) return null;
  const f = mergeFacts(r.worktree, sha);
  return f ? { ...f, repo: name } : null;
}

const headOf = (t) => String(t ?? '').split('+')[0];

// The first-parent path from `from` to `to` in a repo when it holds only base merges: their records, newest first ([] when
// equal). Null when the path holds any other commit, or `to` does not descend from `from` along its first parents.
export function mergeOnlyPath(state, name, from, to) {
  const r = state.repos?.[name];
  if (!r?.worktree || !from || !to) return null;
  if (from === to) return [];
  if (!isAncestor(r.worktree, from, to)) return null;
  const lines = git(r.worktree, ['rev-list', '--first-parent', '--parents', `${from}..${to}`], { allowFail: true }).split('\n').filter(Boolean);
  if (!lines.length) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const [sha, ...parents] = lines[i].split(' ');
    const next = i + 1 < lines.length ? lines[i + 1].split(' ')[0] : from;
    if (parents[0] !== next) return null;
    const rec = classified(state, name, sha, parents);
    if (!rec) return null;
    out.push(rec);
  }
  return out;
}

// Whether the tree moved from `fromTree` to `toTree` only by base merges of the classes allowed: { ok, merges }.
export function throughMerges(state, fromTree, toTree, { allow = ['none', 'context'] } = {}) {
  if (!fromTree || !toTree) return { ok: false, merges: [] };
  const merges = [];
  for (const name of new Set([...Object.keys(fromTree), ...Object.keys(toTree)])) {
    const a = fromTree[name];
    const b = toTree[name];
    if (a === b) continue;
    if (String(a ?? '').includes('+dirty') || String(b ?? '').includes('+dirty')) return { ok: false, merges: [] };
    let path;
    try {
      path = mergeOnlyPath(state, name, headOf(a), headOf(b));
    } catch {
      return { ok: false, merges: [] };
    }
    if (!path || path.some((m) => !allow.includes(m.class))) return { ok: false, merges: [] };
    merges.push(...path.map((m) => ({ ...m, repo: name })));
  }
  return { ok: true, merges };
}

// Every base merge on the first-parent line after `since` (a tree record; the admission base where it names none), with its
// classification, oldest first.
export function mergesSince(state, since = {}) {
  const out = [];
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!r?.worktree) continue;
    const from = headOf(since?.[name]) || r.base;
    let lines;
    try {
      lines = git(r.worktree, ['rev-list', '--first-parent', '--merges', '--parents', '--reverse', `${from}..HEAD`], { allowFail: true }).split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const l of lines) {
      const [sha, ...parents] = l.split(' ');
      let rec = null;
      try {
        rec = classified(state, name, sha, parents);
      } catch {}
      if (rec) out.push({ ...rec, repo: name });
    }
  }
  return out;
}

export const mergeId = (m) => (m.n ? `base:${m.n}` : `base:${String(m.merge ?? m.headAfter).slice(0, 10)}`);

// What a reviewer is handed about the base merges since the last recorded round: each one that is not `none`, with the
// commands that show what it did. The closure answers each in `baseMerges` (engine/lifecycle.mjs recordReview).
export function baseMergeSection(state, since) {
  const list = mergesSince(state, since).filter((m) => m.class !== 'none');
  if (!list.length) return null;
  return list.map((m) => {
    const wt = state.repos[m.repo].worktree;
    const sha = m.merge ?? m.headAfter;
    const files = (l) => (l?.length ? ` -- ${l.map((f) => JSON.stringify(f)).join(' ')}` : '');
    return {
      id: mergeId(m),
      repo: m.repo,
      merge: sha,
      base: m.ref ?? baseRefOf(state.repos[m.repo]),
      class: m.class,
      touched: m.touched,
      resolved: m.resolved,
      ownSame: m.ownSame,
      commands: {
        baseEdits: m.touched.length ? `git -C ${wt} diff ${m.p1} ${sha}${files(m.touched)}` : null,
        resolution: m.resolved === null ? `git -C ${wt} show --remerge-diff ${sha}` : m.resolved.length ? (m.autoTree ? `git -C ${wt} diff ${m.autoTree} ${sha}${files(m.resolved)}` : `git -C ${wt} show --remerge-diff ${sha}`) : null,
        changeBefore: m.ownSame === false ? `git -C ${wt} diff ${m.fork} ${m.p1}` : null,
        changeAfter: m.ownSame === false ? `git -C ${wt} diff ${m.p2} ${sha}` : null,
      },
    };
  });
}

// The facts recorded on `base.merged` (and on the delivery's own merge): what `wf base merge` or push-main did.
export function recordedFacts(wt, merge) {
  const f = mergeFacts(wt, merge);
  if (!f) return {};
  return { merge, touched: f.touched, resolved: f.resolved, ownSame: f.ownSame, autoTree: f.autoTree, p1: f.p1, p2: f.p2, fork: f.fork, class: f.class };
}

// Base merges the engine has not classified yet (one made by hand, or one `wf base merge` recorded before 0.7.34): classified
// once and recorded as `base.observed`, as `adapter.authored` records what the attempt authored (D60), so the classification
// replays from the ledger and every later read finds it there. Never fails the command that reads the attempt.
export function observeBaseMerges(root, state) {
  if (!state?.repos || ['done', 'abandoned'].includes(state.phase)) return state;
  const fresh = [];
  try {
    for (const [name, r] of Object.entries(state.repos)) {
      if (!r?.worktree || !r.base) continue;
      const lines = git(r.worktree, ['rev-list', '--first-parent', '--merges', '--parents', '--reverse', `${r.base}..HEAD`], { allowFail: true }).split('\n').filter(Boolean);
      for (const l of lines) {
        const [sha, ...parents] = l.split(' ');
        if (mergeRecord(state, name, sha) || parents.length !== 2 || !bringsBase(r.worktree, r, parents[0], parents[1])) continue;
        const f = mergeFacts(r.worktree, sha);
        if (f) fresh.push({ repo: name, ref: baseRefOf(r), from: f.fork, to: f.p2, commits: Number(git(r.worktree, ['rev-list', '--count', `${f.fork}..${f.p2}`], { allowFail: true }) || 0), ...recordedFacts(r.worktree, sha) });
      }
    }
  } catch {
    return state;
  }
  if (!fresh.length) return state;
  try {
    recordedTogether(root, state.id, () => {
      const current = loadState(root, state.id);
      for (const d of fresh) if (!mergeRecord(current, d.repo, d.merge)) append(root, state.id, 'base.observed', d, null);
    });
    return loadState(root, state.id);
  } catch {
    return state;
  }
}

// 0.7.34 (I-233): the base's work in this ticket's files, told plainly for whoever tests the delivery: each base commit between
// `from` and `to` that changed one of `files`, with the ticket whose workflow delivery brought it (I-119's delivered heads), or
// that no workflow delivery covers it (merged by hand).
export function baseWorkIn(root, wt, repoName, from, to, files) {
  if (!files?.length) return [];
  const commits = git(wt, ['log', '--format=%H%x09%s', `${from}..${to}`, '--', ...files], { allowFail: true }).split('\n').filter(Boolean).map((l) => ({ commit: l.slice(0, 40), subject: l.slice(41) }));
  if (!commits.length) return [];
  const heads = [];
  for (const id of listAttempts(root)) {
    try {
      const s = loadState(root, id);
      const c = s.delivery?.repos?.[repoName]?.commit;
      if (typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c) && isAncestor(wt, c, to) && !isAncestor(wt, c, from)) heads.push({ commit: c, item: s.item ?? id });
    } catch {
      // a damaged ledger names nothing delivered
    }
  }
  return commits.map((x) => {
    const holders = heads.filter((h) => isAncestor(wt, x.commit, h.commit));
    const first = holders.find((h) => !holders.some((o) => o !== h && isAncestor(wt, o.commit, h.commit))) ?? null;
    const changed = names(wt, `${x.commit}^`, x.commit).filter((f) => files.includes(f));
    return { ...x, files: changed, item: first?.item ?? null };
  });
}
export const baseWorkLines = (work) => work.map((w) => `${w.commit.slice(0, 10)} ${w.subject} (${w.files.join(', ')}; ${w.item ? `delivered with ${w.item}` : 'no workflow delivery brought it: merged by hand'})`);

// The repos whose base branch, as last fetched, holds commits the worktree does not (no fetch: a fact about the refs as they are).
export function baseAhead(state) {
  const out = [];
  for (const [name, r] of Object.entries(state.repos ?? {})) {
    if (!r?.worktree) continue;
    try {
      const n = Number(git(r.worktree, ['rev-list', '--count', `HEAD..${baseRefOf(r)}`], { allowFail: true }) || 0);
      if (n > 0) out.push({ repo: name, commits: n });
    } catch {}
  }
  return out;
}
