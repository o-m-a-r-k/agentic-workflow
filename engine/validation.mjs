import { CONFIG_FILE, adapterPin, attemptAdapter, decodeEscapes, trustedAdapter, adapterFileAtCommit } from './config.mjs';
import { actor, openState, treeHashes } from './attempt.mjs';
import { append, attemptDir, listAttempts, loadState } from './ledger.mjs';
import { loadCatalog } from './secrets.mjs';
import { canonical, git, gitEnv, globToRegExp, hashFile, hashValue, refuse, run, YAML } from './util.mjs';
import { approveHint, decisionFor, labelOf } from './approve.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Named failure: required HTTP/browser proof discovered after admission could
// only be run outside sealed evidence, or by replacing the frozen adapter.
// Additions never replace admission rules, step definitions, or their plugins.
export const validationDigest = (state) => state.validations?.length ? hashValue(state.validations) : null;
export const validationCommit = (state, id) => state.validations?.find((v) => v.steps.some((s) => s.id === id))?.commit ?? adapterPin(state);
export const validationIds = (state) => (state.validations ?? []).flatMap((v) => v.steps.map((s) => s.id));

export function gateAdapter(root, state) {
  const frozen = trustedAdapter(root, state);
  const steps = [...frozen.gate.steps];
  for (const record of state.validations ?? []) {
    const candidate = trustedAdapter(root, state, record.commit);
    for (const selected of record.steps) {
      const step = candidate.gate.steps.find((s) => s.id === selected.id);
      // I-138: corrections recorded by an earlier local build (before 0.7.8 required the person's decision) marked the
      // corrected step itself (`steps[].admission`) and kept the original in `from` unmarked; reviewed since, they blocked
      // every check and correction of their attempt. That exact shape counts; the engine writes it no more (a new admission
      // correction marks `from` and carries the person's decision).
      // 0.7.29 (I-204): a correction a batch carried from a member says so in its own carried record (`correctedFrom`).
      const wasAdmission = (record.carriedFrom && (record.correctedFrom ?? []).some((f) => f.id === selected.id && f.admission)) || (state.validationCorrections ?? []).some((c) => (c.from ?? []).some((f) => f.id === selected.id && f.admission) || ((c.steps ?? []).some((x) => x.id === selected.id && x.admission === true) && !(c.from ?? []).some((f) => f.admission)));
      if (!step || canonical(step) !== canonical(selected.definition)) throw refuse('supplemental validation no longer matches its recorded committed definition');
      // I-125: an admission step the person let the attempt correct runs at its corrected definition, in its place.
      const at = steps.findIndex((s) => s.id === step.id);
      // 0.7.29 (I-204): a corrected admission step runs where a registered one does, in the attempt's own gate. Named failure
      // (found reproducing I-204): a member admitted with --defer-heavy that corrected a heavy admission check deferred it, while
      // its gate required every registered or corrected check to pass, so no gate of that member could pass short of `--full`.
      if (at >= 0) {
        // 0.7.30 (I-151, D60): the attempt follows its base branch's adapter, and the project may since have committed a step
        // of the id this attempt registered (often the registration itself, delivered). The attempt's own check keeps its
        // pin and runs in that place. Named failure (found building the follow): the collision refused every gate of the
        // attempt as "no longer matches". A step of that id the attempt was admitted with still refuses, as before.
        if (!wasAdmission && (adapterPin(state) === state.adapterBase || trustedAdapter(root, state, state.adapterBase).gate.steps.some((s) => s.id === step.id))) throw refuse('supplemental validation no longer matches its recorded committed definition');
        steps[at] = { ...step, deferrable: false };
      } else steps.push({ ...step, deferrable: false });
    }
  }
  return { ...frozen, gate: { ...frozen.gate, steps } };
}

// Only existing catalogued keys may acquire an explicit new step binding. Store
// locations, formats and values remain the original project's; never record values.
export function validationCatalog(root, state, id) {
  const selected = state.validations?.flatMap((v) => v.steps).find((s) => s.id === id);
  const catalog = loadCatalog(root);
  if (!selected) return catalog;
  const keys = new Set(selected.secretKeys);
  if ([...keys].some((key) => !catalog.some((e) => e.key === key))) throw refuse('supplemental validation requires an existing catalogued key that is no longer available');
  return catalog.filter((e) => keys.has(e.key)).map((e) => ({ ...e, usedBy: [id] }));
}

// 0.7.29 (I-204). Named failure (field): four accepted members, each admitted with `--defer-heavy`, were assembled into a batch.
// Their registered HTTP and browser checks (`wf validation add`) lived in the members' ledgers and adapter commits only: the
// batch was admitted on the base's adapter, `wf batch create` copied no member's registrations, and the batch's gate selected
// none of them. A gate on the combined tree could pass without the members' required proofs; only its reviewer noticed. A
// batch now carries every check a member registered or corrected, pinned where the member pinned it (its definition, its
// plugin code and the screenshots it collects), and its gate counts only once each of them passed on the combined tree.

