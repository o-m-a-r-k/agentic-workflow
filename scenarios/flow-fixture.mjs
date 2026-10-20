// Stream 1 scenario setup: the neutral fixture project with every other stream doubled (flow-doubles.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { clearDoubles, setDoubles, worktreeDir } from '../engine/contract.mjs';
import { git, ledgerLines, makeProject, reviewerTranscript, transcript, writeDoubles } from './helpers/index.mjs';
import doubles, { answer } from './flow-doubles.mjs';
import { implements08 as attempt } from '../engine/attempt.mjs';
import { implements08 as flow } from '../engine/flow.mjs';

export { answer, attempt, flow };
export const DOUBLES_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'flow-doubles.mjs');

const KNOBS = ['WF_TEST_NO_TRANSCRIPT', 'WF_TEST_RISKBASE_PASS', 'WF_TEST_FAST_FAIL', 'WF_TEST_ONE_HOST'];

export function setup(opts = {}) {
  const p = makeProject(opts);
  for (const [k, v] of Object.entries(p.env)) process.env[k] = v;
  for (const k of KNOBS) delete process.env[k];
  setDoubles(doubles);
  p.wt = (id, repo) => worktreeDir(p.root, id, repo);
  p.done = () => {
    clearDoubles();
    p.cleanup();
  };
  // A doubles module for a spawned wf, re-exporting this file's.
  p.doublesFile = () => writeDoubles(p, 'flow', `...(await import(${JSON.stringify(DOUBLES_FILE)})).default,`);
  return p;
}

// Start an attempt and set criteria.
export async function started(p, item = 'TK-1', criteria = ['the sum of an empty list is zero']) {
  const s = await attempt.start(p.root, item, { actor: { runtime: 'claude', id: 'owner-1' } });
  if (criteria) await flow.setCriteria(p.root, s.id, { criteria, areas: ['server'] }, { actor: null });
  return s;
}

export const LOW = { level: 'low', why: 'a small change with tests', needs: [] };
export const HIGH = { level: 'high', why: 'it computes a total others rely on', needs: ['second-review', 'failing-test', 'diff-read'] };

// Launch reviewers through bundle + the launch double, write a transcript that read every product file of the seat, and
// record the review. Returns the record result per seat.
export async function review(p, id, perSeat = {}) {
  const { tree, bundles } = await flow.bundle(p.root, id);
  const out = {};
  // A seat already recorded on this tree is not reviewed again (the second seat joins once a judgement needs it).
  const done = ledgerLines(p.root, id).filter((e) => e.type === 'review.recorded' && e.data.tree === tree).map((e) => e.data.seat);
  for (const b of bundles.filter((x) => !done.includes(x.seat))) {
    const { session } = await doubles.launchReviewer(p.root, id, b, { model: b.model, otherHost: b.otherHost });
    const files = b.productFiles.map((f) => path.join(p.wt(id, f.split('/')[0]), f.slice(f.indexOf('/') + 1)));
    const seat = perSeat[b.seat] ?? perSeat.all ?? {};
    reviewerTranscript({ home: p.home, cwd: p.root, files, skip: seat.skip ?? [], session: session.id });
    // First seats judge the risk (low with no needs unless the test says otherwise); the second seat gives `met`.
    const judged = b.seat.startsWith('second') ? { met: seat.met ?? (b.needs ?? []).map((need) => ({ need, met: true, how: 'read the change for it' })) } : { risk: seat.risk ?? LOW };
    out[b.seat] = await flow.recordReview(p.root, id, { session, seat: b.seat, tree, findings: seat.findings ?? [], verified: seat.verified ?? [], ...judged });
  }
  // The fast tests ran on the reviewed tree (`wf review` runs them in parallel).
  for (const repo of Object.keys((await doubles.attemptState(p.root, id)).repos)) await doubles.runTests(p.root, id, repo, 'fast');
  return { tree, bundles, out };
}

// A reviewer transcript that read `files` and wrote `review` (an object) to `output` with its file tool, as a real
// reviewer does; the file is written too. Returns the transcript builder's session.
export function reviewerWrote(p, session, { files, output, review: body, content = JSON.stringify(body) }) {
  const t = transcript({ home: p.home, cwd: p.root, session });
  t.human('Review this change.');
  for (const f of files) t.advance(1).read(f);
  t.advance(1).toolCall('Write', { file_path: output, content }, 'File created');
  t.say('Review written.').write();
  fs.writeFileSync(output, content);
  return t;
}

export const commitWt = (p, id, repo, files, msg = 'change') => p.commit(repo, files, msg, { cwd: p.wt(id, repo) });
export const head = (p, id, repo) => git(p.wt(id, repo), ['rev-parse', 'HEAD']);
export const read = (f) => fs.readFileSync(f, 'utf8');
