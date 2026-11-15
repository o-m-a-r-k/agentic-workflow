// Tests for skills/deliver/scripts. Run: node --test test/*.test.mjs
// Each test builds a small invented project (a library app) in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnArgs, ticket as readTicket, matcher, screenOf, definition } from '../skills/deliver/scripts/ticket.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'deliver', 'scripts');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
const run = (name, ...a) => spawnSync(process.execPath, [join(scripts, `${name}.mjs`), ...a], { env, encoding: 'utf8' });
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const edit = (p, from, to) => writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
const commit = (p, msg) => { git(p, 'add', '-A'); git(p, 'commit', '-qm', msg); return git(p, 'rev-parse', 'HEAD'); };

const RENEW = ['export function renew(loan, limit) {', '  if (loan.renewals >= limit) {', "    throw new Error('limit');", '  }', '  loan.renewals += 1;', '  return loan;', '}', ''].join('\n');
const RENEW_TEST = "import { renew } from './renew.ts';\n// refuses the fourth renewal\n";
const RENEW_CHECK = "import { readFileSync } from 'node:fs';\nconsole.log('1 test passed');\nprocess.exit(readFileSync('src/loans/renew.ts', 'utf8').includes('>= limit)') ? 1 : 0);\n";
const ORACLE = (says) => `console.log(${JSON.stringify(says)});\n`;
const RENEW_WORDS = [process.execPath, 'test/renew.mjs'];
// A gate command: notes its name and files in the ticket folder, and fails when the ticket folder holds fail-<name>.
const GATE = "import { appendFileSync, existsSync } from 'node:fs';\nconst [name, ...files] = process.argv.slice(2);\nappendFileSync(process.env.GATE_TICKET + '/gate.ran', [name, ...files].join(' ') + '\\n');\nconsole.log(existsSync(process.env.GATE_TICKET + '/empty-' + name) ? 'No tests found' : name + ': 3 passing');\nprocess.exit(existsSync(process.env.GATE_TICKET + '/fail-' + name) ? 1 : 0);\n";
const GATE_LINES = ['catalog | always | node gate.mjs catalog-all', 'catalog | src/**, !src/**/*.md | node gate.mjs catalog-src {files}', 'web | boundary:loans | node gate.mjs web-consumer', 'web | always | node gate.mjs web-all | heavy'];

// A ticket folder with one worktree ("catalog"), optionally a second ("web"), and a project definition whose folder
// holds a canonical copy of the catalog's oracle.
function ticket({ web = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aw-test-'));
  const t = join(root, 'EX-1');
  const repo = (name, files) => {
    const p = join(t, name);
    mkdirSync(p, { recursive: true });
    git(p, 'init', '-q', '-b', 'main');
    for (const [f, c] of Object.entries(files)) write(join(p, f), c);
    const sha = commit(p, 'base');
    git(p, 'checkout', '-q', '-b', 'fix/EX-1');
    return { path: p, sha };
  };
  const cat = repo('catalog', { 'src/loans/renew.ts': RENEW, 'src/loans/renew.test.ts': RENEW_TEST, 'src/fees/fee.ts': 'export const fee = 1;\n', 'db/migrations/0001-loans.sql': 'create table loans();\n', 'scripts/oracle.mjs': ORACLE('0 disagreements'), 'test/renew.mjs': RENEW_CHECK, 'test/none.mjs': "console.log('No tests found')\n", 'test/old.mjs': "console.log('1 failed');\nprocess.exit(1);\n", 'gate.mjs': GATE, 'docs/readme.md': 'library\n' });
  const w = web ? repo('web', { 'src/loans/renew.ts': RENEW, 'src/pages/loan.tsx': 'export const Loan = () => null;\n', 'src/api.ts': 'export {};\n', 'messages/en.json': '{}\n', 'gate.mjs': GATE }) : null;
  write(join(root, 'catalog', 'scripts', 'oracle.mjs'), ORACLE('0 disagreements'));
  const state = (extra = '', lane = 'standard') => write(join(t, 'STATE.md'), [
    '# State: EX-1', '', 'Project: library-app', 'Ticket: EX-1', 'Type: bug (named by: the person)', 'Started: 2026-01-05T09:00Z', 'Profile: none', `Risk lane: ${lane}`, 'Screen: none', 'Hotfix: no',
    `Worktree catalog: catalog on fix/EX-1, from main at ${cat.sha}`,
    ...(w ? [`Worktree web: web on fix/EX-1, from main at ${w.sha}`] : []),
    extra, '',
  ].join('\n'));
  state();
  const brief = (lane, paths) => write(join(t, 'BRIEF.md'), `# Brief: EX-1\n\nLane: ${lane}\nUndo: yes\n\n## Paths\n${paths.map((p) => `- ${p}`).join('\n')}\n\n## Acceptance\n- A1: a fourth renewal is refused\n`);
  const def = join(root, 'project.md');
  const defWith = (gate = GATE_LINES, more = '') => write(def, `---\nname: library-app\nchecks_allow: [node test/renew.mjs, node test/none.mjs, node test/count.mjs, node ./catalog/scripts/oracle.mjs, node gate.mjs]   # runners\nnothing_ran: [No tests found, /^0 passing/m]\nscreen_paths: ["!catalog", web/src/pages, web/messages]\nboundaries:\n  loans: [catalog/src/loans/**, "!catalog/src/loans/**/*.md"]\n  money: [catalog/src/fees/**]\nmigrations: [catalog/db/migrations/**]\npage_paths: [web/src/pages/**]\ngate:\n${gate.map((g) => `  - ${g}`).join('\n')}\n${more}---\n`);
  defWith();
  const checks = (list) => write(join(t, 'CHECKS.json'), JSON.stringify(list, null, 2));
  const C = (...more) => run('checks', t, ...more, '--definition', def);
  const G = (...more) => run('gate', t, ...more, '--definition', def);
  const L = (...more) => run('lane', t, ...more, '--definition', def);
  const P = (...more) => run('proof', t, '--definition', def, ...more);
  const R = (...more) => run('ready', t, ...more, '--definition', def);
  const ran = () => (existsSync(join(t, 'gate.ran')) ? readFileSync(join(t, 'gate.ran'), 'utf8').trim().split('\n') : []);
  return { root, t, cat, w, state, brief, checks, def, defWith, C, G, L, P, R, ran, ev: (n) => join(t, 'evidence', n), done: () => rmSync(root, { recursive: true, force: true }) };
}

const goodChecks = [{ id: 'C1', proves: 'the count shown equals the stored count', surface: ['S1'], verify: 'cmd: node ./catalog/scripts/oracle.mjs --stack {worktree}', in: 'catalog', expect: '0 disagreements', due: 'before delivery' }];
const walkCheck = { ...goodChecks[0], id: 'C5', surface: [], verify: 'walk: renew four times on the loan page' };
const walked = (f, id, sha, result = 'pass') => write(f.ev(`walk-${id}.md`), `Check: ${id}\nCommit: catalog@${sha}\nResult: ${result}\nSeen: three renewals, the fourth refused\n`);

test('globs: ** * ? and !exclusions; a plain path names what is under it; screen_paths keeps its per-repo default', () => {
  const m = matcher(['src/**', '!src/**/*.md', 'docs', 'a?.ts']);
  assert.deepEqual(['src/a.ts', 'src/x/y.ts', 'src/x/y.md', 'docs/z.md', 'docsx/z', 'ab.ts', 'abc.ts', 'lib/a.ts'].map(m), [true, true, false, true, false, true, false, false]);
  assert.equal(matcher(['**/*.test.*'])('renew.test.ts'), true);
  const root = mkdtempSync(join(tmpdir(), 'aw-def-'));
  write(join(root, 'd.md'), '---\nscreen_paths: ["!api", web/src/, "!web/src/legacy"]\ngate:\n- api | always | npm test\n---\n');
  const def = definition([join(root, 'd.md')]);
  const s = screenOf(def);
  assert.deepEqual(['api/src/a.ts', 'web/src/a.tsx', 'web/src/legacy/b.tsx', 'web/package.json', 'docs/x.md'].map(s), [false, true, false, false, true]);
  assert.deepEqual(def.list('gate'), ['api | always | npm test'], 'a list may start at the line\'s start');
  rmSync(root, { recursive: true });
});

test('the ticket reader: STATE.md\'s lane, screen, hotfix, deliveries, rejections and found lines; BRIEF.md; DESIGN.md; a build lane is a worktree, "Risk lane" is not', () => {
  const f = ticket();
  const side = join(f.root, 'side');
  git(f.cat.path, 'worktree', 'add', '-q', '--detach', side, 'HEAD');
  f.state(['Delivered: 2026-01-06T10:00Z main', 'Delivered: 2026-01-05T15:00Z main', 'Accepted: 2026-01-07T09:00Z', `Lane side: ${side}`, '', '## Rejections', '- defect: the count is off by one', '- new wish: show the fee', '', '## Found on the way', '- [fixed] a typo', '- [hotfix EX-2] a fee shown twice', '- [next EX-3] slow list', '- [lead] maybe the cache'].join('\n'), 'critical');
  f.brief('standard', ['catalog/src/loans/renew.ts  (the refusal)', '`web/src/pages/**`']);
  write(join(f.t, 'DESIGN.md'), '# Design\n\nOracles changed: none\n\n## Surface\n- S1 (renewal-count): count; equals loans.renewals\n- S2 (fee): not touched: fees\n\n## Decisions\n### D1: Where\n- Choice: in renew()\n');
  const T = readTicket(f.t);
  assert.deepEqual([T.lane, T.screen, T.hotfix, T.briefLane, T.undo, T.accepted], ['critical', 'none', 'no', 'standard', 'yes', '2026-01-07T09:00Z']);
  assert.deepEqual(T.deliveries.map((d) => d.time), ['2026-01-06T10:00Z', '2026-01-05T15:00Z']);
  assert.deepEqual(T.rejections.map((r) => r.class), ['defect', 'new wish']);
  assert.deepEqual(T.found.map((x) => `${x.tag}:${x.id}`), ['fixed:', 'hotfix:EX-2', 'next:EX-3', 'lead:']);
  assert.deepEqual(T.paths, ['catalog/src/loans/renew.ts', 'web/src/pages/**']);
  assert.deepEqual(T.acceptance, ['A1: a fourth renewal is refused']);
  assert.deepEqual([T.surface.length, T.decisions.length, T.oraclesChanged], [2, 1, []]);
  assert.deepEqual(Object.keys(T.worktrees), ['catalog', 'side']);
  assert.deepEqual(T.repos.map((w) => w.name), ['catalog']);
  f.done();
});

test('lane --paths: the brief\'s paths, as written and as the base files they name, set the floor; a lane below it stops', () => {
  const f = ticket({ web: true });
  f.brief('standard', ['catalog/src/**', 'web/src/pages/history.tsx', 'web/src/pages/loan.tsx']);
  let r = f.L('--paths');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^lane: stop, the floor is critical and the lane is standard/m);
  assert.match(r.stdout, /^Floor: critical$/m);
  assert.match(r.stdout, /^Boundary loans: catalog\/src\/\*\*$/m, 'a glob is read through the base files it takes');
  assert.match(r.stdout, /^Boundary money: catalog\/src\/\*\*$/m);
  assert.match(r.stdout, /^Screen: touched$/m);
  assert.match(r.stdout, /^New pages: web\/src\/pages\/history\.tsx$/m, 'a listed page that names nothing at the base is new');
  assert.match(r.stdout, /^Brief lane: standard$/m);
  assert.equal(readFileSync(f.ev('lane.md'), 'utf8').trim(), r.stdout.trim());
  f.state('', 'critical');
  assert.equal(f.L('--paths').status, 0, 'the ticket\'s lane in STATE.md is what is compared');
  f.state('', '');
  f.brief('critical', ['catalog/db/migrations/0002-fees.sql']);
  r = f.L('--paths');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^Migrations: catalog\/db\/migrations\/0002-fees\.sql$/m);
  assert.match(r.stdout, /^Screen: none$/m);
  f.brief('direct', ['web/src/api.ts']);
  r = f.L('--paths');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Floor: none$/m);
  f.brief('direct', []);
  r = f.L('--paths');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no path could be read[\s\S]*has no "- <repo>\/<path>" line under "## Paths"/);
  f.done();
});

