#!/usr/bin/env node
// rounds: names the next read or review file of a delivery and counts the rounds, from evidence/ file names.
// Usage: node rounds.mjs <ticket-folder>                     print every count and the plan revision
//        node rounds.mjs <ticket-folder> <read|review> <n>   which file does the next one of that kind write?
// Only exact names count: read-<n>[-<k>].md, review-<n>-<round>.md; other files are listed as ignored. Rounds have no
// cap: they go on while a round names a concrete failing state. A delivery the plan doesn't list is refused.
// Writes evidence/rounds.md. Exit 1 when refused.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, ROUND, roundsOf } from './ticket.mjs';

const [folder, kind, delivery] = process.argv.slice(2);
if (kind && (!['read', 'review'].includes(kind) || !/^\d+$/.test(delivery || ''))) {
  console.error('usage: node rounds.mjs <ticket-folder> [read|review <delivery>]');
  process.exit(2);
}
const T = ticket(resolve(folder || '.'));
const names = T.names.filter((f) => !f.includes('/'));
const ignored = names.filter((f) => /^(read|review)-/.test(f) && !Object.values(ROUND).some((r) => r.test(f)));
const deliveries = new Set(names.flatMap((f) => Object.values(ROUND).map((r) => (f.match(r) || [])[1]).filter(Boolean)));
if (delivery) deliveries.add(delivery);
const unlisted = (d) => T.plan && !T.deliveries.includes(d);
const lines = [...deliveries].sort((a, b) => a - b).map((d) => `delivery ${d}: read ${roundsOf(names, 'read', d).length}, review ${roundsOf(names, 'review', d).length}${unlisted(d) ? " (not in the plan's Deliveries)" : ''}`);
if (ignored.length) lines.push(`ignored, not a round file name: ${ignored.join(', ')}`);
lines.push(`plan revision ${T.revision || '0'}, ${names.filter((f) => /^challenge-\d+\.md$/.test(f)).length} challenges`);
let result = 'ok';
if (kind) {
  const n = roundsOf(names, kind, delivery).length;
  result = unlisted(delivery) ? `refused: delivery ${delivery} is not in the plan's Deliveries (${T.deliveries.join(', ') || 'none'})` : `next: evidence/${kind}-${delivery}${kind === 'review' ? `-${n + 1}` : n ? `-${n + 1}` : ''}.md`;
}
const out = [`rounds: ${result}`, ...lines].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'rounds.md'), out + '\n');
console.log(out);
process.exit(result.startsWith('refused') ? 1 : 0);
