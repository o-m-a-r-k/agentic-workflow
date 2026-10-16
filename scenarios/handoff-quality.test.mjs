import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closureFile, commitIn, criteriaFile, goodClosure, ok, OUT_OF_ORDER, postedComment, rawReadback, singleRepoProject, state, summaryFile, wf } from './helpers.mjs';
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
  const shots = ok(wf(root, ['gate', ...OUT_OF_ORDER, '--attempt', e.id, '--json'])).json().steps[0].artifacts;
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

test('design system: bans and companions run over added lines; the hits are context for the reviewer and the verdicts it gives are recorded', () => {
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
  // The planner is asked for targets that name the shared components a surface uses (the quality bar and the design system).
  assert.match(pb.instructions, /the quality bar \(`qualityBar`\) turned into targets for this ticket/);
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, {
    'web/report.tsx': 'export const Report = () => (\n  <div>\n    <table>\n      <thead />\n    </table>\n  </div>\n);\n',
    'web/list.tsx': 'export const List = () => <DataTable rows={[]} />;\n',
    'web/paged.tsx': 'export const Paged = () => (<><DataTable rows={[]} /><Pagination /></>);\n',
    'web/components/DataTable.tsx': 'export const DataTable = () => <table><thead /></table>;\n',
    'web/old.tsx': 'export const Old = () => <table />;\nexport const x = 1;\n',
  });
  const start = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id])).out.trim();
  const bundle = JSON.parse(fs.readFileSync(start.match(/^Read (\S+)/)[1], 'utf8'));
  const ids = bundle.designSystem.hits.map((h) => h.id).sort();
  // Added lines only: old.tsx's existing <table> is not this ticket's; the shared component itself is excepted.
  assert.deepEqual(ids, ['no-raw-table@web/report.tsx:3', 'no-raw-table@web/report.tsx:4', 'table-has-pagination@web/list.tsx:1']);
  assert.deepEqual(bundle.designSystem.hits.find((h) => h.rule === 'table-has-pagination').missing, ['<Pagination\\b']);
  assert.match(bundle.instructions, /design-system hits[^:]*are context for your judgement: cite them in findings; no verdict form is owed/);
  // 0.7.0 (goals, not forms): the hits stay in the bundle as context, and a verdict per hit is no longer required (named
  // failure: the form measured compliance with the form, not defects). A closure with none is recorded; a later round that
  // judges the hits has its verdicts recorded with the acceptance.
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r')), '--attempt', e.id]));
  // A delta round (0.7.0: every round between the two full audits) is handed the hits on the files changed since the last
  // reviewed tree, and only those: the three above were judged by the first round.
  commitIn(e.repos.app.worktree, { 'web/extra.tsx': 'export const Extra = () => <table />;\n' });
  const deltaStart = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r-delta', '--attempt', e.id])).out.trim();
  const deltaBundle = JSON.parse(fs.readFileSync(deltaStart.match(/^Read (\S+)/)[1], 'utf8'));
  assert.equal(deltaBundle.mode, 'delta');
  assert.deepEqual(deltaBundle.designSystem.hits.map((h) => h.id), ['no-raw-table@web/extra.tsx:1']);
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r-delta', { criteria: [] })), '--attempt', e.id]));
  // The gate runs on the clean review's tree and warns of every hit; the evidence review (the attempt's second full audit)
  // carries them all again.
  const g = ok(wf(root, ['gate', '--attempt', e.id]));
  assert.match(g.out, /warning: 4 design-system hit\(s\) on added lines/);
  const second = ok(wf(root, ['handoff', 'reviewer', '--agent', 'r2', '--attempt', e.id])).out.trim();
  const everyHit = [...ids, 'no-raw-table@web/extra.tsx:1'].sort();
  assert.deepEqual(JSON.parse(fs.readFileSync(second.match(/^Read (\S+)/)[1], 'utf8')).designSystem.hits.map((h) => h.id).sort(), everyHit, 'both full audits carry every hit');
  const verdicts = {
    findings: [{ id: 'F1', severity: 'major', summary: 'report uses a raw table', status: 'fixed', evidence: 'web/report.tsx:3' }],
    designHits: [
      { id: 'no-raw-table@web/report.tsx:3', verdict: 'finding', finding: 'F1', evidence: 'web/report.tsx:3 raw table' },
      { id: 'no-raw-table@web/report.tsx:4', verdict: 'finding', finding: 'F1', evidence: 'same table' },
      { id: 'table-has-pagination@web/list.tsx:1', verdict: 'justified', evidence: 'the list is capped at 5 rows by the API (C1)' },
    ],
  };
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r2', verdicts)), '--attempt', e.id]));
  const s = ok(wf(root, ['accept', '--attempt', e.id, '--json'])).json();
  assert.equal(s.accepted.designHits.length, 3);
});

