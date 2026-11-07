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
const count = (k) => names.filter((f) => new RegExp(`^${k}-\\d+(?:[^0-9]|$)`).test(f)).length;
const perDelivery = (k) => {
  const by = {};
  for (const f of names) { const m = f.match(new RegExp(`^${k}-(\\d+)(?:[^0-9]|$)`)); if (m) by[m[1]] = (by[m[1]] || 0) + 1; }
  return by;
};
const caps = { judge: 1, read: 1, review: 2 };
const over = Object.keys(caps).some((k) => Object.values(perDelivery(k)).some((n) => n > caps[k]));
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
  risk: ['low', 'high'].includes(field(plan, 'Risk')) ? field(plan, 'Risk') : null,
  plan_revisions: +field(plan, 'Revision') || 0,
  judge_rounds: count('judge'),
  read_rounds: count('read'),
  review_rounds: count('review'),
  rounds_over: over,
  reopened: earlier.filter((r) => r.project === project && r.ticket === ticket).length,
  surface_lines: section(plan, 'Surface').split('\n').filter((l) => /^- S\d+:/.test(l) && !/not touched/i.test(l)).length,
  surface_extras: section(state, 'Outside the ticket').split('\n').filter((l) => /^- \[surface\]/i.test(l)).length,
  cold_audit: audit ? +(field(audit, 'Findings') || 0) : null,
  missed,
  profile: profile && profile !== 'none' ? profile : null,
};
const text = JSON.stringify(line);
if (records) appendFileSync(records, text + '\n');
console.log(text);
console.log(records ? `record: appended to ${records}` : 'record: printed only, since ~/.agents does not exist');
