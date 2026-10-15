import { mkdirStateDirectory } from './state-folders.mjs';
import { checkedLessons, classifierFor, classify, learnedFacts, lessonStats, noteLearned, sameMistakes } from './learning.mjs';
// Lessons: each project's learning path (docs/LESSONS.md). Capture, apply, inject, acknowledge, feedback, export. The
// engine never edits the adapter or an instruction file to enforce a lesson: it prints what to add, and the owner
// commits it.
//
// Where lessons live (named correction, 0.2.x): a lesson belongs to the repository it concerns and is committed and
// delivered with the ticket that taught it: `<repo>/.workflow/lessons/<id>.yaml`, in the attempt's worktree of that repo
// while the attempt is open and its acceptance (if it has one) does not stand any more (committed there, so it is in the
// reviewed diff), in that repo's main checkout otherwise. A cross-repo (`project`) lesson lives the same way in the adapter
// repo. A finding about the workflow itself is a plugin improvement (`wf improve`), never written into a project.
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTER_DIR, adapterLocation, attemptAdapter, loadConfig, repoDir, trustedAdapter } from './config.mjs';
import { readRegular, writeNoFollow } from './evidence.mjs';
import { canonical, isInside, touchesEvidence } from './paths.mjs';
import { acceptedTreeStands } from './attempt.mjs';
import { append, listAttempts, loadState, readLedger } from './ledger.mjs';
import { formatLesson, lessonStyle } from './lessons-format.mjs';
import { componentsOf } from './topology.mjs';
import { WfError, YAML, git, matchesAny, now, refuse } from './util.mjs';
import { obligationSince } from './versions.mjs';
import { recordedRoundsOf, refOf } from './review-policy.mjs';
import { defaultRuntime } from './runtime-policy.mjs';
import { defaultHostId } from './hosts/index.mjs';

export const CAUSES = ['process', 'tooling', 'criteria', 'review', 'test', 'design-system', 'other'];
export const MECHANISMS = ['review-rule', 'designSystem-rule', 'planner-criterion-template', 'reviewer-checklist', 'gate-check', 'engine-change', 'doc'];
const STATUSES = ['proposed', 'enforced', 'retired'];
// Terms: PROJECT = the whole onboarded system (one adapter, one tracker); REPO = one Git repository in it. A `repo`
// lesson is about one repo and lives in its tree; a `project` lesson spans repos and lives in the adapter repo's tree.
// A finding about the workflow itself is a plugin improvement (`wf improve`), never a lesson.
const SCOPES = ['repo', 'project'];
// Finding categories that mean "the way we work let this through": each prompts a lesson.
export const LESSON_CATEGORIES = new Set(['process', 'tooling', 'criteria', 'review', 'test', 'design-system', 'precedent-only']);
// At most this many advisory lessons per bundle; enforced lessons are never dropped by the cap (0.7.9: the rest are ranked by evidence).
export const CAP = 5;

const LESSONS_REL = path.join(ADAPTER_DIR, 'lessons');
const LESSONS_POSIX = LESSONS_REL.split(path.sep).join('/');
export const lessonsDir = (repoRoot) => path.join(repoRoot, LESSONS_REL);
// A changed file that is a lesson: covered by the lesson harness, never an unplanned change.
export const LESSON_FILE = /(^|\/)\.workflow\/lessons\/[^/]+\.ya?ml$/;
// Named finding (0.2.0 review): a lesson id became a path. Ids are a strict allowlist; the file is named by its id (an
// id is only ever taken from a file's name, never from its content); the folder must be a real folder that really lies
// in its repo and outside the evidence; files are read and written without following links, never through a hard link.
export const LESSON_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const fileIn = (repoRoot, id) => {
  if (!LESSON_ID.test(String(id))) throw refuse(`invalid lesson id \`${String(id).slice(0, 80)}\`: letters, digits and dashes, starting with a letter or digit, at most 64 characters`);
  return path.join(lessonsDir(repoRoot), `${id}.yaml`);
};

function dirProblems(repoRoot) {
  const dir = lessonsDir(repoRoot);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [`${dir} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; lessons are not read or written through it`];
  const out = [];
  if (touchesEvidence(dir)) out.push(`${dir} resolves into the evidence`);
  if (!isInside(canonical(dir), canonical(repoRoot))) out.push(`${dir} really lies outside its repo (${canonical(dir)})`);
  return out;
}
const lessonProblems = new Map();
export const lessonWarnings = (root) => lessonProblems.get(root) ?? [];
const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(',').map((x) => x.trim()).filter(Boolean));


function parseLesson(name, text, where, problems) {
  if (!/\.ya?ml$/.test(name)) return null;
  const id = name.replace(/\.ya?ml$/, '');
  if (!LESSON_ID.test(id)) {
    problems.push(`${where}: not a valid lesson file name (skipped)`);
    return null;
  }
  let l;
  try {
    // A lone CR (`endOfLine: cr` in a project's Prettier config) is a line break; the YAML library reads only LF and CRLF.
    l = YAML.parse(text.replace(/\r\n?/g, '\n')) ?? {};
  } catch (error) {
    problems.push(`${where}: not YAML (${error.message.split('\n')[0]}) (skipped)`);
    return null;
  }
  if (l.id !== undefined && String(l.id) !== id) {
    problems.push(`${where}: its id \`${String(l.id).slice(0, 80)}\` differs from its file name (skipped)`);
    return null;
  }
  // Older files: `scope: project` with a `repo` meant one repo (now `repo`); without one it spans the project.
  const scope = l.scope === 'plugin' ? 'plugin' : l.repo !== undefined && l.scope !== 'project-wide' ? (l.scope === 'project' && l.repo === null ? 'project' : 'repo') : 'project';
  return { ...l, id, scope, declaredRepo: l.repo, recurrence: Number(l.recurrence ?? 0), tags: asList(l.tags), paths: asList(l.paths), components: asList(l.components), kinds: asList(l.kinds) };
}

function readDir(dir, extra, problems) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/\.ya?ml$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (!e.isFile()) {
      problems.push(`${p}: ${e.isSymbolicLink() ? 'a symlink' : 'not a regular file'} (skipped)`);
      continue;
    }
    const r = readRegular(p);
    if (!r) {
      problems.push(`${p}: not a regular file with one name (a hard link?) (skipped)`);
      continue;
    }
    const l = parseLesson(e.name, r.bytes.toString('utf8'), p, problems);
    if (l) out.push({ ...l, ...extra, file: p });
  }
  return out;
}

// The lessons a repo holds at a commit (git objects: no link is followed there).
function readAtCommit(repoRoot, commit, extra, problems) {
  const names = git(repoRoot, ['ls-tree', '--name-only', `${commit}:${LESSONS_POSIX}`], { allowFail: true });
  if (!names) return [];
  const out = [];
  for (const name of names.split('\n').filter(Boolean)) {
    const text = git(repoRoot, ['show', `${commit}:${LESSONS_POSIX}/${name}`], { allowFail: true });
    const l = parseLesson(name, text ?? '', `${extra.repo}@${String(commit).slice(0, 10)}:${LESSONS_POSIX}/${name}`, problems);
    if (l) out.push({ ...l, ...extra, file: null });
  }
  return out;
}