// Each step a member registered or corrected: where it is pinned, what it is (definition and plugin code), and, for a
// correction of one of the member's own admission steps, the admission definition it replaced.
function memberSteps(root, member) {
  if (!member.validations?.length) return [];
  const admission = trustedAdapter(root, member).gate.steps;
  return member.validations.flatMap((record) => record.steps.map((step) => ({
    member: member.id, item: member.item, commit: record.commit, step, criteria: record.criteria ?? [], reason: record.reason ?? null,
    original: admission.find((s) => s.id === step.id) ?? null,
    identity: correctionIdentity(root, member, record.commit, step),
  })));
}

// Two members that pinned one step id to different definitions or plugin code: the batch can run only one of them under
// that id, so carrying either drops the other's proof. Checked before the batch exists.
export function batchValidationConflicts(root, members) {
  const first = new Map();
  const conflicts = [];
  for (const m of members) for (const x of memberSteps(root, m)) {
    const seen = first.get(x.step.id);
    if (!seen) first.set(x.step.id, x);
    else if (!x.identity || x.identity !== seen.identity) conflicts.push(`${x.step.id} (${seen.member} pinned it at ${seen.commit.slice(0, 10)}, ${x.member} at ${x.commit.slice(0, 10)}, with a different definition or plugin)`);
  }
  return conflicts;
}

// The records the batch carries, and the member checks it does not carry with why. A member's own registration is carried
// unless the batch's admission adapter (the base it was admitted on) already has a step of that id, which then runs as the
// batch admitted it. A member's correction of one of its admission steps is carried when the batch admitted that step as the
// member had it (the person approved that correction there, `approvedIn`); when the base already holds the corrected
// definition there is nothing to carry, and when the base changed it otherwise the batch runs its own.
export function carriedValidations(root, batch, members) {
  const admission = trustedAdapter(root, batch).gate.steps;
  const byId = new Map();
  const notCarried = [];
  for (const m of members) for (const x of memberSteps(root, m)) {
    const from = { attempt: x.member, item: x.item, commit: x.commit, criteria: x.criteria, reason: x.reason };
    const have = byId.get(x.step.id);
    if (have) {
      have.carriedFrom.push(from);
      continue;
    }
    const own = admission.find((s) => s.id === x.step.id);
    const record = { commit: x.commit, steps: [x.step], criteria: (batch.criteria ?? []).map((c) => c.id), reason: `carried from ${x.member}${x.reason ? `: ${x.reason}` : ''}`, carriedFrom: [from] };
    if (x.original) {
      if (own && canonical(own) === canonical(x.step.definition)) continue;
      if (!own || canonical(own) !== canonical(x.original)) {
        notCarried.push({ id: x.step.id, member: x.member, why: own ? `the batch's admission adapter defines ${x.step.id} differently from the definition ${x.member} corrected; the batch runs its own` : `the batch's admission adapter has no step ${x.step.id}` });
        continue;
      }
      const decision = (m.validationCorrections ?? []).filter((c) => (c.steps ?? []).some((s) => s.id === x.step.id)).at(-1);
      byId.set(x.step.id, { ...record, correctedFrom: [{ id: x.step.id, commit: adapterPin(batch), definition: own, admission: true }], ...(decision?.decision ? { approvedIn: { attempt: x.member, decision: decision.decision } } : decision?.approvedIn ? { approvedIn: decision.approvedIn } : {}) });
      continue;
    }
    if (own) {
      if (canonical(own) !== canonical(x.step.definition)) notCarried.push({ id: x.step.id, member: x.member, why: `the batch's admission adapter now defines ${x.step.id} itself, differently; the batch runs its own` });
      continue;
    }
    byId.set(x.step.id, record);
  }
  return { records: [...byId.values()], notCarried };
}

export const addValidation = (root, options) => registerValidation(root, options, false);

// Named failure (I-102): review found a defect in a supplemental validation's plugin, and registration had no remove,
// overwrite or repin: fixing and committing the plugin left the gate running the defective plugin pinned at registration,
// for ever. A correction re-pins steps that are already registered, at a later commit, and keeps every obligation
// registration carries (closed roles, a committed tree, a commit that descends from the admission commit and now from the
// previous pin, a recorded reason, existing catalogued secret keys, admitted repos); the ledger keeps both pins, and the
// changed digest and the later date make the gate wait for a fresh code review and run every step again.
export const correctValidation = (root, options) => registerValidation(root, options, true);

// What a corrected step is: its definition and the plugin code it runs, as committed.
function correctionIdentity(root, state, commit, step) {
  let pluginHash = null;
  try {
    pluginHash = step.definition.plugin ? hashFile(adapterFileAtCommit(root, state, commit, step.definition.plugin)) : null;
  } catch {
    return null;
  }
  return hashValue({ id: step.id, definition: step.definition, pluginHash });
}

// 0.7.27 (I-187), named failure (field): the person approved correcting two admission checks to the definitions committed at one
// commit; a base merge advanced the attempt's HEAD before the command ran again, and the question's key named that HEAD, so the
// same correction under the same definitions was asked a second time. What the person approves is the correction: the
// admission steps and the definitions (and plugin code) they are corrected to, whatever commit holds them. The key is made of
// exactly that. The reason is the agent's note in the record, not part of the question the person reads; another attempt's
// approval is taken whatever its reason (below), and so is this attempt's own. Where a plugin cannot be read the identity is
// unknown and the key names the commit, as before. A question an earlier release asked under its commit is the same question
// while the definitions at that commit are the ones asked for now (`askedUnderCommit`).
const sameIds = (list, of) => canonical([...list].sort()) === canonical([...of].sort());
const admissionIdentities = (root, state, commit, steps, admission) => steps.filter((s) => admission.includes(s.id)).map((s) => correctionIdentity(root, state, commit, s));
const admissionIdentity = (identities) => (identities.length && identities.every(Boolean) ? hashValue([...identities].sort()) : null);
const correctionKey = (admission, identity, commit) => `correct-admission:${[...admission].sort().join(',')}:${identity ? `identity-${identity}` : commit}`;
const KEY = /^correct-admission:([^:]+):(?:([0-9a-f]{7,40})|identity-([0-9a-f]{64}))$/;

