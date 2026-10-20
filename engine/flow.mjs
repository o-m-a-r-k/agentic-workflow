// The flow (design section 2, D91, D93): criteria, the review bundle, recording a review, the no-progress stop, the merge
// facts, and the commands that drive them. Stream 1.
//
// The engine checks facts only: hashes, git, the ledger and the host's transcripts. What a finding or an edit means is the
// reviewer's and the person's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISION_KINDS, WfError, append, ask, attemptDir, attemptState, canonicalJson, filesRead, launchReviewer,
  listAttempts, loadAdapter, readEvents, refusal, runTests, userDir,
} from './contract.mjs';
import { baseOf, changedOf, dirtyRepos, foreignMerges, mergeBaseOf, rootPath, specOf, unreviewedCommits } from './base.mjs';
import { assertFindings, blockersOf, fileOther, foldFindings, nextFindingNumber, pendingFollowUps, pendingLines, refilePending, refuseOtherOwn } from './findings.mjs';
import { PROJECT_LEDGER, decisionsOf, flagText, holdOf, itemHistory, projectRoot, resolveAttempt, schema2, sessionFlag } from './attempt.mjs';
import { docAtBase, ruleDocs } from './rules.mjs';
import { NEEDS, firstSeat, foldRisk, normNeed, riskLine } from './risk.mjs';
import { writtenBy } from './hosts/index.mjs';
import { scrub, secretValues } from './scrub.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { YAML, git, matchesAny, sha256 } from './util.mjs';
import { workingTree } from './tests.mjs';
import { processSeams } from './process-tree.mjs';

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
  return { root, attempt, state, adapter, history, events, decisions, waived, ...foldFindings(history, waived) };
}

const criteriaOf = (events) => [...events].reverse().find((e) => e.type === 'criteria.set')?.data ?? null;
const reviewsOf = (events) => events.filter((e) => e.type === 'review.recorded').map((e) => e.data);
const allEvents = (history) => history.flatMap((h) => h.events.map((e) => ({ ...e, attempt: h.id })));
const reviewerLaunches = (history) => allEvents(history).filter((e) => e.type === 'handoff' && e.data.role === 'reviewer' && e.data.launchedBy === 'wf').map((e) => ({ ...e.data, attempt: e.attempt }));
// test.run records each repo's git tree (stream 2); screens may record either that or the attempt's tree.
const repoTree = (state, repo) => git(state.repos[repo].worktree, ['rev-parse', 'HEAD^{tree}']);
// A risk-base run counts for the tree it ran on and the merge-base it ran at (when the run records it), never by time.
// Test runs record the files they ran on (tests `workingTree`), so a run is matched to the worktree's files now.
const testedTree = (state, repo) => workingTree(state.repos[repo].worktree);
const riskBaseRan = (L, repo) => {
  const tree = testedTree(L.state, repo);
  return L.events.filter((e) => e.type === 'test.run' && e.data.kind === 'risk-base' && e.data.repo === repo && e.data.tree === tree && (!e.data.mergeBase || e.data.mergeBase === mergeBaseOf(L.state, L.adapter, repo)));
};
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

// Risk (design section 2, "Risk", D94): the first seats judge it and name its needs (engine/risk.mjs folds them across
// the item's attempts); the engine checks that each need has its evidence and never judges the risk.
const itemReviews = (history) => allEvents(history).filter((e) => e.type === 'review.recorded').map((e) => ({ ...e.data, attempt: e.attempt }));
const riskOf = (L) => foldRisk(itemReviews(L.history));
const wantsSecond = (risk) => risk.needs.includes(NEEDS.second) || risk.free.length > 0;
// A finding that cites a free-text need (named in its what or why).
const cites = (f, need) => `${f.what} ${f.why}`.toLowerCase().includes(need.toLowerCase());
// Whether a second review ran on a model of its own: its model differs from every first seat's on the host they share,
// or, with no model recorded, it ran on another host than every first seat (another host's default model).
function ownModel(second, firsts) {
  const same = (f) => f.session?.runtime === second.session?.runtime && (second.model ? f.model === second.model : true);
  return !firsts.some(same);
}
const reviewerOf = (r) => `${r.session?.runtime ?? '?'} ${r.model ?? 'default model'}`;

// A shape problem of a review: a plain error the reviewer can fix, which also marks its launch failed (flow M2).
const shapeError = (message, hint) => Object.assign(new WfError(message, hint ? { hint } : undefined), { shape: true });

// A reviewer's `risk` (first seats) and `met` (second seats), checked for shape and against the facts the engine holds.
// `standing`: the needs that stand before this review; `fastRepos`: whether the changed repos have `fast` tests.
function checkRisk(input, seat, saved, { standing, fastRepos, findings, openCiting }) {
  const shape = 'give `risk` as { level: low|high, why: <text>, needs: [second-review|failing-test|diff-read|<text>, ...], drop?: [{ need, why }] }';
  if (firstSeat(seat)) {
    const r = input.risk;
    // Required only of a seat whose bundle carried the risk guidance (a bundle from before 0.8.1 carries none).
    if (r === undefined && !saved?.files?.risk) return {};
    if (!r || typeof r !== 'object') throw shapeError(`the review gives no risk judgement: ${shape}`);
    if (!['low', 'high'].includes(r.level)) throw shapeError(`risk.level \`${r.level}\` is not low or high`);
    if (typeof r.why !== 'string' || !r.why.trim()) throw shapeError('risk.why is empty: say what a mistake here would cost');
    if (!Array.isArray(r.needs) || r.needs.some((n) => typeof n !== 'string' || !n.trim())) throw shapeError(`risk.needs must be a list of needs: ${shape}`);
    const needs = [...new Set(r.needs.map(normNeed))];
    const drop = r.drop ?? [];
    if (!Array.isArray(drop) || drop.some((d) => typeof d?.need !== 'string' || typeof d.why !== 'string' || !d.why.trim())) throw shapeError(`risk.drop must be a list of { need, why }: ${shape}`);
    const drops = drop.map((d) => ({ need: normNeed(d.need), why: d.why.trim() }));
    const notStanding = drops.filter((d) => !standing.includes(d.need));
    if (notStanding.length) throw shapeError(`risk.drop names ${notStanding.map((d) => `"${d.need}"`).join(', ')}, which no earlier review asked for; the standing needs are: ${standing.join(', ') || 'none'}`);
    const both = drops.filter((d) => needs.includes(d.need));
    if (both.length) throw shapeError(`risk lists and drops ${both.map((d) => `"${d.need}"`).join(', ')}`);
    if (r.level === 'high' && !needs.length && !standing.filter((n) => !drops.some((d) => d.need === n)).length) throw shapeError('risk.level is high but names no needs: say what would make you confident the change is right');
    if (needs.includes(NEEDS.test) && !fastRepos) throw shapeError('risk.needs names failing-test, but no changed repo has `fast` tests to run on the merge-base: name another need (a second review, a scenario to check)');
    return { risk: { level: r.level, why: r.why.trim(), needs, ...(drops.length ? { drop: drops } : {}) } };
  }
  const asked = saved?.needs ?? [];
  const met = input.met ?? [];
  if (!Array.isArray(met) || met.some((m) => typeof m?.need !== 'string' || typeof m.met !== 'boolean')) throw shapeError('`met` must be a list of { need, met: true|false, how }');
  const none = asked.filter((n) => !met.some((m) => m.need === n));
  if (none.length) throw shapeError(`the second review gives no verdict on: ${none.map((n) => `"${n}"`).join('; ')}`, 'have the reviewer add each to `met`, then record the review again');
  const noHow = met.filter((m) => m.met && !(typeof m.how === 'string' && m.how.trim()));
  if (noHow.length) throw shapeError(`\`met: true\` needs \`how\` (what the reviewer read or ran): ${noHow.map((m) => `"${m.need}"`).join('; ')}`);
  // An unmet need is a blocker: a `goal` finding that cites it, new in this review or an open one it verifies.
  const uncited = met.filter((m) => !m.met && !findings.some((f) => f.class === 'goal' && cites(f, m.need)) && !openCiting(m.need));
  if (uncited.length) throw shapeError(`\`met: false\` needs a \`goal\` finding that cites the need: ${uncited.map((m) => `"${m.need}"`).join('; ')}`, 'add a goal finding naming the need in its `what`, then record the review again');
  return met.length ? { met: met.map((m) => ({ need: m.need, met: m.met, ...(typeof m.how === 'string' && m.how.trim() ? { how: m.how.trim() } : {}) })) } : {};
}

