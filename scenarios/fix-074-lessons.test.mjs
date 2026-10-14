// 0.7.4, stream 3 (lessons, review division, native patch grammar). Each test names the failure it reproduces and fails on 0.7.3.
//   I-49   a generated lesson failed the repository's own Prettier check (layout, precedence, recur/set/move)
//   I-99   a lesson recorded after an accepted tree was repaired went untracked into the main checkout; the first fix's
//          edge: an implementer left open at acceptance made a later lesson move the tree off the accepted one
//   I-112  a lesson for a repository the attempt did not admit went untracked into that repository's main checkout
//   I-96   documentation files flipped the review division to a single reviewer
//   I-108  a valid native patch with an empty context line was refused as evidence
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { amendFile, closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, tmp, toAccepted, wf, write, yaml } from './helpers.mjs';
import { patchTargets } from '../engine/hosts/codex-tool.mjs';
import { YAML } from '../engine/util.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [{ id: 'unit', repo: 'app', run: 'true', inputs: ['src/**'] }];
const add = (root, args, opts) => wf(root, ['lesson', 'add', ...args], opts);
const lessonFile = (repoRoot, id) => path.join(repoRoot, '.workflow', 'lessons', `${id}.yaml`);

// ---- An engine stamped with a given version (obligations follow the version an attempt was admitted under, D7) ----
// Copies the plugin into a temporary folder with that version in its package.json: identical code, a different admission
// stamp. `wf(root, args, { bin })` then runs that copy.
const copies = new Map();
function engineAt(version) {
  if (copies.has(version)) return copies.get(version);
  const dir = tmp(`engine-${version}`);
  for (const d of ['bin', 'engine', 'templates', 'docs', 'skills', 'adapters', 'hooks']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  copies.set(version, path.join(dir, 'bin', 'wf'));
  return copies.get(version);
}

function multiRepoProject(name, { api = {}, web = {} } = {}) {
  const base = tmp(name);
  const root = path.join(base, 'ws');
  fs.mkdirSync(root);
  const cfg = { version: 1, enabled: true, name, adapterRepo: 'api', repos: [{ name: 'api', path: 'api', base: 'main' }, { name: 'web', path: 'web', base: 'main' }], lanes: ['quick', 'standard'], gate: { steps: [{ id: 'api-unit', repo: 'api', run: 'true', inputs: ['src/**'] }, { id: 'web-unit', repo: 'web', run: 'true', inputs: ['src/**'] }] } };
  makeRepo(path.join(root, 'api'), { '.workflow/project.yaml': yaml(cfg), 'src/a.txt': 'a\n', ...api });
  makeRepo(path.join(root, 'web'), { 'src/w.txt': 'w\n', 'src/table.tsx': 'x\n', ...web });
  fs.symlinkSync(path.join('api', '.workflow'), path.join(root, '.workflow'));
  return { base, root };
}

const lessonArgs = (title, what = 'a thing went wrong', extra = []) => ['--title', title, '--what', what, '--cause', 'test', '--mechanism', 'doc', ...extra];

// ======================================================================================================================
// I-96: documentation and provenance files do not decide the review division
// ======================================================================================================================

// Two separable flows of 24 product files each, plus `docs` documentation files that no flow maps.
function twoFlows({ docs = 0, perFlow = 24, docLines = 500, docDir = 'docs/verification', docExt = 'md' } = {}) {
  const product = ['alpha', 'beta'].flatMap((feature) => Array.from({ length: perFlow }, (_, i) => `${feature}/${i}.ts`));
  const documentation = Array.from({ length: docs }, (_, i) => `${docDir}/record-${i}.${docExt}`);
  const flows = ['alpha', 'beta'].map((id) => ({ id, flow: `use ${id}`, failure: 'show retry', query: id }));
  const bundle = { changed: { app: [...product, ...documentation] }, impactMap: { survey: { flows }, derived: { outside: [] } } };
  const results = Object.fromEntries(flows.map((f) => [f.id, { files: product.filter((p) => p.startsWith(f.id)).map((p) => `app:${p}`) }]));
  const weights = Object.fromEntries([...product.map((p) => [`app:${p}`, 2]), ...documentation.map((d) => [`app:${d}`, docLines])]);
  return { bundle, results, weights, product, documentation };
}

// Named failure (I-96): 12 documentation files of 500 lines in a 48-file change of two separable flows were read as product code.
// No flow maps them, so they were unmapped integration work (cost 6000 of 6096, over the 3048 threshold) and a division into two
// scopes became one reviewer; 10 such files already did, and 49 also tripped the file-count threshold.
test('I-96: documentation files neither weigh on the division nor count toward its thresholds, and the integration reviewer still owns them', async () => {
  const { divideReview, reviewDivisionSummary, validateDivision } = await import('../engine/review-groups.mjs');
  for (const docs of [10, 12, 49]) {
    const { bundle, results, weights } = twoFlows({ docs });
    const plan = divideReview(bundle, results, { weights });
    assert.equal(plan.mode, 'parallel', `${docs} documentation files: ${plan.reason}`);
    assert.deepEqual(plan.slices.map((s) => s.files.length), [24, 24]);
    assert.equal(plan.documentation.length, docs);
    assert.ok(plan.documentation.every((f) => plan.integration.files.includes(f)), 'integration is handed every documentation file');
    assert.equal(plan.integration.files.length, docs);
    assert.equal(plan.integration.estimatedCost, 0, 'and they cost it nothing');
    assert.equal(plan.diagnostics.integration.unmapped.files, 0, 'they are not unmapped integration code');
    assert.equal(plan.diagnostics.changedFiles, 48);
    assert.equal(plan.diagnostics.documentationFiles, docs);
    assert.equal(plan.files.length, 48 + docs, 'the plan still lists every changed file');
    assert.match(reviewDivisionSummary(plan), new RegExp(`48 changed files \\(${docs} documentation files more, handed to integration and outside the estimate\\)`));
    validateDivision(plan, bundle);
  }
  // The same change without them, and a plan that lies about a documentation file, for the check that owns them.
  const { bundle, results, weights } = twoFlows({ docs: 12 });
  const plan = divideReview(bundle, results, { weights });
  const forged = structuredClone(plan);
  forged.documentation.push('app:alpha/0.ts');
  assert.throws(() => validateDivision(forged, bundle), /documentation file that is not a changed file owned by integration/);
  const lost = structuredClone(plan);
  lost.integration.files = lost.integration.files.filter((f) => f !== plan.documentation[0]);
  assert.throws(() => validateDivision(lost, bundle), /every changed file exactly once|documentation file/);
});

test('I-96: the 40-file threshold counts product files; a flow\'s query that returns a documentation file does not make it a flow file', async () => {
  const { divideReview } = await import('../engine/review-groups.mjs');
  const small = twoFlows({ perFlow: 15, docs: 20 });
  const single = divideReview(small.bundle, small.results, { weights: small.weights });
  assert.equal(single.mode, 'single', '30 product files and 20 documentation files are not 50 files to divide');
  assert.equal(single.diagnostics.reasonCode, 'below-minimum-files');
  assert.match(single.reason, /only 30 changed product files; retain one reviewer below 40/);
  assert.equal(single.diagnostics.documentationFiles, 20);
  assert.equal(single.integration.files.length, 50, 'a single reviewer is handed all of them');
  const wide = twoFlows({ docs: 3 });
  wide.results.alpha.files.push('app:docs/verification/record-0.md');
  const plan = divideReview(wide.bundle, wide.results, { weights: wide.weights });
  assert.equal(plan.mode, 'parallel');
  assert.ok(plan.flows.every((f) => f.files.every((file) => !file.includes('docs/'))), 'documentation is not a flow file');
  assert.deepEqual(plan.integration.interfaces, [], 'and a changed documentation file in a query\'s results is no outside consumer');
});

test('I-96: what counts as documentation: prose and docs folders by name, and the adapter\'s docsOnly files through its matcher', async () => {
  const { divideReview } = await import('../engine/review-groups.mjs');
  const { documentationMatcher, isDocumentationFile } = await import('../engine/impact.mjs');
  for (const file of ['README.md', 'docs/a.json', 'packages/x/docs/img/capture.png', 'guide.mdx', 'notes.rst', 'manual.adoc', 'Doc/a.txt', 'LICENSE', 'sub/NOTICE']) assert.ok(isDocumentationFile(file), file);
  for (const file of ['src/a.ts', 'src/docs.ts', 'src/documents/a.ts', 'requirements.txt', 'robots.txt', 'app/evidence/log.ts', 'src/readme.ts', 'a.md.ts']) assert.ok(!isDocumentationFile(file), file);
  const matcher = documentationMatcher({ repos: [{ name: 'app', packages: [{ path: '.', docsOnly: ['evidence/**'] }] }, { name: 'api', packages: [{ path: 'services/billing', docsOnly: ['fixtures/**/*.json'] }] }] });
  assert.ok(matcher('app', 'evidence/run-1.json') && matcher('app', 'README.md'));
  assert.ok(!matcher('app', 'src/evidence.ts'));
  assert.ok(matcher('api', 'services/billing/fixtures/a/b.json') && !matcher('api', 'services/billing/src/a.json') && !matcher('api', 'fixtures/a.json'));
  assert.ok(!matcher('other', 'evidence/run-1.json'));
  // The caller passes the matcher; the division then leaves those files out as well.
  const { bundle, results, weights } = twoFlows({ docs: 12, docDir: 'evidence', docExt: 'json' });
  assert.equal(divideReview(bundle, results, { weights }).mode, 'single', 'without the adapter\'s notion these are product files');
  const plan = divideReview(bundle, results, { weights, documentation: matcher });
  assert.equal(plan.mode, 'parallel');
  assert.equal(plan.documentation.length, 12);
});

