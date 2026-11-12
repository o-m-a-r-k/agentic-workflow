#!/usr/bin/env node
// record: writes the ticket's record line from its files, so no count is typed by hand.
// Usage: node record.mjs <ticket-folder> [--records <file>]
// The records file defaults to ~/.agents/records.jsonl, used only when ~/.agents exists; otherwise the line is printed only.
// Reads STATE.md, PLAN.md (its decisions, kept here after the folder is removed), evidence/ file names,
// evidence/audit-<n>.md ("Findings: <n>", summed; audits_missing lists delivered deliveries with none),
// evidence/missed.md ("- " lines; those naming Discover are its misses) and the earlier records. Appends one line. Exit 0.
import { existsSync, appendFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { ticket, read, field, section, vals, ROUND } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const records = vals(args, '--records')[0] ? resolve(vals(args, '--records')[0]) : existsSync(join(homedir(), '.agents')) ? join(homedir(), '.agents', 'records.jsonl') : null;
const T = ticket(dir);
if (!T.state) { console.error(`record: no STATE.md in ${dir}`); process.exit(1); }
const names = T.names.filter((f) => !f.includes('/'));
const count = (rx) => names.filter((f) => rx.test(f)).length;
const delivered = [...T.state.matchAll(/^Delivery (\d+):.*(?<!not )\bdelivered (\d{4}-\d\d-\d\d\S*)/gm)];
const audits = names.filter((f) => /^audit(?:-\d+)?\.md$/.test(f)).map((f) => read(join(T.ev, f)));
const missed = existsSync(join(T.ev, 'missed.md')) ? read(join(T.ev, 'missed.md')).split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim()) : null;
const project = field(T.state, 'Project') || null, ticketId = field(T.state, 'Ticket') || basename(dir), profile = field(T.state, 'Profile');
const earlier = records ? read(records).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];

const line = {
  project,
  ticket: ticketId,
  type: (field(T.state, 'Type').toLowerCase().match(/^(hotfix|bug|enhancement|new feature)/) || [])[1] || null,
  size: field(T.state, 'Size').split(/\s/)[0] || null,
  started: field(T.state, 'Started') || null,
  first_delivered: delivered.map((m) => m[2].replace(/[,;]$/, '')).sort()[0] || null,
  finished: new Date().toISOString(),
  risk: ['low', 'high'].includes(T.risk) ? T.risk : null,
  plan_revisions: +T.revision || 0,
  challenge_rounds: count(/^challenge-\d+\.md$/),
  read_rounds: count(ROUND.read),
  review_rounds: count(ROUND.review),
  reopened: earlier.filter((r) => r.project === project && r.ticket === ticketId).length,
  surface_lines: T.surface.filter((l) => l.touched).length,
  surface_not_touched: T.surface.filter((l) => !l.touched).length,
  surface_kinds: [...new Set(T.surface.map((l) => l.kind).filter(Boolean))],
  surface_draft: T.draft.length,
  surface_extras: section(T.state, 'Outside the ticket').split('\n').filter((l) => /^- \[surface\]/i.test(l)).length,
  decisions: T.decisions.map((d) => ({ title: d.split('\n')[0].trim(), choice: field(d, 'choice'), source: field(d, 'source'), reversible: /reversible pick/i.test(d) })),
  cold_audit: audits.length ? audits.reduce((n, a) => n + (parseInt(field(a, 'Findings'), 10) || 0), 0) : null,
  audits_missing: delivered.map((m) => +m[1]).filter((k) => !names.includes(`audit-${k}.md`)),
  missed,
  discover_misses: missed && missed.filter((l) => /\bdiscover/i.test(l)).length,
  profile: profile && profile !== 'none' ? profile : null,
};
const text = JSON.stringify(line);
if (records) appendFileSync(records, text + '\n');
console.log(text);
console.log(records ? `record: appended to ${records}` : 'record: printed only, since ~/.agents does not exist');
