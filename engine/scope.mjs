import { matchesAny } from './util.mjs';

// Changed files the frozen plan does not name. Named failure: an implementer changed audit-read code outside the
// plan, and nothing pointed the reviewer at it. Informational only: shown in bundles and `wf status`, never blocking.

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

// null when the plan names no paths at all: nothing to compare against.
export function outsidePlan(plan, changed) {
  const paths = planPaths(plan);
  if (!paths.length) return null;
  const out = [];
  for (const [repo, files] of Object.entries(changed)) for (const f of files) if (!paths.some((p) => covered(repo, f, p))) out.push(`${repo}:${f}`);
  return out;
}
