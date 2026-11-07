#!/usr/bin/env node
// links: is every link between the proof and what would be delivered in place, at the commits it would deliver?
// Usage: node links.mjs <ticket-folder> --delivery <n> --definition <project definition> [--definition <its .local.md>]
// Reads STATE.md, PLAN.md, evidence/ (judge, review, read, checks.json, proof.jsonl, screenshots) and git.
// Writes evidence/links-<n>.md: one row per link, and for a broken one the worker to start.
// Exit 1 when any link is broken. A round count over its cap is reported in the table, never a stop.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const vals = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const d = +vals('--delivery')[0];
if (!d) {
  console.error('usage: node links.mjs <ticket-folder> --delivery <n> --definition <file> [--definition <file>]');
  process.exit(2);
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const field = (t, k) => (t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')) || [])[1]?.trim() ?? '';
const section = (t, name) => {
  const s = t.split(/^## /m).find((c) => c.split('\n')[0].trim() === name);
  return s ? s.slice(s.indexOf('\n') + 1) : '';
};
const git = (cwd, ...a) => {
  try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim(); } catch { return null; }
};
function list(text, key) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+- .*)*)`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
  const items = v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return items.map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const screenPaths = vals('--definition').map((p) => list(read(resolve(p)), 'screen_paths')).find(Boolean);

const state = read(join(dir, 'STATE.md')), plan = read(join(dir, 'PLAN.md'));
const ev = join(dir, 'evidence');
const names = existsSync(ev) ? readdirSync(ev, { recursive: true }).map(String) : [];
const trees = {}, bases = {}, heads = {}, headTrees = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+).*?(?:at ([0-9a-f]{7,40}))?[ \t]*$/gm)) {
  trees[m[1]] = resolve(dir, m[2]);
  bases[m[1]] = m[3] || '';
  heads[m[1]] = git(trees[m[1]], 'rev-parse', 'HEAD');
  headTrees[m[1]] = git(trees[m[1]], 'rev-parse', 'HEAD^{tree}');
}
const proofs = read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const onHead = (p) => Object.keys(trees).some((r) => trees[r] === p.worktree && headTrees[r] === p.tree);
const rows = [];
const row = (link, ok, detail, worker = '') => rows.push({ link, ok, detail, worker: ok ? '' : worker });
const of = (k, n) => names.filter((f) => new RegExp(`^${k}-${n}(?:[^0-9]|$)`).test(f));

if (!Object.keys(trees).length) row('worktrees', false, 'STATE.md names no "Worktree <repo>: <path>"', 'the orchestrator');
for (const r of Object.keys(trees)) {
  const dirty = git(trees[r], 'status', '--porcelain');
  row(`${r} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${heads[r]?.slice(0, 12)}`, 'implement');
}
const judged = names.filter((f) => /^judge-(\d+)/.test(f) && +f.match(/^judge-(\d+)/)[1] <= d);
row('plan judged', judged.length > 0, judged.join(', ') || 'no judge file', 'judge');

// The last review names each changed worktree's HEAD, or a passing proof covers HEAD's tree since.
const reviews = of('review', d).sort((a, b) => +(a.match(/^review-\d+-(\d+)/) || [0, 0])[1] - +(b.match(/^review-\d+-(\d+)/) || [0, 0])[1]);
const last = reviews.at(-1);
if (!last) row('reviewed', false, `no review-${d}-<n> file`, 'review');
else {
  const text = read(join(ev, last));
  for (const r of Object.keys(trees)) {
    if (bases[r] && heads[r]?.startsWith(bases[r])) continue;
    const named = [...text.matchAll(new RegExp(`${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]);
    if (named.some((s) => heads[r]?.startsWith(s))) row(`${r} reviewed`, true, `${last} names HEAD`);
    else if (named.length && proofs.some((p) => !p.base && p.exit === 0 && trees[r] === p.worktree && headTrees[r] === p.tree))
      row(`${r} reviewed`, true, `${last} names ${named.at(-1).slice(0, 12)}; a passing proof covers HEAD's tree since`);
    else row(`${r} reviewed`, false, named.length ? `${last} names ${named.join(', ')}, not HEAD, and no passing proof covers HEAD's tree` : `${last} names no ${r}@<sha>`, 'review');
  }
}

