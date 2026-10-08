// Named failures: I-53 unsupported blind-review reads; missing frozen rule documents;
// silent symbol truncation, ambiguous origins and textual matches presented as resolved consumers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitIn, criteriaFile, makeRepo, ok, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';
import { codexEntries } from '../engine/codex-agent.mjs';
import { CODEX_DOCUMENT_READ_INSTRUCTIONS, reviewDocumentProblems, unreadDocs } from '../engine/rules.mjs';
import { deriveFromDiff, impactCheckProblems } from '../engine/impact.mjs';
import { loadConfig } from '../engine/config.mjs';

function ready(name, review, files = {}) {
  const p = singleRepoProject(name, { review, gate: { steps: [] } }, files);
  const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
  ok(wf(p.root, ['plan', '--file', criteriaFile(p.base), '--attempt', e.id]));
  ok(wf(p.root, ['handoff', 'implementer', '--agent', 'impl', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'changed\n' });
  return { ...p, id: e.id, wt: e.repos.app.worktree };
}

test('I-53: fresh Codex bundle teaches a full-file read whose actual output earns rule and skill receipts', () => {
  const p = ready('read-protocol', { rules: [{ id: 'policy', paths: ['src/**'], read: ['docs/policy.md'] }] }, { 'docs/policy.md': '# Policy\nRead all of this.\n' });
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'reviewer', '--runtime', 'codex', '--attempt', p.id, '--json'])).json();
  const bundle = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.ok(bundle.instructions.includes(CODEX_DOCUMENT_READ_INSTRUCTIONS));
  assert.match(fs.readFileSync(new URL('../templates/agents/reviewer.md', import.meta.url), 'utf8'), /nodeRepl\.write\(await fs\.readFile/);
  const file = bundle.rules[0].read[0];
  const code = bundle.instructions.match(/```js\n([\s\S]*?)\n```/)[1].replace('"/exact/handed/document.md"', JSON.stringify(file));
  const executed = spawnSync(process.execPath, ['--input-type=module', '-e', 'const nodeRepl = {write: text => process.stdout.write(text)};\n' + code], { encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, fs.readFileSync(file, 'utf8'));
  const transcript = path.join(p.base, 'node-read.jsonl');
  const check = (program, output) => {
    fs.writeFileSync(transcript, [
      { type: 'function_call', namespace: 'mcp__node_repl', name: 'js', call_id: 'read', arguments: JSON.stringify({ code: program }) },
      { type: 'function_call_output', call_id: 'read', output: JSON.stringify({ content: [{ type: 'text', text: output }], isError: false }) },
    ].map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n'));
    return unreadDocs(codexEntries(transcript).entries, bundle.rules, [{ name: 'required-skill', file }]);
  };
  assert.deepEqual(check(code, executed.stdout), []);
  for (const program of [`for (const file of [${JSON.stringify(file)}]) { nodeRepl.write(await fs.readFile(file,'utf8')); }`, `nodeRepl.write({text:await fs.readFile(${JSON.stringify(file)},'utf8')});`, `nodeRepl.write((await fs.readFile(${JSON.stringify(file)},'utf8')).slice(0,10));`]) assert.equal(check(program, executed.stdout).length, 2);
  assert.equal(check(code, executed.stdout.slice(0, 10)).length, 2);
});

test('review readiness: all/partly missing applicable base documents refuse; ticket copies never replace them', () => {
  for (const partial of [false, true]) {
    const p = ready('missing-policy', { rules: [{ id: 'policy', paths: ['src/**'], read: ['docs/missing.md', ...(partial ? ['docs/present.md'] : [])] }] }, { 'docs/present.md': '# Present\n' });
    commitIn(p.wt, { 'docs/missing.md': '# Added only by the ticket\n' });
    const result = wf(p.root, ['handoff', 'reviewer', '--agent', 'reviewer', '--attempt', p.id]);
    assert.equal(result.code, 75);
    assert.match(result.err, /required document\(s\) unavailable at the frozen base: docs\/missing.md/);
    assert.equal(state(p.root, p.id).handoffs.filter(h => h.role === 'reviewer').length, 0);
  }
  const p = ready('unrelated-policy', { rules: [{ id: 'missing', paths: ['other/**'], read: ['docs/missing.md'] }, { id: 'present', paths: ['src/**'], read: ['docs/present.md'] }] }, { 'docs/present.md': '# Present\n' });
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'reviewer', '--attempt', p.id, '--json'])).json();
  assert.deepEqual(JSON.parse(fs.readFileSync(h.bundle)).rules.map(r => r.id), ['present']);
});