// The identities of the named admission steps as committed at `commit`, or null when that commit's adapter or a step cannot be read.
function identitiesAt(root, state, commit, ids) {
  let candidate;
  try {
    candidate = trustedAdapter(root, state, commit);
  } catch {
    return null;
  }
  const have = ids.map((id) => { const definition = candidate.gate.steps.find((x) => x.id === id); return definition ? correctionIdentity(root, state, commit, { id, definition }) : null; });
  return have.every(Boolean) ? have : null;
}

// A question an earlier release asked under the commit it was asked at (`correct-admission:<ids>:<commit>`) is the question asked
// now when the definitions at that commit are the ones asked for now. Its answer holds, pending, declined or approved and not yet
// used, however far HEAD has moved since. The attempt's latest such question.
function askedUnderCommit(root, state, admission, wantAdmission) {
  for (const d of [...(state.decisions ?? [])].reverse()) {
    const m = d.kind === 'override-gate' && !d.withdrawn && !d.spent ? KEY.exec(String(d.key)) : null;
    if (!m?.[2] || !sameIds(m[1].split(','), admission)) continue;
    const have = identitiesAt(root, state, m[2], m[1].split(','));
    if (have && canonical([...have].sort()) === canonical([...wantAdmission].sort())) return d;
  }
  return null;
}

// What a question asked under the earlier key says now: asked as it is, a declined one stands, an approval is taken.
function standingAnswer(state, d) {
  if (!d.approved) throw refuse(`not done: correcting an admission check is the owner's decision (${d.id}: ${d.summary})`, approveHint(state, d), { id: 'approve:override-gate' });
  if (d.approved.choice !== 'yes') throw refuse(`not done: correcting the admission check: the person answered ${d.id} ${d.approved.words ? `in their own words, "${d.approved.words}"` : `"${labelOf(d, d.approved.choice)}"`}`, `follow their answer; it is not asked again. If something changed since they answered, withdraw it with what changed (\`wf decisions withdraw ${d.id} --attempt ${state.id} --reason "<what changed>"\`) and run this command again`, { id: 'approve:answered' });
  return d.id;
}

// 0.7.32 (D78): a question an earlier release asked about a correction (pending, not answered) is no longer asked: it is withdrawn
// with this reason when the correction runs again, and `wf resume` says so meanwhile instead of telling the agent to ask it.
// 0.7.32 (D78), named failure (classification of 25 field corrections): two corrections moved test code out of the pinned plugin into
// the product tree (a fixture harness the plugin loads), and the correction's identity covered only the plugin file, so later edits
// to that harness were ordinary product commits no review of the correction saw. A step declares the files its plugin loads outside
// the adapter folder in its definition (`reads`: paths or globs relative to the step's repo); a correction pins them: each entry
// must match a file at the correction's tree (refused otherwise), and every file matched is recorded with its blob. A change to one
// asks the reviewer's verdict again (engine/lifecycle.mjs correctionsToJudge). Whether the plugin loads anything it does not declare
// is the reviewer's judgement, from the decoded code; an undeclared load is a blocking finding. Review of 0.7.32 (M1): the first form
// guessed the reads from path-like strings in the plugin, which missed `ctx.dir + '/front/…'`, `path.join(ctx.dir, 'front', …)`,
// template literals, imports without an extension and directories; a guess is no rule, so it is only a hint for the reviewer now
// (`looksLoaded`).
export function declaredReadsAt(state, step, commit) {
  const declared = Array.isArray(step?.definition?.reads) ? step.definition.reads : [];
  if (!declared.length) return null;
  const dir = state.repos[step.definition.repo]?.worktree;
  const tree = dir && commit ? treeEntries(dir, commit) : new Map();
  const files = [];
  const unmatched = [];
  for (const g of declared) {
    let hit = false;
    for (const [f, x] of tree) {
      if (!readMatches(g, f)) continue;
      hit = true;
      if (!files.some((y) => y.path === f)) files.push({ path: f, blob: x.blob });
    }
    if (!hit) unmatched.push(g);
  }
  return { step: step.id, repo: step.definition.repo, declared, files, unmatched };
}

// Whether a declared `reads` entry (a path, a folder or a glob relative to the step's repo) covers a file.
export const readMatches = (g, f) => {
  const s = String(g);
  const dir = s.replace(/\/$/, '');
  return f === s || f.startsWith(`${dir}/`) || globToRegExp(s.replace(/\/$/, '/**')).test(f);
};

