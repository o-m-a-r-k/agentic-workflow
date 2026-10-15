// Project learning (0.7.9, D19): the workflow gets better at a project by working in it, and the person curates nothing.
// Learning only changes what roles read and in which order; it never adds a question, a stop, a refusal or a step, and
// it never loosens a guarantee. Lesson text stays in the repositories (committed and reviewed with an attempt); what this
// module keeps is the measurement those repositories cannot hold:
//
//   - a project-local, append-only record (`.workflow-maintenance/learned.jsonl` under the project root, never committed):
//     when a lesson's mistake repeated, which lessons each handoff carried, which lessons describe one mistake, what the
//     person answered when asked whether an item may leave, and what each delivered attempt predicted against what
//     happened. Named failure: the counters lived in lesson files and attempt ledgers, so a recurrence found at
//     acceptance wrote a tracked file of the pull-only main checkout, and the ledgers holding the rest were cleaned away
//     with their evidence (one project kept 7 of its attempts' ledgers).
//   - the classifier: a cheap model (no reasoning, no tools) that labels items with one of the choices it is given. It
//     is a configurable agent: the adapter's `learning.classifier.<runtime>` pins its model and effort over the host's
//     defaults, `learning.enabled: false` turns it off for the project, and `WF_LEARNING=off` for this machine.
//
// Everything here is best effort: a learning step that fails is skipped and recorded, never a reason for a command to fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findHost, launchEnvDeletes, optional } from './hosts/index.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { now } from './util.mjs';

const learnedFile = (root) => path.join(root, '.workflow-maintenance', 'learned.jsonl');

// One learned fact, appended (a line under the pipe-buffer size is one atomic append, so two attempts finishing together
// never lose each other's lines). Returns whether it was written.
export function noteLearned(root, fact) {
  try {
    const file = learnedFile(root);
    mkdirStateDirectory(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: now(), ...fact }) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const cache = new Map();
// Every learned fact of the project, oldest first; a line that does not parse is skipped.
export function learnedFacts(root) {
  const file = learnedFile(root);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return [];
  }
  if (!st.isFile()) return [];
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.facts;
  const facts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (f && typeof f === 'object' && typeof f.kind === 'string') facts.push(f);
    } catch {}
  }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, facts });
  return facts;
}

// Per lesson: how often its mistake repeated since 0.7.9 (beyond the count its file carries), when it last did, and in
// how many attempts a handoff carried it. `except` leaves one attempt's carrying out, so the roles of one attempt see the
// lessons in the same order (an attempt's own planner handoff never pushes a lesson down for its implementer).
export function lessonStats(root, { except = null } = {}) {
  const out = new Map();
  const get = (id) => out.get(id) ?? out.set(id, { repeats: 0, lastRepeatAt: null, injections: 0, carriedIn: new Set() }).get(id);
  for (const f of learnedFacts(root)) {
    if (f.kind === 'repeat' && f.lesson) {
      const s = get(f.lesson);
      s.repeats += 1;
      if (!s.lastRepeatAt || f.at > s.lastRepeatAt) s.lastRepeatAt = f.at;
    } else if (f.kind === 'injected' && f.attempt !== except) for (const id of f.lessons ?? []) get(id).carriedIn.add(f.attempt ?? f.at);
  }
  for (const s of out.values()) s.injections = s.carriedIn.size;
  return out;
}

// Lessons the classifier has compared with the others once, and the pairs it labelled as one mistake.
export const checkedLessons = (root) => new Set(learnedFacts(root).filter((f) => f.kind === 'checked').flatMap((f) => f.lessons ?? []));
export const sameMistakes = (root) => learnedFacts(root).filter((f) => f.kind === 'same' && f.lesson && f.as).map((f) => ({ lesson: f.lesson, as: f.as, at: f.at }));

// The classifier for a runtime under an adapter, or null when learning is off or the runtime cannot run one.
export function classifierFor(cfg, runtime, env = process.env) {
  if (cfg?.learning?.enabled === false || String(env.WF_LEARNING ?? '').toLowerCase() === 'off') return null;
  const host = findHost(runtime);
  const launch = optional(host, 'classifyLaunch');
  const read = optional(host, 'classifyResult');
  if (!launch || !read) return null;
  const pin = { ...(host.classifierDefaults ?? {}), ...(cfg?.learning?.classifier?.[runtime] ?? {}) };
  return { runtime, launch, read, model: pin.model ?? null, effort: pin.effort ?? null };
}

