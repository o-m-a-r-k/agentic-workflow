---
name: onboard
description: Write or re-evaluate a project's definition for the deliver skill, with the person. Covers delivery, environments, access, verification, statuses and where ticket types come from. Use when the person asks to set up, onboard or re-evaluate a project.
---

# Onboard

**Goal.** Write a project definition from which a fresh agent, knowing nothing else, can take a ticket through to delivery in this project. Every fact in it should be checked, not assumed.

The way of working the definition serves is `../deliver/WORKFLOW.md`, relative to this skill's folder (`${CLAUDE_SKILL_DIR}` in Claude Code; in another harness, the folder this file was loaded from). Read it first.

## Method

1. Study the project. That means its repos and each repo's `AGENTS.md`, the build and test commands, the CI configuration, the deploy scripts, the environments the code refers to, and how changes have been merged and released, from git history. Run the fast checks where that is cheap, to confirm the commands work.
2. Draft the definition from what you found. Mark each item as found (with its source) or as a question.
3. Go through the questions with the person, a few at a time. Give each a recommendation drawn from what you found.
4. Write `~/.agents/projects/<project>.md`. `<project>` is a short name the person agrees to.
5. If `~/.agents/workflow.yaml` is missing, create it with an empty `roles:` map and `heavy_runs: 1`, plus a comment saying that `roles.<harness>.<role>` overrides the plugin's defaults.

**Re-running** re-evaluates. Study the project again, compare with the existing definition, and show the person what you would change and why. Write only what they confirm.

## What the definition holds

YAML front matter for the parts agents look up:

```yaml
---
roots: [~/code/library-app]            # folders that belong to this project
statuses: { started: In progress, done: Ready for review }
ticket_type: session                    # or where else it comes from, e.g. a tracker label
roles: {}                               # optional: roles.<harness>.<role>: { model, effort }
---
```

Then short Markdown sections:

- **Repos:** each repo, its base branch, and its fast and full test commands.
- **Delivery:** per target, what "delivered" means and how it is done: a merge to the base branch, a merge request, a deploy and its confirmation, the ticket move, and where the handoff goes.
- **Environments:** each one, how to reach it, and how to start and stop it locally.
- **Test accounts:** references only, such as where an account's credentials live. Never the secrets themselves.
- **Read-only data access:** how to query each data store without the ability to write.
- **Verified means:** what must be seen, and where, before a ticket counts as verified.
- **Tracker:** how to read, file and move tickets, and how to comment on them.

Rules about the code itself belong in each repo's `AGENTS.md`, not here.
