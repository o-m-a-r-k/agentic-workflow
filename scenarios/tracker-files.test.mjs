// The built-in files tracker (`ticketing: { tracker: files, via: files }`): tickets are `tickets/<id>.md` in the project,
// and the engine reads and writes them itself. Ids are an allowlist checked before any file is touched, and nothing is read
// or written through a link. The flow through it (start, status, comment, close) is in scenarios/e2e-push.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { filesTracker } from '../adapters/tracker/files.mjs';
import { tmp } from './plain-repo.mjs';

const ticket = (id, extra = '') => `---\nid: ${id}\ntitle: Show the new text\nstatus: Todo\nlabels: [ui]\n${extra}---\nThe home screen shows the new text.\n`;
const MARK = 'wf:OK-1.1:stage-1';

function project() {
  const root = path.join(tmp('tracker-files'), 'proj');
  fs.mkdirSync(path.join(root, 'tickets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tickets', 'OK-1.md'), ticket('OK-1'));
  return root;
}
const snapshot = (dir) => {
  const all = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (all.push(`${path.join(d, e.name)} ${e.isFile() ? fs.readFileSync(path.join(d, e.name), 'utf8') : ''}`), e.isDirectory() && walk(path.join(d, e.name))));
  walk(dir);
  return all.sort();
};

test('files tracker attack: traversal and malformed ids are refused by name before any file is touched', async () => {
  const root = project();
  const t = filesTracker(root);
  const before = snapshot(path.dirname(root));
  for (const id of ['../x', '..', 'a/b', '/abs', '.hidden', '-flag', 'a\u0000b', 'x'.repeat(200), 'O​K-1', 'ОK-1', 'a\\b', 'trail.', 'a..b']) {
    await assert.rejects(t.setStatus(id, 'Done'), /invalid ticket id/, JSON.stringify(id));
    await assert.rejects(t.comment(id, { body: `x ${MARK}`, marker: MARK }), /invalid ticket id/, JSON.stringify(id));
    assert.equal(await t.normalise(id), null, JSON.stringify(id));
  }
  assert.deepEqual(snapshot(path.dirname(root)), before, 'nothing was created or changed, inside or outside the folder');
});

test('files tracker: a ticket file or a tickets folder that is a link is never read or written through', async () => {
  const root = project();
  const victim = tmp('tickets-victim');
  fs.writeFileSync(path.join(victim, 'LINK-1.md'), ticket('LINK-1'));
  fs.symlinkSync(path.join(victim, 'LINK-1.md'), path.join(root, 'tickets', 'LINK-1.md'));
  const t = filesTracker(root);
  await assert.rejects(t.read('LINK-1'), /not a regular file; not read or written through/);
  await assert.rejects(t.setStatus('LINK-1', 'Done'), /not a regular file/);
  await assert.rejects(t.comment('LINK-1', { body: `x ${MARK}`, marker: MARK }), /not a regular file/);
  assert.equal(fs.readFileSync(path.join(victim, 'LINK-1.md'), 'utf8'), ticket('LINK-1'), 'the linked ticket was not rewritten');
  // The whole folder as a link to another place.
  const elsewhere = tmp('tickets-elsewhere');
  fs.writeFileSync(path.join(elsewhere, 'OK-2.md'), ticket('OK-2'));
  fs.rmSync(path.join(root, 'tickets'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, 'tickets'));
  await assert.rejects(t.read('OK-2'), /is a symbolic link; tickets are not read or written through it/);
  await assert.rejects(t.create({ title: 'Found', body: `x ${MARK}`, marker: MARK }), /symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), ['OK-2.md'], 'nothing written through the linked folder');
});

test('files tracker: a ticket without frontmatter, or whose id differs from its file name, is refused, never guessed', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, 'tickets', 'NO-1.md'), 'no frontmatter\n');
  fs.writeFileSync(path.join(root, 'tickets', 'OK-3.md'), ticket('OK-4'));
  const t = filesTracker(root);
  await assert.rejects(t.read('NO-1'), /has no YAML frontmatter/);
  await assert.rejects(t.setStatus('OK-3', 'Done'), /its id `OK-4` differs from its file name/);
  assert.match(fs.readFileSync(path.join(root, 'tickets', 'OK-3.md'), 'utf8'), /^status: Todo$/m);
  // A comment needs its marker in the body (the engine searches for it before writing again).
  await assert.rejects(t.comment('OK-1', { body: 'no marker', marker: MARK }), /must carry the marker/);
});
