import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, summaryFile, wf, write } from './helpers.mjs';

// 0.7.27 (I-189), named failure (field): a project's tracker adapter posts the delivered comment as a real page comment and the
// screenshots as attachments, listed on follow-up comments of their own; the ticket has no inline images. The engine rendered
// every screenshot as `![title](assetUrl)` with an `{assetUrl:title}` placeholder, and refused any readback whose comment did
// not embed an image per screenshot, so the delivery could never be recorded without a workaround. An adapter now declares that
// its screenshots are attachments (`screenshots: 'attachments'`: the comment lists each file with its caption in plain words;
// `'attachments-only'`: the comment lists nothing): the delivery check wants each screenshot among the readback's attachments as
// an uploaded file, and no embedded image. Every other adapter embeds, as before.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];

// A tracker whose tickets live in a file of its own; attachments are listed on a comment of their own, three to a comment at most.
const adapter = (mode, { subtitle = false, link = false } = {}) => `import fs from 'node:fs';
import path from 'node:path';
const file = (root, item) => path.join(root, 'notes-db', item + '.json');
const read = (root, item) => (fs.existsSync(file(root, item)) ? JSON.parse(fs.readFileSync(file(root, item), 'utf8')) : { identifier: item, title: 'Show the text', description: 'The home screen shows the new text.', status: 'Todo', labels: ['ui'], comments: [], attachments: [] });
export default {
  via: 'files',
  ${mode ? `screenshots: ${JSON.stringify(mode)},` : ''}
  operations: { readIssue: 'read the ticket', setStatus: 'set the status', comment: 'post a page comment', attach: 'attach each file and list it on a comment of its own', readBack: 'read the ticket back' },
  isUpload: (a) => a.stored === true,
  files: {
    async perform({ root, item, actions }) {
      const t = read(root, item);
      const listed = [];
      for (const a of actions) {
        if (a.op === 'setStatus') t.status = a.status;
        else if (a.op === 'comment' && a.body) t.comments.push({ id: 'c' + (t.comments.length + 1), body: a.body, createdAt: new Date().toISOString() });
        else if (a.op === 'attach') for (const f of a.files) {
          t.attachments.push({ id: 'a' + (t.attachments.length + 1), title: f.name, filename: f.name, stored: ${link ? 'false' : 'true'}, ${subtitle ? 'subtitle: f.caption,' : ''} });
          listed.push(f);
        }
      }
      for (let i = 0; i < listed.length; i += 3) t.comments.push({ id: 'c' + (t.comments.length + 1), body: 'Attachments:\\n' + listed.slice(i, i + 3).map((f, n) => (n + 1) + '. File: ' + f.name + '\\n   Caption: ' + f.caption).join('\\n'), createdAt: new Date().toISOString() });
      fs.mkdirSync(path.dirname(file(root, item)), { recursive: true });
      fs.writeFileSync(file(root, item), JSON.stringify(t, null, 2));
      return { issue: t, via: 'notes' };
    },
  },
  normalize(raw) {
    const i = raw.issue ?? raw;
    return { id: i.identifier, title: i.title, description: i.description, status: i.status, labels: i.labels, url: null, updatedAt: null, comments: (i.comments ?? []).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.createdAt })), attachments: (i.attachments ?? []).map((a) => ({ id: a.id, title: a.title, filename: a.filename, subtitle: a.subtitle ?? null, url: null, stored: a.stored })) };
  },
};
`;