// The default handoff, with no caller-supplied notion: 12 documentation files of 500 lines in the diff, next to two flows of 25 files.
function flowFiles() {
  const files = { 'shared.ts': 'alpha beta\n', 'unmapped.ts': 'common\n' };
  for (const feature of ['alpha', 'beta']) for (let i = 0; i < 24; i++) files[`${feature}/${i}.ts`] = `${feature}\n`;
  return files;
}
test('I-96: an ordinary reviewer handoff still divides a large separable change that also commits a documentation package', () => {
  const files = flowFiles();
  const p = singleRepoProject('fix074-docs-division', { strategy: { enabled: false }, gate: { steps: [] } }, files);
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  const queries = ['alpha', 'beta'].map((id) => ({ id, pattern: id, kind: 'literal', paths: ['alpha/**', 'beta/**', 'shared.ts'], hits: 25 }));
  const doc = { survey: { queries, patterns: [{ id: 'P', query: 'alpha', hits: 25 }] }, expect: { files: 2, rounds: 2, minutes: 60 }, criteria: [{ id: 'C1', text: 'flows remain coherent' }], plan: { anchors: ['src/a.txt'], tests: { run: ['flow-test'] } },
    impact: { changes: queries.map((q) => ({ id: q.id, element: q.id, kind: 'symbol', cites: ['C1'], covers: ['P'], consumers: { query: q.id, hits: 25 }, flows: [{ flow: `use ${q.id}`, failure: 'retry', query: q.id, hits: 25 }], contracts: [], suites: [{ suite: 'flow-test', query: q.id, hits: 25 }] })) } };
  ok(wf(p.root, ['plan', '--file', closureFile(p.base, doc), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  const change = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `${text}changed\n`]));
  for (let i = 0; i < 12; i++) change[`docs/verification/capture-${i}.md`] = 'a recorded http result line\n'.repeat(500);
  commitIn(e.repos.app.worktree, change);
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'integration', '--attempt', e.id, '--json'])).json();
  assert.equal(h.division.mode, 'parallel', h.division.reason);
  assert.equal(h.members.length, 3);
  assert.equal(h.division.documentation.length, 12);
  const integration = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.ok(integration.primaryFiles.includes('app:docs/verification/capture-0.md'), 'the integration reviewer is handed the documentation');
  assert.ok(integration.primaryFiles.includes('app:shared.ts'));
  for (const member of h.members.filter((m) => m !== h.members.at(-1))) assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(member.file ?? member.bundle ?? h.bundle, 'utf8')).primaryFiles ?? []).includes('docs/verification'), 'a scope is not handed them');
});

