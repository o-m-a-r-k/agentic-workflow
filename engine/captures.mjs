// Visual evidence the gate cannot collect (I-94).
//
// Named failure: a ticket froze criteria that required English and Arabic, desktop and narrow screenshots, but the adapter
// pinned at admission had no step that writes any capture, so the full gate passed without images and acceptance found the
// missing route only at the end; the way out was a late criteria-reference workaround. Two facts are now stated while they
// can still be acted on, and one supported route exists:
//   - `captureWarning`: a criterion names screenshots as its evidence and no step of the attempt can collect any (a step
//     needs `artifacts` globs or a plugin, the same test `captureRoutes` hands the planner). Said at `wf plan`, at
//     `wf criteria amend` and on every status and resume line until a route exists. Never a refusal: the criterion's
//     wording is a heuristic, and the owner can always take the import route below.
//   - `wf captures import`: the owner brings in captures made by hand on the committed tree. Each file is read once without
//     following a link, copied into the attempt's managed evidence by wf (write-once, read-only, hash-recorded like a gate
//     artifact) and recorded in the ledger with the tree, who imported it and how it was made. From then on it is one of
//     the gate's screenshots for that tree (engine/gate.mjs `screenshots`): the reviewer is handed it and must inspect it,
//     acceptance and delivery read it, and it is left behind by any later change to the tree, as a gate's are.
import fs from 'node:fs';
import path from 'node:path';
import { actor, openState, treeHashes } from './attempt.mjs';
import { append, attemptDir, loadState } from './ledger.mjs';
import { prepareWrite, readRegular, withEvidenceTransaction, writeNoFollow } from './evidence.mjs';
import { mkdirStateDirectory } from './state-folders.mjs';
import { gateAdapter } from './validation.mjs';
import { WfError, canonical, git, refuse, sha256 } from './util.mjs';

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
// What a criterion says when it names a screenshot as the way to see that it holds.
const SCREENSHOT = /\bscreen[\s-]?(?:shots?|captures?|grabs?)\b/i;

// Whether a criterion needs screenshot evidence, from what it already carries. A criterion that states its evidence
// (`evidence: screenshot`, or a list of kinds, the vocabulary of the reviewer's evidence map) is taken at its word, so a
// criterion that mentions screenshots in passing says `evidence: test` and is not counted. One that states none needs them
// when its `text` or its `uat` speaks of screenshots or screen captures, unless it says there is nothing to see (`uat: false`).
export function needsScreenshots(criterion) {
  const kinds = [criterion?.evidence].flat().map((x) => (typeof x === 'string' ? x : x?.kind)).filter((x) => typeof x === 'string' && x.trim());
  if (kinds.length) return kinds.some((k) => /^screenshots?$/i.test(k.trim()));
  if (criterion?.uat === false) return false;
  return SCREENSHOT.test(`${criterion?.text ?? ''} ${typeof criterion?.uat === 'string' ? criterion.uat : ''}`);
}

// The gate steps that can write captures for this attempt: a step of an admitted repo with `artifacts` globs or a plugin
// (a plugin returns its captures as artifacts), the steps `captureRoutes` hands the planner.
export const capturingSteps = (cfg, state) => cfg.gate.steps.filter((s) => state.repos?.[s.repo] && (s.artifacts?.length || s.plugin));

