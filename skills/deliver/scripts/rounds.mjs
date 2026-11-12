#!/usr/bin/env node
// rounds: counts the read and review files per delivery from evidence/ file names.
// Usage: node rounds.mjs <ticket-folder>                     print every count and the plan revision
//        node rounds.mjs <ticket-folder> <read|review> <n>   may one more file of that kind start for delivery <n>?
// Only exact names count: read-<n>.md, review-<n>-<round>.md; other files are listed as ignored. Caps per delivery:
// read 1, review 2, and a narrow third when review 2's Verdict: line asks for fixes or links named review 3 for a diff
// after review. A delivery the plan doesn't list is refused. Challenges of the design are not capped: they end when a
// challenger names no failing state. Writes evidence/rounds.md. Exit 1 when the next file would exceed its cap (or,
// with no kind, when one already has).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, ROUND, roundsOf, cap } from './ticket.mjs';

const [folder, kind, delivery] = process.argv.slice(2);
if (kind && (!['read', 'review'].includes(kind) || !/^\d+$/.test(delivery || ''))) {
  console.error('usage: node rounds.mjs <ticket-folder> [read|review <delivery>]');
  process.exit(2);
}
const T = ticket(resolve(folder || '.'));
const names = T.names.filter((f) => !f.includes('/'));
const ignored = names.filter((f) => /^(read|review)-/.test(f) && !Object.values(ROUND).some((r) => r.test(f)));
const listed = T.plan ? T.deliveries : null;
const deliveries = new Set(names.flatMap((f) => Object.values(ROUND).map((r) => (f.match(r) || [])[1]).filter(Boolean)));
if (delivery) deliveries.add(delivery);
const lines = [];
let over = false;
for (const d of [...deliveries].sort((a, b) => a - b)) {
  const parts = ['read', 'review'].map((k) => {
    const n = roundsOf(names, k, d).length, c = cap(T.ev, k, d);
    if (n > c || (n && listed && !listed.includes(d))) over = true;
    return `${k} ${n}/${c}${n > c ? ' over' : ''}`;
  });
  lines.push(`delivery ${d}: ${parts.join(', ')}${listed && !listed.includes(d) ? " (not in the plan's Deliveries)" : ''}`);
}
if (ignored.length) lines.push(`ignored, not a round file name: ${ignored.join(', ')}`);
lines.push(`plan revision ${T.revision || '0'}, ${names.filter((f) => /^challenge-\d+\.md$/.test(f)).length} challenges`);

let result = over ? 'over' : 'ok';
if (kind) {
  const have = roundsOf(names, kind, delivery), c = cap(T.ev, kind, delivery);
  if (listed && !listed.includes(delivery)) result = `refused: delivery ${delivery} is not in the plan's Deliveries (${listed.join(', ') || 'none'})`;
  else if (have.length >= c) result = `refused: ${have.map((f) => `evidence/${f}`).join(', ')} exist${have.length === 1 ? 's' : ''} (cap ${c})`;
  else if (kind === 'review' && have.length === 2) result = `next: evidence/review-${delivery}-3.md, the narrow review: the fixes of review 2's findings and the diff after review links reported`;
  else result = `next: evidence/${kind}-${delivery}${kind === 'review' ? `-${have.length + 1}` : ''}.md`;
}
const out = [`rounds: ${result}`, ...lines].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'rounds.md'), out + '\n');
console.log(out);
process.exit(result.startsWith('refused') || (!kind && over) ? 1 : 0);
