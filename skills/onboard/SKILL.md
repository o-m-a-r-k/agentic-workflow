---
name: onboard
description: Write or re-evaluate a project's definition for the deliver skill with the person, proven on a practice ticket. Use when asked to set up, onboard or re-evaluate a project.
---

# Onboard

**Goal.** A definition from which a fresh agent, knowing nothing else, can take a ticket from started to delivered in this project. A description nobody has used is a guess, so prove it by use. It serves `../deliver/WORKFLOW.md`, beside this skill's folder; read that first.

## Method

1. **Describe** how the project delivers, from its own sources (repos, every instruction file that applies, harness settings and guards, CI, history) and the person's words. Each fact carries its source, or is marked unchecked.
2. **Prove it:** walk one practice ticket, as a worker would, through every step that is safe. Create and set up the worktrees, run and time the fast and the heavy checks, merge on a scratch branch that is never pushed, read the tracker. Then remove what you created.
3. **Fill the gaps.** Whatever the walk needed that the definition didn't say is missing. Fill it from the sources, or ask the person with a recommendation.
4. **Show the person** what you found, what you proved and what it costs, such as how long proving a change takes. Write only what they confirm, to `~/.agents/projects/<project>.md`.

Authority to act without asking comes only from the person's own words, recorded without widening. An older process's rules move into the project's `AGENTS.md` before it is removed, on every base tickets branch from. Re-run it at any time, the same way, reading `~/.agents/records.jsonl` for this project first: what its deliveries kept missing is what the definition or its `AGENTS.md` should make easier to see. If `~/.agents/workflow.yaml` is missing, create it with `roles: {}` and `heavy_runs: 1`.

## The definition

```yaml
---
roots: [~/code/library-app]
work: ~/code/library-app/.work    # outside the repos, or excluded in each
repos:
  catalog: { path: ~/code/library-app/catalog, base: { staging: develop, production: main } }
  web:     { path: ~/code/library-app/web,     base: { staging: develop, production: main } }
statuses:
  started: In progress
  delivered: { staging: Ready for review, production: Released }
ticket_type: session              # or where else it comes from
roles: {}                         # optional: <harness>.<role>: { model, effort }
---
```

Then a short section per thing a delivering agent does:

- **Set up** a fresh worktree, including what a worker starting there wouldn't find.
- **Prove** a change: the checks available, what each one covers, how long it takes, and which are heavy (two at once make the machine unusable). A ticket picks the ones that cover what it alters and its reach, and runs a broad suite only when that reach justifies it, unless CI already does.
- **Reach** the environments, test accounts (by reference, never secrets) and read-only data.
- **Deliver** to each target, step by step to its delivered status: how each is taken, confirmed and undone, and who may take it without asking, quoted.
- **Track** tickets: read, file, move, comment, attach.

A fact true only for now says what ends it. Rules about the code belong in `AGENTS.md`.