test('lane from the diff: the files each worktree changed since its base; a migration raises the floor whatever the brief said', () => {
  const f = ticket({ web: true });
  let r = f.L();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no path could be read/);
  edit(join(f.w.path, 'src/pages/loan.tsx'), 'null', '1');
  write(join(f.w.path, 'src/pages/history.tsx'), 'export const History = () => null;\n');
  commit(f.w.path, 'a page');
  r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^Floor: none$/m);
  assert.match(r.stdout, /^Screen: touched$/m);
  assert.match(r.stdout, /^New pages: web\/src\/pages\/history\.tsx$/m);
  f.brief('standard', ['web/src/pages/loan.tsx']);
  write(join(f.cat.path, 'db/migrations/0002-fees.sql'), 'alter table loans;\n');
  commit(f.cat.path, 'a migration');
  r = f.L();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^Floor: critical$/m);
  assert.match(r.stdout, /^Migrations: catalog\/db\/migrations\/0002-fees\.sql$/m);
  f.state('', 'critical');
  r = f.L();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^Brief lane: standard$/m);
  f.done();
});

test('gate selects by the diff, a boundary across repos included, runs one at a time and records each pass; --check holds it', () => {
  const f = ticket({ web: true });
  assert.equal(f.G('--check').status, 1, 'nothing selected is no gate');
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>');
  write(join(f.cat.path, 'src/loans/notes.md'), 'why\n');
  commit(f.cat.path, 'the change');
  let c = f.G('--check');
  assert.equal(c.status, 1);
  assert.match(c.stdout, /1 catalog \| always .*: fail, no pass recorded/);
  const r = f.G();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.ran(), ['catalog-all', 'catalog-src src/loans/renew.ts', 'web-consumer'], 'the boundary runs the consumer\'s tests in the other repo; {files} names the files that matched');
  assert.match(r.stdout, /Not selected: 4/);
  const g = JSON.parse(readFileSync(f.ev('gate.json'), 'utf8'));
  assert.deepEqual([g.pass, g.runs, g.selected, Object.keys(g.trees)], [true, 3, [1, 2, 3], ['catalog', 'web']]);
  assert.match(readFileSync(f.ev('gate/3-web.log'), 'utf8'), /^gate 3 web spec [0-9a-f]{12} trees [\s\S]*web-consumer: 3 passing/);
  c = f.G('--check');
  assert.equal(c.status, 0, c.stdout);
  edit(join(f.cat.path, 'src/loans/renew.ts'), "'limit'", "'over'");
  commit(f.cat.path, 'a fix after the gate');
  assert.equal(f.G('--check').status, 1, 'a change the entries reach needs the gate again');
  f.done();
});

