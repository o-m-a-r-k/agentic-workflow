#!/usr/bin/env node
// rounds: counts the judge, read and review files per delivery from evidence/ file names.
// Usage: node rounds.mjs <ticket-folder>                          print every count and the plan revision
//        node rounds.mjs <ticket-folder> <judge|read|review> <n>  may one more file of that kind start for delivery <n>?
// Only exact names count: judge-<n>.md, read-<n>.md, review-<n>-<round>.md; other files are listed as ignored.
// Caps per delivery: judge 1, read 1, review 2, and a third review only when review-<n>-2 says fix with a finding
// tagged [S<k>] (a Surface line); that review reads only the fix of those findings.
// A delivery the plan's "## Deliveries" doesn't list is refused. Writes evidence/rounds.md.
// Exit 1 when the next file would exceed its cap (or, with no kind, when one already has).
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [folder, kind, delivery] = process.argv.slice(2);
const dir = resolve(folder || '.');
if (kind && (!['judge', 'read', 'review'].includes(kind) || !/^\d+$/.test(delivery || ''))) {
  console.error('usage: node rounds.mjs <ticket-folder> [judge|read|review <delivery>]');
  process.exit(2);
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const evidence = join(dir, 'evidence');
const names = existsSync(evidence) ? readdirSync(evidence) : [];
const exact = { judge: /^judge-(\d+)\.md$/, read: /^read-(\d+)\.md$/, review: /^review-(\d+)-(\d+)\.md$/ };
const of = (k, d) => names.filter((f) => (f.match(exact[k]) || [])[1] === String(d)).sort();
const ignored = names.filter((f) => /^(judge|read|review)-/.test(f) && !Object.values(exact).some((r) => r.test(f)));
// A verdict line as models write it, "**Verdict:** Fix: 2 findings." -> "fix"; "fix: 0" -> "clean".
const verdict = (t) => {
  const v = ((t.match(/^[\s>#*_-]*verdict[\s*_`]*:[\s*_`]*(.+)$/im) || [])[1] || '').replace(/[*_`]/g, '').trim().toLowerCase();
  const k = (v.match(/^(clean|fix|build|approval)/) || [])[1] || '';
  return k === 'fix' && /^fix\w*:?\s*0\b/.test(v) ? 'clean' : k;
};
const openSurface = (t) => (verdict(t) === 'fix' ? [...new Set(t.split(/^#+\s*outside the ticket/im)[0].match(/\[(?:S\d+|surface)\]/gi) || [])] : []);
const capOf = (k, d) => (k !== 'review' ? 1 : openSurface(read(join(evidence, `review-${d}-2.md`))).length ? 3 : 2);

const plan = read(join(dir, 'PLAN.md'));
const revision = (plan.match(/^Revision:[ \t]*(\d+)/m) || [])[1] || '0';
const deliveriesSection = plan.split(/^## /m).find((c) => c.split('\n')[0].trim() === 'Deliveries');
const listed = deliveriesSection ? (deliveriesSection.match(/^\s*\d+\./gm) || []).map((s) => s.trim().slice(0, -1)) : null;

const deliveries = new Set(names.flatMap((f) => Object.values(exact).map((r) => (f.match(r) || [])[1]).filter(Boolean)));
if (delivery) deliveries.add(delivery);
const lines = [];
let over = false;
for (const d of [...deliveries].sort((a, b) => a - b)) {
  const parts = ['judge', 'read', 'review'].map((k) => {
    const n = of(k, d).length, cap = capOf(k, d);
    if (n > cap) over = true;
    return `${k} ${n}/${cap}${n > cap ? ' over' : ''}`;
  });
  lines.push(`delivery ${d}: ${parts.join(', ')}${listed && !listed.includes(d) ? " (not in the plan's Deliveries)" : ''}`);
}
if (ignored.length) lines.push(`ignored, not a round file name: ${ignored.join(', ')}`);
lines.push(`plan revision ${revision}`);

let result = over ? 'over' : 'ok';
if (kind) {
  const have = of(kind, delivery), cap = capOf(kind, delivery);
  if (listed && !listed.includes(delivery)) result = `refused: delivery ${delivery} is not in the plan's Deliveries (${listed.join(', ') || 'none'})`;
  else if (have.length >= cap) result = `refused: ${have.map((f) => `evidence/${f}`).join(', ')} exist${have.length === 1 ? 's' : ''} (cap ${cap})`;
  else if (kind === 'review' && have.length === 2) result = `next: evidence/review-${delivery}-3.md, reading only the fix of ${openSurface(read(join(evidence, `review-${delivery}-2.md`))).join(', ')}`;
  else result = `next: evidence/${kind}-${delivery}${kind === 'review' ? `-${have.length + 1}` : ''}.md`;
}
const out = [`rounds: ${result}`, ...lines].join('\n');
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, 'rounds.md'), out + '\n');
console.log(out);
process.exit(result.startsWith('refused') || (!kind && over) ? 1 : 0);
