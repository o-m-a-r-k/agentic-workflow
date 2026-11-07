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
const setting = (key) => vals('--definition').map((p) => list(read(resolve(p)), key)).find(Boolean);
const oracleKinds = vals('--definition').flatMap((p) => { const fm = (read(resolve(p)).match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''; const m = fm.match(/^oracles:[ \t]*\n((?:[ \t]+\S.*\n?)*)/m); return m ? [...m[1].matchAll(/^[ \t]+([\w.-]+):/gm)].map((x) => x[1].toLowerCase()) : []; });
const screenPaths = setting('screen_paths');
const nothingRan = setting('nothing_ran') || [];
const matches = (out, p) => { const rx = p.match(/^\/(.*)\/([a-z]*)$/s); return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(p); };

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
// The same change on a moved base: the diff from where each commit meets the base is the same patch.
const patch = (r, a, b) => { const t = git(trees[r], 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: trees[r], input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
const rebased = (r, s) => {
  if (!baseRef[r]) return false;
  const p1 = patch(r, git(trees[r], 'merge-base', s, baseRef[r]), s);
  return !!p1 && p1 === patch(r, git(trees[r], 'merge-base', 'HEAD', baseRef[r]), 'HEAD');
};
const testsRows = section(plan, 'Tests').split('\n').filter((x) => /^\|\s*T\d+\s*\|/.test(x)).map((l) => l.split('|').slice(1, -1).map((s) => s.trim()));
const rowFile = (c) => (c[2] || '').replace(/`/g, '').split('›')[0].trim();
const isTest = (f) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.\w+$/.test(f) || testsRows.some((c) => rowFile(c) && (f === rowFile(c) || f.endsWith(`/${rowFile(c)}`)));

if (!Object.keys(trees).length) row('worktrees', false, 'STATE.md names no existing "Worktree <repo>: <path>"', 'the orchestrator');
for (const r of Object.keys(trees)) {
  const dirty = git(trees[r], 'status', '--porcelain');
  row(`${r} clean`, dirty === '', dirty === null ? 'not a git worktree' : dirty ? `uncommitted: ${dirty.split('\n').length} paths` : `HEAD ${heads[r]?.slice(0, 12)}`, 'implement');
}
const judge = of('judge', d)[0];
row('plan judged', !!judge && !!verdict(read(join(ev, judge))), judge ? `${judge}: ${verdict(read(join(ev, judge))) || 'no Verdict: line'}` : `no judge-${d}.md`, 'judge');
const open = section(plan, 'Memos').split(/^### /m).slice(1).filter((m) => +(m.match(/^-[ \t]*\**Due:\**[ \t]*before delivery (\d+)/m) || [0, d])[1] <= d && !/^-[ \t]*\**Decided:\**[ \t]*(?!open\b)\S/im.test(m));
if (open.length) row('memos decided', false, `open: ${open.map((m) => m.split(/[:\s]/)[0]).join(', ')}`, 'the person');

// The last review: clean, or round 2 with no open [S<n>] finding (the rest goes to the handoff), or a round 3 that
// read the Surface fix. It names each changed worktree's HEAD in its Commit: lines, or the same change on a moved base,
// or an earlier commit whose diff since stays within the files its findings name plus tests, those rows green on HEAD.
const reviews = of('review', d).sort((a, b) => +a.match(exact.review)[2] - +b.match(exact.review)[2]);
const last = reviews.at(-1);
if (!last) row('reviewed', false, `no review-${d}-<round>.md`, 'review');
else {
  const text = read(join(ev, last)), n = +last.match(exact.review)[2], v = verdict(text);
  const openS = v === 'fix' ? [...new Set(findings(text).match(/\[(?:S\d+|surface)\]/gi) || [])] : [];
  const ok = v === 'clean' || (v === 'fix' && n >= 2 && !openS.length);
  // After review 3 an open Surface finding holds the delivery: it is reported in the handoff as not delivered, never offered to be dropped.
  const next = openS.length ? (n < 2 ? 'implement, then review' : n === 2 ? `implement, then review-${d}-3 on ${openS.join(', ')}` : 'none: held, reported in the handoff as not delivered') : 'implement, then review';
  row('review verdict', ok, `${last}: ${v || 'no Verdict: line'}${openS.length ? `; open Surface findings ${openS.join(', ')}` : ok && v === 'fix' ? ' (open findings go to the handoff)' : ''}`, v ? next : 'review');
  const commitLines = text.split('\n').filter((l) => /^[\s>*_-]*commit/i.test(l)).join('\n');
  const named = (t, r) => [...t.matchAll(new RegExp(`${r.replace(/[.]/g, '\\.')}@([0-9a-f]{7,40})`, 'g'))].map((m) => m[1]);
  // Each finding starts with F<n> and its file:line; those files are where a fix after the review may go.
  const files = findings(text).split('\n').filter((l) => /^[\s>*_#-]*F\d+\b/.test(l)).map((l) => (l.match(/([\w@.\/\[\]()+-]+\.\w+):\d+/) || [])[1]).filter(Boolean);
  for (const r of Object.keys(trees)) {
    if (bases[r] && heads[r]?.startsWith(bases[r])) continue;
    const shas = named(commitLines, r);
    if (shas.some((s) => heads[r]?.startsWith(s))) { row(`${r} reviewed`, true, `${last} names HEAD`); continue; }
    if (shas.some((s) => rebased(r, s))) { row(`${r} reviewed`, true, `${last} names the same change on the earlier base`); continue; }
    if (!shas.length) { row(`${r} reviewed`, false, `${last} has no Commit: line naming ${r}@<sha>`, 'review'); continue; }
    const diff = (git(trees[r], 'diff', '--name-only', shas.at(-1), 'HEAD') || '').split('\n').filter(Boolean);
    const outside = diff.filter((f) => !isTest(f) && !files.some((x) => f === x || f.endsWith(`/${x}`) || x.endsWith(`/${f}`) || x === `${r}/${f}`));
    const affected = testsRows.filter((c) => diff.some((f) => rowFile(c) && (f === rowFile(c) || f.endsWith(`/${rowFile(c)}`))));
    const red = affected.filter((c) => !proofs.some((p) => p.test === c[0] && !p.base && p.exit === 0 && onHead(p, r) && ranSomething(p)));
    const anyGreen = proofs.some((p) => p.test && !p.base && p.exit === 0 && onHead(p, r) && ranSomething(p));
    const why = outside.length ? `commits since ${shas.at(-1).slice(0, 12)} touch files no finding names: ${outside.slice(0, 3).join(', ')}` : red.length ? `rows not green on HEAD: ${red.map((c) => c[0]).join(', ')}` : !anyGreen ? 'no tests-row proof on HEAD' : '';
    row(`${r} reviewed`, !why, why || `${last} names ${shas.at(-1).slice(0, 12)}; the diff since stays within its findings and tests, green on HEAD`, 'review');
  }
}
const ignored = names.filter((f) => /^(judge|read|review)-/.test(f) && !Object.values(exact).some((x) => x.test(f)));
if (ignored.length) rows.push({ link: 'ignored files', ok: true, detail: `not round files, not read: ${ignored.join(', ')}`, worker: '' });

// Each tests row that fails before the change: the same command red on the base, green on HEAD's tree, and each
// having run something.
for (const c of testsRows) {
  if (!/^yes\b/i.test(c[4] || '')) continue;
  const mine = proofs.filter((p) => p.test === c[0] && ranSomething(p));
  const green = mine.filter((p) => !p.base && p.exit === 0 && Object.keys(trees).some((r) => onHead(p, r)));
  const red = mine.filter((p) => p.base && typeof p.exit === 'number' && p.exit !== 0 && green.some((g) => g.command === p.command && g.worktree === p.worktree));
  const lastLine = (red[0]?.log || '').trim().split('\n').at(-1)?.slice(0, 80);
  row(`${c[0]} red then green`, red.length > 0 && green.length > 0, `${green.length ? "green on HEAD's tree" : "no passing proof on HEAD's tree"}; ${red.length ? `red on base, same command (last line: ${lastLine})` : 'no failing base run of the same command'}`, 'implement');
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
const seen = section(plan, 'What people see').trim();
if (seen) {
  row('read', of('read', d).length > 0, of('read', d).join(', ') || `no read-${d}.md`, 'read');
  const states = field(seen, 'States').split(',').map((s) => s.trim()).filter(Boolean);
  if (!states.length) row('states', false, 'What people see has no "States: <state>, <state>" line', 'plan');
  for (const s of states) {
    const has = new RegExp(`(^|[^a-z0-9])${s.replace(/[^\w-]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    let why = `no screenshot whose name holds "${s}" and a commit`;
    for (const f of names.filter((x) => has.test(basename(x)))) {
      for (const c of basename(f).match(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi) || []) {
        const r = Object.keys(trees).find((k) => git(trees[k], 'cat-file', '-e', `${c}^{commit}`) !== null);
        if (!r) continue;
        if (heads[r].startsWith(c.toLowerCase())) { why = ''; break; }
        if (!screenPaths) { why = `${f} is not ${r} HEAD, and the definition names no screen_paths`; continue; }
        const touched = (git(trees[r], 'diff', '--name-only', c, 'HEAD') || '').split('\n').filter(Boolean).map((x) => `${r}/${x}`).filter((x) => screenPaths.some((p) => x === p || x.startsWith(p.replace(/\/?$/, '/'))));
        if (!touched.length) { why = ''; break; }
        why = `retake: ${c.slice(0, 12)}..HEAD touches ${touched.slice(0, 3).join(', ')}`;
      }
      if (!why) break;
    }
    row(`screenshot ${s}`, !why, why || 'shows what HEAD shows', 'verify');
  }
}

// High risk (the higher of the header and the Risk table): approved at a revision, on the Surface as it stands.
const LINE = /^- (S\d+)(?: \(([^)]+)\))?:[ \t]*(.*)$/;
const surface = section(plan, 'Surface').split('\n').filter((l) => LINE.test(l)).map((l) => l.trim());
const equals = (l) => ((l.replace(/`[^`]*`/g, '').match(/\bequals\b([^;]*)/i) || [])[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
const key = (l) => { const m = l.match(LINE); return `${m[1]}|${(m[2] || '').trim().toLowerCase()}|${/^not touched\b/i.test(m[3]) ? 'not touched' : 'touched'}|${equals(l)}`; };
const hash = createHash('sha256').update(surface.map(key).join('\n')).digest('hex').slice(0, 12);
const noOracle = [...new Set(surface.map((l) => l.match(LINE)).filter((m) => !/^not touched\b/i.test(m[3])).map((m) => (m[2] || '').trim().toLowerCase()).filter((k) => !oracleKinds.includes(k)))];
if (noOracle.length) rows.push({ link: 'oracles', ok: true, detail: `no oracle for ${noOracle.map((k) => k || '(no kind)').join(', ')}: no cold audit compares these, and the handoff says so`, worker: '' });
if (field(plan, 'Risk') === 'high' || /\|\s*high\s*\|/i.test(section(plan, 'Risk'))) {
  const a = field(state, 'Approval');
  const ok = /revision \d+/.test(a) && a.includes(`surface ${hash}`);
  row('approval', ok, ok ? a : `Approval "${a || 'none'}" does not hold a revision and surface ${hash}`, 'the person');
}

// Round counts: reported, never a stop.
const r2 = read(join(ev, `review-${d}-2.md`));
const cap = verdict(r2) === 'fix' && /\[(?:S\d+|surface)\]/i.test(findings(r2)) ? 3 : 2;
const counts = ['judge', 'read', 'review'].map((k) => `${k} ${of(k, d).length}/${k === 'review' ? cap : 1}`);
const over = of('judge', d).length > 1 || of('read', d).length > 1 || reviews.length > cap;
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
