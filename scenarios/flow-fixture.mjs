// Stream 1 scenario setup: the neutral fixture project with every other stream doubled (flow-doubles.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { clearDoubles, setDoubles, worktreeDir } from '../engine/contract.mjs';
import { git, makeProject, reviewerTranscript, writeDoubles } from './helpers/index.mjs';
import doubles, { answer } from './flow-doubles.mjs';
import { implements08 as attempt } from '../engine/attempt.mjs';
import { implements08 as flow } from '../engine/flow.mjs';

export { answer, attempt, flow };
export const DOUBLES_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'flow-doubles.mjs');

const KNOBS = ['WF_TEST_NO_TRANSCRIPT', 'WF_TEST_RISKBASE_PASS', 'WF_TEST_FAST_FAIL'];

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

// Launch reviewers through bundle + the launch double, write a transcript that read every product file of the seat, and
// record the review. Returns the record result per seat.
export async function review(p, id, perSeat = {}) {
  const { tree, bundles } = await flow.bundle(p.root, id);
  const out = {};
  for (const b of bundles) {
    const { session } = await doubles.launchReviewer(p.root, id, b);
    const files = b.productFiles.map((f) => path.join(p.wt(id, f.split('/')[0]), f.slice(f.indexOf('/') + 1)));
    const seat = perSeat[b.seat] ?? perSeat.all ?? {};
    reviewerTranscript({ home: p.home, cwd: p.root, files, skip: seat.skip ?? [], session: session.id });
    out[b.seat] = await flow.recordReview(p.root, id, { session, seat: b.seat, tree, findings: seat.findings ?? [], verified: seat.verified ?? [] });
  }
  return { tree, bundles, out };
}

export const commitWt = (p, id, repo, files, msg = 'change') => p.commit(repo, files, msg, { cwd: p.wt(id, repo) });
export const head = (p, id, repo) => git(p.wt(id, repo), ['rev-parse', 'HEAD']);
export const read = (f) => fs.readFileSync(f, 'utf8');
