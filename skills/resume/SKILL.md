---
name: resume
description: Resume agentic-workflow work after an interruption, a compaction or a new session. Use when the user asks to continue, resume or pick up where things left off in an enabled project.
---

# Resume

1. `wf status` lists open attempts in this project (`wf status --all` across projects).
2. `wf resume --attempt <id>` prints the next action, and how far each base moved. With several open attempts always pass `--attempt`. When the user asks this chat to adopt a ticket or attempt, run `wf adopt --item <ticket>` or `wf adopt --attempt <id>` here, then resume it. A direct request such as "adopt ENG-1", "please adopt ENG-1.1", "can you adopt ticket ENG-1", or "I want you to adopt attempt ENG-1.1" is enough: the engine reads and spends that human request from this chat's host transcript. No message or release from the previous session is required, even when it is unavailable. This must be a person's interactive session (terminal or desktop app, never a headless or SDK run). If no current human adoption request exists, ask for one in this chat; do not manufacture a transcript or reopen the old session. For a person-named new owner using the CLI directly, the person types the adoption phrase at their own terminal. Adoption records the previous and new owner, preserves holds and the existing work, refuses closed attempts and stale/replayed requests, and is harmless when this session already owns the attempt. An adoption request does not lift a hold or authorize work beyond the ticket's existing scope.
3. A gate whose runner died, or that was stopped by the owner's decision, continues with `wf gate`; finished steps are carried. A gate stopped for a major finding or a tree change is not resumed: the fixed tree gets a code-review round first, as `wf resume` says.
4. Never start a duplicate gate: `wf` refuses while one is running. Review and gate never run side by side: no reviewer handoff while a gate runs, no gate while a reviewer is at work or before a code-review round on the tree comes back clean.

If a command refuses because the evidence does not match what wf recorded, run `wf verify --attempt <id>` and report the listed files to the user; never repair evidence yourself.

If `wf status` lists open plugin improvements and this is a session in the plugin's own repo, `wf improve next` names the one to fix.