// Mark a launched reviewer's run failed (its review was refused for its shape), so `wf review` launches it again.
function markLaunchFailed(root, attempt, session, why) {
  const dir = path.join(attemptDir(root, attempt), 'reviews');
  if (!session?.id || !fs.existsSync(dir)) return false;
  for (const d of fs.readdirSync(dir).filter((x) => x.startsWith('launch-'))) {
    const file = path.join(dir, d, 'status.json');
    try {
      const status = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (status.session !== session.id) continue;
      fs.writeFileSync(file, `${JSON.stringify({ ...status, state: 'failed', error: `its review was refused: ${why}` }, null, 2)}\n`);
      return true;
    } catch {}
  }
  return false;
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

// A role's text as the plugin ships it, frontmatter stripped: the whole of what the role is told about its job.
export const roleText = (role = 'reviewer') => fs.readFileSync(path.join(PLUGIN, 'templates', 'agents', `${role}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();

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

function rulesFor(root, adapter, state, files, dir) {
  const roots = files.map((f) => rootPath(specOf(adapter, f.repo, state.repos[f.repo]), f.path));
  return ruleDocs(adapter, roots).map((f) => docAtBase(root, state, adapter, f, dir)).filter(Boolean);
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
  const { tree, heads, files } = changedOf(root, attempt, state, adapter);
  const product = files.filter((f) => f.kind === 'product');
  const tests = files.filter((f) => f.kind === 'tests');
  if (!product.length && !tests.length) throw new WfError(`${attempt} has no committed change to review`);
  const productLines = product.reduce((n, f) => n + f.added + f.removed, 0);
  const round = roundOf(L.history, tree);
  const dir = reviewsDir(root, attempt, round, tree);
  mkdirStateDirectory(dir, { recursive: true });

  const criteriaFile = path.join(dir, 'criteria.md');
  fs.writeFileSync(criteriaFile, `${crit.criteria.map((c) => `- ${c.id}: ${c.text}`).join('\n')}\n${crit.areas?.length ? `\nTouched areas: ${crit.areas.join(', ')}\n` : ''}`);
  const cdiff = criteriaDiffSinceReview(L.events);
  const criteriaDiff = cdiff ? path.join(dir, 'criteria-diff.md') : null;
  if (cdiff) fs.writeFileSync(criteriaDiff, `${cdiff}\n`);
  const invariants = adapter.invariants ? docAtBase(root, state, adapter, adapter.invariants, dir) : null;
  const rules = rulesFor(root, adapter, state, files, dir);
  const consumers = consumersOf(root, state, adapter, files);
  const screenTrees = [tree, ...Object.keys(state.repos).map((r) => repoTree(state, r))];
  const images = [...L.events].reverse().find((e) => e.type === 'screens.captured' && !(e.data.refused ?? []).length && screenTrees.includes(e.data.tree))?.data.images ?? [];
  const screens = images.map((i) => i.file);
  // A page that did not show the requested language or direction: the reviewer judges it.
  const mismatched = images.filter((i) => i.mismatch).map((i) => `${i.file}: asked ${i.mismatch.requested?.lang ?? '-'} ${i.mismatch.requested?.dir ?? '-'}, the page is ${i.mismatch.page?.lang ?? '-'} ${i.mismatch.page?.dir ?? '-'}`);
  const learned = learnedFile(adapter);
  const riskGuide = path.join(PLUGIN, 'templates', 'risk.md');
  const risk = riskOf(L);
  const blockers = blockersOf(L.findings);
  const fixed = Object.values(L.findings).filter((f) => f.status === 'fixed' && f.class !== 'other');
  const changes = Object.values(L.findings).filter((f) => f.changes.length);

  const seats = [];
  if (productLines > SPLIT_LINES) {
    const areas = splitAreas(product);
    for (const a of areas) seats.push({ seat: `area:${a.name}`, files: a.files, shared: product.filter((f) => !a.files.includes(f)) });
  } else seats.push({ seat: 'whole', files: product, shared: [] });
  // The second seats, once every first seat on this tree is recorded and their needs ask for it: one on the whole
  // diff, or one per area above the split size (`second:<area>`), on a model of their own.
  const recorded = reviewsOf(L.events).filter((r) => r.tree === tree);
  if (wantsSecond(risk) && seats.every((s) => recorded.some((r) => r.seat === s.seat))) {
    if (productLines > SPLIT_LINES) for (const a of splitAreas(product)) seats.push({ seat: `second:${a.name}`, files: a.files, shared: product.filter((f) => !a.files.includes(f)) });
    else seats.push({ seat: 'second', files: product, shared: [] });
  }
  // The person's diff-read reads the whole product diff, written whenever it is a need (an area split has no whole seat).
  if (risk.needs.includes(NEEDS.read) && !seats.some((s) => s.seat === 'whole')) writeDiff(path.join(dir, 'diff-whole.patch'), state, adapter, [...product, ...tests]);
  // The merge-base runs behind `failing-test`: the engine knows only that they failed; the second seat reads why.
  const baseRuns = [...new Set(tests.map((f) => f.repo))].map((r) => riskBaseRan(L, r).at(-1)?.data).filter(Boolean);
  const secondModel = adapter.models?.secondReviewer ?? null;

  const bundles = seats.map((s) => {
    const name = seatFile(s.seat);
    const diff = writeDiff(path.join(dir, `diff-${name}.patch`), state, adapter, [...s.files, ...tests]);
    const output = path.join(dir, `review-${name}.json`);
    const sharedFiles = s.shared.map((f) => path.join(state.repos[f.repo].worktree, f.path));
    const productFiles = s.files.filter((f) => f.status !== 'D').map((f) => `${f.repo}/${f.path}`);
    const first = firstSeat(s.seat);
    const files_ = { diff, criteria: criteriaFile, criteriaDiff, invariants, rules, consumers, screens, risk: first ? riskGuide : null, sharedFiles };
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
      list('Screenshots whose page language or direction differs from the one asked (judge each)', mismatched),
      first ? `Risk (judge it as this says): ${riskGuide}` : `The first reviewers judged this change ${risk.high ? `high-risk: ${risk.why.join('; ')}` : 'low-risk'}. You are the second, independent review of the whole change.`,
      first ? list('Risk needs standing from earlier reviews (they stay unless you drop one in `risk.drop` with its why)', [...risk.standing].map(([n, why]) => `${n} (${why})`)) : null,
      !first && risk.free.length ? list('Needs to verify (say for each whether this change meets it, and how; an unmet one is a `goal` finding that names it)', risk.free) : null,
      !first ? list('Merge-base test runs (did each fail for the reason the change fixes?)', baseRuns.map((r) => `${r.repo}: ${r.pass ? 'passed' : 'failed'} on the merge-base${r.log ? `, log ${r.log}` : ''}`)) : null,
      list('Product files you must read in full (your reads are checked)', productFiles.map((f) => path.join(state.repos[f.split('/')[0]].worktree, f.slice(f.indexOf('/') + 1)))),
      list('Other changed files, reviewed by other seats', sharedFiles),
      blockers.length ? list('Verify these open findings first (status fixed or open), then re-read the whole change', blockers.map((f) => `${f.id} ${f.class} ${f.severity} ${f.location}: ${f.what}`)) : null,
      fixed.length ? list('Earlier findings marked fixed (mark one `open` in verified if it is back)', fixed.map((f) => `${f.id} ${f.location}: ${f.what}`)) : null,
      changes.length ? list('Findings whose class or severity changed', changes.map((f) => `${f.id}: ${f.changes.map((c) => `${c.field} ${c.from} -> ${c.to}`).join(', ')}`)) : null,
      `Write your review as JSON to ${output}: {"findings": [...], "verified": [{"id": "F1", "status": "fixed"}], ${first ? '"risk": {"level": "low|high", "why": "...", "needs": [...], "drop": [{"need": "...", "why": "..."}]}' : '"met": [{"need": "<a need above>", "met": true, "how": "..."}]'}}, in one write with your file tool. If you cannot write files, give that JSON as your final message.`,
    ].filter((x) => x !== null && x !== '').join('\n');
    const b = {
      seat: s.seat, attempt, tree, heads, round, prompt, files: files_, verify: blockers.map((f) => f.id), productFiles, ...(first ? {} : { needs: risk.free }),
      productLines: s.files.reduce((n, f) => n + f.added + f.removed, 0),
      model: (first ? adapter.models?.reviewer : secondModel) ?? null,
      // With no second-reviewer model set, the second seat runs on another host when one can launch (its default model).
      ...(!first && !secondModel ? { otherHost: true } : {}),
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

// Whether the launch supervisor `pid` (started at `at`) still runs: true, false, or null when this host cannot tell (it
// lets wf signal the pid but `ps` gives no start time). A pid the system gave to another process since is gone: `ps`
// reports whole seconds and the supervisor records `at` as it starts, so its own start is within 2 seconds of it.
export function supervisorAlive(pid, at) {
  try {
    processSeams.kill(pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') return false;
  }
  const launched = Date.parse(at ?? '');
  if (!Number.isFinite(launched)) return null;
  const started = processSeams.startedAt(pid);
  if (started === null) return null;
  return Math.abs(started - launched) <= 2000;
}

// What wf's launch supervisor recorded for a reviewer session (`reviews/launch-*/`): { state, startedAt, endedAt, error,
// closure }, or null when wf holds no record of it here. A run whose supervisor (`pid`) is gone before it ended is failed:
// nothing will ever finish it.
export function launchRecord(root, attempt, session) {
  const dir = path.join(attemptDir(root, attempt), 'reviews');
  if (!session?.id || !fs.existsSync(dir)) return null;
  for (const d of fs.readdirSync(dir).filter((x) => x.startsWith('launch-'))) {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(dir, d, 'status.json'), 'utf8'));
      const spec = JSON.parse(fs.readFileSync(path.join(dir, d, 'spec.json'), 'utf8'));
      if (status.session !== session.id || spec.host !== session.runtime) continue;
      if (!['done', 'failed'].includes(status.state) && status.pid) {
        const alive = supervisorAlive(status.pid, status.pidAt);
        if (alive === false) return { ...status, state: 'failed', error: `its launch supervisor (pid ${status.pid}) is no longer running, so the reviewer will never finish`, closure: spec.closure };
        if (alive === null) return { ...status, liveness: 'unknown', note: `wf cannot tell whether its launch supervisor (pid ${status.pid}) still runs: this host gives no start time for it`, closure: spec.closure };
      }
      return { ...status, closure: spec.closure };
    } catch {}
  }
  return null;
}

async function recordReview(root, attempt, input) {
  const L = await load(root, attempt);
  const { state, adapter } = L;
  if (!state.open) throw new WfError(`${attempt} is closed`);
  const session = input?.session;
  if (!session?.id) throw new WfError('the review names no reviewer session');

  const launched = reviewerLaunches(L.history).filter((h) => sameSession(h.session, session));
  if (!launched.length) throw refusal('review:independent', `session ${session.runtime}:${session.id} was not launched by wf as a reviewer of ${state.item}`, '`wf review` launches reviewers; record their output');
  const implemented = allEvents(L.history).filter((e) => e.type === 'handoff' && e.data.role !== 'reviewer' && sameSession(e.data.session, session));
  if (implemented.length || sameSession(state.owner, session)) throw refusal('review:independent', `session ${session.id} also worked on ${state.item} (${implemented.length ? implemented.map((e) => e.data.role).join(', ') : 'owner'})`, '`wf review` launches a fresh reviewer');

  // The reviewed tree and seat are the ones wf launched this reviewer on, never what a review file or a flag says.
  const launch = launched.at(-1);
  const seat = launch.seat ?? 'whole';
  if (input.seat && input.seat !== seat) throw new WfError(`reviewer ${session.id} was launched for seat ${seat}, not ${input.seat}`);
  const { tree, heads, files } = changedOf(root, attempt, state, adapter);
  if (launch.attempt !== attempt || launch.tree !== tree) throw refusal('review:tree', `the reviewer was launched on tree ${launch.tree}${launch.attempt !== attempt ? ` of ${launch.attempt}` : ''}, but HEAD is tree ${tree}`, '`wf review` launches fresh reviewers on HEAD');
  // The review file is the reviewer's own output, as a fact of its transcript (its last write of the file, or its final
  // message's JSON). Named failure: a review file anyone could write was recorded as the independent reviewer's.
  // A host with no readable transcript cannot show it: provenance is then `unverified`, shown at the diff-read and in the
  // digest, as coverage is.
  const wrote = input.file ? writtenBy(session, input.file) : undefined;
  if (wrote === false) throw refusal('review:independent', `${input.file} is not reviewer ${session.runtime}:${session.id}'s own output: its transcript shows neither a write of these bytes nor this JSON as its final message`, 'record the file the reviewer wrote, unedited');
  const provenance = wrote === null ? 'unverified' : wrote ? 'verified' : null;

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
  // A review refused for its shape marks its launch failed, so `wf review` launches the seat again.
  let judged;
  try {
    assertFindings(input.findings, repos);
    const changed = [...new Set(files.map((f) => f.repo))];
    const verifiedOpen = new Set((input.verified ?? []).filter((v) => v?.status === 'open').map((v) => v.id));
    judged = checkRisk(input, seat, saved, {
      standing: riskOf(L).needs,
      fastRepos: changed.some((r) => specOf(adapter, r, state.repos[r]).tests?.fast),
      findings: input.findings,
      openCiting: (need) => blockersOf(L.findings).some((f) => f.class === 'goal' && verifiedOpen.has(f.id) && cites(f, need)),
    });
  } catch (error) {
    if (error instanceof WfError && (error.shape || !error.refusalId)) markLaunchFailed(root, attempt, session, error.message);
    throw error;
  }
  await refuseOtherOwn(root, attempt, input.findings);
  const verified = input.verified ?? [];
  if (!Array.isArray(verified)) throw new WfError('`verified` must be a list of { id, status }');
  for (const v of verified) {
    if (!L.findings[v?.id]) throw new WfError(`verified: no finding ${v?.id} in ${state.item}`);
    if (!['fixed', 'open'].includes(v.status)) throw new WfError(`verified ${v.id}: status \`${v.status}\` is not fixed or open`);
  }
  let n = nextFindingNumber(L.findings);
  const secrets = secretValues(root, adapter);
  const findings = input.findings.map((f) => ({ id: `F${n++}`, location: f.location, what: scrub(f.what, { secrets }), why: scrub(f.why, { secrets }), severity: f.severity, class: f.class }));
  const round = roundOf(L.history, tree);
  const review = reviewsOf(L.events).length + 1;
  const data = { review, round, seat, tree, heads, session, coverage, ...(provenance ? { provenance } : {}), findings, verified, blockers: 0, ...judged, ...(saved?.model ?? launched[0].model ? { model: saved?.model ?? launched[0].model } : {}), ...(Array.isArray(read) ? { filesRead: read.length } : {}), ...(unread.length ? { unread } : {}) };
  const after = foldFindings([...L.history.filter((h) => h.id !== attempt), { id: attempt, events: [...L.events, { type: 'review.recorded', data, at: new Date().toISOString() }] }]);
  const waivedIds = new Set(Object.values(L.findings).filter((f) => f.status === 'waived').map((f) => f.id));
  data.blockers = blockersOf(after.findings).filter((f) => !waivedIds.has(f.id)).length;
  await append(root, attempt, 'review.recorded', data, session);

  // Follow-ups of earlier reviews still pending through a connector are read back first.
  const pending = (await refilePending(root, attempt)).pending;
  for (const f of findings.filter((x) => x.class === 'other')) {
    const { data: filed, pending: op } = await fileOther(root, attempt, f, adapter, { noTracker: L.events.find((e) => e.type === 'attempt.started')?.data.ticketing === 'none' });
    await append(root, attempt, 'finding.filed', filed, null);
    if (filed.state === 'pending') pending.push({ finding: f.id, operation: op });
  }
  const np = await noProgress(root, state.item);
  if (np.stop && !np.decision) await askNoProgress(root, attempt, np);
  return { review, seat, findings, blockers: data.blockers, coverage, provenance, pending, ...judged };
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

// The standing risk needs (across the item's attempts) that lack their evidence on the reviewed tree, each with the
// command that supplies it. An unmet free-text need is a `goal` finding of the second reviewer: merge:open holds it, and
// the waiver and the no-progress stop apply to it as to any blocker.
function riskMissing(L, files, reviewedTree) {
  const risk = riskOf(L);
  const missing = [];
  const onTree = reviewsOf(L.events).filter((r) => r.tree === reviewedTree);
  const seconds = onTree.filter((r) => !firstSeat(r.seat));
  const launched = reviewerLaunches(L.history).filter((h) => h.attempt === L.attempt && h.tree === reviewedTree && !firstSeat(h.seat ?? 'whole'));
  const allIn = seconds.length > 0 && launched.every((h) => seconds.some((r) => r.seat === h.seat));
  if (wantsSecond(risk) && !allIn) missing.push({ what: risk.needs.includes(NEEDS.second) ? 'the second whole-diff review' : `the second reviewer's verdict on: ${risk.free.join('; ')}`, command: 'review' });
  else if (wantsSecond(risk)) {
    const firsts = onTree.filter((r) => firstSeat(r.seat));
    const same = seconds.filter((r) => !ownModel(r, firsts));
    const configured = L.adapter.models?.secondReviewer;
    if (same.length && configured && configured !== same[0].model) missing.push({ what: `a second review on \`models.secondReviewer\` (${configured}); the last ran on ${reviewerOf(same[0])}, as the first did`, command: 'review' });
    else if (same.length) missing.push({ what: `a second review on a model of its own (it ran on ${reviewerOf(same[0])}, as the first did): set \`models.secondReviewer\` to a different model`, command: 'doctor' });
    for (const n of risk.free) if (seconds.some((r) => !r.met?.some((m) => m.need === n))) missing.push({ what: `the second reviewer's verdict on "${n}"`, command: 'review' });
  }
  if (risk.needs.includes(NEEDS.test)) {
    const repos = [...new Set(files.filter((f) => f.kind === 'tests' && f.status !== 'D').map((f) => f.repo))];
    const runs = repos.map((repo) => ({ repo, last: riskBaseRan(L, repo).at(-1)?.data }));
    if (!repos.length) missing.push({ what: 'a test that fails without the change (the change has no file its repo\'s `kinds.tests` classes as a test)', command: 'handoff' });
    else if (!runs.some((r) => r.last && !r.last.pass)) {
      const notRun = runs.filter((r) => !r.last).map((r) => r.repo);
      if (notRun.length) missing.push({ what: `the changed tests of ${notRun.join(', ')} run on the merge-base`, command: `wf test risk-base --repo ${notRun[0]}` });
      else missing.push({ what: 'changed tests that fail on the merge-base (they passed there, so they prove nothing about the change)', command: 'handoff' });
    }
  }
  return { risk, missing };
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
  const { id, shownAt } = await ask(L.root, L.attempt, q);
  let d = L.decisions.find((x) => x.attempt === L.attempt && x.id === id);
  if (!d) L.decisions.push((d = { ...q, id, attempt: L.attempt, askedAt: shownAt ?? null, answer: null }));
  return d;
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
    const heads = last.heads ?? null;
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
  const { tree, files } = changedOf(root, attempt, state, adapter);
  // The fast tests are green on HEAD in every changed repo that has them (a fact of the ledger: the last fast run on
  // the repo's HEAD tree passed).
  // A run records the files it ran on (tests `workingTree`): HEAD's tree when the worktree is clean. Files that differ
  // from HEAD (`git diff --name-only` of the two trees) make it another tree: the run then stands for no commit, and the
  // hint names them: untracked ones are committed or ignored, tracked ones with uncommitted changes are committed.
  for (const n of names.filter((x) => files.some((f) => f.repo === x) && specOf(adapter, x, state.repos[x]).tests?.fast)) {
    const now = testedTree(state, n);
    const run = L.events.filter((e) => e.type === 'test.run' && e.data.kind === 'fast' && e.data.repo === n && e.data.tree === now).at(-1)?.data;
    const head = repoTree(state, n);
    if (run?.pass && now === head) continue;
    const wt = state.repos[n].worktree;
    const extra = now === head ? [] : git(wt, ['diff', '--name-only', head, now], { allowFail: true }).split('\n').filter(Boolean);
    const others = new Set(extra.length ? git(wt, ['ls-files', '--others', '--exclude-standard', '--', ...extra], { allowFail: true }).split('\n').filter(Boolean) : []);
    const untracked = extra.filter((f) => others.has(f));
    const uncommitted = extra.filter((f) => !others.has(f));
    const said = run ? (run.pass ? 'they passed on the worktree\'s files, not on HEAD\'s' : 'they fail') : 'no run on this tree';
    const parts = [...(untracked.length ? [`untracked files HEAD lacks: ${untracked.join(', ')}`] : []), ...(uncommitted.length ? [`uncommitted changes in ${uncommitted.join(', ')}`] : [])];
    const todo = [...(untracked.length ? [`commit ${untracked.join(', ')} or .gitignore them`] : []), ...(uncommitted.length ? [`uncommitted changes in ${uncommitted.join(', ')}: commit them`] : [])];
    problems.push({
      id: 'merge:untested', fact: 'fast', repo: n, untracked, uncommitted,
      message: `${n}: the fast tests are not green on HEAD (${said})${parts.length ? `; ${parts.join('; ')}` : ''}`,
      ...(todo.length ? { hint: `in ${n}, ${todo.join('; ')}; then \`wf test fast --repo ${n} --attempt ${attempt}\`` } : {}),
    });
  }
  if (landedTree) {
    const passed = L.events.some((e) => e.type === 'test.run' && e.data.kind === 'full' && e.data.pass && e.data.tree === landedTree && (!repo || e.data.repo === repo));
    if (!passed) push('merge:untested', `no passing full run on the landed tree ${landedTree}`);
  }
  const { risk, missing: lacking } = riskMissing(L, files, last?.tree ?? tree);
  const missing = lacking.map((m) => m.what);
  // The person reads the diff last: once no other fact refuses the merge and every other need has its evidence.
  const readable = last && !problems.length && !lacking.length;
  if (risk.needs.includes(NEEDS.read) && !readable) {
    if (adapter.review?.diffRead !== 'after') missing.push('the person\'s diff-read (asked once the other needs are met)');
  } else if (risk.needs.includes(NEEDS.read)) {
    const unverified = reviews.some((r) => r.tree === last.tree && r.coverage === 'unverified');
    const untraced = reviews.some((r) => r.tree === last.tree && r.provenance === 'unverified');
    const dir = reviewsDir(root, attempt, last.round, last.tree);
    const diffFile = path.join(dir, 'diff-whole.patch');
    if (!fs.existsSync(diffFile)) writeDiff(diffFile, state, adapter, files.filter((f) => f.kind !== 'other'));
    const logs = [...new Set(files.filter((f) => f.kind === 'tests').map((f) => f.repo))].map((r) => riskBaseRan(L, r).at(-1)?.data).filter((r) => r?.log).map((r) => `${r.repo} ${r.log}`);
    const line = riskLine(itemReviews(L.history));
    const d = await askOnce(L, {
      kind: 'diff-read',
      question: `${attempt}: its reviewer asks you to read the diff before it ships (${line}). Read it (${diffFile})${logs.length ? `, with the merge-base test log${logs.length > 1 ? 's' : ''} (${logs.join('; ')})` : ''}, and approve it?${unverified ? ' The reviewers\' reads could not be verified from their transcripts.' : ''}${untraced ? ' The review files could not be traced to their reviewers from transcripts.' : ''}`,
      options: [CHOICES.diffRead.yes, CHOICES.diffRead.no],
      refs: [`tree:${last.tree}`],
      blocking: true,
    });
    if (adapter.review?.diffRead !== 'after' && d.answer?.choice !== CHOICES.diffRead.yes) missing.push(`the person's diff-read (${d.id}${d.answer ? `: ${d.answer.choice}` : ', unanswered'})`);
  }
  if (missing.length) push('merge:risk', `the reviewers' risk needs lack evidence: ${missing.join('; ')}`);
  return problems;
}

async function mergeFacts(root, attempt, opts = {}) {
  return factsOf(await load(root, attempt), opts);
}

// --- status ------------------------------------------------------------------------------------------------------------

const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso ?? '')) / 60000)) || 0;

