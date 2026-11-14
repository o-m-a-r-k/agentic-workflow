#!/usr/bin/env node
// words: how many words each screen shows, and whether that grew since its previous capture.
// Usage: node words.mjs <ticket-folder>
// Reads evidence/screens/<state>@<sha>.txt (a screen's visible text, written beside its .png by the project's
// screenshot runner) and counts whitespace-separated words, taking the newest capture of each state by file time.
// Keeps evidence/words.json: per state the first count ever recorded, the previous and the latest, each with its sha.
// A capture is its name, <state>@<sha>: "previous" moves only when a different sha arrives for the state; the same
// capture read again (re-run, re-touched or rewritten) updates the latest count and nothing else. Writes evidence/words.md and prints a
// line per state, marking those whose count grew since the previous capture: growth is a signal for a person, never a
// failure. Exit 0 when it read at least one file, 1 when it found none.
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { read } from './ticket.mjs';

const dir = resolve(process.argv[2] || '.');
const ev = join(dir, 'evidence'), screens = join(ev, 'screens');
const newest = {};
for (const f of existsSync(screens) ? readdirSync(screens) : []) {
  const m = f.match(/^(.+)@([^@]+)\.txt$/);
  if (!m) continue;
  const time = statSync(join(screens, f)).mtimeMs;
  if (!newest[m[1]] || time > newest[m[1]].time || (time === newest[m[1]].time && f > newest[m[1]].file)) newest[m[1]] = { file: f, sha: m[2], time };
}
if (!Object.keys(newest).length) { console.log('words: no evidence/screens/<state>@<sha>.txt'); process.exit(1); }
let kept = {};
try { kept = JSON.parse(read(join(ev, 'words.json'))) || {}; } catch {}
const states = kept.states || {};
for (const [state, n] of Object.entries(newest)) {
  const now = { count: read(join(screens, n.file)).split(/\s+/).filter(Boolean).length, sha: n.sha, capture: `${state}@${n.sha}` };
  const s = states[state];
  if (!s) states[state] = { first: now, previous: null, latest: now };
  else if (s.latest.sha !== now.sha) Object.assign(s, { previous: s.latest, latest: now });
  else s.latest = now;
}
const lines = Object.keys(newest).sort().map((state) => {
  const s = states[state], grew = s.previous && s.latest.count > s.previous.count;
  const delta = s.previous ? `, previous ${s.previous.count} (${s.previous.sha})` : '';
  return `- ${state}: ${s.latest.count} words at ${s.latest.sha}${delta}, first ${s.first.count} (${s.first.sha})${grew ? ` — GREW by ${s.latest.count - s.previous.count} since the previous capture` : ''}`;
});
const grown = Object.keys(newest).filter((k) => states[k].previous && states[k].latest.count > states[k].previous.count);
mkdirSync(ev, { recursive: true });
writeFileSync(join(ev, 'words.json'), JSON.stringify({ states }, null, 2) + '\n');
const out = [`words: ${Object.keys(newest).length} states, ${grown.length ? `grew: ${grown.join(', ')}` : 'none grew'}`, ...lines].join('\n');
writeFileSync(join(ev, 'words.md'), out + '\n');
console.log(out);