// 0.7.33 (I-227). Named cost (review of 0.7.32): the declared reads ran `git rev-parse <commit>:<file>` once per file they matched,
// about a second for 300 files on each correction and each reviewer handoff and a quarter of one on `wf resume`. A tree's files and
// their blobs come from one `git ls-tree -r -z`; a commit's tree never changes, so the last few listings are kept for the process.
const TREES = new Map();
export function treeEntries(dir, commit) {
  // Review of 0.7.33 (L3): only a commit id names one tree for good; anything else (a ref, HEAD) is resolved first.
  const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(commit)) ? String(commit) : git(dir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { allowFail: true });
  if (!sha) return new Map();
  commit = sha;
  const key = `${dir}\0${commit}`;
  const kept = TREES.get(key);
  if (kept) return kept;
  const out = new Map();
  const r = run('git', ['ls-tree', '-r', '-z', '--full-tree', String(commit)], { cwd: dir, allowFail: true });
  if (r.status === 0) {
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, blob] = rec.slice(0, tab).split(' ');
      out.set(rec.slice(tab + 1), { mode, type, blob });
    }
  }
  TREES.set(key, out);
  if (TREES.size > 8) TREES.delete(TREES.keys().next().value);
  return out;
}

// The text of blobs, read in one `git cat-file --batch`; a binary one (a NUL in its first 8000 bytes, as git judges it) is left out.
function blobTexts(dir, blobs) {
  const out = new Map();
  const want = [...new Set(blobs.filter(Boolean))];
  if (!want.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: dir, env: gitEnv(), input: `${want.join('\n')}\n`, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return out;
  const buf = r.stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const [sha, type, size] = buf.subarray(i, nl).toString('utf8').split(' ');
    if (size === undefined) {
      i = nl + 1;
      continue;
    }
    const body = buf.subarray(nl + 1, nl + 1 + Number(size));
    if (type === 'blob' && !body.subarray(0, 8000).includes(0)) out.set(sha, body.toString('utf8'));
    i = nl + 1 + Number(size) + 1;
  }
  return out;
}

// Path-like strings in code: quoted relative specifiers (`'../support/commands.js'`, `'./days'`), quoted or template paths with a
// folder (`${ctx.dir}/front/fixtures`, where `${…}` stands for any one name), and the string parts of `path.join` and `path.resolve`.
function pathHints(text) {
  const out = [];
  const add = (spec) => {
    const s = spec.replace(/\$\{[^}]*\}/g, '*').replace(/\/+/g, '/');
    const relative = /^\.{1,2}\//.test(s);
    if (s && !out.some((x) => x.spec === s)) out.push({ spec: relative ? s : s.replace(/^\//, ''), relative });
  };
  for (const m of text.matchAll(/['"`](\.{1,2}\/[^'"`\s]*)['"`]/g)) add(m[1]);
  for (const m of text.matchAll(/['"`/]((?:\.\.?\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.*[\]{}$-]+)+)/g)) add(m[1]);
  for (const m of text.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)) {
    const parts = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    if (parts.length) add(parts.join('/'));
  }
  return out;
}

// The files of a sorted list a path names: itself, itself with an extension (an import without one), the files under it (a folder),
// or the files a glob matches.
function filesNamed(sorted, set, p) {
  if (/[*?[{]/.test(p)) {
    const re = globToRegExp(p);
    return sorted.filter((f) => re.test(f));
  }
  if (set.has(p)) return [p];
  const under = (prefix) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const hits = [];
    for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i++) hits.push(sorted[i]);
    return hits;
  };
  const withExtension = under(`${p}.`).filter((f) => !f.slice(p.length + 1).includes('/'));
  return withExtension.length ? withExtension : under(`${p}/`);
}

