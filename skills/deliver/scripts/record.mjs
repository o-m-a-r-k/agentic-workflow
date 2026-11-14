#!/usr/bin/env node
// record: writes the ticket's record line from its files, so no count is typed by hand.
// Usage: node record.mjs <ticket-folder> [--records <file>]
// The records file defaults to ~/.agents/records.jsonl, used only when ~/.agents exists; otherwise the line is printed only.
// Reads STATE.md (Project, Ticket, Type, Risk lane, Screen, Hotfix, Started, Delivered, Accepted, Profile, Rejections,
// Found on the way), BRIEF.md's Lane, DESIGN.md (Surface, Decisions, kept here after the folder is removed),
// evidence/log.md, gate.json, lane.md, words.json, ready.md's History line (ready_fails), the challenge-, confirm-, verify- and read-<n>.md file names,
// audit.md ("Findings: <n>"), missed.md ("- " lines; those naming discover are its misses) and the earlier records.
// idle_minutes: the minutes from Started to the last log line during which no role was working, a role working from its
// start line to its return line (starts and returns paired per role, in order). Appends one line. Exit 0, 1 with no STATE.md.
import { existsSync, appendFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { ticket, read, field, vals, laneRank } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const records = vals(args, '--records')[0] ? resolve(vals(args, '--records')[0]) : existsSync(join(homedir(), '.agents')) ? join(homedir(), '.agents', 'records.jsonl') : null;
const T = ticket(dir);
if (!T.state) { console.error(`record: no STATE.md in ${dir}`); process.exit(1); }
const names = T.names.filter((f) => !f.includes('/'));
const count = (rx) => names.filter((f) => rx.test(f)).length;
const json = (f) => { try { return JSON.parse(read(join(T.ev, f))); } catch { return null; } };
const audits = names.filter((f) => /^audit(?:-\d+)?\.md$/.test(f)).map((f) => read(join(T.ev, f)));
const missed = existsSync(join(T.ev, 'missed.md')) ? read(join(T.ev, 'missed.md')).split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim()) : null;
const project = field(T.state, 'Project') || null, ticketId = field(T.state, 'Ticket') || basename(dir), profile = field(T.state, 'Profile');
const earlier = records ? read(records).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const tally = (xs) => xs.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {});
const started = field(T.state, 'Started') || null;

// Idle: from Started to the last log line, the time no role was open. A return closes its role's earliest open start.
const idle = (() => {
  const from = Date.parse(started || ''), events = [...T.log].sort((a, b) => a.time - b.time);
  if (isNaN(from) || !events.length) return null;
  const open = {};
  let busy = 0, at = from, total = 0;
  for (const e of events) {
    if (e.time > at) { if (!busy) total += e.time - at; at = e.time; }
    if (e.kind === 'start') { open[e.role] = (open[e.role] || 0) + 1; busy++; }
    else if (open[e.role] > 0) { open[e.role]--; busy--; }
  }
  return Math.round(total / 60000);
})();

const gate = json('gate.json'), words = json('words.json')?.states || {};
const floor = (read(join(T.ev, 'lane.md')).match(/^Floor: (\w+)/m) || [])[1] || null;
const line = {
  project,
  ticket: ticketId,
  type: (field(T.state, 'Type').toLowerCase().match(/^(hotfix|bug|enhancement|new feature)/) || [])[1] || null,
  lane: laneRank(T.lane) >= 0 ? T.lane : null,
  screen: ['none', 'touched', 'shaped'].includes(T.screen) ? T.screen : null,
  hotfix: T.hotfix === 'yes' ? true : T.hotfix === 'no' ? false : null,
  started,
  first_delivered: T.deliveries.map((d) => d.time).sort()[0] || null,
  accepted: T.accepted || null,
  finished: new Date().toISOString(),
  returns: tally(T.log.filter((e) => e.kind === 'return').map((e) => e.role)),
  agents: T.log.filter((e) => e.kind === 'start').length,
  idle_minutes: idle,
  gate_runs: gate ? +gate.runs || 0 : null,
  ready_fails: (() => { const m = read(join(T.ev, 'ready.md')).match(/^History: \d+ runs, (\d+) failed$/m); return m ? +m[1] : null; })(),
  lane_floor: floor,
  brief_lane: laneRank(T.briefLane) >= 0 ? T.briefLane : null,
  brief_below_floor: floor ? floor === 'critical' && laneRank(T.briefLane) < laneRank('critical') : null,
  challenges: count(/^challenge-\d+\.md$/),
  confirms: count(/^confirm-\d+\.md$/),
  verifies: count(/^verify-\d+\.md$/),
  reads: count(/^read-\d+\.md$/),
  rejections: tally(T.rejections.map((r) => (r.class || 'unclassified').replace(/ /g, '_'))),
  found: tally(T.found.map((f) => f.tag || 'untagged')),
  words: Object.fromEntries(Object.entries(words).map(([s, w]) => [s, { first: w.first?.count ?? null, latest: w.latest?.count ?? null }])),
  reopened: earlier.filter((r) => r.project === project && r.ticket === ticketId).length,
  surface_lines: T.surface.filter((l) => l.touched).length,
  surface_not_touched: T.surface.filter((l) => !l.touched).length,
  surface_kinds: [...new Set(T.surface.map((l) => l.kind).filter(Boolean))],
  decisions: T.decisions.map((d) => ({ title: d.split('\n')[0].trim(), choice: field(d, 'choice'), source: field(d, 'source'), reversible: /reversible pick/i.test(d) })),
  cold_audit: audits.length ? audits.reduce((n, a) => n + (parseInt(field(a, 'Findings'), 10) || 0), 0) : null,
  missed,
  discover_misses: missed && missed.filter((l) => /\bdiscover/i.test(l)).length,
  profile: profile && profile !== 'none' ? profile : null,
};
const text = JSON.stringify(line);
if (records) appendFileSync(records, text + '\n');
console.log(text);
console.log(records ? `record: appended to ${records}` : 'record: printed only, since ~/.agents does not exist');
