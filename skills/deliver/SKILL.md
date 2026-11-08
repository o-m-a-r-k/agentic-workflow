---
name: deliver
description: Deliver one ticket or several, from investigation and plan to verified delivery and cleanup, with fresh agents checking each step. Use when the person asks to fix, implement, build or deliver a ticket, or to continue one.
---

# Deliver

You orchestrate, in the session the person talks to, since workers return to it and not to a sub-agent. You own each ticket's outcome, as `WORKFLOW.md` "The outcome" describes. Workers do the work and write it to the ticket folder; you read the state and the scripts' output, decide the next move and start workers. You settle what is an extra and what the next move is, and say why; a disputed finding is settled by the next judge. Keep the work itself out of your context: you run no tests, builds, containers or servers, and you don't read `PLAN.md` to decide.

**The skill folder** is the folder containing this file: `${CLAUDE_SKILL_DIR}` in Claude Code. In another harness, where that text is not replaced, use the path this file was loaded from. Its scripts run as `node <skill folder>/scripts/<name>.mjs`.

## At the start of a session

Read once, and again after the harness compacts your context:

1. `WORKFLOW.md` in the skill folder: the way of working.
2. The project definition: a repo-held `.agents/project.md` in the current directory, the nearest directory above it that has one, or a sibling folder beside the current repo (among several, the one whose `repos` include the current repo; if several or none qualify, ask the person). Its repo `path`s resolve against the folder that holds `.agents/`, or else the checkout of the same repo beside it. Otherwise `~/.agents/projects/<project>.md`, the one whose `roots` contain the current directory. If both exist, use the repo-held one and tell the person once to move the personal file's machine-only facts into `<project>.local.md`. A `~/.agents/projects/<project>.local.md` may set what the shared definition leaves unset and give this machine's paths, never remove a step, check or delivery rule. With no definition, run the onboard skill first.
3. The user settings, `~/.agents/workflow.yaml`, with the active profile applied (see Settings).

## Each cycle

A cycle runs whenever anything returns or the person writes. Read `STATE.md` for every ticket in the definition's `work` folder, the return line, and the result file of any script that ran since (`evidence/plan-shape.md`, `rounds.md`, `checks.json`, `links-<n>.md`). A folder started under an earlier version holds `PROGRESS.md`: rename it to `STATE.md`, bring its fields to the template's (the `Worktree <repo>:` lines and the Surface draft above all), and have the next plan revision take the template's header and sections; its old evidence files don't count as rounds, and an `evidence/audit.md` is renamed `audit-<n>.md` for the delivery it audited. Then, for each ticket you were asked to deliver or continue, decide the next move following `WORKFLOW.md` and start its workers. A proven delivery that isn't delivered is the next move on that ticket. Tickets move independently, so start whatever is ready, as many workers at once as `agents_at_once` allows. Judges and reviewers run `rounds` themselves; run it for the reader, which can't. Before starting the delivery worker, run `links` with the project definition (`--definition`); a broken row names the worker to start instead (or to wait for, when it is already running), and `none: held` means the delivery worker writes the held delivery's handoff. Each script's result file gives a summary line per item; read those, not the logs. For the reader's purpose and the memos, run `plan-shape <ticket folder> --print reader` or `--print memos` rather than reading the plan.

Take a new ticket (step 1) yourself, from the files in the skill folder's `templates/`; a worker installs and sets up the worktrees.

## Where things stand

You alone write `STATE.md`: its fixed fields, overwritten each cycle, never a narrative. Append one line per return to `evidence/log.md` (time, role, status); the worker writing `missed.md` reads it, nobody else. Check every wait and every ticket's tracker status against its source. A worker whose files have stopped moving for far longer than its step needs, or whose session has ended, is gone, and a fresh worker restarts its step from what was left (at `agents_at_once: 1`, only when the harness reports it ended); a worker waiting for room for a heavy run is waiting, not gone. A lane whose blocker changes the plan pauses the lanes that depend on it. When your context grows heavy, or the session may end, make sure `STATE.md` is current; the next cycle resumes from the files.

## Starting a worker

Every worker is fresh: started through the harness's own general-purpose sub-agent from this session, without its history, not a fork, not one of the project's agent types, and never a worker kept alive and messaged across revisions. In Codex, pass `fork_turns: "none"` where the spawn tool offers it. Its brief is paths:

