// Where Codex finds a skill: the project, the user's skill folders, or an installed enabled plugin (its own plugin list is
// authoritative for installed versions and enabled state).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashFile } from '../util.mjs';

const directories = (folder) => {
  try { return fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
};
function enabledCodexPlugins(hostHome, marketplace) {
  // The native list is authoritative for installed versions/enabled state. Never infer availability from a cache.
  // Synthetic homes use the injected provider in scenarios and never read this user's actual plugin configuration.
  if (path.resolve(hostHome) !== path.resolve(os.homedir())) return { installed: [] };
  const result = spawnSync('codex', ['plugin', 'list', '--marketplace', marketplace, '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  try { if (result.status === 0) return JSON.parse(result.stdout); } catch {}
  return { problem: `Codex could not verify installed plugins from ${marketplace}; check \`codex plugin list --marketplace ${marketplace} --json\`` };
}
function codexPluginSkill(name, hostHome, listPlugins) {
  // Named failure I-37: Codex native plugin skills were absent from findSkill, even when installed and enabled.
  const parts = name.split(':');
  const leaf = parts.at(-1), prefix = parts.length === 2 ? parts[0] : null;
  if (parts.length > 2 || !/^[A-Za-z0-9_-]+$/.test(leaf) || (prefix && !/^[A-Za-z0-9_-]+$/.test(prefix))) return null;
  const cache = path.join(hostHome, '.codex', 'plugins', 'cache');
  const hits = [], failures = [];
  for (const marketplace of directories(cache).filter((n) => /^[A-Za-z0-9_-]+$/.test(n))) {
    const candidates = directories(path.join(cache, marketplace)).filter((n) => (!prefix || n === prefix) && /^[A-Za-z0-9_-]+$/.test(n));
    const containing = candidates.filter((plugin) => directories(path.join(cache, marketplace, plugin)).some((version) => ['skills', '.claude/skills'].some((folder) => fs.existsSync(path.join(cache, marketplace, plugin, version, folder, leaf, 'SKILL.md')))));
    if (!containing.length) continue;
    const listed = listPlugins(hostHome, marketplace);
    if (listed.problem) { failures.push(listed.problem); continue; }
    for (const plugin of listed.installed ?? []) {
      if (plugin.installed !== true || plugin.enabled !== true || !containing.includes(plugin.name) || !/^[A-Za-z0-9_.-]+$/.test(plugin.version ?? '')) continue;
      for (const folder of ['skills', '.claude/skills']) {
        const file = path.join(cache, marketplace, plugin.name, plugin.version, folder, leaf, 'SKILL.md');
        if (fs.existsSync(file)) { hits.push({ path: file, sha256: hashFile(file), source: `plugin ${plugin.pluginId ?? `${plugin.name}@${marketplace}`}` }); break; }
      }
    }
  }
  if (failures.length) return { broken: failures.join('; ') };
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ...hits[0], broken: `skill ${name} is supplied by several enabled Codex plugins; vendor the chosen skill into .workflow/skills/` };
  return null;
}


export function findSkill(root, name, { home, codexPlugins = enabledCodexPlugins }) {
  const tryDir = (dir, source) => {
    const f = path.join(dir, name, 'SKILL.md');
    return fs.existsSync(f) ? { path: f, sha256: hashFile(f), source } : null;
  };
  return tryDir(path.join(root, '.agents', 'skills'), 'project') ?? tryDir(path.join(home, '.codex', 'skills'), 'user') ?? tryDir(path.join(home, '.agents', 'skills'), 'user') ?? codexPluginSkill(name, home, codexPlugins);
}