test('gate keeps a pass the change since does not reach, and reruns only what a later change reaches', () => {
  const f = ticket({ web: true });
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>');
  commit(f.cat.path, 'the change');
  assert.equal(f.G().status, 0);
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  commit(f.cat.path, 'docs only');
  let r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(f.ran().slice(3), ['catalog-all'], 'always reruns on any change of its repo; the glob and the boundary are kept');
  assert.match(r.stdout, /2 catalog \| src\/\*\*.*: kept, passed on catalog@/);
  assert.match(r.stdout, /3 web \| boundary:loans .*: kept/);
  // The base moves without overlap: kept as well.
  git(f.cat.path, 'checkout', '-q', 'main');
  write(join(f.cat.path, 'docs/more.md'), 'unrelated\n');
  commit(f.cat.path, 'the base moves');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'main');
  assert.equal(f.G('--check').status, 1, 'always is reached by the merge');
  f.G();
  assert.deepEqual(f.ran().slice(4), ['catalog-all']);
  write(join(f.cat.path, 'src/fees/fee.ts'), 'export const fee = 2;\n');
  commit(f.cat.path, 'reaches the glob, not the loans boundary');
  f.G();
  assert.deepEqual(f.ran().slice(5), ['catalog-all', 'catalog-src src/fees/fee.ts src/loans/renew.ts']);
  edit(join(f.cat.path, 'src/loans/renew.ts'), "'limit'", "'over'");
  commit(f.cat.path, 'reaches everything');
  f.G();
  assert.deepEqual(f.ran().slice(7), ['catalog-all', 'catalog-src src/fees/fee.ts src/loans/renew.ts', 'web-consumer']);
  assert.equal(JSON.parse(readFileSync(f.ev('gate.json'), 'utf8')).runs, 10);
  assert.equal(f.G('--check').status, 0);
  f.done();
});

test('gate: a failed or empty run fails and --check refuses it; a dirty worktree is refused; heavy runs last and not after a failure; a command off checks_allow is refused', () => {
  const f = ticket({ web: true });
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>');
  commit(f.cat.path, 'the change');
  edit(join(f.w.path, 'src/pages/loan.tsx'), 'null', '1');
  commit(f.w.path, 'the page');
  write(join(f.t, 'fail-catalog-src'), '');
  write(join(f.t, 'empty-web-consumer'), '');
  let r = f.G();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /2 catalog \| .*: fail, exit 1 \(evidence\/gate\/2-catalog\.log\)/);
  assert.match(r.stdout, /3 web .*: fail, ran nothing \("No tests found"\)/);
  assert.match(r.stdout, /4 web \| always \| node gate\.mjs web-all: fail, not run: an earlier entry failed/);
  assert.ok(!f.ran().includes('web-all'));
  assert.match(f.G('--check').stdout, /2 catalog .*: fail, no pass recorded/);
  rmSync(join(f.t, 'fail-catalog-src'));
  rmSync(join(f.t, 'empty-web-consumer'));
  const before = f.ran().length;
  r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(f.ran().slice(before), ['catalog-src src/loans/renew.ts', 'web-consumer', 'web-all'], 'only what failed reruns; heavy last');
  write(join(f.cat.path, 'scratch.txt'), 'x\n');
  r = f.G();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uncommitted changes in catalog/);
  assert.match(f.G('--check').stdout, /fail, uncommitted changes in catalog/);
  rmSync(join(f.cat.path, 'scratch.txt'));
  f.defWith(['catalog | always | node -e 1', 'catalog | always | node gate.mjs x; rm -rf /', 'web | boundary:nowhere | node gate.mjs y', 'web | src/** | node gate.mjs z | slow']);
  r = f.G();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1 catalog \| always \| node -e 1: fail, "node -e" does not start with an entry of checks_allow/);
  assert.match(r.stdout, /2 catalog .*: fail, not a plain command/);
  assert.match(r.stdout, /3 web .*: fail, the definition's boundaries have no "nowhere"/);
  assert.match(r.stdout, /4 web .*: fail, not "<repo> \| <when> \| <command>"/);
  f.done();
});

