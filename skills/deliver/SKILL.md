---
name: deliver
description: Deliver one ticket or several, at a depth set by what the change can damage, from discovery to verified delivery and cleanup, with fresh agents checking the work. Use when the person asks to fix, implement, build or deliver a ticket, or to continue one.
---

# Deliver

You orchestrate, in the session the person talks to. You own each ticket's outcome. Workers do the work and write it to the ticket folder; you read the state and the scripts' output, decide the next move and start workers. Keep the work out of your context: you run no tests, builds or servers.

**The skill folder** is the folder containing this file: `${CLAUDE_SKILL_DIR}` in Claude Code, or the path this file was loaded from. Scripts run as `node <skill folder>/scripts/<name>.mjs`.

## At the start of a session

Read once, and again after the harness compacts your context:

1. `WORKFLOW.md` in the skill folder.
2. The project definition: a repo-held `.agents/project.md` in the current directory, the nearest directory above it, or a sibling folder (the one whose `repos` include the current repo; if several or none qualify, ask). Otherwise `~/.agents/projects/<project>.md` whose `roots` contain the current directory. A `~/.agents/projects/<project>.local.md` adds this machine's facts and never removes a step. With no definition, run the `onboard` skill first.
3. `~/.agents/workflow.yaml`, with the active profile applied (see Settings).

## Each cycle

A cycle runs whenever a worker returns or the person writes. Read each ticket's `STATE.md`, the return line, and the result file of any script that ran (`evidence/lane.md`, `gate.md`, `words.md`, `checks.json`). Then decide each ticket's next move by `WORKFLOW.md` and start its workers. Tickets move independently.

- **Take** a new ticket yourself: the folder, the worktrees, the tracker status, and `STATE.md` from `templates/` with the outcome and the `Ground:` in the ticket's own terms. Every other file is made from its template by whoever writes it. Tell the person in one line the outcome and the lane you expect.
- **After Discover:** run `lane <ticket> --paths --definition …`. A floor above the brief's lane raises it; a path it cannot place goes back to Discover. Record the lane and `Screen:` in `STATE.md`. A ground Discover found contradicted goes to the person in one line; only their word changes it. Where the brief says `Undo: no`, ask for the approval when `WORKFLOW.md` "Decisions and the person" says.
- **After every build, fix rounds included:** run `lane <ticket> --definition …` on the diff. A rise starts the skipped steps, and you tell the builder what they conclude; a screen or new page it reports that `STATE.md` does not have starts Read or Shape the same way.
- **Verifiers:** the direct lane's reads `roles/verify.md` and takes its model from the role `verify-direct`. On the critical lane start one per boundary `lane` named, each told its boundary; where it named none, one for what made the lane critical: the rule Discover or a verifier named, or the data and its way back. After a fix there, each of them that reported a finding, or whose verification no longer stands for the new commit, gets its own confirming check, started together.
- **Start Verify and Read together** where both apply: three readers for a shaped screen, one otherwise, and after a fix one reader on the changed states. Run `words <ticket>` after each capture; name a state whose words grew to the builder in that fix round, once, and show the counts in the handoff.
- **Score the readers' answers against the answer key yourself** (`roles/read-score.md`): the reader never sees the key. Write the result to `evidence/read-<n>.md`, and remove the readers' folders.
- **Freeze the question sheet** when the person has seen it (for an unshaped change, when Discover returns): record `Question sheet: <first 12 of its sha256>` in `STATE.md` (as `shasum -a 256` prints it). A later change to it is shown to the person before you record the new value.
- **Count the open findings after every round.** Before a second fix round in a delivery, start a reconsider and follow its ruling (`WORKFLOW.md` "How loops end" rule 3): a changed approach or a removed item is the builder's next job, a product question goes to the decision judge. Give each confirming checker the earlier confirm files, so it can tell a finding reported not closed before.
- **Found items:** workers report them and place none. When every verifier has returned and any return line of this delivery had `found` above 0, start one triage judge (`roles/triage.md`); for a line with `urgent` above 0, start it at once on those items. Record its rulings under `## Found on the way`, open the ticket it rules (one for everything it ruled the next ticket) and tell the person, and give its `finding` and `fix here` items to the builder with the verifiers' findings as one fix round, once the decision judge has answered what it wrote under `## Questions`; the builder gets each answer with its item. A `finding` whose line names a boundary the design does not cover goes to the designer first, for its Surface line and its check, with no new challenge. That round always ends in a confirming check that answers each item by its id, whatever verification still stands. A `found` reported after the judge ruled is a `[note]` unless it is urgent. Only the judge's rulings open tickets.
- **Gate and ready:** before any delivery step `ready <ticket> --definition …` must exit 0; when it fails, each failing row names the step to start again: the gate, and on the critical lane `checks`, by whoever last moved the branch; a confirming check for a verification that no longer stands or whose findings none has answered; one reader for a read that no longer holds. `ready` does not read the triage rulings: before a delivery step, see that every `[fixed]` line under `## Found on the way` has its commit and a confirm line that answers its id. When `gate` reports a consumer repository with no worktree, add that worktree at its base and have it run again.
- **Work the person adds** to a ticket starts at Discover (`WORKFLOW.md`, after the rejections).
- **A worker's questions** (its return line ends `questions <n>`) go to a decision judge at once, while other work goes on; its answer goes to the worker that asked, or the next of its role.
- **A return nothing above covers** (`blocked`, `waiting`, `stopped`, `to design` where there is no designer): a fresh worker of that role resumes it where one can; otherwise tell the person in one line what stopped and what it needs.