// The criteria that need screenshots and have no way to get them: the line the owner reads, or null.
export function captureWarning(root, state) {
  if (!state.criteria?.length || ['accepted', 'handoff-pending', 'done', 'abandoned'].includes(state.phase)) return null;
  const needs = state.criteria.filter(needsScreenshots).map((c) => c.id);
  if (!needs.length) return null;
  let cfg;
  try {
    cfg = gateAdapter(root, state);
  } catch {
    return null;
  }
  if (capturingSteps(cfg, state).length) return null;
  let tree = null;
  try {
    tree = canonical(treeHashes(state));
  } catch {}
  const imports = state.captureImports ?? [];
  const here = imports.filter((i) => tree && canonical(i.tree) === tree);
  const covered = new Set(here.flatMap((i) => (i.criteria?.length ? i.criteria : needs)));
  const open = needs.filter((id) => !covered.has(id));
  if (!open.length) return null;
  const earlier = imports.length && !here.length ? ` Captures imported earlier were made on an earlier tree; import them again from the current one.` : '';
  return `${open.join(', ')} ${open.length > 1 ? 'name' : 'names'} screenshots as evidence, but no gate step of this attempt collects any (a step needs \`artifacts\` globs or a plugin), so acceptance would find nothing to inspect. Once the work is committed, bring in captures made on that tree with \`wf captures import --from <folder> --attempt ${state.id}\` (they join the gate's screenshots, bound to the tree and recorded by wf), or register a collecting step with \`wf validation add\`.${earlier}`;
}

function listImages(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listImages(path.join(dir, e.name), r, out);
    else out.push(r);
  }
  return out;
}

// `wf captures import --from <folder> | --file <image> [--criteria C5,C6] [--note "how they were made"] [--for <member>]`.
export function importCaptures(root, options) {
  const opened = openState(root, options);
  return withEvidenceTransaction(root, opened.id, () => importLocked(root, options, loadState(root, opened.id)));
}