// Every declared repo's lessons: at the attempt's base, in the main checkout, and in the attempt's worktree. A lesson
// at the base or in the main checkout is never replaced by a weaker worktree copy (a ticket cannot drop or soften one);
// the worktree adds new lessons and carries this attempt's own updates (a recurrence) for delivery.
export function loadLessons(root, { state = null } = {}) {
  let cfg = null;
  let adapterRepo = null;
  if (state) {
    // For an attempt, the repos whose lessons apply are the base adapter's: a repo dropped from the working copy keeps
    // its lessons (0.5.0 adversarial review).
    cfg = trustedAdapter(root, state);
    adapterRepo = attemptAdapter(root, state).repo.name;
  } else {
    try {
      cfg = loadConfig(root);
      adapterRepo = adapterLocation(root, cfg).repo.name;
    } catch {}
  }
  const problems = [];
  // Named failure (I-95): ids are allocated per repository, so two repositories could each hold a different lesson `L-4`
  // (after integrating bases, or two attempts adding one each); the second was dropped without a word and its lesson never
  // reached a bundle. A lesson is now held per repository and id; two different lessons that share an id keep both, each
  // under the identity `<id>@<repository>` (a lesson's repository is the repository whose folder holds its file), and the
  // collision is reported. The same lesson held twice (a copy left after a move) is still one.
  const held = new Map();
  const put = (l, { replaces = false } = {}) => {
    const k = `${l.id.toLowerCase()}\n${l.repo}`;
    const had = held.get(k);
    if (!had) held.set(k, l);
    else if (replaces && l.status === had.status && l.recurrence >= had.recurrence) held.set(k, l);
  };
  for (const repo of cfg?.repos ?? []) {
    const main = repoDir(root, repo);
    const r = state?.repos?.[repo.name];
    const extra = (where) => ({ repo: repo.name, where });
    if (r?.base) for (const l of readAtCommit(main, r.base, extra('base'), problems)) put(l);
    const mp = dirProblems(main);
    problems.push(...mp);
    if (!mp.length) for (const l of readDir(lessonsDir(main), extra('main'), problems)) put(l);
    if (r?.worktree && fs.existsSync(r.worktree)) {
      const wp = dirProblems(r.worktree);
      problems.push(...wp);
      if (!wp.length) for (const l of readDir(lessonsDir(r.worktree), extra('attempt'), problems)) put(l, { replaces: true });
    }
  }
  const sameId = new Map();
  for (const l of held.values()) sameId.set(l.id.toLowerCase(), [...(sameId.get(l.id.toLowerCase()) ?? []), l]);
  const found = [];
  for (const group of sameId.values()) {
    const distinct = [];
    for (const l of group) if (!distinct.some((d) => d.title === l.title && d.trigger?.what === l.trigger?.what)) distinct.push(l);
    if (distinct.length < 2) {
      found.push({ ...distinct[0], fileId: distinct[0].id });
      continue;
    }
    for (const l of distinct) found.push({ ...l, fileId: l.id, id: `${l.id}@${l.repo}` });
    problems.push(`lesson ${distinct[0].id} is ${distinct.length} different lessons, held by ${distinct.map((l) => l.repo).join(', ')}; each keeps its own identity (${distinct.map((l) => `${l.id}@${l.repo}`).join(', ')}), so none is hidden; rename one when convenient (its file name and \`id\`, committed in its repo)`);
  }
  const own = found;
  // Lessons in the wrong place: no `repo`, a `repo` other than the one holding the file, or a plugin lesson in a project.
  for (const l of own) {
    if (l.scope === 'plugin') problems.push(`${l.repo}: lesson ${l.id} is about the workflow itself: it is a plugin improvement, not a lesson; move it to your inbox with \`wf lesson move ${l.id} --improvement\``);
    else if (l.scope === 'project') {
      if (adapterRepo && l.repo !== adapterRepo) problems.push(`${l.repo}: lesson ${l.id} spans the project and belongs in the adapter repo (${adapterRepo}): \`wf lesson move ${l.id} --project\` (or \`--repo <name>\` if it is about one repo)`);
    } else if (l.declaredRepo !== l.repo) problems.push(`${l.repo}: lesson ${l.id} says it concerns ${l.declaredRepo}; move it there: \`wf lesson move ${l.id} --repo ${l.declaredRepo}\``);
  }
  lessonProblems.set(root, problems);
  return own.map((l) => (l.scope === 'project' ? { ...l, repo: null, home: l.repo } : { ...l, home: l.repo }));
}

// A lesson by the identity the roles are given: its id, or `<id>@<repository>` when two repositories hold different lessons
// of one id (I-95). The qualified form names the same lesson whether or not another repository still holds that id, so a
// reference recorded while they collided stays valid after one is renamed. A bare id that is now two lessons is refused
// with the identities to choose from.
export function findLesson(lessons, ref) {
  const want = String(ref ?? '');
  const exact = lessons.find((l) => l.id === want) ?? lessons.find((l) => `${l.fileId}@${l.home}` === want);
  if (exact) return exact;
  const several = lessons.filter((l) => l.fileId === want);
  if (several.length > 1) throw refuse(`lesson ${want} is ${several.length} different lessons: name one of ${several.map((l) => l.id).join(', ')}`);
  return undefined;
}

function validate(l, cfg = null) {
  const p = [];
  if (!LESSON_ID.test(String(l.fileId ?? l.id ?? ''))) p.push('`id` must be letters, digits and dashes, starting with a letter or digit, at most 64 characters');
  if (!String(l.title ?? '').trim()) p.push('`title` says in one line what the project learned');
  if (!String(l.trigger?.what ?? '').trim()) p.push('`trigger.what` says what happened and where it was seen');
  if (!CAUSES.includes(l.cause)) p.push(`\`cause\` is one of ${CAUSES.join(', ')}`);
  if (!MECHANISMS.includes(l.mechanism?.kind)) p.push(`\`mechanism.kind\` is one of ${MECHANISMS.join(', ')}`);
  if (!SCOPES.includes(l.scope)) p.push('`scope` is repo (about one repository: `--repo <name>`) or project (spans repos: `--project`); a finding about the workflow itself is a plugin improvement: `wf improve add`');
  if (!STATUSES.includes(l.status)) p.push(`\`status\` is one of ${STATUSES.join(', ')}`);
  if (l.status === 'enforced' && !String(l.mechanism?.ref ?? '').trim()) p.push('an enforced lesson names its mechanism: `mechanism.ref` (the rule id, step id or document that enforces it; `wf lesson apply <id>` prints what to add)');
  const kinds = asList(l.kinds);
  if (kinds.some((k) => !FILE_KINDS.includes(k))) p.push(`\`kinds\` are file kinds: ${FILE_KINDS.join(', ')} (not ${kinds.filter((k) => !FILE_KINDS.includes(k)).join(', ')})`);
  const comps = asList(l.components);
  if (cfg && comps.some((c) => !cfg.components.some((x) => x.id === c))) p.push(`\`components\` names components of the adapter: ${cfg.components.map((c) => c.id).join(', ') || 'none are declared'} (not ${comps.filter((c) => !cfg.components.some((x) => x.id === c)).join(', ')})`);
  if (l.scope === 'repo' && cfg && comps.some((c) => cfg.components.some((x) => x.id === c && x.repo !== l.repo))) p.push(`a repo lesson's \`components\` are in its repo ${l.repo}`);
  if (l.scope === 'repo' && cfg && !cfg.repos.some((r) => r.name === l.repo)) p.push(`\`repo\` names the repository the lesson concerns: one of ${cfg.repos.map((r) => r.name).join(', ')}`);
  return p;
}

// A project lesson that narrows itself by nothing (no repo, components, kinds, paths or tags) applies to every change in the
// project (I-64); `wf lesson show` states the same rule from here (I-110).
export const isProjectWide = (l) => l.scope === 'project' && !l.repo && !(l.components ?? []).length && !(l.kinds ?? []).length && !(l.paths ?? []).length && !(l.tags ?? []).length;

// Whether the attempt's acceptance still describes its tree. It does not once the tree moved past the accepted heads (commits
// made after the acceptance: a repair), nor once an implementer was handed after it and is still open (a repair under way,
// before its first commit). An implementer left open when the review was accepted is no sign of either: committing a lesson
// then would move the tree off the accepted one and `wf deliver` would refuse "modified after acceptance".
// Named failure (I-98, I-99): the old signal was "accepted, with an implementer open", so a lesson recorded after the
// implementer closed (its repairs committed, the attempt waiting for its review) went untracked into the pull-only main
// checkout, and one recorded with an implementer left open at acceptance committed into the worktree and blocked delivery.
function acceptanceHolds(state) {
  const accepted = state.accepted;
  if (!accepted) return false;
  if ((state.implementers ?? []).some((x) => !x.closedAt && x.openedAt > accepted.at)) return false;
  return acceptedTreeStands(state);
}

// Where a lesson of `repoName` is written now, and why: the attempt's worktree of that repo (committed there) while the attempt
// is open and its acceptance does not stand; otherwise the repo's main checkout (a file to commit there). `why` is one of
// attempt, no-attempt, finished (delivered or abandoned), accepted (the accepted tree is frozen), not-admitted (the attempt does
// not hold that repo) and no-worktree (its worktree is gone).
function targetFor(root, cfg, repoName, state) {
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo) throw refuse(`no repo \`${repoName}\` (repos: ${cfg.repos.map((r) => r.name).join(', ')})`);
  const main = (why) => ({ dir: repoDir(root, repo), attempt: null, commit: false, why });
  if (!state) return main('no-attempt');
  if (['done', 'abandoned', 'handoff-pending'].includes(state.phase)) return main('finished');
  const held = state.repos?.[repoName];
  if (!held) return main('not-admitted');
  if (!held.worktree || !fs.existsSync(held.worktree)) return main('no-worktree');
  if (acceptanceHolds(state)) return main('accepted');
  return { dir: held.worktree, attempt: state.id, commit: true, why: 'attempt' };
}