// Screens are due when capture is set and the change reaches a routed repo's product files, or a `shared` file (whose
// sentinel screens are captured even with no routes).
function screensNeeded(L, files) {
  const sc = L.adapter.screens;
  if (!sc?.capture) return false;
  const product = files.filter((f) => f.kind === 'product');
  if (sc.routes?.repo && product.some((f) => f.repo === sc.routes.repo)) return true;
  return Boolean(sc.sentinel?.length) && product.some((f) => matchesAny(rootPath(specOf(L.adapter, f.repo, L.state.repos[f.repo]), f.path), sc.shared ?? []));
}

const approveCmd = (d, attempt) => `wf approve ${d.id} --attempt ${attempt} --choice "<${d.options.join(' | ')}>" --quote "<the person's words>"`;
// With `review.diffRead: after` the diff-read holds nothing: the merge goes first and the person keeps the revert.
const blockingOpen = (L) => L.decisions.filter((d) => d.attempt === L.attempt && !d.answer && DECISION_KINDS[d.kind]?.blocking && !(d.kind === 'diff-read' && L.adapter.review?.diffRead === 'after'));

// The one next command of an attempt, and why; `followUps`: those still pending through a connector, from the ledger.
// It writes nothing: `wf review --record` and `wf deliver` read pending follow-ups and the start's tracker status back.
// The attempt is loaded once (`L`: the caller's load, when it holds one).
export async function nextStep(root, attempt, L = null) {
  L ??= await load(root, attempt);
  const followUps = L.state.open && !holdOf(L.events) ? pendingFollowUps(L.events).map(({ finding, operation }) => ({ finding, operation })) : [];
  const step = await stepOf(root, attempt, L);
  return followUps.length ? { ...step, followUps } : step;
}

