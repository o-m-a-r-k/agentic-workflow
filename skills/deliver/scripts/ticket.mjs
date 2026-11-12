// ticket: the one reader of a ticket's files (STATE.md, PLAN.md, CHECKS.json, evidence/) and of the project definition.
// Every script reads them through this module, so a field a later script reads is the field plan-shape checked at plan
// time. It runs no command but git, and writes nothing.
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
export const git = (cwd, ...a) => { try { return execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trimEnd(); } catch { return null; } };
export const vals = (args, k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
export const field = (t, k) => (t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')) || [])[1]?.trim() ?? '';
export const section = (t, name) => { const s = t.split(/^## /m).find((c) => c.split('\n')[0].trim() === name); return s ? s.slice(s.indexOf('\n') + 1) : ''; };
export const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);
// An expect matches output as text it holds, or as /regex/flags; one that can't fail is empty or matches "", "x" or "ok".
export const matches = (out, e) => { const rx = String(e).match(/^\/(.*)\/([a-z]*)$/s); return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(String(e).trim()); };
export const trivial = (e) => { try { return !String(e ?? '').trim() || (/^\/.*\/[a-z]*$/s.test(String(e)) && ['', 'x', 'ok'].some((o) => matches(o, e))); } catch { return true; } };

// The definition's front matter: a list (`[a, b]` or `- a` lines) or a map (indented `key: value` lines); the first
// definition that sets a key wins. Its folder is the one holding `.agents/`, or the file's own.
export function definition(paths) {
  const fms = paths.map((p) => (read(resolve(p)).match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  const block = (key) => fms.map((fm) => fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n[ \\t]+\\S.*)*)`, 'm'))).find(Boolean);
  const list = (key) => {
    const m = block(key);
    if (!m) return null;
    const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
    return (v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''))).map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  const map = (key) => { const m = block(key); return Object.fromEntries((m ? m[2].split('\n') : []).map((l) => l.match(/^\s+([^\s:]+):\s*(.+)$/)).filter(Boolean).map((x) => [x[1].toLowerCase(), x[2].trim()])); };
  const f = paths[0] && resolve(paths[0]);
  return { list, map, dir: f ? (basename(dirname(f)) === '.agents' ? dirname(dirname(f)) : dirname(f)) : null };
}

// Test files: the definition's test_files globs, or a default across common languages.
const TESTS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_tests.*', '**/test_*.*', '**/tests.*', '**/*_spec.rb', '**/*Test.*', '**/*Tests.*'];
export const testMatcher = (globs) => {
  const rx = (globs?.length ? globs : TESTS).map((g) => new RegExp(`^${g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`));
  return (f) => rx.some((r) => r.test(f));
};

// On Windows a runner such as npm is a .cmd file, which Node starts only through cmd.exe. Each word reaches cmd.exe as
// an environment variable expanded after it has parsed the line, so no word, a substituted path included, is shell text.
export function spawnArgs(argv) {
  if (process.platform !== 'win32' || /[\\/]|\.\w+$/.test(argv[0])) return { argv, env: {} };
  for (const d of (process.env.PATH || '').split(';')) for (const e of (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')) {
    if (!d || !existsSync(join(d, argv[0] + e))) continue;
    const words = [join(d, argv[0] + e), ...argv.slice(1)];
    if (!/\.(cmd|bat)$/i.test(e)) return { argv: words, env: {} };
    return { argv: [process.env.ComSpec || 'cmd.exe', '/d', '/v:on', '/s', '/c', `"${words.map((_, i) => `"!AW_WORD_${i}!"`).join(' ')}"`], env: Object.fromEntries(words.map((w, i) => [`AW_WORD_${i}`, w])), verbatim: true };
  }
  return { argv, env: {} };
}

// A review's or judge's state is its `Verdict:` line, as models write it: "**Verdict:** Fix: 2." -> "fix"; "fix: 0" -> "clean".
export const verdict = (t) => { const v = ((t.match(/^[\s>#*_-]*verdict[\s*_`]*:[\s*_`]*(.+)$/im) || [])[1] || '').replace(/[*_`]/g, '').trim().toLowerCase(); return /^fix\w*:?\s*0\b/.test(v) ? 'clean' : (v.match(/^(clean|fix|build)/) || [])[1] || ''; };
// The files a review's findings name: `path:line` under its "## Findings" heading, nowhere else.
export const findingFiles = (t) => [...section(t, 'Findings').matchAll(/([^\s`'"()]+\.\w+):\d+/g)].map((m) => m[1]);
export const ROUND = { judge: /^judge-(\d+)\.md$/, read: /^read-(\d+)\.md$/, review: /^review-(\d+)-(\d+)\.md$/ };
export const roundsOf = (names, kind, d) => names.filter((f) => (f.match(ROUND[kind]) || [])[1] === String(d)).sort((a, b) => +(a.match(/(\d+)\.md$/)[1]) - +(b.match(/(\d+)\.md$/)[1]));
// A delivery's third review is the narrow one: review 2's verdict asked for fixes, or links named review 3 for a diff after review.
export const cap = (ev, kind, d) => (kind !== 'review' ? 1 : verdict(read(join(ev, `review-${d}-2.md`))) === 'fix' || new RegExp(`\\| review-${d}-3\\b`).test(read(join(ev, `links-${d}.md`))) ? 3 : 2);

const LINE = /^- (S\d+)(?: \(([^)]+)\))?:[ \t]*(.*)$/;
// A Surface line: `- S<n> (<kind>): <fact>: <where>; equals <its record>`, or `- S<n> (<kind>): not touched: <why>`.
// Its key is what approval is of: the id, the kind, whether it is touched, and what it must equal; not its wording.
const surface = (t) => section(t, 'Surface').split('\n').filter((l) => LINE.test(l)).map((l) => {
  const [, id, k = '', rest] = l.trim().match(LINE), kind = k.trim().toLowerCase(), touched = !/^not touched\b/i.test(rest);
  const equals = ((l.replace(/`[^`]*`/g, '').match(/\bequals\b([^;]*)/i) || [])[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return { id, kind, touched, text: l.trim(), key: `${id}|${kind}|${touched ? 'touched' : 'not touched'}|${equals}` };
});

// Everything a script reads from a ticket folder.
export function ticket(dir) {
  const state = read(join(dir, 'STATE.md')), plan = read(join(dir, 'PLAN.md')), ev = join(dir, 'evidence');
  const worktrees = {};
  for (const m of state.matchAll(/^Worktree ([\w.-]+):[ \t]*(\S+)(?:.*?\bfrom (\S+))?.*?(?:\bat ([0-9a-f]{7,40}))?[ \t]*$/gm)) {
    const p = resolve(dir, m[2]), w = (worktrees[m[1]] = { path: existsSync(p) ? realpathSync(p) : null, from: (m[3] || '').replace(/,$/, ''), at: m[4] || '' });
    if (!w.path) continue;
    const common = git(w.path, 'rev-parse', '--git-common-dir');
    Object.assign(w, { head: git(w.path, 'rev-parse', 'HEAD'), tree: git(w.path, 'rev-parse', 'HEAD^{tree}'), repository: common && realpathSync(resolve(w.path, common)) });
    w.baseRef = w.from ? [`origin/${w.from}`, w.from].find((b) => git(w.path, 'rev-parse', '--verify', '-q', b)) : null;
  }
  const seen = section(plan, 'What people see').trim();
  let checks = [], checksError = '';
  try { checks = JSON.parse(read(join(dir, 'CHECKS.json')) || '[]'); if (!Array.isArray(checks)) throw new Error('is not a list'); } catch (e) { checks = []; checksError = e.message; }
  return {
    dir, ev, state, plan, worktrees, checks, checksError,
    names: existsSync(ev) ? readdirSync(ev, { recursive: true }).map(String) : [],
    revision: (field(plan, 'Revision').match(/^\d+$/) || [])[0] || '',
    risk: field(plan, 'Risk'),
    readAt: [...field(plan, 'Read at').matchAll(/([\w.-]+)@([0-9a-f]{7,40})/g)].map((m) => ({ repo: m[1], sha: m[2] })),
    deliveries: (section(plan, 'Deliveries').match(/^\s*\d+\./gm) || []).map((s) => s.trim().slice(0, -1)),
    decisions: section(plan, 'Decisions').split(/^### /m).slice(1),
    questions: section(plan, 'Questions').match(/^- Q\d+\b.*$/gm) || [],
    surface: surface(plan),
    draft: surface(state),
    // Tests rows: ID | behaviour | test (file › name, or "(new)") | asserts | fails before | delivery.
    tests: section(plan, 'Tests').split('\n').filter((l) => l.trim().startsWith('|')).slice(2).map((l) => {
      const c = l.split('|').slice(1, -1).map((s) => s.trim());
      return { raw: l.replace(/\s+/g, ' ').trim(), id: c[0] || '', isNew: /\(new\)/.test(c[2] || ''), file: (c[2] || '').replace(/`|\(new\)/g, '').split('›')[0].trim(), before: (c[4] || '').toLowerCase(), delivery: +((c[5] || '').match(/\d+/) || [0])[0] };
    }),
    seen,
    // The states screenshots carry: `States: <name>, <name>`, short names only.
    states: seen && !/^none\b/i.test(seen) ? field(seen, 'States').split(',').map((s) => s.trim()).filter(Boolean) : null,
    planHash: sha(`${plan}\n${read(join(dir, 'CHECKS.json'))}`),
    proofs: read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }),
  };
}