// Named failure (I-96, same class): the symbol scan of the final diff took declarations out of documentation files, so a code block
// in a guide put `renderGuide` among the symbols whose callers every reviewer was asked about.
test('I-96: declarations in documentation files are not symbols of the final diff', () => {
  const { base, root } = singleRepoProject('fix074-docs-symbols', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-420', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, {
    'src/table.js': 'export function renderTable(rows) {\n  return rows;\n}\n',
    'docs/guide.md': '# Guide\n\n```js\nexport function renderGuide(rows) {\n  return rows;\n}\nclass GuideHelper {}\n```\n',
    'docs/manifest.json': '{ "note": "export function renderManifest() {}" }\n',
  });
  ok(wf(root, ['gate', '--reason', 'scenario: gate mechanics, outside the order of work', '--attempt', e.id]));
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'rev-1', '--attempt', e.id])).out;
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/m)[1], 'utf8'));
  assert.ok(bundle.impactMap.derived.symbols.includes('renderTable'), 'product declarations are still scanned');
  for (const symbol of ['renderGuide', 'GuideHelper', 'renderManifest']) assert.ok(!bundle.impactMap.derived.symbols.includes(symbol), `${symbol} is documentation`);
  assert.deepEqual(Object.keys(bundle.impactMap.derived.declarationOrigins), ['renderTable']);
});

