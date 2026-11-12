// ticket: the one reader of a ticket's files (STATE.md, PLAN.md, CHECKS.json, evidence/) and of the project definition,
// and the one set of rules for what stands as proof. Every script reads and compares through this module, so a field a
// later script reads is the field plan-shape checked. It runs no command but git, and writes nothing.
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') : '');
export const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trimEnd(); } catch { return null; } };
export const vals = (args, k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
export const field = (t, k) => (t.match(new RegExp(`^[\\s>*_-]*${k}[*_]*:[*_]*[ \\t]*(.*)$`, 'im')) || [])[1]?.trim() ?? '';
export const fields = (t, k) => [...t.matchAll(new RegExp(`^[\\s>*_-]*${k}[*_]*:[*_]*[ \\t]*(.*)$`, 'gim'))].map((m) => m[1].trim());
export const section = (t, name) => { const s = t.split(/^## /m).find((c) => c.split('\n')[0].trim().toLowerCase() === name.toLowerCase()); return s ? s.slice(s.indexOf('\n') + 1) : ''; };
export const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);
// One path form: no backticks, forward slashes, no leading ./
export const normPath = (p) => String(p).replace(/`/g, '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
// A file f of repo r is the path p when p is f, <repo>/f, or the end of f.
export const pathIs = (f, p, r) => { f = normPath(f); p = normPath(p); return !!p && (f === p || `${r}/${f}` === p || f.endsWith(`/${p}`)); };
// An expect matches output as text it holds, or as /regex/flags; one that can't fail is empty or matches "", "x" or "ok".
export const matches = (out, e) => { const rx = String(e).match(/^\/(.*)\/([a-z]*)$/s); return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(String(e).trim()); };
export const trivial = (e) => { try { return !String(e ?? '').trim() || (/^\/.*\/[a-z]*$/s.test(String(e)) && ['', 'x', 'ok'].some((o) => matches(o, e))); } catch { return true; } };

// The definition's front matter: a list (`[a, b]` or `- a` lines) or a map (indented `key: value` lines); the first
// definition that sets a key wins. A file that doesn't exist is an error. Its folder is the one holding `.agents/`.
export function definition(paths) {
  const missing = paths.filter((p) => !existsSync(resolve(p)));
  if (!paths.length || missing.length) throw new Error(paths.length ? `no definition at ${missing.join(', ')}` : '--definition <project definition> is required');
  const fms = paths.map((p) => (read(resolve(p)).match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  const block = (key) => fms.map((fm) => fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+\\S.*)*)`, 'm'))).find(Boolean);
  const list = (key) => {
    const m = block(key);
    if (!m) return null;
    const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
    return (v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''))).map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  const map = (key) => { const m = block(key); return Object.fromEntries((m ? m[2].split('\n') : []).map((l) => l.match(/^\s+([^\s:]+):\s*(.+)$/)).filter(Boolean).map((x) => [x[1].toLowerCase(), x[2].trim()])); };
  const f = resolve(paths[0]);
  return { list, map, files: paths.map((p) => resolve(p)), dir: basename(dirname(f)) === '.agents' ? dirname(dirname(f)) : dirname(f) };
}
export const definitionOf = (args) => { try { return definition(vals(args, '--definition')); } catch (e) { console.error(`${basename(process.argv[1], '.mjs')}: ${e.message}`); process.exit(2); } };