// Paths the decoded plugin, and the files the step declares, look like they load: a hint listed to the reviewer, never a record and
// never enforced. 0.7.33 (I-224, I-227). Named failures (review of 0.7.32): the hint scanned the plugin only, so a declared harness that
// imports `../support/commands.js` named nothing; and its entries were raw strings (`front/fixtures` beside a declared
// `front/fixtures/**`, a package name, the declared files themselves). Each hint is now resolved in the step's repo as the tree is
// (`tree`): a relative one against the folder of the file it is in, another against the repo and the step's package; a hint that names
// no file is dropped, and one is listed only when it names a file the declared `reads` does not cover and that is not in the adapter
// folder (pinned with the adapter itself). Each entry is `{ path, from }`: the repo path, and the file it was found in (`plugin`).
export function looksLoaded(root, state, { commit, tree, definition }) {
  const repo = definition?.repo;
  const wt = repo ? state.repos[repo]?.worktree : null;
  const at = String(tree ?? '').split('+')[0];
  if (!wt || !at) return [];
  const entries = treeEntries(wt, at);
  const sorted = [...entries.keys()].sort();
  const set = new Set(sorted);
  const declared = Array.isArray(definition.reads) ? definition.reads : [];
  const covered = (f) => declared.some((g) => readMatches(g, f));
  let adapterDir = null;
  let pkgPath = '';
  try {
    const loc = attemptAdapter(root, state);
    if (loc.repo.name === repo) adapterDir = (loc.relative || '').split(path.sep).join('/') || null;
    const r = trustedAdapter(root, state, commit).repos.find((x) => x.name === repo);
    const pkg = definition.package ? r?.packages?.find((p) => p.name === definition.package || p.path === definition.package) : r?.packages?.[0];
    pkgPath = pkg?.path && pkg.path !== '.' ? pkg.path : '';
  } catch {}
  const inAdapter = (f) => Boolean(adapterDir) && (f === adapterDir || f.startsWith(`${adapterDir}/`));
  const sources = [];
  if (definition.plugin) {
    try {
      sources.push({ from: 'plugin', dir: adapterDir ? path.posix.dirname(path.posix.join(adapterDir, definition.plugin)) : null, text: decodeEscapes(fs.readFileSync(adapterFileAtCommit(root, state, commit, definition.plugin), 'utf8')) });
    } catch {}
  }
  const own = sorted.filter(covered);
  const texts = blobTexts(wt, own.map((f) => entries.get(f)?.blob));
  for (const f of own) {
    const text = texts.get(entries.get(f)?.blob);
    if (text !== undefined) sources.push({ from: f, dir: path.posix.dirname(f), text: decodeEscapes(text) });
  }
  const out = [];
  for (const s of sources) {
    for (const h of pathHints(s.text)) {
      const bases = h.relative ? (s.dir !== null ? [path.posix.join(s.dir, h.spec)] : []) : [h.spec, ...(pkgPath ? [path.posix.join(pkgPath, h.spec)] : [])];
      for (const b of bases) {
        const p = path.posix.normalize(b).replace(/\/$/, '');
        if (!p || p === '.' || p.startsWith('../') || p === '..' || path.posix.isAbsolute(p)) continue;
        const named = filesNamed(sorted, set, p);
        if (!named.length) continue;
        const outside = named.filter((f) => !covered(f) && !inAdapter(f) && f !== s.from);
        const shown = outside.length === 1 && named.length === 1 ? outside[0] : p;
        if (outside.length && !out.some((x) => x.path === shown)) out.push({ path: shown, from: s.from });
        break;
      }
    }
  }
  return out;
}

// 0.7.33 (I-223): the files the earlier pins of an admission step covered through its declared `reads`: the admission original's
// declaration matched at the attempt's admission base, and the previous correction's pinned files. A correction's own pin is compared
// with both, as the reviewer compares its definition with both.
function earlierReads(state, id, admissionDefinition) {
  const of = (state.validationCorrections ?? []).filter((c) => (c.from ?? []).some((f) => f.admission && f.id === id));
  const original = of.length ? of[0].from.find((f) => f.id === id)?.definition : admissionDefinition;
  const out = [];
  const at = state.repos[original?.repo]?.base;
  const x = original && at ? declaredReadsAt(state, { id, definition: original }, at) : null;
  if (x?.files.length) out.push({ against: 'original', repo: x.repo, declared: x.declared, files: x.files, at });
  const prev = of.at(-1);
  const rec = (prev?.reads ?? []).find((r) => r.step === id);
  if (rec?.files?.length) out.push({ against: 'previous', repo: rec.repo, declared: rec.declared, files: rec.files, at: String(prev.tree?.[rec.repo] ?? prev.commit).split('+')[0] });
  return out;
}

// Each file an earlier pin covered that the corrected pin does not hold, and why: its path is no longer declared, or it is declared
// and no longer in the tree.
const droppedFrom = (earlier, pinned) => earlier.files.filter((f) => !(pinned?.repo === earlier.repo && pinned.files.some((x) => x.path === f.path))).map((f) => ({ path: f.path, blob: f.blob, why: pinned?.repo === earlier.repo && pinned.declared.some((g) => readMatches(g, f.path)) ? 'no longer in the tree' : 'no longer declared' }));

