---
name: onboard
description: Write or re-evaluate a project's definition for the deliver skill, with the person. Covers delivery, environments, access, verification, statuses and where ticket types come from. Use when the person asks to set up, onboard or re-evaluate a project.
---

# Onboard

**Goal.** Write a project definition from which a fresh agent, knowing nothing else, can take a ticket through to delivery in this project. Every fact in it is checked, not assumed, and every decision in it is the person's, in their own words.

The way of working the definition serves is `../deliver/WORKFLOW.md`, relative to this skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code; in another harness, the folder this file was loaded from). Read it first.

## Method

1. **Study the project as a ticket will meet it:** its repos and every `AGENTS.md` that applies, including one in a folder above them; the build and test commands; the CI configuration and what it does on a merge; the deploy scripts; the environments the code refers to; the harness's permission settings and guard hooks, which decide which git and deploy commands an agent can run; and, from git history, how changes have been merged, released and rolled back.
2. **Prove the commands the way a worker would,** in a fresh worktree set up first (dependencies, environment files, whatever its tooling expects). Run and time the fast checks and the heavy runs, record each setup step and fix you needed, then remove what you created.
3. **Carry over any older process** described in an `AGENTS.md`, a process folder, agent definitions or scripts. Move what still holds (rules into `AGENTS.md`, facts into the definition), then show the person what you would remove. Removal is a change delivered on each base branch like a ticket; until it lands, tickets cut from that branch read the old text, and where it asks for more, it wins.
4. **Draft the definition.** Give each fact its source inline: a file and line, a command and when you ran it, or the person's words. Mark what you found but could not run as unchecked, and what you could not find as a question.
5. **Go through the questions with the person,** a few at a time, each with a recommendation drawn from what you found. Some answers are theirs alone; ask those plainly and record what they said without widening it:
   - which steps an agent may take without asking, per target and ticket type. A method that would allow more grants nothing; only their words do.
   - which suite proves which kind of change, and whether it runs per ticket before delivery or per batch or day. Show the times you measured, so they weigh proof against speed knowing the cost.
   - any convention the tracker itself doesn't fix, such as ids, formats and attachments in a plain file.
6. **Write** `~/.agents/projects/<project>.md`. `<project>` is a short name the person agrees to.
7. If `~/.agents/workflow.yaml` is missing, create it with an empty `roles:` map and `heavy_runs: 1`, plus a comment saying that `roles.<harness>.<role>` overrides the plugin's defaults.

**Re-running** re-evaluates. Study the project again, compare with the existing definition, and show the person what you would change and why. Write only what they confirm.

## What the definition holds

YAML front matter for the parts agents look up:

```yaml
---
roots: [~/code/library-app]          # folders that belong to this project
work: ~/code/library-app/.work        # ticket folders; outside the repos, or excluded in each
repos:                                # each repo, the checkout worktrees come from, its base per target
  catalog: { path: ~/code/library-app/catalog, base: { staging: develop, production: main } }
  web:     { path: ~/code/library-app/web,     base: { staging: develop, production: main } }
statuses:
  started: In progress
  delivered: { staging: Ready for review, production: Released }   # per target
ticket_type: session                  # or where else it comes from, e.g. a tracker label
roles: {}                             # optional: roles.<harness>.<role>: { model, effort }
---
```

Then short Markdown sections:

- **Repos:** for each, how to set up a fresh worktree (including any other repo its tooling expects beside it), its fast and full test commands with the time each took, and which runs are heavy: those that load the machine so much that two at once make it unusable, such as runs that start containers or browsers. Name any instruction file that applies from outside the repos, since a worker starting in a worktree won't find it.
- **Delivery:** which ticket types go to which target; per target, what "delivered" means and each step with commands the harness allows: the merge, the order across repos when a change spans them, what CI does on the merge (tests, migrations, a deploy) and how a deploy is confirmed, how each step is rolled back and what cannot be, and where the handoff goes. Then who may take which step without asking, quoted. A project with no production yet says so, and where a hotfix would branch from.
- **Environments:** each one, how to reach it, and how to start and stop it locally.
- **Test accounts:** references only, such as where an account's credentials live. Never the secrets themselves.
- **Data access:** how to query each data store that must not change, without the ability to write, and which data is disposable.
- **Verified means:** what must be seen, and where, before a ticket counts as verified; which suite proves which kind of change, and when it runs, with its measured time.
- **Tracker:** how to read, file and move tickets, and how to comment on them and attach files.
- **For now:** limits that hold only until something changes, such as an environment out of reach or a freeze, each with what ends it.

Rules about the code itself belong in each repo's `AGENTS.md`, not here.