// ======================================================================================================================
// I-108: every native patch Codex itself applies is parsed; a malformed payload is refused as malformed
// ======================================================================================================================

const P = (...lines) => lines.join('\n');
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const update = (...body) => P(BEGIN, '*** Update File: a.txt', ...body, END);

// The grammar Codex applies, taken from the installed Codex itself (`codex --codex-run-as-apply-patch`, codex-cli 0.162.1, each
// row run on a three-file folder): the target list the guard must read, or `null` for a patch Codex refuses to parse.
// WF_TEST_CODEX names a Codex binary (or `1` for the one on PATH): the next test then runs every row through it.
const PATCHES = [
  // Update hunks: what an update line may be
  ['an empty context line (I-108)', update('@@', ' one', '', '-two', '+TWO'), ['a.txt']],
  ['an empty context line in a CRLF patch', update('@@', ' one', '', '-two', '+TWO').replace(/\n/g, '\r\n'), ['a.txt']],
  ['empty lines between two chunks', update('@@', '-one', '+ONE', '', '', '@@', '-three', '+THREE'), ['a.txt']],
  ['a line of spaces in a chunk', update('@@', ' one', '   ', '-two', '+TWO'), ['a.txt']],
  ['a first chunk with no @@ line', update(' two', '-three', '+THREE'), ['a.txt']],
  ['a first chunk of an empty line', update('', '@@', '-three', '+THREE'), ['a.txt']],
  ['@@ with a context text, and @@ with a trailing space', update('@@ three', '-four', '+FOUR', '@@ ', '-one', '+ONE'), ['a.txt']],
  ['a plus line that starts with plus signs', update('@@', ' two', '-three', '+++x'), ['a.txt']],
  ['an End of File marker, and blank lines after it', update('@@', '-five', '+FIVE', '*** End of File', '', '\t', '   '), ['a.txt']],
  ['an End of File marker with trailing spaces', update('@@', '-five', '+FIVE', '*** End of File  '), ['a.txt']],
  ['an End of File marker before the first chunk is skipped', update('*** End of File', '@@', '-five', '+FIVE'), ['a.txt']],
  ['a context line that reads like the end of the patch', update('@@', ' *** End Patch', '-three', '+THREE'), ['a.txt']],
  ['a context-only hunk', update('@@', ' one'), ['a.txt']],
  ['a move, with trailing spaces on its line', P(BEGIN, '*** Update File: a.txt', '*** Move to: d.txt  ', '@@', '-three', '+THREE', END), ['a.txt', 'd.txt']],
  ['a move and an empty context line', P(BEGIN, '*** Update File: a.txt', '*** Move to: sub/d.txt', '@@', ' one', '', '-two', '+TWO', END), ['a.txt', 'sub/d.txt']],
  ['an update followed by a hunk header with no blank between', P(BEGIN, '*** Update File: a.txt', '@@', '-three', '+THREE', '*** Delete File: c.txt', END), ['a.txt', 'c.txt']],
  ['an empty line before the next header is an empty context line', P(BEGIN, '*** Update File: a.txt', '@@', '-three', '+THREE', '', '*** Update File: b.txt', '@@', '-x', '+X', END), ['a.txt', 'b.txt']],
  // Hunk headers
  ['an Add with empty + lines', P(BEGIN, '*** Add File: n.txt', '+hello', '+', '+world', END), ['n.txt']],
  ['an Add with no lines', P(BEGIN, '*** Add File: n.txt', END), ['n.txt']],
  ['an Add, a Delete and an Update', P(BEGIN, '*** Add File: n.txt', '+a', '*** Delete File: c.txt', '*** Update File: b.txt', '@@', '-x', '+X', END), ['n.txt', 'c.txt', 'b.txt']],
  ['a header with white space around it after an Add', P(BEGIN, '*** Add File: n.txt', '+hello', '  *** Delete File: b.txt  ', END), ['n.txt', 'b.txt']],
  ['paths with spaces and non-ASCII letters', P(BEGIN, '*** Add File: dir/n n.txt', '+x', '*** Add File: ü/ö.txt', '+x', END), ['dir/n n.txt', 'ü/ö.txt']],
  // The boundaries
  ['white space around the whole patch and its boundary lines', `  \n\n${BEGIN}  \n*** Delete File: c.txt\n  ${END}\n\n`, ['c.txt']],
  ['a heredoc around the patch', P("<<'EOF'", BEGIN, '*** Delete File: c.txt', END, 'EOF'), ['c.txt']],
  ['a heredoc, bare and double-quoted', P('<<EOF', BEGIN, '*** Delete File: c.txt', END, 'EOF'), ['c.txt']],
  ['a stray second End Patch line after blank lines', P(BEGIN, '*** Delete File: c.txt', END, '', END), ['c.txt']],
  // Refused by Codex's own parser, so malformed here
  ['text that is not a patch', 'rm -rf x', null],
  ['no Begin Patch line', P('*** Delete File: c.txt', END), null],
  ['no End Patch line', P(BEGIN, '*** Delete File: c.txt'), null],
  ['text after End Patch', P(BEGIN, '*** Delete File: c.txt', END, 'trailing'), null],
  ['a hunk after a stray End Patch', P(BEGIN, '*** Delete File: c.txt', END, '*** Delete File: b.txt', END), null],
  ['two stray End Patch lines', P(BEGIN, '*** Delete File: c.txt', END, END, END), null],
  ['a second Begin Patch line', P(BEGIN, BEGIN, '*** Delete File: c.txt', END), null],
  ['a heredoc with another tag, or a command around it', P("<<'PATCH'", BEGIN, '*** Delete File: c.txt', END, 'PATCH'), null],
  ['a command around the heredoc', P("apply_patch <<'EOF'", BEGIN, '*** Delete File: c.txt', END, 'EOF'), null],
  ['no hunks', P(BEGIN, END), null],
  ['an empty line before the first hunk', P(BEGIN, '', '*** Delete File: c.txt', END), null],
  ['an empty line after a Delete', P(BEGIN, '*** Delete File: c.txt', '', '*** Delete File: b.txt', END), null],
  ['an empty line inside an Add', P(BEGIN, '*** Add File: n.txt', '+hello', '', '+world', END), null],
  ['a line after a Delete', P(BEGIN, '*** Delete File: c.txt', '-x', END), null],
  ['a header with no space after the colon, or in lower case', P(BEGIN, '*** Delete File:c.txt', END), null],
  ['a lower-case header after a chunk', update('@@', '-three', '+THREE', '*** add file: n.txt', '+x'), null],
  ['an update with no chunk', update(), null],
  ['an update of only @@', update('@@'), null],
  ['an @@ chunk with nothing in it before the next header', P(BEGIN, '*** Update File: a.txt', '@@', '*** Delete File: c.txt', END), null],
  ['an End of File marker right after @@', update('@@', '*** End of File'), null],
  ['@@ glued to text', update('@@x', '-three', '+THREE'), null],
  ['a line that starts any other way in a chunk', update('@@', '-three', '+THREE', 'foo'), null],
  ['a "No newline" line', update('@@', '-five', '+FIVE', '\\ No newline at end of file'), null],
  ['a tab-only line between chunks', update('@@', '-one', '+ONE', '\t', '@@', '-three', '+THREE'), null],
  ['a second chunk with no @@ line', update('@@', '-one', '+ONE', '*** End of File', '+x'), null],
  ['a second End of File marker', update('@@', '-five', '+FIVE', '*** End of File', '*** End of File'), null],
  ['a move that is not the line after the header', update('@@', '-three', '+THREE', '*** Move to: d.txt'), null],
  ['a move to nowhere', P(BEGIN, '*** Update File: a.txt', '*** Move to: ', '@@', '-three', '+THREE', END), null],
  ['a move with no chunk', P(BEGIN, '*** Update File: a.txt', '*** Move to: d.txt', END), null],
];

