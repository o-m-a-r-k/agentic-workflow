import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, makeRepo, ok, sh, singleRepoProject, state, summaryFile, tmp, wf, yaml } from './helpers.mjs';

// 0.4.0: tickets as files in the repo. The engine does every tracker action and reads the files back.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const ticket = (id, extra = {}) => `---\n${yaml({ id, title: 'Show the new text', status: 'Todo', labels: ['ui'], ...extra }).trim()}\n---\nThe home screen shows the new text.\n`;

function project(name, files = {}) {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
  return singleRepoProject(name, { tracker: { kind: 'files', statuses, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', 'tickets/ENG-400.md': ticket('ENG-400'), ...files });
}

test('files tracker: admission reads the ticket, status and the delivered comment are written to it, screenshots copied with captions, all read back by the engine', () => {
  const { base, root } = project('tracker-files');
  const e = ok(wf(root, ['entry', '--item', 'ENG-400', '--owner', 'o', '--json'])).json();
  let s = state(root, e.id);
  assert.deepEqual(s.tracker.done.map((t) => [t.event, t.provenance]), [['admitted', 'engine (tracker API)']]);
  const file = path.join(root, 'tickets', 'ENG-400.md');
  assert.match(fs.readFileSync(file, 'utf8'), /^status: In Progress$/m, 'the engine set the status');
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)]));
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  const r = ok(wf(root, ['shown', '--file', shown, '--attempt', e.id]));
  assert.match(r.out, /tracker: delivered performed through the API and read back; attempt closed/);
  s = state(root, e.id);
  assert.equal(s.phase, 'done');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^status: Ready for UAT$/m);
  assert.match(text, /<!-- wf:comment id=c-1 at=\S+ -->\nENG-400 is ready for UAT\.\n\nThe home screen now shows the new text\.[\s\S]*!\[home\.png\]\(ENG-400\/attachments\/home\.png\)\n<!-- \/wf:comment -->/);
  const listed = JSON.parse(fs.readFileSync(path.join(root, 'tickets', 'ENG-400', 'attachments', 'attachments.json'), 'utf8'));
  assert.deepEqual(listed.map((a) => [a.title, a.subtitle, a.sha256]), [['home.png', 'Home screen with the new text', g.steps[0].artifacts[0].sha256]]);
  assert.equal(fs.readFileSync(path.join(root, 'tickets', 'ENG-400', 'attachments', 'home.png'), 'utf8'), 'png');
});

test('files tracker: a ticket or tickets folder that is a link, a bad id, or a ticket without frontmatter is refused; nothing is written through a link', () => {
  const victim = tmp('tickets-victim');
  fs.writeFileSync(path.join(victim, 'ENG-401.md'), ticket('ENG-401'));
  const before = fs.readFileSync(path.join(victim, 'ENG-401.md'), 'utf8');
  const { root } = project('tracker-files-links');
  fs.symlinkSync(path.join(victim, 'ENG-401.md'), path.join(root, 'tickets', 'ENG-401.md'));
  const e = ok(wf(root, ['entry', '--item', 'ENG-401', '--owner', 'o', '--json'])).json();
  const out = ok(wf(root, ['status', '--attempt', e.id])).out;
  assert.equal(state(root, e.id).tracker.done.length, 0, 'not recorded');
  assert.ok(state(root, e.id).tracker.pending.length, 'the actions stay pending');
  assert.equal(fs.readFileSync(path.join(victim, 'ENG-401.md'), 'utf8'), before, 'the linked ticket was not rewritten');
  assert.ok(out);
  const sync = ok(wf(root, ['tracker', 'sync', '--attempt', e.id])).out;
  assert.match(sync, /tracker files \(admitted\) failed: no ticket ENG-401: .* a link or not a regular file/);
  fs.writeFileSync(path.join(root, 'tickets', 'ENG-402.md'), 'no frontmatter\n');
  const e2 = ok(wf(root, ['entry', '--item', 'ENG-402', '--owner', 'o', '--json'])).json();
  assert.match(ok(wf(root, ['tracker', 'sync', '--attempt', e2.id])).out, /has no YAML frontmatter/);
});

test('files tracker: doctor states what is verifiable and refuses a linked tickets folder', () => {
  const { root } = project('tracker-files-doctor');
  assert.match(ok(wf(root, ['doctor', '--no-steps'])).out, /tracker files\/files\n {4}verifiable: the engine does every action on the ticket files in the repo and reads them back/);
  const elsewhere = tmp('tickets-elsewhere');
  fs.rmSync(path.join(root, 'tickets'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, 'tickets'));
  const d = wf(root, ['doctor', '--no-steps']);
  assert.notEqual(d.code, 0);
  assert.match(d.out, /tickets is a symlink; tickets are not read or written through it/);
});

test('tracker kinds and vias are validated together', () => {
  const bad = (tracker, re) => {
    const { root } = singleRepoProject(`tracker-cfg-${Math.random().toString(36).slice(2, 6)}`, { tracker });
    const r = wf(root, ['doctor', '--no-steps']);
    assert.match(`${r.out}${r.err}`, re);
  };
  bad({ kind: 'files', via: 'api' }, /`tracker\.via` for files is one of files, not `api`/);
  bad({ kind: 'github', via: 'cli' }, /`tracker\.repo` names the GitHub repository holding the issues: `owner\/name`/);
  bad({ kind: 'jira' }, /`tracker\.kind` is one of linear, github, files, none/);
  bad({ kind: 'linear', via: 'files' }, /`tracker\.via` for linear is one of api, connector/);
});

test('wf init: a tickets/ folder drafts the files tracker; a GitHub origin is named with the choices, not assumed', () => {
  const base = tmp('init-tracker');
  const a = path.join(base, 'with-tickets');
  makeRepo(a, { 'package.json': JSON.stringify({ name: 'a', scripts: { test: 'node --test' } }), 'tickets/T-1.md': ticket('T-1') });
  const ia = ok(wf(a, ['init']));
  assert.match(ia.out, /note: tracker: tickets\/ holds frontmatter tickets, drafted as `tracker\.kind: files`/);
  assert.match(fs.readFileSync(path.join(a, '.workflow', 'project.yaml'), 'utf8'), /tracker:\n {2}kind: files\n {2}via: files\n {2}folder: tickets/);
  assert.match(wf(a, ['doctor', '--no-steps']).out, /tracker files\/files\n {4}verifiable:/, 'doctor reads the draft (it is not committed yet)');
  const b = path.join(base, 'on-github');
  makeRepo(b, { 'package.json': JSON.stringify({ name: 'b', scripts: { test: 'node --test' } }) });
  sh(b, 'git remote set-url origin git@github.com:acme/app.git');
  const ib = ok(wf(b, ['init']));
  assert.match(ib.out, /note: tracker: origin is GitHub \(acme\/app\)\. If its issues are your tasks: `tracker: \{ kind: github, repo: acme\/app, via: cli \}`/);
  assert.match(fs.readFileSync(path.join(b, '.workflow', 'project.yaml'), 'utf8'), /tracker:\n {2}kind: none/);
});
