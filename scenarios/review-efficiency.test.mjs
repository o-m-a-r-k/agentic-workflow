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
import { roleInstructions } from '../engine/onboard.mjs';

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
  const code = [...bundle.instructions.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]).find(program => program.includes('/exact/handed/document.md')).replace('"/exact/handed/document.md"', JSON.stringify(file));
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

test('I-58: large handoffs use bounded structured inspection without earning document receipts', () => {
  const p = ready('large-handoff', { rules: [{ id: 'policy', paths: ['src/**'], read: ['docs/policy.md'] }] }, { 'docs/policy.md': '# Required policy\nRead the whole document.\n' });
  const h = ok(wf(p.root, ['handoff', 'reviewer', '--agent', 'reviewer', '--runtime', 'codex', '--attempt', p.id, '--json'])).json();
  const handed = JSON.parse(fs.readFileSync(h.bundle, 'utf8'));
  assert.match(handed.instructions, /handoff JSON is structured review input/i);
  assert.match(handed.instructions, /inventory is navigation, not completed inspection/i);
  assert.match(handed.instructions, /every section/i);
  assert.match(handed.instructions, /consecutive chunks/i);
  assert.match(handed.instructions, /earns no document-read credit/i);
  const bootstrap = roleInstructions(loadConfig(p.root), 'reviewer', 'review');
  assert.match(bootstrap, /handoff JSON is structured review input/i);
  assert.match(bootstrap, /inventory is navigation, not completed inspection/i);
  assert.match(bootstrap, /not to printing the JSON handoff in one output/i);
  const file = path.join(p.base, 'large-handoff.json');
  const large = { ...handed, criteria: Array.from({ length: 600 }, (_, i) => ({ id: `C${i}`, text: `criterion-${i}` })), impactMap: { inventory: Array.from({ length: 600 }, (_, i) => ({ id: `entry-${i}` })) }, oversized: '0123456789'.repeat(300000) };
  fs.writeFileSync(file, JSON.stringify(large));
  assert.ok(fs.statSync(file).size > 2.75 * 1024 * 1024);
  const examples = [...handed.instructions.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
  const parse = examples.find(code => code.includes('JSON.parse(')).replace('"/exact/handed/handoff.json"', JSON.stringify(file));
  const view = examples.find(code => code.includes('function view('));
  const exercised = `const outputs=[]; const nodeRepl={write:value=>outputs.push(value)};\n${parse}\n${view}\n` +
    `const boundedView=view; view=(value,from,to)=>{const page=boundedView(value,from,to); if(Buffer.byteLength(JSON.stringify(page))>12000) throw Error('unbounded output'); return page;}; const recovered={}; for(const section of Object.keys(bundle)){ const value=bundle[section]; if(value!==null&&typeof value==='object'&&!Array.isArray(value)){ recovered[section]=Object.fromEntries(Object.keys(value).flatMap((_,i)=>view(value,i,i+1).items)); } else if(Array.isArray(value)){ recovered[section]=value.flatMap((_,i)=>view(value,i,i+1).items); } else if(typeof value==='string'){ let text=''; for(let from=0;from<value.length;from+=2000) text+=view(value,from,from+2000).items; recovered[section]=text; } else recovered[section]=value; } process.stdout.write(JSON.stringify({navigation:outputs[0],recovered,nestedFirst:view(bundle.impactMap.inventory,0,1),nestedLast:view(bundle.impactMap.inventory,599,600)}));`;
  const executed = spawnSync(process.execPath, ['--input-type=module', '-e', exercised], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(executed.status, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  assert.deepEqual(result.navigation.map(row => row.section), Object.keys(large));
  assert.deepEqual(result.recovered, large);
  assert.deepEqual(result.nestedFirst, { from: 0, to: 1, total: 600, items: [{ id: 'entry-0' }] });
  assert.deepEqual(result.nestedLast, { from: 599, to: 600, total: 600, items: [{ id: 'entry-599' }] });
  const transcript = path.join(p.base, 'bundle-inspection.jsonl');
  const receipts = (program, output) => {
    fs.writeFileSync(transcript, [
      { type: 'function_call', namespace: 'mcp__node_repl', name: 'js', call_id: 'read', arguments: JSON.stringify({ code: program }) },
      { type: 'function_call_output', call_id: 'read', output: JSON.stringify({ content: [{ type: 'text', text: output }], isError: false }) },
    ].map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n'));
    return unreadDocs(codexEntries(transcript).entries, handed.rules, [{ name: 'required-skill', file: handed.rules[0].read[0] }]);
  };
  assert.equal(receipts(parse, JSON.stringify(result.navigation)).length, 2);
  const documentCode = examples.find(code => code.includes('/exact/handed/document.md')).replace('"/exact/handed/document.md"', JSON.stringify(handed.rules[0].read[0]));
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', 'const nodeRepl={write:text=>process.stdout.write(text)};\n' + documentCode], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(receipts(documentCode, read.stdout), []);
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
