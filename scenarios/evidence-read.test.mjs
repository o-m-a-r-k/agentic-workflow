import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check } from '../hooks/guard-evidence.mjs';
import { commitIn, criteriaFile, ok, singleRepoProject, wf } from './helpers.mjs';

// I-16, named failure: harmless Bash commands were refused because their text (a commit message, an improvement
// description, a search pattern) named the evidence folder, and the refusal neither said what matched nor how to avoid
// it; agents split commands or switched tools by trial. The guard still decides on the raw text and never parses shell
// (0.1.16 and 0.1.17 did, and opened parser differentials). The refusal now names the matched token and says how to
// avoid it, and `wf evidence list|show` reads the evidence without the folder name in any shell command.

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'guard-evidence.mjs');
const run = (command, cwd = '/p') => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, tool_input: { command } }), encoding: 'utf8' });

test('I-16: the refusal names the matched token and says how to avoid it; nothing new passes', () => {
  const r = run('git commit -m "docs: reads of .wf-evidence/ go through the Read tool"');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /matched "\.wf-evidence\/"/);
  assert.match(r.stderr, /say "the evidence folder" instead of its name in commit messages, echo text and grep patterns/);
  assert.match(r.stderr, /read evidence with the Read tool or `wf evidence list` \/ `wf evidence show <path>`/);
  assert.match(r.stderr, /run each `wf` command as one plain invocation/);
  assert.match(run('cat /p/.wf-evidence/attempts/A/ledger.jsonl').stderr, /matched "\/p\/\.wf-evidence\/attempts\/A\/ledger\.jsonl"/);
  assert.match(run('cp /tmp/x .wf-ev*/a').stderr, /matched "\.wf-ev\*\/a"/);
  assert.match(run('cat {.wf-,}evidence/a').stderr, /matched "\{\.wf-,\}evidence\/a"/);
  assert.match(run('ls', '/p/.wf-evidence/attempts/A').stderr, /runs inside the evidence folder \(working directory \/p\/\.wf-evidence\/attempts\/A\)/);
  // Prose still refuses: no text argument is exempt.
  for (const c of ['git commit -m "mention .wf-evidence"', "echo '.wf-evidence'", "grep -rn 'wf-evidence' engine", "wf improve add --title 'x .wf-evidence'"]) assert.ok(check({ cwd: '/p', tool_input: { command: c } }), c);
  // Named failure (0.4.5, found while redoing I-16): `wf run --lease X -- <command>` executes its command but passed as
  // one plain `wf` invocation, so a command on the evidence went through. It is judged like any other command now.
  for (const c of ['wf run --lease docker -- rm -rf .wf-evidence', 'wf run --lease x -- cp /tmp/a .wf-evidence/a']) assert.ok(check({ cwd: '/p', tool_input: { command: c } }), c);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf run --lease docker -- docker compose up --wait' } }), null);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf evidence show gate/run-1/unit/output.log --attempt ENG-1.1' } }), null);
});

// Second security review of 0.4.5: an agent can give `wf discovered defer` a terminal through a pseudo-terminal wrapper.
// The guard refuses a wrapper in a command that mentions it: a speed bump, not a defence (documented in the trust model).
test('0.4.5: a pty wrapper around `wf discovered defer` is refused; the plain command and unrelated script use are not', () => {
  for (const c of [
    "script -q -e -c 'wf discovered defer D1 --reason x' /dev/null", 'script -q /dev/null wf discovered defer D1 --reason x', "expect -c 'spawn wf discovered defer D1 --reason x'",
    'unbuffer wf discovered defer D1 --reason x', 'echo D1 | socat - EXEC:"wf discovered defer D1 --reason x",pty', "python3 -c 'import pty; pty.spawn([\"wf\",\"discovered\",\"defer\",\"D1\"])'",
    'tmux new -d "wf discovered defer D1 --reason x"', 'ssh -tt localhost wf discovered defer D1 --reason x',
  ]) {
    const r = run(c);
    assert.equal(r.status, 2, c);
    assert.match(r.stderr, /refused: `wf discovered defer` and `wf discovered close` run as one plain command, never through a wrapper or shell indirection \(matched "[^"]+"\)/, c);
  }
  // Third review of 0.4.5: raw matching only, fail closed. `discovered defer` or `discovered close` (in any spelling the
  // fold leaves: quoted parts, other words between) with any wrapper or shell-indirection token anywhere is refused.
  for (const c of [
    "bash -c 'wf discovered defer D1 --reason x'", "sh -c 'wf discovered close D1 --deferred --quote x'", "eval 'wf discovered defer D1'", 'echo d2YgZGlzY292ZXJlZCBkZWZlcg== | base64 -d | sh; wf discovered defer D1',
    "python3 -c 'import os; os.system(\"wf discovered defer D1\")'", "node -e 'require(\"child_process\").execSync(\"wf discovered defer D1\")'", 'echo D1 | xargs wf discovered defer',
    'wf discovered close D1 --deferred --quote "$(cat /tmp/q)"', 'wf discovered close D1 --deferred --quote `cat /tmp/q`', "wf discovered 'defer' D1 --reason x; script -q /dev/null true",
    "screen -dm wf discovered defer D1", 'wf discovered close D1 --deferred --quote x | tee /tmp/o',
  ]) assert.match(run(c).stderr, /refused: `wf discovered defer` and `wf discovered close` run as one plain command, never through a wrapper or shell indirection/, c);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf discovered defer D1 --reason x' } }), null);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf discovered close D1 --fixed abc123' } }), null);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'wf discovered close D1 --deferred --quote "D1: defer it to the next sprint"' } }), null);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'script -q /dev/null npm test' } }), null);
  assert.equal(check({ cwd: '/p', tool_input: { command: 'npm run script' } }), null);
});

test('I-16: `wf evidence list` lists an attempt\'s evidence by kind; `wf evidence show` prints a text file, never an image or a path outside it', () => {
  const steps = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf one > shots/home.png && echo step-output-line', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('evidence-read', { gate: { steps } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-760', '--lane', 'quick', '--owner', 'o', '--json'])).json();
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'q\n' });
  ok(wf(root, ['gate', '--attempt', e.id]));

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
  assert.match(wf(root, ['evidence', 'show', shot.path, '--attempt', e.id]).err, /is an image: copy it out with `wf export screenshots --gate --attempt ENG-760\.1/);
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

test('I-16: role texts and skills read evidence with `wf evidence` and say how to avoid the guard', () => {
  const read = (p) => fs.readFileSync(path.resolve(import.meta.dirname, '..', p), 'utf8');
  for (const p of ['templates/agents/reviewer.md', 'templates/agents/implementer.md', 'skills/work/SKILL.md']) {
    assert.match(read(p), /wf evidence list/, p);
    assert.match(read(p), /the evidence folder/, p);
  }
});
