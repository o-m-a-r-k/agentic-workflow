// The flow (design section 2, D91, D93): criteria, the review bundle, recording a review, the no-progress stop, the merge
// facts, and the commands that drive them. Stream 1.
//
// The engine checks facts only: hashes, git, the ledger and the host's transcripts. What a finding or an edit means is the
// reviewer's and the person's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_KINDS, WfError, append, ask, attemptDir, attemptState, canonicalJson, filesRead, launchReviewer, listAttempts,
  loadAdapter, readEvents, refusal, runTests, userDir,
} from './contract.mjs';
import { baseOf, baseRef, changedOf, dirtyRepos, foreignMerges, headsOfTree, mergeBaseOf, rootPath, specOf, unreviewedCommits } from './base.mjs';
import { assertFindings, blockersOf, fileOther, foldFindings, nextFindingNumber, refuseOtherOwn } from './findings.mjs';
import { decisionsOf, flagText, holdOf, itemHistory, projectRoot, resolveAttempt, schema2, sessionFlag } from './attempt.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { YAML, git, matchesAny, run, sha256 } from './util.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Above about 1,500 product lines one reviewer reads shallowly (design section 2): the review splits by area.
export const SPLIT_LINES = 1500;
export const MAX_CRITERIA = 6;

export const CHOICES = {
  waiver: { yes: 'waive', no: 'keep blocking' },
  loosen: { yes: 'accept the edit', no: 'keep the criteria' },
  foreign: { yes: 'allow the merge', no: 'remove the merge' },
  diffRead: { yes: 'approve', no: 'changes needed' },
  noProgress: { yes: 'continue', no: 'stop' },
};

// --- reading one attempt -----------------------------------------------------------------------------------------------

async function load(root, attempt) {
  const state = await attemptState(root, attempt);
  const adapter = await loadAdapter(root);
  const history = await itemHistory(root, state.item);
  const events = history.find((h) => h.id === attempt)?.events ?? [];
  const decisions = await decisionsOf(root, history);
  const waived = new Set(decisions.filter((d) => d.kind === 'waiver' && d.answer?.choice === CHOICES.waiver.yes).flatMap((d) => d.refs));
  return { root, attempt, state, adapter, history, events, decisions, ...foldFindings(history, waived) };
}

const criteriaOf = (events) => [...events].reverse().find((e) => e.type === 'criteria.set')?.data ?? null;
const reviewsOf = (events) => events.filter((e) => e.type === 'review.recorded').map((e) => e.data);
const allEvents = (history) => history.flatMap((h) => h.events.map((e) => ({ ...e, attempt: h.id })));
const reviewerLaunches = (history) => allEvents(history).filter((e) => e.type === 'handoff' && e.data.role === 'reviewer' && e.data.launchedBy === 'wf').map((e) => ({ ...e.data, attempt: e.attempt }));
// test.run records each repo's git tree (stream 2); screens may record either that or the attempt's tree.
const repoTree = (state, repo) => git(state.repos[repo].worktree, ['rev-parse', 'HEAD^{tree}']);
const headTime = (state, repo) => git(state.repos[repo].worktree, ['log', '-1', '--format=%cI', 'HEAD']);
const sameSession = (a, b) => Boolean(a && b) && a.id === b.id && (a.runtime ?? null) === (b.runtime ?? null);

// The review round of a tree, counted per item across attempts: the round already given to this tree, else the next.
function roundOf(history, tree) {
  let max = 0;
  for (const e of allEvents(history)) {
    const r = e.type === 'review.recorded' ? e.data.round : e.type === 'handoff' && e.data.role === 'reviewer' ? e.data.round : null;
    if (typeof r !== 'number') continue;
    if (e.data.tree === tree) return r;
    max = Math.max(max, r);
  }
  return max + 1;
}

function riskOf(adapter, files) {
  const spec = (name) => adapter.repos.find((r) => r.name === name);
  const paths = adapter.risk?.paths ?? [];
  const touched = paths.filter((p) => files.some((f) => matchesAny(rootPath(spec(f.repo), f.path), p.paths ?? [])));
  const tests = files.filter((f) => f.status !== 'D' && touched.some((p) => matchesAny(rootPath(spec(f.repo), f.path), p.tests ?? [])));
  return { touched, tests };
}

// --- criteria ----------------------------------------------------------------------------------------------------------

const citedBy = (f, ids) => {
  const named = [...`${f.what} ${f.why}`.matchAll(/\bC(\d+)\b/g)].map((m) => `C${m[1]}`).filter((id) => ids.includes(id));
  // A blocker that names no criterion stands against the whole change.
  return named.length ? named : ids;
};