## Where things stand

You alone write `STATE.md`: its fixed fields, overwritten each cycle, never a narrative. Append to `evidence/log.md` one line when a worker starts, `<ISO time> start <role>`, and one when it returns, `<ISO time> return <role>: <status>`; `record` measures idle time from them. A worker whose files have stopped moving for far longer than its step needs, or whose session ended, is gone: append `return <role>: gone`, and a fresh worker restarts its step from what was left. A wait is a step only where the definition names it (a pipeline, a deploy): come back at the time it gives, through the harness's own scheduling where it has one. Anything else that would leave a ticket waiting has its cause fixed in the ticket; only what cannot be fixed there goes to the person, in one line with what each way out costs. When your context grows heavy, make sure `STATE.md` is current; the next cycle resumes from the files.

## Starting a worker

Every worker is fresh: started through the harness's general-purpose sub-agent, without your history, never a fork. In Codex, pass `fork_turns: "none"` where the spawn tool offers it. Where the harness shows a worker's name or description, give its role and ticket, so the person can tell the workers apart. Its brief is paths and facts:

- its role file, `roles/<role>.md`, which it reads first, whole, and the skills that file names;
- the absolute paths of the ticket folder, the worktrees, the project definition (and its `.local.md`), `WORKFLOW.md` and the skill folder;
- its particular job: the lane, the boundary, the findings to confirm;
- this, in these words: "Before you work in a repo, read the `AGENTS.md` of the worktree and of each directory you touch. Run every command from inside the worktree. Keep what you found, with its source, apart from what you propose. A question no source settles goes under `## Questions` in your file; you never decide it yourself, and your return line ends `questions <n>`. What you meet that the ticket did not ask for goes under `## Found on the way` in your file, as the `triage` skill says; you fix none of it. Ask for an access the way the harness grants permissions, and name what a refusal stopped rather than working around it. Before you finish, remove what you started or created that the next step does not need, and name what it does need with how to remove it. What the project's environments can produce, you produce and check; never report it as unchecked."

**Readers and direction builders get less.** A reader gets a folder holding only the screenshots and the questions, and its role file: no worktree, no brief, no answer key, no earlier round. Each direction builder gets the question sheet and its one organising idea, not the other directions.

The brief adds the ticket's facts. It never narrows the method or decides a worker's findings.

**Models.** If the settings say `models: session`, pass no model. Otherwise take each role's model and effort from the first of these that sets it: the project definition's `roles.<harness>.<role>`; `~/.agents/workflow.yaml` `roles.<harness>.<role>`; `defaults.yaml` in the skill folder; the session's own. `<harness>` is `claude` or `codex`.

A worker returns one line. Record it, and read its file only when the next decision needs it.

## The person

Write to the person only for what `WORKFLOW.md` "Decisions and the person" lists, and for a finished delivery. Never put a blocking dialog in front of them while any step can proceed. Each message opens with where the outcome stands, then what you need, if anything.

- **A screen's direction:** one message with the question sheet, the three screenshots side by side, one line each on what that direction gives up, and your recommendation. When they pick, remove the directions' worktrees the build does not need.
- **A finished delivery:** the handoff, in full.
- **A rejection:** restate it in one line with the class you took it as, and act; they correct the class if it is wrong. Add it under `## Rejections` in `STATE.md`.
- **A hotfix or next ticket opened:** one line saying what and why.
- **After delivery:** an audit's result, in one line. A wrong fact it confirmed, or a check that fails after a delivery step, is a defect on this ticket, fixed as a hotfix where users meet it now.

Record their standing instructions in `STATE.md`, in their words, and never ask again what they settle.

## Settings

`~/.agents/workflow.yaml` holds the person's settings. A key left out keeps its default.

- `agents_at_once`: how many workers run at once, across every ticket. Unset, as many as the work allows.
- `heavy_runs`: how many heavy test runs go at once. Unset, the project definition decides.
- `context_tokens`: the session model's context window. When set, tell each worker to read only the parts of files it needs and send long output to `evidence/`.
- `models: session`: every role runs on the session's model.
- `roles.<harness>.<role>`: a role's model and effort.
- `profiles.<name>`: any of the keys above, merged over the top-level keys. A profile is active when the person names it, or when `AGENTS_WORKFLOW_PROFILE` does; record it in `STATE.md`.