function project(name, mode, options = {}, via = 'files') {
  return singleRepoProject(name, { tracker: { kind: './tracker/notes.mjs', via, statuses, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\nnotes-db/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n', '.workflow/tracker/notes.mjs': adapter(mode, options) });
}

// An attempt that is delivered and waits for `wf shown`.
function toShown(base, root, item = 'ENG-70') {
  const e = ok(wf(root, ['entry', '--item', item, '--json'])).json();
  const id = e.id;
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
  const shown = path.join(base, `shown-${id}.json`);
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  return { id, shown, sha: g.steps[0].artifacts[0].sha256 };
}
const commentOf = (root, id) => fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'delivery', 'delivered-comment.md'), 'utf8');
const tickets = (root, item) => JSON.parse(fs.readFileSync(path.join(root, 'notes-db', `${item}.json`), 'utf8'));

test('0.7.27 (I-189): an adapter whose screenshots are attachments gets a comment that lists them in plain words, and the delivery is recorded without an embedded image', () => {
  const { base, root } = project('attach-listed', 'attachments', { subtitle: true });
  const { id, shown } = toShown(base, root);
  assert.match(ok(wf(root, ['doctor', '--no-steps'])).out, /tracker screenshots\n {4}the adapter shows screenshots as attachments \(`screenshots: attachments`\): the delivered comment lists each file and its caption, and no image is embedded/);
  const comment = commentOf(root, id);
  assert.match(comment, /Screenshots \(attached to the ticket\):\n\n1\. File: home\.png\n {3}Caption: /, 'a plain list: the file name and its caption');
  assert.doesNotMatch(comment, /!\[|\{assetUrl:/, 'no embedded image and no placeholder');
  const action = state(root, id).tracker.pending.find((a) => a.op === 'comment' && a.event === 'delivered');
  assert.equal(action.screenshots, 'attachments', 'the action carries what the adapter declared');
  // The caption the owner gives it is in the list the readback compares with; the attachment is the upload.
  const r = ok(wf(root, ['shown', '--file', shown, '--attempt', id]));
  assert.match(r.out, /tracker: delivered performed on the ticket files and read back|tracker: delivered performed/);
  const s = state(root, id);
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.tracker.done.find((d) => d.event === 'delivered').attachments.map((x) => [x.title, x.caption]), [['home.png', 'Home screen with the new text']]);
  assert.match(commentOf(root, id), /Caption: Home screen with the new text/);
  assert.deepEqual(tickets(root, 'ENG-70').comments.map((c) => /^ENG-70 is ready for UAT|^Attachments:/.exec(c.body)?.[0]), ['ENG-70 is ready for UAT', 'Attachments:'].map((x) => x), 'the page comment, then the follow-up that lists the files');
});

test('0.7.27 (I-189): "attachments-only" lists nothing in the comment; the attachment carries its caption; a link or a missing file is still refused', () => {
  const only = project('attach-only', 'attachments-only', { subtitle: true });
  const a = toShown(only.base, only.root);
  assert.doesNotMatch(commentOf(only.root, a.id), /Screenshots|home\.png|!\[|\{assetUrl:/, 'the comment holds no screenshot section');
  ok(wf(only.root, ['shown', '--file', a.shown, '--attempt', a.id]));
  assert.equal(state(only.root, a.id).phase, 'done');
  // The caption is on the attachment alone here, so an attachment without it is refused.
  const bare = project('attach-only-bare', 'attachments-only');
  const b = toShown(bare.base, bare.root);
  const refused = wf(bare.root, ['shown', '--file', b.shown, '--attempt', b.id]);
  assert.match(`${refused.out}${refused.err}`, /home\.png[^\n]*uploaded, but no attachment of it has the subtitle "Home screen with the new text"/);
  assert.notEqual(state(bare.root, b.id).phase, 'done');
  // An attachment that is a link, not an uploaded file, is not delivered, whichever way the comment lists it.
  const link = project('attach-link', 'attachments', { link: true });
  const c = toShown(link.base, link.root);
  const linked = wf(link.root, ['shown', '--file', c.shown, '--attempt', c.id]);
  assert.match(`${linked.out}${linked.err}`, /home\.png[^\n]*attached as a link, not an uploaded file/);
  assert.notEqual(state(link.root, c.id).phase, 'done');
});

// 0.7.27 (review of the release), named failure: in `attachments` mode an upload with no subtitle at all was accepted, which
// weakened the guard that an earlier attempt's upload with the same file name does not count as this delivery's: the caption the
// owner gave the screenshot is the only thing that tells the two apart. The subtitle is the caption in both attached modes.
test('0.7.27 (I-189): in "attachments" mode an upload without the caption as its subtitle is refused, as in "attachments-only"', () => {
  const bare = project('attach-listed-bare', 'attachments');
  const a = toShown(bare.base, bare.root);
  const refused = wf(bare.root, ['shown', '--file', a.shown, '--attempt', a.id]);
  assert.match(`${refused.out}${refused.err}`, /home\.png[^\n]*uploaded, but no attachment of it has the subtitle "Home screen with the new text" \(an earlier attempt's file with the same name does not count\)/);
  assert.notEqual(state(bare.root, a.id).phase, 'done');
});

test('0.7.27 (I-189): every other adapter embeds as before, and an adapter that declares something else is refused by name', () => {
  const plain = project('attach-default', undefined);
  const { id } = toShown(plain.base, plain.root);
  assert.match(commentOf(plain.root, id), /Screenshots:\n\n\*\*1\. [^\n]*\*\*\n!\[home\.png\]\(/, 'embedded, as before');
  assert.equal(state(plain.root, id).tracker.pending.find((a) => a.op === 'comment' && a.event === 'delivered').screenshots, undefined);
  const odd = project('attach-unknown', 'carrier-pigeon');
  const e = wf(odd.root, ['entry', '--item', 'ENG-71', '--json']);
  assert.match(`${e.out}${e.err}`, /screenshots: "carrier-pigeon" is not one of embedded, attachments, attachments-only/);
  const d = wf(odd.root, ['doctor', '--no-steps']);
  assert.notEqual(d.code, 0);
  assert.match(d.out, /✗ [a-z]+: tracker screenshots — [^\n]*screenshots: "carrier-pigeon" is not one of embedded, attachments, attachments-only\n {4}fix: declare `screenshots`/);
});

test('0.7.27 (I-189): through a connector the agent-reported readback of such an adapter needs the attachments, not an embedded image', () => {
  const { base, root } = project('attach-reported', 'attachments', {}, 'connector');
  let n = 0;
  const at = () => new Date(Date.now() + 1000 * ++n).toISOString();
  const report = (r) => {
    const f = path.join(base, `reported-${++n}.json`);
    fs.writeFileSync(f, JSON.stringify(r));
    return f;
  };
  const e = ok(wf(root, ['entry', '--item', 'ENG-72', '--json'])).json();
  const id = e.id;
  const rec = (event, r, extra = []) => wf(root, ['tracker', 'record', '--event', event, '--agent-reported', '--file', report(r), '--attempt', id, ...extra]);
  ok(rec('admitted', { issue: 'ENG-72', title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: at() }));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  ok(rec('implementing', { issue: 'ENG-72', title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: at() }));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  ok(wf(root, ['shown', '--file', shown, '--attempt', id]));
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /post the comment in [^\n]* unchanged \(it lists each screenshot with its caption\): this tracker's adapter shows the screenshots as attachments, so they are attached to the ticket as files, not embedded in the comment/);
  const posted = commentOf(root, id);
  write(base, 'posted.md', posted);
  const good = { issue: 'ENG-72', status: 'Ready for UAT', comment: { id: 'c1', bodySha256: crypto.createHash('sha256').update(posted).digest('hex'), createdAt: at() }, attachments: [{ title: 'home.png', subtitle: 'Home screen with the new text', assetUrl: 'https://uploads.example.test/home.png?sig=abc' }] };
  const missing = rec('delivered', { ...good, attachments: [], readAt: at() }, ['--comment-file', path.join(base, 'posted.md')]);
  assert.equal(missing.code, 75);
  assert.match(missing.err, /home\.png: not among the reported attachments/);
  assert.doesNotMatch(missing.err, /shows no image|embedded/, 'no image is asked for');
  // Each reported attachment names the upload by an https url (a file attached on the ticket, not a title written in a report).
  for (const [attachments, why] of [[[{ title: 'home.png', subtitle: 'Home screen with the new text' }], 'no url'], [[{ title: 'home.png', subtitle: 'Home screen with the new text', assetUrl: 'http://uploads.example.test/home.png' }], 'not https'], [[{ title: 'home.png', assetUrl: 'https://uploads.example.test/home.png' }], 'no subtitle']]) {
    const refused = rec('delivered', { ...good, attachments, readAt: at() }, ['--comment-file', path.join(base, 'posted.md')]);
    assert.equal(refused.code, 75, why);
    assert.match(refused.err, why === 'no subtitle' ? /home\.png: reported without the subtitle "Home screen with the new text"/ : /home\.png: the report gives no `assetUrl` \(https\) for its upload/, why);
  }
  const done = ok(rec('delivered', { ...good, readAt: at() }, ['--comment-file', path.join(base, 'posted.md')]));
  assert.equal(JSON.stringify(state(root, id).tracker.done.find((d) => d.event === 'delivered').attachments).includes('sig=abc'), false, 'the upload signature is not kept');
  assert.match(done.out, /tracker delivered recorded as agent-reported, unverified/);
  assert.equal(state(root, id).phase, 'done');
});