// 0.7.33 (I-226): which admission checks an attempt corrected, and whether it is still open, read from its ledger's own entries without
// folding it. Named failure (review of 0.7.32): the note that another open attempt corrected the same check was computed once, by the
// later attempt, and stored on its correction (`sharedWith`): the earlier attempt never named the later one, and an attempt that had
// closed stayed named. Named cost behind that design (review of 0.7.32, M3): folding every attempt's ledger for every next step took
// about a second with eleven attempts. The index is a small file per attempt in the project's scratch folder, extended from the bytes
// its ledger gained since (a ledger only grows, and the first new entry must continue the indexed chain, else it is read again from the
// start), and only the entries it needs are parsed: `validation.corrected` and the four that close an attempt (an attempt never
// reopens: `wf reopen` admits a new one). It is derived from the ledger and never decides anything: a ledger that cannot be read has
// no index (null), and an index that cannot be written is rebuilt next time.
const CLOSING = new Set(['closed', 'abandoned', 'analysis.closed', 'shipped.closed']);
// The hash of a ledger's last entry, read from its end (growing the read until the line is whole), or null.
function lastHash(file, size) {
  if (!size) return null;
  const fd = fs.openSync(file, 'r');
  try {
    for (let want = Math.min(size, 64 * 1024); ; want = Math.min(size, want * 4)) {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      const text = buf.toString('utf8').replace(/\n$/, '');
      const nl = text.lastIndexOf('\n');
      if (nl >= 0 || want === size) {
        try {
          return JSON.parse(text.slice(nl + 1)).hash ?? null;
        } catch {
          return null;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
const INDEXED = /"type":"(?:validation\.corrected|closed|abandoned|analysis\.closed|shipped\.closed)"/;
export function correctionIndex(root, id) {
  const ledger = path.join(attemptDir(root, id), 'ledger.jsonl');
  let size;
  try {
    size = fs.statSync(ledger).size;
  } catch {
    return null;
  }
  const scratch = path.join(root, '.wf-worktrees');
  const file = path.join(scratch, '_corrections', `${id}.json`);
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (cached?.v !== 1 || !Number.isInteger(cached.offset) || cached.offset > size || !Array.isArray(cached.steps)) cached = null;
  // Review of 0.7.33 (L2): a ledger of the same size is the indexed one only when its last entry is the one indexed.
  if (cached && cached.offset === size) {
    if (lastHash(ledger, size) === cached.last) return cached;
    cached = null;
  }
  const scan = (idx) => {
    const fd = fs.openSync(ledger, 'r');
    try {
      let pos = idx.offset;
      let carry = Buffer.alloc(0);
      let first = idx.offset > 0;
      let lastLine = null;
      while (pos < size) {
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, size - pos));
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (!n) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        // Complete lines only: an entry being appended right now is read next time.
        const end = data.lastIndexOf(0x0a) + 1;
        carry = Buffer.from(data.subarray(end));
        if (!end) continue;
        idx.offset += end;
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          if (!line) continue;
          lastLine = line;
          const head = line.slice(0, 160);
          if (!first && !(head.includes('"type":"') ? INDEXED.test(head) : INDEXED.test(line))) continue;
          const e = JSON.parse(line);
          if (first) {
            if (e.prev !== idx.last) return false;
            first = false;
          }
          if (e.type === 'validation.corrected') for (const f of e.data?.from ?? []) if (f?.admission && !idx.steps.includes(f.id)) idx.steps.push(f.id);
          if (CLOSING.has(e.type)) idx.open = false;
        }
      }
      if (lastLine !== null) idx.last = JSON.parse(lastLine).hash ?? null;
      return true;
    } finally {
      fs.closeSync(fd);
    }
  };
  let idx = cached ? { ...cached, steps: [...cached.steps] } : null;
  try {
    if (!idx || !scan(idx)) {
      idx = { v: 1, offset: 0, last: null, open: true, steps: [] };
      scan(idx);
    }
  } catch {
    return null;
  }
  try {
    const st = fs.lstatSync(scratch, { throwIfNoEntry: false });
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(idx));
      fs.renameSync(tmp, file);
    }
  } catch {}
  return idx;
}

// The other open attempts of the project that corrected the same admission check: one defect frozen into a check shared by every
// ticket is fixed once on the adapter's base branch, which every live attempt follows (D60). Named failure (the same
// classification): seven parallel tickets each corrected one check that asserted a failed request shows the empty state.
export function sharedCorrections(root, state, ids) {
  const out = [];
  for (const id of listAttempts(root)) {
    if (id === state.id) continue;
    const idx = correctionIndex(root, id);
    if (!idx?.open) continue;
    const same = ids.filter((step) => idx.steps.includes(step));
    if (same.length) out.push({ attempt: id, steps: same });
  }
  return out;
}

export const CORRECTION_WITHDRAWN = 'the reviewer judges corrections since 0.7.32: no question to the person; the review that follows the correction gives its verdict on it';
export const correctionQuestionSteps = (d) => (d?.kind === 'override-gate' ? KEY.exec(String(d.key ?? ''))?.[1]?.split(',') ?? null : null);

