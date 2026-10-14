// What a role says it expects (0.7.0). The planner states how many files, review rounds and minutes the change will take
// (`plan.expect`), an implementer its approach and expected minutes (its report file, written early and completed at the
// end), a reviewer its scope and expected minutes (its closure, the same way). The engine reads these statements and shows
// them beside what happened (`wf signals`, `wf resume`, `wf status`). Nothing here judges: no number in this file is a
// limit, and no refusal depends on what a role predicted. Whether a course has diverged is the owner agent's call.
//
// Named failure: the engine judged work against numbers it picked (amendments above 1x the frozen criteria, changed files
// above 2x the planned ones, 90 wall minutes, a quiet role for 15), so a large ticket that was going well was stopped by
// the same line as one that was not; the only judge who could tell them apart, the agent that predicted, was never asked.
import fs from 'node:fs';

// What a plan may expect (files touched, review rounds to delivery, minutes to delivery) and what a role's own file may.
export const PLAN_EXPECT = ['files', 'rounds', 'minutes'];
export const ROLE_EXPECT = ['minutes'];

// The problems with a stated expectation, empty when it is absent or readable. Named failure: `minutes: "an hour"` or a
// misspelled key could not be compared, so the comparison was silently missing exactly where the role had predicted.
export function expectProblems(value, keys, where) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return [`\`${where}\` must be a mapping of ${keys.join(', ')} to positive numbers`];
  const out = [];
  for (const [k, v] of Object.entries(value)) {
    if (!keys.includes(k)) out.push(`\`${where}.${k}\` is not known (known: ${keys.join(', ')})`);
    else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) out.push(`\`${where}.${k}\` must be a positive number`);
    else if (k !== 'minutes' && !Number.isInteger(v)) out.push(`\`${where}.${k}\` must be a whole number`);
  }
  return out;
}

// The readable entries of a stated expectation, or null when it states none.
export function expectOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const k of PLAN_EXPECT) if (typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] > 0) out[k] = value[k];
  return Object.keys(out).length ? out : null;
}

// A role's own file while the role is still working on it: whatever it has written so far. Never throws; a file that is
// absent, large or half written yields null (the role has stated nothing yet).
export function readStatement(file, saysKey) {
  if (typeof file !== 'string' || !file) return null;
  let raw;
  try {
    if (fs.statSync(file).size > 256 * 1024) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const said = typeof value[saysKey] === 'string' && value[saysKey].trim() ? value[saysKey].trim().slice(0, 600) : null;
  const minutes = expectOf(value.expect)?.minutes ?? null;
  return said || minutes !== null ? { said, minutes } : null;
}