// Named failure (I-112): a lesson for a repository the attempt did not admit (`--repo X` not among its repos, or a project lesson
// whose adapter repo is not) was written into that repo's main checkout as an untracked file even though the attempt was open, so
// it was neither reviewed nor delivered with the ticket, and the report called it "recorded". It is refused with the route;
// without `--attempt` the same lesson is written to the main checkout on purpose. An attempt admitted before 0.7.4 keeps the
// write it always had (D7).
function notAdmitted(state, repoName, project, verb) {
  return refuse(`lesson not ${verb}: ${repoName}${project ? ' (the adapter repo, where a project lesson lives)' : ''} is not part of ${state.id} (its repos: ${Object.keys(state.repos).join(', ')}), so the lesson could not be committed, reviewed or delivered with this attempt, and a file written into ${repoName}'s main checkout would stay untracked there`, `to deliver it with ${state.id}, add the repo first (\`wf criteria amend --file <amendment.json> --reason "<why>" --add-repo ${repoName} --attempt ${state.id}\`) and run this again; to keep it outside the attempt, run it without \`--attempt\` (it is written into ${repoName}'s main checkout, to commit there)`, { id: 'lesson:repo-not-admitted' });
}

function writeLesson(target, l, { create = false, message } = {}) {
  const { file, builtin, where, declaredRepo, home, fileId, ...rest } = l;
  if (rest.scope === 'project') rest.repo = null;
  // I-95: a lesson read as `L-4@api` is written under its own id, never the qualified one.
  if (fileId) rest.id = fileId;
  const out = fileIn(target.dir, rest.id);
  const before = dirProblems(target.dir);
  if (before.length) throw refuse(`lessons not written: ${before.join('; ')}`);
  mkdirStateDirectory(lessonsDir(target.dir), { recursive: true });
  const after = dirProblems(target.dir);
  if (after.length) throw refuse(`lessons not written: ${after.join('; ')}`);
  const folded = `${String(rest.id).normalize('NFC').toLowerCase()}.yaml`;
  const clash = fs.readdirSync(lessonsDir(target.dir)).find((f) => f.normalize('NFC').toLowerCase() === folded && f !== `${rest.id}.yaml`);
  if (clash) throw refuse(`lesson ${rest.id} would collide with ${clash}`);
  const st = fs.lstatSync(out, { throwIfNoEntry: false });
  if (create && st) throw refuse(`lesson ${rest.id} already exists (${out})`);
  if (st && (!st.isFile() || st.nlink > 1)) throw refuse(`${out} is ${st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a hard link' : 'not a regular file'}; not written through`);
  // Named failure (I-49): the layout is the repository's Prettier contract (engine/lessons-format.mjs).
  const existing = create ? null : readRegular(out);
  const { text } = formatLesson(rest, lessonStyle(target.dir, out, existing?.bytes.toString('utf8') ?? null));
  writeNoFollow(out, text, { exclusive: create });
  if (target.commit) {
    const rel = path.relative(target.dir, out).split(path.sep).join('/');
    git(target.dir, ['add', '--', rel]);
    git(target.dir, ['commit', '-q', '-m', message ?? `Lesson ${l.id}: ${l.title}`, '--', rel]);
  }
  return out;
}

// Named failure (I-95): two open attempts each allocated the next id from the lessons they could see, so each added an `L-4`,
// in different repositories. The names of the lesson files in every attempt worktree (.wf-worktrees/<attempt>/<repo>) count as
// taken. Folder names only: no ledger is read, so this costs nothing on a project with long ledgers.
function takenByOpenAttempts(root) {
  const base = path.join(root, '.wf-worktrees');
  const names = [];
  const folders = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  };
  for (const attempt of folders(base)) {
    for (const repo of folders(attempt)) {
      try {
        names.push(...fs.readdirSync(lessonsDir(repo)).map((f) => f.replace(/\.ya?ml$/, '')));
      } catch {}
    }
  }
  return names;
}
const nextId = (lessons, taken = []) => `L-${Math.max(0, ...[...lessons.map((l) => l.fileId ?? l.id), ...taken].map((id) => Number(/^L-(\d+)$/.exec(id)?.[1] ?? 0))) + 1}`;

// Same mechanism kind and a shared tag: the earlier lesson's mechanism did not prevent this.
export const recurrenceOf = (lessons, l) => lessons.filter((x) => x.id !== l.id && !x.builtin && x.status !== 'retired' && x.mechanism?.kind === l.mechanism?.kind && x.tags.some((t) => l.tags.includes(t)));

