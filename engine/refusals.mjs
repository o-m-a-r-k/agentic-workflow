// The refusal log: every refusal `wf` prints is counted by its id (design-0.8 section 7, `refusals.{count,byId}`).
//
// Named failure: no refusal left a record outside agent transcripts, so no check could be measured or retired (334 guard
// refusals in 0.7, 69% naming no evidence folder). One JSON line per refusal in the person's user folder, outside every
// repo. Measurement only: nothing reads it to allow or block an action, and a failed write never fails the command.
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_VERSION, userDir } from './contract.mjs';
import { nowIso } from './ledger.mjs';

export const refusalsFile = (env = process.env) => path.join(userDir(env), 'refusals.jsonl');

/** Count one refusal. root: the project root (kept local, in the user folder), or null outside a project. */
export async function recordRefusal(root, attempt, id) {
  try {
    const file = refusalsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), id: String(id), root: root ? path.resolve(root) : null, attempt: attempt ?? null, engine: CONTRACT_VERSION })}\n`);
  } catch {
    // Measurement never fails a command.
  }
}

// Refusal lines, optionally of one project root and one attempt.
export function readRefusals({ root, attempt } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(refusalsFile(), 'utf8');
  } catch {
    return [];
  }
  const want = root ? path.resolve(root) : null;
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const r = JSON.parse(line);
      if (want && r.root !== want) return [];
      if (attempt !== undefined && r.attempt !== attempt) return [];
      return [r];
    } catch {
      return [];
    }
  });
}

// { count, byId } for TicketRow.refusals.
export function refusalCounts(rows) {
  const byId = {};
  for (const r of rows) byId[r.id] = (byId[r.id] ?? 0) + 1;
  return { count: rows.length, byId };
}

export const implements08 = { recordRefusal };