// On Windows a runner such as npm is a .cmd file, which Node starts only through cmd.exe. Each word reaches cmd.exe as
// an environment variable expanded after it has parsed the line; a word holding a quote can't be passed that way.
export function spawnArgs(argv, win = process.platform === 'win32', env = process.env) {
  if (!win || /[\\/]|\.\w+$/.test(argv[0])) return { argv, env: {} };
  for (const d of (env.PATH || '').split(';')) for (const e of (env.PATHEXT || '.EXE;.CMD;.BAT').split(';')) {
    if (!d || !existsSync(join(d, argv[0] + e))) continue;
    const words = [join(d, argv[0] + e), ...argv.slice(1)];
    if (!/\.(cmd|bat)$/i.test(e)) return { argv: words, env: {} };
    if (words.some((w) => /["\r\n]/.test(w))) return { error: 'a word holds a quote or a line break, which cmd.exe cannot pass' };
    return { argv: [env.ComSpec || 'cmd.exe', '/d', '/v:on', '/s', '/c', `"${words.map((_, i) => `"!AW_WORD_${i}!"`).join(' ')}"`], env: Object.fromEntries(words.map((w, i) => [`AW_WORD_${i}`, w])), verbatim: true };
  }
  return { argv, env: {} };
}

// A review's or challenge's state is its one `Verdict:` line, whole: clean | fix: <n> | build | fix items <list>.
// More than one Verdict: line, or any other value, is invalid. A review's fix count equals its findings, clean has none.
export const findings = (t) => section(t, 'Findings').split('\n').filter((l) => /^[\s>*#-]*\**F\d+\b/.test(l));
export const findingFiles = (t) => findings(t).flatMap((l) => [...l.matchAll(/([^\s`'"()]+\.\w+):\d+/g)].map((m) => normPath(m[1])));
export function verdict(t) {
  const vs = fields(t, 'verdict').map((v) => v.replace(/[*_`]/g, '').replace(/\.$/, '').trim().toLowerCase());
  if (vs.length !== 1) return 'invalid';
  const v = vs[0], n = (v.match(/^fix: (\d+)( findings?)?$/) || [])[1];
  if (v === 'clean') return findings(t).length ? 'invalid' : 'clean';
  if (n) return +n > 0 && +n === findings(t).length ? 'fix' : 'invalid';
  return v === 'build' ? 'build' : /^fix items [\d, and]+$/.test(v) ? 'fix' : 'invalid';
}
export const ROUND = { read: /^read-(\d+)(?:-(\d+))?\.md$/, review: /^review-(\d+)-(\d+)\.md$/ };
const roundNo = (f) => +((f.match(/-(\d+)-(\d+)\.md$/) || [])[2] || 1);
export const roundsOf = (names, kind, d) => names.filter((f) => (f.match(ROUND[kind]) || [])[1] === String(d)).sort((a, b) => roundNo(a) - roundNo(b));

const LINE = /^- (S\d+)(?: \(([^)]+)\))?:[ \t]*(.*)$/;
// A Surface line: `- S<n> (<kind>): <fact>: <where>; equals <its record>`, or `- S<n> (<kind>): not touched: <why>`.
// Its key is the id, the kind, whether it is touched, and what it must equal; not its wording.
const surface = (t) => section(t, 'Surface').split('\n').filter((l) => LINE.test(l)).map((l) => {
  const [, id, k = '', rest] = l.trim().match(LINE), kind = k.trim().toLowerCase(), touched = !/^not touched\b/i.test(rest);
  const equals = ((l.replace(/`[^`]*`/g, '').match(/\bequals\b([^;]*)/i) || [])[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return { id, kind, touched, text: l.trim(), key: `${id}|${kind}|${touched ? 'touched' : 'not touched'}|${equals}` };
});
// A table row's cells, split on pipes that aren't escaped.
const cells = (l) => l.split(/(?<!\\)\|/).slice(1, -1).map((s) => s.replace(/\\\|/g, '|').trim());

// A path in STATE.md is read from the ticket folder or, failing that, from the nearest folder above it where it exists.
const within = (dir, p) => { for (let d = dir; ; d = dirname(d)) { const q = resolve(d, p); if (existsSync(q)) return q; if (dirname(d) === d) return null; } };

// Everything a script reads from a ticket folder. A `Lane <name>: <path>` line is a worktree proof may run in; it is
// not delivered.
export function ticket(dir) {
  const state = read(join(dir, 'STATE.md')), plan = read(join(dir, 'PLAN.md')), ev = join(dir, 'evidence');
  const worktrees = {};
  for (const m of state.matchAll(/^(Worktree|Lane) ([\w.-]+):[ \t]*(\S+)(?:.*?\bfrom (\S+))?.*?(?:\bat ([0-9a-f]{7,40}))?[ \t]*$/gm)) {
    const p = within(dir, m[3]), w = (worktrees[m[2]] = { name: m[2], lane: m[1] === 'Lane', path: p && realpathSync(p), from: (m[4] || '').replace(/,$/, ''), at: m[5] || '' });
    if (!w.path) continue;
    const common = git(w.path, 'rev-parse', '--git-common-dir');
    Object.assign(w, { head: git(w.path, 'rev-parse', 'HEAD'), tree: git(w.path, 'rev-parse', 'HEAD^{tree}'), repository: common && realpathSync(resolve(w.path, common)) });
    w.baseRef = w.from ? [`origin/${w.from}`, w.from].find((b) => git(w.path, 'rev-parse', '--verify', '-q', b)) : null;
    w.base = (w.baseRef && git(w.path, 'merge-base', 'HEAD', w.baseRef)) || w.at;
    w.baseTree = w.base ? git(w.path, 'rev-parse', `${w.base}^{tree}`) : null;
  }
  const seen = section(plan, 'What people see').trim();
  let checks = [], checksError = '';
  try { checks = JSON.parse(read(join(dir, 'CHECKS.json')) || '[]'); if (!Array.isArray(checks)) throw new Error('is not a list'); } catch (e) { checks = []; checksError = e.message; }
  return {
    dir, ev, state, plan, worktrees, checks, checksError,
    delivered: Object.values(worktrees).filter((w) => !w.lane && w.path),
    names: existsSync(ev) ? readdirSync(ev, { recursive: true }).map(String) : [],
    revision: (field(plan, 'Revision').match(/^\d+$/) || [])[0] || '',
    risk: field(plan, 'Risk').toLowerCase(),
    readAt: [...field(plan, 'Read at').matchAll(/([\w.-]+)@([0-9a-f]{7,40})/g)].map((m) => ({ repo: m[1], sha: m[2] })),
    oraclesChanged: field(plan, 'Oracles changed').split(',').map(normPath).filter((x) => x && !/^none$/i.test(x)),
    deliveries: (section(plan, 'Deliveries').match(/^\d+\.(?= )/gm) || []).map((s) => s.slice(0, -1)),
    decisions: section(plan, 'Decisions').split(/^### /m).slice(1),
    questions: section(plan, 'Questions').match(/^- Q\d+\b.*$/gm) || [],
    surface: surface(plan),
    draft: surface(state),
    // Tests rows: ID | behaviour | test (file › name, or "(new)") | asserts | fails before | delivery.
    tests: section(plan, 'Tests').split('\n').filter((l) => l.trim().startsWith('|')).slice(2).map((l) => {
      const c = cells(l);
      return { raw: l.replace(/\s+/g, ' ').trim(), id: c[0] || '', isNew: /\(new\)/.test(c[2] || ''), file: normPath((c[2] || '').replace(/\(new\)/g, '').split(/›|>/)[0]), before: (c[4] || '').toLowerCase(), delivery: +((c[5] || '').match(/\d+/) || [0])[0] };
    }),
    seen,
    // The states screenshots carry: `States: <name>, <name>`, short names only.
    states: seen && !/^none\b/i.test(seen) ? field(seen, 'States').split(',').map((s) => s.trim()).filter(Boolean) : null,
    planHash: sha(`${plan}\n${read(join(dir, 'CHECKS.json'))}`),
    proofs: read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }),
  };
}

// A check is due for delivery d when due "before delivery d", a Surface check also when due before an earlier one,
// and after the delivery's steps also when due "after <step> in delivery d". Its spec is what decides its result.
export const dueBefore = (c) => +((String(c.due).match(/^before delivery (\d+)$/) || [])[1] || 0);
export const dueAfter = (c) => +((String(c.due).match(/^after .+ in delivery (\d+)$/) || [])[1] || 0);
export const due = (c, d, after) => dueBefore(c) === d || ((c.surface || []).length > 0 && dueBefore(c) > 0 && dueBefore(c) < d) || (after && dueAfter(c) === d);
export const specOf = (c, def) => sha(JSON.stringify([c.verify, c.expect ?? null, c.in ?? null, !!c.heavy, def.list('checks_allow') || [], def.list('nothing_ran') || []]));

// What stands as proof, by facts about trees. The change's files are those it alters since its base.
export function proofRules(T, def) {
  const tests = (() => { const DEF = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_tests.*', '**/test_*.*', '**/tests.*', '**/*_spec.rb', '**/*Test.*', '**/*Tests.*'];
    const g = def.list('test_files');
    return (g?.length ? g : DEF).map((x) => new RegExp(`^${x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`)); })();
  const nothingRan = def.list('nothing_ran') || [];
  const isTestFile = (f) => tests.some((x) => x.test(normPath(f)));
  const isTest = (f, r) => isTestFile(f) || T.tests.some((t) => t.file && pathIs(f, t.file, r));
  const W = (p) => Object.values(T.worktrees).find((w) => w.path && w.repository === p.repository && !w.lane) || Object.values(T.worktrees).find((w) => w.path && w.repository === p.repository);
  const names = (w, a, b) => (git(w.path, 'diff', '--name-only', a, b) || '').split('\n').filter(Boolean);
  const changed = {};
  const changeFiles = (w) => (changed[w.name] ??= w.base ? names(w, w.base, 'HEAD') : []);
  const patch = (w, a, b) => { const t = git(w.path, 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: w.path, input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
  // Commit c stands for HEAD when it exists, holds the change (its tree isn't the base's while HEAD's is not), is HEAD's
  // ancestor or the same change on a moved base, and what differs since touches none of the change's files but tests
  // and the files in `also` (a review's findings). So a merge that changes no byte, or a base move that leaves the
  // change's files alone, keeps what was proven.
  const stands = (w, c, also = []) => {
    const t = c && git(w.path, 'rev-parse', `${c}^{tree}`);
    if (!t) return false;
    if (t === w.tree) return true;
    if (t === w.baseTree) return false;
    const rebased = () => { const b = w.baseRef, p1 = b && patch(w, git(w.path, 'merge-base', c, b), c); return !!p1 && p1 === patch(w, w.base, 'HEAD'); };
    if (git(w.path, 'merge-base', '--is-ancestor', c, 'HEAD') === null && !rebased()) return false;
    const mine = changeFiles(w);
    return names(w, c, 'HEAD').every((f) => !mine.includes(f) || isTest(f, w.name) || also.some((x) => pathIs(f, x, w.name)));
  };
  // A run ran something: an exit code, and output that matches no nothing_ran pattern. A base run is one on a tree that
  // differs from the base (or the commit STATE.md names) in test files alone, read from git, never assumed: the row's
  // own file among them for a new test, or, for an existing test, that file present in the tree it ran on, so the run
  // is in the row's repository. A red is such a run that failed; a base pass, one that passed. A green ran the row's
  // words on a commit that stands for HEAD with a clean worktree, or on HEAD's tree.
  const ran = (p) => typeof p.exit === 'number' && !nothingRan.some((x) => matches(p.log || '', x));
  const onBaseOf = (p, row) => {
    const w = W(p);
    if (!w || !p.base || !ran(p) || p.test !== row.id) return false;
    const has = () => (git(w.path, 'ls-tree', '-r', '--name-only', p.tree) || '').split('\n').some((f) => f && pathIs(f, row.file, w.name));
    return [...new Set([w.at, w.base])].filter(Boolean).some((b) => {
      const out = git(w.path, 'diff', '--name-only', b, p.tree);
      if (out === null) return false;
      const fs = out.split('\n').filter(Boolean);
      return fs.every((f) => isTest(f, w.name)) && (fs.some((f) => pathIs(f, row.file, w.name)) || (!row.isNew && !!row.file && has()));
    });
  };
  const isRed = (p, row) => p.exit !== 0 && onBaseOf(p, row);
  const isBasePass = (p, row) => p.exit === 0 && onBaseOf(p, row);
  const isGreen = (p) => { const w = W(p); return !!w && !p.base && ran(p) && p.exit === 0 && (p.tree === w.tree || (p.tree === git(w.path, 'rev-parse', `${p.head}^{tree}`) && stands(w, p.head))); };
  return { isTest, isTestFile, stands, isRed, isBasePass, isGreen, ran, worktreeOf: W, changeFiles };
}
