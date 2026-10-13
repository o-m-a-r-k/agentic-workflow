import os from 'node:os';
import { findHost, optional } from './hosts/index.mjs';

// Where a runtime finds a skill: the project, the user's skill folders, or an installed enabled plugin (the harness
// adapter knows its own folders and plugin list). `options` carries a plugin-list provider for scenarios.
export function findSkill(root, name, runtime, home = process.env.WF_HOME ?? os.homedir(), options = {}) {
  return optional(findHost(runtime), 'findSkill')?.(root, name, { home, ...options }) ?? null;
}
