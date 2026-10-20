---
name: deliver
description: Deliver one ticket or several, from investigation and plan to verified delivery and cleanup, with fresh agents checking each step. Use when the person asks to fix, implement, build or deliver a ticket, or to continue one.
---

# Deliver

You orchestrate. Workers do the work and write it to the ticket folder. You read the files, decide what comes next, and start workers. Keep the work itself out of your context.

**The skill folder** is the folder containing this file: `${CLAUDE_SKILL_DIR}` in Claude Code. In another harness, where that text is not replaced, use the path this file was loaded from.

## Each cycle

Read these files fresh, every cycle. Do not rely on what you remember of them.

1. `WORKFLOW.md` in the skill folder: the way of working.
2. The project definition, `~/.agents/projects/<project>.md`. Use the definition whose `roots` contain the current directory. If none does, run the onboard skill first.
3. The user settings, `~/.agents/workflow.yaml`.
4. For every ticket under `<project root>/.work/`: `PROGRESS.md`, `PLAN.md` and `CHECKS.json`.

Then decide the next step for each ticket, following `WORKFLOW.md`, and start its workers. Tickets move independently, so start whatever is ready, in parallel.

For a new ticket, create its folder with the files in the skill folder's `templates/`.

## Starting a worker

Start workers through the harness's own sub-agents, all from this session. Start each one fresh, without this session's history. In Codex, that means `fork_turns: "none"`, which is also what lets a model and effort be set. Give each one:

- the full text of its role file, `roles/<role>.md` in the skill folder, quoted as its brief;
- the paths of the ticket folder, the worktrees, the project definition and `WORKFLOW.md`;
- its particular job, such as the angle an investigator covers.

Choose each role's model and effort from the first of these that sets them:

1. the project definition's `roles.<harness>.<role>`;
2. `~/.agents/workflow.yaml`, `roles.<harness>.<role>`;
3. `defaults.yaml` in the skill folder;
4. the session's own model.

`<harness>` is `claude` or `codex`. Pass the model and effort when you start the sub-agent: in Claude Code, `model` and `effort`; in Codex, `model` and `reasoning_effort`.

A worker returns a short status. Record it in `PROGRESS.md` and read the details from the files only when the next decision needs them.

## When to stop for the person

Stop only for these:

- a high-risk plan that needs approval;
- product decision memos;
- work that has stalled;
- a finished delivery.

Never stop just to report status. When you do stop, say what you need, link the file, and give your recommendation.

When your context grows heavy, make sure `PROGRESS.md` says where every ticket stands. Then continue in a fresh context. The files are the state.
