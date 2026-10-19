// End to end, the real `wf` with no doubles: a project of two repos on different bases whose tests, tracker and delivery
// are its own modules, loaded as each repo's fetched base holds them. The test module imports a helper from a sibling
// folder (`../lib/`), which resolves because the loader extracts the module's top-level folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, makeProject, writeTrackerModule } from './helpers/index.mjs';
import { events, fakeReviewerHost, reviewFiles, waitFor, wf } from './e2e-support.mjs';

const UNIT = 'import { runNode } from "../lib/runner.mjs";\nexport default async (ctx) => runNode(ctx.cwd, "test/check.mjs");\n';
const RUNNER = 'import { spawnSync } from "node:child_process";\nexport const runNode = (cwd, file) => { const r = spawnSync(process.execPath, [file], { cwd, encoding: "utf8" }); return { pass: r.status === 0, log: `base runner: ${r.stdout}${r.stderr}` }; };\n';
// The project's delivery: push each repo's accepted commit to its own base, then report it.
const SHIP = 'import { spawnSync } from "node:child_process";\nexport default async ({ repos }) => {\n  const out = {};\n  for (const [name, r] of Object.entries(repos)) {\n    const p = spawnSync("git", ["push", "--quiet", r.remote, `${r.tip}:refs/heads/${r.base}`], { cwd: r.dir, encoding: "utf8" });\n    if (p.status !== 0) return { state: "waiting", evidence: { repos: out }, next: p.stderr };\n    out[name] = { accepted: r.tip, base: r.base };\n  }\n  return { state: "done", evidence: { repos: out } };\n};\n';

function project() {
  const p = makeProject({
    name: 'modular',
    overrides: {
      repos: [
        { name: 'server', path: 'server', base: 'trunk', tests: { fast: { module: { repo: 'server', path: '.workflow/steps/unit.mjs' } }, full: { module: { repo: 'server', path: '.workflow/steps/unit.mjs' } } }, kinds: { tests: ['test/**'], other: ['**/*.md'] } },
        { name: 'client', path: 'client', base: 'stable', tests: { fast: { run: 'node -e "process.exit(0)"' } }, kinds: { tests: ['test/**'], other: ['**/*.md'] } },
      ],
      screens: { routes: { repo: 'client', path: 'scripts/routes-of.mjs' }, shared: [], sentinel: [], langs: [{ lang: 'l1', dir: 'ltr' }], viewports: [400] },
      risk: 'none',
      delivery: { landing: 'direct', order: ['server', 'client'], stages: [{ do: 'module', module: { repo: 'server', path: '.workflow/delivery/ship.mjs' } }, { do: 'status', to: 'Ready', comment: 'uat' }] },
    },
  });
  const trackerState = path.join(p.tmp, 'tracker.json');
  writeTrackerModule(p.repos.server.dir, '.workflow/tracker.mjs', trackerState);
  p.commit('server', {
    '.workflow/steps/unit.mjs': UNIT,
    '.workflow/lib/runner.mjs': RUNNER,
    '.workflow/delivery/ship.mjs': SHIP,
    'test/check.mjs': 'import { routes } from "../src/routes/items.controller.mjs";\nif (!routes.includes("/items")) { console.error("no /items route"); process.exit(1); }\nconsole.log("routes ok");\n',
  }, 'project modules', { push: true });
  const tracker = () => JSON.parse(fs.readFileSync(trackerState, 'utf8'));
  return { p, tracker };
}

