#!/usr/bin/env node
// ready: the one check before a delivery step. It runs nothing but git, reads what the other scripts recorded, and
// compares; it never decides what the work is.
// Usage: node ready.mjs <ticket-folder> --definition <project definition> [--definition <its .local.md>]
// Rows:
//   gate      what `gate --check` decides (ticket.mjs's gateCheck)
//   base      each worktree's HEAD contains its base ref's tip (origin/<from>, else <from>; local refs), or the base's
//             tip is exactly the tree this script last passed on: a repo whose delivery landed stays ready while the
//             next repo's step is taken
//   lane      the floor from the current diff and from "Undo: no" (ticket.mjs's laneFacts) is not above STATE.md's
//             "Risk lane:"
//   verify    at least one evidence/verify-<n>.md. A stream is the verify files with one "Boundary:" value (or none),
//             judged by its newest verify by number. That verify is answered by the newest confirm whose
//             "Confirms:" line names it, if there is one: then the confirm must say "Verdict: closed"; otherwise the
//             verify must say "Verdict: clean". Asked for, and so also held to commits that stand for HEAD
//             (ticket.mjs's proofRules; its "Commit: <repo>@<sha>" lines name every worktree the change touches): on
//             the critical lane each boundary the current diff touches, or where it touches none the streams that
//             name what they verified; elsewhere every stream. A stream not asked for still fails while its
//             findings are unanswered
//   checks    every CHECKS.json check due "before delivery" passed in evidence/checks.json with its current spec, on
//             commits that stand. On the critical lane at least one such check is needed; elsewhere none is "ok (none)"
//   read      with "Screen: touched" or "shaped": the highest-numbered evidence/read-<n>.md says "Verdict: pass" and its
//             "Commit:" lines name every worktree whose change touches screen_paths, with no screen file of the change changed
//             since (a base that moved without touching the change's screen files keeps the read, as it keeps a verify)
//   approval  with "Undo: no" in BRIEF.md or at the top of a verify file: STATE.md's "Approval:" starts "given"
//   questions with QUESTIONS.md: STATE.md's "Question sheet: <12 hex>" is the first 12 hex of its sha256
// Writes evidence/ready.md (its History line counts the runs and the failed ones) and, on a pass, evidence/ready.json
// (each repo's tree and the base its change was measured from). Exit 0 when every row holds, else 1.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ticket, definitionOf, proofRules, read, field, fields, sha, laneFacts, laneRank, gateCheck, behindOf, dueKind, specOf, namesBetween, screenOf } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const def = definitionOf(args);
if (!existsSync(join(dir, 'STATE.md'))) { console.error(`ready: ${dir} is not a ticket folder`); process.exit(2); }
const T = ticket(dir), R = proofRules(T, def), W = Object.fromEntries(T.repos.map((w) => [w.name, w]));
const critical = T.lane === 'critical';
const rows = [];
const row = (name, why) => rows.push({ name, ok: !/^fail\b/.test(why) && why !== '', text: why });
const fail = (why) => `fail: ${why}`;
const top = (rx) => T.names.filter((f) => rx.test(f)).sort((a, b) => +a.match(rx)[1] - +b.match(rx)[1]);
const verdictOf = (t) => field(t, 'Verdict').replace(/[*_`.]/g, '').trim().toLowerCase().split(/[\s:,;]/)[0] || '';
const commitsOf = (t) => fields(t, 'Commit').flatMap((v) => [...v.matchAll(/([\w.-]+)@([0-9a-f]{7,40})/g)].map((m) => ({ repo: m[1], sha: m[2] })));
const touched = T.repos.filter((w) => w.tree !== w.baseTree).map((w) => w.name);

// gate and base
const g = gateCheck(T, def);
row('gate', g.ok ? 'ok' : fail(g.reason));
const behind = behindOf(T);
row('base', !T.repos.length ? fail('no worktree') : behind.length ? fail(behind.map((b) => `${b.name}: ${b.why}`).join('; ')) : 'ok');

// lane
const F = laneFacts(T, def, false);
row('lane', laneRank(T.lane) < 0 ? fail('STATE.md has no "Risk lane: direct | standard | critical"') : F.floor === 'critical' && laneRank(T.lane) < laneRank('critical') ? fail(`the floor is critical (${[...F.kinds.map((k) => k.kind), ...(F.migrations.length ? ['migrations'] : []), ...(T.undo === 'no' ? ['cannot be undone'] : [])].join(', ')}) and the lane is ${T.lane}`) : `ok (floor ${F.floor}, lane ${T.lane})`);

// verify
const standsAll = (t) => {
  const cs = commitsOf(t);
  if (!cs.length) return 'no "Commit: <repo>@<sha>" line';
  const missing = touched.filter((r) => !cs.some((c) => c.repo === r));
  if (missing.length) return `no Commit: line names ${missing.join(', ')}`;
  const bad = cs.filter((c) => !W[c.repo] || !R.stands(W[c.repo], c.sha));
  return bad.length ? `${bad.map((c) => `${c.repo}@${c.sha.slice(0, 12)}`).join(', ')} does not stand for HEAD` : '';
};
{
  const V = /^verify-(\d+)\.md$/, C = /^confirm-(\d+)\.md$/;
  const head = (f) => read(join(T.ev, f)).split('\n').slice(0, 12).join('\n');
  const of = (f) => field(head(f), 'Boundary').toLowerCase().split(/\s/)[0];
  const verifies = top(V), confirms = top(C);
  const confirmOf = (v) => confirms.filter((c) => fields(head(c), 'Confirms').some((x) => x.replace(/[`*]/g, '').split(/[\s,]+/).includes(v.replace(/\.md$/, '')))).at(-1);
  const kinds = critical ? F.kinds.map((k) => k.kind.toLowerCase()) : [];
  const streams = [...new Set(verifies.map(of))];
  const asked = !critical ? streams : kinds.length ? kinds : streams.filter(Boolean);
  if (!verifies.length) row('verify', fail('no evidence/verify-<n>.md'));
  else if (!asked.length) row('verify', fail('on the critical lane no verify file says what it verified ("Boundary: <kind>")'));
  else {
    const out = [...new Set([...asked, ...streams])].flatMap((s) => {
      const v = verifies.filter((f) => of(f) === s).at(-1), label = s ? `${s}: ` : '';
      if (!v) return [{ ok: false, text: `${s}: no verify file names this boundary` }];
      const c = confirmOf(v), judged = c || v, t = read(join(T.ev, judged)), want = c ? 'closed' : 'clean', got = verdictOf(t);
      if (got !== want) return [{ ok: false, text: `${label}${judged} says Verdict: ${got || '(none)'}, not ${want}` }];
      if (!asked.includes(s)) return [];
      const st = standsAll(t);
      return [{ ok: !st, text: `${label}${judged} ${st || `says ${want}`}` }];
    });
    row('verify', out.every((o) => o.ok) ? `ok (${out.map((o) => o.text).join('; ')})` : fail(out.filter((o) => !o.ok).map((o) => o.text).join('; ')));
  }
}

