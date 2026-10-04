import path from 'node:path';
import { matchesAny } from './util.mjs';

const posix = (p) => p.split(path.sep).join('/');
const inside = (file, dir) => dir === '.' || dir === '' || file === dir || file.startsWith(`${dir.replace(/\/$/, '')}/`);
const rel = (file, dir) => (dir === '.' || dir === '' ? file : file.slice(dir.replace(/\/$/, '').length + 1));

// The package a repo-relative file belongs to: the deepest matching package path.
export function packageOf(repo, file) {
  return [...repo.packages].filter((p) => inside(file, p.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export function componentsOf(cfg, repoName, file) {
  return cfg.components.filter((c) => c.repo === repoName && inside(file, c.package ?? '.'));
}

// Root-relative path of a repo-relative file, so contracts can be named across repos.
export const rootPath = (cfg, repoName, file) => {
  const repo = cfg.repos.find((r) => r.name === repoName);
  return posix(path.posix.normalize(path.posix.join(repo.path, file)));
};

function providerContracts(cfg, comp) {
  const repo = cfg.repos.find((r) => r.name === comp.repo);
  return (comp.provides ?? []).filter((p) => p.spec).map((p) => posix(path.posix.join(repo.path, comp.package ?? '.', p.spec)));
}

// changed: { repoName: [repo-relative files] }.
export function impact(cfg, changed) {
  const touched = new Set();
  const contractsChanged = [];
  const rootFiles = [];
  for (const [repoName, files] of Object.entries(changed)) {
    for (const f of files) {
      for (const c of componentsOf(cfg, repoName, f)) touched.add(c.id);
      rootFiles.push(rootPath(cfg, repoName, f));
    }
  }
  for (const comp of cfg.components) {
    for (const spec of providerContracts(cfg, comp)) {
      if (rootFiles.some((f) => f === spec || matchesAny(f, [spec]))) contractsChanged.push({ component: comp.id, contract: spec });
    }
  }
  for (const consumer of cfg.components) {
    for (const d of consumer.dependsOn ?? []) {
      if (d.contract && rootFiles.some((f) => f === d.contract || matchesAny(f, [d.contract]))) contractsChanged.push({ component: d.component, contract: d.contract });
    }
  }
  const seen = new Set();
  for (let i = contractsChanged.length - 1; i >= 0; i--) {
    const k = `${contractsChanged[i].component}|${contractsChanged[i].contract}`;
    if (seen.has(k)) contractsChanged.splice(i, 1);
    else seen.add(k);
  }
  const dependents = new Set();
  for (const { component } of contractsChanged) {
    for (const c of cfg.components) if ((c.dependsOn ?? []).some((d) => d.component === component)) dependents.add(c.id);
  }
  const crossed = [];
  for (const c of cfg.components) {
    for (const d of c.dependsOn ?? []) {
      if (touched.has(c.id) || touched.has(d.component)) crossed.push({ from: c.id, to: d.component, via: d.via ?? null, contract: d.contract ?? null });
    }
  }
  return {
    touched: [...touched].sort(),
    contractsChanged,
    dependents: [...dependents].filter((d) => !contractsChanged.some((c) => c.component === d)).sort(),
    crossed,
  };
}

// Providers before consumers. Repos without components keep their configured order.
export function deliveryOrder(cfg, repoNames) {
  if (cfg.delivery.order) {
    const listed = cfg.delivery.order.filter((r) => repoNames.includes(r));
    return [...listed, ...repoNames.filter((r) => !listed.includes(r))]; // never drop a repo that has changes
  }
  const deps = new Map(repoNames.map((r) => [r, new Set()]));
  for (const c of cfg.components) {
    for (const d of c.dependsOn ?? []) {
      const provider = cfg.components.find((x) => x.id === d.component);
      if (provider && provider.repo !== c.repo && deps.has(c.repo) && deps.has(provider.repo)) deps.get(c.repo).add(provider.repo);
    }
  }
  const order = [];
  const visiting = new Set();
  const visit = (r) => {
    if (order.includes(r) || visiting.has(r)) return;
    visiting.add(r);
    for (const p of deps.get(r)) visit(p);
    order.push(r);
  };
  for (const r of repoNames) visit(r);
  return order;
}

export { inside, rel };
