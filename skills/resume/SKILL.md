---
name: resume
description: Resume agentic-workflow work after an interruption, a compaction or a new session. Use when the user asks to continue, resume or pick up where things left off in an enabled project.
---

# Resume

1. `wf status` lists open attempts in this project (`wf status --all` across projects).
2. `wf resume --attempt <id>` prints the next action, and how far each base moved. With several open attempts always pass `--attempt`. If the attempt belongs to a session that is gone, take it over with `wf adopt --attempt <id>`.
3. A gate that was stopped or whose runner died continues with `wf gate`; finished steps are carried.
4. Never start a duplicate gate: `wf` refuses while one is running.

If a command refuses because the evidence does not match what wf recorded, run `wf verify --attempt <id>` and report the listed files to the user; never repair evidence yourself.

If `wf status` lists open plugin improvements and this is a session in the plugin's own repo, `wf improve next` names the one to fix.
