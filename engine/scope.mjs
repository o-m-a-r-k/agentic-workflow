import { matchesAny } from './util.mjs';

// Changed files the frozen plan does not name. Named failures: an implementer changed audit-read code outside the plan
// and the reviewer marked it minor; a capture fix and an e2e build change with .gitignore entries were covered by no
// criterion until the owner amended after the review. The owner is warned before the review (`wf status`, `wf gate`,
// `wf check`, `wf handoff reviewer`), and `wf accept` needs the reviewer's verdict per file (`outsideVerdicts`).

// A plan entry names a file as `path`, `path:line ...`, `repo/path`, a directory ending in `/`, or a glob.
function planPaths(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const out = [];
  const take = (v) => {
    for (const item of [v].flat()) {
      if (typeof item !== 'string') continue;
      for (const tok of item.split(/\s+/)) {
        const p = tok.replace(/^[`'"([]+|[`'",)\]]+$/g, '').replace(/:\d+(?:-\d+)?$/, '').replace(/:$/, '');
        if (p && /[/*]|\.\w+$/.test(p) && !/^https?:/.test(p) && !p.startsWith('-')) out.push(p);
      }
    }
  };
  take(plan.anchors);
  take(plan.tests?.changed);
  take(plan.tests?.run);
  return [...new Set(out)];
}

function covered(repo, file, p) {
  const candidates = [file, `${repo}/${file}`];
  return candidates.some((f) => f === p || f.endsWith(`/${p}`) || (p.endsWith('/') && (f.startsWith(p) || f.includes(`/${p}`))) || (/[*?{]/.test(p) && matchesAny(f, [p])));
}

const inside = (file, dir) => dir === '.' || dir === '' || file === dir || file.startsWith(`${dir.replace(/\/$/, '')}/`);
const relTo = (file, dir) => (dir === '.' || dir === '' ? file : file.slice(dir.replace(/\/$/, '').length + 1));

// Not scope: the plugin's own evidence and worktree paths, a package's `docsOnly` files and the files a step `ignores`
// (generated output), each relative to its package. Without the adapter nothing is filtered.
export function scopeNoise(cfg, repo, file) {
  if (/(^|\/)\.wf-(evidence|worktrees)\//.test(file)) return true;
  const r = cfg?.repos?.find((x) => x.name === repo);
  if (!r) return false;
  for (const pkg of r.packages ?? []) if (inside(file, pkg.path) && pkg.docsOnly?.length && matchesAny(relTo(file, pkg.path), pkg.docsOnly)) return true;
  for (const step of cfg.gate?.steps ?? []) {
    if (step.repo !== repo || !step.ignores?.length) continue;
    const pkg = step.package ? r.packages.find((p) => p.name === step.package || p.path === step.package) : r.packages[0];
    if (pkg && inside(file, pkg.path) && matchesAny(relTo(file, pkg.path), step.ignores)) return true;
  }
  return false;
}

// null when the plan names no paths at all: nothing to compare against.
export function outsidePlan(plan, changed, cfg = null) {
  const paths = planPaths(plan);
  if (!paths.length) return null;
  const out = [];
  for (const [repo, files] of Object.entries(changed)) for (const f of files) if (!scopeNoise(cfg, repo, f) && !paths.some((p) => covered(repo, f, p))) out.push(`${repo}:${f}`);
  return out;
}

// The reviewer's verdict per outside-plan file: `{ file, verdict: covered|finding, by, evidence }`. `covered` names a
// criterion (amended criteria included) in `by`; anything no criterion covers is a `finding` naming a finding id of
// the closure (in `by` or `finding`). Evidence is one line.
export function outsideVerdicts(files, closure, criteria) {
  const entries = Array.isArray(closure?.outsidePlan) ? closure.outsidePlan : [];
  const criterionIds = new Set((criteria ?? []).filter((c) => !c.dropped).map((c) => c.id));
  const findingIds = new Set((closure?.findings ?? []).map((f) => f.id));
  const problems = [];
  const verdicts = [];
  for (const file of files ?? []) {
    const plain = file.replace(/^[^:]+:/, '');
    const e = entries.find((x) => x?.file === file) ?? entries.find((x) => x?.file === plain);
    const by = String(e?.by ?? e?.finding ?? '').trim();
    if (!e) problems.push(`${file}: no verdict`);
    else if (!['covered', 'finding'].includes(e.verdict)) problems.push(`${file}: verdict must be covered (with \`by\`: a criterion id) or finding (with the finding id), not \`${e.verdict}\``);
    else if (!String(e.evidence ?? '').trim()) problems.push(`${file}: ${e.verdict} needs evidence`);
    else if (e.verdict === 'covered' && !criterionIds.has(by)) problems.push(`${file}: covered by \`${by || '?'}\`, which is not a criterion (known: ${[...criterionIds].join(', ') || 'none'}); a change no criterion covers is a finding, or the owner amends the criteria first`);
    else if (e.verdict === 'finding' && !findingIds.has(by)) problems.push(`${file}: a finding verdict names a finding id of this closure (known: ${[...findingIds].join(', ') || 'none'})`);
    else verdicts.push({ file, verdict: e.verdict, by, evidence: String(e.evidence) });
  }
  return { problems, verdicts };
}
