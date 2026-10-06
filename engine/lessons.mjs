// Lessons: the project's learning path (docs/LESSONS.md). Capture, apply, inject, feedback, export. The engine never
// edits the adapter or an instruction file to enforce a lesson: it prints what to add, and the owner commits it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_DIR, adapterLocation, loadConfig, repoDir } from './config.mjs';
import { readRegular, writeNoFollow } from './evidence.mjs';
import { canonical, isInside, touchesEvidence } from './paths.mjs';
import { append, listAttempts, loadState, readLedger } from './ledger.mjs';
import { WfError, YAML, matchesAny, now, refuse } from './util.mjs';

export const CAUSES = ['process', 'tooling', 'criteria', 'review', 'test', 'design-system', 'other'];
export const MECHANISMS = ['review-rule', 'designSystem-rule', 'planner-criterion-template', 'reviewer-checklist', 'gate-check', 'engine-change', 'doc'];
const STATUSES = ['proposed', 'enforced', 'retired'];
const SCOPES = ['project', 'plugin'];
// Finding categories that mean "the way we work let this through": each prompts a lesson.
export const LESSON_CATEGORIES = new Set(['process', 'tooling', 'criteria', 'review', 'test', 'design-system', 'precedent-only']);
export const CAP = 5;

export const lessonsDir = (root) => path.join(root, ADAPTER_DIR, 'lessons');
// Named finding (0.2.0 review): a lesson id became a path. Ids are a strict allowlist; the file is named by its id (and
// an id is only ever taken from a file's name, never from its content); the folder must be a real folder that really
// lies in the adapter repo and outside the evidence; files are read and written without following links, never through
// a hard link.
export const LESSON_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const fileOf = (root, id) => {
  if (!LESSON_ID.test(String(id))) throw refuse(`invalid lesson id \`${String(id).slice(0, 80)}\`: letters, digits and dashes, starting with a letter or digit, at most 64 characters`);
  return path.join(lessonsDir(root), `${id}.yaml`);
};

// The lessons folder, checked: problems (empty when it is fine or absent).
function dirProblems(root) {
  const dir = lessonsDir(root);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [`${dir} is ${st.isSymbolicLink() ? 'a symlink' : 'not a folder'}; lessons are not read or written through it`];
  const out = [];
  if (touchesEvidence(dir)) out.push(`${dir} resolves into .wf-evidence/`);
  let repo = null;
  try {
    const cfg = loadConfig(root);
    repo = repoDir(root, adapterLocation(root, cfg).repo);
  } catch {}
  if (repo && !isInside(canonical(dir), canonical(repo))) out.push(`${dir} really lies outside the adapter repo (${canonical(dir)})`);
  return out;
}
const lessonProblems = new Map();
export const lessonWarnings = (root) => lessonProblems.get(root) ?? [];
const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(',').map((x) => x.trim()).filter(Boolean));

// Lessons the plugin ships (scope plugin, enforced through its own templates): listed with the project's, never
// injected (`inject: false`: the mechanism is already in every role file), never written by a project.
const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lessons');
// Each `<id>.yaml` whose name is a valid id, read without following a link (a regular file with one name), whose
// content's `id` (if any) matches its name. Anything else is skipped and reported.
function readDir(dir, extra = {}, problems = []) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/\.ya?ml$/.test(e.name)) continue;
    const id = e.name.replace(/\.ya?ml$/, '');
    const p = path.join(dir, e.name);
    if (!LESSON_ID.test(id)) {
      problems.push(`${p}: not a valid lesson file name (skipped)`);
      continue;
    }
    if (!e.isFile()) {
      problems.push(`${p}: ${e.isSymbolicLink() ? 'a symlink' : 'not a regular file'} (skipped)`);
      continue;
    }
    const r = readRegular(p);
    if (!r) {
      problems.push(`${p}: not a regular file with one name (a hard link?) (skipped)`);
      continue;
    }
    let l;
    try {
      l = YAML.parse(r.bytes.toString('utf8')) ?? {};
    } catch (error) {
      problems.push(`${p}: not YAML (${error.message.split('\n')[0]}) (skipped)`);
      continue;
    }
    if (l.id !== undefined && String(l.id) !== id) {
      problems.push(`${p}: its id \`${String(l.id).slice(0, 80)}\` differs from its file name (skipped)`);
      continue;
    }
    out.push({ ...l, ...extra, id, recurrence: Number(l.recurrence ?? 0), tags: asList(l.tags), paths: asList(l.paths), file: p });
  }
  return out;
}

