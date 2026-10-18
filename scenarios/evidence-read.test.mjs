import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commitIn, criteriaFile, ok, OUT_OF_ORDER, singleRepoProject, wf } from './helpers.mjs';

// I-16, named failure: a refused evidence edit neither said what matched nor how to avoid it; agents switched tools by
// trial. 0.7.0: the guard judges file targets and the working directory only (shell text is not scanned), and the refusal
// names the target and the supported routes: `wf evidence list|show` reads the evidence without the folder name.

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'guard-evidence.mjs');
const run = (tool_input, cwd = '/p', tool_name = 'Bash') => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, tool_name, tool_input }), encoding: 'utf8' });

test('I-16: the refusal names the target and says how to read or change evidence; a shell mention is not refused', () => {
  const r = run({ file_path: '/p/.wf-evidence/attempts/A/ledger.jsonl' }, '/p', 'Edit');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\(\/p\/\.wf-evidence\/attempts\/A\/ledger\.jsonl is workflow evidence\)/);
  assert.match(r.stderr, /Read evidence with the Read tool or `wf evidence list` \/ `wf evidence show <path>`/);
  assert.match(r.stderr, /change recorded state through a `wf` command/);
  assert.match(run({ command: 'ls' }, '/p/.wf-evidence/attempts/A').stderr, /runs inside the evidence folder \(working directory \/p\/\.wf-evidence\/attempts\/A\)/);
  // Prose, glob and `wf run` text pass: only a file target and a working directory are judged.
  for (const c of ['git commit -m "mention .wf-evidence"', "echo '.wf-evidence'", "grep -rn 'wf-evidence' engine", "wf improve add --title 'x .wf-evidence'", 'wf run --lease docker -- rm -rf .wf-evidence', 'wf evidence show gate/run-1/unit/output.log --attempt ENG-1.1']) assert.equal(run({ command: c }).status, 0, c);
});

test('I-16: `wf evidence list` lists an attempt\'s evidence by kind; `wf evidence show` prints a text file, never an image or a path outside it', () => {
  const steps = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png && echo step-output-line', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('evidence-read', { gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-760', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));

  const list = ok(wf(root, ['evidence', 'list', '--attempt', e.id, '--json'])).json();
  const kinds = new Set(list.files.map((f) => f.kind));
  for (const k of ['ledger', 'plan', 'handoff', 'gate log', 'screenshot']) assert.ok(kinds.has(k), `${k} in ${[...kinds].join(', ')}`);
  const log = list.files.find((f) => f.kind === 'gate log' && /ui/.test(f.path));
  const shot = list.files.find((f) => f.kind === 'screenshot');
  assert.ok(log && shot);
  assert.ok(path.isAbsolute(log.file) && log.file.endsWith(log.path));
  const human = ok(wf(root, ['evidence', 'list', '--attempt', e.id])).out;
  assert.match(human, /^gate log \(\d+\):\n {2}\S+/m);
  assert.match(human, /screenshots: copy them out with `wf export screenshots --gate --attempt ENG-760\.1 --to <folder>` and view the copies/);
  assert.match(ok(wf(root, ['evidence', 'list', '--attempt', e.id, '--kind', 'ledger'])).out, /ledger\.jsonl/);

  assert.match(ok(wf(root, ['evidence', 'show', log.path, '--attempt', e.id])).out, /step-output-line/);
  assert.match(ok(wf(root, ['evidence', 'show', 'ledger.jsonl', '--attempt', e.id])).out, /"type":"admitted"/);
  // 0.7.30 (I-198): an image is sent to the export of the run it belongs to.
  const runOfShot = /^gate\/([^/]+)\//.exec(shot.path)[1];
  assert.match(wf(root, ['evidence', 'show', shot.path, '--attempt', e.id]).err, new RegExp(`is an image: copy it out with \`wf export screenshots --run ${runOfShot} --attempt ENG-760\\.1`));
  for (const bad of ['../../x', '/etc/hosts', path.join(root, 'src', 'a.txt'), 'nope.txt']) assert.notEqual(wf(root, ['evidence', 'show', bad, '--attempt', e.id]).code, 0, bad);
  assert.match(wf(root, ['evidence', 'show', '../../x', '--attempt', e.id]).err, /a path inside this attempt's evidence, relative to it/);
  assert.match(wf(root, ['evidence', 'show', '--attempt', e.id]).err, /usage: wf evidence show <path>/);
  // The attempt folder replaced by a link: nothing is listed or read through it (the open-time verification may refuse
  // first; either way nothing is read).
  const real = path.join(root, '.wf-evidence', 'attempts', e.id);
  const moved = `${real}-moved`;
  fs.renameSync(real, moved);
  fs.symlinkSync(moved, real);
  assert.notEqual(wf(root, ['evidence', 'list', '--attempt', e.id]).code, 0);
  assert.notEqual(wf(root, ['evidence', 'show', 'ledger.jsonl', '--attempt', e.id]).code, 0);
  fs.unlinkSync(real);
  fs.renameSync(moved, real);
  // Nothing was written.
  assert.equal(ok(wf(root, ['verify', '--attempt', e.id])).code, 0);
  assert.ok(!fs.existsSync(path.join(root, 'nope.txt')));
});