const targetsOf = (patch) => {
  try {
    return patchTargets(patch);
  } catch {
    return null;
  }
};

// Named failure (I-108): the parser accepted an update line only when it began with a space, `+` or `-`, so a hunk with an empty
// context line threw "unknown patch line", and the guard refused a patch that touched no evidence as one that did.
test('I-108: every patch Codex applies yields its targets, and a patch Codex refuses to parse stays malformed', () => {
  for (const [name, patch, expected] of PATCHES) assert.deepEqual(targetsOf(patch), expected, name);
});

const CODEX = (() => {
  const wanted = process.env.WF_TEST_CODEX;
  if (!wanted) return null;
  return wanted === '1' ? 'codex' : wanted;
})();
test('I-108: the same patches through the installed Codex agree (WF_TEST_CODEX=1, or the path of a Codex binary; skipped without it)', { skip: CODEX ? false : 'WF_TEST_CODEX is not set' }, () => {
  const run = (patch) => {
    const dir = tmp('codex-patch');
    for (const [file, text] of Object.entries({ 'a.txt': 'one\n\ntwo\nthree\nfour\nfive\n', 'b.txt': 'x\ny\n', 'c.txt': 'cc\n' })) write(dir, file, text);
    const snapshot = () => Object.fromEntries(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'n.txt', 'sub/d.txt', 'dir/n n.txt', 'ü/ö.txt'].filter((f) => fs.existsSync(path.join(dir, f))).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const before = snapshot();
    const r = spawnSync(CODEX, ['--codex-run-as-apply-patch', patch], { cwd: dir, encoding: 'utf8' });
    const after = snapshot();
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
    fs.rmSync(dir, { recursive: true, force: true });
    const first = (r.stderr || '').split('\n')[0];
    return { applied: r.status === 0, parsed: r.status === 0 || (!/^Invalid patch/.test(first) && !/^No files were modified/.test(first)), touched };
  };
  for (const [name, patch, expected] of PATCHES) {
    const codex = run(patch);
    assert.equal(codex.parsed, expected !== null, `${name}: Codex ${codex.parsed ? 'parses' : 'refuses'} it`);
    if (codex.applied) for (const file of codex.touched) assert.ok(expected.includes(file), `${name}: Codex wrote ${file}`);
  }
});