export function loadLessons(root, { builtin = true } = {}) {
  const problems = dirProblems(root);
  const own = problems.length ? [] : readDir(lessonsDir(root), {}, problems);
  lessonProblems.set(root, problems);
  const shipped = builtin ? readDir(BUILTIN, { builtin: true }).filter((b) => !own.some((l) => l.id === b.id)) : [];
  return [...own, ...shipped];
}

function validate(l) {
  const p = [];
  if (!LESSON_ID.test(String(l.id ?? ''))) p.push('`id` must be letters, digits and dashes, starting with a letter or digit, at most 64 characters');
  if (!String(l.title ?? '').trim()) p.push('`title` says in one line what the project learned');
  if (!String(l.trigger?.what ?? '').trim()) p.push('`trigger.what` says what happened and where it was seen');
  if (!CAUSES.includes(l.cause)) p.push(`\`cause\` is one of ${CAUSES.join(', ')}`);
  if (!MECHANISMS.includes(l.mechanism?.kind)) p.push(`\`mechanism.kind\` is one of ${MECHANISMS.join(', ')}`);
  if (!SCOPES.includes(l.scope)) p.push(`\`scope\` is project or plugin`);
  if (!STATUSES.includes(l.status)) p.push(`\`status\` is one of ${STATUSES.join(', ')}`);
  if (l.status === 'enforced' && !String(l.mechanism?.ref ?? '').trim()) p.push('an enforced lesson names its mechanism: `mechanism.ref` (the rule id, step id or document that enforces it; `wf lesson apply <id>` prints what to add)');
  return p;
}

function writeLesson(root, l, { create = false } = {}) {
  const { file, builtin, ...rest } = l;
  const target = fileOf(root, l.id);
  const before = dirProblems(root);
  if (before.length) throw refuse(`lessons not written: ${before.join('; ')}`);
  fs.mkdirSync(lessonsDir(root), { recursive: true });
  const after = dirProblems(root);
  if (after.length) throw refuse(`lessons not written: ${after.join('; ')}`);
  // Case and Unicode variants of an id name the same file on a case-insensitive volume: one id per folded name.
  const folded = `${String(l.id).normalize('NFC').toLowerCase()}.yaml`;
  const clash = fs.readdirSync(lessonsDir(root)).find((f) => f.normalize('NFC').toLowerCase() === folded && f !== `${l.id}.yaml`);
  if (clash) throw refuse(`lesson ${l.id} would collide with ${clash}`);
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (create && st) throw refuse(`lesson ${l.id} already exists (${target})`);
  if (st && (!st.isFile() || st.nlink > 1)) throw refuse(`${target} is ${st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a hard link' : 'not a regular file'}; not written through`);
  writeNoFollow(target, YAML.stringify(rest), { exclusive: create });
  return target;
}

const nextId = (lessons) => `L-${Math.max(0, ...lessons.map((l) => Number(/^L-(\d+)$/.exec(l.id)?.[1] ?? 0))) + 1}`;

// Same mechanism kind and a shared tag: the earlier lesson's mechanism did not prevent this.
export const recurrenceOf = (lessons, l) => lessons.filter((x) => x.id !== l.id && x.status !== 'retired' && x.mechanism?.kind === l.mechanism?.kind && x.tags.some((t) => l.tags.includes(t)));

// `wf lesson add --file l.yaml` or flags. Records `lesson.recorded` on the attempt it came from (when given).
export function addLesson(root, options, actorId) {
  const lessons = loadLessons(root);
  let doc = {};
  if (lessons.some((x) => x.builtin && x.id === (options.id ?? null))) throw refuse(`${options.id} is a lesson the plugin ships; record a recurrence instead`);
  if (typeof options.file === 'string') doc = YAML.parse(fs.readFileSync(options.file, 'utf8')) ?? {};
  const l = {
    id: doc.id ?? options.id ?? nextId(lessons),
    title: doc.title ?? options.title,
    trigger: { what: doc.trigger?.what ?? options.what, attempt: doc.trigger?.attempt ?? options.attempt ?? null, finding: doc.trigger?.finding ?? options.finding ?? null, quote: doc.trigger?.quote ?? options.quote ?? null },
    cause: doc.cause ?? options.cause,
    mechanism: { kind: doc.mechanism?.kind ?? options.mechanism, ref: doc.mechanism?.ref ?? options.ref ?? null, text: doc.mechanism?.text ?? options.text ?? null },
    scope: doc.scope ?? options.scope ?? 'project',
    status: doc.status ?? options.status ?? 'proposed',
    tags: asList(doc.tags ?? options.tags),
    paths: asList(doc.paths ?? options.paths),
    classes: asList(doc.classes ?? options.classes),
    recurrence: 0,
    created: now(),
  };
  if (lessons.some((x) => String(x.id).toLowerCase() === String(l.id).toLowerCase())) throw refuse(`lesson ${l.id} already exists (${fileOf(root, l.id)}); a recurrence of it is recorded with \`wf lesson recur ${l.id} --attempt <id>\``);
  const problems = validate(l);
  if (problems.length) throw new WfError(`lesson not recorded:\n  - ${problems.join('\n  - ')}`);
  const recurs = [...new Set([...recurrenceOf(lessons, l).map((x) => x.id), ...asList(options.recurs)])];
  const file = writeLesson(root, l, { create: true });
  if (l.trigger.attempt) append(root, String(l.trigger.attempt), 'lesson.recorded', { id: l.id, for: options.for ?? (loadState(root, String(l.trigger.attempt)).reopenedFrom ? 'reopen' : 'finding'), file }, actorId);
  const flagged = recurs.map((id) => recur(root, id, l.trigger.attempt, actorId, `new lesson ${l.id}`));
  return { lesson: l, file, recurred: flagged };
}