// Review of b5b2183: `show` refuses a file that is a link, and reads at most 4 MiB of a large file.
test('I-16: `wf evidence show` refuses a link and cuts a large file at 4 MiB', async () => {
  const steps = [{ id: 'big', repo: 'app', run: "head -c 5000000 /dev/zero | tr '\\000' a; echo" }];
  const { base, root } = singleRepoProject('evidence-show-limits', { gate: { steps } });
  const e = ok(wf(root, ['entry', '--item', 'ENG-770', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id]));
  const log = ok(wf(root, ['evidence', 'list', '--attempt', e.id, '--json'])).json().files.find((f) => f.kind === 'gate log' && f.size > 4 * 1024 * 1024);
  assert.ok(log, 'the step log is over 4 MiB');
  const r = ok(wf(root, ['evidence', 'show', log.path, '--attempt', e.id]));
  assert.match(r.out, /… \(\d+ B; the first part only: read the rest with the Read tool on /);
  assert.ok(r.out.length < 4 * 1024 * 1024 + 4096 && r.out.length >= 4 * 1024 * 1024, `printed ${r.out.length} characters`);
  // A link planted in the attempt's evidence. Through the CLI, the open-time evidence verification (openState) refuses
  // it first, before `wf evidence show` runs; showEvidence's own link check is exercised directly below.
  const secret = path.join(base, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET-OUTSIDE\n');
  const linkDir = path.join(root, '.wf-evidence', 'attempts', e.id);
  fs.chmodSync(linkDir, 0o755);
  fs.symlinkSync(secret, path.join(linkDir, 'link.txt'));
  const shown = wf(root, ['evidence', 'show', 'link.txt', '--attempt', e.id]);
  assert.notEqual(shown.code, 0);
  assert.match(shown.err, /does not match what wf recorded[\s\S]*link\.txt: symlink/);
  assert.doesNotMatch(shown.out, /SECRET-OUTSIDE/);
  // showEvidence itself (no open-time verification in front of it) refuses the link and reads nothing through it.
  const { showEvidence } = await import('../engine/evidence-read.mjs');
  assert.throws(() => showEvidence(root, { id: e.id }, 'link.txt'), /link\.txt is not a regular file; nothing is read through it/);
});

test('I-45: native roles can read an absolute handed path only inside their selected attempt', () => {
  const { root } = singleRepoProject('native-evidence-path');
  const a = ok(wf(root, ['entry', '--item', 'ENG-84', '--json'])).json().id;
  const h = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', a, '--json'])).json();
  const read = ok(wf(root, ['evidence', 'show', h.bundle, '--attempt', a]));
  assert.equal(JSON.parse(read.out).agent, 'p');
  const page=ok(wf(root,['evidence','show',h.bundle,'--attempt',a,'--offset','0','--length','64','--json'])).json();
  assert.equal(page.offset,0); assert.equal(page.bytes,64); assert.equal(page.nextOffset,64);
  assert.equal(page.text,read.out.slice(0,64)); assert.equal(page.remaining,page.size-64);
  assert.match(page.sha256,/^[a-f0-9]{64}$/);
  const structured=ok(wf(root,['evidence','inspect',h.bundle,'--attempt',a,'--pointer','/agent'])).json();
  assert.equal(structured.text,'p');assert.equal(structured.documentReadCredit,false);
  assert.equal(structured.sha256,page.sha256);
  assert.equal(wf(root,['evidence','inspect',h.bundle,'--attempt',a,'--pointer','/constructor']).code,75);
  const b = ok(wf(root, ['entry', '--item', 'ENG-85', '--json'])).json().id;
  assert.equal(wf(root, ['evidence', 'show', h.bundle, '--attempt', b]).code, 75);
  assert.equal(wf(root, ['evidence', 'show', '/etc/hosts', '--attempt', a]).code, 75);
  assert.equal(wf(root, ['evidence', 'show', h.bundle + '/../01-planner.json', '--attempt', a]).code, 75);
});