// Named failure (I-94): criteria requiring screenshots were frozen against an adapter with no step that collects any;
// the planner bundle now lists the steps that can produce captures.
test('the planner bundle lists the gate steps that can produce captures', () => {
  const plain = singleRepoProject('routes-none', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }] } });
  const withShots = singleRepoProject('routes-some', { gate: { steps: [{ id: 'unit', repo: 'app', run: 'true' }, { id: 'e2e', repo: 'app', run: 'true', artifacts: ['shots/{itemLower}/*.png'] }] } });
  const routes = (p, item) => {
    const e = ok(wf(p.root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
    const out = ok(wf(p.root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id])).out;
    return JSON.parse(fs.readFileSync(out.match(/bundle: (\S+)/)[1], 'utf8')).captureRoutes;
  };
  assert.deepEqual(routes(plain, 'ENG-171'), { steps: [] });
  assert.deepEqual(routes(withShots, 'ENG-172'), { steps: [{ id: 'e2e', repo: 'app', artifacts: ['shots/{itemLower}/*.png'] }] });
});

test('design system config is validated', () => {
  const bad = singleRepoProject('design-bad', { designSystem: { rules: [{ id: 'x', description: 'd', pattern: '<A' }, { id: 'y', forbidPattern: '(' }] } });
  const r = wf(bad.root, ['doctor', '--no-steps']);
  assert.match(`${r.out}${r.err}`, /`pattern` needs `requireWith`/);
  assert.match(`${r.out}${r.err}`, /designSystem rule `y`: `description`/);
  assert.match(`${r.out}${r.err}`, /invalid regex/);
});

