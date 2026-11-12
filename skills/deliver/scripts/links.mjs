#!/usr/bin/env node
// links: is every link between the proof and what would be delivered in place, at the trees it would deliver?
// Usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <project definition> [--definition <its .local.md>]
//   --final  before the delivery's last step: checks due after its earlier steps must have passed too (checks --after)
// Reads STATE.md, PLAN.md, CHECKS.json, evidence/ (plan-shape, judge, review and read Verdict:/Commit: lines,
// checks.json, proof.jsonl, screenshots) and git. Every comparison of proof is by tree: a commit whose tree is HEAD's
// is HEAD. Writes evidence/links-<n>.md: one row per link, and for a broken one the worker to start.
// Exit 1 when any link is broken. A round count over its cap is reported in the table, never a stop.
import { writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ticket, definition, read, git, field, vals, sha, matches, testMatcher, verdict, findingFiles, roundsOf, cap } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const d = +vals(args, '--delivery')[0];
if (!d || !vals(args, '--definition').length) {
  console.error('usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <file> [--definition <file>]');
  process.exit(2);
}
const def = definition(vals(args, '--definition'));
const screenPaths = def.list('screen_paths'), nothingRan = def.list('nothing_ran') || [], oracleKinds = Object.keys(def.map('oracles'));
const T = ticket(dir), ev = T.ev, W = Object.fromEntries(Object.entries(T.worktrees).filter(([, w]) => w.path));
const rows = [];
const row = (link, ok, detail, worker = '') => rows.push({ link, ok, detail, worker: ok ? '' : worker });
const HELD = 'none: held, reported in the handoff as not delivered';
// A repository is its shared git folder, so every worktree and lane of it is the same repository.
const repoOfLine = (p) => p.repository || (existsSync(p.worktree || '') ? realpathSync(resolve(p.worktree, git(p.worktree, 'rev-parse', '--git-common-dir') || '.git')) : p.worktree);
const repoNamed = (p) => Object.keys(W).find((k) => k === p.in && W[k].repository === repoOfLine(p)) || Object.keys(W).find((k) => W[k].repository === repoOfLine(p));
const treeIsHead = (r, c) => git(W[r].path, 'rev-parse', `${c}^{tree}`) === W[r].tree;
const isTest = testMatcher(def.list('test_files'));
// The same change on a moved base: the diff from where each commit meets the base is the same patch.
const patch = (r, a, b) => { const t = git(W[r].path, 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: W[r].path, input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
const rebased = (r, s) => { const b = W[r].baseRef, p1 = b && patch(r, git(W[r].path, 'merge-base', s, b), s); return !!p1 && p1 === patch(r, git(W[r].path, 'merge-base', 'HEAD', b), 'HEAD'); };
const testsDue = T.tests.filter((t) => /^T\d+$/.test(t.id) && (!t.delivery || t.delivery <= d));
const rowTest = (f, r) => isTest(f) || testsDue.some((t) => t.file && (f === t.file || `${r}/${f}` === t.file || f.endsWith(`/${t.file}`)));
const screenTouched = (r, c) => {
  if (screenPaths?.includes(`!${r}`)) return [];
  const diff = (git(W[r].path, 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).map((x) => `${r}/${x}`);
  return screenPaths?.some((p) => p.startsWith(`${r}/`)) ? diff.filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/')))) : diff;
};

if (!Object.keys(W).length) row('worktrees', false, 'STATE.md names no existing "Worktree <repo>: <path>"', 'the orchestrator');
for (const r of Object.keys(W)) {
  const dirty = git(W[r].path, 'status', '--porcelain');
  row(`${r} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${W[r].head?.slice(0, 12)}`, 'implement');
}
// The plan as its planner last left it: only the planner writes PLAN.md and CHECKS.json, and runs plan-shape after.
const left = (read(join(ev, 'plan-shape.md')).match(/\bplan ([0-9a-f]{12})\b/) || [])[1];
row('plan as its planner left it', left === T.planHash, left === T.planHash ? `plan ${left}` : left ? `PLAN.md or CHECKS.json changed since plan-shape recorded plan ${left}: the planner reads the change, folds or rejects it, and runs plan-shape` : 'no plan-shape run with --definition', 'plan');
// The plan judged at its current revision, by this delivery's judge or an earlier one.
const revision = (t) => (t.match(/revision[\s:*_]*r?(\d+)/i) || [])[1];
const judges = T.names.filter((f) => +(f.match(/^judge-(\d+)\.md$/) || [0, 99])[1] <= d);
const judge = judges.filter((f) => revision(read(join(ev, f))) === T.revision).at(-1);
const judgeText = read(join(ev, judge || judges.at(-1) || '-'));
row('plan judged', !!judge && !!verdict(judgeText), judge ? `${judge}: ${verdict(judgeText) || 'no Verdict: line'}, revision ${T.revision}` : judges.length ? `${judges.join(', ')} judged revision ${revision(judgeText) || '(none named)'}, the plan is ${T.revision}; after "plan wrong", move it aside and judge again` : `no judge-${d}.md`, 'judge');

// The last review: clean, or fixed and read again, up to the narrow third. Each changed worktree's tree is the one its
// Commit: lines name, the same change on a moved base, or one whose diff since stays within its findings' files plus tests.
const reviews = roundsOf(T.names, 'review', d), last = reviews.at(-1);
if (!last) row('reviewed', false, `no review-${d}-<round>.md`, 'review');
else {
  const text = read(join(ev, last)), n = +last.match(/-(\d+)\.md$/)[1], v = verdict(text), files = findingFiles(text);
  row('review verdict', v === 'clean', `${last}: ${v || 'no Verdict: line'}`, !v ? 'review' : n < 2 ? 'implement, then review' : n === 2 ? `implement, then review-${d}-3 on the fixes` : HELD);
  const shas = (r) => [...text.split('\n').filter((l) => /^[\s>*_-]*commit/i.test(l)).join('\n').matchAll(new RegExp(`${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]);
  for (const r of Object.keys(W)) {
    if (W[r].at && W[r].head?.startsWith(W[r].at)) continue;
    const s = shas(r);
    if (s.some((c) => treeIsHead(r, c))) { row(`${r} reviewed`, true, `${last} names HEAD's tree`); continue; }
    if (s.some((c) => rebased(r, c))) { row(`${r} reviewed`, true, `${last} names the same change on the earlier base`); continue; }
    if (!s.length) { row(`${r} reviewed`, false, `${last} has no Commit: line naming ${r}@<sha>`, 'review'); continue; }
    const outside = (git(W[r].path, 'diff', '--name-only', s.at(-1), 'HEAD') || '').split('\n').filter((f) => f && !rowTest(f, r) && !files.some((x) => f === x || f.endsWith(`/${x}`) || x.endsWith(`/${f}`) || x === `${r}/${f}`));
    row(`${r} reviewed`, !outside.length, outside.length ? `commits since ${s.at(-1).slice(0, 12)} touch files no finding names: ${outside.slice(0, 3).join(', ')}` : `${last} names ${s.at(-1).slice(0, 12)}; the diff since stays within its findings and tests`, n < 2 ? 'review' : n === 2 ? `review-${d}-3 (narrow: reads the diff since ${s.at(-1).slice(0, 12)})` : HELD);
  }
}

// Every tests row due is green on HEAD's tree, having run something; a row that fails before the change also went red
// on the base with the words of a green in the same repository, and that pair stands whatever moves after it.
// A broken row names the missing link; the words to run are listed under "Run", once per command.
const words = (p) => JSON.stringify(p.argv || p.command);
const same = (a, b) => repoOfLine(a) === repoOfLine(b) && words(a) === words(b);
const quote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
const runs = new Map();
const due = (p, id, onBase = false, r = repoNamed(p)) => {
  if (!r) return `; ${p.in} is not a worktree STATE.md names`;
  const k = `${r} ${onBase} ${words(p)}`;
  runs.set(k, { r, p, onBase, ids: [...(runs.get(k)?.ids || []), id] });
  return `; run the words below${onBase ? ' with --base, on the base tree with only the test applied' : ''}`;
};
for (const t of testsDue) {
  const mine = T.proofs.filter((p) => p.test === t.id && !nothingRan.some((x) => matches(p.log || '', x)));
  const greens = mine.filter((p) => !p.base && p.exit === 0), green = greens.filter((p) => { const r = repoNamed(p); return r && W[r].tree === p.tree; });
  const before = t.before.startsWith('yes'), reds = mine.filter((p) => p.base && typeof p.exit === 'number' && p.exit !== 0);
  const paired = reds.filter((p) => greens.some((g) => same(g, p)));
  let why;
  if (green.length && (!before || paired.length)) why = `green on HEAD's tree${before ? `; red on base, same words (last line: ${(paired[0].log || '').trim().split('\n').at(-1)?.slice(0, 80)})` : ''}`;
  else if (!mine.length) why = `no proof line names ${t.id}: run its test with --test ${t.id} (one command proving several rows names them all)`;
  else if (before && !reds.length) why = 'no failing base run: run its test with --base on the base tree with only the test applied, then the same words on HEAD';
  else if (!green.length) {
    const dirty = Object.values(W).some((w) => w.repository === repoOfLine(mine.at(-1)) && git(w.path, 'status', '--porcelain'));
    why = `${greens.length ? 'green only on an earlier tree' : 'never green'}${dirty ? ' (the worktree has uncommitted or untracked files, so no run there is on HEAD\'s tree until they are committed or removed)' : ''}${due(reds.at(-1) || mine.at(-1), t.id)}`;
  } else {
    // A red with the green's words in another repository (a clone) can't pair: run it again in this repository.
    const elsewhere = reds.find((p) => green.some((g) => words(g) === words(p)));
    why = elsewhere ? `green on HEAD's tree; the base red ran in another repository (${elsewhere.worktree})${due(green.at(-1), t.id, true)}` : `green on HEAD's tree; the base red ran other words${due(reds.at(-1), t.id)}, so red and green share them`;
  }
  row(before ? `${t.id} red then green` : `${t.id} green`, why.startsWith("green on HEAD's tree") && !why.includes('; run'), why, 'implement');
}

// checks ran for this delivery on these trees and passed (with --final, including those due after its steps).
const checks = (() => { try { return JSON.parse(read(join(ev, 'checks.json'))); } catch { return null; } })();
const fresh = checks && checks.delivery === d && Object.keys(W).every((r) => checks.trees?.[r] === W[r].tree);
const afterDue = args.includes('--final') && T.checks.some((c) => new RegExp(`^after .+ in delivery ${d}$`).test(c.due));
const fail = !checks ? 'no evidence/checks.json' : !fresh ? 'checks.json is for another delivery or tree' : !checks.ok ? `failing: ${checks.results.filter((x) => !x.ok).map((x) => x.id).join(', ')}` : afterDue && !checks.after ? "checks due after this delivery's steps have not run (checks --after)" : '';
row('checks', !fail, fail || 'every due check passes', 'verify');

// The oracles and scripts checks_allow names by path are unchanged on the branch.
for (const w of [...new Set((def.list('checks_allow') || []).flatMap((a) => a.split(/\s+/)).filter((x) => x.includes('/')))]) {
  const [first, ...rest] = w.replace(/^\.\//, '').split('/');
  if (!W[first]?.at) continue;
  const touched = (git(W[first].path, 'diff', '--name-only', W[first].at, 'HEAD') || '').split('\n').filter((f) => f === rest.join('/') || f.startsWith(`${rest.join('/')}/`));
  if (touched.length) row(`oracle ${w}`, false, `changed on the branch: ${touched.join(', ')}; a change to it is reviewed on its own`, 'review');
}

// A plan with states to picture: a reader's file, and a screenshot of each state at a commit whose screens are HEAD's.
// A screenshot is any file whose name holds the state's name (its words joined by spaces, dashes or underscores) and a
// commit; a file goes to the longest state name it matches, so "empty" doesn't take "non-empty".
const commitIn = (c) => Object.keys(W).find((k) => git(W[k].path, 'cat-file', '-e', `${c}^{commit}`) !== null);
if (T.states) {
  const readFile = roundsOf(T.names, 'read', d)[0];
  row('read', !!readFile, readFile || `no read-${d}.md`, 'read');
  for (const c of new Set(read(join(ev, readFile || '-')).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g) || [])) {
    const r = commitIn(c), t = r && !W[r].head.startsWith(c) ? screenTouched(r, c) : [];
    if (t.length) rows.push({ link: `reader ${r}`, ok: true, detail: `reader read ${c.slice(0, 12)}; screens changed since in ${t.slice(0, 3).join(', ')} (in the handoff)`, worker: '' });
  }
  const rx = (s) => new RegExp(`(^|[^\\p{L}\\p{N}])(?<!(?:^|[^\\p{L}])(?:non|not|no)[\\s_-])${s.split(/[\s_-]+/).map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s_-]+')}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  const owner = (f) => T.states.filter((s) => rx(s).test(basename(f))).sort((a, b) => b.length - a.length)[0];
  for (const s of T.states) {
    let why = `no screenshot whose name holds "${s}" and a commit`;
    for (const c of T.names.filter((x) => owner(x) === s).flatMap((f) => basename(f).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi) || [])) {
      const r = commitIn(c);
      if (!r) continue;
      const touched = W[r].head.startsWith(c.toLowerCase()) ? [] : screenTouched(r, c);
      why = touched.length ? `retake: ${c.slice(0, 12)}..HEAD touches ${touched.slice(0, 3).join(', ')}` : '';
      if (!why) break;
    }
    row(`screenshot ${s}`, !why, why || 'shows what HEAD shows', 'verify');
  }
}

// Every other delivered delivery has its cold audit.
for (const m of T.state.matchAll(/^Delivery (\d+):.*(?<!not )\bdelivered \d{4}-\d\d-\d\d/gm)) {
  const k = +m[1], has = T.names.includes(`audit-${k}.md`);
  if (k !== d) row(`audit ${k}`, has, has ? `audit-${k}.md` : `delivery ${k} is delivered and has no evidence/audit-${k}.md`, 'audit');
}

// High risk (the plan's or its judge's): approved at a revision, on the Surface as it stands.
const hash = sha(T.surface.map((l) => l.key).join('\n'));
const noOracle = [...new Set(T.surface.filter((l) => l.touched && !oracleKinds.includes(l.kind)).map((l) => l.kind || '(no kind)'))];
if (noOracle.length) rows.push({ link: 'oracles', ok: true, detail: `no oracle for ${noOracle.join(', ')}: checked only by walk, as the handoff says`, worker: '' });
if (T.risk === 'high' || /^[\s*_-]*risk[\s*_]*:[\s*_]*high/im.test(judgeText)) {
  const a = field(T.state, 'Approval'), ok = /revision \d+/.test(a) && a.includes(`surface ${hash}`);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not hold a revision and surface ${hash}`, 'the person');
}

// Round counts: reported, never a stop.
const counts = ['judge', 'read', 'review'].map((k) => [k, roundsOf(T.names, k, d).length, cap(ev, k, d)]);
const over = counts.some(([, n, c]) => n > c);
const broken = rows.filter((r) => !r.ok);
const out = [
  `links ${d}: ${broken.length ? `stop, ${broken.length} broken` : 'pass'}; rounds ${counts.map(([k, n, c]) => `${k} ${n}/${c}`).join(', ')}${over ? ' (over the cap: reported in the handoff and the record)' : ''}`,
  '',
  '| Link | Holds | Detail | Start |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.link} | ${r.ok ? 'yes' : 'no'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.worker} |`),
  ...(runs.size ? ['', 'Run (each once, on HEAD unless it says --base; heavy ones when there is room):', ...[...runs.values()].map(({ r, p, onBase, ids }) => {
    const argv = p.argv || String(p.command).split(' ');
    return `- proof ${quote(dir)} --in ${r} --test ${ids.join(',')}${onBase ? ' --base' : ''} -- ${argv.map(quote).join(' ')}${argv.some((x) => /(^|\/)evidence\/|^\/tmp\/|^\/private\/|\.log$/.test(x)) ? '   (names an output path: remove it so this run does not overwrite another)' : ''}`;
  })] : []),
].join('\n');
mkdirSync(ev, { recursive: true });
writeFileSync(join(ev, `links-${d}.md`), out + '\n');
console.log(out);
process.exit(broken.length ? 1 : 0);
