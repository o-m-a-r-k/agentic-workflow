// Schema-1 (0.7) ledgers with a batch, for stream 5's legacy07.mjs and the 0.7-against-0.8 telemetry comparison, and for
// stream 7's migration. Written exactly as 0.7 chained them: each entry { seq, at, type, actor, data, prev, hash } with
// hash = sha256 of the canonical JSON of the entry without `hash`, one ledger per attempt under
// `<root>/.wf-evidence/attempts/<id>/ledger.jsonl`.
//
// The story (times in UTC):
//   TK-1.1  admitted 09:00, criteria 09:10, implementer 09:15, review 10:00 (one blocker), fix, review 10:40 (clean),
//           joins BATCH-1 11:00, delivered through the batch 12:30 (`batch.member.delivered`), closed 12:35.
//   TK-2.1  admitted 09:30, criteria 09:40, implementer 09:45, review 10:30 (clean), joins BATCH-1 11:00, delivered 12:30,
//           closed 12:36.
//   BATCH-1 admitted 11:00 (lane batch), batch.members, gate 11:05–12:20 (pass), delivered 12:30, closed 12:40.
//   TK-4.1  admitted 13:00, held 13:05 with the person's words, still open (migration skips held attempts).
//   TK-5.1  admitted 13:10, criteria 13:20, still open, not held (migration supersedes it).
// Expected roll-up (EXPECTED): the batch is not a ticket; its gate and delivery count towards both members.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const OWNER = 'claude:00000000-0000-4000-8000-000000000001';
const day = '2026-01-05';
const t = (hm) => `${day}T${hm}:00.000Z`;

// 0.7's real shape: `base` is the commit the attempt started from, `baseRef` the ref it was read at.
const admitted = (id, item, lane, at, extra = {}) => [at, 'admitted', { id, item, lane, intent: 'implementation', repos: { server: { branch: `wf/${id}`, base: 'c'.repeat(40), baseRef: 'origin/trunk' } }, schemaVersion: 1, engineVersion: '0.7.35', deferHeavy: lane !== 'batch', ...extra }];
const criteria = (at, n = 2) => [at, 'criteria.frozen', { criteria: Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, text: `criterion ${i + 1}`, uat: false })), plan: null }];
const handoff = (at, role, agent) => [at, 'handoff', { role, agent, runtime: 'claude', session: null, tree: 'tree0' }];
const review = (at, findings) => [at, 'review.recorded', { tree: 'tree1', mode: 'full', closure: { reviewer: 'reviewer-1', verdict: findings.length ? 'changes' : 'approve', findings } }];

export const STORY = {
  'TK-1.1': [
    admitted('TK-1.1', 'TK-1', 'standard', t('09:00')),
    criteria(t('09:10')),
    handoff(t('09:15'), 'implementer', 'impl-1'),
    review(t('10:00'), [{ id: 'F1', severity: 'high', status: 'open', path: 'server/src/core/sum.mjs', line: 1, what: 'wrong sum' }]),
    handoff(t('10:05'), 'implementer', 'impl-2'),
    review(t('10:40'), []),
    [t('11:00'), 'batch.joined', { batch: 'BATCH-1' }],
    [t('12:30'), 'batch.member.delivered', { batch: 'BATCH-1' }],
    [t('12:35'), 'closed', { reason: 'delivered through BATCH-1' }],
  ],
  'TK-2.1': [
    admitted('TK-2.1', 'TK-2', 'standard', t('09:30')),
    criteria(t('09:40'), 1),
    handoff(t('09:45'), 'implementer', 'impl-3'),
    review(t('10:30'), []),
    [t('11:00'), 'batch.joined', { batch: 'BATCH-1' }],
    [t('12:30'), 'batch.member.delivered', { batch: 'BATCH-1' }],
    [t('12:36'), 'closed', { reason: 'delivered through BATCH-1' }],
  ],
  'BATCH-1': [
    admitted('BATCH-1', 'BATCH-1', 'batch', t('11:00')),
    [t('11:00'), 'batch.members', { members: ['TK-1.1', 'TK-2.1'], heads: { 'TK-1.1': { server: 'a'.repeat(40) }, 'TK-2.1': { server: 'b'.repeat(40) } } }],
    [t('11:05'), 'gate.started', { runId: 'g1', tree: 'tree2' }],
    [t('12:20'), 'gate.finished', { runId: 'g1', status: 'passed', tree: 'tree2', steps: [{ id: 'full', status: 'passed' }] }],
    [t('12:30'), 'delivered', { order: ['server'] }],
    [t('12:40'), 'closed', { reason: 'delivered' }],
  ],
  'TK-4.1': [
    admitted('TK-4.1', 'TK-4', 'standard', t('13:00')),
    [t('13:05'), 'hold', { reason: 'stop everything', decision: null }],
  ],
  'TK-5.1': [
    admitted('TK-5.1', 'TK-5', 'standard', t('13:10')),
    criteria(t('13:20')),
  ],
};

// What a 0.7 reader must derive from STORY (stream 5's legacy07 row; stream 7's migration).
export const EXPECTED = {
  tickets: ['TK-1', 'TK-2'], // batch members rolled up; BATCH-1 is not a ticket
  terminal: { 'TK-1.1': t('12:35'), 'TK-2.1': t('12:36'), 'BATCH-1': t('12:40') }, // the first terminal event is the end
  wallMin: { 'TK-1.1': 215, 'TK-2.1': 186 },
  reviews: { 'TK-1.1': 2, 'TK-2.1': 1 },
  blockingReviews: { 'TK-1.1': 1, 'TK-2.1': 0 },
  deliveredVia: { 'TK-1.1': 'BATCH-1', 'TK-2.1': 'BATCH-1' },
  open: ['TK-4.1', 'TK-5.1'],
  held: ['TK-4.1'],
};

// Write the ledgers under `root`. Returns the attempt ids.
export function writeLegacyLedgers(root, story = STORY) {
  for (const [id, events] of Object.entries(story)) {
    const dir = path.join(root, '.wf-evidence', 'attempts', id);
    fs.mkdirSync(dir, { recursive: true });
    let prev = null;
    const out = events.map(([at, type, data], i) => {
      const entry = { seq: i + 1, at, type, actor: OWNER, data, prev };
      entry.hash = sha(canonical(entry));
      prev = entry.hash;
      return JSON.stringify(entry);
    });
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), out.join('\n') + '\n');
  }
  return Object.keys(story);
}