// The repo a lesson of this attempt concerns, when not given: the only repo, else the attempt's repo with the most
// changed files (a tie, or none changed, is asked).
function defaultRepo(cfg, state) {
  if (cfg.repos.length === 1) return cfg.repos[0].name;
  if (!state) return null;
  const counts = Object.entries(state.repos).map(([name, r]) => [name, git(r.worktree, ['diff', '--name-only', `${r.base}...HEAD`], { allowFail: true }).split('\n').filter(Boolean).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts.length && counts[0][1] > 0 && (counts.length === 1 || counts[0][1] > counts[1][1]) ? counts[0][0] : null;
}

// `wf lesson add --file l.yaml` or flags. Records `lesson.recorded` on the attempt it came from (when given).
export function addLesson(root, options, actorId) {
  const cfg = loadConfig(root);
  const state = options.attempt ? loadState(root, String(options.attempt)) : null;
  const lessons = loadLessons(root, { state });
  let doc = {};
  if (typeof options.file === 'string') doc = YAML.parse(fs.readFileSync(options.file, 'utf8')) ?? {};
  const l = {
    id: doc.id ?? options.id ?? nextId(lessons, takenByOpenAttempts(root)),
    title: doc.title ?? options.title,
    trigger: { what: doc.trigger?.what ?? options.what, attempt: doc.trigger?.attempt ?? options.attempt ?? null, finding: doc.trigger?.finding ?? options.finding ?? null, quote: doc.trigger?.quote ?? options.quote ?? null },
    cause: doc.cause ?? options.cause,
    mechanism: { kind: doc.mechanism?.kind ?? options.mechanism, ref: doc.mechanism?.ref ?? options.ref ?? null, text: doc.mechanism?.text ?? options.text ?? null },
    scope: options.project ? 'project' : doc.scope === 'plugin' || options.scope === 'plugin' ? 'plugin' : doc.scope ?? (options.scope === 'project' ? 'project' : 'repo'),
    status: doc.status ?? options.status ?? 'proposed',
    tags: asList(doc.tags ?? options.tags),
    paths: asList(doc.paths ?? options.paths),
    components: asList(doc.components ?? options.components),
    kinds: asList(doc.kinds ?? options.kinds),
    classes: asList(doc.classes ?? options.classes),
    recurrence: 0,
    created: now(),
  };
  // A finding about the workflow itself is a plugin improvement, never a lesson.
  if (l.scope === 'plugin') return { plugin: true, lesson: l };
  if (l.scope === 'project') l.repo = null;
  else {
    l.repo = doc.repo ?? options.repo ?? defaultRepo(cfg, state);
    if (!l.repo) throw refuse(`which repository does this lesson concern? pass \`--repo <name>\` (${cfg.repos.map((r) => r.name).join(', ')}), or \`--project\` when it spans repos (stored in the adapter repo); it is committed and delivered there`);
  }
  const dup = lessons.find((x) => (x.fileId ?? x.id).toLowerCase() === String(l.id).toLowerCase());
  if (dup) throw refuse(`lesson ${l.id} already exists (in ${dup.repo ?? 'the plugin'}); a recurrence of it is recorded with \`wf lesson recur ${l.id} --attempt <id>\``);
  const problems = validate(l, cfg);
  if (problems.length) throw new WfError(`lesson not recorded:\n  - ${problems.join('\n  - ')}`);
  const recurs = [...new Set([...recurrenceOf(lessons, l).map((x) => x.id), ...asList(options.recurs)])];
  const home = l.repo ?? adapterLocation(root, cfg).repo.name;
  const target = targetFor(root, cfg, home, state);
  if (target.why === 'not-admitted' && obligationSince(state, '0.7.4')) throw notAdmitted(state, home, l.scope === 'project', 'recorded');
  const file = writeLesson(target, l, { create: true });
  if (l.trigger.attempt) append(root, String(l.trigger.attempt), 'lesson.recorded', { id: l.id, repo: l.repo, for: options.for ?? (state?.reopenedFrom ? 'reopen' : 'finding'), file, inAttempt: Boolean(target.attempt) }, actorId);
  const flagged = recurs.map((id) => recur(root, id, l.trigger.attempt, actorId, `new lesson ${l.id}`));
  return { lesson: l, file, recurred: flagged, inAttempt: Boolean(target.attempt), repo: home, scope: l.scope };
}

// The lesson's mechanism failed: it happened again. Recorded on the attempt (`lesson.recurred`) and in the project's learned
// record (engine/learning.mjs), never in the lesson's file: the file's `recurrence` is the count it was committed with.
// Named failure (I-130): a recurrence found at acceptance wrote the lesson file of the pull-only main checkout
// (`targetFor` answers `accepted` or `finished` then), the I-99 class the earlier ledger-only exceptions only narrowed;
// and the ledgers that held the rest are cleaned away with their evidence, so nothing remembered which lesson repeated.
export function recur(root, id, attempt, actorId, why) {
  const state = attempt ? loadState(root, String(attempt)) : null;
  const l = findLesson(loadLessons(root, { state }), id);
  if (!l) throw refuse(`no lesson ${id}`);
  noteLearned(root, { kind: 'repeat', lesson: lessonKey(l), attempt: attempt ? String(attempt) : null, why: why ?? null });
  const recurrence = totalRecurrence(l, lessonStats(root));
  if (attempt) append(root, String(attempt), 'lesson.recurred', { id: l.id, recurrence, why, ledgerOnly: true }, actorId);
  return { id: l.id, recurrence, promote: recurrence >= 2 && l.mechanism?.kind !== 'gate-check' };
}

// The name learning keeps a lesson under: its file id and the repository holding it, whether or not another repository
// holds the same id now (I-95), so its history survives a collision appearing or going away.
export const lessonKey = (l) => `${l.fileId ?? l.id}@${l.home ?? l.repo ?? ''}`;
// A lesson's recurrences: those committed in its file and those learned since.
export const totalRecurrence = (l, stats) => (l.recurrence ?? 0) + (stats.get(lessonKey(l))?.repeats ?? 0);

// The attempt worktree a lesson file lives in while that attempt's acceptance stands: the file is part of the accepted tree.
function frozenSource(state, file) {
  if (!state || ['done', 'abandoned', 'handoff-pending'].includes(state.phase)) return null;
  const held = Object.values(state.repos ?? {}).find((r) => r.worktree && isInside(path.resolve(file), path.resolve(r.worktree)));
  return held && acceptanceHolds(state) ? held : null;
}
// Named failure (I-99 class, found in review): `wf lesson move --attempt` of a lesson that lives in an accepted tree removed the
// file from the worktree (an uncommitted deletion: the tree no longer matched its acceptance, gate or review) while the copy went
// untracked into the other repo's main checkout, and the lesson was then delivered twice. A change to the accepted tree is not
// made behind its back.
function refuseAcceptedSource(state, l, doing = 'moving', verb = 'move') {
  const held = frozenSource(state, l.file);
  if (held && obligationSince(state, '0.7.4')) {
    throw refuse(`lesson ${l.id} is part of ${state.id}'s accepted tree (${path.relative(held.worktree, l.file)}), and ${doing} it would change that tree: \`wf deliver\` refuses a change made after the acceptance`, `${verb} it after the delivery (without \`--attempt\`), or while the work is reopened (an implementer handed for a repair)`, { id: 'lesson:accepted-tree' });
  }
}

// Removes a lesson's file after it moved away. A file that lives in an attempt's worktree is tracked there, so its removal is
// committed with the attempt (the worktree stays clean and the delivered change does not carry the lesson twice); one in a main
// checkout is left to the owner, as every main-checkout change is.
// Named failure (I-99 class): `wf lesson move --attempt` left the source worktree with an uncommitted deletion, and the move
// said it was "committed in the attempt".
function removeLessonFile(state, file, message) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.nlink !== 1) return;
  fs.unlinkSync(file);
  const held = Object.values(state?.repos ?? {}).find((r) => r.worktree && isInside(path.resolve(file), path.resolve(r.worktree)));
  if (!held || ['done', 'abandoned', 'handoff-pending'].includes(state.phase) || acceptanceHolds(state)) return;
  const rel = path.relative(held.worktree, file).split(path.sep).join('/');
  if (git(held.worktree, ['add', '--', rel], { allowFail: true }) !== null) git(held.worktree, ['commit', '-q', '-m', message, '--', rel], { allowFail: true });
}

// `wf lesson move <id> --repo R`: a lesson stored in the wrong repository goes to the one it concerns.
export function moveLesson(root, id, options) {
  const cfg = loadConfig(root);
  const state = options.attempt ? loadState(root, String(options.attempt)) : null;
  const l = findLesson(loadLessons(root, { state }), id);
  if (!l) throw refuse(`no lesson ${id}`);
  if (!l.file) throw refuse(`${id} exists only in a commit; check out a branch that has it first`);
  const project = options.project === true;
  const to = project ? adapterLocation(root, cfg).repo.name : String(options.repo ?? '');
  if (!cfg.repos.some((r) => r.name === to)) throw refuse(`--repo names one of ${cfg.repos.map((r) => r.name).join(', ')} (or --project for a lesson that spans repos)`);
  refuseAcceptedSource(state, l);
  const target = targetFor(root, cfg, to, state);
  if (target.why === 'not-admitted' && obligationSince(state, '0.7.4')) throw notAdmitted(state, to, project, 'moved');
  // Named failure (I-95): a move wrote over a file of the same id in the target repository, hiding the lesson it held.
  const there = fileIn(target.dir, l.fileId);
  const held = path.resolve(there) === path.resolve(l.file) ? null : readRegular(there);
  if (held) {
    const other = YAML.parse(held.bytes.toString('utf8')) ?? {};
    if (other.title !== l.title || other.trigger?.what !== l.trigger?.what) throw refuse(`${to} already holds a different lesson ${l.fileId} (${there}); moving ${l.id} there would overwrite it`, 'rename one of them first (its file name and `id`)');
  }
  const out = writeLesson(target, { ...l, scope: project ? 'project' : 'repo', repo: project ? null : to }, { message: `Lesson ${l.id} moved to ${to}` });
  if (path.resolve(out) !== path.resolve(l.file)) removeLessonFile(state, l.file, `Lesson ${l.id} moved to ${to}`);
  return { id, from: l.file, to: out, inAttempt: Boolean(target.attempt) };
}

export function setLesson(root, id, options) {
  const cfg = loadConfig(root);
  const state = options.attempt ? loadState(root, String(options.attempt)) : null;
  const l = findLesson(loadLessons(root, { state }), id);
  if (!l) throw refuse(`no lesson ${id}`);
  if (options.status) l.status = String(options.status);
  if (options.ref) l.mechanism = { ...l.mechanism, ref: String(options.ref) };
  if (options.mechanism) l.mechanism = { ...l.mechanism, kind: String(options.mechanism) };
  const problems = validate(l, cfg);
  if (problems.length) throw new WfError(`lesson ${id} not changed:\n  - ${problems.join('\n  - ')}`);
  // Independent review of 0.7.4 (I-99 class): `set` on a lesson of the accepted tree wrote a second, untracked copy into the
  // main checkout, and on a lesson of a repo the attempt did not admit it changed a tracked file of that repo's main
  // checkout. Both are refused, as `move` is.
  const target = targetFor(root, cfg, l.home, state);
  if (state) refuseAcceptedSource(state, l, 'changing', 'change');
  if (target.why === 'not-admitted' && obligationSince(state, '0.7.4')) throw notAdmitted(state, l.home, l.scope === 'project', 'changed');
  return { lesson: l, file: writeLesson(target, l, { message: `Lesson ${l.id}: ${l.status}` }) };
}