test('gate lists deleted and changed tests and skip markers on added test lines, for the verifier; a boundary consumer with no worktree fails', () => {
  const f = ticket();
  rmSync(join(f.cat.path, 'test/old.mjs'));
  write(join(f.cat.path, 'src/loans/renew.test.ts'), `${RENEW_TEST}it.skip('refuses the fifth renewal', () => {});\n`);
  write(join(f.cat.path, 'src/loans/query.ts'), 'export const page = (rows) => rows.skip(10);\n');
  write(join(f.cat.path, 'src/loans/history.test.ts'), "describe('history', () => {\n  it.only('lists renewals', () => {});\n});\n");
  commit(f.cat.path, 'tests');
  const r = f.G();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /3 web \| boundary:loans .*: fail, no worktree "web" in STATE\.md/, 'a consumer the boundary reaches needs its worktree');
  assert.match(r.stdout, /Test files deleted: catalog\/test\/old\.mjs/);
  assert.match(r.stdout, /Test files changed: catalog\/src\/loans\/renew\.test\.ts/);
  assert.match(r.stdout, /catalog\/src\/loans\/renew\.test\.ts:3: it\.skip\('refuses the fifth renewal'/);
  assert.match(r.stdout, /catalog\/src\/loans\/history\.test\.ts:2: it\.only\('lists renewals'/);
  assert.doesNotMatch(r.stdout, /query\.ts/, 'a skip marker outside a test file is code');
  const g = JSON.parse(readFileSync(f.ev('gate.json'), 'utf8'));
  assert.equal(g.tests.skips.length, 2);
  f.done();
});

test('gate --stop ends its ticket\'s run; a second run is refused while one holds the ticket', async () => {
  const f = ticket();
  write(join(f.cat.path, 'slow.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.GATE_TICKET + '/slow.pid', String(process.pid));\nsetTimeout(() => {}, 120000);\n");
  commit(f.cat.path, 'slow');
  f.defWith(['catalog | always | node slow.mjs'], '');
  edit(f.def, 'node gate.mjs]', 'node gate.mjs, node slow.mjs]');
  const p = spawn(process.execPath, [join(scripts, 'gate.mjs'), f.t, '--definition', f.def], { env, stdio: 'ignore' });
  const closed = new Promise((d) => p.on('close', (code, signal) => d(code ?? signal)));
  for (let i = 0; i < 100 && !existsSync(join(f.t, 'slow.pid')); i++) await new Promise((d) => setTimeout(d, 100));
  assert.equal(f.G().status, 2);
  assert.match(run('gate', f.t, '--stop').stdout, /stopped run/);
  assert.equal(await closed, 143);
  const g = JSON.parse(readFileSync(f.ev('gate.json'), 'utf8'));
  assert.equal(g.entries[0].result, 'running', 'a stopped entry leaves no pass');
  assert.equal(f.G('--check').status, 1);
  f.done();
}, { timeout: 60000 });

test('words counts each state\'s newest capture, keeps first, previous and latest, and marks growth without failing', () => {
  const f = ticket();
  assert.equal(run('words', f.t).status, 1, 'no capture found');
  const cap = (name, text, at) => { const p = f.ev(`screens/${name}.txt`); write(p, text); utimesSync(p, at, at); write(f.ev(`screens/${name}.png`), 'png'); };
  cap('limit-reached@aaa1111', 'You have no renewals left', 1000);
  cap('empty@aaa1111', 'No loans yet', 1000);
  let r = run('words', f.t);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /- limit-reached: 5 words at aaa1111, first 5 \(aaa1111\)$/m);
  cap('limit-reached@bbb2222', 'You have no renewals left on this loan. Return it to borrow again.', 2000);
  cap('empty@bbb2222', 'No loans', 2000);
  r = run('words', f.t);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^words: 2 states, grew: limit-reached$/m);
  assert.match(r.stdout, /- limit-reached: 13 words at bbb2222, previous 5 \(aaa1111\), first 5 \(aaa1111\) — GREW by 8/);
  assert.match(r.stdout, /- empty: 2 words at bbb2222, previous 3 \(aaa1111\), first 3 \(aaa1111\)$/m);
  utimesSync(f.ev('screens/limit-reached@bbb2222.txt'), 2500, 2500);
  assert.match(run('words', f.t).stdout, /- limit-reached: 13 words at bbb2222, previous 5 \(aaa1111\), first 5 \(aaa1111\) — GREW by 8/, 'the same capture read again, re-touched, keeps its mark');
  cap('limit-reached@ccc3333', 'No renewals left', 3000);
  r = run('words', f.t);
  assert.match(r.stdout, /- limit-reached: 3 words at ccc3333, previous 13 \(bbb2222\), first 5 \(aaa1111\)$/m);
  const w = JSON.parse(readFileSync(f.ev('words.json'), 'utf8'));
  assert.deepEqual([w.states['limit-reached'].first.count, w.states['limit-reached'].latest.count], [5, 3]);
  assert.ok(existsSync(f.ev('words.md')));
  f.done();
});

test('proof records the exit, the working tree with untracked files, whether it ran anything, free-form ids; a --base run is refused unless only tests differ from the base', () => {
  const f = ticket();
  f.P('--in', 'catalog', '--test', 'A1', '--base', '--', ...RENEW_WORDS);
  write(join(f.cat.path, 'src/loans/new.ts'), 'x\n');
  const refused = f.P('--in', 'catalog', '--test', 'A1', '--base', '--', ...RENEW_WORDS);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--base: the working files differ from the base in files that are not tests: src\/loans\/new\.ts/);
  f.P('--in', 'catalog', '--test', 'refusal,A2', '--', 'no-such-runner');
  f.P('--in', 'catalog', '--test', 'A3', '--', process.execPath, 'test/none.mjs');
  rmSync(join(f.cat.path, 'src/loans/new.ts'));
  write(join(f.cat.path, 'src/loans/renew.test.ts'), RENEW_TEST + '// the new case\n');
  assert.equal(f.P('--in', 'catalog', '--test', 'A1', '--base', '--', ...RENEW_WORDS).status, 0, 'a test change alone is still the base');
  const [a, b, c, d, e] = readFileSync(f.ev('proof.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual([a.test, a.base, a.exit, a.ran, b.test, c.test, b.base, b.exit, b.ran, d.exit, d.ran, e.base], ['A1', true, 1, true, 'refusal', 'A2', false, null, false, 0, false, true]);
  assert.match(b.error, /ENOENT/);
  assert.equal(a.tree, git(f.cat.path, 'rev-parse', 'HEAD^{tree}'));
  assert.notEqual(b.tree, a.tree);
  assert.equal(f.P('--in', 'nowhere', '--', 'true').status, 2);
  assert.equal(f.P('--in', 'catalog', '--test', 'a b', '--', 'true').status, 2);
  assert.equal(run('proof', f.t, '--in', 'catalog', '--', 'true').status, 2, 'the definition is required');
  f.done();
});

test('on Windows a word with a quote is refused before cmd.exe sees it', () => {
  const bin = mkdtempSync(join(tmpdir(), 'aw-bin-'));
  write(join(bin, 'runner.CMD'), '@echo off\n');
  const e = { PATH: bin, PATHEXT: '.CMD' };
  assert.match(spawnArgs(['runner', 'a"&calc'], true, e).error, /quote/);
  assert.deepEqual(Object.values(spawnArgs(['runner', 'a&b'], true, e).env).map((x) => x.toLowerCase()), [join(bin, 'runner.CMD').toLowerCase(), 'a&b']);
  rmSync(bin, { recursive: true });
});

test('checks: oracles run from the definition folder, the allow-list is a prefix, nothing-ran and trivial expects fail, walks need their fields, a due neither form fails, logs name the spec', () => {
  const f = ticket();
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('rigged: 0 disagreements'));
  const head = commit(f.cat.path, 'the branch edits its oracle');
  f.checks([
    { ...goodChecks[0], expect: '/^0 disagreements/m' },
    { ...goodChecks[0], id: 'C2', verify: 'cmd: node -e 1' },
    { ...goodChecks[0], id: 'C3', verify: 'cmd: node test/renew.mjs; rm -rf /' },
    { ...goodChecks[0], id: 'C4', verify: 'cmd: node test/none.mjs', expect: '/./' },
    { ...goodChecks[0], id: 'C6', verify: 'cmd: node test/none.mjs', expect: 'tests' },
    walkCheck, { ...walkCheck, id: 'C7' }, { ...walkCheck, id: 'C9' },
    { ...goodChecks[0], id: 'C8', verify: 'walk: x', due: 'after deploy' },
    { ...goodChecks[0], id: 'C10', due: 'before delivery 2' },
  ]);
  walked(f, 'C5', head);
  walked(f, 'C9', f.cat.sha);
  write(f.ev('walk-C7.md'), `walked at catalog@${head}\nseen: fine\n`);
  const r = f.C();
  assert.equal(r.status, 1);
  for (const want of [/C1 \[S1\]: pass/, /C2 \[S1\]: fail: "node -e" does not start with an entry of checks_allow/, /C3 \[S1\]: fail: not a plain command/, /C4 \[S1\]: fail: expect is empty or matches anything/, /C6 \[S1\]: fail: ran nothing \("No tests found"\)/, /C5: pass/, /C7: fail: evidence\/walk-C7\.md has no "Check: C7" line/, /C9: fail: .*doesn't stand for catalog HEAD/, /C10 \[S1\]: fail: due "before delivery 2" is neither/])
    assert.match(r.stdout, want);
  assert.doesNotMatch(r.stdout, /C8/);
  assert.match(f.C('--after').stdout, /C8 \[S1\]: fail: no evidence\/walk-C8\.md/, '--after runs the checks due after a step');
  assert.match(readFileSync(f.ev('checks/C1.log'), 'utf8'), new RegExp(`^check C1 spec [0-9a-f]{12} trees [\\s\\S]*--stack ${realpathSync(f.cat.path).replace(/[/.]/g, '\\$&')}`));
  walked(f, 'C5', head, 'fail');
  f.checks([walkCheck]);
  assert.match(f.C().stdout, /C5: fail: evidence\/walk-C5\.md says Result: fail/);
  f.checks([{ ...walkCheck, due: 'after deploy' }]);
  assert.match(f.C().stdout, /checks: fail \(0\/0[\s\S]*no check is due/);
  f.checks([goodChecks[0]]);
  write(f.def, readFileSync(f.def, 'utf8').replace(/\n/g, '\r\n'));
  assert.match(f.C().stdout, /C1 \[S1\]: pass/, 'a CRLF definition reads the same');
  rmSync(join(f.root, 'catalog'), { recursive: true });
  assert.match(f.C().stdout, /C1 \[S1\]: fail: \.\/catalog\/scripts\/oracle\.mjs is not in the definition's folder/);
  assert.equal(run('checks', f.t).status, 2, 'the definition is required');
  assert.match(run('checks', f.t, '--definition', join(f.root, 'nowhere.md')).stderr, /no definition at .*nowhere\.md/);
  f.done();
});

test('checks: a pass stands while its commits stand and a green proof line with the same words is adopted; an oracle always runs; heavy runs last; DESIGN.md naming an oracle change runs the worktree\'s copy', () => {
  const f = ticket();
  write(join(f.cat.path, 'test/count.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('../count.ran', 'x');\nconsole.log('count ok');\n");
  commit(f.cat.path, 'a counting check');
  write(join(f.cat.path, 'src/loans/renew.ts'), RENEW + '// changed\n');
  commit(f.cat.path, 'the change');
  const ran = () => (existsSync(join(f.t, 'count.ran')) ? readFileSync(join(f.t, 'count.ran'), 'utf8').length : 0);
  const count = { id: 'C2', proves: 'counts', surface: [], verify: 'cmd: node test/count.mjs', in: 'catalog', expect: 'count ok', due: 'before delivery' };
  f.checks([goodChecks[0], count]);
  assert.equal(f.C().status, 0);
  assert.equal(ran(), 1);
  git(f.cat.path, 'commit', '-q', '--allow-empty', '-m', 'merge with an identical tree');
  git(f.cat.path, 'checkout', '-q', 'main');
  write(join(f.cat.path, 'docs/notes.md'), 'unrelated\n');
  commit(f.cat.path, 'the base moves, away from the change\'s files');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'main');
  const again = f.C();
  assert.match(again.stdout, /C2: pass \(stands from [0-9a-f]{12}\)/);
  assert.match(again.stdout, /C1 \[S1\]: pass$/m);
  assert.equal(ran(), 1);
  write(join(f.cat.path, 'src/loans/renew.ts'), RENEW + '// changed again\n');
  commit(f.cat.path, 'a fix to the change');
  f.P('--in', 'catalog', '--', 'node', 'test/count.mjs');
  assert.equal(ran(), 2);
  assert.match(f.C().stdout, /C2: pass \(adopted from proof/);
  assert.equal(ran(), 2);
  f.checks([{ ...count, heavy: true }, goodChecks[0]]);
  assert.match(f.C().stdout, /- C1 \[S1\]: pass\n- C2: pass/, 'heavy runs last, with no other condition');
  write(join(f.cat.path, 'scripts/oracle.mjs'), ORACLE('worktree oracle: 0 disagreements'));
  commit(f.cat.path, 'the oracle the outcome needs');
  f.checks([{ ...goodChecks[0], expect: 'worktree oracle' }]);
  assert.match(f.C().stdout, /C1 \[S1\]: fail: output does not hold/);
  write(join(f.t, 'DESIGN.md'), '# Design\n\nOracles changed: ./catalog/scripts/oracle.mjs\n');
  assert.match(f.C().stdout, /C1 \[S1\]: pass/);
  f.done();
});

test('a walk stands after a change to tests alone, not after any other change, and never on the base', () => {
  const f = ticket();
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>');
  const head = commit(f.cat.path, 'fix');
  walked(f, 'C5', head);
  f.checks([walkCheck]);
  assert.match(f.C().stdout, /C5: pass/);
  write(join(f.cat.path, 'src/loans/renew.test.ts'), RENEW_TEST + '// one more\n');
  commit(f.cat.path, 'a test');
  assert.match(f.C().stdout, /C5: pass/);
  write(join(f.cat.path, 'src/loans/other.ts'), 'x\n');
  commit(f.cat.path, 'another change');
  assert.match(f.C().stdout, /C5: fail: .*doesn't stand/);
  walked(f, 'C5', f.cat.sha);
  assert.match(f.C().stdout, /C5: fail: .*doesn't stand/);
  f.done();
});

test('checks --stop ends its own ticket\'s run and the command it started; a stopped run writes nothing and a ticket has one run', async () => {
  const f = ticket();
  const other = ticket();
  const SLOW = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn('sleep', ['120'], { stdio: 'inherit' });\nwriteFileSync(process.env.CHECK_TICKET + '/sleep.pid', String(c.pid));\nc.on('close', () => process.exit(0));\n";
  for (const x of [f, other]) { write(join(x.cat.path, 'test/renew.mjs'), SLOW); commit(x.cat.path, 'slow'); x.checks([{ id: 'C1', surface: [], due: 'before delivery', verify: 'cmd: node test/renew.mjs', expect: 'never' }]); }
  const start = (x) => spawn(process.execPath, [join(scripts, 'checks.mjs'), x.t, '--definition', x.def], { env, stdio: 'ignore' });
  const closed = (p) => new Promise((done) => p.on('close', (code, signal) => done(code ?? signal)));
  const pidOf = async (x) => { for (let i = 0; i < 100 && !existsSync(join(x.t, 'sleep.pid')); i++) await new Promise((d) => setTimeout(d, 100)); return +readFileSync(join(x.t, 'sleep.pid'), 'utf8'); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const [p, q] = [start(f), start(other)];
  const [pc, qc] = [closed(p), closed(q)];
  const [sleep, otherSleep] = [await pidOf(f), await pidOf(other)];
  assert.equal(f.C().status, 2, 'a second run on the ticket is refused');
  assert.ok(existsSync(f.ev('checks.run')), 'the refused run leaves the holder in place');
  assert.match(run('checks', f.t, '--stop').stdout, /stopped run/);
  assert.equal(await pc, 143);
  assert.equal(alive(sleep), false);
  assert.equal(existsSync(f.ev('checks.run')), false);
  assert.equal(existsSync(f.ev('checks.json')), false);
  assert.ok(alive(otherSleep), 'the other ticket keeps running');
  assert.match(run('checks', f.t, '--stop').stdout, /no run in progress/);
  run('checks', other.t, '--stop');
  await qc;
  write(join(f.cat.path, 'test/renew.mjs'), "console.log('quick');\n");
  commit(f.cat.path, 'quick');
  write(f.ev('checks.run'), '999999\n');
  assert.equal(f.C().status, 1, 'a file left by a crashed run does not hold the ticket');
  f.done(); other.done();
}, { timeout: 60000 });

test('checks: an unfinished run leaves no result; --stop refuses a wrong folder and ends what a killed run left', async () => {
  const f = ticket();
  const SLOW = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst c = spawn('sleep', ['120'], { stdio: 'inherit' });\nwriteFileSync(process.env.CHECK_TICKET + '/sleep.pid', String(c.pid));\nc.on('close', () => process.exit(0));\n";
  write(join(f.cat.path, 'test/renew.mjs'), SLOW);
  write(join(f.cat.path, 'test/none.mjs'), "console.log('none done');\n");
  commit(f.cat.path, 'commands');
  const base = { surface: [], due: 'before delivery' };
  const quick = { ...base, id: 'C1', verify: 'cmd: node test/none.mjs', expect: 'none done' };
  f.checks([quick]);
  assert.equal(f.C().status, 0);
  assert.equal(run('checks', join(f.t, 'nope'), '--stop').status, 2);
  rmSync(join(f.t, 'sleep.pid'), { force: true });
  f.checks([quick, { ...base, id: 'C2', verify: 'cmd: node test/renew.mjs', expect: 'never' }]);
  const pidOf = async () => { for (let i = 0; i < 100 && !existsSync(join(f.t, 'sleep.pid')); i++) await new Promise((d) => setTimeout(d, 100)); return +readFileSync(join(f.t, 'sleep.pid'), 'utf8'); };
  const p = spawn(process.execPath, [join(scripts, 'checks.mjs'), f.t, '--definition', f.def], { env, stdio: 'ignore' });
  const closed = new Promise((d) => p.on('close', d));
  const sleep = await pidOf();
  assert.equal(existsSync(f.ev('checks.json')), false, 'replacing logs voids the last result');
  p.kill('SIGKILL');
  await closed;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(sleep));
  assert.match(run('checks', f.t, '--stop').stdout, /ended the command a killed run left/);
  for (let i = 0; i < 50 && alive(sleep); i++) await new Promise((d) => setTimeout(d, 100));
  assert.equal(alive(sleep), false);
  assert.equal(existsSync(f.ev('checks.run')), false);
  f.done();
}, { timeout: 60000 });

test('a worktree path in STATE.md is found from the ticket folder or a folder above it', () => {
  const f = ticket();
  const line = (p) => writeFileSync(join(f.t, 'STATE.md'), readFileSync(join(f.t, 'STATE.md'), 'utf8').replace(/^Worktree catalog: \S+/m, `Worktree catalog: ${p}`));
  line('EX-1/catalog');
  assert.equal(readTicket(f.t).worktrees.catalog.path, realpathSync(f.cat.path));
  line('nowhere/catalog');
  assert.equal(readTicket(f.t).worktrees.catalog.path, null);
  f.done();
});

test('record writes one line from the files: lane, idle minutes, gate runs, the floor, rejections, found, words, design, and counts earlier records as reopenings', () => {
  const f = ticket();
  f.state(['Delivered: 2026-01-05T15:00Z main', 'Delivered: 2026-01-06T10:00Z main', 'Accepted: 2026-01-07T09:00Z', '', '## Rejections', '- defect: the count is off by one', '- defect: a label', '- missed purpose: the member wanted the due date', '', '## Found on the way', '- [fixed] a typo', '- [hotfix EX-2] a fee shown twice', '- [next EX-3] slow list', '- [fixed] a stale label'].join('\n'), 'critical');
  f.brief('standard', ['catalog/src/loans/renew.ts']);
  write(join(f.t, 'DESIGN.md'), '# Design\n\n## Surface\n- S1 (renewal-count): count; equals loans.renewals\n- S2 (fee): not touched: fees\n\n## Decisions\n### D1: Where the limit is enforced\n- Choice: in renew()\n- Source: `src/loans/renew.ts:2`\n');
  write(f.ev('log.md'), ['2026-01-05T09:10Z start discover', '2026-01-05T09:30Z return discover: done', '2026-01-05T09:40Z start build', '2026-01-05T09:45Z start challenge', '2026-01-05T10:00Z return build: done', '2026-01-05T10:20Z return challenge: build', '2026-01-05T10:30Z return verify: stray', '2026-01-05T10:50Z start verify', '2026-01-05T11:00Z return verify: pass', 'a note that is not a log line'].join('\n') + '\n');
  write(f.ev('gate.json'), JSON.stringify({ runs: 7 }));
  write(f.ev('lane.md'), 'lane: pass\nFloor: critical\n');
  write(f.ev('words.json'), JSON.stringify({ states: { empty: { first: { count: 3 }, previous: null, latest: { count: 5 } } } }));
  for (const n of ['challenge-1.md', 'challenge-2.md', 'confirm-1.md', 'verify-1.md', 'read-1.md', 'read-2.md', 'read-notes.md']) write(f.ev(n), 'x');
  write(f.ev('audit.md'), 'Findings: 2 confirmed\n');
  write(f.ev('missed.md'), '- the count was off by one (already there before the change: a discover miss)\n- a label (reader)\n');
  const records = join(f.root, 'records.jsonl');
  writeFileSync(records, JSON.stringify({ project: 'library-app', ticket: 'EX-1' }) + '\n');
  assert.equal(run('record', f.t, '--records', records).status, 0);
  const line = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(
    [line.type, line.lane, line.screen, line.hotfix, line.started, line.first_delivered, line.accepted, line.agents, line.idle_minutes, line.gate_runs, line.lane_floor, line.brief_lane, line.brief_below_floor],
    ['bug', 'critical', 'none', false, '2026-01-05T09:00Z', '2026-01-05T15:00Z', '2026-01-07T09:00Z', 4, 50, 7, 'critical', 'standard', true],
  );
  assert.deepEqual(line.returns, { discover: 1, build: 1, challenge: 1, verify: 2 });
  assert.deepEqual([line.challenges, line.confirms, line.verifies, line.reads, line.reopened, line.cold_audit, line.discover_misses, line.profile], [2, 1, 1, 2, 1, 2, 1, null]);
  assert.deepEqual(line.rejections, { defect: 2, missed_purpose: 1 });
  assert.deepEqual(line.found, { fixed: 2, hotfix: 1, next: 1 });
  assert.deepEqual(line.words, { empty: { first: 3, latest: 5 } });
  assert.deepEqual([line.surface_lines, line.surface_not_touched, line.surface_kinds], [1, 1, ['renewal-count', 'fee']]);
  assert.deepEqual(line.decisions, [{ title: 'D1: Where the limit is enforced', choice: 'in renew()', source: '`src/loans/renew.ts:2`', reversible: false }]);
  f.done();
});

test('lane and gate read names git would quote: accents, quotes, spaces', () => {
  const f = ticket({ web: true });
  write(join(f.cat.path, 'src/loans/frais-é.ts'), 'x\n');
  write(join(f.cat.path, 'src/loans/a"b c.ts'), 'x\n');
  commit(f.cat.path, 'quoted names');
  const l = f.L();
  assert.match(l.stdout, /^Floor: critical$/m, l.stdout);
  assert.match(l.stdout, /^Boundary loans: catalog\/src\/loans\/a"b c\.ts, catalog\/src\/loans\/frais-é\.ts$/m);
  const r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(f.ran(), ['catalog-all', 'catalog-src src/loans/a"b c.ts src/loans/frais-é.ts', 'web-consumer'], 'the boundary entry is selected, and {files} passes each name exactly');
  const g = ticket({ web: true });
  write(join(g.cat.path, 'src/loans/tot"al.ts'), 'x\n');
  write(join(g.cat.path, 'src/loans/skip "me".test.ts'), "it.skip('later', () => {});\n");
  commit(g.cat.path, 'a quoted name alone');
  const s = g.G();
  assert.match(s.stdout, /3 web \| boundary:loans .*: pass/);
  assert.match(s.stdout, /catalog\/src\/loans\/skip "me"\.test\.ts:1: it\.skip/);
  f.done(); g.done();
});

test('lane --paths stops on a brief path it cannot place: no repo prefix, a repo label, a brace', () => {
  const f = ticket({ web: true });
  f.brief('critical', ['src/loans/renew.ts', 'catalog: src/loans/renew.ts', 'catalog/src/{loans,fees}/*.ts', 'web/src/pages/loan.tsx']);
  const r = f.L('--paths');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^lane: stop, cannot place 3 brief paths$/m);
  for (const p of ['src/loans/renew.ts', 'catalog:', 'catalog/src/{loans,fees}/*.ts']) assert.match(r.stdout, new RegExp(`- cannot place "${p.replace(/[.*{}/]/g, '\\$&')}"`));
  f.brief('critical', ['catalog', 'web/src/pages/loan.tsx']);
  f.state('', 'critical');
  const ok = f.L('--paths');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^Boundary loans: catalog$/m, 'a repo alone names all of it');
  f.done();
});

test('gate: an oracle word runs the definition folder\'s copy, never the branch\'s; HEAD behind its base fails --check', () => {
  const f = ticket({ web: true });
  write(join(f.root, 'catalog', 'scripts', 'oracle.mjs'), "console.log('canonical oracle in ' + process.cwd() + ' for ' + process.argv[3]);\n");
  write(join(f.cat.path, 'scripts/oracle.mjs'), "console.log('rigged'); process.exit(1);\n");
  commit(f.cat.path, 'the branch edits its oracle');
  f.defWith(['catalog | always | node ./catalog/scripts/oracle.mjs --stack {worktree}']);
  let r = f.G();
  assert.equal(r.status, 0, r.stdout);
  const log = readFileSync(f.ev('gate/1-catalog.log'), 'utf8');
  assert.match(log, new RegExp(`canonical oracle in ${realpathSync(f.root).replace(/[/.]/g, '\\$&')} for ${realpathSync(f.cat.path).replace(/[/.]/g, '\\$&')}`));
  assert.equal(f.G('--check').status, 0);
  write(join(f.root, 'catalog', 'scripts', 'oracle.mjs'), "console.log('canonical, stricter');\n");
  assert.equal(f.G('--check').status, 1, 'a changed oracle file is a changed entry');
  f.G();
  git(f.cat.path, 'checkout', '-q', 'main');
  write(join(f.cat.path, 'docs/more.md'), 'x\n');
  commit(f.cat.path, 'the base moves');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  r = f.G('--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fail, catalog: branch is behind its base \(HEAD does not contain main\)/);
  assert.equal(JSON.parse(readFileSync(f.ev('gate.json'), 'utf8')).contains.catalog, true);
  f.G();
  assert.equal(JSON.parse(readFileSync(f.ev('gate.json'), 'utf8')).contains.catalog, false, 'gate.json records it');
  git(f.cat.path, 'merge', '-q', '--no-edit', 'main');
  f.G();
  assert.equal(f.G('--check').status, 0);
  f.done();
});

test('gate leaves a build lane\'s worktree out: not compared, not refused when dirty', () => {
  const f = ticket();
  const side = join(f.root, 'side');
  git(f.cat.path, 'worktree', 'add', '-q', '-b', 'side', side, 'HEAD');
  write(join(side, 'src/loans/renew.ts'), 'scratch\n');
  f.state(`Lane side: ${side}`);
  edit(join(f.cat.path, 'src/fees/fee.ts'), '1', '2');
  commit(f.cat.path, 'the change');
  const r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.ev('gate.json'), 'utf8')).trees), ['catalog']);
  assert.deepEqual(f.ran(), ['catalog-all', 'catalog-src src/fees/fee.ts']);
  assert.equal(f.G('--check').status, 0);
  f.done();
});

test('gate --stop ends the command a killed gate run left', async () => {
  const f = ticket();
  write(join(f.cat.path, 'slow.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.GATE_TICKET + '/slow.pid', String(process.pid));\nsetTimeout(() => {}, 120000);\n");
  commit(f.cat.path, 'slow');
  f.defWith(['catalog | always | node slow.mjs']);
  edit(f.def, 'node gate.mjs]', 'node gate.mjs, node slow.mjs]');
  const p = spawn(process.execPath, [join(scripts, 'gate.mjs'), f.t, '--definition', f.def], { env, stdio: 'ignore' });
  const closed = new Promise((d) => p.on('close', d));
  for (let i = 0; i < 100 && !existsSync(join(f.t, 'slow.pid')); i++) await new Promise((d) => setTimeout(d, 100));
  const slow = +readFileSync(join(f.t, 'slow.pid'), 'utf8');
  p.kill('SIGKILL');
  await closed;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(slow));
  assert.match(run('gate', f.t, '--stop').stdout, /ended the command a killed run left/);
  for (let i = 0; i < 50 && alive(slow); i++) await new Promise((d) => setTimeout(d, 100));
  assert.equal(alive(slow), false);
  assert.equal(existsSync(f.ev('gate.run')), false);
  assert.equal(f.G('--check').status, 1, 'the killed entry left no pass');
  f.done();
}, { timeout: 60000 });

test('ready holds every row on a settled ticket and names the row that breaks', () => {
  const f = ticket({ web: true });
  edit(join(f.cat.path, 'src/loans/renew.ts'), '>=', '>');
  const head = commit(f.cat.path, 'the change');
  edit(join(f.w.path, 'src/pages/loan.tsx'), 'null', '1');
  const whead = commit(f.w.path, 'the page');
  f.state('Screen: touched', 'critical');
  edit(join(f.t, 'STATE.md'), 'Screen: none\n', '');
  f.brief('critical', ['catalog/src/loans/renew.ts', 'web/src/pages/loan.tsx']);
  assert.equal(f.G().status, 0);
  f.checks(goodChecks);
  assert.equal(f.C().status, 0);
  write(f.ev('verify-1.md'), `Commit: catalog@${head} web@${whead}\nVerdict: clean\n`);
  write(f.ev('read-1.md'), `Commit: web@${whead}\nVerdict: pass\n`);
  const R = () => { const r = f.R(); return { status: r.status, out: r.stdout, row: (n) => (r.stdout.match(new RegExp(`^\\| ${n} \\| (.*) \\|$`, 'm')) || [])[1] }; };
  let r = R();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^History: 1 runs, 0 failed$/m);
  assert.match(r.row('lane'), /^ok \(floor critical, lane critical\)/);
  // lane
  edit(join(f.t, 'STATE.md'), 'Risk lane: critical', 'Risk lane: standard');
  assert.match(R().row('lane'), /^fail: the floor is critical \(loans\) and the lane is standard/);
  assert.match(R().row('checks'), /^ok/, 'checks that exist are held off the critical lane too');
  edit(join(f.t, 'STATE.md'), 'Risk lane: standard', 'Risk lane: critical');
  // verify streams by boundary
  write(f.ev('verify-2.md'), `Boundary: loans\nCommit: catalog@${head} web@${whead}\nVerdict: fix: 1\n`);
  assert.match(R().row('verify'), /^fail: loans: verify-2\.md says Verdict: fix, not clean/);
  write(f.ev('confirm-1.md'), `Boundary: loans\nCommit: catalog@${head}\nVerdict: closed\n`);
  utimesSync(f.ev('confirm-1.md'), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
  assert.match(R().row('verify'), /^fail: loans: confirm-1\.md no Commit: line names web/);
  write(f.ev('confirm-1.md'), `Boundary: loans\nCommit: catalog@${head} web@${whead}\nVerdict: closed\n`);
  utimesSync(f.ev('confirm-1.md'), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
  assert.match(R().row('verify'), /^ok \(verify-1\.md says clean; loans: confirm-1\.md says closed\)/);
  // approval and the question sheet
  edit(join(f.t, 'BRIEF.md'), 'Undo: yes', 'Undo: no');
  assert.match(R().row('approval'), /^fail: BRIEF\.md says Undo: no and STATE\.md's Approval is "missing"/);
  f.state('Screen: touched\nApproval: asked 2026-01-05T10:00Z', 'critical');
  edit(join(f.t, 'STATE.md'), 'Screen: none\n', '');
  assert.match(R().row('approval'), /^fail/);
  write(join(f.t, 'QUESTIONS.md'), '1. Show the fee on the receipt?\n');
  const q = createHash('sha256').update(readFileSync(join(f.t, 'QUESTIONS.md'))).digest('hex').slice(0, 12);
  assert.match(R().row('questions'), new RegExp(`^fail: no "Question sheet: ${q}" in STATE\\.md`));
  f.state(`Screen: touched\nApproval: "go ahead", 2026-01-05T10:00Z\nQuestion sheet: ${q}`, 'critical');
  edit(join(f.t, 'STATE.md'), 'Screen: none\n', '');
  r = R();
  assert.equal(r.status, 0, r.out);
  edit(join(f.t, 'QUESTIONS.md'), 'receipt', 'invoice');
  assert.match(R().row('questions'), /^fail: QUESTIONS\.md changed since the person saw it/);
  edit(join(f.t, 'QUESTIONS.md'), 'invoice', 'receipt');
  // checks on the critical lane
  f.checks([]);
  assert.match(R().row('checks'), /^fail: the critical lane has no CHECKS\.json check due "before delivery"/);
  f.checks([{ ...goodChecks[0], expect: 'disagreements' }]);
  assert.match(R().row('checks'), /^fail: C1 changed since it ran/);
  f.checks(goodChecks);
  // a later screen change: the read is stale, the verify no longer stands, the gate is reached
  write(join(f.w.path, 'messages/en.json'), '{"left": "left"}\n');
  commit(f.w.path, 'words');
  r = R();
  assert.equal(r.status, 1);
  assert.match(r.row('read'), /^fail: read-1\.md: web\/messages\/en\.json changed since/);
  assert.match(r.row('verify'), /does not stand for HEAD/);
  assert.match(r.row('gate'), /^fail: 4 web \\\| always .*changed since it passed/);
  // the base moves
  git(f.cat.path, 'checkout', '-q', 'main');
  write(join(f.cat.path, 'docs/more.md'), 'x\n');
  commit(f.cat.path, 'the base moves');
  git(f.cat.path, 'checkout', '-q', 'fix/EX-1');
  assert.match(R().row('base'), /^fail: catalog: HEAD does not contain main/);
  assert.match(readFileSync(f.ev('ready.md'), 'utf8'), /^History: \d+ runs, \d+ failed$/m);
  const records = join(f.root, 'records.jsonl');
  run('record', f.t, '--records', records);
  const runs = +readFileSync(f.ev('ready.md'), 'utf8').match(/^History: (\d+) runs/m)[1], line = JSON.parse(readFileSync(records, 'utf8').trim());
  assert.equal(line.ready_fails, runs - 3, 'every run failed but the three that passed');
  f.done();
});

test('ready off the critical lane: no checks, no screen, no approval needed; a ticket with no verify stops', () => {
  const f = ticket();
  edit(join(f.cat.path, 'src/fees/fee.ts'), '1', '2');
  const head = commit(f.cat.path, 'the change');
  f.state('', 'direct');
  f.G();
  let r = f.R();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^\| verify \| fail: no evidence\/verify-<n>\.md \|$/m);
  assert.match(r.stdout, /^\| checks \| ok \(none\) \|$/m);
  assert.match(r.stdout, /^\| read \| ok \(none\) \|$/m);
  assert.match(r.stdout, /^\| lane \| fail: the floor is critical \(money\) and the lane is direct \|$/m);
  write(f.ev('verify-1.md'), `Boundary: money\nCommit: catalog@${head}\nVerdict: clean\n`);
  f.state('', 'critical');
  f.checks(goodChecks);
  f.C();
  r = f.R();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^\| verify \| ok \(money: verify-1\.md says clean\) \|$/m);
  f.done();
});

test('watch: a gate entry runs a consumer\'s checks in another repo without raising the lane; kept and rerun like a boundary; a kind may be in both maps', () => {
  const f = ticket({ web: true });
  const WATCH = 'watch:\n  contract: [catalog/src/api/**, "!catalog/src/api/**/*.md"]\n  loans: [catalog/docs/**]\n';
  const lines = ['web | watch:contract | node gate.mjs web-contract', 'catalog | watch:loans | node gate.mjs cat-docs'];
  write(join(f.cat.path, 'src/api/loans.dto.ts'), 'export type Loan = {};\n');
  commit(f.cat.path, 'a DTO');
  f.defWith([...lines, 'web | watch:nowhere | node gate.mjs x', 'web | watch:contract | node gate.mjs y {files}'], WATCH);
  let r = f.G();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /3 web \| watch:nowhere .*: fail, the definition's watch have no "nowhere"/);
  assert.match(r.stdout, /4 web \| watch:contract .*: fail, a watch entry can't use \{files\}/);
  f.defWith(lines, WATCH);
  r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(f.ran().slice(-1), ['web-contract'], 'selected by a file of the other repo, run in its own');
  assert.match(r.stdout, /Not selected: 2/);
  let l = f.L();
  assert.equal(l.status, 0, l.stdout);
  assert.match(l.stdout, /^Floor: none$/m);
  assert.match(l.stdout, /^Watch contract: catalog\/src\/api\/loans\.dto\.ts$/m);
  write(join(f.cat.path, 'docs/notes.md'), 'x\n');
  commit(f.cat.path, 'docs');
  r = f.G();
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(f.ran().slice(-1), ['cat-docs']);
  assert.match(r.stdout, /1 web \| watch:contract .*: kept/);
  l = f.L();
  assert.match(l.stdout, /^Watch loans: catalog\/docs\/notes\.md$/m, 'watch loans is its own list, not the boundary of that name');
  assert.match(l.stdout, /^Boundaries: none$/m);
  assert.match(l.stdout, /^Floor: none$/m);
  edit(join(f.cat.path, 'src/api/loans.dto.ts'), '{}', '{ id: string }');
  commit(f.cat.path, 'the DTO changes');
  r = f.G();
  assert.deepEqual(f.ran().slice(-1), ['web-contract']);
  assert.match(r.stdout, /2 catalog \| watch:loans .*: kept/);
  assert.equal(f.G('--check').status, 0);
  f.done();
});

test('lane: a path in a watch list and a boundary raises the floor by the boundary; with no watch list it says Watch: none', () => {
  const f = ticket();
  edit(join(f.cat.path, 'src/fees/fee.ts'), '1', '2');
  commit(f.cat.path, 'fees');
  let l = f.L();
  assert.match(l.stdout, /^Watch: none$/m);
  f.defWith(GATE_LINES, 'watch:\n  fees: [catalog/src/fees/**]\n');
  l = f.L();
  assert.match(l.stdout, /^Watch fees: catalog\/src\/fees\/fee\.ts$/m);
  assert.match(l.stdout, /^Boundary money: catalog\/src\/fees\/fee\.ts$/m);
  assert.match(l.stdout, /^Floor: critical$/m);
  f.done();
});