test('modules: tests, tracker and delivery are the project\'s modules, on two repos with different bases', async () => {
  const { p, tracker } = project();
  const host = fakeReviewerHost(p);
  try {
    const s = wf(p, ['start', 'TK-1']);
    assert.match(s.out, /server: .*branch wf\/TK-1\.1 at trunk/);
    assert.match(s.out, /client: .*branch wf\/TK-1\.1 at stable/);
    assert.equal(tracker().issues.find((i) => i.id === 'TK-1').status, 'Started');
    const wt = (repo) => path.join(p.root, '.wf-worktrees', 'TK-1.1', repo);

    fs.writeFileSync(path.join(p.tmp, 'c.json'), JSON.stringify(['the items list also serves /items/archived', 'the items page links to the archived list']));
    wf(p, ['criteria', '--file', path.join(p.tmp, 'c.json')]);
    wf(p, ['handoff', 'implementer', '--session', 'claude:impl-m']);
    p.commit('server', { 'src/routes/items.controller.mjs': 'export const routes = ["/items", "/items/archived"];\n' }, 'archived route', { cwd: wt('server') });
    p.commit('client', { 'src/pages/items.mjs': 'export const page = "/items";\nexport const archived = "/items/archived";\n' }, 'archived link', { cwd: wt('client') });

    // The server's fast tests run the base's module, which imports its helper from ../lib, against the worktree's code.
    // The worktree's own copy of the module (edited here to fail) is not what runs.
    fs.writeFileSync(path.join(wt('server'), '.workflow', 'lib', 'runner.mjs'), 'export const runNode = () => ({ pass: false, log: "worktree copy" });\n');
    const fast = wf(p, ['test', 'fast'], { cwd: wt('server') });
    assert.match(fast.out, /server: fast passed/);
    const log = /Log: (\S+)/.exec(fast.out)[1];
    assert.match(fs.readFileSync(log, 'utf8'), /base runner: routes ok/);
    git(wt('server'), ['checkout', '--', '.workflow/lib/runner.mjs']);
    wf(p, ['test', 'fast'], { cwd: wt('server') });
    wf(p, ['test', 'fast'], { cwd: wt('client') });

    // The review: the bundle names the consumer of the changed contract; an `other` finding on code the change did not
    // write is filed through the tracker module, searched first, with its marker.
    host.plan({ 1: { findings: [{ location: 'client/README.md:1', class: 'other', severity: 'low', what: 'the readme names no page', why: 'new readers cannot find the items page' }] } });
    const r = wf(p, ['review']);
    const [file] = reviewFiles(r.out);
    const prompt = fs.readFileSync(path.join(path.dirname(file), 'prompt-whole.md'), 'utf8');
    assert.match(prompt, /Consumers of changed contracts \(check each still works\):\n- \S+\/client\/scripts\/routes-of\.mjs/);
    await waitFor(file);
    const rec = wf(p, ['review', '--record', file]);
    assert.match(rec.out, /review 1 recorded .*1 finding\(s\), 0 open blocker\(s\)/);
    const filed = tracker().issues.filter((i) => i.body.includes('wf:TK-1.1:finding:F1'));
    assert.equal(filed.length, 1);
    assert.deepEqual(filed[0].labels, ['found-in-review']);
    assert.ok(tracker().log.indexOf(`search marker wf:TK-1.1:finding:F1`) < tracker().log.findIndex((l) => l.startsWith('create ')));
    assert.equal(events(p, 'TK-1.1', 'finding.filed')[0].data.ticket, filed[0].id);

    // Delivery through the project's module: each repo's part goes to its own base.
    const d1 = wf(p, ['deliver']);
    assert.match(d1.out, /0 module: done/);
    git(p.repos.server.dir, ['fetch', '--quiet', 'origin']);
    git(p.repos.client.dir, ['fetch', '--quiet', 'origin']);
    assert.match(git(p.repos.server.dir, ['show', 'origin/trunk:src/routes/items.controller.mjs']), /\/items\/archived/);
    assert.match(git(p.repos.client.dir, ['show', 'origin/stable:src/pages/items.mjs']), /archived/);
    const comment = /to (\S+comments\/uat\.md)/.exec(d1.out)[1];
    fs.writeFileSync(comment, 'Open the items page and follow the archived link.\n');
    assert.match(wf(p, ['deliver']).out, /delivered/);
    const issue = tracker().issues.find((i) => i.id === 'TK-1');
    assert.equal(issue.status, 'Ready');
    assert.equal(issue.comments.length, 1);

    // Close as shipped: every commit is on its base.
    const c = wf(p, ['close']);
    assert.match(c.out, /closed \(shipped\)/);
    const row = JSON.parse(fs.readFileSync(path.join(p.env.WF_USER_DIR, 'telemetry', 'modular.jsonl'), 'utf8').trim());
    assert.equal(row.findings.other, 1);
    assert.equal(row.findings.filed, 1);
    assert.deepEqual(events(p, 'TK-1.1', 'attempt.closed')[0].data.patchIds.map((x) => x.repo).sort(), ['client', 'server']);
  } finally {
    p.cleanup();
  }
});