function importLocked(root, options, state) {
  const usage = 'usage: wf captures import --from <folder of images> | --file <image> [--criteria C5,C6] [--note "how they were made"] [--attempt ID]';
  if ((typeof options.from === 'string') === (typeof options.file === 'string')) throw new WfError(`give the folder of captures (--from) or one image (--file), not both and not neither\n${usage}`);
  if (['handoff-pending', 'done', 'abandoned'].includes(state.phase)) throw refuse(`${state.id} is ${state.phase}; captures are imported while the work is being reviewed`, undefined, { id: 'captures:closed' });
  const trees = treeHashes(state);
  // Named failure (I-94): a capture added after the review was accepted would be delivered without a reviewer having
  // inspected it; the evidence review inspects every screenshot of the tree it is handed.
  if (state.accepted && canonical(state.accepted.heads) === canonical(trees)) throw refuse(`the review of this tree is accepted: captures imported now would reach the delivery without a reviewer inspecting them`, 'import before the evidence review; after a fix the tree changes and the review runs again', { id: 'captures:after-acceptance' });
  // A capture says nothing about a tree that is not committed: the record binds it to the commits of every repo.
  if (Object.values(trees).some((t) => t.includes('+dirty'))) throw refuse('commit the change before importing captures: they are bound to the committed tree they were made on', 'commit through the implementer, then make the captures and import them', { id: 'captures:uncommitted-tree' });
  const criteria = typeof options.criteria === 'string' ? [...new Set(options.criteria.split(',').map((x) => x.trim()).filter(Boolean))] : [];
  const unknown = criteria.filter((id) => !(state.criteria ?? []).some((c) => c.id === id));
  if (options.criteria !== undefined && (!criteria.length || unknown.length)) throw refuse(`--criteria names frozen criteria (${(state.criteria ?? []).map((c) => c.id).join(', ') || 'none are frozen yet'})${unknown.length ? `, not ${unknown.join(', ')}` : ''}`, undefined, { id: 'captures:criteria' });
  // A batch's captures are delivered by the member they show: it names which.
  let units = [state.id];
  if (state.lane === 'batch') {
    const member = typeof options.for === 'string' ? options.for : null;
    if (!member || !(state.batch?.members ?? []).includes(member)) throw refuse(`${state.id} is a batch: say which member the captures show with --for (members: ${(state.batch?.members ?? []).join(', ') || 'none'})`, undefined, { id: 'captures:batch-member' });
    units = [member];
  }
  const from = typeof options.from === 'string' ? options.from : null;
  const names = from ? listImages(from) : [path.basename(String(options.file))];
  const sources = names.map((rel) => ({ rel, abs: from ? path.join(from, ...rel.split('/')) : String(options.file) }));
  const earlier = new Set((state.captureImports ?? []).filter((i) => canonical(i.tree) === canonical(trees)).flatMap((i) => i.files.map((f) => f.sha256)));
  const n = (state.captureImports?.length ?? 0) + 1;
  const dir = attemptDir(root, state.id);
  const committedAt = Math.max(0, ...Object.values(state.repos).map((r) => Number(git(r.worktree, ['log', '-1', '--format=%ct', 'HEAD'], { allowFail: true })) || 0)) * 1000;
  const files = [];
  const skipped = [];
  const seen = new Set();
  let ignored = 0;
  for (const { rel, abs } of sources) {
    if (!IMAGE.test(rel)) {
      ignored += 1;
      continue;
    }
    if (/[\u0000-\u001f\u007f\\]/.test(rel)) {
      skipped.push({ file: rel, why: 'not a usable file name' });
      continue;
    }
    const read = readRegular(abs);
    if (!read) {
      skipped.push({ file: rel, why: 'not a regular file with one name (a link, or a file with another name, is never read)' });
      continue;
    }
    if (!read.bytes.length) {
      skipped.push({ file: rel, why: 'empty: nothing was captured' });
      continue;
    }
    const digest = sha256(read.bytes);
    if (earlier.has(digest) || seen.has(digest)) {
      skipped.push({ file: rel, why: 'already imported for this tree' });
      continue;
    }
    seen.add(digest);
    const dest = path.join(dir, 'captures', `import-${n}`, ...rel.split('/'));
    prepareWrite(dest);
    mkdirStateDirectory(path.dirname(dest), { recursive: true });
    writeNoFollow(dest, read.bytes, { exclusive: true });
    const modifiedMs = read.st.mtimeMs;
    files.push({ path: dest, sha256: digest, kind: 'screenshot', source: `import-${n}/${rel}`, units, origin: 'imported by the owner', import: n, modifiedAt: new Date(modifiedMs).toISOString(), ...(modifiedMs < committedAt ? { madeBeforeLastCommit: true } : {}) });
  }
  if (!files.length) throw refuse(`no capture imported from ${from ?? options.file}${skipped.length ? `:\n  - ${skipped.slice(0, 10).map((s) => `${s.file}: ${s.why}`).join('\n  - ')}` : ignored ? ` (${ignored} file(s) that are not png, jpeg, webp or gif images were ignored)` : ''}`, 'give a folder that holds png, jpeg, webp or gif files made on the committed tree', { id: 'captures:none' });
  const note = typeof options.note === 'string' ? options.note.trim() : '';
  append(root, state.id, 'captures.imported', { n, tree: trees, files, from: from ?? String(options.file), ...(criteria.length ? { criteria } : {}), ...(note ? { note } : {}), ...(skipped.length ? { skipped } : {}), ...(ignored ? { ignored } : {}) }, actor(options));
  const late = files.filter((f) => f.madeBeforeLastCommit);
  const text = `${files.length} capture(s) imported into ${state.id} as import ${n}, bound to the committed tree${criteria.length ? ` for ${criteria.join(', ')}` : ''}:\n${files.map((f) => `  ${f.source}  sha256 ${f.sha256.slice(0, 12)}`).join('\n')}${skipped.length ? `\nskipped ${skipped.length}: ${skipped.slice(0, 5).map((s) => `${s.file} (${s.why})`).join('; ')}${skipped.length > 5 ? '; …' : ''}` : ''}${late.length ? `\nnote: ${late.length} of them were saved before the last commit of this tree; the reviewer is told, and judges whether they show it` : ''}\nthey are the gate's screenshots for this tree: once a gate has passed on it the evidence reviewer must inspect each; any later change to the tree leaves them behind (import again from the new tree)`;
  return { text, record: { attempt: state.id, import: n, tree: trees, files, skipped } };
}
