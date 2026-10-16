#!/usr/bin/env node
// Gives every session in an agentic-workflow project the plugin's standing rules when it starts (0.7.24, D30), from the
// installed plugin and the project's adapter. Named failure: the rules were a block `wf sync` wrote into each project's
// AGENTS.md, so the project's own instruction file carried the plugin's text, and every plugin release that changed it
// was a commit in every project (0.7.23 changed it in two). The person's rule (2026-10-16): "this is part of the workflow
// plugin or adapter setup. not agents.md". Claude Code and Codex both run a plugin's SessionStart hook and add what it
// prints to the session's context. Outside an enabled project, or on any error, it prints nothing.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRoot, loadConfig } from '../engine/config.mjs';
import { sessionRules } from '../engine/onboard.mjs';

export function rulesFor(cwd) {
  try {
    const root = findRoot(cwd);
    if (!root) return null;
    const cfg = loadConfig(root);
    return cfg.enabled ? sessionRules(root, cfg) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let cwd = process.cwd();
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (typeof input.cwd === 'string' && input.cwd) cwd = input.cwd;
    } catch {}
    const rules = rulesFor(cwd);
    if (rules) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rules } }));
    process.exit(0);
  });
}