// The adapter snippet or template text for a lesson's mechanism. Printed only: the owner adds and commits it.
export function applySnippet(l) {
  const id = `lesson-${String(l.id).toLowerCase()}`;
  const paths = l.paths.length ? l.paths : ['**'];
  const text = l.mechanism?.text ?? l.title;
  switch (l.mechanism?.kind) {
    case 'review-rule':
      return { where: `${l.repo ?? 'the adapter'}: .workflow/project.yaml (review.rules) and a rule document`, snippet: `review:\n  rules:\n    - { id: ${id}, ${l.repo ? `repo: ${l.repo}, ` : ''}paths: ${JSON.stringify(paths)}, read: [docs/lessons/${l.id}.md] }\n\n# docs/lessons/${l.id}.md\n# ${l.title}\n${text}\n`, ref: id };
    case 'designSystem-rule':
      return { where: '.workflow/project.yaml (designSystem.rules)', snippet: `designSystem:\n  rules:\n    - { id: ${id}, ${l.repo ? `repo: ${l.repo}, ` : ''}description: ${JSON.stringify(l.title)}, forbidPattern: "<regex an added line must not match>", paths: ${JSON.stringify(paths)} }\n`, ref: id };
    case 'planner-criterion-template':
      return { where: 'the planner appendix (roles.planner.appendix in .workflow/project.yaml)', snippet: `- When a change touches ${paths.join(', ')}${l.repo ? ` in ${l.repo}` : ''}: add a criterion "${text}" with a uat a person can check.\n`, ref: 'roles.planner.appendix' };
    case 'reviewer-checklist':
      return { where: 'the reviewer appendix (roles.reviewer.appendix in .workflow/project.yaml)', snippet: `- ${text} (lesson ${l.id})\n`, ref: 'roles.reviewer.appendix' };
    case 'gate-check':
      return { where: '.workflow/project.yaml (gate.steps)', snippet: `gate:\n  steps:\n    - { id: ${id}, repo: ${l.repo ?? '<repo>'}, run: "<command that fails when this recurs>", inputs: ${JSON.stringify(paths)} }\n`, ref: id };
    default:
      return { where: 'a change or a document in the project', snippet: `${l.title}\n\n${text}\n`, ref: null };
  }
}

// ---- Selection: which lessons each role receives, and why ----

// The ticket's own words: the issue file given at entry and the admitted tracker capture (title, description, labels).
function ticketText(state) {
  const parts = [state.item ?? ''];
  for (const f of [state.issue?.file, ...(state.tracker?.done ?? []).filter((d) => d.event === 'admitted').map((d) => d.capture?.path)]) {
    if (!f) continue;
    const r = readRegular(f);
    if (r) parts.push(r.bytes.toString('utf8').slice(0, 200000));
  }
  return parts.join('\n').toLowerCase();
}

const label = (l) => (l.status === 'enforced' ? `enforced by ${l.mechanism?.kind}${l.mechanism?.ref ? ` (${l.mechanism.ref})` : ''}` : 'advisory (proposed: no mechanism enforces it yet)');

