import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from './util.mjs';

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// Claude plugins that are installed, enabled and whose marketplace is still known (a plugin whose marketplace
// entry is gone fails to load even though its files are on disk).
function claudePluginSkillDirs(home) {
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  const enabled = readJson(path.join(home, '.claude', 'settings.json'))?.enabledPlugins ?? {};
  const markets = readJson(path.join(home, '.claude', 'plugins', 'known_marketplaces.json')) ?? {};
  const out = [];
  for (const [id, installs] of Object.entries(installed)) {
    const market = id.split('@')[1];
    const ok = enabled[id] !== false && (!market || markets[market]);
    for (const i of installs ?? []) out.push({ id, dir: i.installPath, loads: Boolean(ok), reason: ok ? null : `marketplace ${market} is not registered (re-add it with \`claude plugin marketplace add\`)` });
  }
  return out;
}

// Where a runtime finds a skill: the project, the user's skill folders, or (Claude) an installed plugin.
export function findSkill(root, name, runtime, home = process.env.WF_HOME ?? os.homedir()) {
  const tryDir = (dir, source) => {
    const f = path.join(dir, name, 'SKILL.md');
    return fs.existsSync(f) ? { path: f, sha256: hashFile(f), source } : null;
  };
  if (runtime === 'codex') {
    return tryDir(path.join(root, '.agents', 'skills'), 'project') ?? tryDir(path.join(home, '.codex', 'skills'), 'user') ?? tryDir(path.join(home, '.agents', 'skills'), 'user');
  }
  const local = tryDir(path.join(root, '.claude', 'skills'), 'project') ?? tryDir(path.join(home, '.claude', 'skills'), 'user');
  if (local) return local;
  for (const p of claudePluginSkillDirs(home)) {
    const hit = tryDir(path.join(p.dir, 'skills'), `plugin ${p.id}`) ?? tryDir(path.join(p.dir, '.claude', 'skills'), `plugin ${p.id}`);
    if (hit) return p.loads ? hit : { ...hit, broken: p.reason };
  }
  return null;
}
