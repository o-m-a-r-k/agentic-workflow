#!/usr/bin/env node
// Gives every session and subagent in a project the plugin's standing rules (D30): templates/session-rules.md filled
// from the adapter, with the project's invariants as written. Outside a project, or on any error: no output, exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function rulesFor(cwd, env = process.env) {
  try {
    const { findProject, loadAdapter } = await import('../engine/contract.mjs');
    const found = await findProject(cwd, { env });
    if (!found) return null;
    const a = await loadAdapter(found.root, { env });
    const tpl = fs.readFileSync(path.join(PLUGIN, 'templates', 'session-rules.md'), 'utf8');
    const file = a.invariants ? path.join(a.root, a.invariants) : null;
    const invariants = file && fs.existsSync(file) ? `\nThe project's critical invariants (\`${a.invariants}\`):\n\n${fs.readFileSync(file, 'utf8').trim()}` : '';
    const tracker = typeof a.ticketing?.tracker === 'string' ? a.ticketing.tracker : a.ticketing?.tracker?.module ? 'a project module' : 'none';
    const delivery = (a.delivery?.stages ?? []).map((s) => s.do).join(', ') || 'none';
    return tpl.replaceAll('{project}', a.name).replaceAll('{tracker}', tracker).replaceAll('{delivery}', delivery).replaceAll('{invariants}', invariants).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', async () => {
    let cwd = process.cwd();
    let event = 'SessionStart';
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (typeof input.cwd === 'string' && input.cwd) cwd = input.cwd;
      if (input.hook_event_name === 'SubagentStart') event = 'SubagentStart';
    } catch {}
    const rules = await rulesFor(cwd);
    if (rules) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: rules } }));
  });
}
