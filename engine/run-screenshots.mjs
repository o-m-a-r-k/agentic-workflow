// The screenshots of one named run (0.7.30, I-198, I-160, D55).
//
// Named failure (I-198, field): a failed browser step kept four failed-case screenshots that `wf evidence list` showed, but
// `wf export screenshots --gate` reads only the last gate's collected `artifacts`, so it said the last gate collected no
// screenshots; the role instructions allow viewing images only through an exported copy, and the implementer diagnosing the
// failure could not look at them. A gate stopped after its first failed case (I-199) had sealed its captures with an empty
// collected list, and captures imported before any full gate (I-160) joined the gate's set only for a tree a gate had run on:
// both were refused the same way. A run is named by its id (the folder `wf evidence list` shows under `gate/`) or an import
// by `import-<n>`; its images are every image the evidence manifest records in that run's folder (collected artifacts, the
// copy of the step's scratch folder, anything else the run wrote) and the captures its step records name elsewhere (a reused
// step's capture lives in the run that collected it), or the files of the import. Each is read the way every export reads
// (engine/evidence.mjs `readEvidenceFile`): inside the attempt evidence, never through a link, its bytes checked against the
// recorded sha256. Nothing here is gate acceptance: a run's images are diagnostic copies, and an import is the gate's
// evidence only for the tree it was made on once a gate passes there (engine/gate.mjs `importedCaptures`).
import path from 'node:path';
import { recordedUnder } from './evidence.mjs';
import { IMAGE } from './evidence-read.mjs';
import { WfError, refuse } from './util.mjs';

const RUN_ID = /^[\w.-]+$/;
const finishedRuns = (state) => [...(state.gates ?? []).map((g) => ({ ...g, kind: 'gate' })), ...(state.checks ?? []).map((g) => ({ ...g, kind: 'check' }))].filter((g) => g.runId);

function importOf(state, run) {
  const m = /^import-(\d+)$/.exec(run);
  return m ? (state.captureImports ?? []).find((i) => Number(i.n) === Number(m[1])) ?? null : null;
}

const importLabel = (i) => `import-${i.n} (imported by the owner${i.at ? ` on ${String(i.at).slice(0, 10)}` : ''}${i.note ? `; ${i.note}` : ''})`;
const runLabel = (g) => `${g.kind} run ${g.runId} (${g.status})`;

// The images the manifest records under the attempt's `gate/` folder, by run id: read once for every run a refusal lists.
function recordedImages(root, state) {
  const byRun = new Map();
  for (const r of recordedUnder(root, state.id, 'gate/')) {
    if (!IMAGE.test(r.rel)) continue;
    const run = r.rel.split('/')[1];
    byRun.set(run, [...(byRun.get(run) ?? []), r]);
  }
  return byRun;
}

// The images of a finished gate or check run: recorded in its folder, and named by its steps' records elsewhere.
function imagesOfRun(g, recorded) {
  const prefix = `gate/${g.runId}/`;
  const seen = new Set();
  const files = [];
  const add = (f) => {
    if (!f.sha256 || seen.has(f.sha256)) return;
    seen.add(f.sha256);
    files.push(f);
  };
  for (const r of recorded.get(g.runId) ?? []) {
    const [step, ...rest] = r.rel.slice(prefix.length).split('/');
    // Where the run wrote it, as the step sees it: inside the step's scratch copy (`out/`) or its collected `artifacts/`.
    const source = ['out', 'artifacts'].includes(rest[0]) && rest.length > 1 ? rest.slice(1).join('/') : rest.join('/');
    add({ path: r.path, sha256: r.sha256, source, step });
  }
  for (const s of g.steps ?? []) for (const a of s.artifacts ?? []) if (a.kind === 'screenshot' || IMAGE.test(String(a.path ?? ''))) add({ path: a.path, sha256: a.sha256, source: a.source ?? path.basename(String(a.path)), step: a.step ?? s.id });
  return files;
}

// Every run and import of the attempt that holds images, with how many: what a refusal names so the route is never guessed.
export function runsWithImages(root, state) {
  const out = [];
  const recorded = recordedImages(root, state);
  for (const g of finishedRuns(state)) {
    const n = imagesOfRun(g, recorded).length;
    if (n) out.push({ run: g.runId, label: runLabel(g), count: n });
  }
  for (const i of state.captureImports ?? []) if (i.files?.length) out.push({ run: `import-${i.n}`, label: importLabel(i), count: i.files.length });
  return out;
}

export const runsText = (runs) => runs.map((r) => `${r.label}: ${r.count}`).join('; ');

// `wf export screenshots --run <id>`: the run (or import) and its images, or a refusal that names the runs that exist.
export function runImages(root, state, run) {
  if (typeof run !== 'string' || !run.trim()) throw new WfError(`usage: wf export screenshots --run <run id | import-<n>> [--to DIR] (a run's folder as \`wf evidence list --attempt ${state.id}\` shows it under gate/, or an import's number)`);
  run = run.trim();
  const imp = importOf(state, run);
  if (imp) return { run, label: importLabel(imp), imported: true, files: (imp.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256, source: f.source ?? path.basename(String(f.path)) })) };
  const g = RUN_ID.test(run) ? finishedRuns(state).find((x) => x.runId === run) : null;
  if (!g) {
    const others = runsWithImages(root, state);
    const where = others.length ? `runs with images: ${runsText(others)}` : 'no run or import of it holds an image';
    if (RUN_ID.test(run) && state.gateRuns?.[run]) throw refuse(`run ${run} of ${state.id} has not finished: its files are recorded when it ends (${where})`, 'wait for it to end, or stop it with `wf stop`; a run whose runner died is recorded by the next `wf gate` or `wf check`, then it exports', { id: 'export:run-open' });
    throw refuse(`no run \`${run}\` in ${state.id}; ${where}`, `name a run as \`wf evidence list --attempt ${state.id}\` shows its folder (gate/<run id>/…), or an import as import-<n>`, { id: 'export:run-unknown' });
  }
  return { run, label: runLabel(g), imported: false, files: imagesOfRun(g, recordedImages(root, state)) };
}