test('document preflight reads exact regular UTF-8 files and aggregates unavailable inputs without crediting aliases', () => {
  const dir = tmp('document-preflight'), good = path.join(dir, 'good.md'), alias = path.join(dir, 'alias.md'), hard = path.join(dir, 'hard.md');
  fs.writeFileSync(good, '# Good\n');
  assert.deepEqual(reviewDocumentProblems({ skills: [{ name: 'good', file: good }] }), []);
  fs.symlinkSync(good, alias);
  fs.linkSync(good, hard);
  assert.equal(reviewDocumentProblems({ skills: [{ name: 'symlink', file: alias }, { name: 'hardlink', file: hard }, { name: 'missing', file: path.join(dir, 'missing.md') }] }).length, 3);
  fs.unlinkSync(hard);
  fs.writeFileSync(good, Buffer.from([0xff]));
  assert.equal(reviewDocumentProblems({ skills: [{ name: 'bad-utf8', file: good }] }).length, 1);
  fs.writeFileSync(good, '');
  assert.equal(reviewDocumentProblems({ invariants: good }).length, 1);
});

test('impact metadata: 201 extracted symbols disclose the cap; same names retain all origins and comments stay textual', () => {
  const root = tmp('textual-impact');
  const cfg = { version: 1, enabled: true, name: 'textual-impact', adapterRepo: 'one', repos: ['one', 'two'].map(name => ({ name, path: name, base: 'main' })), gate: { steps: [] } };
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name);
    makeRepo(dir, { 'src/source.ts': 'export function SharedName() { return 1; }\n', 'docs/comment.md': '// SharedName appears only in prose\n', ...(name === 'one' ? { '.workflow/project.yaml': yaml(cfg) } : {}) });
  }
  fs.symlinkSync(path.join(root, 'one/.workflow'), path.join(root, '.workflow'));
  const e = ok(wf(root, ['entry', '--lane', 'quick', '--repos', 'one,two', '--json'])).json();
  for (const name of ['one', 'two']) commitIn(e.repos[name].worktree, { 'src/source.ts': 'export function SharedName() { return 2; }\n' + (name === 'one' ? Array.from({ length: 200 }, (_, i) => `export const Symbol${i} = ${i};\n`).join('') : '') });
  const derived = deriveFromDiff(root, cfg, state(root, e.id));
  assert.equal(derived.mode, 'textual');
  assert.equal(derived.structuralCoverage, 'unsupported');
  assert.equal(derived.resolvedReferences, false);
  assert.deepEqual([derived.totalSymbols, derived.analyzedSymbols, derived.symbolsTruncated, derived.incomplete], [201, 200, true, true]);
  assert.deepEqual(derived.declarationOrigins.SharedName, ['one:src/source.ts', 'two:src/source.ts']);
  const comment = derived.outside.find(o => o.file === 'one:docs/comment.md');
  assert.equal(comment.matchKind, 'textual');
  assert.equal(comment.originAmbiguous, true);
  assert.deepEqual(comment.declarationOrigins, derived.declarationOrigins.SharedName);
  assert.equal(derived.truncated, false, 'symbol truncation is distinct from outside-match truncation');
  // Older frozen bundles and closure fields remain usable; metadata adds no new mandatory record.
  assert.deepEqual(impactCheckProblems({ inventory: [], derived: { outside: [] } }, { impactChecked: { queries: [], sampled: [], derived: [] }, findings: [] }, {}), []);
});

test('impact origin tracking selects the actual old/new paths for deleted and renamed declarations', () => {
  for (const rename of [false, true]) {
    const padding = '// unchanged context\n'.repeat(40);
    const p = singleRepoProject('impact-path-sides', { gate: { steps: [] } }, {
      'src/original.ts': 'export function SharedName() { return 1; }\n' + padding,
      'src/other.ts': 'export function SharedName() { return 1; }\n',
      'docs/name.md': 'SharedName textual mention\n',
    });
    const e = ok(wf(p.root, ['entry', '--lane', 'quick', '--json'])).json();
    const wt = e.repos.app.worktree;
    if (rename) fs.renameSync(path.join(wt, 'src/original.ts'), path.join(wt, 'src/renamed.ts'));
    else fs.unlinkSync(path.join(wt, 'src/original.ts'));
    commitIn(wt, { 'src/other.ts': 'export function SharedName() { return 2; }\n', ...(rename ? { 'src/renamed.ts': 'export function SharedName() { return 2; }\n' + padding } : {}) });
    const derived = deriveFromDiff(p.root, loadConfig(p.root), state(p.root, e.id));
    const origins = derived.declarationOrigins.SharedName;
    assert.ok(origins.includes('app:src/original.ts'), 'removed declaration comes from the old diff side');
    assert.ok(origins.includes('app:src/other.ts'));
    if (rename) assert.ok(origins.includes('app:src/renamed.ts'), 'added declaration comes from the new diff side');
    assert.equal(origins.some(origin => origin.endsWith(':/dev/null')), false);
    for (const hit of derived.outside) assert.equal(hit.declaredIn.endsWith(':/dev/null'), false);
  }
});
