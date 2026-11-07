---
name: deliver
description: Deliver one ticket or several, from investigation and plan to verified delivery and cleanup, with fresh agents checking each step. Use when the person asks to fix, implement, build or deliver a ticket, or to continue one.
---

# Deliver

You orchestrate, in the session the person talks to, since workers return to it and not to a sub-agent. You own each ticket's outcome, as `WORKFLOW.md` "The outcome" describes. Workers do the work and write it to the ticket folder; you read the files, decide the next move and start workers. You decide what has a defensible answer from the files: you settle findings and disputes yourself and say why, and send to a worker only what needs code, a run or a fresh check. Workers write code, tests, plans and checks; a repair is one implementer who fixes and runs what covers it. Keep the work itself out of your context: you run no tests, builds, containers or servers; a worker does.

**The skill folder** is the folder containing this file: `${CLAUDE_SKILL_DIR}` in Claude Code. In another harness, where that text is not replaced, use the path this file was loaded from.

## Each cycle

Read these files fresh, every cycle. Do not rely on what you remember of them.

1. `WORKFLOW.md` in the skill folder: the way of working.
2. The project definition. Look first for a repo-held `.agents/project.md`, in the current directory, in the nearest directory above it that has one, or in a sibling folder beside the current repo (a harness that clones repos side by side puts a shared workspace repo there); it needs no `roots`. Resolve each repo's `path` against the folder that holds `.agents/`; where nothing is there, use the checkout of the same repo beside that folder (matched by its remote), and say in `PROGRESS.md` which you used. Among several siblings, use the one whose `repos` include the current repo; if several or none qualify, ask the person. Otherwise use `~/.agents/projects/<project>.md`, the one whose `roots` contain the current directory. `<project>` is the definition's `name`, or else its file name. If both a repo-held definition and a personal `<project>.md` exist, use the repo-held one and tell the person, once, to move the personal file's machine-only facts into `<project>.local.md` and delete it. A personal `~/.agents/projects/<project>.local.md`, if present, may set what the shared definition leaves unset and give this machine's paths; it never removes a step, check or delivery rule. If no definition exists, run the onboard skill first.
3. The user settings, `~/.agents/workflow.yaml`, with the active profile applied (see Settings).
4. `PROGRESS.md` for every ticket in the definition's `work` folder; `PLAN.md` and `CHECKS.json` for the tickets you drive, the parts the next decision needs.

Then, for each ticket you were asked to deliver or continue, compare where the outcome stands with the last cycle, and keep to `WORKFLOW.md`'s two fix rounds. A proven delivery that isn't delivered is the next move, before anything else on that ticket. Decide the next move following `WORKFLOW.md`, and start its workers. Tickets move independently, so start whatever is ready, as many workers at once as `agents_at_once` allows.

Take a new ticket (step 1) yourself, from the files in the skill folder's `templates/`, and confirm each part from its output.

## Where things stand

You alone write `PROGRESS.md`. It says, for each ticket, which session drives it, what it waits for, and what is left running or created. A cycle runs whenever anything returns or the person writes. Each cycle, check every wait and every ticket's tracker status against its source, not your memory of it, and act on what you see: a worker whose files have stopped moving for far longer than its step needs, or whose session has ended, is gone, so a fresh worker restarts its step (at `agents_at_once: 1`, a worker is gone only when the harness reports it ended, since a slow model can look stalled), building on what was left and saying what it kept. A lane whose blocker changes the plan pauses the lanes that depend on it. Cleanup removes what that list names.

When your context grows heavy, or the session may end, make sure `PROGRESS.md` is current. The next cycle resumes from the files, whether the harness compacts this context or the person opens a new session and asks to continue.

## Starting a worker

Start workers through the harness's own general-purpose sub-agent, all from this session. Start each one fresh, without this session's history: not a fork, and not one of the project's own agent types, because the role file is the whole brief. In Codex, pass `fork_turns: "none"` where the spawn tool offers it. Give each one:

- the full text of its role file, `roles/<role>.md` in the skill folder, quoted as its brief;
- the paths of the ticket folder, the worktrees, the project definition (and its `.local.md`, if any) and `WORKFLOW.md`, and for the delivery worker this session's transcript, where the harness exposes it. The reader is the exception. Start one once, on the built commit that changes what people see, before its review. Copy its screenshots into a folder of their own outside the ticket folder (record it under Left behind in `PROGRESS.md`), and give it only that folder, the commit they show, the purpose from the plan's "What people see" (who it is for, what they must know or do, and their few questions), copied word for word, and the permission line below. It writes its file in that folder and you move it to `evidence/read-<round>.md`. It gets no other path and not the worktree sentence, because what it must not see is the point;
- that it asks for what it needs the way the harness grants permissions, and where one is refused it names what it couldn't do rather than working around it;
- its particular job, such as the angle an investigator covers, and how to take a heavy run: start it as `WORKFLOW.md` Several tickets says, otherwise wait for room, never skip it;
- this, in these words: "You start outside the worktrees. Before you work in a repo, read the `AGENTS.md` of the worktree, of each directory you touch, and any instruction file the project definition names; the harness may not have loaded them. Run every command from inside the worktree, and record the worktree's `HEAD` with every result. Before you finish, remove what you started or created and what your runs left behind (compare before and after, and remove only what you can trace to your own runs by name, label or the command that made it; name what you can't trace); what the next step needs, name with how to remove it in your return line. What the project's environments can produce, you produce and check; never report it as unchecked or a limit."