// 0.7.17: the delivered comment lists every known limit, nothing counted away; the owner words any item for the tester by
// its ref (`wf summary --explain`), and items worded the same show once. Named failure: one comment carried 53 lines of
// reviewer notes with file paths and test counts, and the first fix counted the minor items away instead.
test('every known limit is listed; the owner words items for the tester by ref, and the same wording shows once', () => {
  const { base, root } = singleRepoProject('limits-wording', { tracker }, { ...ignore, '.workflow/uat.md': '{id} is ready for UAT.\n' });
  const item = 'ENG-170';
  const issue = { identifier: item, description: 'd', state: { name: 'In Progress' } };
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', cap(base, { issue }), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'planner', '--agent', 'p', '--attempt', e.id]));
  ok(wf(root, ['plan', '--file', criteriaFile(base), '--attempt', e.id]));
  ok(wf(root, ['handoff', 'implementer', '--agent', 'i', '--attempt', e.id]));
  commitIn(e.repos.app.worktree, { 'src/a.txt': 'ui\n' });
  ok(wf(root, ['handoff', 'close', '--agent', 'i', '--attempt', e.id]));
  ok(wf(root, ['handoff', 'reviewer', '--agent', 'r', '--attempt', e.id]));
  ok(wf(root, ['review', '--closure', closureFile(base, goodClosure('r', { notReached: ['the dark theme (Docker-backed; not run). More detail for engineers.', 'the French screens were not viewed', 'the RTL layout (src/rtl/layout.tsx not run)'] })), '--attempt', e.id]));
  const lines0 = (obj) => {
    const f = path.join(base, `lines-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const listed = ok(wf(root, ['summary', '--file', summaryFile(base), '--attempt', e.id])).out;
  const [dark] = listed.match(/^ {2}(\S+:U1) {2}Not checked by review: the dark theme \(Docker-backed; not run\)\.$/m).slice(1);
  const french = dark.replace(/U1$/, 'U2');
  const rtl = dark.replace(/U1$/, 'U3');
  assert.match(listed, new RegExp(`^ {2}${french} {2}Not checked by review: the French screens were not viewed\\.$`, 'm'));
  // A line the readback would refuse as internals is marked for wording before anything is posted.
  assert.match(listed, new RegExp(`^ {2}${rtl} {2}Not checked by review: the RTL layout \\(src/rtl/layout\\.tsx not run\\)\\. {2}\\[carries source file path: word it\\]$`, 'm'));
  ok(wf(root, ['summary', '--explain', lines0({ [rtl]: 'Right-to-left layout was not checked by a reviewer' }), '--attempt', e.id]));
  assert.equal(knownLimits(state(root, e.id)), '- Not checked by review: the dark theme (Docker-backed; not run).\n- Not checked by review: the French screens were not viewed.\n- Not checked by review: Right-to-left layout was not checked by a reviewer.');
  const lines = lines0;
  assert.match(wf(root, ['summary', '--file', summaryFile(base), '--explain', lines({ 'r:F9': 'x' }), '--attempt', e.id]).err, new RegExp(`--explain names r:F9, which is not a known-limit item of ${e.id.replace('.', '\\.')} \\(its refs: ${dark}, ${french}, ${rtl}\\)`));
  assert.match(wf(root, ['summary', '--file', summaryFile(base), '--explain', lines({ [dark]: 'see src/theme/dark.tsx' }), '--attempt', e.id]).err, /--explain wording for \S+:U1 contains internals: source file path/);
  const same = 'Dark mode and the French screens were not checked by a reviewer';
  const rtlLine = '- Not checked by review: Right-to-left layout was not checked by a reviewer.';
  ok(wf(root, ['summary', '--file', summaryFile(base), '--explain', lines({ [dark]: same, [french]: { what: same } }), '--attempt', e.id]));
  assert.equal(knownLimits(state(root, e.id)), `- Not checked by review: ${same}.\n${rtlLine}`, 'merged per ref into the earlier wording');
  // The wording stays with a later summary that gives none.
  ok(wf(root, ['summary', '--file', summaryFile(base, 'The list now shows active accounts.'), '--attempt', e.id]));
  assert.equal(knownLimits(state(root, e.id)), `- Not checked by review: ${same}.\n${rtlLine}`);
  // "" drops one ref's wording; its recorded sentence shows again.
  ok(wf(root, ['summary', '--explain', lines({ [french]: '' }), '--attempt', e.id]));
  assert.equal(knownLimits(state(root, e.id)), `- Not checked by review: ${same}.\n- Not checked by review: the French screens were not viewed.\n${rtlLine}`);
});

// Fable review of 0.7.17: a delta round does not go back over an earlier round's gaps, so every round since the last complete
// full audit is listed, not only the latest that named any.
test('scope named as not checked in any round since the last full audit stays in the known limits', () => {
  const round = (n, mode, notReached) => ({ review: { handoff: `b/0${n}-reviewer.json`, reviewer: `r${n}`, closure: { notReached } }, handoff: { role: 'reviewer', bundle: `b/0${n}-reviewer.json`, mode } });
  const rounds = [round(2, 'full', ['the dark theme']), round(3, 'delta', ['the French screens were not viewed']), round(4, 'delta', [])];
  const s = { reviews: rounds.map((r) => r.review), handoffs: rounds.map((r) => r.handoff) };
  assert.equal(knownLimits(s), '- Not checked by review: the dark theme.\n- Not checked by review: the French screens were not viewed.');
});
