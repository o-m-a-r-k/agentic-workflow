import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ok, rawReadback, singleRepoProject, state, tmp, wf, yaml } from './helpers.mjs';

// 0.3.0: tracker access is chosen at onboarding, with the trade-off stated. The connector route (the agent calls the
// tracker's tools) cannot produce a readback wf can verify; the api route can.

const statuses = { started: 'In Progress', delivered: 'Ready for UAT', done: 'Done' };

test('doctor states the tracker mode trade-off; api mode needs its key; the readback says where it came from', () => {
  // Connector mode: a warning naming the gap and the one-line switch.
  const a = singleRepoProject('mode-agent', { tracker: { kind: 'linear', statuses } });
  const d = wf(a.root, ['doctor', '--no-steps']);
  assert.match(d.out, /warning: tracker mode — the linear tracker is driven by the agent's connector: convenient, but the handoff is agent-reported \(recorded "agent-reported, unverified"\), so wf cannot prove the status, the comment or the attachments are the tracker's own answer[\s\S]*fix: let the engine reach it: `wf tracker mode api` \(then the owner runs `wf secrets guide LINEAR_API_KEY`\)/);
  assert.match(d.out, /tracker readback level\n {4}verifiable: agent-reported in this shell \(no Claude Code or Codex session\); host-recorded when the owner runs wf from Claude Code or Codex/);
  assert.match(d.out, /connectors: tracker linear\/connector\n {4}verifiable: the agent acts through its connector/);
  // Api mode without the key catalogued, then catalogued but not set: doctor fails with the exact command.
  const b = singleRepoProject('mode-api', { tracker: { kind: 'linear', via: 'api', statuses } });
  const d1 = wf(b.root, ['doctor', '--no-steps']);
  assert.notEqual(d1.code, 0);
  assert.match(d1.out, /✗ secrets: LINEAR_API_KEY — tracker\.via is api but LINEAR_API_KEY is not catalogued in \.workflow\/secrets\.yaml/);
  const c = singleRepoProject('mode-api-key', { tracker: { kind: 'linear', via: 'api', statuses } }, { '.workflow/secrets.yaml': yaml({ keys: [{ key: 'LINEAR_API_KEY', kind: 'provided', required: true }] }) });
  const d2 = wf(c.root, ['doctor', '--no-steps']);
  assert.match(d2.out, /✗ secrets: LINEAR_API_KEY — tracker\.via is api but LINEAR_API_KEY is not set\n {4}fix: the owner runs `wf secrets guide LINEAR_API_KEY` in their own terminal/);
  // Switching: printed, or written into the adapter with its comments kept.
  const file = path.join(a.root, '.workflow', 'project.yaml');
  fs.writeFileSync(file, `# the adapter\n${fs.readFileSync(file, 'utf8')}`);
  assert.match(ok(wf(a.root, ['tracker', 'mode', 'api'])).out, /set in \.workflow\/project\.yaml:\n {2}tracker:\n {4}via: api\n {4}apiKey: LINEAR_API_KEY/);
  assert.match(ok(wf(a.root, ['tracker', 'mode', 'api', '--write'])).out, /tracker\.via set to api .*commit it on the base branch[\s\S]*wf secrets guide LINEAR_API_KEY/);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# the adapter/);
  assert.match(text, /via: api/);
});

test('a connector readback is labelled agent-reported unless it is the host\'s own saved tool-result file; --comments keeps both results unchanged', () => {
  const { base, root } = singleRepoProject('mode-provenance', { tracker: { kind: 'linear', statuses } });
  const item = 'ENG-320';
  const e = ok(wf(root, ['entry', '--item', item, '--owner', 'o', '--json'])).json();
  const saved = path.join(base, 'issue.json');
  fs.writeFileSync(saved, JSON.stringify({ issue: { identifier: item, description: 'd', state: { name: 'In Progress' } } }));
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', saved, '--attempt', e.id]));
  assert.equal(state(root, e.id).tracker.done[0].provenance, 'agent-reported, unverified');
  assert.match(ok(wf(root, ['status', '--attempt', e.id])).out, /tracker admitted: readback agent-reported, unverified \(an engine route verifies it: `wf tracker mode api\|cli\|files`\)/);
  // The host's tool-result files (Claude Code saves long tool results there), given as issue and comments.
  const home = tmp('home');
  const results = path.join(home, '.claude', 'projects', 'p', 's', 'tool-results');
  fs.mkdirSync(results, { recursive: true });
  const e2 = ok(wf(root, ['entry', '--item', 'ENG-321', '--owner', 'o', '--json'])).json();
  const raw2 = rawReadback('ENG-321', 'In Progress');
  fs.writeFileSync(path.join(results, 'get_issue.json'), JSON.stringify(raw2.issue));
  fs.writeFileSync(path.join(results, 'list_comments.json'), JSON.stringify(raw2.comments));
  ok(wf(root, ['tracker', 'record', '--event', 'admitted', '--capture', path.join(results, 'get_issue.json'), '--comments', path.join(results, 'list_comments.json'), '--attempt', e2.id], { env: { HOME: home } }));
  const done = state(root, e2.id).tracker.done[0];
  assert.equal(done.provenance, 'host tool-result file');
  const kept = JSON.parse(fs.readFileSync(done.capture.path, 'utf8'));
  assert.ok(Array.isArray(kept) && kept.length === 2 && kept[0].id === 'ENG-321' && Array.isArray(kept[1].comments), 'issue and comments kept together, unchanged');
  assert.doesNotMatch(ok(wf(root, ['status', '--attempt', e2.id])).out, /agent-reported/);
});
