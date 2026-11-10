#!/usr/bin/env node
// links: is every link between the proof and what would be delivered in place, at the commits it would deliver?
// Usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <project definition> [--definition <its .local.md>]
//   --final  before the delivery's last step: checks due after its earlier steps must have passed too (checks --after)
// Reads STATE.md, PLAN.md, CHECKS.json, evidence/ (judge, review, read, checks.json, proof.jsonl, screenshots) and git.
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
if (!vals('--definition').length) {
  console.error('links: --definition <project definition> is required: its oracles, screen_paths and nothing_ran decide rows');
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
// A repository is its shared git folder, so every worktree and lane of it is the same repository.
const repoOf = (w) => { const c = existsSync(w) && git(w, 'rev-parse', '--git-common-dir'); return c ? realpathSync(resolve(w, c)) : w; };
function list(text, key) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+- .*)*)`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
  const items = v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''));
  return items.map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const setting = (key) => vals('--definition').map((p) => list(read(resolve(p)), key)).find(Boolean);
const oracleKinds = vals('--definition').flatMap((p) => { const fm = (read(resolve(p)).match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''; const m = fm.match(/^oracles:[ \t]*\n((?:[ \t]+\S.*\n?)*)/m); return m ? [...m[1].matchAll(/^[ \t]+([^\s:]+):/gm)].map((x) => x[1].toLowerCase()) : []; });
const screenPaths = setting('screen_paths');
const nothingRan = setting('nothing_ran') || [];
const matches = (out, p) => { const rx = p.match(/^\/(.*)\/([a-z]*)$/s); return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(p); };

const state = read(join(dir, 'STATE.md')), plan = read(join(dir, 'PLAN.md'));
const ev = join(dir, 'evidence');
const names = existsSync(ev) ? readdirSync(ev, { recursive: true }).map(String) : [];
const trees = {}, bases = {}, baseRef = {}, heads = {}, headTrees = {}, repos = {};
for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)(?:.*?\bfrom (\S+))?.*?(?:at ([0-9a-f]{7,40}))?[ \t]*$/gm)) {
  if (!existsSync(resolve(dir, m[2]))) continue;
  const p = (trees[m[1]] = realpathSync(resolve(dir, m[2])));
  bases[m[1]] = m[4] || '';
  baseRef[m[1]] = m[3] ? [`origin/${m[3]}`, m[3]].find((b) => git(p, 'rev-parse', '--verify', '-q', b)) : null;
  heads[m[1]] = git(p, 'rev-parse', 'HEAD');
  headTrees[m[1]] = git(p, 'rev-parse', 'HEAD^{tree}');
  repos[m[1]] = repoOf(p);
}
// The previous links table: a narrow third review it named stays earned.
const earlier = read(join(ev, `links-${d}.md`));
const proofs = read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
// A line from before the repository was recorded whose worktree is gone counts as the repository STATE names it by.
const repoOfLine = (p) => p.repository || (existsSync(p.worktree || '') ? repoOf(p.worktree) : repos[p.in] || p.worktree);
const onHead = (p, r) => repoOfLine(p) === repos[r] && headTrees[r] === p.tree;
const ranSomething = (p) => !nothingRan.some((x) => matches(p.log || '', x));
const rows = [];
const row = (link, ok, detail, worker = '') => rows.push({ link, ok, detail, worker: ok ? '' : worker });
const exact = { judge: /^judge-(\d+)\.md$/, read: /^read-(\d+)\.md$/, review: /^review-(\d+)-(\d+)\.md$/ };
const of = (k, n) => names.filter((f) => (f.match(exact[k]) || [])[1] === String(n));
// A verdict line as models write it, "**Verdict:** Fix: 2 findings." -> "fix"; "fix: 0" -> "clean".
const verdict = (t) => {
  const v = ((t.match(/^[\s>#*_-]*verdict[\s*_`]*:[\s*_`]*(.+)$/im) || [])[1] || '').replace(/[*_`]/g, '').trim().toLowerCase();
  const k = (v.match(/^(clean|fix|build|approval)/) || [])[1] || '';
  return k === 'fix' && /^fix\w*:?\s*0\b/.test(v) ? 'clean' : k;
};
const findings = (t) => t.split(/^#+\s*outside the ticket/im)[0];
// A review's findings: blocks from an F<n> line to the next F<n> line or heading. Its state comes from the verdict line
// and the findings together; when they disagree, or there is no verdict and no finding, the file is broken.
const blocks = (t) => findings(t).split('\n').reduce((acc, l) => { if (/^[\s>#*_-]*F\d+\b/.test(l)) acc.push(l); else if (/^#/.test(l)) acc.push(null); else if (acc.length && acc.at(-1) !== null) acc[acc.length - 1] += `\n${l}`; return acc; }, []).filter(Boolean);
const reviewState = (t) => {
  const v = verdict(t), n = blocks(t).length, said = +((t.match(/^[\s>#*_-]*verdict.*?(\d+)\s+(?:\w+\s+){0,3}findings?/im) || [])[1] || 0);
  if (said && said !== n) return 'broken';
  return v === 'clean' && !n ? 'clean' : (v === 'fix' || !v) && n ? 'fix' : 'broken';
};
const filesOf = (bs) => bs.flatMap((b) => [...b.matchAll(/([^\s`'"()]+\.\w+):\d+/g)].map((m) => m[1]));
// Test files: the definition's test_files globs, or a default across common languages.
const globs = setting('test_files') || ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_tests.*', '**/test_*.*', '**/tests.*', '**/*_spec.rb', '**/*Test.*', '**/*Tests.*'];
const glob = (g) => new RegExp(`^${g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')}$`);
const testRx = globs.map(glob);
// The same change on a moved base: the diff from where each commit meets the base is the same patch.
const patch = (r, a, b) => { const t = git(trees[r], 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: trees[r], input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
const rebased = (r, s) => {
  if (!baseRef[r]) return false;
  const p1 = patch(r, git(trees[r], 'merge-base', s, baseRef[r]), s);
  return !!p1 && p1 === patch(r, git(trees[r], 'merge-base', 'HEAD', baseRef[r]), 'HEAD');
};
// Tests rows due by this delivery (the Delivery column; empty means every delivery).
const testsRows = section(plan, 'Tests').split('\n').filter((x) => /^\|\s*T\d+\s*\|/.test(x)).map((l) => l.split('|').slice(1, -1).map((s) => s.trim())).filter((c) => !/\d/.test(c[5] || '') || +c[5].match(/\d+/)[0] <= d);
const rowFile = (c) => (c[2] || '').replace(/`/g, '').split('›')[0].trim();
const isTest = (f) => testRx.some((rx) => rx.test(f)) || testsRows.some((c) => rowFile(c) && (f === rowFile(c) || f.endsWith(`/${rowFile(c)}`)));
const screenTouched = (r, c) => { if (screenPaths?.includes(`!${r}`)) return []; const diff = (git(trees[r], 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).map((x) => `${r}/${x}`); return screenPaths?.some((p) => p.startsWith(`${r}/`)) ? diff.filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/')))) : diff; };

if (!Object.keys(trees).length) row('worktrees', false, 'STATE.md names no existing "Worktree <repo>: <path>"', 'the orchestrator');
for (const r of Object.keys(trees)) {
  const dirty = git(trees[r], 'status', '--porcelain');
  row(`${r} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${heads[r]?.slice(0, 12)}`, 'implement');
}
// The plan judged at its current revision, by this delivery's judge or an earlier one (a later delivery on an
// unchanged plan needs no new judge).
const revision = (t) => (t.match(/revision[\s:*_]*r?(\d+)/i) || t.match(/\br(\d+)\b/) || [])[1];
const judges = names.filter((f) => (f.match(exact.judge) || [99, 99])[1] <= d && exact.judge.test(f));
const judge = judges.filter((f) => revision(read(join(ev, f))) === revision(plan)).at(-1);
const judgeText = judge || judges.length ? read(join(ev, judge || judges.at(-1))) : '';
row('plan judged', !!judge && !!verdict(judgeText), judge ? `${judge}: ${verdict(judgeText) || 'no Verdict: line'}, revision ${revision(plan)}` : judges.length ? `${judges.join(', ')} ${revision(judgeText) ? `judged revision ${revision(judgeText)}, the plan is ${revision(plan)}; after "plan wrong", move it aside and judge again` : 'names no Revision: line; the judge adds it'}` : `no judge-${d}.md`, 'judge');
const open = section(plan, 'Memos').split(/^### /m).slice(1).filter((m) => +(m.match(/^-[ \t]*\**Due:\**[ \t]*before delivery (\d+)/m) || [0, d])[1] <= d && !/^-[ \t]*\**Decided:\**[ \t]*(?!(open|pending|undecided|tbd)\b)\S/im.test(m));
if (open.length) row('memos decided', false, `open: ${open.map((m) => m.split(/[:\s]/)[0]).join(', ')}`, 'the person');

// The last review: clean; round 2 with no open [S<n>] finding (the rest goes to the handoff); or round 3, the narrow
// review of an open [S<n>] fix or of a diff after review that links reported, whose findings all count as Surface.
// Each changed worktree's HEAD is named in its Commit: lines, or the same change on a moved base, or a commit whose
// diff since stays within the files its findings name plus tests. Past round 3, anything open holds the delivery.
const HELD = 'none: held, reported in the handoff as not delivered';
const reviews = of('review', d).sort((a, b) => +a.match(exact.review)[2] - +b.match(exact.review)[2]);
const last = reviews.at(-1);
if (!last) row('reviewed', false, `no review-${d}-<round>.md`, 'review');
else {
  const text = read(join(ev, last)), n = +last.match(exact.review)[2], st = reviewState(text), bs = blocks(text);
  const openS = st === 'fix' ? (n >= 3 ? bs.map((b) => b.match(/F\d+/)[0]) : [...new Set(bs.flatMap((b) => b.match(/\[(?:S\d+|surface)\]/gi) || []))]) : [];
  const ok = st === 'clean' || (st === 'fix' && n === 2 && !openS.length);
  const next = st === 'broken' ? `a fresh reviewer rewrites ${last} (verdict and F<n> findings disagree or are missing; not a new round)` : n < 2 ? 'implement, then review' : n === 2 ? `implement, then review-${d}-3 on ${openS.join(', ')}` : HELD;
  row('review verdict', ok, `${last}: ${st}${openS.length ? `; open Surface findings ${openS.join(', ')}` : ok && st === 'fix' ? ' (open findings go to the handoff)' : ''}`, next);
  const commitLines = text.split('\n').filter((l) => /^[\s>*_-]*commit/i.test(l)).join('\n');
  const named = (t, r) => [...t.matchAll(new RegExp(`${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]);
  const files = filesOf(bs);
  for (const r of Object.keys(trees)) {
    if (bases[r] && heads[r]?.startsWith(bases[r])) continue;
    const shas = named(commitLines, r);
    if (shas.some((s) => heads[r]?.startsWith(s))) { row(`${r} reviewed`, true, `${last} names HEAD`); continue; }
    if (shas.some((s) => rebased(r, s))) { row(`${r} reviewed`, true, `${last} names the same change on the earlier base`); continue; }
    if (!shas.length) { row(`${r} reviewed`, false, `${last} has no Commit: line naming ${r}@<sha>`, 'review'); continue; }
    const diff = (git(trees[r], 'diff', '--name-only', shas.at(-1), 'HEAD') || '').split('\n').filter(Boolean);
    const outside = diff.filter((f) => !isTest(f) && !files.some((x) => f === x || f.endsWith(`/${x}`) || x.endsWith(`/${f}`) || x === `${r}/${f}`));
    row(`${r} reviewed`, !outside.length, outside.length ? `commits since ${shas.at(-1).slice(0, 12)} touch files no finding names: ${outside.slice(0, 3).join(', ')}` : `${last} names ${shas.at(-1).slice(0, 12)}; the diff since stays within its findings and tests`, n < 2 ? 'review' : n === 2 ? `review-${d}-3 (narrow: reads the diff since ${shas.at(-1).slice(0, 12)})` : HELD);
  }
}
const ignored = names.filter((f) => /^(judge|read|review)-/.test(f) && !Object.values(exact).some((x) => x.test(f)) && !/^judge-\d+-r\d+\.md$/.test(f));
if (ignored.length) rows.push({ link: 'ignored files', ok: true, detail: `not round files, not read: ${ignored.join(', ')}`, worker: '' });

// Every tests row due by this delivery is green on HEAD's tree, having run something; a row that fails before the
// change also went red on the base with the same words in the same repository. A broken row says which link is
// missing and the words to run; rows the same words prove are run once, listed under "Run" below the table.
const same = (a, b) => repoOfLine(a) === repoOfLine(b) && (a.argv && b.argv ? JSON.stringify(a.argv) === JSON.stringify(b.argv) : a.command === b.command);
const quote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
const runs = new Map();
// A Run line: on HEAD unless marked --base; a line recorded before exact words were kept is printed as its text.
const due = (p, id, onBase = false, r = Object.keys(trees).find((k) => k === p.in && repos[k] === repoOfLine(p)) || Object.keys(trees).find((k) => repos[k] === repoOfLine(p))) => {
  if (!r) return `; ${p.in} is not a worktree STATE.md names`;
  const k = `${r} ${onBase} ${p.argv ? JSON.stringify(p.argv) : p.command}`;
  runs.set(k, { r, p, onBase, ids: [...(runs.get(k)?.ids || []), id] });
  return `; run the words below${onBase ? ' with --base, on the base tree with only the test applied' : ''}`;
};
for (const c of testsRows) {
  const mine = proofs.filter((p) => p.test === c[0] && ranSomething(p));
  const green = mine.filter((p) => !p.base && p.exit === 0 && Object.keys(trees).some((r) => onHead(p, r)));
  const before = /^yes\b/i.test(c[4] || '');
  const reds = mine.filter((p) => p.base && typeof p.exit === 'number' && p.exit !== 0);
  const red = reds.filter((p) => green.some((g) => same(g, p)));
  const ok = green.length > 0 && (!before || red.length > 0);
  let why;
  if (ok) why = `green on HEAD's tree${before ? `; red on base, same words (last line: ${(red[0].log || '').trim().split('\n').at(-1)?.slice(0, 80)})` : ''}`;
  else if (!mine.length) why = `no proof line names ${c[0]}: run its test with --test ${c[0]} (one command proving several rows names them all)`;
  else if (before && !reds.length) why = `no failing base run: run its test with --base on the base tree with only the test applied, then the same words on HEAD`;
  else if (!green.length) {
    const greens = mine.filter((p) => !p.base && p.exit === 0);
    const dirty = Object.keys(trees).some((r) => repos[r] === repoOfLine(mine.at(-1)) && git(trees[r], 'status', '--porcelain'));
    why = `${greens.length ? 'green only on an earlier tree' : 'never green'}${dirty ? ' (the worktree has uncommitted or untracked files, so no run there is on HEAD\'s tree until they are committed or removed)' : ''}${due(reds.at(-1) || mine.at(-1), c[0])}`;
  } else {
    // A red with the green's words in another repository (a clone) can't pair: run it again in this repository.
    const elsewhere = reds.find((p) => green.some((g) => (g.argv && p.argv ? JSON.stringify(g.argv) === JSON.stringify(p.argv) : g.command === p.command)));
    why = elsewhere ? `green on HEAD's tree; the base red ran in another repository (${elsewhere.worktree})${due(green.at(-1), c[0], true)}` : `green on HEAD's tree; the base red ran other words${due(reds.at(-1), c[0])}, so red and green share them`;
  }
  row(before ? `${c[0]} red then green` : `${c[0]} green`, ok, why, 'implement');
}

// checks ran for this delivery at these HEADs and passed (with --final, including those due after its steps).
const checks = (() => { try { return JSON.parse(read(join(ev, 'checks.json'))); } catch { return null; } })();
const fresh = checks && checks.delivery === d && Object.keys(trees).every((r) => checks.heads?.[r] === heads[r]);
const afterDue = args.includes('--final') && (() => { try { return JSON.parse(read(join(dir, 'CHECKS.json'))); } catch { return []; } })().some((c) => new RegExp(`^after .+ in delivery ${d}$`).test(c.due));
const fail = !checks ? 'no evidence/checks.json' : !fresh ? 'checks.json is for another delivery or HEAD' : !checks.ok ? `failing: ${checks.results.filter((x) => !x.ok).map((x) => x.id).join(', ')}` : afterDue && !checks.after ? "checks due after this delivery's steps have not run (checks --after)" : '';
row('checks', !fail, fail || 'every due check passes', 'verify');

// The oracles and scripts checks_allow names by path are unchanged on the branch.
for (const w of [...new Set((setting('checks_allow') || []).flatMap((a) => a.split(/\s+/)).filter((w) => w.includes('/')))]) {
  const [first, ...rest] = w.replace(/^\.\//, '').split('/');
  if (!trees[first] || !bases[first]) continue;
  const touched = (git(trees[first], 'diff', '--name-only', bases[first], 'HEAD') || '').split('\n').filter((f) => f === rest.join('/') || f.startsWith(`${rest.join('/')}/`));
  if (touched.length) row(`oracle ${w}`, false, `changed on the branch: ${touched.join(', ')}; a change to it is reviewed on its own`, 'review');
}

// A plan with "What people see": a reader's file, and a screenshot of each state at a commit whose screens are HEAD's.
// A screenshot is any file whose name holds the state's name and a commit (7 to 40 hex characters).
// A state's name matches a file name with its words joined by spaces, dashes or underscores; a file goes to the
// longest state name it matches, so "empty" doesn't take "non-empty". "None" means nothing people see changes.
const seen = section(plan, 'What people see').trim();
if (seen && !/^none\b/i.test(seen)) {
  const readFile = of('read', d)[0];
  row('read', !!readFile, readFile || `no read-${d}.md`, 'read');
  // The reader knows only the commit, so its sha is matched to the repo that holds it.
  if (readFile) for (const [r, c] of [...new Set(read(join(ev, readFile)).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g) || [])].map((c) => [Object.keys(trees).find((k) => git(trees[k], 'cat-file', '-e', `${c}^{commit}`) !== null), c]).filter(([r]) => r)) {
    const t = heads[r].startsWith(c) ? [] : screenTouched(r, c);
    if (t.length) rows.push({ link: `reader ${r}`, ok: true, detail: `reader read ${c.slice(0, 12)}; screens changed since in ${t.slice(0, 3).join(', ')} (in the handoff)`, worker: '' });
  }
  // States: free (390 en ar, 1440 en), taken (1440 en): the names, split on commas outside parentheses.
  const states = field(seen, 'States').split(/,(?![^()]*\))/).map((s) => s.replace(/\(.*\)/, '').trim()).filter(Boolean);
  if (!states.length) row('states', false, 'What people see has no "States: <state>, <state>" line', 'plan');
  const rx = (s) => new RegExp(`(^|[^\\p{L}\\p{N}])(?<!(?:^|[^\\p{L}])(?:non|not|no)[\\s_-])${s.split(/[\s_-]+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s_-]+')}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  const owner = (f) => states.filter((s) => rx(s).test(basename(f))).sort((a, b) => b.length - a.length)[0];
  for (const s of states) {
    let why = `no screenshot whose name holds "${s}" and a commit`;
    for (const f of names.filter((x) => owner(x) === s)) {
      for (const c of basename(f).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi) || []) {
        const r = Object.keys(trees).find((k) => git(trees[k], 'cat-file', '-e', `${c}^{commit}`) !== null);
        if (!r) continue;
        if (heads[r].startsWith(c.toLowerCase())) { why = ''; break; }
        const touched = screenTouched(r, c);
        if (!touched.length) { why = ''; break; }
        why = `retake: ${c.slice(0, 12)}..HEAD touches ${touched.slice(0, 3).join(', ')}`;
      }
      if (!why) break;
    }
    row(`screenshot ${s}`, !why, why || 'shows what HEAD shows', 'verify');
  }
}

// Every other delivered delivery has its cold audit.
for (const m of state.matchAll(/^Delivery (\d+):.*(?<!not )\bdelivered \d{4}-\d\d-\d\d/gm)) {
  const k = +m[1];
  if (k !== d) row(`audit ${k}`, names.includes(`audit-${k}.md`), names.includes(`audit-${k}.md`) ? `audit-${k}.md` : `delivery ${k} is delivered and has no evidence/audit-${k}.md`, 'audit');
}

// High risk (the higher of the header and the Risk table): approved at a revision, on the Surface as it stands.
const LINE = /^- (S\d+)(?: \(([^)]+)\))?:[ \t]*(.*)$/;
const surface = section(plan, 'Surface').split('\n').filter((l) => LINE.test(l)).map((l) => l.trim());
const equals = (l) => ((l.replace(/`[^`]*`/g, '').match(/\bequals\b([^;]*)/i) || [])[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
const key = (l) => { const m = l.match(LINE); return `${m[1]}|${(m[2] || '').trim().toLowerCase()}|${/^not touched\b/i.test(m[3]) ? 'not touched' : 'touched'}|${equals(l)}`; };
const hash = createHash('sha256').update(surface.map(key).join('\n')).digest('hex').slice(0, 12);
const noOracle = [...new Set(surface.map((l) => l.match(LINE)).filter((m) => !/^not touched\b/i.test(m[3])).map((m) => (m[2] || '').trim().toLowerCase()).filter((k) => !oracleKinds.includes(k)))];
if (noOracle.length) rows.push({ link: 'oracles', ok: true, detail: `no oracle for ${noOracle.map((k) => k || '(no kind)').join(', ')}: checked only by walk, as the handoff says`, worker: '' });
if (field(plan, 'Risk') === 'high' || /\|\s*high\s*\|/i.test(section(plan, 'Risk')) || verdict(judgeText) === 'approval' || /^[\s*_-]*risk[\s*_]*:[\s*_]*high/im.test(judgeText)) {
  const a = field(state, 'Approval');
  const ok = /revision \d+/.test(a) && a.includes(`surface ${hash}`);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not hold a revision and surface ${hash}`, 'the person');
}

// Round counts: reported, never a stop.
const r2 = read(join(ev, `review-${d}-2.md`));
const cap = (reviewState(r2) === 'fix' && /\[(?:S\d+|surface)\]/i.test(findings(r2))) || rows.some((r) => r.worker.startsWith(`review-${d}-3`)) || new RegExp(`\\| review-${d}-3\\b`).test(earlier) ? 3 : 2;
const counts = ['judge', 'read', 'review'].map((k) => `${k} ${of(k, d).length}/${k === 'review' ? cap : 1}`);
const over = of('judge', d).length > 1 || of('read', d).length > 1 || reviews.length > cap;
const broken = rows.filter((r) => !r.ok);
const out = [
  `links ${d}: ${broken.length ? `stop, ${broken.length} broken` : 'pass'}; rounds ${counts.join(', ')}${over ? ' (over the cap: reported in the handoff and the record)' : ''}`,
  '',
  '| Link | Holds | Detail | Start |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.link} | ${r.ok ? 'yes' : 'no'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.worker} |`),
  ...(runs.size ? ['', 'Run (each once, on HEAD unless it says --base; heavy ones when there is room):', ...[...runs.values()].map(({ r, p, onBase, ids }) => { const w = p.argv ? p.argv.map(quote).join(' ') : p.command; const out = (p.argv || p.command.split(' ')).some((x) => /(^|\/)evidence\/|^\/tmp\/|^\/private\/|\.log$/.test(x)); return `- proof ${quote(dir)} --in ${r} --test ${ids.join(',')}${onBase ? ' --base' : ''} -- ${w}${p.argv ? '' : '   (recorded as text before exact words were kept: group the words as the runner needs)'}${out ? '   (names an output path: remove it so this run does not overwrite another)' : ''}`; })] : []),
].join('\n');
mkdirSync(ev, { recursive: true });
writeFileSync(join(ev, `links-${d}.md`), out + '\n');
console.log(out);
process.exit(broken.length ? 1 : 0);
