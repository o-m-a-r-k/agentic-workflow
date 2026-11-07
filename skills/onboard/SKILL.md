---
name: onboard
description: Write or re-evaluate a project's definition for the deliver skill with the person, proven on a practice ticket. Use when asked to set up, onboard or re-evaluate a project.
---

# Onboard

**Goal.** A definition from which a fresh agent, knowing nothing else, can take a ticket from started to delivered in this project. A description nobody has used is a guess, so prove it by use. It serves `../deliver/WORKFLOW.md`, beside this skill's folder; read that first.

## Method

1. **Describe** how the project delivers, from its own sources (repos, every instruction file that applies, harness settings and guards, CI, history) and the person's words. Each fact carries its source, or is marked unchecked.
2. **Prove it:** walk one practice ticket, as a worker would, through every step that is safe. Create and set up the worktrees, run and time the fast and the heavy checks, and measure each heavy check's peak memory where it runs, run each oracle and the read-only query command once, merge on a scratch branch that is never pushed, read the tracker. Then remove what you created.
3. **Fill the gaps.** Whatever the walk needed that the definition didn't say is missing. Fill it from the sources, or ask the person with a recommendation.
4. **Show the person** what you found, what you proved and what it costs, such as how long proving a change takes. Write only what they confirm: to `.agents/project.md` in a versioned folder every checkout gets (the folder that holds the repos if it is versioned, otherwise a repo the person names), with a `name`, paths relative to that folder and no `roots`; otherwise to `~/.agents/projects/<project>.md`. Facts true only on this machine go to `~/.agents/projects/<project>.local.md`. If `~/.agents/projects/<project>.md` already exists, move its machine-only facts to the `.local.md` and remove it, with the person's confirmation.

Authority to act without asking comes only from the person's own words, recorded without widening. An older process's rules move into the project's `AGENTS.md` before it is removed, on every base tickets branch from. Re-run it at any time, the same way, reading `~/.agents/records.jsonl` for this project first: what its deliveries kept missing is what the definition or its `AGENTS.md` should make easier to see. If `~/.agents/workflow.yaml` is missing on the person's own machine, create it with `roles: {}`.

## The definition

```yaml
---
name: library-app
work: .work                       # outside the repos, or excluded in each
repos:
  catalog: { path: catalog, base: { staging: develop, production: main } }
  web:     { path: web,     base: { staging: develop, production: main } }
statuses:
  started: In progress
  delivered: { staging: Ready for review, production: Released }
ticket_type: session              # or where else it comes from
roles: {}                         # optional: <harness>.<role>: { model, effort }
checks_allow: [npm test, npx vitest run, ./tools/read-db.sh, node ./tools/money-check.mjs, node ./tools/permission-matrix.mjs]
nothing_ran: [No tests found, /^0 passing/m]
screen_paths: [web/src/pages, web/src/components, web/messages]
money_oracle: node ./tools/money-check.mjs --stack {worktree} <spec.json>
permission_oracle: node ./tools/permission-matrix.mjs --stack {worktree} <spec.json>
---
```

This is the repo-held form: paths are relative to the folder that holds `.agents/`. In `~/.agents/projects/<project>.md`, add `roots: [<the project's folder>]` and use absolute paths.

The deliver skill's scripts read these front-matter keys, each a list as `[a, b]` or as `- a` lines:

- `checks_allow`: the command prefixes a check's `cmd:` may start with, word for word (`npm test` allows `npm test -- renew`, never `npm exec`); `checks` runs nothing else, and never through a shell. A word starting `./`, `../` or `/` is a file from the definition's folder: that command runs there, so an oracle is never taken from the branch under test, and `links` stops a delivery whose branch changed it. Every other command runs inside the check's worktree. `{worktree}` and `{ticket}` in a command become those folders' paths.
- `nothing_ran`: what each runner prints when it ran no test (plain text, or `/regex/flags`). A run whose output matches one fails, whatever its exit code, in `checks` and in the test rows `links` reads.
- `screen_paths`: `<repo>/<path>` prefixes of the screen source and locale files. A screenshot taken at an earlier commit stands while the diff since touches none of them.

`money_oracle` and `permission_oracle` name the oracles (one line each, also on `checks_allow`); where neither is set, no cold audit runs. A screenshot is any file under `evidence/` whose name holds the state's name from the plan's `States:` line and the commit it shows (7 to 40 hex characters), so the project's own naming works, for example `limit-reached-390-en-light-<sha>.png`.

Then a short section per thing a delivering agent does:

- **Set up** a fresh worktree, including what a worker starting there wouldn't find.
- **Screens**, for a project with any: its design system and where it lives, its best reference screen for each kind of surface, its languages, themes and widths, and the cheapest way to render a picture from its real components and the product's own rules, including how a screen's render calls rules that live in another repository before their endpoint exists.
- **Prove** a change: the checks available, what each one covers, how long it takes, and which are heavy, the memory each peaks at and the margin to keep, where free memory is measured (the machine, and the container VM and its size where runs live there), how a starting run makes itself visible to other sessions before it takes memory, and how to see the heavy runs any session has going. A ticket picks the ones that cover what it alters and its reach, and runs a broad suite only when that reach justifies it, unless CI already does.
- **Check** money and permissions: the project's oracles, each a read-only command on `checks_allow` that plans call from `CHECKS.json` with an `expect`. A workable form: `<oracle> --stack <worktree> <spec.json>`, the spec naming the states and figures or routes to compare, printing every disagreement, and exiting 0 when all agree, 1 on a disagreement or a value it couldn't read, 2 on a bad spec. A money oracle prints every disagreement between a figure the screen shows in a given state, the stored record (through the read-only query command) and the payment provider's test-mode record. A permission matrix runs each touched route against each role and tenant and prints every outcome that differs from the expected allow, deny or not-found, from the rules the project's `AGENTS.md` states. Name how each is run, what it covers and how long it takes; where one doesn't exist yet, writing it is the person's decision, with a recommendation.
- **Reach** the environments, test accounts (by reference, never secrets) and read-only data; how an agent gets the app running to walk through as its users would, and the browser it drives it with; and how everything a ticket starts, runs included, is found and removed afterwards.
- **Deliver** to each target, step by step to its delivered status: how each is taken, confirmed and undone, and who may take it without asking, quoted.
- **Track** tickets: read, file, move, comment, attach.

A fact true only for now says what ends it. Rules about the code belong in `AGENTS.md`.
