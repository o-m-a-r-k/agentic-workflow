#!/usr/bin/env node
// links: is every link between the proof and what would be delivered in place, on commits that stand for HEAD?
// Usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <project definition> [--definition <its .local.md>]
//   --final  before the delivery's last step: checks due after its earlier steps must have passed too (checks --after)
// Reads STATE.md, PLAN.md, CHECKS.json, evidence/ (plan-shape.md; the Plan:, Risk:, Verdict: and Commit: lines of
// challenges, reviews and reads; verify-<n>.md's "Failing <id>:" lines; checks.json; proof.jsonl; screenshots) and git.
// What stands as proof is ticket.mjs's rule. Writes evidence/links-<n>.md: one row per link, and for a broken one the
// worker to start. Exit 1 when any link is broken.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { ticket, definitionOf, proofRules, read, git, field, fields, vals, sha, verdict, findingFiles, roundsOf, due, specOf, normPath } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const d = +vals(args, '--delivery')[0];
if (!d) { console.error('usage: node links.mjs <ticket-folder> --delivery <n> [--final] --definition <file> [--definition <file>]'); process.exit(2); }
const def = definitionOf(args);
const T = ticket(dir), ev = T.ev, R = proofRules(T, def), W = Object.fromEntries(T.delivered.map((w) => [w.name, w]));
const screenPaths = def.list('screen_paths'), oracleKinds = Object.keys(def.map('oracles'));
const rows = [];
const row = (link, ok, detail, worker = '') => rows.push({ link, ok, detail, worker: ok ? '' : worker });
const commitsOf = (t, r) => fields(t, 'commit').flatMap((v) => [...v.matchAll(new RegExp(`(?:^|\\s)${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]));
const screenTouched = (w, c) => {
  if (screenPaths?.includes(`!${w.name}`)) return [];
  const diff = (git(w.path, 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).map((x) => `${w.name}/${x}`);
  return screenPaths?.some((p) => p.startsWith(`${w.name}/`)) ? diff.filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/')))) : diff;
};

if (!T.delivered.length) row('worktrees', false, 'STATE.md names no existing "Worktree <repo>: <path>"', 'the orchestrator');
for (const w of T.delivered) {
  const dirty = git(w.path, 'status', '--porcelain');
  row(`${w.name} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${w.head?.slice(0, 12)}`, 'implement');
}
// The plan as its planner last left it, passing plan-shape: only the planner writes PLAN.md and CHECKS.json.
const shape = read(join(ev, 'plan-shape.md')), left = (shape.match(/\bplan ([0-9a-f]{12})\b/) || [])[1], passed = /^plan-shape: pass$/m.test(shape);
row('plan as its planner left it', left === T.planHash && passed, left !== T.planHash ? `PLAN.md or CHECKS.json changed since plan-shape recorded plan ${left || '(none)'}: the planner reads the change, folds or disputes it, and runs plan-shape` : passed ? `plan ${left}, plan-shape pass` : `plan-shape fails on plan ${left}: ${shape.split('\n').find((l) => l.startsWith('- ')) || ''}`, 'plan');
// The design challenged as it stands: every challenge whose Plan: line names the current plan says build.
const challenges = T.names.filter((f) => /^challenge-\d+\.md$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
const current = challenges.filter((f) => field(read(join(ev, f)), 'plan') === T.planHash), open = current.filter((f) => verdict(read(join(ev, f))) !== 'build');
row('design challenged', current.length > 0 && !open.length, !current.length ? `no challenge-<k>.md has "Plan: ${T.planHash}"` : open.length ? `${open.join(', ')}: ${open.map((f) => verdict(read(join(ev, f)))).join(', ')}` : `${current.join(', ')}: build`, !current.length ? 'challenge' : 'plan, then challenge');

// The newest review is clean, and names, for each worktree the change touches, a commit that stands for HEAD (its
// findings' files may differ since).
const reviews = roundsOf(T.names, 'review', d), last = reviews.at(-1);
if (!last) row('reviewed', false, `no review-${d}-<round>.md`, 'review');
else {
  const text = read(join(ev, last)), v = verdict(text);
  row('review verdict', v === 'clean', `${last}: ${v}`, v === 'fix' ? 'implement, then review' : 'review');
  for (const w of T.delivered.filter((x) => x.tree !== x.baseTree)) {
    const s = commitsOf(text, w.name);
    const ok = s.some((c) => R.stands(w, c, findingFiles(text)));
    row(`${w.name} reviewed`, ok, ok ? `${last} names ${s.find((c) => R.stands(w, c, findingFiles(text))).slice(0, 12)}, which stands for HEAD` : s.length ? `${last} names ${s.map((c) => c.slice(0, 12)).join(', ')}: not a commit here, or the change's files changed since outside its findings` : `${last} has no Commit: line naming ${w.name}@<sha>`, 'review');
  }
}

// Every tests row due is green on a commit that stands; a row that fails before the change also went red on the base
// with the same words, in the same repository, and a row that passes before, where it passed on the base, too. The words to run are listed under "Run", once per command.
const words = (p) => JSON.stringify(p.argv);
const quote = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
const runs = new Map();
const toRun = (p, id, onBase) => { const w = R.worktreeOf(p); if (!w) return; const k = `${w.name} ${onBase} ${words(p)}`; runs.set(k, { w, p, onBase, ids: [...(runs.get(k)?.ids || []), id] }); };
for (const t of T.tests.filter((x) => /^T\d+$/.test(x.id) && (!x.delivery || x.delivery <= d))) {
  const mine = T.proofs.filter((p) => p.test === t.id), before = t.before.startsWith('yes');
  const reds = mine.filter((p) => R.isRed(p, t)), passes = mine.filter((p) => R.isBasePass(p, t)), greens = mine.filter((p) => R.isGreen(p));
  const firsts = before ? reds : passes;
  const paired = greens.filter((g) => (!before && !passes.length) || firsts.some((r) => r.repository === g.repository && words(r) === words(g)));
  const ok = paired.length > 0;
  let why = ok ? `green on a commit that stands${before ? ', red on the base with the same words' : ''}` : '';
  if (ok) {} else if (!mine.length) why = `no proof line names ${t.id}: run its test with --test ${t.id}`;
  else if (before && !reds.length) why = 'no red on the base: on a tree that differs from the base only in tests, the row\'s own among them, run its test with --base and see it fail on its assertion';
  else if (!greens.length) { why = 'not green on a commit that stands for HEAD; run the words below'; toRun(reds.at(-1) || mine.at(-1), t.id, false); }
  else { why = `the base ${before ? 'red' : 'pass'} and the green ran different words or repositories; run the words below`; toRun(firsts.at(-1), t.id, false); }
  row(before ? `${t.id} red then green` : `${t.id} green`, ok, why, 'implement');
}

// checks ran for this delivery as CHECKS.json now says, on commits that stand, and every due check passed.
const checks = (() => { try { return JSON.parse(read(join(ev, 'checks.json'))); } catch { return null; } })();
const after = !!checks?.after, dueNow = T.checks.filter((c) => due(c, d, after));
const stale = checks && dueNow.filter((c) => { const x = checks.results.find((y) => y.id === c.id); return !x || x.spec !== specOf(c, def) || !T.delivered.every((w) => R.stands(w, x.heads?.[w.name])); }).map((c) => c.id);
const failing = checks ? checks.results.filter((x) => !x.ok).map((x) => x.id) : [];
const verifyText = read(join(ev, `verify-${d}.md`)), kind = (id) => field(verifyText, `failing ${id}`).toLowerCase();
const fixer = failing.every((id) => /^product/.test(kind(id))) ? 'implement' : failing.every((id) => /^(product|check)/.test(kind(id))) ? 'plan (the checks), implement (the product)' : 'verify';
const needAfter = args.includes('--final') && T.checks.some((c) => due(c, d, true) && !due(c, d, false));
const cf = !T.checks.length ? '' : !dueNow.length ? `no check is due for delivery ${d}` : !checks || checks.delivery !== d ? 'no evidence/checks.json for this delivery' : stale.length ? `stale for ${stale.join(', ')}: changed in CHECKS.json, never run, or run on commits that no longer stand` : failing.length ? `failing: ${failing.map((id) => `${id}${kind(id) ? ` (${kind(id)})` : ''}`).join(', ')}` : needAfter && !after ? "checks due after this delivery's steps have not run (checks --after)" : '';
row('checks', !cf, cf || `every due check passes (definition ${def.files.join(', ')})`, failing.length && !stale.length ? fixer : 'verify');

// The oracles and scripts checks_allow names by path are unchanged on the branch, unless the plan names the change.
for (const x of [...new Set((def.list('checks_allow') || []).flatMap((a) => a.split(/\s+/)).filter((y) => y.includes('/')).map(normPath))]) {
  const [first, ...rest] = x.split('/'), w = W[first];
  if (!w?.base) continue;
  const touched = (git(w.path, 'diff', '--name-only', w.base, 'HEAD') || '').split('\n').filter((f) => f === rest.join('/') || f.startsWith(`${rest.join('/')}/`));
  const named = T.oraclesChanged.includes(x);
  if (touched.length) row(`oracle ${x}`, named, named ? 'changed as the plan\'s "Oracles changed:" names; checks runs the worktree\'s copy and review reads it' : `changed on the branch: ${touched.join(', ')}; the plan names it under "Oracles changed:", or the change is undone`, 'plan');
}

// A plan with states to picture: a read of the screens HEAD shows, and a screenshot of each state at such a commit.
// A screenshot is any file whose name holds the state's name (words joined by spaces, dashes or underscores) and a
// commit; a file goes to the longest state name it matches, so "empty" doesn't take "non-empty".
const commitIn = (c) => T.delivered.find((w) => git(w.path, 'cat-file', '-e', `${c}^{commit}`) !== null);
if (T.states) {
  const reads = roundsOf(T.names, 'read', d), readFile = reads.at(-1), rt = read(join(ev, readFile || '-'));
  const changed = [...new Set(fields(rt, 'commit').join(' ').match(/[0-9a-f]{7,40}/g) || rt.match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/g) || [])].flatMap((c) => { const w = commitIn(c); return w && !w.head.startsWith(c) ? screenTouched(w, c) : []; });
  row('read', !!readFile && !changed.length, !readFile ? `no read-${d}.md` : changed.length ? `${readFile}: screens changed since in ${changed.slice(0, 3).join(', ')}; read those screens again` : readFile, 'read');
  const rx = (s) => new RegExp(`(^|[^\\p{L}\\p{N}])(?<!(?:^|[^\\p{L}])(?:non|not|no)[\\s_-])${s.split(/[\s_-]+/).map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s_-]+')}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  const owner = (f) => T.states.filter((s) => rx(s).test(basename(f))).sort((a, b) => b.length - a.length)[0];
  for (const s of T.states) {
    let why = `no screenshot whose name holds "${s}" and a commit`;
    for (const c of T.names.filter((x) => owner(x) === s).flatMap((f) => basename(f).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi) || [])) {
      const w = commitIn(c);
      if (!w) continue;
      const touched = w.head.startsWith(c.toLowerCase()) ? [] : screenTouched(w, c);
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

// High risk: the plan's, or the last risk a challenger stated. The approval names the plan it approved.
const noOracle = [...new Set(T.surface.filter((l) => l.touched && !oracleKinds.includes(l.kind)).map((l) => l.kind || '(no kind)'))];
if (noOracle.length) rows.push({ link: 'oracles', ok: true, detail: `no oracle for ${noOracle.join(', ')}: checked only by walk, as the handoff says`, worker: '' });
const stated = challenges.map((f) => field(read(join(ev, f)), 'risk').toLowerCase()).filter(Boolean).at(-1);
if (T.risk === 'high' || stated === 'high') {
  const a = field(T.state, 'Approval'), ok = new RegExp(`\\bplan ${T.planHash}\\b`).test(a);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not name plan ${T.planHash}: ask with plan-shape --print approval`, 'the person');
}

const broken = rows.filter((r) => !r.ok);
const out = [
  `links ${d}: ${broken.length ? `stop, ${broken.length} broken` : 'pass'}; rounds: review ${reviews.length}, read ${roundsOf(T.names, 'read', d).length}, challenge ${challenges.length}; definition ${def.files.join(', ')}`,
  '',
  '| Link | Holds | Detail | Start |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.link} | ${r.ok ? 'yes' : 'no'} | ${String(r.detail).replace(/\|/g, '/')} | ${r.worker} |`),
  ...(runs.size ? ['', 'Run (each once, on HEAD unless it says --base; heavy ones when there is room):', ...[...runs.values()].map(({ w, p, onBase, ids }) => `- proof ${quote(dir)} --in ${w.name} --test ${ids.join(',')}${onBase ? ' --base' : ''} -- ${p.argv.map(quote).join(' ')}${p.argv.some((x) => /(^|\/)evidence\/|^\/tmp\/|^\/private\/|\.log$/.test(x)) ? '   (names an output path: remove it so this run does not overwrite another)' : ''}`)] : []),
].join('\n');
mkdirSync(ev, { recursive: true });
writeFileSync(join(ev, `links-${d}.md`), out + '\n');
console.log(out);
process.exit(broken.length ? 1 : 0);