// checks
{
  const due = T.checks.filter((c) => dueKind(c) === 'before');
  let cj = null;
  try { cj = JSON.parse(read(join(T.ev, 'checks.json'))); } catch {}
  if (T.checksError) row('checks', fail(`CHECKS.json ${T.checksError}`));
  else if (!due.length) row('checks', critical ? fail('the critical lane has no CHECKS.json check due "before delivery"') : 'ok (none)');
  else if (!cj) row('checks', fail('no evidence/checks.json: run checks'));
  else {
    const bad = due.flatMap((c) => {
      const x = (cj.results || []).find((y) => y.id === c.id);
      return !x ? [`${c.id} never ran`] : !x.ok ? [`${c.id} failed`] : x.spec !== specOf(c, def) ? [`${c.id} changed since it ran`] : !T.repos.every((w) => (/^cmd:/.test(c.verify) && w.name === (c.in || T.repos[0]?.name) ? R.ranStands : R.stands)(w, x.heads?.[w.name])) ? [`${c.id} ran on commits that no longer stand`] : [];
    });
    row('checks', bad.length ? fail(bad.join(', ')) : `ok (${due.length} due)`);
  }
}

// read
if (!['touched', 'shaped'].includes(T.screen)) row('read', 'ok (none)');
else {
  const screen = screenOf(def), reads = top(/^read-(\d+)\.md$/), f = reads.at(-1);
  if (!f) row('read', fail('no evidence/read-<n>.md'));
  else {
    const t = read(join(T.ev, f)), cs = commitsOf(t);
    const screenRepos = T.repos.filter((w) => (namesBetween(w.path, w.base, 'HEAD') || []).some((x) => screen(`${w.name}/${x}`))).map((w) => w.name);
    const missing = screenRepos.filter((r) => !cs.some((c) => c.repo === r));
    const stale = cs.flatMap((c) => { const w = W[c.repo], n = w && namesBetween(w.path, c.sha, 'HEAD'); return !n ? [`${c.repo}@${c.sha.slice(0, 12)} is not a commit here`] : n.filter((x) => screen(`${c.repo}/${x}`) && R.changeFiles(w).includes(x)).slice(0, 3).map((x) => `${c.repo}/${x} changed since`); });
    row('read', verdictOf(t) !== 'pass' ? fail(`${f} says Verdict: ${verdictOf(t) || '(none)'}`) : !cs.length ? fail(`${f} has no "Commit: <repo>@<sha>" line`) : missing.length ? fail(`${f} names no commit of ${missing.join(', ')}`) : stale.length ? fail(`${f}: ${stale.join(', ')}`) : `ok (${f})`);
  }
}

// approval and the question sheet
if (T.undo !== 'no') row('approval', 'ok (none needed)');
else { const a = field(T.state, 'Approval'); row('approval', /^given\b/i.test(a) ? 'ok' : fail(`Undo: no and STATE.md's Approval is "${a || 'missing'}", not "given: …"`)); }
const qs = join(dir, 'QUESTIONS.md');
if (!existsSync(qs)) row('questions', 'ok (none)');
else { const want = sha(readFileSync(qs, 'utf8')), have = (field(T.state, 'Question sheet').match(/^[0-9a-f]{12}\b/) || [])[0]; row('questions', have === want ? 'ok' : fail(have ? `QUESTIONS.md changed since the person saw it (${have}, now ${want})` : `no "Question sheet: ${want}" in STATE.md`)); }

const failed = rows.filter((r) => !r.ok);
const last = (read(join(T.ev, 'ready.md')).match(/^History: (\d+) runs, (\d+) failed$/m) || []).slice(1).map(Number);
const out = [
  `ready: ${failed.length ? `stop, ${failed.length} of ${rows.length} rows fail` : 'pass'}`,
  `History: ${(last[0] || 0) + 1} runs, ${(last[1] || 0) + (failed.length ? 1 : 0)} failed`,
  '',
  '| Row | Holds |',
  '|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.text.replace(/\|/g, '\\|')} |`),
].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'ready.md'), out + '\n');
if (!failed.length) writeFileSync(join(T.ev, 'ready.json'), JSON.stringify({ repos: Object.fromEntries(T.repos.map((w) => [w.name, { tree: w.tree, base: w.base }])) }, null, 2) + '\n');
console.log(out);
process.exit(failed.length ? 1 : 0);