// The lesson's mechanism failed: it happened again. Recorded on the lesson (its counter) and on the attempt.
export function recur(root, id, attempt, actorId, why) {
  const l = loadLessons(root).find((x) => x.id === id);
  if (!l) throw refuse(`no lesson ${id}`);
  l.recurrence = (l.recurrence ?? 0) + 1;
  // A shipped lesson's counter lives in the project: a copy is written there on its first recurrence.
  writeLesson(root, { ...l, builtin: undefined });
  if (attempt) append(root, String(attempt), 'lesson.recurred', { id, recurrence: l.recurrence, why }, actorId);
  return { id, recurrence: l.recurrence, promote: l.recurrence >= 2 && l.mechanism?.kind !== 'gate-check' };
}

export function setLesson(root, id, options) {
  const l = loadLessons(root).find((x) => x.id === id);
  if (!l) throw refuse(`no lesson ${id}`);
  if (l.builtin) throw refuse(`${id} is a lesson the plugin ships; it is changed in the plugin, not here`);
  if (options.status) l.status = String(options.status);
  if (options.ref) l.mechanism = { ...l.mechanism, ref: String(options.ref) };
  if (options.mechanism) l.mechanism = { ...l.mechanism, kind: String(options.mechanism) };
  const problems = validate(l);
  if (problems.length) throw new WfError(`lesson ${id} not changed:\n  - ${problems.join('\n  - ')}`);
  return { lesson: l, file: writeLesson(root, l) };
}

// The adapter snippet or template text for a lesson's mechanism. Printed only: the owner adds and commits it.
export function applySnippet(l) {
  const id = `lesson-${String(l.id).toLowerCase()}`;
  const paths = l.paths.length ? l.paths : ['**'];
  const text = l.mechanism?.text ?? l.title;
  switch (l.mechanism?.kind) {
    case 'review-rule':
      return { where: '.workflow/project.yaml (review.rules) and a rule document', snippet: `review:\n  rules:\n    - { id: ${id}, paths: ${JSON.stringify(paths)}, read: [docs/lessons/${l.id}.md] }\n\n# docs/lessons/${l.id}.md\n# ${l.title}\n${text}\n`, ref: id };
    case 'designSystem-rule':
      return { where: '.workflow/project.yaml (designSystem.rules)', snippet: `designSystem:\n  rules:\n    - { id: ${id}, description: ${JSON.stringify(l.title)}, forbidPattern: "<regex an added line must not match>", paths: ${JSON.stringify(paths)} }\n`, ref: id };
    case 'planner-criterion-template':
      return { where: 'the planner appendix (roles.planner.appendix in .workflow/project.yaml)', snippet: `- When a change touches ${paths.join(', ')}: add a criterion "${text}" with a uat a person can check.\n`, ref: 'roles.planner.appendix' };
    case 'reviewer-checklist':
      return { where: 'the reviewer appendix (roles.reviewer.appendix in .workflow/project.yaml)', snippet: `- ${text} (lesson ${l.id})\n`, ref: 'roles.reviewer.appendix' };
    case 'gate-check':
      return { where: '.workflow/project.yaml (gate.steps)', snippet: `gate:\n  steps:\n    - { id: ${id}, repo: <repo>, run: "<command that fails when this recurs>", inputs: ${JSON.stringify(paths)} }\n`, ref: id };
    case 'engine-change':
    case 'doc':
    default:
      return { where: l.scope === 'plugin' ? 'an issue for the plugin (`wf lesson export --plugin`)' : 'a change or a document in the project', snippet: `${l.title}\n\n${text}\n`, ref: null };
  }
}

