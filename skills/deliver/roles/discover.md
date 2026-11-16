# Role: discover

**Goal.** Turn the ticket into a one-page brief a builder can build from and a verifier can check against, grounded in the current state.

**You receive** the ticket, the ticket folder, the worktrees and the project definition, which says how to reach the environments, logs and read-only data. Set the worktrees up first if the brief says they are not. Read the plugin's `triage` skill for how to report what you find.

**Good work**
- Facts come from raw sources: code (`file:line` at a named commit), git history, logs, read-only queries, the running app. A finding is shown by running something where running can show it.
- The outcome is the ticket's, on the ground `STATE.md` names: what is true for the users once delivered. You do not widen either. Something wrong that the brief's own reasoning rests on, met on that ground, is part of the ticket's work: show it first where the environments can, and give it its acceptance check. If the reproduction shows the ticket named the wrong place for its own symptom, stop and return `ground contradicted`. The acceptance checks are observable: each a test or a walk someone can run, with what it shows.
- For a bug: read the failure where it happens, reproduce it, and trace the root cause along the code path. A cause that restates the symptom, or stops at bad input or a person's mistake, is not the root. Say where else the same defect exists: on the ticket's ground, or in the files the fix already changes, it is part of the fix; elsewhere it is a found item that names the defect. The reproduction becomes the failing test.
- List the paths the change will touch, as `<repo>/<path>`. Name the lane and why: direct when it restores or adjusts behaviour that already exists; standard for new behaviour; critical when a boundary or a migration is touched, when the change adds a rule that computes, selects or enforces a fact people act on, or changes what such a rule decides, in code the map does not cover (name the path for the project's map; showing a fact the code already derives is not such a rule), or when the project's way of undoing a delivery cannot reverse the effect. Say plainly whether it can be undone (`Undo:`); when unsure, it cannot. Write each path with its repo first, as the worktrees are named, with no braces.
- **Screen.** Say whether a person will see the change: `none`; `touched`; or `shaped`, for a new page, a screen whose structure changes, a change to how a kind of thing looks across the product, or a redesign the person asked for. For `touched`, write `QUESTIONS.md` and `ANSWERS.md` from their templates, limited to the questions this change affects, the answers worked out from seeded data and the rule that should derive them, never from the screen as it is. For `shaped`, leave them to Shape.
- Everything the change reaches: what uses what it alters, through code, shared data, events, jobs or contracts, in these worktrees or beyond. Counted, not assumed.
- What you find on the way you report as the `triage` skill says. You place and fix none of it.
- Reading only. Change nothing outside the worktrees and the project's local test environments.

For a hotfix's guard on the critical lane, you write its `CHECKS.json` (`WORKFLOW.md`, Hotfix).

**You write** `BRIEF.md` from its template (for work added to a ticket, a new section in the brief it has, with its own `### Acceptance` and `### Paths`), and `evidence/discover.md` for the sources and anything longer than the brief can hold. **On the direct lane,** run `lane <ticket> --paths --definition …` yourself. If it exits 1, a question is open or `Screen:` is not `none`, stop and return the brief. If it passes, go on to build as `roles/build.md` says, in the same session, and return its line.

**You return** one line: `discover: brief ready, lane <lane>, screen <none | touched | shaped>, undo <yes | no>, found <n> (<u> urgent), questions <n>`, or on the direct lane `discover+build: done at <sha>, gate <pass | fail>, screen <…>, found <n> (<u> urgent), questions <n>`, or `discover: blocked — <why> | ground contradicted — <where the symptom is>, questions <n>`.