// The guard on the ground: the patch of the report (an update with an empty context line, to an ordinary file) passes; the same
// shape aimed at the evidence folder, or a payload that cannot be read, does not.
test('I-108: the guard passes a valid patch with an empty context line, refuses one that touches the evidence, and calls an unreadable payload malformed', async () => {
  const { check } = await import('../hooks/guard-evidence.mjs');
  const root = tmp('fix074-guard');
  const judge = (command, tool_name = 'apply_patch') => check({ tool_name, cwd: root, tool_input: { command } });
  const scratch = P(BEGIN, '*** Update File: notes/scratch.txt', '@@', ' heading', '', '-old', '+new', END);
  assert.equal(judge(scratch), null);
  assert.match(judge(P(BEGIN, '*** Update File: .wf-evidence/ledger', '@@', ' heading', '', '-old', '+new', END)), /\.wf-evidence\/ledger is workflow evidence/);
  assert.match(judge(P(BEGIN, '*** Update File: notes/a.txt', '*** Move to: .wf-evidence/x', '@@', ' one', '', '-two', '+TWO', END)), /is workflow evidence/);
  assert.match(judge(P(BEGIN, '*** Delete File: notes/a.txt', '', '*** Update File: .wf-evidence/x', '@@', '-a', '+b', END)), /malformed native file-edit payload/, 'a blank line after a Delete is not a patch Codex reads');
  assert.equal(judge(scratch, 'Bash'), null, 'a shell command is never read as a patch');
  for (const bad of ['not a patch', P(BEGIN, '*** Update File: a.txt', '@@', '-a', '+b', 'oops', END), P(BEGIN, '*** Add File: a.txt', '+a')]) assert.equal(judge(bad), 'malformed native file-edit payload', bad);
});