- its role file, `roles/<role>.md` in the skill folder, which it reads first, whole;
- the absolute paths of the ticket folder, the worktrees, the project definition (and its `.local.md`), `WORKFLOW.md`, and the skill folder for the scripts;
- its particular job: the angle, the work item, the delivery number, and how to take a heavy run (as `WORKFLOW.md` Several tickets says, otherwise wait for room, never skip it);
- that it asks for what it needs the way the harness grants permissions, and names what a refusal stopped rather than working around it;
- this, in these words: "You start outside the worktrees. Before you work in a repo, read the `AGENTS.md` of the worktree, of each directory you touch, and any instruction file the project definition names; the harness may not have loaded them. Run every command from inside the worktree, and record the worktree's `HEAD` with every result. Before you finish, remove what you started or created and what your runs left behind (compare before and after, and remove only what you can trace to your own runs by name, label or the command that made it; name what you can't trace); what the next step needs, name with how to remove it in your return line. What the project's environments can produce, you produce and check; never report it as unchecked or a limit."

**The reader is the exception.** Copy the built screenshots into a folder of their own outside the ticket folder (record it under Left behind) with the purpose, questions and states `plan-shape --print reader` prints, word for word, and the commit they show. Give it only that folder, its role file and the permission line above; no worktree, no plan, no data. You move its file to `evidence/read-<delivery>.md`.

The brief adds the ticket's facts; it never narrows the method or decides a worker's findings.

Size the model to the work. If the settings say `models: session`, pass no model: every role runs on the session's model, and effort still comes from the list below. Otherwise take each role's model and effort, each separately, from the first of these that sets it, and lighten them for a small ticket unless a source pins them:

1. the project definition's `roles.<harness>.<role>`;
2. `~/.agents/workflow.yaml`, `roles.<harness>.<role>`;
3. `defaults.yaml` in the skill folder;
4. the session's own model and effort.

`<harness>` is `claude` or `codex`. Pass them where the harness accepts them: in Claude Code, `model` and `effort`; in Codex, the model and reasoning effort the spawn tool offers.

A worker returns one line. Record it, and read the details from the files only when the next decision needs them. Judge each item workers list as outside the ticket by `WORKFLOW.md` Scope: one the users can't get the outcome without, or one the change caused, goes back into the plan as work; a shown Surface extra opens a hotfix ticket at once and you tell the person, as `WORKFLOW.md` Scope says; leads and the rest go under "Outside the ticket" for the handoff.

## Settings

`~/.agents/workflow.yaml` holds the person's settings. A key left out keeps its default.

- `agents_at_once`: how many workers run at the same time, across every ticket. Unset, as many as the work allows. At `1`, workers run one after another: update `STATE.md` first, start the worker as the last thing you do, then end your turn, or block on the harness's wait with a long timeout, until it returns. Every step and every fresh agent still happens, in turn.
- `heavy_runs`: an outer limit on how many heavy test runs go at once; unset, the project definition's admission alone decides.
- `context_tokens`: the context window of the session's model. When set, tell each worker the window (the harness uses part of it), to read only the parts of files it needs, send long output to `evidence/` and write findings as it goes. Size lanes so each worker's reading fits.
- `models: session`: every role runs on the session's own model, for a harness whose sub-agents can't choose one.
- `roles.<harness>.<role>`: a role's model and effort, as above.
- `profiles.<name>`: any of the keys above, merged over the top-level keys field by field. A profile is active when the person names it in the session, or else when `AGENTS_WORKFLOW_PROFILE` names it; an unknown name is reported, not guessed. An active profile's keys also win over the project definition's `roles`. Record the active profile in `STATE.md`; a resumed ticket uses the profile active in the new session.

## When to stop for the person

Stop when a ticket's next step is the person's: the one bundled message of step 5, an access or permission a worker couldn't get (ask, then restart the worker; never do that work yourself), a stall, a check that failed after a delivery step, a held delivery or ticket, or a finished delivery. Ask for everything a ticket needs from them at once, with your recommendation, and only what the method gives them; what the method, the definition or their standing instructions settle, you decide, and never ask again. Record their standing instructions in `STATE.md`, in their words. Before you stop, start the other tickets' ready steps within `agents_at_once`. Never stop just to report status. Every message opens with where the outcome stands and its evidence, then what you need from them, and links the file. A finished delivery ends with its report, `~/.agents/reports/<project>/<ticket>/report.md` where one was written, otherwise the tracker comment: give it in full; the person sees the screenshots where the handoff attached them, and you don't open them one by one.
