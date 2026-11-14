// ticket: the one reader of a ticket's files (STATE.md, BRIEF.md, DESIGN.md, CHECKS.json, evidence/) and of the project
// definition, and the one set of rules for what stands as proof. Every script reads and compares through this module.
// It runs no command but git, and writes nothing.
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
// Name lists from git, read NUL-separated so that no name is quoted or escaped.
const Q = ['-c', 'core.quotePath=false'];
const z = (o) => (o === null ? null : o.split('\0').filter((x) => x !== ''));
export const namesBetween = (cwd, a, b) => z(git(cwd, ...Q, 'diff', '-z', '--name-only', '--no-renames', a, b));
export const statusBetween = (cwd, a, b) => { const t = z(git(cwd, ...Q, 'diff', '-z', '--name-status', '--no-renames', a, b)); if (!t) return null; const out = []; for (let i = 0; i + 1 < t.length; i += 2) out.push({ status: t[i][0], path: t[i + 1] }); return out; };
export const filesAt = (cwd, rev) => z(git(cwd, ...Q, 'ls-tree', '-r', '-z', '--name-only', rev));
// The added lines of one file's diff, with their line numbers in the new file.
export const addedLines = (cwd, a, b, file) => {
  const out = [];
  let ln = 0, inHunk = false;
  for (const l of (git(cwd, ...Q, '--literal-pathspecs', 'diff', '-U0', '--no-renames', '--no-color', a, b, '--', file) || '').split('\n')) {
    const h = l.match(/^@@ -\S+ \+(\d+)(?:,\d+)? @@/);
    if (h) { ln = +h[1]; inHunk = true; continue; }
    if (inHunk && l.startsWith('+')) out.push({ line: ln++, text: l.slice(1) });
  }
  return out;
};
export const bullets = (t) => t.split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim());
export const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);
// One path form: no backticks, forward slashes, no leading ./
export const normPath = (p) => String(p).replace(/`/g, '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
// A file f of repo r is the path p when p is f, <repo>/f, or the end of f.
export const pathIs = (f, p, r) => { f = normPath(f); p = normPath(p); return !!p && (f === p || `${r}/${f}` === p || f.endsWith(`/${p}`)); };
// An expect matches output as text it holds, or as /regex/flags; one that can't fail is empty or matches "", "x" or "ok".
export const matches = (out, e) => { const rx = String(e).match(/^\/(.*)\/([a-z]*)$/s); return rx ? new RegExp(rx[1], rx[2]).test(out) : out.includes(String(e).trim()); };
export const trivial = (e) => { try { return !String(e ?? '').trim() || (/^\/.*\/[a-z]*$/s.test(String(e)) && ['', 'x', 'ok'].some((o) => matches(o, e))); } catch { return true; } };

// A glob: `**/` any folders, `**` anything, `*` anything but a slash, `?` one character but a slash.
export const globRx = (g) => new RegExp(`^${normPath(g).replace(/\?/g, '\u0002').replace(/[.+^$()|[\]\\{}]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*').replace(/\u0002/g, '[^/]')}$`);
// One entry of a path list: a glob, or a plain path that names itself and everything under it.
const entry = (g) => { g = normPath(g); if (/[*?]/.test(g)) { const rx = globRx(g); return (p) => rx.test(p); } const d = g.replace(/\/$/, ''); return (p) => p === d || p.startsWith(`${d}/`); };
// A path list: a path is in it when an entry takes it and no `!entry` does. The path is taken as given (git's names
// are exact; a name may hold spaces, quotes or backticks).
export function matcher(list) {
  const pos = [], neg = [];
  for (const g of list || []) { const n = normPath(g); if (n) (n.startsWith('!') ? neg : pos).push(entry(n.slice(n.startsWith('!') ? 1 : 0))); }
  return (p) => { p = String(p); return pos.some((f) => f(p)) && !neg.some((f) => f(p)); };
}
// screen_paths, repo-prefixed: a repo none of whose entries names it shows all its files ("!<repo>" shows none of them);
// a repo some entry names shows the files its entries take. No screen_paths: every file can change a screen.
export function screenOf(def) {
  const list = (def.list('screen_paths') || []).map(normPath);
  if (!def.list('screen_paths')) return () => true;
  const m = matcher(list), neg = matcher(list.filter((x) => x.startsWith('!')).map((x) => x.slice(1)));
  return (p) => { p = String(p); const repo = p.split('/')[0]; return list.some((x) => !x.startsWith('!') && x.startsWith(`${repo}/`)) ? m(p) : !neg(p); };
}

// The definition's front matter: a list (`[a, b]` or `- a` lines) or a map (indented `key: value` lines); the first
// definition that sets a key wins. A file that doesn't exist is an error. Its folder is the one holding `.agents/`.
export function definition(paths) {
  const missing = paths.filter((p) => !existsSync(resolve(p)));
  if (!paths.length || missing.length) throw new Error(paths.length ? `no definition at ${missing.join(', ')}` : '--definition <project definition> is required');
  const fms = paths.map((p) => (read(resolve(p)).match(/^---\n([\s\S]*?)\n---/) || [])[1] || '');
  const block = (key) => fms.map((fm) => fm.match(new RegExp(`^${key}:[ \\t]*(.*)$((?:\\n(?:[ \\t]+\\S|-[ \\t]).*)*)`, 'm'))).find(Boolean);
  const items = (v) => v.slice(1, v.lastIndexOf(']')).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const list = (key) => {
    const m = block(key);
    if (!m) return null;
    const v = m[1].replace(/(^|\s+)#.*$/, '').trim();
    return (v.startsWith('[') ? v.slice(1, v.lastIndexOf(']')).split(',') : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''))).map((s) => s.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };
  const map = (key) => { const m = block(key); return Object.fromEntries((m ? m[2].split('\n') : []).map((l) => l.match(/^\s+([^\s:]+):\s*(.+)$/)).filter(Boolean).map((x) => [x[1].toLowerCase(), x[2].trim()])); };
  // A map whose values are lists: kind → [glob, glob].
  const lists = (key) => Object.fromEntries(Object.entries(map(key)).map(([k, v]) => [k, v.startsWith('[') ? items(v.replace(/\s+#.*$/, '')) : [v.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')]]));
  const f = resolve(paths[0]);
  return { list, map, lists, files: paths.map((p) => resolve(p)), dir: basename(dirname(f)) === '.agents' ? dirname(dirname(f)) : dirname(f) };
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
// A command split like a shell would, quotes only; anything that needs a shell (operators, pipes, variables) is null.
export function split(s) {
  const out = [];
  let cur = '', q = null, quoted = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { if (cur || quoted) out.push(cur); cur = ''; quoted = false; continue; }
    if (/[;&|<>`$]/.test(ch)) return null;
    cur += ch;
  }
  if (q) return null;
  if (cur || quoted) out.push(cur);
  return out;
}
// The checks_allow entry a command's words start with ("npm test" allows "npm test -- renew", not "npm exec").
export const allowed = (argv, allow) => (argv?.length && allow.find((a) => a.split(/\s+/).every((x, i) => argv[i] === x))) || null;

const LINE = /^- (S\d+)(?: \(([^)]+)\))?:[ \t]*(.*)$/;
// A Surface line: `- S<n> (<kind>): <fact>: <where>; equals <its record>`, or `- S<n> (<kind>): not touched: <why>`.
const surface = (t) => section(t, 'Surface').split('\n').filter((l) => LINE.test(l)).map((l) => {
  const [, id, k = '', rest] = l.trim().match(LINE), kind = k.trim().toLowerCase(), touched = !/^not touched\b/i.test(rest);
  return { id, kind, touched, text: l.trim() };
});

// A path in STATE.md is read from the ticket folder or, failing that, from the nearest folder above it where it exists.
const within = (dir, p) => { for (let d = dir; ; d = dirname(d)) { const q = resolve(d, p); if (existsSync(q)) return q; if (dirname(d) === d) return null; } };
export const LANES = ['direct', 'standard', 'critical'];
export const laneRank = (l) => LANES.indexOf(String(l || '').toLowerCase().split(/[\s(]/)[0]);

// Everything a script reads from a ticket folder. A `Worktree <repo>: <path>` line is a worktree the change is
// delivered from; a `Lane <name>: <path>` line is a build lane's extra worktree, where proof may run, never delivered.
export function ticket(dir) {
  const state = read(join(dir, 'STATE.md')), brief = read(join(dir, 'BRIEF.md')), design = read(join(dir, 'DESIGN.md')), ev = join(dir, 'evidence');
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
  let checks = [], checksError = '';
  try { checks = JSON.parse(read(join(dir, 'CHECKS.json')) || '[]'); if (!Array.isArray(checks)) throw new Error('is not a list'); } catch (e) { checks = []; checksError = e.message; }
  const word = (t, k) => field(t, k).toLowerCase().split(/[\s(,;]/)[0];
  return {
    dir, ev, state, brief, design, worktrees, checks, checksError,
    // The worktrees the change is delivered from.
    repos: Object.values(worktrees).filter((w) => !w.lane && w.path),
    names: existsSync(ev) ? readdirSync(ev, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')) : [],
    lane: word(state, 'Risk lane'),
    screen: word(state, 'Screen'),
    hotfix: word(state, 'Hotfix'),
    deliveries: fields(state, 'Delivered').map((v) => ({ time: v.split(/\s/)[0], where: v.split(/\s/).slice(1).join(' ') })).filter((d) => d.time),
    accepted: field(state, 'Accepted').split(/\s/)[0],
    rejections: bullets(section(state, 'Rejections')).map((l) => { const m = l.match(/^(missed purpose|defect|new wish)\s*:\s*(.*)$/i); return m ? { class: m[1].toLowerCase(), text: m[2] } : { class: '', text: l }; }),
    found: bullets(section(state, 'Found on the way')).map((l) => { const m = l.match(/^\[(fixed|hotfix|next|filed|dropped|lead)\b([^\]]*)\]\s*(.*)$/i); return m ? { tag: m[1].toLowerCase(), id: m[2].trim(), text: m[3] } : { tag: '', id: '', text: l }; }),
    briefLane: word(brief, 'Lane'),
    undo: word(brief, 'Undo'),
    // A Paths line's first word is the path; anything after it is a note.
    paths: bullets(section(brief, 'Paths')).map((l) => normPath(l.split(/\s+/)[0])).filter(Boolean),
    acceptance: bullets(section(brief, 'Acceptance')).filter((l) => /^A\d+\b/.test(l)),
    oraclesChanged: field(design, 'Oracles changed').split(',').map(normPath).filter((x) => x && !/^none$/i.test(x)),
    decisions: section(design, 'Decisions').split(/^### /m).slice(1),
    surface: surface(design),
    proofs: read(join(ev, 'proof.jsonl')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }),
    log: read(join(ev, 'log.md')).split('\n').flatMap((l) => { const m = l.trim().match(/^(\S+)\s+(start|return)\s+([^:\s]+)\s*(?::\s*(.*))?$/); const t = m && Date.parse(m[1]); return m && !isNaN(t) ? [{ time: t, kind: m[2], role: m[3], status: (m[4] || '').trim() }] : []; }),
  };
}

// A check is due "before delivery", or "after <step>"; --after runs the second kind too. Its spec decides its result.
export const dueKind = (c) => (/^before delivery$/i.test(String(c.due ?? '').trim()) ? 'before' : /^after \S.*$/i.test(String(c.due ?? '').trim()) ? 'after' : '');
export const due = (c, after) => dueKind(c) === 'before' || (after && dueKind(c) === 'after');
export const specOf = (c, def) => sha(JSON.stringify([c.verify, c.expect ?? null, c.in ?? null, !!c.heavy, def.list('checks_allow') || [], def.list('nothing_ran') || []]));

// Test files: the definition's test_files, read against repo-relative paths, or common conventions.
const TESTS = ['**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*_tests.*', '**/test_*.*', '**/tests.*', '**/*_spec.rb', '**/*Test.*', '**/*Tests.*'];
export const testFiles = (def) => { const g = def.list('test_files'); return matcher(g?.length ? g : TESTS); };

// What stands as proof, by facts about trees. The change's files are those it alters since its base.
export function proofRules(T, def) {
  const isTestFile = testFiles(def);
  const nothingRan = def.list('nothing_ran') || [];
  const W = (p) => Object.values(T.worktrees).find((w) => w.path && w.repository === p.repository && !w.lane) || Object.values(T.worktrees).find((w) => w.path && w.repository === p.repository);
  const names = (w, a, b) => namesBetween(w.path, a, b) || [];
  const changed = {};
  const changeFiles = (w) => (changed[w.name] ??= w.base ? names(w, w.base, 'HEAD') : []);
  const patch = (w, a, b) => { const t = git(w.path, 'diff', a, b); try { return t ? execFileSync('git', ['patch-id', '--stable'], { cwd: w.path, input: t + '\n', encoding: 'utf8' }).split(' ')[0] : ''; } catch { return ''; } };
  // Commit c stands for HEAD when it exists, holds the change (its tree isn't the base's while HEAD's is not), is HEAD's
  // ancestor or the same change on a moved base, and what differs since touches none of the change's files but tests
  // and the files in `also`. So a merge that changes no byte, or a base move that leaves the change's files alone, keeps
  // what was proven.
  const stands = (w, c, also = []) => {
    const t = c && git(w.path, 'rev-parse', `${c}^{tree}`);
    if (!t) return false;
    if (t === w.tree) return true;
    if (t === w.baseTree) return false;
    const rebased = () => { const b = w.baseRef, p1 = b && patch(w, git(w.path, 'merge-base', c, b), c); return !!p1 && p1 === patch(w, w.base, 'HEAD'); };
    if (git(w.path, 'merge-base', '--is-ancestor', c, 'HEAD') === null && !rebased()) return false;
    const mine = changeFiles(w);
    return names(w, c, 'HEAD').every((f) => !mine.includes(f) || isTestFile(f) || also.some((x) => pathIs(f, x, w.name)));
  };
  // A run ran something: an exit code, and output that matches no nothing_ran pattern. A green ran on HEAD's tree, or
  // on a commit that stands for HEAD with a clean worktree.
  const ran = (p) => typeof p.exit === 'number' && !nothingRan.some((x) => matches(p.log || '', x));
  const isGreen = (p) => { const w = W(p); return !!w && !p.base && ran(p) && p.exit === 0 && (p.tree === w.tree || (p.tree === git(w.path, 'rev-parse', `${p.head}^{tree}`) && stands(w, p.head))); };
  return { isTest: isTestFile, isTestFile, stands, isGreen, ran, worktreeOf: W, changeFiles };
}

// Whether HEAD contains the tip of the base ref STATE.md names (origin/<from>, else <from>; local refs, no fetch).
// null when no such ref exists here.
export const containsBase = (w) => (!w.baseRef ? null : git(w.path, 'merge-base', '--is-ancestor', w.baseRef, 'HEAD') !== null);
export const behindOf = (T) => T.repos.flatMap((w) => { const c = containsBase(w); return c === true ? [] : [{ name: w.name, why: c === null ? `no base ref ${w.from ? `"${w.from}" ` : ''}found locally` : `HEAD does not contain ${w.baseRef}` }]; });

// The facts that set the lane's floor: the paths the brief lists (fromBrief) or the files each worktree changed from
// its base to HEAD, against the definition's boundaries, migrations, page_paths and screen_paths. A brief path is
// placed when its first segment is one of the ticket's repos and it holds no brace; it is then taken as itself and as
// the base files it names. Paths it cannot place are listed, never guessed.
export function laneFacts(T, def, fromBrief) {
  const boundaries = Object.entries(def.lists('boundaries')).map(([kind, globs]) => ({ kind, take: matcher(globs) }));
  const migration = matcher(def.list('migrations') || []), page = matcher(def.list('page_paths') || []), screen = screenOf(def);
  const notes = [], unplaced = [], paths = [];
  if (fromBrief) {
    const at = {};
    if (!T.brief) notes.push('no BRIEF.md');
    else if (!T.paths.length) notes.push('BRIEF.md has no "- <repo>/<path>" line under "## Paths"');
    for (const p of T.paths) {
      const w = T.repos.find((x) => x.name === p.split('/')[0]);
      if (!w || p.includes('{')) { unplaced.push(p); continue; }
      const named = (at[w.name] ??= (filesAt(w.path, w.base || 'HEAD') || []).map((f) => `${w.name}/${f}`)).filter(matcher([p]));
      paths.push({ path: p, forms: [p, ...named], added: !named.length });
    }
  } else {
    if (!T.repos.length) notes.push('STATE.md names no existing "Worktree <repo>: <path>"');
    for (const w of T.repos) {
      if (!w.base) { notes.push(`${w.name}: no base to compare with (STATE.md's "from <branch> at <sha>")`); continue; }
      const out = statusBetween(w.path, w.base, 'HEAD');
      if (out === null) { notes.push(`${w.name}: git could not compare ${w.base.slice(0, 12)} with HEAD`); continue; }
      for (const c of out) paths.push({ path: `${w.name}/${c.path}`, forms: [`${w.name}/${c.path}`], added: c.status === 'A' });
    }
  }
  const any = (take, x) => x.forms.some((f) => take(f));
  const kinds = boundaries.map((b) => ({ kind: b.kind, paths: paths.filter((x) => any(b.take, x)).map((x) => x.path) })).filter((b) => b.paths.length);
  const migrations = paths.filter((x) => any(migration, x)).map((x) => x.path);
  return { boundaries: boundaries.length, paths, notes, unplaced, kinds, migrations, pages: paths.filter((x) => x.added && page(x.path)).map((x) => x.path), screenTouched: paths.some((x) => any(screen, x)), floor: kinds.length || migrations.length ? 'critical' : 'none' };
}

// The gate as the definition and the current diff make it: each `gate:` entry, what selects it and the files that
// did, and whether an earlier pass is reached by what changed since. See gate.mjs.
export function gatePlan(T, def) {
  const allow = def.list('checks_allow') || [], nothingRan = def.list('nothing_ran') || [], boundaries = def.lists('boundaries');
  const W = Object.fromEntries(T.repos.map((w) => [w.name, w]));
  const errors = [], changes = {};
  if (!T.repos.length) errors.push('STATE.md names no existing "Worktree <repo>: <path>"');
  const dirty = T.repos.filter((w) => git(w.path, 'status', '--porcelain') !== '').map((w) => w.name);
  for (const w of T.repos) {
    if (!w.base) { errors.push(`${w.name}: no base to compare with (STATE.md's "from <branch> at <sha>")`); continue; }
    const c = statusBetween(w.path, w.base, 'HEAD');
    if (c === null) errors.push(`${w.name}: git could not compare ${w.base.slice(0, 12)} with HEAD`);
    else changes[w.name] = c;
  }
  const entries = (def.list('gate') || []).map((line, i) => {
    const parts = line.split('|').map((s) => s.trim()), [repo, when = '', command = '', flag = ''] = parts;
    const words = split(command), allowedBy = allowed(words, allow);
    // Words naming a file (./ ../ /) of the allow-list entry are the definition folder's files, never the branch's.
    const own = allowedBy ? allowedBy.split(/\s+/).filter((x) => /^(\.{1,2})?\//.test(x)) : [];
    const e = { n: i + 1, line, repo, when, command, words, allowedBy, own, heavy: flag === 'heavy', bad: '' };
    e.spec = sha(JSON.stringify([repo, when, command, flag, allow, nothingRan, own.map((x) => sha(read(resolve(def.dir, x))))]));
    if (parts.length < 3 || parts.length > 4 || !repo || !when || !command || (flag && flag !== 'heavy')) e.bad = 'not "<repo> | <when> | <command>" with an optional "| heavy"';
    const kind = (when.match(/^boundary:\s*(\S+)$/i) || [])[1]?.toLowerCase();
    if (!e.bad && kind && !boundaries[kind]) e.bad = `the definition's boundaries have no "${kind}"`;
    if (!e.bad && kind && command.includes('{files}')) e.bad = 'a boundary entry can\'t use {files}: it names files of other repos';
    if (e.bad) return e;
    if (kind) { const m = matcher(boundaries[kind]); Object.assign(e, { scope: Object.keys(W), takes: (r, f) => m(`${r}/${f}`) }); }
    else if (/^always$/i.test(when)) Object.assign(e, { scope: [repo], takes: () => true });
    else { const m = matcher(when.split(',').map((s) => s.trim()).filter(Boolean)); Object.assign(e, { scope: [repo], takes: (r, f) => m(f) }); }
    const hit = e.scope.flatMap((r) => (changes[r] || []).filter((c) => e.takes(r, c.path)).map((c) => ({ ...c, repo: r })));
    e.files = hit.filter((c) => c.repo === repo && c.status !== 'D').map((c) => c.path);
    e.selected = hit.length > 0 && (!command.includes('{files}') || e.files.length > 0);
    return e;
  });
  // An earlier pass is reached when a file it reaches changed between the trees it passed on and HEAD's.
  const reaches = (e, was) => e.scope.some((r) => {
    const w = W[r];
    if (!w || was?.[r] === w.tree) return false;
    if (!was?.[r]) return true;
    const out = namesBetween(w.path, was[r], w.tree);
    return out === null || out.some((f) => e.takes(r, f));
  });
  const pick = (k) => Object.fromEntries(T.repos.map((w) => [w.name, w[k]]));
  return { W, errors, dirty, changes, entries, counted: entries.filter((e) => e.bad || e.selected), reaches, behind: behindOf(T), contains: Object.fromEntries(T.repos.map((w) => [w.name, containsBase(w)])), trees: pick('tree'), heads: pick('head'), bases: pick('base'), allow, nothingRan };
}
export const shortTrees = (t) => Object.entries(t || {}).map(([r, x]) => `${r}@${String(x).slice(0, 12)}`).join(' ');
// What `gate --check` decides: every entry the current diff selects passed on trees that still stand for HEAD, at
// least one is selected, every worktree is clean and contains its base's tip.
export function gateCheck(T, def, P = gatePlan(T, def)) {
  let rec = {};
  try { rec = JSON.parse(read(join(T.ev, 'gate.json'))) || {}; } catch {}
  const passes = rec.passes || {};
  const blockers = [...P.errors, ...(P.dirty.length ? [`uncommitted changes in ${P.dirty.join(', ')}`] : []), ...P.behind.map((b) => `${b.name}: branch is behind its base (${b.why})`)];
  const lines = P.counted.map((e) => {
    const p = passes[e.spec], why = e.bad || (!P.W[e.repo] ? `no worktree "${e.repo}" in STATE.md` : !p ? 'no pass recorded for it as written' : P.reaches(e, p.trees) ? `changed since it passed on ${shortTrees(p.trees)}` : '');
    return { ok: !why, text: `${e.n} ${e.repo} | ${e.when} | ${e.command}: ${why ? `fail, ${why}` : `passed on ${shortTrees(p.trees)}`}` };
  });
  if (!lines.length) blockers.push('the current diff selects no gate entry');
  const ok = !blockers.length && lines.every((l) => l.ok);
  return { ok, blockers, lines, reason: blockers[0] || lines.find((l) => !l.ok)?.text || '' };
}