async function registerValidation(root, options, correcting) {
  const { withReviewLock } = await import('./gate.mjs');
  const { reviewInFlight, openImplementersOf } = await import('./lifecycle.mjs');
  const initial = openState(root, options);
  const verb = correcting ? 'correcting' : 'registering';
  return withReviewLock(root, initial, () => {
    const state = loadState(root, initial.id);
    if (!state.criteria || ['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse('supplemental validation requires an open attempt with frozen criteria');
    if (reviewInFlight(state) || openImplementersOf(root, state).length) throw refuse(`finish and close active roles before ${verb} supplemental validation`);
    if (!options.reason || options.reason === true) throw refuse('supplemental validation needs --reason');
    const ids = typeof options.steps === 'string' ? options.steps.split(',').map((s) => s.trim()) : [];
    const registered = (state.validations ?? []).flatMap((v) => v.steps.map((s) => ({ id: s.id, commit: v.commit, criteria: v.criteria ?? [], secretKeys: s.secretKeys })));
    if (!ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) || new Set(ids).size !== ids.length) throw refuse('--steps must name distinct supplemental step ids');
    // I-125 (0.7.8): an admission step (frozen with the adapter at admission) may be corrected too, as the person's decision:
    // a frozen check that is itself wrong (it read a failed request as empty data) otherwise blocked the full gate for good.
    const base = trustedAdapter(root, state);
    // A step frozen at admission stays one through every correction (independent review of 0.7.8: a second correction was
    // taken for a supplemental one, skipped the person and left the gate refusing for good).
    const admission = correcting ? ids.filter((id) => base.gate.steps.some((s) => s.id === id)) : [];
    const unknown = correcting ? ids.filter((id) => !registered.some((r) => r.id === id) && !admission.includes(id)) : [];
    if (unknown.length) throw refuse(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} neither a registered supplemental validation step nor an admission step (registered: ${registered.map((r) => r.id).join(', ') || 'none'}); a new one is registered with \`wf validation add\``, undefined, { id: 'validation:correct-unregistered' });
    // A correction keeps the criteria its steps were registered for unless it names others; an admission step answers for
    // every frozen criterion.
    const criteria = typeof options.criteria === 'string' ? options.criteria.split(',').map((s) => s.trim()) : correcting ? [...new Set(ids.flatMap((id) => registered.find((r) => r.id === id)?.criteria ?? state.criteria.filter((c) => !c.dropped).map((c) => c.id)))] : [];
    if (!criteria.length || criteria.some((id) => !state.criteria.some((c) => c.id === id)) || new Set(criteria).size !== criteria.length) throw refuse('--criteria must name distinct frozen acceptance criteria');
    const frozen = gateAdapter(root, state);
    if (!correcting && ids.some((id) => frozen.gate.steps.some((s) => s.id === id))) throw refuse('supplemental validation cannot replace an existing step');
    const trees = treeHashes(state);
    if (Object.values(trees).some((t) => t.includes('+dirty'))) throw refuse('commit the product tree and validation adapter before registering validation');
    const adapter = attemptAdapter(root, state);
    const own = state.repos[adapter.repo.name];
    if (!own?.worktree) throw refuse('the admission adapter repo must belong to this attempt', `the project's adapter lives in ${adapter.repo.name}, which this attempt does not hold: \`wf criteria amend --file <amendment> --reason "<why>" --add-repo ${adapter.repo.name} --attempt ${state.id}\` brings its worktree into the attempt (0.7.32, D73); commit the step there, then register it`);
    const commit = git(own.worktree, ['rev-parse', 'HEAD']);
    if (git(own.worktree, ['merge-base', state.adapterBase, commit]) !== state.adapterBase) throw refuse('supplemental adapter must descend from the admission commit');
    const pinOf = (id) => registered.find((r) => r.id === id)?.commit ?? adapterPin(state);
    if (correcting) for (const pin of new Set(ids.map(pinOf))) {
      if (pin === commit) throw refuse(`the adapter repo is still at ${pin.slice(0, 10)}, where ${ids.filter((id) => pinOf(id) === pin).join(', ')} is already pinned: commit the corrected definition or plugin first`, undefined, { id: 'validation:correct-unchanged' });
      if (git(own.worktree, ['merge-base', pin, commit], { allowFail: true }) !== pin) throw refuse(`the corrected definition must descend from the commit it is pinned at (${pin.slice(0, 10)}); a correction moves a pin forward, never sideways or back`, pin === adapterPin(state) && pin !== state.adapterBase ? `this attempt follows its base branch's adapter, now at ${pin.slice(0, 10)}: \`wf base merge\` brings it into the worktree, then commit the correction on top` : undefined, { id: 'validation:correct-not-descendant' });
    }
    const candidate = trustedAdapter(root, state, commit);
    let catalog = [];
    const catalogText = git(own.worktree, ['show', `${commit}:${adapter.relative}/secrets.yaml`], { allowFail: true });
    if (catalogText) { const raw = YAML.parse(catalogText); catalog = raw?.keys ?? raw; if (!Array.isArray(catalog)) throw refuse('committed secret catalog must be a list'); }
    const existing = loadCatalog(root);
    const steps = ids.map((id) => {
      const step = candidate.gate.steps.find((s) => s.id === id);
      // 0.7.32 (D73). Named failure (field): this refusal named no route while the session rules said "never change the workflow
      // from a ticket"; a finding waiting for the proof stayed open 37 minutes, a strategist escalated it, and the person had to
      // answer before the step was registered. The route is this ticket's own: the project's adapter, never the plugin.
      if (!step) throw refuse(`supplemental step ${id} is not committed in the attempt adapter`, `commit its definition (the step under \`gate.steps\` in ${adapter.relative}/${CONFIG_FILE}, and its plugin if it has one) in this attempt's worktree of ${adapter.repo.name} (${own.worktree}), then run \`wf validation add --steps ${ids.join(',')} --criteria <ids> --reason "<why>" --attempt ${state.id}\` again. This is the project's adapter, not the workflow: proof a ticket adds is additive by design, and nothing else in that commit becomes a rule this attempt is judged by (the gate runs only the registered steps from it)`, { id: 'validation:not-committed' });
      const repo = frozen.repos.find((r) => r.name === step.repo);
      if (!repo || !state.repos[step.repo] || (step.package && !repo.packages.some((p) => p.path === step.package || p.name === step.package))) throw refuse(`supplemental step ${id} must use an admitted repo and package`);
      if ((step.alsoInputs ?? []).some((r) => !state.repos[r] || !frozen.repos.some((x) => x.name === r))) throw refuse(`supplemental step ${id} reads a repo outside the attempt`);
      if (step.plugin) fs.readFileSync(adapterFileAtCommit(root, state, commit, step.plugin));
      const secretKeys = catalog.filter((e) => e.usedBy?.includes(id)).map((e) => e.key);
      if (secretKeys.some((key) => !existing.some((e) => e.key === key))) throw refuse('supplemental steps may bind only existing catalogued keys');
      return { id, definition: step, secretKeys };
    });
    if (correcting) {
      // 0.7.32 (D78), the person's words: "why should it come to me? we have an agent designed just for that in the workflow right?"
      // Named failure (field): correcting a check frozen at admission was the person's decision (I-125, D37), asked 20 times on 10
      // attempts in four days (7 on one ticket), while a fresh independent review and the full gate followed anyway. That review
      // now judges the correction: it is handed both definitions (`admissionCorrections` in its bundle) and gives its verdict on
      // each, a weakening is a blocking finding the ticket fixes (or the person waives), and no verdict means no acceptance. The
      // original stays in the record, both pins are recorded, and the pin moves forward only (D11b). An answer the person already
      // gave to this exact correction stands as recorded: a yes is the record's approval, another answer is followed.
      let decision = null;
      if (admission.length) {
        // With no person to screen it, a correction that changes nothing in the step's definition or plugin is refused.
        const same = admission.filter((id) => { const pin = pinOf(id); const before = state.validations.flatMap((v) => v.steps).find((x) => x.id === id)?.definition ?? base.gate.steps.find((x) => x.id === id); const now = steps.find((x) => x.id === id); const a = correctionIdentity(root, state, pin, { id, definition: before }); return Boolean(a) && a === correctionIdentity(root, state, commit, now); });
        if (same.length) throw refuse(`${same.join(', ')} ${same.length > 1 ? 'are' : 'is'} defined at ${commit.slice(0, 10)} exactly as pinned (the step and its plugin): there is nothing to correct`, 'commit the corrected definition or plugin first', { id: 'validation:correct-unchanged' });
        const wantAdmission = admissionIdentities(root, state, commit, steps, admission);
        const key = correctionKey(admission, admissionIdentity(wantAdmission), commit);
        const own = decisionFor(state, 'override-gate', key) ?? (key.includes(':identity-') ? askedUnderCommit(root, state, admission, wantAdmission) : null);
        if (own?.approved && !own.spent) decision = standingAnswer(state, own);
        // A question an earlier release opened about these steps, not answered, is withdrawn with the reason.
        for (const d of state.decisions ?? []) {
          const of = correctionQuestionSteps(d);
          if (of && !d.approved && !d.withdrawn && of.some((id) => admission.includes(id))) append(root, state.id, 'decision.withdrawn', { id: d.id, reason: CORRECTION_WITHDRAWN }, actor(options));
        }
      }
      // Both pins stay in the ledger: what the step was, and what it is now.
      const current = (id) => state.validations.flatMap((v) => v.steps).find((s) => s.id === id)?.definition;
      const from = ids.map((id) => (admission.includes(id) ? { id, commit: pinOf(id), definition: current(id) ?? base.gate.steps.find((s) => s.id === id), admission: true } : { id, commit: pinOf(id), definition: current(id) }));
      const treeOf = (repo) => trees[repo]?.split('+')[0] ?? commit;
      const pins = admission.map((id) => { const now = steps.find((x) => x.id === id); return { id, pinned: declaredReadsAt(state, now, treeOf(now.definition.repo)) }; });
      const reads = pins.map((x) => x.pinned).filter(Boolean);
      const missing = reads.filter((x) => x.unmatched.length);
      if (missing.length) throw refuse(`${missing.map((x) => `${x.step} declares \`reads\` ${x.unmatched.map((g) => `\`${g}\``).join(', ')}, which ${x.unmatched.length > 1 ? 'match' : 'matches'} no file in ${x.repo}`).join('; ')}`, 'a step\'s `reads` lists the files its plugin loads outside the adapter folder (paths or globs relative to the step\'s repo), as committed: fix the path, or commit the file', { id: 'validation:reads-unmatched' });
      // 0.7.33 (I-223). Named failure (review of 0.7.32): a correction that dropped the step's `reads`, or narrowed a glob, was accepted
      // and pinned nothing, and the reviewer, told that paths are plumbing, saw only two definitions that differ in one line. A file an
      // earlier pin covered (the admission original's declaration, the previous correction's pin) that the corrected pin no longer holds
      // is a fact, recorded with the correction (`readsDropped`) and handed to the reviewer as a coverage loss to judge. It is not
      // refused: the correction's verdict is owed before acceptance anyway, and a refusal would also stop a harness inlined back into
      // the plugin or renamed, whose only way on would then be a new override.
      const readsDropped = pins.flatMap(({ id, pinned }) => earlierReads(state, id, from.find((f) => f.id === id)?.definition).map((earlier) => ({ step: id, repo: earlier.repo, against: earlier.against, at: earlier.at, files: droppedFrom(earlier, pinned) })).filter((x) => x.files.length));
      const shared = admission.length ? sharedCorrections(root, state, admission) : [];
      append(root, state.id, 'validation.corrected', { commit, steps, criteria, reason: String(options.reason), tree: trees, from, ...(decision ? { decision } : {}), ...(admission.length ? { judgedBy: 'reviewer', ...(reads.length ? { reads: reads.map(({ unmatched, ...x }) => x) } : {}), ...(readsDropped.length ? { readsDropped } : {}), ...(shared.length ? { sharedWith: shared } : {}) } : {}) }, actor(options));
    } else append(root, state.id, 'validation.added', { commit, steps, criteria, reason: String(options.reason), tree: trees }, actor(options));
    return loadState(root, state.id);
  });
}
