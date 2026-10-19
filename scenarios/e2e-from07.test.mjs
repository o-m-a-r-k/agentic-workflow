// End to end, the real `wf` with no doubles: a 0.7 project (schema-1 adapter, modules under `.workflow/`, 0.7 ledgers
// with a batch, a held and an open attempt) is migrated with `wf init --from-07` and `wf migrate attempts`, then one
// ticket runs on the migrated adapter: its tests are the old module, its tracker is reached through the owner's
// connector (read back from the owner's transcript), and its 0.7 delivery module became a merge request the person
// opens and merges.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, transcript, YAML } from './helpers/index.mjs';
import { makeModuleProject } from './onboard-fixture.mjs';
import { events, fakeReviewerHost, reviewFiles, waitFor, wf } from './e2e-support.mjs';

test('from 0.7: init --from-07 and migrate attempts, then a ticket on the migrated adapter through connector and module', async () => {
  const p = makeModuleProject();
  const host = fakeReviewerHost(p);
  const owner = crypto.randomUUID();
  const as = { env: { CLAUDE_CODE_SESSION_ID: owner } };
  try {
    // The adapter: an onboarding run seeded from the schema-1 adapter, confirmed whole, with the capture command.
    assert.match(wf(p, ['status'], { code: 1 }).err, /wf init --from-07/);
    const draft = path.join(p.tmp, 'draft.json');
    fs.writeFileSync(draft, JSON.stringify({ screens: { capture: 'cd panel && npm run shots -- --out {out} --width {viewport} --lang {lang} {routes}' } }));
    const init = wf(p, ['init', '--from-07', '--draft', draft, '--confirm', 'all']);
    assert.match(init.out, /Wrote .*project\.yaml/);
    const file = path.join(p.repos.core.dir, '.workflow', 'project.yaml');
    const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 2);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /&a\d|\*a\d/); // no YAML anchors in a file the person edits
    // Re-running onboarding on the migrated project changes nothing.
    assert.deepEqual(wf(p, ['init', '--json']).json().diff.changes, []);

    // Open 0.7 attempts: the held one is left for the person, the other is superseded; numbering continues.
    const m = wf(p, ['migrate', 'attempts']);
    assert.match(m.out, /TK-4\.1 .*held \("stop everything"\), skipped/);
    assert.match(m.out, /TK-5\.1 .*closed as superseded/);
    assert.match(wf(p, ['start', 'TK-4'], { code: 75, ...as }).err, /refused \(start:open\): TK-4 already has an attempt held by the person/);
    // Nor can the agent close the held 0.7 attempt around the person's hold.
    assert.match(wf(p, ['abandon', '--attempt', 'TK-4.1', '--reason', 'tidy up'], { code: 75, ...as }).err, /refused \(hold\): TK-4\.1 is held by the person \("stop everything"\)/);

    // The project commits its migrated adapter on the base.
    p.commit('core', {}, 'adapter 0.8', { push: true });

    const started = wf(p, ['start', 'TK-5'], as);
    assert.match(started.out, /started TK-5\.2/);
    assert.match(started.out, /tracker status: do this now: /);
    const wt = (repo) => path.join(p.root, '.wf-worktrees', 'TK-5.2', repo);
    fs.writeFileSync(path.join(p.tmp, 'c.json'), JSON.stringify(['the notes list is sorted by title']));
    wf(p, ['criteria', '--file', path.join(p.tmp, 'c.json')], as);
    wf(p, ['handoff', 'implementer', '--session', 'claude:impl-07'], as);
    p.commit('core', { 'src/modules/notes/list.mjs': 'export const list = (notes = []) => [...notes].sort((a, b) => a.title.localeCompare(b.title));\n' }, 'sorted notes', { cwd: wt('core') });
    // The 0.7 test module runs as the base holds it; its import of ../browser/ resolves in the extracted `.workflow/`.
    assert.match(wf(p, ['test', 'fast'], { cwd: wt('core'), ...as }).out, /core: fast passed/);

    host.plan({ 1: { findings: [] } });
    const r = wf(p, ['review'], as);
    const [review] = reviewFiles(r.out);
    await waitFor(review);
    assert.match(wf(p, ['review', '--record', review], as).out, /review 1 recorded .*coverage complete.*0 open blocker/);

    // Delivery waits for the tracker status set at start, which the owner sets through its connector.
    const t = transcript({ home: p.home, cwd: p.root, session: owner, start: new Date().toISOString() });
    const d0 = wf(p, ['deliver'], as);
    assert.match(d0.out, /-1 status: pending — .*Item TK-5 to "Doing"/);
    assert.doesNotMatch(d0.out, /0 merge-request/);
    t.human('Implement TK-5.').toolCall('mcp__board__set_status', { issue: 'TK-5', status: 'Doing' }, 'status set to Doing').write();
    // Delivery: the 0.7 delivery module became a merge request the person opens and merges; the engine matches the
    // merge by patch-id. The tracker stages go through the owner's connector.
    const d1 = wf(p, ['deliver'], as);
    assert.match(d1.out, /^-1 status: done$/m);
    assert.match(d1.out, /0 merge-request: done — the person opens a merge request in core/);
    assert.match(d1.out, /1 wait-merged: waiting/);
    git(wt('core'), ['push', '--quiet', 'origin', 'HEAD:trunk']);
    const d1b = wf(p, ['deliver'], as);
    assert.match(d1b.out, /1 wait-merged: done/);
    git(p.repos.core.dir, ['fetch', '--quiet', 'origin']);
    assert.match(git(p.repos.core.dir, ['show', 'origin/trunk:src/modules/notes/list.mjs']), /localeCompare/);
    fs.writeFileSync(/to (\S+comments\/uat\.md)/.exec(d1b.out)[1], 'Open the notes list: the notes are in title order.\n');
    const d2 = wf(p, ['deliver'], as);
    const mark = 'wf:TK-5.2:stage-2:comment';
    assert.match(d2.out, new RegExp(`2 status: pending — .*must end with "${mark}"`));
    // The owner performs the operations through its connector; the engine reads them back from its transcript.
    t.at(new Date().toISOString()).toolCall('mcp__board__add_comment', { issue: 'TK-5', body: `Open the notes list: the notes are in title order.\n\n${mark}` }, 'comment added');
    t.write();
    assert.match(wf(p, ['deliver'], as).out, /2 status: pending — .*Item TK-5 to "Testing"/);
    t.toolCall('mcp__board__set_status', { issue: 'TK-5', status: 'Testing' }, 'status set to Testing').write();
    const d4 = wf(p, ['deliver'], as);
    assert.match(d4.out, /2 status: done/);
    assert.match(d4.out, /3 status: pending — .*labels/);
    // The labels the owner read through its connector: not Urgent, so the label-filtered stages are skipped.
    t.at(new Date(Date.now() + 1000).toISOString()).toolCall('mcp__board__get_issue', { issue: 'TK-5' }, JSON.stringify({ id: 'TK-5', labels: ['Minor'] })).write();
    assert.match(wf(p, ['deliver'], as).out, /delivered: every stage is done/);
    assert.deepEqual(events(p, 'TK-5.2', 'stage').filter((e) => e.data.index >= 3).map((e) => e.data.state), ['pending', 'skipped', 'skipped', 'skipped']);

    assert.match(wf(p, ['close'], as).out, /TK-5\.2 closed \(shipped\)/);
    const rows = fs.readFileSync(path.join(p.env.WF_USER_DIR, 'telemetry', 'modular.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.attempt), ['TK-5.2']);
  } finally {
    p.cleanup();
  }
});
