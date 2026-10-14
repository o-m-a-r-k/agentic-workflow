// The refusal log (0.7.0): every refusal a `wf` command prints is counted by the check that made it.
//
// Named failure: design principle 13 asked for a measured false-positive rate before a check was kept, and no refusal
// left a record outside agent transcripts. Hundreds of refusals (334 from the guard alone, 69% naming no evidence
// folder) were invisible, so no check was ever retired. One JSON line per refusal, outside every repo; measurement
// only, never read to allow or block anything.
import fs from 'node:fs';
import path from 'node:path';
import { inboxDir } from './improve.mjs';
import { ENGINE_VERSION } from './util.mjs';

export const refusalsFile = () => path.resolve(process.env.WF_REFUSALS_FILE ?? path.join(path.dirname(inboxDir()), 'refusals.jsonl'));

// The attempt this command resolved (`--attempt`, the worktree it runs in, or the only open one), noted by
// resolveAttempt. Named failure: refusals carried an attempt only when `--attempt` was typed, so `wf report` could not
// join the many refusals of a command that found its attempt itself. The project's folder name is kept with it because
// an attempt id (an item and a number) can repeat across projects.
let resolved = { attempt: null, project: null };
export function noteAttempt(root, id) {
  resolved = { attempt: String(id), project: path.basename(String(root)) };
}

export function logRefusal({ id, cmd, sub = null, attempt = null, message = '' }) {
  try {
    const file = refusalsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const known = resolved.attempt && (!attempt || String(attempt) === resolved.attempt);
    const line = JSON.stringify({ at: new Date().toISOString(), id: id ?? 'unknown', version: ENGINE_VERSION, cmd, sub, attempt: attempt ?? (known ? resolved.attempt : null), project: known ? resolved.project : null, message: String(message).split('\n')[0].slice(0, 300) });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // Measurement never fails a command.
  }
}

export function readRefusals({ since = null } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(refusalsFile(), 'utf8');
  } catch {
    return [];
  }
  const from = since ? Date.parse(since) : null;
  return text.split('\n').filter(Boolean).flatMap((l) => {
    try {
      const r = JSON.parse(l);
      return from && Date.parse(r.at) < from ? [] : [r];
    } catch {
      return [];
    }
  });
}

// Counts per check id, most frequent first, with the newest message as an example.
export function refusalCounts(rows) {
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.id) ?? { id: r.id, count: 0, attempts: new Set(), last: null, example: '' };
    x.count += 1;
    if (r.attempt) x.attempts.add(r.attempt);
    if (!x.last || r.at > x.last) {
      x.last = r.at;
      x.example = r.message;
    }
    by.set(r.id, x);
  }
  return [...by.values()].map((x) => ({ ...x, attempts: [...x.attempts] })).sort((a, b) => b.count - a.count);
}
