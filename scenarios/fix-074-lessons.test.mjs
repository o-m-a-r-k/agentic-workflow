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