async function stepOf(root, attempt, L) {
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
  const lastRun = (repo) => {
    const t = testedTree(L.state, repo);
    return L.events.filter((e) => e.type === 'test.run' && e.data.kind === 'fast' && e.data.repo === repo && e.data.tree === t).pop()?.data;
  };
  const failing = [...new Set(files.map((f) => f.repo))].filter((r) => lastRun(r)?.pass === false);
  if (failing.length) return { command: handoff, why: `fast tests fail on this tree in ${failing.join(', ')}${note}` };
  if (screensNeeded(L, files) && !L.events.some((e) => e.type === 'screens.captured' && !(e.data.refused ?? []).length && [tree, ...Object.keys(L.state.repos).map((r) => repoTree(L.state, r))].includes(e.data.tree))) {
    return { command: `wf screens ${A}`, why: 'the change touches screens and none are captured for this tree' };
  }
  const recorded = reviewsOf(L.events);
  const launches = reviewerLaunches(L.history).filter((h) => h.attempt === attempt && h.tree === tree);
  const unrecorded = launches.filter((h) => !recorded.some((r) => r.tree === tree && r.seat === h.seat)).map((h) => ({ ...h, run: launchRecord(root, attempt, h.session) }));
  const running = unrecorded.filter((h) => h.run && !['done', 'failed'].includes(h.run.state));
  if (running.length) return { command: `wf review ${A}`, why: running.map((h) => `reviewer ${h.seat} running since ${minutesSince(h.run.startedAt)} min${h.run.note ? ` (${h.run.note})` : ''}`).join('; ') + '; `wf review` waits for it' };
  const failedRuns = unrecorded.filter((h) => h.run?.state === 'failed');
  if (failedRuns.length) return { command: `wf review ${A}`, why: `reviewer ${failedRuns.map((h) => `${h.seat} failed (${h.run.error ?? 'no result'})`).join('; ')}; \`wf review\` launches it again` };
  if (unrecorded.length) return { command: `wf review --record <review file> ${A}`, why: `reviewer seat(s) ${unrecorded.map((h) => h.seat).join(', ')} launched on this tree; record each review when it is written (its prompt names the file)` };
  const last = recorded[recorded.length - 1];
  let reviewed = recorded.some((r) => r.tree === tree);
  if (!reviewed && last) {
    const heads = last.heads ?? null;
    reviewed = Boolean(heads) && Object.keys(L.state.repos).every((n) => heads[n] && unreviewedCommits(L.state.repos[n].worktree, heads[n], git(L.state.repos[n].worktree, ['rev-parse', 'HEAD']), baseOf(L.state, L.adapter, n)).length === 0);
  }
  if (!reviewed) return { command: `wf review ${A}`, why: `this tree (${tree}) is not reviewed${note}` };
  const blockers = blockersOf(L.findings);
  if (blockers.length) return { command: handoff, why: `fix round for open blocker(s) ${blockers.map((f) => f.id).join(', ')}` };
  const miss = riskMissing(L, files, last?.tree ?? tree).missing[0];
  if (miss) return { command: miss.command === 'handoff' ? handoff : miss.command === 'review' ? `wf review ${A}` : miss.command === 'doctor' ? 'wf doctor' : `${miss.command} ${A}`, why: `the reviewer's risk needs ${miss.what}` };
  const problems = await factsOf(L); // a question the facts asked joins L.decisions
  open = blockingOpen(L);
  if (open.length) return { command: approveCmd(open[0], attempt), why: `ask the person, in these words: ${open[0].question}` };
  if (problems.length) {
    const p = problems[0];
    const command = p.fact === 'fast' ? (p.untracked?.length || p.uncommitted?.length ? handoff : `wf test fast --repo ${p.repo} ${A}`) : p.id === 'merge:unreviewed' ? `wf review ${A}` : handoff;
    return { command, why: p.hint ? `${p.message}; ${p.hint}` : p.message };
  }
  const stages = L.state.stages ?? [];
  const results = new Map();
  for (const e of L.events) if (e.type === 'stage') results.set(e.data.index, e.data);
  const take = results.get(-1);
  if (take && !['done', 'skipped'].includes(take.state)) return { command: `wf deliver ${A}`, why: `the tracker status set at start is ${take.state}${take.next ? `: first do this: ${take.next}` : ''}` };
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
  for (const id of (await listAttempts(root)).filter((x) => x !== PROJECT_LEDGER)) {
    const s = await attemptState(root, id);
    if (s.open && s.schema === 2) out.push(id);
  }
  return out;
}

