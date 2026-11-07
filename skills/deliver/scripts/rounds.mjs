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
const ignored = names.filter((f) => /^(judge|read|review)-/.test(f) && !Object.values(exact).some((r) => r.test(f)) && !/^judge-\d+-r\d+\.md$/.test(f));
// A verdict line as models write it, "**Verdict:** Fix: 2 findings." -> "fix"; "fix: 0" -> "clean".
const verdict = (t) => {
  const v = ((t.match(/^[\s>#*_-]*verdict[\s*_`]*:[\s*_`]*(.+)$/im) || [])[1] || '').replace(/[*_`]/g, '').trim().toLowerCase();
  const k = (v.match(/^(clean|fix|build|approval)/) || [])[1] || '';
  return k === 'fix' && /^fix\w*:?\s*0\b/.test(v) ? 'clean' : k;
};
// A third review is the narrow one: for an open [S<n>] finding of review 2 (found with the verdict and its F<n> lines
// together), or for a diff after review that links reported (its table names review-<n>-3).
const blocksOf = (t) => t.split(/^#+\s*outside the ticket/im)[0].split('\n').reduce((acc, l) => { if (/^[\s>#*_-]*F\d+\b/.test(l)) acc.push(l); else if (/^#/.test(l)) acc.push(null); else if (acc.length && acc.at(-1) !== null) acc[acc.length - 1] += `\n${l}`; return acc; }, []).filter(Boolean);
const openSurface = (t) => (verdict(t) !== 'clean' && blocksOf(t).length ? [...new Set(blocksOf(t).flatMap((b) => b.match(/\[(?:S\d+|surface)\]/gi) || []))] : []);
const narrow = (d) => openSurface(read(join(evidence, `review-${d}-2.md`))).length > 0 || new RegExp(`\\| review-${d}-3\\b`).test(read(join(evidence, `links-${d}.md`)));
// A review file whose verdict and F<n> findings disagree (or has neither) is rewritten in place, by a fresh worker.
const broken = (t) => {
  const v = verdict(t), n = blocksOf(t).length, said = +((t.match(/^[\s>#*_-]*verdict.*?(\d+)\s+(?:\w+\s+){0,3}findings?/im) || [])[1] || 0);
  return (said && said !== n) || !((v === 'clean' && !n) || ((v === 'fix' || !v) && n));
};
const capOf = (k, d) => (k !== 'review' ? 1 : narrow(d) ? 3 : 2);
// A judge file moved aside after "plan wrong" is named judge-<n>-r<revision>.md; a third re-plan holds the ticket.
const aside = (d) => names.filter((f) => new RegExp(`^judge-${d}-r\\d+\\.md$`).test(f));

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
    if (n > cap || (n && listed && !listed.includes(d))) over = true;
    return `${k} ${n}/${cap}${n > cap ? ' over' : ''}${k === 'judge' && aside(d).length ? ` (+${aside(d).length} moved aside)` : ''}`;
  });
  lines.push(`delivery ${d}: ${parts.join(', ')}${listed && !listed.includes(d) ? " (not in the plan's Deliveries)" : ''}`);
}
if (ignored.length) lines.push(`ignored, not a round file name: ${ignored.join(', ')}`);
lines.push(`plan revision ${revision}`);

let result = over ? 'over' : 'ok';
if (kind) {
  const have = of(kind, delivery), cap = capOf(kind, delivery);
  const lastReview = kind === 'review' && have.length ? have.sort((a, b) => +a.match(exact.review)[2] - +b.match(exact.review)[2]).at(-1) : null;
  if (lastReview && broken(read(join(evidence, lastReview)))) result = `next: rewrite evidence/${lastReview} (its verdict and findings disagree; not a new round)`;
  else if (listed && !listed.includes(delivery)) result = `refused: delivery ${delivery} is not in the plan's Deliveries (${listed.join(', ') || 'none'})`;
  else if (kind === 'judge' && aside(delivery).length >= 2) result = `refused: a third re-plan (${aside(delivery).join(', ')} moved aside); the ticket is held and the person gets one message with the evidence`;
  else if (have.length >= cap) result = `refused: ${have.map((f) => `evidence/${f}`).join(', ')} exist${have.length === 1 ? 's' : ''} (cap ${cap})`;
  else if (kind === 'review' && have.length === 2 && cap === 3) result = `next: evidence/review-${delivery}-3.md, reading only ${openSurface(read(join(evidence, `review-${delivery}-2.md`))).join(', ') || 'the diff links reported'}`;
  else result = `next: evidence/${kind}-${delivery}${kind === 'review' ? `-${Math.max(0, ...have.map((f) => +f.match(exact.review)[2])) + 1}` : ''}.md`;
}
const out = [`rounds: ${result}`, ...lines].join('\n');
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, 'rounds.md'), out + '\n');
console.log(out);
process.exit(result.startsWith('refused') || (!kind && over) ? 1 : 0);
