#!/usr/bin/env node
// rounds: counts the judge, read and review files per delivery from evidence/ file names.
// Usage: node rounds.mjs <ticket-folder>                          print every count and the plan revision
//        node rounds.mjs <ticket-folder> <judge|read|review> <n>  may one more file of that kind start for delivery <n>?
// Caps per delivery: judge 1, read 1, review 2. Any file whose name starts with <kind>-<n> counts, whatever follows.
// Writes evidence/rounds.md. Exit 1 when the next file would exceed its cap (or, with no kind, when one already has).
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [folder, kind, delivery] = process.argv.slice(2);
const dir = resolve(folder || '.');
const caps = { judge: 1, read: 1, review: 2 };
if (kind && (!caps[kind] || !/^\d+$/.test(delivery || ''))) {
  console.error('usage: node rounds.mjs <ticket-folder> [judge|read|review <delivery>]');
  process.exit(2);
}
const evidence = join(dir, 'evidence');
const names = existsSync(evidence) ? readdirSync(evidence) : [];
const of = (k, d) => names.filter((f) => new RegExp(`^${k}-${d}(?:[^0-9]|$)`).test(f)).sort();
const plan = existsSync(join(dir, 'PLAN.md')) ? readFileSync(join(dir, 'PLAN.md'), 'utf8') : '';
const revision = (plan.match(/^Revision:[ \t]*(\d+)/m) || [])[1] || '0';

const deliveries = new Set(names.map((f) => (f.match(/^(?:judge|read|review)-(\d+)/) || [])[1]).filter(Boolean));
if (delivery) deliveries.add(delivery);
const lines = [];
let over = false;
for (const d of [...deliveries].sort((a, b) => a - b)) {
  const parts = Object.keys(caps).map((k) => {
    const n = of(k, d).length;
    if (n > caps[k]) over = true;
    return `${k} ${n}/${caps[k]}${n > caps[k] ? ' over' : ''}`;
  });
  lines.push(`delivery ${d}: ${parts.join(', ')}`);
}
lines.push(`plan revision ${revision}`);

let verdict = over ? 'over' : 'ok';
if (kind) {
  const have = of(kind, delivery);
  if (have.length >= caps[kind]) verdict = `refused: ${have.map((f) => `evidence/${f}`).join(', ')} exist${have.length === 1 ? 's' : ''} (cap ${caps[kind]})`;
  else verdict = `next: evidence/${kind}-${delivery}${kind === 'review' ? `-${have.length + 1}` : ''}.md`;
}
const out = [`rounds: ${verdict}`, ...lines].join('\n');
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, 'rounds.md'), out + '\n');
console.log(out);
process.exit(verdict.startsWith('refused') || (!kind && over) ? 1 : 0);