// The person's open questions in these attempts, as one closing line.
async function questionsLine(root, ids) {
  let n = 0;
  for (const id of ids) n += (await decisionsOf(root, [{ id, events: schema2(await readEvents(root, id)) }])).filter((d) => !d.answer).length;
  return { open: n, line: `open questions for the person: ${n}${n ? '; `wf digest` lists them' : ''}` };
}

async function cmdStatus(ctx, args) {
  const root = projectRoot(ctx);
  await loadAdapter(root); // an adapter that cannot be read (a schema-1 one names `wf init --from-07`) is said first
  const rows = [];
  const ids = await openAttempts(ctx, args);
  for (const id of ids) rows.push({ attempt: id, ...(await nextStep(root, id)) });
  const q = await questionsLine(root, ids);
  const text = rows.length ? [...rows.map((r) => [`${r.attempt}`, `  next: ${r.command}`, `  why: ${r.why}`, ...pendingLines(r.followUps ?? [])].join('\n')), q.line].join('\n') : 'no open attempts; `wf start <item>` starts one';
  return { text, data: { attempts: rows, openQuestions: q.open } };
}

async function cmdResume(ctx, args) {
  const root = projectRoot(ctx);
  await loadAdapter(root);
  const ids = await openAttempts(ctx, args);
  if (!ids.length) return { text: 'no open attempts; `wf start <item>` starts one', data: { attempts: [] } };
  const out = [];
  const data = [];
  for (const id of ids) {
    const L = await load(root, id);
    const step = await nextStep(root, id, L);
    const crit = criteriaOf(L.events);
    const reviews = reviewsOf(L.events);
    const blockers = blockersOf(L.findings);
    const pending = L.decisions.filter((d) => d.attempt === id && !d.answer);
    const lines = [`${id} (item ${L.state.item})`];
    for (const [n, r] of Object.entries(L.state.repos)) lines.push(`  ${n}: ${r.worktree} (${r.branch}, from ${r.base} ${String(r.baseSha).slice(0, 10)})`);
    lines.push(`  criteria: ${crit ? crit.criteria.map((c) => `${c.id} ${c.text}`).join('; ') : 'none yet'}`);
    lines.push(`  reviews: ${reviews.length}${reviews.length ? `, last round ${reviews[reviews.length - 1].round} on tree ${reviews[reviews.length - 1].tree} (${reviews[reviews.length - 1].coverage})` : ''}; open blockers: ${blockers.map((f) => f.id).join(', ') || 'none'}`);
    if (pending.length) lines.push(`  questions waiting for the person: ${pending.map((d) => `${d.id} "${d.question}" (${d.options.join(' | ')})`).join('; ')}`);
    const changed = Object.values(L.findings).filter((f) => f.changes.length);
    if (changed.length) lines.push(`  class or severity changed: ${changed.map((f) => `${f.id} ${f.changes.map((c) => `${c.field} ${c.from} -> ${c.to}`).join(', ')}`).join('; ')}`);
    const hold = holdOf(L.events);
    if (hold) lines.push(`  held: "${hold.reason}"`);
    lines.push(`  next: ${step.command}`, `  why: ${step.why}`, ...pendingLines(step.followUps ?? []));
    out.push(lines.join('\n'));
    data.push({ attempt: id, item: L.state.item, next: step.command, why: step.why, blockers: blockers.map((f) => f.id), decisions: pending.map((d) => d.id), followUps: step.followUps ?? [] });
  }
  const q = await questionsLine(root, ids);
  return { text: [...out, q.line].join('\n\n'), data: { attempts: data, openQuestions: q.open } };
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
  if (!['planner', 'implementer'].includes(role)) throw new WfError('wf handoff planner|implementer --session <runtime:id>');
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
  const { tree, heads } = changedOf(root, id, L.state, L.adapter);
  const round = roundOf(L.history, tree);
  await append(root, id, 'handoff', { role, session, launchedBy: 'owner', tree, heads, round }, ctx.actor);
  const learned = learnedFile(L.adapter);
  const prompt = [
    roleText(role),
    '',
    `Change: ${id} (${L.state.item}). Worktrees: ${Object.entries(L.state.repos).map(([n, r]) => `${n} ${r.worktree}`).join('; ')}.`,
    learned ? `What this project learned (read it): ${learned}` : null,
  ].filter((x) => x !== null).join('\n');
  return { text: `${role} ${session.runtime}:${session.id} recorded on ${id} (tree ${tree}). Launch it with this text as its instructions:\n\n${prompt}`, data: { attempt: id, role, session, tree, learned, prompt } };
}

