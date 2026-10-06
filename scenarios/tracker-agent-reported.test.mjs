import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, singleRepoProject, state, summaryFile, wf, write } from './helpers.mjs';

// 0.4.2: connector mode is a first-class choice. In Claude Code the connector's tool results arrive inline in the chat,
// so the raw-capture path could only be met by retyping them (named failure: ~35 KB of signed URLs retyped). The agent
// reports what the tracker showed; the engine checks what it can and records it as agent-reported, unverified.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
const project = (name, via = 'connector') => singleRepoProject(name, { tracker: { kind: 'linear', via, statuses, deliveredComment: 'uat.md' }, gate: { steps: visual } }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n' });
let n = 0;
const later = () => new Date(Date.now() + 1000 * ++n).toISOString();
const report = (base, r) => {
  const f = path.join(base, `reported-${++n}.json`);
  fs.writeFileSync(f, JSON.stringify(r));
  return f;
};

function toDelivered(base, root) {
  const e = ok(wf(root, ['entry', '--item', 'ENG-50', '--owner', 'o', '--json'])).json();
  const id = e.id;
  const rec = (event, r, extra = []) => wf(root, ['tracker', 'record', '--event', event, '--agent-reported', '--file', report(base, r), '--attempt', id, ...extra]);
  // The admitted report must carry the description the roles will read.
  assert.match(rec('admitted', { issue: 'ENG-50', status: 'In Progress', readAt: later() }).err, /needs the issue's `title` and `description`/);
  ok(rec('admitted', { issue: 'ENG-50', title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: later() }));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', id]));
  ok(rec('implementing', { issue: 'ENG-50', title: 'Show a', description: 'Show the new text.', status: 'In Progress', readAt: later() }));
  commitIn(state(root, id).repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', '--attempt', id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', id]));
  ok(wf(root, ['accept', '--attempt', id]));
  ok(wf(root, ['deliver', '--attempt', id, '--summary-file', summaryFile(base)]));
  const shown = path.join(base, 'shown.json');
  fs.writeFileSync(shown, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  ok(wf(root, ['shown', '--file', shown, '--attempt', id]));
  return { id, rec };
}

test('connector, agent-reported: the engine checks status, comment text, screenshots and captions, allows owner additions, records it unverified', () => {
  const { base, root } = project('agent-reported');
  const { id, rec } = toDelivered(base, root);
  const rendered = fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', id, 'delivery', 'delivered-comment.md'), 'utf8');
  // The comment as posted: each screenshot by its uploaded asset, plus a section the owner added.
  const posted = `${rendered.replace(/\{assetUrl:home\.png\}/g, 'https://uploads.linear.app/x/home.png')}\nOwner note: also check the dark theme.\n`;
  const postedFile = path.join(base, 'posted.md');
  write(base, 'posted.md', posted);
  const good = { issue: 'ENG-50', status: 'Ready for UAT', comment: { id: 'c1', bodySha256: sha(posted), createdAt: later() }, attachments: [{ title: 'home.png', subtitle: 'Home screen with the new text' }] };
  const refusals = [
    [{ ...good, readAt: later(), status: 'In Progress' }, /status is `In Progress`, expected `Ready for UAT`/],
    [{ ...good, readAt: later(), comment: { ...good.comment, bodySha256: sha('other') } }, /the posted comment's sha256 is .* the report declares/],
    [{ ...good, readAt: later(), attachments: [{ title: 'home.png', subtitle: 'wrong caption' }] }, /home\.png: reported without the subtitle "Home screen with the new text"/],
    [{ ...good, readAt: later(), attachments: [] }, /home\.png: not among the reported attachments/],
    [{ ...good, readAt: '2020-01-01T00:00:00.000Z' }, /`readAt` 2020-01-01T00:00:00.000Z is before delivery/],
    [{ ...good, readAt: later(), issue: 'ENG-51' }, /the report is for `ENG-51`, not ENG-50/],
  ];
  for (const [r, re] of refusals) {
    const out = rec('delivered', r, ['--comment-file', postedFile]);
    assert.equal(out.code, 75, String(re));
    assert.match(out.err, re);
  }
  // A comment without the screenshot image, or without the fixed lines, is refused.
  const bare = 'Something else entirely.\n';
  write(base, 'bare.md', bare);
  const b = rec('delivered', { ...good, readAt: later(), comment: { ...good.comment, bodySha256: sha(bare) } }, ['--comment-file', path.join(base, 'bare.md')]);
  assert.match(b.err, /lacks the template's fixed line\(s\): "UAT scope:"[\s\S]*lacks the owner's summary[\s\S]*no inline image for 1 delivered screenshot\(s\): home\.png/);
  assert.match(rec('delivered', { ...good, readAt: later() }).err, /--comment-file <posted\.md> is required/);
  // The good report: recorded, unverified, the owner's addition listed; status and export say so.
  const readAt = later();
  const r = ok(rec('delivered', { ...good, readAt }, ['--comment-file', postedFile]));
  assert.match(r.out, /tracker delivered recorded as agent-reported, unverified \(the engine checked what the agent reported, not the tracker's answer; 1 line\(s\) added to the comment beyond the rendered one\)\. Attempt closed/);
  const s = state(root, id);
  assert.equal(s.phase, 'done');
  const d = s.tracker.done.find((t) => t.event === 'delivered');
  assert.deepEqual([d.provenance, d.verified, d.mode, d.readAt, d.extraLines], ['agent-reported, unverified', false, 'agent-reported', readAt, ['Owner note: also check the dark theme.']]);
  assert.equal(d.comment.sha256, sha(posted));
  assert.match(ok(wf(root, ['status', '--attempt', id])).out, /tracker delivered: readback agent-reported, unverified/);
  const page = fs.readFileSync(ok(wf(root, ['export', '--attempt', id])).out.match(/(\/\S+\.html)/)[1], 'utf8');
  assert.match(page, /agent-reported, unverified/);
});

test('agent-reported is refused outside connector mode, and a recycled read time is refused', () => {
  const { base, root } = project('agent-reported-api', 'api');
  const e = ok(wf(root, ['entry', '--item', 'ENG-60', '--owner', 'o', '--json'])).json();
  const r = wf(root, ['tracker', 'record', '--event', 'admitted', '--agent-reported', '--file', report(base, { issue: 'ENG-60', description: 'd', status: 'In Progress', readAt: later() }), '--attempt', e.id]);
  assert.equal(r.code, 75);
  assert.match(r.err, /`--agent-reported` is for `tracker\.via: connector`; with `api` the engine performs and verifies the handoff itself/);
  const c = project('agent-reported-recycle');
  const e2 = ok(wf(c.root, ['entry', '--item', 'ENG-50', '--owner', 'o', '--json'])).json();
  const at = later();
  ok(wf(c.root, ['tracker', 'record', '--event', 'admitted', '--agent-reported', '--file', report(c.base, { issue: 'ENG-50', description: 'd', status: 'In Progress', readAt: at }), '--attempt', e2.id]));
  ok(wf(c.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e2.id]));
  ok(wf(c.root, ['plan', '--file', criteriaFile(c.base), '--attempt', e2.id]));
  ok(wf(c.root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e2.id]));
  const again = wf(c.root, ['tracker', 'record', '--event', 'implementing', '--agent-reported', '--file', report(c.base, { issue: 'ENG-50', description: 'd', status: 'In Progress', readAt: at }), '--attempt', e2.id]);
  assert.match(again.err, /`readAt` .* was already recorded for event `admitted`: read the issue again now/);
  assert.match(ok(wf(c.root, ['status', '--attempt', e2.id])).out, /--agent-reported --file reported\.json/, 'the next step names the agent-reported route in connector mode');
});
