---
name: deliver
description: Deliver one ticket or several, from investigation and plan to verified delivery and cleanup, with fresh agents checking each step. Use when the person asks to fix, implement, build or deliver a ticket, or to continue one.
---

# Deliver

You orchestrate, in the session the person talks to, since workers return to it and not to a sub-agent. Workers do the work and write it to the ticket folder. You read the files, decide what comes next, and start workers. Keep the work itself out of your context.

**The skill folder** is the folder containing this file: `${CLAUDE_SKILL_DIR}` in Claude Code. In another harness, where that text is not replaced, use the path this file was loaded from.

## Each cycle

Read these files fresh, every cycle. Do not rely on what you remember of them.

1. `WORKFLOW.md` in the skill folder: the way of working.
2. The project definition, `~/.agents/projects/<project>.md`. Use the definition whose `roots` contain the current directory. If none does, run the onboard skill first.
3. The user settings, `~/.agents/workflow.yaml`.
4. For every ticket in the definition's `work` folder: `PROGRESS.md`, `PLAN.md` and `CHECKS.json`.

Then decide the next step for each ticket you were asked to deliver or continue, following `WORKFLOW.md`, and start its workers. Tickets move independently, so start whatever is ready, in parallel.

Take a new ticket (step 1) yourself, from the files in the skill folder's `templates/`, and confirm each part from its output.

## Where things stand

You alone write `PROGRESS.md`. It says, for each ticket, which session drives it, what it waits for, and what it has running. A cycle runs whenever anything returns or the person writes. Each cycle, check every wait and every ticket's tracker status against its source, not your memory of it, and act on what you see: a worker whose files have stopped moving for far longer than its step needs, or whose session has ended, is gone, so a fresh worker restarts its step, building on what was left and saying what it kept. A lane whose blocker changes the plan pauses the lanes that depend on it. Cleanup stops what the list names.

When your context grows heavy, or the session may end, make sure `PROGRESS.md` is current. The next cycle resumes from the files, whether the harness compacts this context or the person opens a new session and asks to continue.

## Starting a worker

Start workers through the harness's own general-purpose sub-agent, all from this session. Start each one fresh, without this session's history: not a fork, and not one of the project's own agent types, because the role file is the whole brief. In Codex, pass `fork_turns: "none"` where the spawn tool offers it. Give each one:

- the full text of its role file, `roles/<role>.md` in the skill folder, quoted as its brief;
- the paths of the ticket folder, the worktrees, the project definition and `WORKFLOW.md`, and for the delivery worker this session's transcript, where the harness exposes it;
- that it cannot answer a permission prompt, so it skips any tool that would ask and names what it could not do;
- its particular job, such as the angle an investigator covers, and how to take a heavy run: start it when a slot is free, otherwise queue it, never skip it;
- this, in these words: "You start outside the worktrees. Before you work in a repo, read the `AGENTS.md` of the worktree, of each directory you touch, and any instruction file the project definition names; the harness may not have loaded them. Run every command from inside the worktree, and record the worktree's `HEAD` with every result. Stop what you start, or name it and how to stop it in your return line."

The brief adds the ticket's facts; it never narrows the method or decides a worker's findings. If time matters, say so; weighing is the worker's job.

Size the model to the work as well: a small ticket's planning doesn't need the deepest model. Take each role's model and effort, each separately, from the first of these that sets it, and lighten them for a small ticket unless a source pins them:

1. the project definition's `roles.<harness>.<role>`;
2. `~/.agents/workflow.yaml`, `roles.<harness>.<role>`;
3. `defaults.yaml` in the skill folder;
4. the session's own model and effort.

`<harness>` is `claude` or `codex`. Pass them when you start the sub-agent where the harness accepts them: in Claude Code, `model` and `effort`; in Codex, the model and reasoning effort the spawn tool offers. Where it doesn't, the worker runs on the session's model.

A worker returns a short status. Record it in `PROGRESS.md` and read the details from the files only when the next decision needs them. File once each the out-of-scope items workers list, unless a ticket already exists.

## When to stop for the person

Stop when a ticket's next step is the person's: one the method or the instructions give them (an approval, a decision, reading a diff), a stall, a check that failed after a delivery step, or a finished delivery. Ask for everything a ticket needs from them at once. Before you stop, start every ready step of the other tickets. Never stop just to report status. When you do stop, say what you need, link the file, and give your recommendation.