// Named failure (I-108): the refusal for an unreadable payload said "this targets the workflow evidence folder", so the agent
// looked for an evidence path in a patch that had none. It now says the payload is malformed and what a patch is.
test('I-108: the hook refuses a malformed payload with a message that says so, and an evidence target with the evidence message', () => {
  const hook = path.join(REPO, 'hooks', 'guard-evidence.mjs');
  const run = (command, cwd = tmp('fix074-hook')) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'apply_patch', cwd, tool_input: { command } }), encoding: 'utf8' });
  const malformed = run(P(BEGIN, '*** Update File: a.txt', '@@', '-a', '+b', 'oops', END));
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /this file-edit payload is malformed, so its file targets cannot be read/);
  assert.match(malformed.stderr, /not about the workflow evidence/);
  assert.match(malformed.stderr, /`\*\*\* Begin Patch`[\s\S]*`\*\*\* End Patch` as the last line/);
  assert.doesNotMatch(malformed.stderr, /this targets the workflow evidence folder/);
  const evidence = run(P(BEGIN, '*** Add File: .wf-evidence/x', '+a', END));
  assert.equal(evidence.status, 2);
  assert.match(evidence.stderr, /this targets the workflow evidence folder, which only `wf` writes/);
  assert.equal(run(P(BEGIN, '*** Update File: a.txt', '@@', ' one', '', '-a', '+b', END)).status, 0, 'the patch of the report passes');
});
