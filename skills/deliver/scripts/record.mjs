#!/usr/bin/env node
// record: writes the ticket's record line from its files, so no count is typed by hand.
// Usage: node record.mjs <ticket-folder> [--records <file>]
// The records file defaults to ~/.agents/records.jsonl, used only when ~/.agents exists; otherwise the line is printed only.
// Reads STATE.md, PLAN.md, evidence/ file names, evidence/audit.md ("Findings: <n>"), evidence/missed.md ("- " lines)
// and the earlier records. Appends one line. Exit 0 once written or printed.
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const records = args.includes('--records') ? resolve(args[args.indexOf('--records') + 1]) : existsSync(join(homedir(), '.agents')) ? join(homedir(), '.agents', 'records.jsonl') : null;
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const field = (t, k) => (t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')) || [])[1]?.trim() ?? '';
const section = (t, name) => {
  const s = t.split(/^## /m).find((c) => c.split('\n')[0].trim() === name);
  return s ? s.slice(s.indexOf('\n') + 1) : '';
};

const state = read(join(dir, 'STATE.md')), plan = read(join(dir, 'PLAN.md'));
if (!state) {
  console.error(`record: no STATE.md in ${dir}`);
  process.exit(1);
}
const ev = join(dir, 'evidence');
const names = existsSync(ev) ? readdirSync(ev) : [];
const exact = { judge: /^judge-(\d+)\.md$/, read: /^read-(\d+)\.md$/, review: /^review-(\d+)-\d+\.md$/ };
const count = (k) => names.filter((f) => exact[k].test(f) || (k === 'judge' && /^judge-\d+-r\d+\.md$/.test(f))).length; // judges moved aside count
const perDelivery = (k) => {
  const by = {};
  for (const f of names) { const m = f.match(exact[k]); if (m) by[m[1]] = (by[m[1]] || 0) + 1; }
  return by;
};
// Caps as rounds counts them: a third review only when review-<d>-2 left a [S<n>] finding open; a round file for a
// delivery the plan doesn't list is over too.
const verdict = (t) => { const v = ((t.match(/^[\s>#*_-]*verdict[\s*_`]*:[\s*_`]*(.+)$/im) || [])[1] || '').replace(/[*_`]/g, '').trim().toLowerCase(); return /^fix\w*:?\s*0\b/.test(v) ? 'clean' : (v.match(/^(clean|fix|build|approval)/) || [])[1] || ''; };
// A third review is the narrow one: for an open [S<n>] finding of review 2 (found with the verdict and its F<n> lines
// together), or for a diff after review that links reported (its table names review-<n>-3).
const blocksOf = (t) => t.split(/^#+\s*outside the ticket/im)[0].split('\n').reduce((acc, l) => { if (/^[\s>*_-]*F\d+\b/.test(l)) acc.push(l); else if (/^#/.test(l)) acc.push(null); else if (acc.length && acc.at(-1) !== null) acc[acc.length - 1] += `\n${l}`; return acc; }, []).filter(Boolean);
const openSurface = (t) => (verdict(t) !== 'clean' && blocksOf(t).length ? [...new Set(blocksOf(t).flatMap((b) => b.match(/\[(?:S\d+|surface)\]/gi) || []))] : []);
const narrow = (d) => openSurface(read(join(ev, `review-${d}-2.md`))).length > 0 || new RegExp(`\\| review-${d}-3\\b`).test(read(join(ev, `links-${d}.md`)));
const cap = (k, d) => (k !== 'review' ? 1 : narrow(d) ? 3 : 2);
const listed = (section(plan, 'Deliveries').match(/^\s*\d+\./gm) || []).map((x) => x.trim().slice(0, -1));
const over = ['judge', 'read', 'review'].some((k) => Object.entries(perDelivery(k)).some(([d, n]) => n > cap(k, d) || (listed.length && !listed.includes(d))));
const type = (field(state, 'Type').toLowerCase().match(/^(hotfix|bug|enhancement|new feature)/) || [])[1] || null;
const delivered = [...state.matchAll(/^Delivery \d+:.*\bdelivered (\S+)/gm)].map((m) => m[1].replace(/[,;]$/, '')).sort();
const audit = read(join(ev, 'audit.md'));
const missed = existsSync(join(ev, 'missed.md')) ? read(join(ev, 'missed.md')).split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim()) : null;
const project = field(state, 'Project') || null;
const ticket = field(state, 'Ticket') || basename(dir);
const earlier = records ? read(records).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const profile = field(state, 'Profile');

const line = {
  project,
  ticket,
  type,
  started: field(state, 'Started') || null,
  first_delivered: delivered[0] || null,
  finished: new Date().toISOString(),
  risk: field(plan, 'Risk') === 'high' || /\|\s*high\s*\|/i.test(section(plan, 'Risk')) ? 'high' : field(plan, 'Risk') === 'low' ? 'low' : null,
  plan_revisions: +field(plan, 'Revision') || 0,
  judge_rounds: count('judge'),
  read_rounds: count('read'),
  review_rounds: count('review'),
  rounds_over: over,
  reopened: earlier.filter((r) => r.project === project && r.ticket === ticket).length,
  surface_lines: section(plan, 'Surface').split('\n').filter((l) => /^- S\d+\b/.test(l) && !/^[^:]*:[ \t]*not touched\b/i.test(l)).length,
  surface_not_touched: section(plan, 'Surface').split('\n').filter((l) => /^- S\d+\b[^:]*:[ \t]*not touched\b/i.test(l)).length,
  surface_kinds: [...new Set([...section(plan, 'Surface').matchAll(/^- S\d+ \(([^)]+)\)/gm)].map((m) => m[1].trim().toLowerCase()))],
  surface_draft: section(state, 'Surface').split('\n').filter((l) => /^- S\d+\b/.test(l)).length,
  surface_extras: section(state, 'Outside the ticket').split('\n').filter((l) => /^- \[surface\]/i.test(l)).length,
  cold_audit: audit ? parseInt(field(audit, 'Findings'), 10) || 0 : null,
  missed,
  profile: profile && profile !== 'none' ? profile : null,
};
const text = JSON.stringify(line);
if (records) appendFileSync(records, text + '\n');
console.log(text);
console.log(records ? `record: appended to ${records}` : 'record: printed only, since ~/.agents does not exist');
