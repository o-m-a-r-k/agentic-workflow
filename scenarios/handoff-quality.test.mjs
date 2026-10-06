import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, postedComment, rawReadback, singleRepoProject, state, summaryFile, wf } from './helpers.mjs';
import { knownLimits, uatScope } from '../engine/tracker.mjs';

// 0.1.16: field failures from delivering one UI ticket. The delivered comment was a verbatim dump of every criterion;
// screenshots were attachments only ("added N links", zero images visible); a hand-built readback was accepted; the
// screenshots could not be viewed after close; an owner called a count that differed between two captures cosmetic.

const ignore = { '.gitignore': '.wf-evidence/\n.wf-worktrees/\nshots/\n' };
const tracker = { kind: 'linear', statuses: { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' }, deliveredComment: 'uat.md' };
const cap = (dir, obj) => {
  const f = path.join(dir, `cap-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};

test('UAT scope keeps user-visible criteria only; known limits come from finalHandoff notes, dropped criteria and follow-ups', () => {
  const s = {
    criteria: [
      { id: 'C1', text: 'list endpoint paginates', uat: 'The invoice list shows 20 rows per page' },
      { id: 'C2', text: 'repository refactor', uat: 'Not user visible: internal refactor' },
      { id: 'C3', text: 'migration', uat: false },
      { id: 'C4', text: 'retention', uat: 'N/A' },
      { id: 'C5', text: 'export', uat: 'Export downloads a CSV', finalHandoff: 'Exports over 10,000 rows are cut off; follow-up filed' },
    ],
    criteriaAmendments: [{ changes: { dropped: [{ id: 'C6', reason: 'dark mode moved to a follow-up' }] } }],
    delivery: { shown: { anomalies: [{ observation: 'counts differ between captures', followUp: 'isolate test data per run' }] } },
  };
  assert.equal(uatScope(s), '- The invoice list shows 20 rows per page\n- Export downloads a CSV');
  assert.equal(knownLimits(s), '- Exports over 10,000 rows are cut off; follow-up filed\n- Not delivered: dark mode moved to a follow-up\n- Follow-up: counts differ between captures (isolate test data per run)');
});

test('delivered handoff: summary required, screenshots embedded inline, raw readback only, anomalies recorded, screenshots viewable after close', () => {
  const visual = [{ id: 'ui', repo: 'app', run: 'mkdir -p shots && printf en > shots/list-en.png && printf fr > shots/list-fr.png', artifacts: ['shots/*.png'] }];
  const { base, root } = singleRepoProject('handoff', { tracker, gate: { steps: visual } }, { ...ignore, '.workflow/uat.md': '{id} is ready for UAT.\n\nUAT scope:\n{uatScope}\n' });
  const item = 'ENG-160';
  const issue = { identifier: item, description: 'd', state: { name: 'In Progress' } };
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap(base, { issue }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  const criteria = [{ id: 'C1', text: 'list shows active accounts', uat: 'The list shows the number of active accounts' }, { id: 'C2', text: 'query refactor', uat: 'Not user visible' }];
  ok(wf(root, ['plan', '--file', criteriaFile(base, criteria), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['tracker', 'record', '--event', 'implementing', '--capture', cap(base, { issue }), '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  const shots = ok(wf(root, ['gate', '--attempt', e.id, '--json'])).json().steps[0].artifacts;
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { criteria: criteria.map((c) => ({ id: c.id, evidence: { kind: 'output', ref: 'gate log' } })), screenshotsInspected: shots.map((a) => a.sha256) })), '--attempt', e.id]));
  ok(wf(root, ['accept', '--attempt', e.id]));

  // The summary is the owner's; a verbatim criterion is refused.
  assert.match(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base, '- list shows active accounts')]).err, /repeats criteria text verbatim \(C1\)/);
  const d = ok(wf(root, ['deliver', '--attempt', e.id, '--summary-file', summaryFile(base, 'The account list now shows how many accounts are active.')]));
  assert.match(d.out, /delivered comment to post .*delivered-comment\.md/);
  assert.match(d.out, /to view them again \(also after close\): `wf export screenshots --attempt ENG-160\.1 --to .*_exports\/ENG-160\.1`/);
  assert.match(d.out, /1\. .*_exports\/ENG-160\.1\/screenshots-\w+\/list-\w+\.png\n/, 'the SHOW block lists the viewable copies, exported at delivery');
  const s0 = state(root, e.id);
  assert.deepEqual(s0.tracker.pending.filter((a) => a.event === 'delivered').map((a) => a.op), ['attach', 'comment', 'setStatus', 'readback'], 'uploads come before the comment that embeds them');

  // Anomalies: the key is required; "cosmetic" needs evidence; an anomaly needs a cause or a follow-up.
  const byTitle = Object.fromEntries(s0.delivery.screenshots.screenshots.map((f) => [f.title, f]));
  const shownWith = (anomalies) => {
    const f = path.join(base, `shown-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ screenshots: [{ sha256: byTitle['list-en.png'].sha256, caption: 'Account list, English, 1 active' }, { sha256: byTitle['list-fr.png'].sha256, caption: 'Account list, French, 3 active' }], ...(anomalies === undefined ? {} : { anomalies }) }));
    return f;
  };
  const shown = (a) => wf(root, ['shown', '--file', shownWith(a), '--attempt', e.id]);
  assert.match(shown(undefined).err, /no `anomalies` key: while viewing the screenshots, compare values between captures of the same state/);
  assert.match(shown([{ screenshots: ['list-en.png', 'list-fr.png'], observation: '1 active in English, 3 in French', cause: 'cosmetic' }]).err, /"cosmetic" needs `evidence`/);
  assert.match(shown([{ screenshots: ['list-en.png'], observation: 'count differs' }]).err, /investigate it to a `cause`, or record a `followUp`/);
  assert.match(shown([{ screenshots: ['nope.png'], observation: 'x', cause: 'y' }]).err, /nope\.png not in the delivered set/);
  const anomaly = { screenshots: ['list-en.png', 'list-fr.png'], observation: '1 active account in English, 3 in French for the same state', followUp: 'isolate test data between capture runs' };
  ok(shown([anomaly]));
  const st = ok(wf(root, ['status', '--attempt', e.id])).out;
  assert.match(st, /anomalies: 1 active account in English, 3 in French for the same state \[list-en\.png, list-fr\.png\] → follow-up: isolate test data/);

  const assets = { 'list-en.png': 'https://uploads.linear.app/org/asset-en/file', 'list-fr.png': 'https://uploads.linear.app/org/asset-fr/file' };
  const body = postedComment(root, e.id, assets);
  assert.equal(body, [
    'ENG-160 is ready for UAT.',
    '',
    'The account list now shows how many accounts are active.',
    '',
    'UAT scope:',
    '- The list shows the number of active accounts',
    '',
    'Screenshots:',
    '',
    '**1. Account list, English, 1 active**',
    `![list-en.png](${assets['list-en.png']})`,
    '',
    '**2. Account list, French, 3 active**',
    `![list-fr.png](${assets['list-fr.png']})`,
    '',
    'Known limits and follow-ups:',
    '- Follow-up: 1 active account in English, 3 in French for the same state (isolate test data between capture runs)',
    '',
  ].join('\n'), 'no "Not user visible" line; each screenshot inline under its caption; the follow-up is a known limit');

  const after = new Date(Date.now() + 1000).toISOString();
  const attachments = [{ id: 'a-en', title: 'list-en.png', subtitle: 'Account list, English, 1 active', url: assets['list-en.png'] }, { id: 'a-fr', title: 'list-fr.png', subtitle: 'Account list, French, 3 active', url: assets['list-fr.png'] }];
  const record = (obj) => wf(root, ['tracker', 'record', '--event', 'delivered', '--capture', cap(base, obj), '--attempt', e.id]);

  // Attachments alone: the ticket shows "added 2 links" and no image.
  const noImages = record(rawReadback(item, 'Ready for UAT', { attachments, comments: [{ body: body.replace(/!\[[^\]]*\]\([^)]*\)\n?/g, ''), createdAt: after }] }));
  assert.match(noImages.err, /the comment does not embed 2 delivered screenshot\(s\) as an inline image[\s\S]*added N links[\s\S]*list-en\.png \(attachment a-en, asset https:\/\/uploads\.linear\.app\/org\/asset-en\/file\)/);
  // An image of another asset does not count.
  const wrong = record(rawReadback(item, 'Ready for UAT', { attachments, comments: [{ body: body.replace(assets['list-fr.png'], 'https://uploads.linear.app/org/other/file'), createdAt: after }] }));
  assert.match(wrong.err, /does not embed 1 delivered screenshot[\s\S]*list-fr\.png/);
  // A rebuilt readback: signatures stripped, fields missing.
  const stripped = rawReadback(item, 'Ready for UAT', { attachments, comments: [{ body, createdAt: after }] });
  stripped.issue.attachments[0].url = assets['list-en.png'];
  delete stripped.issue.stateHistory;
  delete stripped.comments.comments[0].author;
  const rebuilt = record(stripped).err;
  assert.match(rebuilt, /not the unmodified tracker output \(get_issue fields missing: stateHistory; attachment list-en\.png: its uploads\.linear\.app url has no signature[^;]*; comment c0 lacks author\)/);
  assert.match(rebuilt, /Prefer `tracker\.via: api`/);
  // An abridged comment.
  assert.match(record(rawReadback(item, 'Ready for UAT', { attachments, comments: [{ body: body.replace('The account list now shows how many accounts are active.\n\n', ''), createdAt: after }] })).err, /the posted comment is not the one `wf` rendered \(summary sha256 [0-9a-f]{12}\); first difference at line 2/);

  ok(record(rawReadback(item, 'Ready for UAT', { attachments, comments: [{ body, createdAt: after }] })));
  const s = state(root, e.id);
  assert.equal(s.phase, 'done');

  // Viewable after close: the delivered set was copied out (at delivery), named by title, and resume says where.
  const dir = s.delivery.exported.dir;
  assert.match(dir, new RegExp(`${path.join(root, '.wf-worktrees', '_exports', e.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/screenshots-\\w+$`));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['list-en.png', 'list-fr.png']);
  assert.equal(fs.readFileSync(path.join(dir, 'list-fr.png'), 'utf8'), 'fr');
  assert.ok(!fs.existsSync(e.repos.app.worktree), 'the worktree is gone');
  assert.match(ok(wf(root, ['resume', '--attempt', e.id])).out, new RegExp(`delivered screenshots \\(2\\): viewable copies in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const to = path.join(base, 'shots-out');
  const ex = ok(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', to]));
  assert.match(ex.out, /copied 2 delivered screenshot\(s\) of ENG-160\.1 to .*shots-out\/screenshots-\w+ \(each sha256-checked/);
  const fresh = ok(wf(root, ['resume', '--attempt', e.id, '--json'])).json().delivery.exported.dir;
  assert.equal(path.dirname(fresh), to, 'each export is a fresh folder under --to');
  assert.deepEqual(fs.readdirSync(fresh).sort(), ['list-en.png', 'list-fr.png']);
  assert.match(wf(root, ['export', 'screenshots', '--attempt', e.id, '--to', path.join(root, '.wf-evidence', 'x')]).err, /inside \.wf-evidence/);
  const j = ok(wf(root, ['export', '--attempt', e.id, '--json'])).json();
  assert.equal(j.delivered.anomalies[0].followUp, 'isolate test data between capture runs');
  assert.equal(j.delivered.exportedTo, fresh);
  ok(wf(root, ['export', '--attempt', e.id]));
  assert.match(fs.readFileSync(path.join(root, '.wf-evidence', 'attempts', e.id, 'export', 'attempt.html'), 'utf8'), /Anomalies seen/);
});

test('design system: bans and companions run over added lines; every hit needs the reviewer\'s verdict', () => {
  const designSystem = {
    components: [{ name: 'DataTable', path: 'web/components/DataTable.tsx', use: 'every data table' }, { name: 'Pagination', path: 'web/components/Pagination.tsx', use: 'every paged list' }],
    rules: [
      { id: 'no-raw-table', description: 'no raw <table>/<thead> in app source outside the shared table component', forbidPattern: '<(table|thead)\\b', paths: ['web/**/*.tsx'], except: ['web/components/DataTable.tsx'] },
      { id: 'table-has-pagination', description: 'a list rendered with the shared table is used with the shared pagination', pattern: '<DataTable\\b', requireWith: ['<Pagination\\b'], paths: ['web/**/*.tsx'] },
    ],
  };
  const { base, root } = singleRepoProject('design', { designSystem }, { 'web/components/DataTable.tsx': 'export const DataTable = () => <table />;\n', 'web/old.tsx': 'export const Old = () => <table />;\n' });
  const e = ok(wf(root, ['entry', '--item', 'ENG-161', '--owner', 'o', '--json'])).json();
  const planner = ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out;
  const pb = JSON.parse(fs.readFileSync(planner.match(/bundle: (\S+)/)[1], 'utf8'));
  assert.deepEqual(pb.designSystem.components.map((c) => c.name), ['DataTable', 'Pagination'], 'the planner sees the shared components');
  assert.match(pb.instructions, /uses the shared components/);
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, {
    'web/report.tsx': 'export const Report = () => (\n  <div>\n    <table>\n      <thead />\n    </table>\n  </div>\n);\n',
    'web/list.tsx': 'export const List = () => <DataTable rows={[]} />;\n',
    'web/paged.tsx': 'export const Paged = () => (<><DataTable rows={[]} /><Pagination /></>);\n',
    'web/components/DataTable.tsx': 'export const DataTable = () => <table><thead /></table>;\n',
    'web/old.tsx': 'export const Old = () => <table />;\nexport const x = 1;\n',
  });
  const g = ok(wf(root, ['gate', '--attempt', e.id]));
  assert.match(g.out, /warning: 3 design-system hit\(s\) on added lines/);
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  const ids = bundle.designSystem.hits.map((h) => h.id).sort();
  // Added lines only: old.tsx's existing <table> is not this ticket's; the shared component itself is excepted.
  assert.deepEqual(ids, ['no-raw-table@web/report.tsx:3', 'no-raw-table@web/report.tsx:4', 'table-has-pagination@web/list.tsx:1']);
  assert.deepEqual(bundle.designSystem.hits.find((h) => h.rule === 'table-has-pagination').missing, ['<Pagination\\b']);
  assert.match(bundle.instructions, /for every changed UI file list each table, list, form and dialog/);
  const refused = wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]);
  assert.equal(refused.code, 75);
  assert.match(refused.err, /3 design-system hit\(s\) on lines this attempt added have no valid verdict[\s\S]*no-raw-table@web\/report\.tsx:3 \(no raw <table>/);
  const partial = { designHits: [{ id: 'no-raw-table@web/report.tsx:3', verdict: 'justified' }] };
  assert.match(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', partial)), '--attempt', e.id]).err, /justified needs evidence/);
  const verdicts = {
    findings: [{ id: 'F1', severity: 'major', summary: 'report uses a raw table', status: 'fixed', evidence: 'web/report.tsx:3' }],
    designHits: [
      { id: 'no-raw-table@web/report.tsx:3', verdict: 'finding', finding: 'F1', evidence: 'web/report.tsx:3 raw table' },
      { id: 'no-raw-table@web/report.tsx:4', verdict: 'finding', finding: 'F1', evidence: 'same table' },
      { id: 'table-has-pagination@web/list.tsx:1', verdict: 'justified', evidence: 'the list is capped at 5 rows by the API (C1)' },
    ],
  };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', verdicts)), '--attempt', e.id]));
  const s = ok(wf(root, ['accept', '--attempt', e.id, '--json'])).json();
  assert.equal(s.accepted.designHits.length, 3);
});

test('design system config is validated', () => {
  const bad = singleRepoProject('design-bad', { designSystem: { rules: [{ id: 'x', description: 'd', pattern: '<A' }, { id: 'y', forbidPattern: '(' }] } });
  const r = wf(bad.root, ['doctor', '--no-steps']);
  assert.match(`${r.out}${r.err}`, /`pattern` needs `requireWith`/);
  assert.match(`${r.out}${r.err}`, /designSystem rule `y`: `description`/);
  assert.match(`${r.out}${r.err}`, /invalid regex/);
});