// File kinds a lesson may declare (`kinds: [ui, test]`), from the file's path alone. A file can be of several kinds.
export const FILE_KINDS = ['ui', 'test', 'migration', 'docs', 'script', 'config', 'source'];
export function kindsOf(file) {
  const f = String(file).toLowerCase();
  const base = f.split('/').at(-1);
  const out = new Set();
  if (/\.(test|spec|e2e)\.[a-z0-9]+$/.test(f) || /(^|\/)(__tests__|tests?|e2e|specs?|fixtures?)\//.test(f)) out.add('test');
  if (/(^|\/)migrations?\//.test(f) || /\.migration\.[a-z0-9]+$/.test(f)) out.add('migration');
  if (/\.(md|mdx|rst|adoc|txt)$/.test(f) || /(^|\/)docs?\//.test(f)) out.add('docs');
  if (/\.(sh|bash|zsh|ps1)$/.test(f) || /(^|\/)(scripts?|bin)\//.test(f)) out.add('script');
  if (/^(dockerfile.*|.*\.dockerfile|(docker-)?compose[^/]*\.ya?ml|package\.json|tsconfig[^/]*\.json|\.env.*|makefile)$/.test(base) || /\.(ya?ml|toml|ini|conf)$/.test(f)) out.add('config');
  if (/\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$/.test(f) || /(^|\/)(components?|pages|views|app|styles?)\//.test(f) && /\.(tsx|jsx|ts|js)$/.test(f)) out.add('ui');
  if (/\.(ts|js|mjs|cjs|py|go|rb|java|kt|rs|cs|php|swift|scala|ex|exs)$/.test(f) && !out.has('test') && !out.has('migration')) out.add('source');
  return out;
}

// What a lesson declares about where it applies, in words.
const declaredScope = (l) => [l.repo ? `repo ${l.repo}` : null, l.components.length ? `components ${l.components.join(', ')}` : null, l.paths.length ? `paths ${l.paths.join(', ')}` : null, l.kinds.length ? `kinds ${l.kinds.join(', ')}` : null].filter(Boolean);

// Named failure: UI lessons of one repo were injected into a quick fix that changed only scripts in another repo, because
// a lesson without paths matched any repo admitted to the attempt (and a project lesson without paths matched every
// change); the reviewer had to give each a verdict. A lesson now applies where it declares it does: a changed (or
// planned) file inside its repo, its components, its path globs and its file kinds, all that it declares. A lesson that
// declares none of them matches only by its tags in the ticket (`paths: ["**"]` declares "every change").
function inLessonScope(cfg, l, repo, file) {
  if (l.repo && repo !== l.repo) return false;
  if (l.components.length) {
    if (!repo || !cfg) return false;
    const comps = componentsOf(cfg, repo, file).map((c) => c.id);
    if (!l.components.some((c) => comps.includes(c))) return false;
  }
  if (l.paths.length && !matchesAny(file, l.paths)) return false;
  if (l.kinds.length) {
    const k = kindsOf(file);
    if (!l.kinds.some((x) => k.has(x))) return false;
  }
  return true;
}

// Lessons for a role: every non-retired project lesson (proposed and enforced) whose declared scope this change falls
// in, each with the reasons it matched; the rest are returned under `filtered` with why (never put in a bundle).
// Planner (nothing changed yet): a tag the ticket mentions, a file the plan names that is in the lesson's scope, or the
// lesson's repo (or one of its components' repos) admitted to the attempt. Implementer: a tag, a planned or already
// changed file in scope, and its repo only when that repo is the attempt's only repo or the work item's. Reviewer: a tag,
// or a changed file in scope. Enforced lessons are always kept; the rest are ranked by evidence and capped at CAP, the omitted
// ones listed by id.
export function relevantLessons(root, role, state, changed, { work = null } = {}) {
  let cfg = null;
  try {
    cfg = loadConfig(root);
  } catch {}
  const scope = new Set(Object.keys(state.repos ?? {}));
  const classes = new Set((state.work ?? []).map((w) => w.class));
  const text = ticketText(state);
  const planned = [...(state.plan?.anchors ?? []), ...(state.plan?.tests?.changed ?? [])].map((a) => String(a).split(/[:\s]/)[0]).filter(Boolean);
  const workRepos = new Set(work?.repos ?? []);
  const files = Object.entries(changed ?? {}).flatMap(([r, list]) => (list ?? []).map((f) => [r, f]));
  const matches = [];
  const filtered = [];
  for (const l0 of loadLessons(root, { state })) {
    if (l0.status === 'retired' || l0.scope === 'plugin') continue;
    const l = { ...l0, components: l0.components ?? [], kinds: l0.kinds ?? [] };
    const declared = declaredScope(l);
    if (l.classes?.length && classes.size && !l.classes.some((c) => classes.has(c))) {
      filtered.push({ id: l.id, title: l.title, repo: l.repo ?? null, reason: `its classes (${l.classes.join(', ')}) are not this attempt's (${[...classes].join(', ')})` });
      continue;
    }
    const why = [];
    // `paths: ["**"]` and nothing else: the lesson says it applies to every change.
    const everyChange = !l.repo && !l.components.length && !l.kinds.length && l.paths.length > 0 && l.paths.every((p) => p === '**');
    // Named failure (I-64): `wf lesson add --project` with no tags and no paths, components or kinds could match nothing, ever
    // (the tags were its only selector and it had none), so the project lesson never reached a bundle. A project lesson that
    // narrows itself by nothing applies project-wide.
    const projectWide = isProjectWide(l);
    if (everyChange) why.push('it applies to every change (paths **)');
    else if (projectWide) why.push('it is a project-wide lesson (no narrower scope declared)');
    for (const t of l.tags) if (new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) why.push(`the ticket mentions "${t}"`);
    if (declared.length && !everyChange && role !== 'reviewer') {
      // A planned file has no repo: judged by the lesson's paths and kinds (a lesson declaring only a repo or components
      // is matched by its repos below).
      if (l.paths.length || l.kinds.length) for (const p of planned) if (inLessonScope(null, { ...l, repo: null, components: [] }, null, p)) why.push(`the plan names ${p}`);
      const repos = [...new Set([l.repo, ...(cfg ? l.components.map((c) => cfg.components.find((x) => x.id === c)?.repo) : [])].filter(Boolean))];
      const admitted = repos.filter((r) => scope.has(r));
      if (role === 'planner') for (const r of admitted) why.push(`its repo ${r} is in this attempt`);
      else for (const r of admitted) if (scope.size === 1 || workRepos.has(r)) why.push(workRepos.has(r) ? `its repo ${r} is this work item's` : `its repo ${r} is in this attempt`);
    }
    if (declared.length && !everyChange && role !== 'planner') {
      const hit = files.find(([r, f]) => inLessonScope(cfg, l, r, f));
      if (hit) why.push(`${hit[0]}:${hit[1]} is in its scope (${declared.join('; ')})`);
    }
    if (why.length) matches.push({ l, why: [...new Set(why)] });
    else filtered.push({ id: l.id, title: l.title, repo: l.repo ?? null, reason: !declared.length ? `declares no scope (repo, components, paths or kinds), so only its tags match${l.tags.length ? `, and the ticket mentions none of ${l.tags.join(', ')}` : ', and it has none'}; add \`paths: ["**"]\` if it applies to every change` : role === 'planner' ? `nothing planned is in its scope (${declared.join('; ')})` : `no ${role === 'reviewer' ? 'changed' : 'changed or planned'} file is in its scope (${declared.join('; ')})` });
  }
  // 0.7.9 (D19): ranked by evidence. A lesson whose mistake repeated most recently comes first, then the one that repeated
  // most, then the one carried in the fewest attempts (a lesson carried in many whose mistake never came back has done its work);
  // only enforced lessons are always kept. Named failure (independent review of the 0.7.9 design): every lesson that had
  // recurred once bypassed the cap, so 16 of one project's 70 lessons were carried in every matching bundle whatever their
  // age, and counting recurrences from review findings would only have grown that set.
  const stats = lessonStats(root, { except: state.id });
  const ev = (l) => stats.get(lessonKey(l)) ?? {};
  const must = (m) => m.l.status === 'enforced';
  const order = (a, b) => String(ev(b.l).lastRepeatAt ?? '').localeCompare(String(ev(a.l).lastRepeatAt ?? '')) || totalRecurrence(b.l, stats) - totalRecurrence(a.l, stats) || (ev(a.l).injections ?? 0) - (ev(b.l).injections ?? 0) || String(a.l.id).localeCompare(String(b.l.id), undefined, { numeric: true });
  const kept = matches.filter(must).sort(order);
  const rest = matches.filter((m) => !must(m)).sort(order);
  const chosen = [...kept, ...rest.slice(0, CAP)];
  const omitted = rest.slice(CAP).map((m) => m.l.id);
  return {
    apply: chosen.map(({ l, why }) => ({ id: l.id, title: l.title, repo: l.repo ?? null, cause: l.cause, mechanism: l.mechanism, status: l.status, label: label(l), recurrence: totalRecurrence(l, stats), ...(ev(l).lastRepeatAt ? { lastRepeated: ev(l).lastRepeatAt } : {}), matched: why, what: l.trigger?.what ?? null })),
    omitted,
    more: omitted.length,
    // The learned names of the lessons carried (engine/learning.mjs), for counting; not part of any bundle.
    keys: chosen.map(({ l }) => lessonKey(l)),
    filtered: filtered.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })),
  };
}

// The reviewer's verdict per injected lesson: complied | not-applicable | finding (naming a finding of the closure).
export function lessonVerdicts(injected, closure) {
  const entries = Array.isArray(closure?.lessons) ? closure.lessons : [];
  const findings = new Set((closure?.findings ?? []).map((f) => f.id));
  const problems = [];
  const verdicts = [];
  for (const l of injected ?? []) {
    const e = entries.find((x) => x?.lesson === l.id);
    if (!e) problems.push(`lesson ${l.id} ("${l.title}"): no verdict`);
    else if (!['complied', 'not-applicable', 'finding'].includes(e.verdict)) problems.push(`lesson ${l.id}: verdict must be complied, not-applicable or finding, not \`${e.verdict}\``);
    else if (!String(e.evidence ?? '').trim()) problems.push(`lesson ${l.id}: ${e.verdict} needs evidence`);
    else if (e.verdict === 'finding' && !findings.has(e.finding)) problems.push(`lesson ${l.id}: a finding verdict names a finding id of this closure in \`finding\``);
    else verdicts.push({ lesson: l.id, verdict: e.verdict, evidence: String(e.evidence), finding: e.verdict === 'finding' ? e.finding : null });
  }
  return { problems, verdicts };
}

// The implementer's acknowledgement of each lesson its bundle listed: a commit trailer in the attempt's commits,
// `Lesson <id>: applied - <one line>` or `Lesson <id>: not-applicable - <one line>`.
const ACK = /^Lesson ([A-Za-z0-9][A-Za-z0-9@._-]{0,127}): (applied|not-applicable)\s*[-:—]\s*(\S.*)$/;
export function implementerAcks(state) {
  const listed = [...new Set(state.handoffs.filter((h) => h.role === 'implementer').flatMap((h) => h.lessons ?? []))];
  const found = new Map();
  for (const [name, r] of Object.entries(state.repos)) {
    if (!r.worktree || !fs.existsSync(r.worktree)) continue;
    const log = git(r.worktree, ['log', '--format=%H%n%B%n--wf-end--', `${r.base}..HEAD`], { allowFail: true }) ?? '';
    for (const chunk of log.split('--wf-end--')) {
      const lines = chunk.trim().split('\n');
      const commit = lines[0];
      for (const line of lines.slice(1)) {
        const m = ACK.exec(line.trim());
        if (m && !found.has(m[1])) found.set(m[1], { lesson: m[1], ack: m[2], line: m[3].trim(), repo: name, commit });
      }
    }
  }
  return { listed, acks: listed.map((id) => found.get(id)).filter(Boolean), missing: listed.filter((id) => !found.has(id)) };
}

// A reopened attempt owes a lesson (or an explicit, ledgered reason why not), recorded before its review so the lesson
// is reviewed and delivered with the change.
export const owesLesson = (state) => Boolean(state.reopenedFrom) && !(state.lessons?.recorded?.length || state.lessons?.waived);

export function lessonPrompts(state) {
  const out = [];
  if (owesLesson(state)) out.push(`this attempt reopens ${state.reopenedFrom} ("${state.reopenReason ?? ''}"): record what the project learns before the review (\`wf lesson add --attempt ${state.id} --repo <repo it concerns> --title "..." --what "..." --cause <class> --mechanism <kind> --quote "<the user's words>"\`; it is committed in this attempt and delivered with it) or why there is none (\`wf lesson waive --attempt ${state.id} --reason "..."\`)`);
  for (const f of state.review?.closure?.findings ?? []) if (LESSON_CATEGORIES.has(f.category)) out.push(`finding ${f.id} is a ${f.category} problem: record a lesson (\`wf lesson add --attempt ${state.id} --finding ${f.id} --cause ${f.category} ...\`)`);
  for (const a of state.delivery?.shown?.anomalies ?? []) if (a.followUp) out.push(`anomaly "${a.observation}" has a follow-up: record a lesson if the way we work let it through (\`wf lesson add --attempt ${state.id} ...\`)`);
  return out;
}

export function reviewLessons(root, { after = 10 } = {}) {
  const lessons = loadLessons(root);
  const injected = new Map();
  const ids = listAttempts(root).map((id) => ({ id, entries: readLedger(root, id) })).sort((a, b) => String(a.entries[0]?.at).localeCompare(String(b.entries[0]?.at)));
  const recent = ids.slice(-after);
  for (const a of recent) for (const e of a.entries) if (e.type === 'handoff') for (const l of e.data.lessons ?? []) injected.set(l, (injected.get(l) ?? 0) + 1);
  return {
    promote: lessons.filter((l) => l.status !== 'retired' && l.recurrence >= 2 && l.mechanism?.kind !== 'gate-check'),
    apply: lessons.filter((l) => l.status === 'proposed'),
    retire: recent.length >= after ? lessons.filter((l) => l.status !== 'retired' && !injected.has(l.id) && !injected.has(`${l.fileId}@${l.home}`) && Date.parse(l.created ?? 0) < Date.parse(recent[0]?.entries[0]?.at ?? 0)) : [],
    attempts: recent.length,
  };
}

// Generic issue text for the plugin: the project and repo names, ticket and attempt ids, emails, URLs, absolute paths
// and the project's own forbidden patterns stripped.
function scrubber(root, cfg) {
  const names = [cfg.name, ...cfg.repos.map((r) => r.name), ...cfg.repos.map((r) => path.basename(path.resolve(root, r.path))), path.basename(root)].filter((x) => x && x.length > 2);
  const forbid = [...(cfg.tracker?.commentRules?.forbid ?? []), ...(cfg.lessons?.forbid ?? [])];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = names.length ? new RegExp(`\\b(?:${[...new Set(names)].sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'gi') : null;
  return (text) => {
    let t = String(text ?? '');
    for (const pattern of forbid) {
      try {
        t = t.replace(new RegExp(pattern, 'gi'), '<redacted>');
      } catch {
        t = t.split(pattern).join('<redacted>');
      }
    }
    t = t.replace(/\bhttps?:\/\/\S+/g, '<url>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').replace(/(?:~|\/(?:Users|home|private|var|tmp|opt))\/\S*/g, '<path>');
    t = t.replace(/\b[A-Z][A-Z0-9]+-\d+(?:\.\d+)?\b/g, '<ticket>');
    if (nameRe) t = t.replace(nameRe, '<project>');
    return t;
  };
}
export function pluginIssueText(root, cfg, l) {
  const scrub = scrubber(root, cfg);
  return `## ${scrub(l.title)}\n\n**What happened:** ${scrub(l.trigger?.what)}\n\n**Cause class:** ${l.cause}\n\n**Proposed mechanism:** ${l.mechanism?.kind}${l.mechanism?.text ? ` — ${scrub(l.mechanism.text)}` : ''}\n\n**Recurrences so far:** ${l.recurrence ?? 0}\n`;
}
// Plugin-scope lessons still stored in a project (from before 0.3.0), as issue text.
export function exportPluginLessons(root, cfg) {
  return loadLessons(root).filter((l) => l.scope === 'plugin' && l.status !== 'retired').map((l) => ({ id: l.id, text: pluginIssueText(root, cfg, l) }));
}

// `wf lesson move <id> --improvement`: a lesson about the workflow itself goes to the user's improvements inbox (its
// text sanitised) and leaves the project.
export async function lessonToImprovement(root, id, options) {
  const cfg = loadConfig(root);
  const state = options.attempt ? loadState(root, String(options.attempt)) : null;
  const l = findLesson(loadLessons(root, { state }), id);
  if (!l) throw refuse(`no lesson ${id}`);
  if (!l.file) throw refuse(`${id} exists only in a commit; check out a branch that has it first`);
  refuseAcceptedSource(state, l);
  const { addImprovement } = await import('./improve.mjs');
  const names = [cfg.name, ...cfg.repos.map((r) => r.name), ...cfg.repos.map((r) => path.basename(path.resolve(root, r.path))), path.basename(root)];
  const r = addImprovement({ title: l.title, what: l.trigger?.what ?? l.title, class: String(options.class ?? 'other'), 'observed-in': l.trigger?.attempt ?? null, quote: l.trigger?.quote ?? null }, names);
  removeLessonFile(state, l.file, `Lesson ${l.id} moved to the improvement inbox`);
  return { id, improvement: r.item.id, file: r.file, removed: l.file };
}

// ---- Learning (0.7.9, D19) ----

// At review acceptance the classifier labels what this attempt taught (engine/learning.mjs). Each finding any round raised
// (a verified non-issue is no mistake) gets the lesson whose mistake it repeats, or none. Each lesson this attempt recorded,
// and each lesson never compared yet (once, so a project's existing lessons are consolidated too), gets another lesson that
// describes the same mistake, or none. A repeat counts as the lesson's recurrence, once per lesson per attempt as a
// reviewer's `finding` verdict does; "the same mistake" becomes a merge the owner makes in an attempt (`wf lesson merge`),
// reviewed and delivered like any lesson. Labels only rank lessons: nothing is refused or asked because of one.
// Named failure: 70 lessons of one project were all `proposed`, 16 had recurred and none had ever been curated, because the
// counting waited for a reviewer to volunteer a verdict and the merging, promoting and retiring waited for a person.
export function learnFromReview(root, state, actorId) {
  let cfg;
  try {
    cfg = trustedAdapter(root, state);
  } catch {
    return null;
  }
  const c = classifierFor(cfg, defaultRuntime(state) ?? defaultHostId());
  if (!c) return null;
  const lessons = liveLessons(loadLessons(root, { state }));
  if (!lessons.length) return null;
  const refs = new Set();
  const findings = [];
  for (const r of recordedRoundsOf(state)) {
    for (const f of r.closure?.findings ?? []) {
      const ref = refOf(r.closure?.reviewer ?? r.reviewer, f.id);
      if (f.status === 'verified-nonissue' || refs.has(ref)) continue;
      refs.add(ref);
      findings.push({ ref, text: [f.summary, f.family ? `family ${f.family}` : null, f.category ? `category ${f.category}` : null].filter(Boolean).join('; ') });
    }
  }
  const recorded = new Set((state.lessons?.recorded ?? []).map((x) => String(x.id)));
  const isNew = (l) => recorded.has(String(l.fileId ?? l.id));
  const checked = checkedLessons(root);
  const fresh = lessons.filter((l) => isNew(l) || !checked.has(lessonKey(l)));
  if (!findings.length && !fresh.length) return null;
  const about = (l) => `${l.title}${l.trigger?.what ? ` (${l.trigger.what})` : ''}`;
  const items = [...findings.map((f, i) => ({ key: `F${i + 1}`, text: `a review finding: ${f.text}`, ref: f.ref })), ...fresh.map((l, i) => ({ key: `N${i + 1}`, text: `the lesson ${l.id}: ${about(l)}`, not: l.id, lesson: l }))];
  const res = classify(c, {
    goal: "You match a software project's review findings and lessons to its lessons. For each item, choose the lesson that describes the same mistake: following that lesson would have prevented the item. Choose none when no lesson does; a lesson about the same area but a different mistake is none. A lesson item never chooses itself.",
    choices: [{ id: 'none', text: 'no lesson below describes the same mistake' }, ...lessons.map((l) => ({ id: l.id, text: about(l) }))],
    items: items.map(({ key, text, not }) => ({ key, text, not })),
  });
  const labels = res.labels ?? {};
  const event = { runtime: c.runtime, model: res.model ?? c.model, ms: res.ms ?? null, ...(typeof res.costUsd === 'number' ? { costUsd: res.costUsd } : {}), ...(res.error ? { error: res.error } : {}), findings: Object.fromEntries(items.filter((i) => i.ref).map((i) => [i.ref, labels[i.key] ?? null])), lessons: Object.fromEntries(items.filter((i) => i.lesson).map((i) => [i.lesson.id, labels[i.key] ?? null])) };
  append(root, state.id, 'lessons.labelled', event, actorId);
  if (res.error) return { ...event, repeated: [] };
  const compared = items.filter((i) => i.lesson && labels[i.key]).map((i) => lessonKey(i.lesson));
  if (compared.length) noteLearned(root, { kind: 'checked', lessons: compared, attempt: state.id });
  const already = new Set((loadState(root, state.id).lessons?.recurred ?? []).map((x) => x.id));
  const repeated = [];
  for (const it of items) {
    const to = labels[it.key];
    if (!to || to === 'none') continue;
    // A lesson this attempt recorded is its findings' lesson, not a repeat of them (independent review of 0.7.9: the owner
    // records a lesson from a finding, and that finding then counted as the new lesson's first recurrence).
    if (it.ref && isNew(lessons.find((l) => l.id === to))) continue;
    if (it.lesson) noteLearned(root, { kind: 'same', lesson: lessonKey(it.lesson), as: lessonKey(lessons.find((l) => l.id === to)), attempt: state.id });
    // An older lesson that describes the same mistake as another is a merge to make, not a new occurrence of it.
    if (it.lesson && !isNew(it.lesson)) continue;
    if (already.has(to)) continue;
    recur(root, to, state.id, actorId, it.ref ? `classifier (${event.model ?? c.runtime}): review finding ${it.ref} repeats it` : `classifier (${event.model ?? c.runtime}): new lesson ${it.lesson.id} describes the same mistake`);
    already.add(to);
    repeated.push(to);
  }
  return { ...event, repeated };
}

// The lessons learning compares: not retired, not the plugin's, and not merged into another (a merge an open attempt made
// retires its members only when it is delivered, so the attempt's own merged lesson names them).
function liveLessons(all) {
  const mergedAway = new Set(all.filter((l) => l.status !== 'retired').flatMap((l) => l.merged ?? []).map(String));
  return all.filter((l) => l.status !== 'retired' && l.scope !== 'plugin' && !l.builtin && !mergedAway.has(String(l.fileId ?? l.id)) && !mergedAway.has(l.id));
}

// Groups of live lessons the classifier labelled as one mistake: each a merge to make (`wf lesson merge`).
export function mergeSuggestions(root, { state = null } = {}) {
  let lessons;
  try {
    lessons = liveLessons(loadLessons(root, { state }));
  } catch {
    return [];
  }
  const idOf = new Map(lessons.map((l) => [lessonKey(l), l.id]));
  const live = new Set(idOf.keys());
  const parent = new Map();
  const find = (x) => {
    while (parent.has(x)) x = parent.get(x);
    return x;
  };
  // Lessons an attempt has merged already (its merge applies once delivered; an abandoned one's never does), and pairs the
  // owner said are different mistakes (`wf lesson distinct`).
  const merging = new Set();
  const status = new Map();
  for (const f of learnedFacts(root).filter((x) => x.kind === 'merged')) {
    if (!status.has(f.attempt)) {
      try {
        status.set(f.attempt, loadState(root, String(f.attempt)).phase);
      } catch {
        status.set(f.attempt, 'unknown');
      }
    }
    if (status.get(f.attempt) !== 'abandoned') for (const m of f.members ?? []) merging.add(m);
  }
  const apart = new Set(learnedFacts(root).filter((x) => x.kind === 'distinct').flatMap((x) => (x.lessons ?? []).flatMap((a) => (x.lessons ?? []).map((b) => `${a}\n${b}`))));
  for (const { lesson, as } of sameMistakes(root)) {
    if (!live.has(lesson) || !live.has(as) || merging.has(lesson) || merging.has(as) || apart.has(`${lesson}\n${as}`)) continue;
    const a = find(lesson);
    const b = find(as);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map();
  for (const id of live) if (parent.has(id) || [...parent.values()].includes(id)) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const byId = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.map((k) => idOf.get(k)).sort(byId)).sort((a, b) => byId(a[0], b[0]));
}

// Whether these lessons can be merged in this attempt now: it holds every member's repository (and the merged lesson's),
// is open, and its acceptance does not stand. `wf resume` proposes a merge only where it can be made.
export function mergeableIn(root, state, ids) {
  try {
    const cfg = loadConfig(root);
    const all = loadLessons(root, { state });
    const members = ids.map((id) => findLesson(all, id));
    if (members.some((m) => !m)) return false;
    const repos = [...new Set(members.map((m) => m.repo ?? null))];
    const home = repos.length === 1 && repos[0] ? repos[0] : adapterLocation(root, cfg).repo.name;
    return [home, ...members.map((m) => m.home)].every((repo) => targetFor(root, cfg, repo, state).why === 'attempt');
  } catch {
    return false;
  }
}

// `wf lesson distinct <ids...>`: the owner says the classifier was wrong, these lessons are different mistakes; no merge of
// them is proposed again. A learned fact only: nothing in any repository changes.
export function distinctLessons(root, ids, { state = null } = {}) {
  // A lesson recorded in an open attempt lives in its worktree until delivered: read with that attempt (`--attempt`).
  const all = loadLessons(root, { state });
  const members = [...new Set((ids ?? []).map(String))].map((id) => findLesson(all, id) ?? (() => { throw refuse(`no lesson ${id}`); })());
  if (members.length < 2) throw refuse('name two or more lessons: `wf lesson distinct <id> <id>...`');
  noteLearned(root, { kind: 'distinct', lessons: members.map(lessonKey) });
  return { lessons: members.map((m) => m.id) };
}

// `wf lesson merge <ids...> --title "..." --attempt <id>`: lessons that describe one mistake become one lesson, written and
// committed in the attempt's worktree (reviewed and delivered with it, so `git revert` undoes it). The new lesson carries
// the members' scope (their tags, paths, components and kinds together; classes only when every member names some) and
// their recurrences summed; each member is retired with `mergedInto`. A lesson at the base keeps applying until the merge
// is delivered: a ticket never drops a lesson behind its review.
export function mergeLessons(root, ids, options, actorId) {
  if (!options.attempt) throw refuse('a merge is committed with an attempt and reviewed and delivered with it: pass `--attempt <id>`');
  const cfg = loadConfig(root);
  const state = loadState(root, String(options.attempt));
  const all = loadLessons(root, { state });
  const members = [];
  for (const id of new Set((ids ?? []).map(String))) {
    const m = findLesson(all, id);
    if (!m) throw refuse(`no lesson ${id}`);
    if (m.status === 'retired') throw refuse(`lesson ${m.id} is retired${m.mergedInto ? ` (merged into ${m.mergedInto})` : ''}`);
    if (m.status === 'enforced') throw refuse(`lesson ${m.id} is enforced by ${m.mechanism?.ref ?? 'its mechanism'}; merge proposed lessons only, so no enforcement is lost`);
    members.push(m);
  }
  if (members.length < 2) throw refuse('a merge takes two or more lessons: `wf lesson merge <id> <id>... --title "<the one mistake>" --attempt <id>`');
  const title = String(options.title ?? '').trim();
  if (!title) throw refuse('`--title` says in one line the one mistake these lessons describe');
  const one = (key, flag) => {
    const values = [...new Set(members.map((m) => (key === 'kind' ? m.mechanism?.kind : m[key])))];
    if (options[flag]) return String(options[flag]);
    if (values.length === 1) return values[0];
    throw refuse(`these lessons differ in ${flag} (${values.join(', ')}): pass \`--${flag} <one>\``);
  };
  const cause = one('cause', 'cause');
  const kind = one('kind', 'mechanism');
  const repos = [...new Set(members.map((m) => m.repo ?? null))];
  const scope = repos.length === 1 && repos[0] ? 'repo' : 'project';
  const union = (k) => [...new Set(members.flatMap((m) => m[k] ?? []))];
  const stats = lessonStats(root);
  const l = {
    id: options.id ?? nextId(all, takenByOpenAttempts(root)),
    title,
    // What happened, in the members' own words (what every bundle shows); the members' ids are in `merged`.
    trigger: { what: options.what ?? [...new Set(members.map((m) => String(m.trigger?.what ?? '').trim()).filter(Boolean))].join('; '), attempt: state.id, finding: null, quote: null },
    cause,
    mechanism: { kind, ref: null, text: null },
    scope,
    status: 'proposed',
    tags: union('tags'),
    paths: union('paths'),
    components: union('components'),
    kinds: union('kinds'),
    classes: members.every((m) => (m.classes ?? []).length) ? union('classes') : [],
    recurrence: members.reduce((n, m) => n + totalRecurrence(m, stats), 0),
    merged: members.map((m) => m.id),
    created: now(),
    repo: scope === 'repo' ? repos[0] : null,
  };
  const problems = validate(l, cfg);
  if (problems.length) throw new WfError(`lessons not merged:\n  - ${problems.join('\n  - ')}`);
  const home = l.repo ?? adapterLocation(root, cfg).repo.name;
  const committed = (repo, what) => {
    const t = targetFor(root, cfg, repo, state);
    if (t.why !== 'attempt') throw refuse(`lessons not merged: ${what} would be written into ${repo}'s ${t.why === 'not-admitted' ? 'main checkout (the attempt does not hold that repo)' : `main checkout (${t.why})`}, outside ${state.id}'s review`, t.why === 'not-admitted' ? `add the repo first (\`wf criteria amend --file <amendment.json> --reason "<why>" --add-repo ${repo} --attempt ${state.id}\`)` : 'merge while the attempt is open and its acceptance does not stand (before the review, or while the work is reopened)', { id: 'lesson:merge-outside-attempt' });
    return t;
  };
  const target = committed(home, `lesson ${l.id}`);
  const targets = members.map((m) => [m, committed(m.home, `lesson ${m.id}`)]);
  for (const m of members) refuseAcceptedSource(state, m, 'merging', 'merge');
  const file = writeLesson(target, l, { create: true, message: `Lesson ${l.id}: ${l.title} (merges ${l.merged.join(', ')})` });
  for (const [m, t] of targets) writeLesson(t, { ...m, status: 'retired', mergedInto: l.id }, { message: `Lesson ${m.id} merged into ${l.id}` });
  append(root, state.id, 'lesson.merged', { id: l.id, repo: l.repo, merged: l.merged, file }, actorId);
  // The members were compared already; the merged lesson is their sum, so it needs no comparison of its own. It inherits
  // their ranking evidence (when their mistake last repeated, where they were carried): engine/learning.mjs lessonStats.
  noteLearned(root, { kind: 'checked', lessons: [lessonKey({ ...l, home })], attempt: state.id });
  noteLearned(root, { kind: 'merged', lesson: lessonKey({ ...l, home }), members: members.map(lessonKey), attempt: state.id });
  return { lesson: l, file, merged: l.merged };
}