// Lessons for this change: not retired; with paths, only when a changed file matches; with classes, only for those.
export function relevantLessons(root, role, state, changed) {
  const files = Object.values(changed ?? {}).flat();
  const classes = new Set((state.work ?? []).map((w) => w.class));
  const all = loadLessons(root).filter((l) => l.status !== 'retired' && l.inject !== false).filter((l) => {
    if (l.classes?.length && classes.size && !l.classes.some((c) => classes.has(c))) return false;
    if (!l.paths.length) return true;
    if (role === 'planner') return true; // nothing is changed yet: the planner sees every lesson with paths too
    return files.some((f) => matchesAny(f, l.paths));
  }).sort((a, b) => b.recurrence - a.recurrence || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return {
    apply: all.slice(0, CAP).map((l) => ({ id: l.id, title: l.title, cause: l.cause, mechanism: l.mechanism, status: l.status, recurrence: l.recurrence, why: l.trigger?.what ?? null })),
    more: Math.max(0, all.length - CAP),
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

// A reopened attempt owes a lesson (or an explicit, ledgered reason why not) before its delivery handoff closes.
export const owesLesson = (state) => Boolean(state.reopenedFrom) && !(state.lessons?.recorded?.length || state.lessons?.waived);

// What the owner is prompted to record (never required except for a reopen).
export function lessonPrompts(state) {
  const out = [];
  if (owesLesson(state)) out.push(`this attempt reopens ${state.reopenedFrom} ("${state.reopenReason ?? ''}"): record what the project learns (\`wf lesson add --attempt ${state.id} --title "..." --what "..." --cause <class> --mechanism <kind> --quote "<the user's words>"\`) or why there is none (\`wf lesson waive --attempt ${state.id} --reason "..."\`); its delivery does not close until then`);
  for (const f of state.review?.closure?.findings ?? []) if (LESSON_CATEGORIES.has(f.category)) out.push(`finding ${f.id} is a ${f.category} problem: record a lesson (\`wf lesson add --attempt ${state.id} --finding ${f.id} --cause ${f.category} ...\`)`);
  for (const a of state.delivery?.shown?.anomalies ?? []) if (a.followUp) out.push(`anomaly "${a.observation}" has a follow-up: record a lesson if the way we work let it through (\`wf lesson add --attempt ${state.id} ...\`)`);
  return out;
}

// For `wf lesson review`: promote (recurred twice), apply (proposed, no mechanism ref), retire (injected into none of
// the last N attempts that had any lessons injected at all).
export function reviewLessons(root, { after = 10 } = {}) {
  const lessons = loadLessons(root);
  const injected = new Map();
  const ids = listAttempts(root).map((id) => ({ id, entries: readLedger(root, id) })).sort((a, b) => String(a.entries[0]?.at).localeCompare(String(b.entries[0]?.at)));
  const recent = ids.slice(-after);
  for (const a of recent) for (const e of a.entries) if (e.type === 'handoff') for (const l of e.data.lessons ?? []) injected.set(l, (injected.get(l) ?? 0) + 1);
  return {
    promote: lessons.filter((l) => l.status !== 'retired' && l.recurrence >= 2 && l.mechanism?.kind !== 'gate-check'),
    apply: lessons.filter((l) => l.status === 'proposed'),
    retire: recent.length >= after ? lessons.filter((l) => l.status !== 'retired' && !injected.has(l.id) && Date.parse(l.created ?? 0) < Date.parse(recent[0]?.entries[0]?.at ?? 0)) : [],
    attempts: recent.length,
  };
}

// Plugin-scope lessons as generic issue text. Stripped: the project and repo names, the owner and agent ids, ticket and
// attempt ids, email addresses, URLs, absolute paths and repository paths, and the project's own forbidden patterns.
export function exportPluginLessons(root, cfg) {
  const names = [cfg.name, ...cfg.repos.map((r) => r.name), ...cfg.repos.map((r) => path.basename(path.resolve(root, r.path))), path.basename(root)].filter((x) => x && x.length > 2);
  const forbid = [...(cfg.tracker?.commentRules?.forbid ?? []), ...(cfg.lessons?.forbid ?? [])];
  // One pass per kind, the project's own patterns first, names as whole words (a placeholder is never rescanned).
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = names.length ? new RegExp(`\\b(?:${[...new Set(names)].sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'gi') : null;
  const scrub = (text) => {
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
  return loadLessons(root, { builtin: false }).filter((l) => l.scope === 'plugin' && l.status !== 'retired').map((l) => ({
    id: l.id,
    text: `## ${scrub(l.title)}\n\n**What happened:** ${scrub(l.trigger?.what)}\n\n**Cause class:** ${l.cause}\n\n**Proposed mechanism:** ${l.mechanism?.kind}${l.mechanism?.text ? ` — ${scrub(l.mechanism.text)}` : ''}\n\n**Recurrences so far:** ${l.recurrence}\n`,
  }));
}