// Each tests row that fails before the change went red on the base and green on HEAD's tree.
for (const l of section(plan, 'Tests').split('\n').filter((x) => /^\|\s*T\d+\s*\|/.test(x))) {
  const c = l.split('|').slice(1, -1).map((s) => s.trim());
  if (!/^yes\b/i.test(c[4] || '')) continue;
  const mine = proofs.filter((p) => p.test === c[0]);
  const red = mine.some((p) => p.base && p.exit !== 0 && Object.values(trees).includes(p.worktree));
  const green = mine.some((p) => !p.base && p.exit === 0 && onHead(p));
  row(`${c[0]} red then green`, red && green, `${red ? 'red on base' : 'no failing base proof'}; ${green ? "green on HEAD's tree" : "no passing proof on HEAD's tree"}`, 'implement');
}

// checks ran for this delivery at these HEADs and passed.
const checks = (() => { try { return JSON.parse(read(join(ev, 'checks.json'))); } catch { return null; } })();
const fresh = checks && checks.delivery === d && Object.keys(trees).every((r) => checks.heads?.[r] === heads[r]);
row('checks', !!(fresh && checks.ok), !checks ? 'no evidence/checks.json' : !fresh ? 'checks.json is for another delivery or HEAD' : checks.ok ? 'every due check passes' : `failing: ${checks.results.filter((x) => !x.ok).map((x) => x.id).join(', ')}`, 'verify');

// A plan with "What people see": a reader's file, and a screenshot of each state at a commit whose screens are HEAD's.
const seen = section(plan, 'What people see').trim();
if (seen) {
  row('read', of('read', d).length > 0, of('read', d).join(', ') || `no read-${d} file`, 'read');
  const states = field(seen, 'States').split(',').map((s) => s.trim()).filter(Boolean);
  if (!states.length) row('states', false, 'What people see names no States:', 'plan');
  for (const s of states) {
    const shots = names.filter((f) => basename(f).startsWith(`${s}@`));
    let verdict = 'no screenshot named <state>@<commit>';
    for (const f of shots) {
      const c = (basename(f).match(/@([0-9a-f]{7,40})/) || [])[1];
      if (!c) continue;
      if (Object.values(heads).some((h) => h?.startsWith(c))) { verdict = ''; break; }
      if (!screenPaths) { verdict = `${f} is not HEAD, and the definition names no screen_paths`; continue; }
      const r = Object.keys(trees).find((k) => git(trees[k], 'cat-file', '-e', `${c}^{commit}`) !== null);
      const diff = r ? git(trees[r], 'diff', '--name-only', c, 'HEAD') : null;
      const touched = diff === null ? null : diff.split('\n').filter(Boolean).map((x) => `${r}/${x}`).filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/'))));
      if (touched && !touched.length) { verdict = ''; break; }
      verdict = touched ? `retake: ${c.slice(0, 12)}..HEAD touches ${touched.slice(0, 3).join(', ')}` : `${c} is not a commit in any worktree`;
    }
    row(`screenshot ${s}`, !verdict, verdict || 'shows what HEAD shows', 'verify');
  }
}

// High risk: approved at a revision, on the Surface as it stands.
const surface = section(plan, 'Surface').split('\n').filter((l) => /^- S\d+:/.test(l)).map((l) => l.trim());
const hash = createHash('sha256').update(surface.join('\n')).digest('hex').slice(0, 12);
if (field(plan, 'Risk') === 'high') {
  const a = field(state, 'Approval');
  const ok = /revision \d+/.test(a) && a.includes(`surface ${hash}`);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not hold a revision and surface ${hash}`, 'the person');
}

// Round counts: reported, never a stop.
const counts = ['judge', 'read', 'review'].map((k) => `${k} ${of(k, d).length}/${k === 'review' ? 2 : 1}`);
const over = of('judge', d).length > 1 || of('read', d).length > 1 || of('review', d).length > 2;
const broken = rows.filter((r) => !r.ok);
const out = [
  `links ${d}: ${broken.length ? `stop, ${broken.length} broken` : 'pass'}; rounds ${counts.join(', ')}${over ? ' (over the cap: reported in the handoff and the record)' : ''}`,
  '',
  '| Link | Holds | Detail | Start |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.link} | ${r.ok ? 'yes' : 'no'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.worker} |`),
].join('\n');
mkdirSync(ev, { recursive: true });
writeFileSync(join(ev, `links-${d}.md`), out + '\n');
console.log(out);
process.exit(broken.length ? 1 : 0);