async function setCriteria(root, attempt, input, { actor = null } = {}) {
  const list = input?.criteria;
  if (!Array.isArray(list) || !list.length) throw new WfError('criteria: give 1 to 6 criteria that a user or a test can check');
  if (list.length > MAX_CRITERIA) throw refusal('criteria:max', `${list.length} criteria; at most ${MAX_CRITERIA}`, 'propose a split of the item into smaller ones, each with its own criteria');
  const L = await load(root, attempt);
  if (!L.state.open) throw new WfError(`${attempt} is closed`);
  const prev = criteriaOf(L.events);
  const prevList = prev?.criteria ?? [];
  const everUsed = L.events.filter((e) => e.type === 'criteria.set').flatMap((e) => e.data.criteria.map((c) => c.id));
  let next = Math.max(0, ...everUsed.map((id) => Number(/^C(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
  const seen = new Set();
  const criteria = list.map((c, i) => {
    const text = typeof c === 'string' ? c : c?.text;
    if (typeof text !== 'string' || !text.trim()) throw new WfError(`criterion ${i + 1} has no text`);
    let id = typeof c === 'object' && c.id ? String(c.id) : prevList.find((p) => p.text === text.trim() && !seen.has(p.id))?.id;
    if (id && !/^C\d+$/.test(id)) throw new WfError(`criterion id \`${id}\` is not C<n>`);
    if (id && !prevList.some((p) => p.id === id)) throw new WfError(`criterion ${id} does not exist; give new criteria without an id`);
    id ??= `C${next++}`;
    if (seen.has(id)) throw new WfError(`criterion ${id} is given twice`);
    seen.add(id);
    return { id, text: text.trim() };
  });
  const areas = (input.areas ?? []).map(String);
  const hash = sha256(canonicalJson(criteria));
  if (prev && prev.hash === hash && canonicalJson(prev.areas) === canonicalJson(areas)) return { hash, loosened: [], decision: null, unchanged: true, criteria };
  const diff = {
    added: criteria.filter((c) => !prevList.some((p) => p.id === c.id)).map((c) => c.id),
    changed: criteria.filter((c) => prevList.some((p) => p.id === c.id && p.text !== c.text)).map((c) => ({ id: c.id, from: prevList.find((p) => p.id === c.id).text, to: c.text })),
    dropped: prevList.filter((p) => !criteria.some((c) => c.id === p.id)).map((p) => ({ id: p.id, text: p.text })),
  };
  const blockers = blockersOf(L.findings);
  const prevIds = prevList.map((p) => p.id);
  const cited = new Set(blockers.flatMap((f) => citedBy(f, prevIds)));
  // Putting back a text an earlier loosening edit replaced restores the criterion; it loosens nothing.
  const replaced = L.events.filter((e) => e.type === 'criteria.set' && e.data.loosened?.length).flatMap((e) => [...(e.data.diff?.changed ?? []).map((c) => ({ id: c.id, text: c.from })), ...(e.data.diff?.dropped ?? [])]);
  const restores = (c) => replaced.some((r) => r.id === c.id && r.text === c.to);
  const loosened = [...diff.changed.filter((c) => !restores(c)).map((c) => c.id), ...diff.dropped.map((d) => d.id)].filter((id) => cited.has(id));
  await append(root, attempt, 'criteria.set', { criteria, areas, hash, previous: prev?.hash ?? null, ...(loosened.length ? { loosened } : {}), ...(prev ? { diff } : {}) }, actor);
  let decision = null;
  if (loosened.length) {
    const what = loosened.map((id) => {
      const ch = diff.changed.find((c) => c.id === id);
      return ch ? `${id} "${ch.from}" -> "${ch.to}"` : `${id} "${diff.dropped.find((d) => d.id === id).text}" dropped`;
    });
    const q = await ask(root, attempt, {
      kind: 'loosen',
      question: `While blocker(s) ${blockers.map((f) => f.id).join(', ')} are open, the criteria edit changes ${what.join('; ')}. Accept the edit?`,
      options: [CHOICES.loosen.yes, CHOICES.loosen.no],
      refs: [...loosened, `criteria:${hash.slice(0, 12)}`],
      blocking: true,
    });
    decision = q.id;
  }
  return { hash, loosened, decision, criteria };
}

// --- bundle ------------------------------------------------------------------------------------------------------------

const roleText = () => {
  try {
    return fs.readFileSync(path.join(PLUGIN, 'templates', 'agents', 'reviewer.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch {
    return 'You did not write this change. Read every product file in the diff. Do not fix.';
  }
};

// Consumers of changed contracts: for each component whose `dependsOn` contract globs match a changed file, the files of
// its repo that name the changed file's stem (`items` for `items.controller.ts`), by path or as a word in the text.
function consumersOf(root, state, adapter, files) {
  const out = new Set();
  for (const c of adapter.components ?? []) {
    const hit = files.filter((f) => (c.dependsOn ?? []).some((d) => matchesAny(rootPath(specOf(adapter, f.repo, state.repos[f.repo]), f.path), [d.contract])));
    if (!hit.length) continue;
    const spec = specOf(adapter, c.repo, state.repos[c.repo]);
    const cwd = state.repos[c.repo]?.worktree ?? path.join(root, spec.path);
    if (!fs.existsSync(cwd)) continue;
    const stems = [...new Set(hit.map((f) => path.basename(f.path).split('.')[0]).filter((s) => s.length >= 3))];
    if (!stems.length) continue;
    const byText = git(cwd, ['grep', '-l', '-w', ...stems.flatMap((s) => ['-e', s])], { allowFail: true }).split('\n').filter(Boolean);
    const byPath = git(cwd, ['ls-files'], { allowFail: true }).split('\n').filter((f) => stems.some((s) => path.basename(f).split('.')[0] === s));
    for (const f of [...byText, ...byPath]) if (!files.some((x) => x.repo === c.repo && x.path === f)) out.add(path.join(cwd, f));
  }
  return [...out].sort();
}

// A project document as the base holds it, never as the attempt's worktree does: a ticket cannot loosen the rules or the
// invariants it is judged by. A path inside a repo is read at the attempt's base commit (or the fetched base of a repo the
// attempt does not hold) and copied into the bundle folder; a path outside every repo is read from the project root.
function fromBase(root, state, adapter, rel, dir) {
  const spec = [...adapter.repos].sort((a, b) => b.path.length - a.path.length).find((r) => r.path === '.' || rel === r.path || rel.startsWith(`${r.path.replace(/\/+$/, '')}/`));
  if (!spec) {
    const f = path.resolve(root, rel);
    return fs.existsSync(f) ? f : null;
  }
  const inRepo = spec.path === '.' ? rel : rel.slice(spec.path.replace(/\/+$/, '').length + 1);
  const cwd = state.repos[spec.name]?.worktree ?? path.join(root, spec.path);
  if (!fs.existsSync(cwd)) return null;
  const commit = state.repos[spec.name]?.baseSha ?? baseRef(cwd, spec);
  if (!commit) return null;
  const r = run('git', ['show', `${commit}:${inRepo}`], { cwd, allowFail: true });
  if (r.status !== 0) return null;
  const out = path.join(dir, 'base', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.stdout);
  return out;
}

function rulesFor(root, adapter, state, files, dir) {
  const roots = files.map((f) => rootPath(specOf(adapter, f.repo, state.repos[f.repo]), f.path));
  return [...new Set((adapter.rules ?? []).filter((r) => roots.some((f) => matchesAny(f, r.paths ?? []))).flatMap((r) => r.read ?? []))].map((f) => fromBase(root, state, adapter, f, dir)).filter(Boolean);
}

// Areas for a split: product files grouped by repo and leading folders, a group above the limit split one folder deeper,
// then packed in order into bundles of at most SPLIT_LINES lines (a single file above it stays alone).
export function splitAreas(files, limit = SPLIT_LINES) {
  const lines = (fs_) => fs_.reduce((n, f) => n + f.added + f.removed, 0);
  const group = (list, depth) => {
    const m = new Map();
    for (const f of list) {
      const dirs = path.dirname(f.path).split('/').filter((d) => d && d !== '.');
      const key = [f.repo, ...dirs.slice(0, depth)].join('/');
      m.set(key, [...(m.get(key) ?? []), f]);
    }
    return [...m.entries()].flatMap(([key, fs_]) => {
      const deeper = fs_.some((f) => path.dirname(f.path).split('/').filter((d) => d && d !== '.').length > depth);
      return lines(fs_) > limit && deeper ? group(fs_, depth + 1) : fs_.length > 1 && lines(fs_) > limit ? fs_.map((f) => ({ key: `${f.repo}/${f.path}`, files: [f] })) : [{ key, files: fs_ }];
    });
  };
  const groups = group([...files].sort((a, b) => `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`)), 1);
  const out = [];
  for (const g of groups) {
    const cur = out[out.length - 1];
    if (cur && lines(cur.files) + lines(g.files) <= limit) {
      cur.files.push(...g.files);
      cur.keys.push(g.key);
    } else out.push({ keys: [g.key], files: [...g.files] });
  }
  return out.map((a) => ({ name: a.keys.length > 1 ? `${a.keys[0]}+${a.keys.length - 1}` : a.keys[0], files: a.files }));
}

// Applied project proposals (stream 5) change only what roles read: this file goes into every role's prompt.
export const learnedFile = (adapter) => {
  const f = path.join(userDir(), 'learned', `${adapter.name}.md`);
  return fs.existsSync(f) ? f : null;
};

const seatFile = (seat) => seat.replace(/[^A-Za-z0-9._-]+/g, '_');
const reviewsDir = (root, attempt, round, tree) => path.join(attemptDir(root, attempt), 'reviews', `r${round}-${tree}`);

function writeDiff(file, state, adapter, files) {
  const parts = [];
  for (const name of [...new Set(files.map((f) => f.repo))]) {
    const wt = state.repos[name].worktree;
    const paths = files.filter((f) => f.repo === name).map((f) => f.path);
    parts.push(`### repo ${name} (${wt})\n${git(wt, ['diff', '--no-color', '--no-ext-diff', mergeBaseOf(state, adapter, name), 'HEAD', '--', ...paths])}\n`);
  }
  fs.writeFileSync(file, parts.join('\n'));
  return file;
}

// The criteria as they stood at this attempt's last recorded review, and the diff to now (null when unchanged or none).
function criteriaDiffSinceReview(events) {
  let reviewed = null;
  let current = null;
  for (const e of events) {
    if (e.type === 'criteria.set') current = e.data;
    if (e.type === 'review.recorded') reviewed = current;
  }
  if (!reviewed || !current || reviewed.hash === current.hash) return null;
  const lines = [];
  for (const c of current.criteria) {
    const was = reviewed.criteria.find((p) => p.id === c.id);
    if (!was) lines.push(`+ ${c.id}: ${c.text}`);
    else if (was.text !== c.text) lines.push(`~ ${c.id}: "${was.text}" -> "${c.text}"`);
  }
  for (const p of reviewed.criteria) if (!current.criteria.some((c) => c.id === p.id)) lines.push(`- ${p.id}: ${p.text}`);
  return lines.join('\n');
}

async function bundle(root, attempt) {
  const L = await load(root, attempt);
  const { state, adapter } = L;
  const dirty = dirtyRepos(state);
  if (Object.keys(dirty).length) throw new WfError(`uncommitted changes in ${Object.keys(dirty).join(', ')}: a review reads commits only`, { hint: 'the implementer commits them, then `wf review`' });
  const crit = criteriaOf(L.events);
  if (!crit) throw new WfError(`${attempt} has no criteria`, { hint: `\`wf criteria --file <f> --attempt ${attempt}\`` });
  const { tree, files } = changedOf(root, attempt, state, adapter);
  const product = files.filter((f) => f.kind === 'product');
  const tests = files.filter((f) => f.kind === 'tests');
  if (!product.length && !tests.length) throw new WfError(`${attempt} has no committed change to review`);
  const productLines = product.reduce((n, f) => n + f.added + f.removed, 0);
  const risk = riskOf(adapter, files);
  if (risk.touched.length && productLines > SPLIT_LINES) {
    throw refusal('review:size', `${productLines} product lines touch risk path(s) ${risk.touched.map((r) => r.id).join(', ')}; a risk change above ${SPLIT_LINES} lines is reviewed whole, so it must be split`, 'split the item: deliver the risk part as its own smaller change');
  }
  const round = roundOf(L.history, tree);
  const dir = reviewsDir(root, attempt, round, tree);
  mkdirStateDirectory(dir, { recursive: true });

  const criteriaFile = path.join(dir, 'criteria.md');
  fs.writeFileSync(criteriaFile, `${crit.criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n')}\n${crit.areas?.length ? `\nTouched areas: ${crit.areas.join(', ')}\n` : ''}`);
  const cdiff = criteriaDiffSinceReview(L.events);
  const criteriaDiff = cdiff ? path.join(dir, 'criteria-diff.md') : null;
  if (cdiff) fs.writeFileSync(criteriaDiff, `${cdiff}\n`);
  const invariants = adapter.invariants ? fromBase(root, state, adapter, adapter.invariants, dir) : null;
  const rules = rulesFor(root, adapter, state, files, dir);
  const consumers = consumersOf(root, state, adapter, files);
  const screenTrees = [tree, ...Object.keys(state.repos).map((r) => repoTree(state, r))];
  const screens = [...L.events].reverse().find((e) => e.type === 'screens.captured' && !(e.data.refused ?? []).length && screenTrees.includes(e.data.tree))?.data.images.map((i) => i.file) ?? [];
  const learned = learnedFile(adapter);
  const riskChecklist = risk.touched.length ? path.join(PLUGIN, 'templates', 'risk-checklist.md') : null;
  const blockers = blockersOf(L.findings);
  const fixed = Object.values(L.findings).filter((f) => f.status === 'fixed' && f.class !== 'other');
  const changes = Object.values(L.findings).filter((f) => f.changes.length);

  const seats = [];
  if (productLines > SPLIT_LINES) {
    const areas = splitAreas(product);
    for (const a of areas) seats.push({ seat: `area:${a.name}`, files: a.files, shared: product.filter((f) => !a.files.includes(f)) });
  } else {
    seats.push({ seat: 'whole', files: product, shared: [] });
    if (risk.touched.length) seats.push({ seat: 'second', files: product, shared: [] });
  }

  const bundles = seats.map((s) => {
    const name = seatFile(s.seat);
    const diff = writeDiff(path.join(dir, `diff-${name}.patch`), state, adapter, [...s.files, ...tests]);
    const output = path.join(dir, `review-${name}.json`);
    const sharedFiles = s.shared.map((f) => path.join(state.repos[f.repo].worktree, f.path));
    const productFiles = s.files.filter((f) => f.status !== 'D').map((f) => `${f.repo}/${f.path}`);
    const files_ = { diff, criteria: criteriaFile, criteriaDiff, invariants, rules, consumers, screens, riskChecklist, sharedFiles };
    const list = (title, xs) => (xs.length ? `${title}:\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
    const prompt = [
      roleText(),
      '',
      `Change: ${attempt}, review round ${round}, seat ${s.seat}, tree ${tree}.`,
      `Diff: ${diff}`,
      learned ? `What this project learned (read it): ${learned}` : null,
      `Criteria: ${criteriaFile}`,
      criteriaDiff ? `Criteria changed since the last review: ${criteriaDiff}` : null,
      invariants ? `Invariants: ${invariants}` : null,
      list('Project rules for the touched paths', rules),
      list('Consumers of changed contracts (check each still works)', consumers),
      screens.length ? list('Screenshots (open every one)', screens) : 'Screenshots: none were captured for this tree.',
      riskChecklist ? `Risk checklist (risk paths ${risk.touched.map((r) => r.id).join(', ')}): ${riskChecklist}` : null,
      list('Product files you must read in full (your reads are checked)', productFiles.map((f) => path.join(state.repos[f.split('/')[0]].worktree, f.slice(f.indexOf('/') + 1)))),
      list('Other changed files, reviewed by other seats', sharedFiles),
      blockers.length ? list('Verify these open findings first (status fixed or open), then re-read the whole change', blockers.map((f) => `${f.id} ${f.class} ${f.severity} ${f.location}: ${f.what}`)) : null,
      fixed.length ? list('Earlier findings marked fixed (mark one `open` in verified if it is back)', fixed.map((f) => `${f.id} ${f.location}: ${f.what}`)) : null,
      changes.length ? list('Findings whose class or severity changed', changes.map((f) => `${f.id}: ${f.changes.map((c) => `${c.field} ${c.from} -> ${c.to}`).join(', ')}`)) : null,
      `Write your review as JSON to ${output}: {"findings": [...], "verified": [{"id": "F1", "status": "fixed"}]}.`,
    ].filter((x) => x !== null && x !== '').join('\n');
    const b = {
      seat: s.seat, attempt, tree, round, prompt, files: files_, verify: blockers.map((f) => f.id), productFiles,
      productLines: s.files.reduce((n, f) => n + f.added + f.removed, 0),
      model: (s.seat === 'second' ? adapter.models?.secondReviewer : adapter.models?.reviewer) ?? null,
      output,
    };
    fs.writeFileSync(path.join(dir, `prompt-${name}.md`), `${prompt}\n`);
    fs.writeFileSync(path.join(dir, `bundle-${name}.json`), JSON.stringify(b, null, 2));
    return b;
  });
  return { tree, bundles };
}

function savedBundle(root, attempt, tree, seat) {
  const base = path.join(attemptDir(root, attempt), 'reviews');
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base).filter((x) => x.endsWith(`-${tree}`))) {
    const f = path.join(base, d, `bundle-${seatFile(seat)}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return null;
}

// --- recording a review ------------------------------------------------------------------------------------------------

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

async function recordReview(root, attempt, input) {
  const L = await load(root, attempt);
  const { state, adapter } = L;
  if (!state.open) throw new WfError(`${attempt} is closed`);
  const seat = input?.seat ?? 'whole';
  const session = input?.session;
  if (!session?.id) throw new WfError('the review names no reviewer session');
  const { tree, files } = changedOf(root, attempt, state, adapter);
  if (input.tree !== tree) throw refusal('review:tree', `the review is of tree ${input.tree}, but HEAD is tree ${tree}`, '`wf review` launches fresh reviewers on HEAD');

  const launched = reviewerLaunches(L.history).filter((h) => sameSession(h.session, session));
  if (!launched.length) throw refusal('review:independent', `session ${session.runtime}:${session.id} was not launched by wf as a reviewer of ${state.item}`, '`wf review` launches reviewers; record their output');
  const implemented = allEvents(L.history).filter((e) => e.type === 'handoff' && e.data.role !== 'reviewer' && sameSession(e.data.session, session));
  if (implemented.length || sameSession(state.owner, session)) throw refusal('review:independent', `session ${session.id} also worked on ${state.item} (${implemented.length ? implemented.map((e) => e.data.role).join(', ') : 'owner'})`, '`wf review` launches a fresh reviewer');

  const saved = savedBundle(root, attempt, tree, seat);
  const required = saved?.productFiles ?? files.filter((f) => f.kind === 'product' && f.status !== 'D').map((f) => `${f.repo}/${f.path}`);
  const abs = (f) => path.join(state.repos[f.split('/')[0]].worktree, f.slice(f.indexOf('/') + 1));
  const read = await filesRead(session);
  let coverage = 'unverified';
  let unread = [];
  if (Array.isArray(read)) {
    const seen = new Set(read.map(real));
    unread = required.filter((f) => !seen.has(real(abs(f))));
    if (unread.length) throw refusal('review:coverage', `the reviewer's transcript shows ${unread.length} of ${required.length} product file(s) unread: ${unread.join(', ')}`, 'have the reviewer read every listed product file, then record the review again');
    coverage = 'complete';
  }

  const repos = Object.keys(state.repos);
  assertFindings(input.findings, repos);
  await refuseOtherOwn(root, attempt, input.findings);
  const verified = input.verified ?? [];
  if (!Array.isArray(verified)) throw new WfError('`verified` must be a list of { id, status }');
  for (const v of verified) {
    if (!L.findings[v?.id]) throw new WfError(`verified: no finding ${v?.id} in ${state.item}`);
    if (!['fixed', 'open'].includes(v.status)) throw new WfError(`verified ${v.id}: status \`${v.status}\` is not fixed or open`);
  }
  let n = nextFindingNumber(L.findings);
  const findings = input.findings.map((f) => ({ id: `F${n++}`, location: f.location, what: f.what, why: f.why, severity: f.severity, class: f.class }));
  const round = roundOf(L.history, tree);
  const review = reviewsOf(L.events).length + 1;
  const data = { review, round, seat, tree, session, coverage, findings, verified, blockers: 0, ...(saved?.model ?? launched[0].model ? { model: saved?.model ?? launched[0].model } : {}), ...(Array.isArray(read) ? { filesRead: read.length } : {}), ...(unread.length ? { unread } : {}) };
  const after = foldFindings([...L.history.filter((h) => h.id !== attempt), { id: attempt, events: [...L.events, { type: 'review.recorded', data, at: new Date().toISOString() }] }]);
  const waivedIds = new Set(Object.values(L.findings).filter((f) => f.status === 'waived').map((f) => f.id));
  data.blockers = blockersOf(after.findings).filter((f) => !waivedIds.has(f.id)).length;
  await append(root, attempt, 'review.recorded', data, session);

  const pending = [];
  for (const f of findings.filter((x) => x.class === 'other')) {
    const { data: filed, pending: op } = await fileOther(root, attempt, f, adapter);
    await append(root, attempt, 'finding.filed', filed, null);
    if (op) pending.push({ finding: f.id, operation: op });
  }
  const np = await noProgress(root, state.item);
  if (np.stop && !np.decision) await askNoProgress(root, attempt, np);
  return { review, findings, blockers: data.blockers, coverage, pending };
}

// --- no progress -------------------------------------------------------------------------------------------------------

async function noProgress(root, item) {
  const history = await itemHistory(root, item);
  const decisions = await decisionsOf(root, history, { kinds: ['no-progress', 'waiver'] });
  const waived = new Set(decisions.filter((d) => d.kind === 'waiver' && d.answer?.choice === CHOICES.waiver.yes).flatMap((d) => d.refs));
  const { findings, rounds } = foldFindings(history, waived);
  const last = rounds[rounds.length - 1];
  const prev = rounds[rounds.length - 2];
  if (!last) return { stop: false, reason: null, findings: [], decision: null, round: null, answer: null };
  let reason = null;
  let ids = [];
  if (last.reopened.length) {
    reason = `review round ${last.round} reopened finding(s) ${last.reopened.join(', ')} after a fix`;
    ids = last.reopened;
  } else if (prev && last.blockers > 0 && last.blockers >= prev.blockers) {
    reason = `review round ${last.round} left ${last.blockers} open blocker(s), no fewer than the ${prev.blockers} after round ${prev.round}`;
    ids = blockersOf(findings).map((f) => f.id);
  }
  const d = decisions.filter((x) => x.kind === 'no-progress' && x.refs.includes(`round:${last.round}`)).pop();
  return { stop: Boolean(reason), reason, findings: ids, decision: d?.id ?? null, round: last.round, answer: d?.answer ?? null, attempt: d?.attempt ?? null };
}

function askNoProgress(root, attempt, np) {
  return ask(root, attempt, {
    kind: 'no-progress',
    question: `The fix rounds stopped making progress: ${np.reason}. Continue with another fix round, or stop?`,
    options: [CHOICES.noProgress.yes, CHOICES.noProgress.no],
    refs: [`round:${np.round}`, ...np.findings],
    blocking: true,
  });
}

// --- merge facts -------------------------------------------------------------------------------------------------------

function riskMissing(L, tree, files, reviewedTree) {
  const risk = riskOf(L.adapter, files);
  if (!risk.touched.length) return { touched: [], missing: [] };
  const missing = [];
  if (!risk.tests.length) missing.push({ what: `a test added or changed under the risk tests of ${risk.touched.map((r) => r.id).join(', ')}`, command: 'handoff' });
  for (const repo of [...new Set(risk.tests.map((f) => f.repo))]) {
    // A risk-base run records the merge-base tree it ran on, so it counts when it ran after the repo's last commit.
    const since = Date.parse(headTime(L.state, repo));
    const runs = L.events.filter((e) => e.type === 'test.run' && e.data.kind === 'risk-base' && e.data.repo === repo && Date.parse(e.at) >= since);
    const last = runs[runs.length - 1]?.data;
    if (!last) missing.push({ what: `the risk tests of ${repo} run on the merge-base`, command: `wf test risk-base --repo ${repo}` });
    else if (last.pass) missing.push({ what: `risk tests of ${repo} that fail on the merge-base (they passed there, so they assert nothing about the change)`, command: 'handoff' });
  }
  if (!reviewsOf(L.events).some((r) => r.tree === reviewedTree && r.seat === 'second')) missing.push({ what: 'the second whole-diff review', command: 'review' });
  return { touched: risk.touched, missing };
}

const restored = (events, d) => {
  const after = events.filter((e) => e.type === 'criteria.set' && e.at > (d.answer?.at ?? d.askedAt)).pop()?.data;
  const set = [...events].reverse().find((e) => e.type === 'criteria.set' && (e.data.loosened ?? []).some((id) => d.refs.includes(id)))?.data;
  if (!after || !set?.diff) return false;
  return d.refs.filter((id) => /^C\d+$/.test(id)).every((id) => {
    const was = set.diff.changed.find((c) => c.id === id)?.from ?? set.diff.dropped.find((x) => x.id === id)?.text;
    return after.criteria.some((c) => c.id === id && c.text === was);
  });
};

// A question already answered is never asked again (stream 4 deduplicates only open ones): the answered decision for the
// same kind and refs stands. Returns the decision with its answer, or the open one just asked.
async function askOnce(L, q) {
  const same = L.decisions.find((d) => d.attempt === L.attempt && d.kind === q.kind && canonicalJson(d.refs) === canonicalJson(q.refs) && d.answer);
  if (same) return same;
  const { id } = await ask(L.root, L.attempt, q);
  return L.decisions.find((d) => d.attempt === L.attempt && d.id === id) ?? { id, answer: null };
}

async function factsOf(L, { repo = null, landedTree = null } = {}) {
  const { root, attempt, state, adapter } = L;
  const problems = [];
  const push = (id, message) => problems.push({ id, message });
  const hold = holdOf(L.events);
  if (hold) push('hold', `held by the person: "${hold.reason}"`);
  const blockers = blockersOf(L.findings);
  if (blockers.length) push('merge:open', `open blocking finding(s): ${blockers.map((f) => `${f.id} (${f.class}, ${f.severity}) ${f.location}`).join('; ')}`);
  for (const d of L.decisions.filter((x) => x.attempt === attempt && ['waiver', 'loosen'].includes(x.kind))) {
    if (!d.answer) push('merge:waiver', `${d.id} is unanswered: ${d.question}`);
    else if (d.kind === 'loosen' && d.answer.choice === CHOICES.loosen.no && !restored(L.events, d)) push('merge:waiver', `the person kept the criteria (${d.id}); restore ${d.refs.filter((r) => /^C\d+$/.test(r)).join(', ')} with \`wf criteria\``);
  }
  const names = (repo ? [repo] : Object.keys(state.repos)).filter((n) => state.repos[n] && fs.existsSync(state.repos[n].worktree));
  const reviews = reviewsOf(L.events);
  const last = reviews[reviews.length - 1] ?? null;
  if (!last) push('merge:unreviewed', 'no review is recorded for this attempt');
  else {
    const heads = headsOfTree(root, attempt, last.tree);
    for (const n of names) {
      const head = git(state.repos[n].worktree, ['rev-parse', 'HEAD']);
      if (!heads?.[n]) {
        push('merge:unreviewed', `the commit reviewed in ${n} is not known (tree ${last.tree})`);
        continue;
      }
      const lines = unreviewedCommits(state.repos[n].worktree, heads[n], head, baseOf(state, adapter, n));
      if (lines.length) push('merge:unreviewed', `${n} changed since the review: ${lines.join('; ')}`);
    }
  }
  for (const n of names) {
    for (const m of foreignMerges(state.repos[n].worktree, 'HEAD', baseOf(state, adapter, n))) {
      const d = await askOnce(L, {
        kind: 'foreign-merge',
        question: `${n}: merge commit ${m.sha.slice(0, 10)} brings in ${m.parent.slice(0, 10)}, which is not on the base${m.branches.length ? ` (it is on ${m.branches.join(', ')})` : ''}. Allow this history in the delivery?`,
        options: [CHOICES.foreign.yes, CHOICES.foreign.no],
        refs: [`${n}:${m.sha}`],
        blocking: true,
      });
      if (d.answer?.choice !== CHOICES.foreign.yes) push('merge:foreign', `${n}: merge ${m.sha.slice(0, 10)} brings in ${m.parent.slice(0, 10)}, not on the base${m.branches.length ? ` (on ${m.branches.join(', ')})` : ''} (${d.id}${d.answer ? `: ${d.answer.choice}` : ', unanswered'})`);
    }
  }
  if (landedTree) {
    const passed = L.events.some((e) => e.type === 'test.run' && e.data.kind === 'full' && e.data.pass && e.data.tree === landedTree && (!repo || e.data.repo === repo));
    if (!passed) push('merge:untested', `no passing full run on the landed tree ${landedTree}`);
  }
  const { tree, files } = changedOf(root, attempt, state, adapter);
  const risk = riskMissing(L, tree, files, last?.tree ?? tree);
  if (risk.touched.length) {
    const missing = risk.missing.map((m) => m.what);
    if (last && !blockers.length) {
      const unverified = reviews.some((r) => r.tree === last.tree && r.coverage === 'unverified');
      const d = await askOnce(L, {
        kind: 'diff-read',
        question: `${attempt} touches risk path(s) ${risk.touched.map((r) => r.id).join(', ')}. Read the diff (${path.join(reviewsDir(root, attempt, last.round, last.tree), 'diff-whole.patch')}) and approve it?${unverified ? ' The reviewers\' reads could not be verified from their transcripts.' : ''}`,
        options: [CHOICES.diffRead.yes, CHOICES.diffRead.no],
        refs: [`tree:${last.tree}`],
        blocking: true,
      });
      if (adapter.review?.diffRead !== 'after' && d.answer?.choice !== CHOICES.diffRead.yes) missing.push(`the person's diff-read (${d.id}${d.answer ? `: ${d.answer.choice}` : ', unanswered'})`);
    }
    if (missing.length) push('merge:risk', `risk path(s) ${risk.touched.map((r) => r.id).join(', ')} touched; missing: ${missing.join('; ')}`);
  }
  return problems;
}

async function mergeFacts(root, attempt, opts = {}) {
  return factsOf(await load(root, attempt), opts);
}

// --- status ------------------------------------------------------------------------------------------------------------

const approveCmd = (d, attempt) => `wf approve ${d.id} --attempt ${attempt} --choice "<${d.options.join(' | ')}>" --quote "<the person's words>"`;
const blockingOpen = (L) => L.decisions.filter((d) => d.attempt === L.attempt && !d.answer && DECISION_KINDS[d.kind]?.blocking);

// The one next command of an attempt, and why.
export async function nextStep(root, attempt) {
  let L = await load(root, attempt);
  const A = `--attempt ${attempt}`;
  const handoff = `wf handoff implementer --session <runtime:session> ${A}`;
  if (!L.state.open) return { command: null, why: `closed (${L.state.outcome})` };
  const hold = holdOf(L.events);
  if (hold) return { command: `wf release ${A}`, why: `held by the person ("${hold.reason}"); run it only when the person asks to lift the hold` };
  let open = blockingOpen(L);
  if (open.length) return { command: approveCmd(open[0], attempt), why: `ask the person, in these words: ${open[0].question}` };
  if (!criteriaOf(L.events)) return { command: `wf criteria --file <criteria file> ${A}`, why: 'no criteria yet: 1 to 6 that a user or a test can check' };
  const { tree, files } = changedOf(root, attempt, L.state, L.adapter);
  const dirty = Object.keys(dirtyRepos(L.state));
  const note = dirty.length ? ` (uncommitted changes in ${dirty.join(', ')})` : '';
  if (!files.length) return { command: handoff, why: `nothing is committed yet${note}` };
  const lastRun = (repo) => L.events.filter((e) => e.type === 'test.run' && e.data.kind === 'fast' && e.data.repo === repo && e.data.tree === repoTree(L.state, repo)).pop()?.data;
  const failing = [...new Set(files.map((f) => f.repo))].filter((r) => lastRun(r)?.pass === false);
  if (failing.length) return { command: handoff, why: `fast tests fail on this tree in ${failing.join(', ')}${note}` };
  const sc = L.adapter.screens;
  if (sc?.capture && sc.routes?.repo && files.some((f) => f.repo === sc.routes.repo && f.kind === 'product') && !L.events.some((e) => e.type === 'screens.captured' && !(e.data.refused ?? []).length && [tree, repoTree(L.state, sc.routes.repo)].includes(e.data.tree))) {
    return { command: `wf screens ${A}`, why: 'the change touches screens and none are captured for this tree' };
  }
  const recorded = reviewsOf(L.events);
  const launches = reviewerLaunches(L.history).filter((h) => h.attempt === attempt && h.tree === tree);
  const unrecorded = launches.filter((h) => !recorded.some((r) => r.tree === tree && r.seat === h.seat));
  if (unrecorded.length) return { command: `wf review --record <review file> ${A}`, why: `reviewer seat(s) ${unrecorded.map((h) => h.seat).join(', ')} launched on this tree; record each review when it is written (its prompt names the file)` };
  const last = recorded[recorded.length - 1];
  let reviewed = recorded.some((r) => r.tree === tree);
  if (!reviewed && last) {
    const heads = headsOfTree(root, attempt, last.tree);
    reviewed = Boolean(heads) && Object.keys(L.state.repos).every((n) => heads[n] && unreviewedCommits(L.state.repos[n].worktree, heads[n], git(L.state.repos[n].worktree, ['rev-parse', 'HEAD']), baseOf(L.state, L.adapter, n)).length === 0);
  }
  if (!reviewed) return { command: `wf review ${A}`, why: `this tree (${tree}) is not reviewed${note}` };
  const blockers = blockersOf(L.findings);
  if (blockers.length) return { command: handoff, why: `fix round for open blocker(s) ${blockers.map((f) => f.id).join(', ')}` };
  const risk = riskMissing(L, tree, files, last?.tree ?? tree);
  const miss = risk.missing[0];
  if (miss) return { command: miss.command === 'handoff' ? handoff : miss.command === 'review' ? `wf review ${A}` : `${miss.command} ${A}`, why: `risk path(s) ${risk.touched.map((r) => r.id).join(', ')}: missing ${miss.what}` };
  const problems = (await factsOf(L)).filter((p) => p.id !== 'merge:untested');
  L = await load(root, attempt); // the facts may have asked the person something
  open = blockingOpen(L);
  if (open.length) return { command: approveCmd(open[0], attempt), why: `ask the person, in these words: ${open[0].question}` };
  if (problems.length) return { command: problems[0].id === 'merge:unreviewed' ? `wf review ${A}` : handoff, why: problems[0].message };
  const stages = L.state.stages ?? [];
  const results = new Map();
  for (const e of L.events) if (e.type === 'stage' && e.data.index >= 0) results.set(e.data.index, e.data);
  const i = stages.findIndex((_, k) => !['done', 'skipped'].includes(results.get(k)?.state));
  if (i < 0) return { command: `wf close ${A}`, why: stages.length ? 'every delivery stage is done' : 'no delivery stages: close once the change is on the base' };
  const r = results.get(i);
  if (r?.state === 'waiting' && stages[i].do === 'land' && L.adapter.delivery?.landing === 'queue') return { command: 'wf land', why: 'ready: the landing queue lands it' };
  if (r?.state === 'pending') return { command: `wf deliver ${A}`, why: `first do this: ${r.next}` };
  return { command: `wf deliver ${A}`, why: `delivery stage ${i + 1} (${stages[i].do})${r?.state === 'waiting' ? ' is waiting' : ''}` };
}

async function openAttempts(ctx, args) {
  const root = projectRoot(ctx);
  if (args.flags.attempt) return [await resolveAttempt(ctx, args)];
  const out = [];
  for (const id of await listAttempts(root)) {
    const s = await attemptState(root, id);
    if (s.open && s.schema === 2) out.push(id);
  }
  return out;
}

async function cmdStatus(ctx, args) {
  const root = projectRoot(ctx);
  const rows = [];
  for (const id of await openAttempts(ctx, args)) rows.push({ attempt: id, ...(await nextStep(root, id)) });
  const text = rows.length ? rows.map((r) => `${r.attempt}\n  next: ${r.command}\n  why: ${r.why}`).join('\n') : 'no open attempts; `wf start <item>` starts one';
  return { text, data: { attempts: rows } };
}

async function cmdResume(ctx, args) {
  const root = projectRoot(ctx);
  const ids = await openAttempts(ctx, args);
  if (!ids.length) return { text: 'no open attempts; `wf start <item>` starts one', data: { attempts: [] } };
  const out = [];
  const data = [];
  for (const id of ids) {
    const L = await load(root, id);
    const crit = criteriaOf(L.events);
    const reviews = reviewsOf(L.events);
    const blockers = blockersOf(L.findings);
    const pending = L.decisions.filter((d) => d.attempt === id && !d.answer);
    const step = await nextStep(root, id);
    const lines = [`${id} (item ${L.state.item})`];
    for (const [n, r] of Object.entries(L.state.repos)) lines.push(`  ${n}: ${r.worktree} (${r.branch}, from ${r.base} ${String(r.baseSha).slice(0, 10)})`);
    lines.push(`  criteria: ${crit ? crit.criteria.map((c) => `${c.id} ${c.text}`).join('; ') : 'none yet'}`);
    lines.push(`  reviews: ${reviews.length}${reviews.length ? `, last round ${reviews[reviews.length - 1].round} on tree ${reviews[reviews.length - 1].tree} (${reviews[reviews.length - 1].coverage})` : ''}; open blockers: ${blockers.map((f) => f.id).join(', ') || 'none'}`);
    if (pending.length) lines.push(`  questions waiting for the person: ${pending.map((d) => `${d.id} "${d.question}" (${d.options.join(' | ')})`).join('; ')}`);
    const hold = holdOf(L.events);
    if (hold) lines.push(`  held: "${hold.reason}"`);
    lines.push(`  next: ${step.command}`, `  why: ${step.why}`);
    out.push(lines.join('\n'));
    data.push({ attempt: id, item: L.state.item, next: step.command, why: step.why, blockers: blockers.map((f) => f.id), decisions: pending.map((d) => d.id) });
  }
  return { text: out.join('\n\n'), data: { attempts: data } };
}

// --- commands ----------------------------------------------------------------------------------------------------------

function readInput(file) {
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new WfError(`no file ${f}`);
  const text = fs.readFileSync(f, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return YAML.parse(text);
    } catch (error) {
      throw new WfError(`${f} is neither JSON nor YAML: ${error.message}`);
    }
  }
}

async function cmdCriteria(ctx, args) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  const raw = readInput(flagText(args, 'file', { required: true }));
  const input = Array.isArray(raw) ? { criteria: raw, areas: [] } : raw ?? {};
  const r = await setCriteria(root, id, { criteria: input.criteria, areas: input.areas ?? [] }, { actor: ctx.actor });
  const lines = [r.unchanged ? `criteria unchanged (${r.hash.slice(0, 12)})` : `criteria set on ${id} (${r.hash.slice(0, 12)}):`, ...r.criteria.map((c) => `  ${c.id}: ${c.text}`)];
  if (r.decision) lines.push(`the edit changes criteria cited by open blockers (${r.loosened.join(', ')}): asked the person (${r.decision}); the merge waits for the answer`);
  return { text: lines.join('\n'), data: r };
}

async function cmdHandoff(ctx, args) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  const role = args._[0];
  if (role === 'reviewer') throw refusal('review:independent', 'a reviewer is launched by wf, never handed by the owner', '`wf review` launches reviewers with only the bundle');
  if (!['planner', 'implementer', 'tester'].includes(role)) throw new WfError('wf handoff planner|implementer|tester --session <runtime:id>');
  const session = sessionFlag(flagText(args, 'session', { required: true }), ctx.actor);
  const L = await load(root, id);
  if (!L.state.open) throw new WfError(`${id} is closed`);
  const hold = holdOf(L.events);
  if (hold) throw refusal('hold', `${id} is held by the person ("${hold.reason}")`, 'only the person lifts the hold (`wf release` on their answer)');
  if (role === 'implementer') {
    const np = await noProgress(root, L.state.item);
    if (np.stop) {
      let decision = np.decision;
      if (!decision) decision = (await askNoProgress(root, id, np)).id;
      if (np.answer?.choice !== CHOICES.noProgress.yes) {
        throw refusal('fix:no-progress', `${np.reason}${np.answer ? `; the person chose "${np.answer.choice}"` : ''}`, np.answer ? `the person stopped the fix rounds: \`wf abandon --attempt ${id} --reason "<their words>"\`` : `ask the person ${decision} (\`wf status\` shows it), then record their answer with \`wf approve ${decision}\``);
      }
    }
  }
  const { tree } = changedOf(root, id, L.state, L.adapter);
  const round = roundOf(L.history, tree);
  await append(root, id, 'handoff', { role, session, launchedBy: 'owner', tree, round }, ctx.actor);
  const learned = learnedFile(L.adapter);
  return { text: `${role} ${session.runtime}:${session.id} recorded on ${id} (tree ${tree})${learned ? `\nput this in its prompt: what this project learned: ${learned}` : ''}`, data: { attempt: id, role, session, tree, learned } };
}

async function recordFromFile(ctx, args, root, id) {
  const file = path.resolve(flagText(args, 'record', { required: true }));
  const raw = readInput(file);
  // The bundle that named this output file gives its seat and tree.
  const near = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((f) => /^bundle-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(file), f), 'utf8'))).find((b) => path.resolve(b.output ?? '') === file) : null;
  const seat = raw.seat ?? flagText(args, 'seat') ?? near?.seat ?? 'whole';
  const tree = raw.tree ?? near?.tree ?? null;
  let session = raw.session ?? (flagText(args, 'session') ? sessionFlag(flagText(args, 'session'), ctx.actor) : null);
  if (!session) {
    const L = await load(root, id);
    const t = tree ?? changedOf(root, id, L.state, L.adapter).tree;
    const cands = reviewerLaunches(L.history).filter((h) => h.attempt === id && h.seat === seat && h.tree === t);
    if (cands.length !== 1) throw new WfError(`${cands.length ? 'several reviewers were' : 'no reviewer was'} launched for seat ${seat} on tree ${t}; pass --session <runtime:id>`);
    session = cands[0].session;
  }
  let t = tree;
  if (!t) {
    const L = await load(root, id);
    t = changedOf(root, id, L.state, L.adapter).tree;
  }
  const input = { session, seat, tree: t, findings: raw.findings ?? [], verified: raw.verified ?? [] };
  const r = await recordReview(root, id, input);
  const lines = [`review ${r.review} recorded on ${id} (seat ${seat}, coverage ${r.coverage}): ${r.findings.length} finding(s), ${r.blockers} open blocker(s)`];
  for (const f of r.findings) lines.push(`  ${f.id} ${f.class} ${f.severity} ${f.location}: ${f.what}`);
  for (const p of r.pending) lines.push(`  ${p.finding} is filed through the tracker connector: ${p.operation}`);
  return { text: lines.join('\n'), data: r };
}

async function cmdReview(ctx, args) {
  const root = projectRoot(ctx);
  const id = await resolveAttempt(ctx, args);
  if (args.flags.record) return recordFromFile(ctx, args, root, id);
  const waive = flagText(args, 'waive');
  if (waive) {
    const L = await load(root, id);
    const f = L.findings[waive];
    if (!f || !blockersOf(L.findings).includes(f)) throw new WfError(`${waive} is not an open blocking finding of ${L.state.item}`);
    const q = await ask(root, id, { kind: 'waiver', question: `Waive blocking finding ${f.id} (${f.class}, ${f.severity}) at ${f.location}: ${f.what}?${flagText(args, 'why') ? ` The owner's reason: ${flagText(args, 'why')}` : ''}`, options: [CHOICES.waiver.yes, CHOICES.waiver.no], refs: [f.id], blocking: true });
    return { text: `asked the person (${q.id}) whether to waive ${f.id}; the merge waits for the answer`, data: { decision: q.id } };
  }
  const hold = holdOf(schema2(await readEvents(root, id)));
  if (hold) throw refusal('hold', `${id} is held by the person ("${hold.reason}")`, 'only the person lifts the hold (`wf release` on their answer)');
  const { tree, bundles } = await bundle(root, id);
  const L = await load(root, id);
  const launched = reviewerLaunches(L.history).filter((h) => h.attempt === id && h.tree === tree);
  const todo = bundles.filter((b) => !launched.some((h) => h.seat === b.seat));
  if (!todo.length) return { text: `reviewers are already launched on tree ${tree} (${launched.map((h) => h.seat).join(', ')}); record each with \`wf review --record <file> --attempt ${id}\``, data: { tree, launched: [] } };
  const { files } = changedOf(root, id, L.state, L.adapter);
  const repos = [...new Set(files.map((f) => f.repo))];
  const ran = (repo, kind) => L.events.some((e) => e.type === 'test.run' && e.data.repo === repo && e.data.kind === kind && (kind === 'risk-base' ? Date.parse(e.at) >= Date.parse(headTime(L.state, repo)) : e.data.tree === repoTree(L.state, repo)));
  const tests = repos.filter((r) => !ran(r, 'fast')).map((r) => ({ repo: r, kind: 'fast' }));
  for (const r of [...new Set(riskOf(L.adapter, files).tests.map((f) => f.repo))]) if (!ran(r, 'risk-base')) tests.push({ repo: r, kind: 'risk-base' });
  // Reviewers and tests run at once on the same tree.
  const jobs = [
    ...todo.map((b) => launchReviewer(root, id, b, b.model ? { model: b.model } : {}).then((x) => ({ seat: b.seat, ...x, output: b.output }))),
    ...tests.map((t) => runTests(root, id, t.repo, t.kind).then((x) => ({ test: t, ...x }))),
  ];
  const results = await Promise.allSettled(jobs);
  const lines = [`review round on tree ${tree}:`];
  results.forEach((r, i) => {
    const job = i < todo.length ? `reviewer ${todo[i].seat}` : `${tests[i - todo.length].kind} tests of ${tests[i - todo.length].repo}`;
    if (r.status === 'rejected') lines.push(`  ${job}: failed: ${r.reason?.message ?? r.reason}`);
    else if (r.value.session) lines.push(`  ${job}: launched ${r.value.session.runtime}:${r.value.session.id}; it writes ${r.value.output}`);
    else lines.push(`  ${job}: ${r.value.pass ? 'pass' : 'FAIL'}${r.value.log ? ` (${r.value.log})` : ''}`);
  });
  lines.push(`next: when a reviewer's file is written, wf review --record <file> --attempt ${id}`);
  return { text: lines.join('\n'), data: { tree, results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message ?? r.reason) })) } };
}

export const implements08 = { setCriteria, bundle, recordReview, noProgress, mergeFacts, cmdCriteria, cmdReview, cmdHandoff, cmdStatus, cmdResume };