async function recordFromFile(ctx, args, root, id) {
  const file = path.resolve(flagText(args, 'record', { required: true }));
  const raw = readInput(file);
  // The session is the reviewer wf launched for the bundle that named this file (or --session); its launch gives the
  // seat and the tree. Nothing the file says about them is read.
  const near = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((f) => /^bundle-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(file), f), 'utf8'))).find((b) => path.resolve(b.output ?? '') === file) : null;
  let session = flagText(args, 'session') ? sessionFlag(flagText(args, 'session'), ctx.actor) : null;
  if (!session) {
    if (!near) throw new WfError(`${file} is not a review file a bundle names; pass --session <runtime:id>`);
    const L = await load(root, id);
    const cands = reviewerLaunches(L.history).filter((h) => h.attempt === id && h.seat === near.seat && h.tree === near.tree);
    if (cands.length !== 1) throw new WfError(`${cands.length ? 'several reviewers were' : 'no reviewer was'} launched for seat ${near.seat} on tree ${near.tree}; pass --session <runtime:id>`);
    session = cands[0].session;
  }
  const r = await recordReview(root, id, { session, file, findings: raw.findings ?? [], verified: raw.verified ?? [], risk: raw.risk, met: raw.met });
  const lines = [`review ${r.review} recorded on ${id} (seat ${r.seat}, coverage ${r.coverage}${r.provenance === 'unverified' ? ', provenance unverified' : ''}): ${r.findings.length} finding(s), ${r.blockers} open blocker(s)`];
  if (r.risk) lines.push(`  risk ${r.risk.level}: ${r.risk.why}${r.risk.needs.length ? `; needs: ${r.risk.needs.join('; ')}` : ''}`);
  for (const d of r.risk?.drop ?? []) lines.push(`  dropped need: ${d.need} (${d.why})`);
  for (const m of r.met ?? []) lines.push(`  ${m.met ? 'met' : 'NOT met'}: ${m.need}${m.how ? ` (${m.how})` : ''}`);
  for (const f of r.findings) lines.push(`  ${f.id} ${f.class} ${f.severity} ${f.location}: ${f.what}`);
  if (r.provenance === 'unverified') lines.push('  provenance unverified: the host keeps no readable transcript to show the reviewer wrote this file; the person sees it at the diff-read and in the digest');
  lines.push(...pendingLines(r.pending));
  return { text: lines.join('\n'), data: r };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until every launched reviewer's run is done or failed (wf's launch record); a session wf holds no record of is
