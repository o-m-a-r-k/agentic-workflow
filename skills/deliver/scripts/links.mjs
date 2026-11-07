#!/usr/bin/env node
// links: is every link between the proof and what would be delivered in place, at the commits it would deliver?
// Usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <project definition> [--definition <its .local.md>]
//   --final  before the delivery's last step: checks due after its earlier steps must have passed too (checks --after)
// Reads STATE.md, PLAN.md, evidence/ (judge, review, read, checks.json, proof.jsonl, screenshots) and git.
// Writes evidence/links-<n>.md: one row per link, and for a broken one the worker to start.
// Exit 1 when any link is broken. A round count over its cap is reported in the table, never a stop.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const vals = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const d = +vals('--delivery')[0];
if (!d) {
  console.error('usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <file> [--definition <file>]');
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
const trees = {}, bases = {}, baseRef = {}, heads = {}, headTrees = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)(?:.*?\bfrom (\S+))?.*?(?:at ([0-9a-f]{7,40}))?[ \t]*$/gm)) {
  if (!existsSync(resolve(dir, m[2]))) continue;
  const p = (trees[m[1]] = realpathSync(resolve(dir, m[2])));
  bases[m[1]] = m[4] || '';
  baseRef[m[1]] = m[3] ? [`origin/${m[3]}`, m[3]].find((b) => git(p, 'rev-parse', '--verify', '-q', b)) : null;
  heads[m[1]] = git(p, 'rev-parse', 'HEAD');
  headTrees[m[1]] = git(p, 'rev-parse', 'HEAD^{tree}');
}
const proofs = read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const onHead = (p, r) => trees[r] === p.worktree && headTrees[r] === p.tree;
const rows = [];
const row = (link, ok, detail, worker = '') => rows.push({ link, ok, detail, worker: ok ? '' : worker });
const of = (k, n) => names.filter((f) => new RegExp(`^${k}-${n}(?:[^0-9]|$)`).test(f));
const verdict = (f) => field(read(join(ev, f)), 'Verdict').toLowerCase();
// The same change on a moved base: the diff from where each commit meets the base is the same patch.
const patch = (r, a, b) => { const t = git(trees[r], 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: trees[r], input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
const rebased = (r, s) => {
  if (!baseRef[r]) return false;
  const m1 = git(trees[r], 'merge-base', s, baseRef[r]), m2 = git(trees[r], 'merge-base', 'HEAD', baseRef[r]);
  const p1 = m1 && patch(r, m1, s);
  return !!p1 && p1 === patch(r, m2, 'HEAD');
};

if (!Object.keys(trees).length) row('worktrees', false, 'STATE.md names no existing "Worktree <repo>: <path>"', 'the orchestrator');
for (const r of Object.keys(trees)) {
  const dirty = git(trees[r], 'status', '--porcelain');
  row(`${r} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${heads[r]?.slice(0, 12)}`, 'implement');
}
const judge = of('judge', d)[0];
row('plan judged', !!judge && !!verdict(judge), judge ? `${judge}: ${verdict(judge) || 'no Verdict: line'}` : `no judge-${d} file`, 'judge');
const open = section(plan, 'Memos').split(/^### /m).slice(1).filter((m) => !/^-[ \t]*\**Decided:\**[ \t]*(?!open\b)\S/im.test(m));
if (open.length) row('memos decided', false, `open: ${open.map((m) => m.split(/[:\s]/)[0]).join(', ')}`, 'the person');

// The last review is clean (or round 2, its open findings in the handoff) and names each changed worktree's HEAD,
// the same change on a moved base, or HEAD's tree proven since by a tests-row run.
const reviews = of('review', d);
const round = (f) => +(f.match(/^review-\d+-(\d+)\.md$/) || [])[1];
const odd = reviews.filter((f) => !round(f));
const last = reviews.filter(round).sort((a, b) => round(a) - round(b)).at(-1);
if (odd.length) row('review files', false, `not named review-${d}-<round>.md: ${odd.join(', ')}`, 'the orchestrator');
if (!last) row('reviewed', false, `no review-${d}-<round>.md`, 'review');
else {
  const v = verdict(last);
  row('review verdict', v === 'clean' || (v.startsWith('fix') && round(last) >= 2), `${last}: ${v || 'no Verdict: line'}${v.startsWith('fix') && round(last) >= 2 ? ' (open findings go to the handoff)' : ''}`, v.startsWith('fix') ? 'implement, then review' : 'review');
  const text = read(join(ev, last));
  for (const r of Object.keys(trees)) {
    if (bases[r] && heads[r]?.startsWith(bases[r])) continue;
    const named = [...text.matchAll(new RegExp(`${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]);
    if (named.some((s) => heads[r]?.startsWith(s))) row(`${r} reviewed`, true, `${last} names HEAD`);
    else if (named.some((s) => rebased(r, s))) row(`${r} reviewed`, true, `${last} names the same change on the earlier base`);
    else if (named.length && proofs.some((p) => p.test && !p.base && p.exit === 0 && onHead(p, r)))
      row(`${r} reviewed`, true, `${last} names ${named.at(-1).slice(0, 12)}; a tests-row proof covers HEAD's tree since`);
    else row(`${r} reviewed`, false, named.length ? `${last} names ${named.join(', ')}: not HEAD, not the same change, no tests-row proof on HEAD's tree` : `${last} names no ${r}@<sha>`, 'review');
  }
}

// Each tests row that fails before the change: the same command red on the base, green on HEAD's tree.
for (const l of section(plan, 'Tests').split('\n').filter((x) => /^\|\s*T\d+\s*\|/.test(x))) {
  const c = l.split('|').slice(1, -1).map((s) => s.trim());
  if (!/^yes\b/i.test(c[4] || '')) continue;
  const mine = proofs.filter((p) => p.test === c[0]);
  const green = mine.filter((p) => !p.base && p.exit === 0 && Object.keys(trees).some((r) => onHead(p, r)));
  const red = mine.filter((p) => p.base && typeof p.exit === 'number' && p.exit !== 0 && green.some((g) => g.command === p.command && g.worktree === p.worktree));
  row(`${c[0]} red then green`, red.length > 0 && green.length > 0, `${green.length ? "green on HEAD's tree" : "no passing proof on HEAD's tree"}; ${red.length ? 'red on base, same command' : 'no failing base run of the same command'}`, 'implement');
}

// checks ran for this delivery at these HEADs and passed (with --final, including those due after its steps).
const checks = (() => { try { return JSON.parse(read(join(ev, 'checks.json'))); } catch { return null; } })();
const fresh = checks && checks.delivery === d && Object.keys(trees).every((r) => checks.heads?.[r] === heads[r]);
const afterDue = args.includes('--final') && (() => { try { return JSON.parse(read(join(dir, 'CHECKS.json'))); } catch { return []; } })().some((c) => new RegExp(`^after .+ in delivery ${d}$`).test(c.due));
const fail = !checks ? 'no evidence/checks.json' : !fresh ? 'checks.json is for another delivery or HEAD' : !checks.ok ? `failing: ${checks.results.filter((x) => !x.ok).map((x) => x.id).join(', ')}` : afterDue && !checks.after ? 'checks due after this delivery\'s steps have not run (checks --after)' : '';
row('checks', !fail, fail || 'every due check passes', 'verify');

// A plan with "What people see": a reader's file, and a screenshot of each state at a commit whose screens are HEAD's.
const seen = section(plan, 'What people see').trim();
if (seen) {
  row('read', of('read', d).length > 0, of('read', d).join(', ') || `no read-${d} file`, 'read');
  const states = field(seen, 'States').split(',').map((s) => s.trim()).filter(Boolean);
  if (!states.length) row('states', false, 'What people see names no States:', 'plan');
  for (const s of states) {
    let why = 'no screenshot named <state>@<commit>';
    for (const f of names.filter((x) => basename(x).startsWith(`${s}@`))) {
      const c = (basename(f).match(/@([0-9a-f]{7,40})/) || [])[1];
      const r = c && Object.keys(trees).find((k) => git(trees[k], 'cat-file', '-e', `${c}^{commit}`) !== null);
      if (!r) { why = `${f}: not a commit in any worktree`; continue; }
      if (heads[r].startsWith(c)) { why = ''; break; }
      if (!screenPaths) { why = `${f} is not ${r} HEAD, and the definition names no screen_paths`; continue; }
      const touched = (git(trees[r], 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).map((x) => `${r}/${x}`).filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/'))));
      if (!touched.length) { why = ''; break; }
      why = `retake: ${c.slice(0, 12)}..HEAD touches ${touched.slice(0, 3).join(', ')}`;
    }
    row(`screenshot ${s}`, !why, why || 'shows what HEAD shows', 'verify');
  }
}

// High risk (the higher of the header and the Risk table): approved at a revision, on the Surface as it stands.
const surface = section(plan, 'Surface').split('\n').filter((l) => /^- S\d+:/.test(l)).map((l) => l.trim());
const hash = createHash('sha256').update(surface.map((l) => l.replace(/`[^`]*`/g, '').replace(/\s+/g, ' ').trim()).join('\n')).digest('hex').slice(0, 12);
if (field(plan, 'Risk') === 'high' || /\|\s*high\s*\|/i.test(section(plan, 'Risk'))) {
  const a = field(state, 'Approval');
  const ok = /revision \d+/.test(a) && a.includes(`surface ${hash}`);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not hold a revision and surface ${hash}`, 'the person');
}

// Round counts: reported, never a stop.
const counts = ['judge', 'read', 'review'].map((k) => `${k} ${of(k, d).length}/${k === 'review' ? 2 : 1}`);
const over = of('judge', d).length > 1 || of('read', d).length > 1 || reviews.length > 2;
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
