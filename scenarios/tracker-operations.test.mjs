import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, singleRepoProject, state, summaryFile, wf } from './helpers.mjs';

// 0.7.31 (I-215, D68), named failure (field): `wf shown` and `wf resume` told the owner to post image Markdown in a comment, while
// the project's pinned tracker adapter said in its own `operations` to add a native page section with uploaded image blocks;
// following the generic line produced a comment without images. Through the connector, the next action for each pending tracker
// step now says the adapter's own instructions for it, verbatim and ahead of the workflow's generic wording; an adapter that gives
// none, or whose `operations` describe its own engine route, leaves the generic wording alone.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };
const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf png > shots/home.png', artifacts: ['shots/*.png'] }];
const OPS = {
  readIssue: 'Fetch the ticket page with pages_fetch (its properties and every section)',
  setStatus: 'Set the page property Status with pages_update to the status named',
  comment: 'Add one flat native "Agentic delivery" section to the ticket page with the rendered text, each screenshot as an uploaded image block where its placeholder stands; never a page comment',
  attach: 'Upload each screenshot with files_upload and keep its file id for the image block',
  readBack: 'Fetch the page again with pages_fetch and save the result unchanged',
};
// A project's own tracker adapter driven through the agent's connector, as the field's pinned page adapter was.
const pages = (ops) => `export default {
  via: 'agent',
  ${ops ? `operations: ${JSON.stringify(ops)},` : ''}
  isUpload: (a) => /^https:\\/\\/files\\.example\\.test\\//.test(String(a && a.url || '')),
  normalize(raw) {
    const i = raw.issue ?? raw;
    return { id: i.identifier, title: i.title, description: i.description, status: i.status, labels: i.labels ?? [], url: null, updatedAt: null, comments: i.comments ?? [], attachments: i.attachments ?? [] };
  },
};
`;
function project(name, ops, extra = {}) {
  return singleRepoProject(name, { tracker: { kind: './tracker/pages.mjs', via: 'connector', statuses }, gate: { steps: visual }, ...extra }, { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n', '.workflow/tracker/pages.mjs': pages(ops) });
}
const resume = (root, id) => ok(wf(root, ['resume', '--attempt', id])).out;

test('I-215: through the connector, each pending step shows the project adapter\'s own instructions verbatim, before the generic wording', () => {
  const { base, root } = project('ops-pages', OPS);
  const e = ok(wf(root, ['entry', '--item', 'ENG-80', '--json'])).json();
  const admitted = resume(root, e.id);
  const own = `tracker (admitted): through the connector: your tracker adapter's own instructions for these steps, verbatim (follow them for how each is done; the workflow's wording after them says what each carries): readIssue: "${OPS.readIssue}"; setStatus: "${OPS.setStatus}"; readBack: "${OPS.readBack}". The workflow's wording: read, set status to "In Progress"; then read the issue back with the connector`;
  assert.ok(admitted.includes(own), admitted);
  assert.ok(!admitted.includes(OPS.comment), 'only the steps pending now');

  // The delivered handoff, where the field's owner followed the generic line: `wf shown` and `wf resume` lead with the adapter's words.
  let n = 0;
  const reported = (r) => {
    const f = path.join(base, `reported-${++n}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...r, readAt: new Date(Date.now() + 1000 * n).toISOString() }));
    return f;
  };
  const issue = { issue: 'ENG-80', title: 'Show the text', description: 'The home screen shows the new text.', status: 'In Progress' };
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--agent-reported', '--file', reported(issue), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--agent-reported', '--file', reported(issue), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const g = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json();
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { screenshotsInspected: [g.steps[0].artifacts[0].sha256] })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));
  ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base)]));
  const shownFile = path.join(base, 'shown.json');
  fs.writeFileSync(shownFile, JSON.stringify({ screenshots: [{ sha256: g.steps[0].artifacts[0].sha256, caption: 'Home screen with the new text' }], anomalies: 'none seen' }));
  const shown = ok(wf(root, ['shown', '--file', shownFile, '--attempt', e.id])).out;
  for (const out of [shown, resume(root, e.id)]) {
    const head = `tracker (delivered): through the connector: your tracker adapter's own instructions for these steps, verbatim (follow them for how each is done; the workflow's wording after them says what each carries): attach: "${OPS.attach}"; comment: "${OPS.comment}"; setStatus: "${OPS.setStatus}"; readBack: "${OPS.readBack}". The workflow's wording: upload and attach 1 screenshot(s)`;
    assert.ok(out.includes(head), out);
    assert.ok(out.indexOf(OPS.comment) < out.indexOf('post the comment in'), 'the adapter\'s words come before the generic comment line');
  }
  assert.equal(state(root, e.id).phase, 'handoff-pending');
});

test('I-215: an adapter with no operations, and one whose operations describe its own engine route, leave the generic wording; the built-in Linear adapter\'s words are shown', () => {
  const plain = project('ops-none', null);
  const a = ok(wf(plain.root, ['entry', '--item', 'ENG-81', '--json'])).json();
  const none = resume(plain.root, a.id);
  assert.match(none, /tracker \(admitted\): through the connector: read, set status to "In Progress"; then read the issue back with the connector/);
  assert.doesNotMatch(none, /own instructions/);

  // GitHub's operations say what the engine does on its `cli` route ("the engine reads the issue"): no agent instruction.
  const gh = singleRepoProject('ops-github', { tracker: { kind: 'github', repo: 'example/app', via: 'connector', statuses }, gate: { steps: visual } });
  const b = ok(wf(gh.root, ['entry', '--item', 'ENG-82', '--json'])).json();
  const github = resume(gh.root, b.id);
  assert.match(github, /tracker \(admitted\): through the connector: read, set status to "In Progress"/);
  assert.doesNotMatch(github, /the engine reads the issue|own instructions/);

  const ln = singleRepoProject('ops-linear', { tracker: { kind: 'linear', statuses }, gate: { steps: visual } });
  const c = ok(wf(ln.root, ['entry', '--item', 'ENG-83', '--json'])).json();
  assert.match(resume(ln.root, c.id), /tracker \(admitted\): through the connector: your tracker adapter's own instructions for these steps, verbatim \([^)]*\): readIssue: "Linear get_issue \(include comments and attachments\) or list_comments"; setStatus: "Linear save_issue with the status name"; readBack: "Linear get_issue [^"]*"\. The workflow's wording: read, set status to "In Progress"/);
});
