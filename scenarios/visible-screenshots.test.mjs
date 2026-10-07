import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, postedComment, rawReadback, singleRepoProject, state, summaryFile, wf } from './helpers.mjs';

// I-11: screenshots must be visible on the ticket, not only attached. Named failure: the owner saw zero images on the
// ticket; the uploads showed only as link rows. A project with no delivered comment template (or an events list that
// attaches screenshots without a comment) delivered the screenshots as attachments alone, and nothing checked that they
// showed. Now a delivery with screenshots always posts the delivered comment that embeds each one (a built-in template
// when the project names none), and the readback refuses it until every screenshot is embedded by its upload.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
const asset = 'https://uploads.linear.app/x/y/home';

function toShown(name, tracker, item) {
  const { base, root } = singleRepoProject(name, { tracker: { kind: 'linear', statuses, ...tracker }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' });
  const cap = (obj) => {
    const f = path.join(base, `cap-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap({ issue: { identifier: item, description: 'Show the new text.', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap({ issue: { identifier: item, description: 'Show the new text.', state: { name: 'In Progress' } } }), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const shot = JSON.parse(ok(wf(root, ['gate', '--attempt', e.id, '--json'])).out).steps[0].artifacts[0];
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [shot.sha256] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  // No template configured: the comment that shows the screenshots still needs the owner's summary, before anything is pushed.
  assert.match(wf(root, ['deliver', '--attempt', e.id]).err, /the delivered comment needs the owner's summary first/);
  ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)]));
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: shot.sha256, caption: 'Home screen showing the new text' }], anomalies: 'none seen' }));
  ok(wf(root, ['shown', '--file', shown, '--attempt', e.id]));
  return { base, root, id: e.id, item, cap };
}

function assertVisibleOnly({ root, id, item, cap }) {
  const pending = state(root, id).tracker.pending.filter((a) => a.event === 'delivered').map((a) => a.op);
  assert.deepEqual(pending.slice(0, 2), ['attach', 'comment'], 'the comment that embeds the uploads follows them');
  assert.match(ok(wf(root, ['resume', '--attempt', id])).out, /so every screenshot shows as an image on the ticket \(an attachment alone is only a link row\)/);
  const body = postedComment(root, id, { 'home.png': asset });
  assert.match(body, new RegExp(`^${item} is ready for UAT\\.\\n\\nThe home screen now shows the new text\\.\\n\\nUAT scope:\\n- a shows the new text\\n\\nScreenshots:\\n\\n\\*\\*1\\. Home screen showing the new text\\*\\*\\n!\\[home\\.png\\]\\(https://uploads\\.linear\\.app/x/y/home\\)\\n$`), 'the built-in template: header, summary, UAT scope, each screenshot inline under its caption');
  const after = new Date(Date.now() + 1000).toISOString();
  const upload = { id: 'a1', title: 'home.png', subtitle: 'Home screen showing the new text', url: asset };
  // The screenshot uploaded as an attachment only, with no comment: refused (this is the ticket with zero images).
  const attachedOnly = wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments: [upload] })), '--attempt', id]);
  assert.equal(attachedOnly.code, 75);
  assert.match(attachedOnly.err, /no comment written after delivery containing the template's fixed lines: "UAT scope:"/);
  // The comment posted with the placeholder left in: no image on the ticket, refused.
  const unreplaced = postedComment(root, id, {});
  const ph = wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments: [upload], comments: [{ id: 'c1', body: unreplaced, createdAt: after }] })), '--attempt', id]);
  assert.match(ph.err, /the comment does not embed 1 delivered screenshot\(s\) as an inline image of its uploaded asset/);
  ok(wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(rawReadback(item, 'Ready for UAT', { attachments: [upload], comments: [{ id: 'c2', body, createdAt: after }] })), '--attempt', id]));
  assert.equal(state(root, id).phase, 'done');
}

test('I-11: no delivered comment template: a delivery with screenshots posts the built-in comment that embeds them; attachments alone are refused', () => {
  assertVisibleOnly(toShown('visible-default', {}, 'ENG-110'));
});

test('I-11: an events list that attaches screenshots without a comment gets the delivered comment after the uploads', () => {
  assertVisibleOnly(toShown('visible-events', { events: { delivered: [{ attach: 'screenshots' }, { setStatus: 'delivered' }, 'readback'] } }, 'ENG-111'));
});
