#!/usr/bin/env node
// lane: the floor the facts set for the ticket's lane, from the paths it touches and the project's boundaries.
// Usage: node lane.mjs <ticket-folder> --definition <project definition> [--definition <its .local.md>] [--paths]
//   --paths  read BRIEF.md's "## Paths" (before the build): each "- <repo>/<path or glob>", taken as itself and as the
//            files at the worktree's base it names (the path, the files under it, or the files its glob takes). A line
//            whose first segment is not one of the ticket's repos, or that holds a brace, cannot be placed.
//   without  read the files each worktree changed from its base to HEAD (after the build); build lanes are left out
// Compares those paths with the definition's boundaries (kind → repo-prefixed globs), migrations and page_paths, and
// screen_paths (ticket.mjs's screenOf). The floor is critical when a path is in a boundary or a migration, else none.
// The definition's watch lists (same shape as boundaries) are reported under Watch, for the verifier; never the floor.
// New pages: added files under page_paths; with --paths, listed paths under page_paths that name no file at the base.
// A change that cannot be undone ("Undo: no" in BRIEF.md or at the top of a verify file) sets the floor to critical too.
// An entry of those lists that takes no file at its repo's base is reported as stale (a note; it does not stop).
// It never lowers a lane.
// Writes evidence/lane.md. Exit 1 when the floor is critical and the ticket's lane (STATE.md's "Risk lane:", else
// BRIEF.md's "Lane:") is lower, when no path could be read, or when a brief path cannot be placed; else 0.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ticket, definitionOf, laneFacts, laneRank } from './ticket.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const fromBrief = args.includes('--paths');
const def = definitionOf(args);
const T = ticket(dir);
const F = laneFacts(T, def, fromBrief);
const lane = laneRank(T.lane) >= 0 ? T.lane : T.briefLane;
const below = F.floor === 'critical' && laneRank(lane) < laneRank('critical');
const list = (xs) => (xs.length ? xs.join(', ') : 'none');
const why = F.unplaced.length ? `stop, cannot place ${F.unplaced.length} brief path${F.unplaced.length > 1 ? 's' : ''}` : !F.paths.length ? 'stop, no path could be read' : below ? `stop, the floor is critical and the lane is ${lane || 'not set'}` : 'pass';

const out = [
  `lane: ${why}`,
  `Source: ${fromBrief ? "BRIEF.md's Paths" : 'files changed since each base'} (${F.paths.length} paths)`,
  `Floor: ${F.floor}`,
  ...(F.kinds.length ? F.kinds.map((b) => `Boundary ${b.kind}: ${b.paths.join(', ')}`) : ['Boundaries: none']),
  ...(F.watched.length ? F.watched.map((b) => `Watch ${b.kind}: ${b.paths.join(', ')}`) : ['Watch: none']),
  `Migrations: ${list(F.migrations)}`,
  `Screen: ${F.screenTouched ? 'touched' : 'none'}`,
  `New pages: ${list(F.pages)}`,
  `Brief lane: ${T.briefLane || 'not set'}`,
  `Ticket lane: ${T.lane || 'not set'}`,
  ...F.unplaced.map((p) => `- cannot place "${p}": write "- <repo>/<path or glob>" with a repo of ${T.repos.map((w) => w.name).join(', ') || 'STATE.md'} and no braces`),
  ...F.stale.map((x) => `- stale, takes no file at its repo's base: ${x}; a path that moved no longer sets the floor, so fix the definition`),
  ...(!F.boundaries ? ['- the definition names no boundaries'] : []),
  ...F.notes.map((n) => `- ${n}`),
].join('\n');
mkdirSync(T.ev, { recursive: true });
writeFileSync(join(T.ev, 'lane.md'), out + '\n');
console.log(out);
process.exit(why === 'pass' ? 0 : 1);