The brief adds the ticket's facts; it never narrows the method or decides a worker's findings. If time matters, say so; weighing is the worker's job.

Size the model to the work as well: a small ticket's planning doesn't need the deepest model. If the settings say `models: session`, pass no model: every role runs on the session's model, whatever the project definition or `defaults.yaml` names, and effort still comes from the list below. Otherwise take each role's model and effort, each separately, from the first of these that sets it, and lighten them for a small ticket unless a source pins them:

1. the project definition's `roles.<harness>.<role>`;
2. `~/.agents/workflow.yaml`, `roles.<harness>.<role>`;
3. `defaults.yaml` in the skill folder;
4. the session's own model and effort.

`<harness>` is `claude` or `codex`. Pass them when you start the sub-agent where the harness accepts them: in Claude Code, `model` and `effort`; in Codex, the model and reasoning effort the spawn tool offers. Where it doesn't, the worker runs on the session's model.

A worker returns a short status. The reader's gaps go to review, which turns those that hold into findings the implementer fixes in the ticket. Record it in `PROGRESS.md` and read the details from the files only when the next decision needs them. Judge each item workers list as outside the ticket: one the users can't get the outcome without, shown by the evidence that it fails without it, or one the change caused, goes back into the plan as work, in the delivery the plan gives it; record the rest under "Outside the ticket" in `PROGRESS.md` and show them to the person at your next message to them (a hotfix's after its first delivery), one at a time or several together, each explained in plain words (what is wrong, who meets it, what fixing it would take) with your recommendation; file, fix now or fix after delivery as they choose (`WORKFLOW.md` Scope).

## Settings

`~/.agents/workflow.yaml` holds the person's settings. A key left out keeps its default.

- `agents_at_once`: how many workers run at the same time, across every ticket. Unset, as many as the work allows. The count is of workers; you are one more call whenever you work between returns. At `1`, workers run one after another: update `PROGRESS.md` first, start the worker as the last thing you do, then end your turn, or block on the harness's wait with a long timeout, until it returns. The workflow then keeps one model call in flight at a time. The method doesn't change: every step and every fresh agent still happens, in order, and whatever would have run side by side runs in turn.
- `heavy_runs`: an outer limit on how many heavy test runs go at once; unset, the project definition's admission alone decides (`WORKFLOW.md`).
- `context_tokens`: the context window of the model the session runs on. When it is set, tell each worker the window, and that the harness's own prompt and tools use part of it: it reads the parts of files it needs, sends long command and test output to `evidence/` and reads the lines that matter, and writes its findings to its file as it goes, so a restart keeps them. Size lanes and work items so each worker's reading fits; a review of a large change splits by work item, each reviewer reading its part whole. Keep within the window yourself: read what a decision needs and keep briefs to paths and facts. A plan that would fill much of the window is a sign it holds more than its decisions need.
- `models: session`: every role runs on the session's own model, for a harness whose sub-agents can't choose one, such as one pointed at a local model.
- `roles.<harness>.<role>`: a role's model and effort, as above.
- `profiles.<name>`: any of the keys above, merged over the top-level keys field by field. A profile is active when the person names it in the session, or else when the environment variable `AGENTS_WORKFLOW_PROFILE` names it; an unknown name is reported, not guessed. An active profile's keys also win over the project definition's `roles`, since a profile describes the machine. Record the active profile in `PROGRESS.md`; a resumed ticket uses the profile active in the new session, not the recorded one.

## When to stop for the person

Stop when a ticket's next step is the person's: one the method or the instructions give them (an approval, a decision, reading a diff), a stall, a check that failed after a delivery step, or a finished delivery (give its report; a next delivery goes on). A permission a worker couldn't get is the person's to grant: ask, then restart the worker; never do that work yourself. Ask for everything a ticket needs from them at once, and only what the method gives them; what the method, the definition or their standing instructions settle, you decide or route, and never ask again. Record their standing instructions in `PROGRESS.md`, in their words, when they give them. Before you stop, start the other tickets' ready steps within `agents_at_once`; at 1, ask the person first, then carry on with the other tickets in turn. Never stop just to report status. Every message to the person opens with where the outcome stands and its evidence, then what you need from them with your recommendation, and links the file. A finished delivery ends with its report, the file `~/.agents/reports/<project>/<ticket>/report.md` where one was written, otherwise the tracker comment: give it to the person in full and show the screenshots themselves, from the tracker's attachments when the files are gone, not only their paths.