// not waited for.
async function waitForReviewers(root, id, sessions) {
  for (;;) {
    const runs = sessions.map((s) => launchRecord(root, id, s));
    // A run whose supervisor wf cannot see is not waited for: its line says so.
    if (runs.every((r) => !r || ['done', 'failed'].includes(r.state) || r.liveness === 'unknown')) return runs;
    await sleep(process.env.WF_TEST === '1' ? 100 : 2000);
  }
}

function reviewerLines(root, id, launched) {
  return launched.map((h) => {
    const run = launchRecord(root, id, h.session);
    const file = run?.closure ?? h.output;
    if (run?.state === 'failed') return `  reviewer ${h.seat}: failed: ${run.error ?? 'it ended without a result'}; \`wf review --attempt ${id}\` launches it again`;
    if (run && run.state !== 'done') return `  reviewer ${h.seat}: running since ${minutesSince(run.startedAt)} min${run.note ? ` (${run.note})` : ''}; it writes ${file}`;
    return `  reviewer ${h.seat}: ${run ? 'done' : 'launched'}; record it: wf review --record ${file ?? '<review file>'} --attempt ${id}`;
  });
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
  const wait = args.flags['no-wait'] !== true;
  const hold = holdOf(schema2(await readEvents(root, id)));
  if (hold) throw refusal('hold', `${id} is held by the person ("${hold.reason}")`, 'only the person lifts the hold (`wf release` on their answer)');
  const { tree, bundles } = await bundle(root, id);
  const L = await load(root, id);
  const recorded = reviewsOf(L.events);
  // A seat counts as launched unless its run failed with no review recorded: that seat is launched again.
  // A second seat whose review ran on the first seats' model is launched again once `models.secondReviewer` names another.
  const firsts = recorded.filter((r) => r.tree === tree && firstSeat(r.seat));
  const stale = (r) => !firstSeat(r.seat) && !ownModel(r, firsts) && L.adapter.models?.secondReviewer && L.adapter.models.secondReviewer !== r.model;
  const launched = reviewerLaunches(L.history).filter((h) => h.attempt === id && h.tree === tree && (recorded.some((r) => r.tree === tree && r.seat === h.seat && !stale(r)) || (!recorded.some((r) => r.tree === tree && r.seat === h.seat) && launchRecord(root, id, h.session)?.state !== 'failed')));
  const todo = bundles.filter((b) => !launched.some((h) => h.seat === b.seat));
  if (!todo.length) {
    const waiting = launched.filter((h) => !recorded.some((r) => r.tree === tree && r.seat === h.seat));
    if (wait) await waitForReviewers(root, id, waiting.map((h) => h.session));
    const out = waiting.map((h) => ({ ...h, output: bundles.find((b) => b.seat === h.seat)?.output }));
    return { text: [`reviewers are already launched on tree ${tree} (${launched.map((h) => h.seat).join(', ')}):`, ...reviewerLines(root, id, out)].join('\n'), data: { tree, launched: [] } };
  }
  const { files } = changedOf(root, id, L.state, L.adapter);
  const repos = [...new Set(files.map((f) => f.repo))];
  const ran = (repo, kind) => {
    if (kind === 'risk-base') return riskBaseRan(L, repo).length > 0;
    const t = testedTree(L.state, repo);
    return L.events.some((e) => e.type === 'test.run' && e.data.repo === repo && e.data.kind === kind && e.data.tree === t);
  };
  const tests = repos.filter((r) => !ran(r, 'fast')).map((r) => ({ repo: r, kind: 'fast' }));
  if (riskOf(L).needs.includes(NEEDS.test)) for (const r of [...new Set(files.filter((f) => f.kind === 'tests' && f.status !== 'D').map((f) => f.repo))]) if (!ran(r, 'risk-base')) tests.push({ repo: r, kind: 'risk-base' });
  // Reviewers and tests run at once on the same tree; by default this waits until every reviewer is done or failed.
  const launches = todo.map((b) => launchReviewer(root, id, b, { closure: b.output, ...(b.model ? { model: b.model } : {}), ...(b.otherHost ? { otherHost: true } : {}) }).then((x) => ({ seat: b.seat, ...x, output: x.closure ?? b.output })));
  const reviewersDone = Promise.allSettled(launches).then(async (rs) => {
    if (wait) await waitForReviewers(root, id, rs.filter((r) => r.status === 'fulfilled').map((r) => r.value.session));
    return rs;
  });
  const [reviewers, testResults] = await Promise.all([reviewersDone, Promise.allSettled(tests.map((t) => runTests(root, id, t.repo, t.kind).then((x) => ({ test: t, ...x }))))]);
  const lines = [`review round on tree ${tree}:`];
  reviewers.forEach((r, i) => {
    if (r.status === 'rejected') lines.push(`  reviewer ${todo[i].seat}: failed: ${r.reason?.message ?? r.reason}`);
    else lines.push(`  reviewer ${todo[i].seat}: launched ${r.value.session.runtime}:${r.value.session.id}; it writes ${r.value.output}`, ...(wait ? reviewerLines(root, id, [{ seat: todo[i].seat, session: r.value.session, output: r.value.output }]) : []));
  });
  testResults.forEach((r, i) => {
    const job = `${tests[i].kind} tests of ${tests[i].repo}`;
    if (r.status === 'rejected') lines.push(`  ${job}: failed: ${r.reason?.message ?? r.reason}`);
    else lines.push(`  ${job}: ${r.value.pass ? 'pass' : 'FAIL'}${r.value.log ? ` (${r.value.log})` : ''}`);
  });
  if (!wait) lines.push(`next: when a reviewer's file is written, wf review --record <file> --attempt ${id}`);
  const results = [...reviewers, ...testResults];
  return { text: lines.join('\n'), data: { tree, results: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message ?? r.reason) })) } };
}

export const implements08 = { setCriteria, bundle, recordReview, noProgress, mergeFacts, cmdCriteria, cmdReview, cmdHandoff, cmdStatus, cmdResume };