// The first JSON object in a model's answer (models wrap it in prose or a code fence now and then).
function firstObject(text) {
  const s = String(text ?? '');
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    let quoted = false;
    for (let j = i; j < s.length; j += 1) {
      const c = s[j];
      if (quoted) {
        if (c === '\\') j += 1;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(s.slice(i, j + 1));
          if (v && typeof v === 'object' && !Array.isArray(v)) return v;
        } catch {}
        break;
      }
    }
  }
  return null;
}

const oneLine = (x, n = 300) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Labels each item with one of the choices: `{ labels: { key: choice } }`, or `{ error }`. `goal` says what a label
// means; `choices` are `{ id, text }` and always include `none`; `items` are `{ key, text, not? }` (`not`: a choice this
// item may not take, e.g. itself). A label that is not one of the item's choices is dropped.
export function classify(c, { goal, choices, items }) {
  const started = Date.now();
  const prompt = [
    goal,
    'This is classification: no reasoning, no tools. Answer with exactly one JSON object that maps every item key to one choice id, and nothing else.',
    '',
    'Choices:',
    ...choices.map((x) => `- ${x.id}: ${oneLine(x.text)}`),
    '',
    'Items:',
    ...items.map((x) => `- ${x.key}: ${oneLine(x.text, 600)}`),
  ].join('\n');
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wf-classify-'));
    const env = { ...process.env };
    for (const name of launchEnvDeletes()) delete env[name];
    const call = c.launch({ prompt, model: c.model, effort: c.effort, dir });
    // A model call that hangs would hold the command that asked for it; five minutes is far past any labelling answer.
    const r = spawnSync(call.bin, call.args, { cwd: dir, env, input: call.input ?? '', encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    const ms = Date.now() - started;
    if (r.error || r.status !== 0) return { error: oneLine(r.error?.message ?? `${call.bin} exited ${r.status}: ${r.stderr ?? ''}`), ms };
    const out = c.read({ stdout: r.stdout, outFile: call.outFile ?? null });
    const answer = firstObject(out?.text);
    if (!answer) return { error: `no JSON object in the answer: ${oneLine(out?.text, 200)}`, ms, model: out?.model ?? c.model };
    const ids = new Set(choices.map((x) => x.id));
    const labels = {};
    for (const it of items) {
      const v = typeof answer[it.key] === 'string' ? answer[it.key].trim() : null;
      if (v && ids.has(v) && v !== it.not) labels[it.key] = v;
    }
    return { labels, ms, model: out?.model ?? c.model, costUsd: out?.costUsd ?? null };
  } catch (e) {
    return { error: oneLine(e?.message ?? e), ms: Date.now() - started };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- The person's answers ----

// What the person answered when asked whether an item may leave a delivery: `fix now` and their own words are what a
// reviewer reads as "what this person fixes" when it rates similar items (never a rule: the reviewer still rates).
export function personFixed(root) {
  return learnedFacts(root)
    .filter((f) => f.kind === 'answer' && (f.choice === 'fix now' || f.choice === 'other'))
    .map((f) => ({ at: f.at, item: f.summary ?? null, ...(f.choice === 'other' ? { ownWords: f.words ?? null } : { answer: 'fix now' }) }));
}

// ---- Estimates ----

// Per lane, how the plans' predictions compared with what happened in delivered attempts: the median of actual over
// predicted (1 is exact; 2 took twice as long) and how many attempts it is over. For the planner's own judgement (D9:
// nothing is decided from it). Minutes leave out the longest stretch with nothing recorded (a night, a wait).
export function pastCourse(root) {
  const median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 100) / 100;
  };
  const byLane = new Map();
  for (const f of learnedFacts(root)) if (f.kind === 'course' && f.expected) byLane.set(f.lane ?? 'any', [...(byLane.get(f.lane ?? 'any') ?? []), f]);
  const out = {};
  for (const [lane, rows] of byLane) {
    out[lane] = { attempts: rows.length };
    for (const k of ['files', 'rounds', 'minutes']) {
      const ratios = rows.filter((r) => typeof r.expected?.[k] === 'number' && r.expected[k] > 0 && typeof r.actual?.[k] === 'number').map((r) => r.actual[k] / r.expected[k]);
      out[lane][k] = { attempts: ratios.length, medianActualOverPredicted: median(ratios) };
    }
  }
  return Object.keys(out).length ? out : null;
}
