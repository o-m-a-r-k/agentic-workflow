---
name: resume
description: Resume agentic-workflow work after an interruption, a compaction or a new session. Use when the user asks to continue, resume or pick up where things left off in an enabled project.
---

# Resume

1. `wf status` lists open attempts in this project (`wf status --all` across projects).
2. `wf resume --attempt <id>` prints the next action, and how far each base moved. With several open attempts always pass `--attempt`. If the attempt belongs to a session that is gone, the user takes it over: they reopen the old owner session (for Claude Code, `claude --resume <session id>`) and start a message there with `adopt <attempt id>:<this session>` (for example `adopt ENG-1.1:claude:<this session's id>`), then start a message in this session with `adopt <attempt id>`, then `wf adopt --attempt <id>` (the engine reads both messages; it never takes your word for it). This session must be a person's interactive session (the terminal or the desktop app, not a headless or SDK run); for an attempt owned by a person's name, the owner types `adopt <attempt id>:<this session>` at their own terminal instead.
3. A gate whose runner died, or that was stopped by the owner's decision, continues with `wf gate`; finished steps are carried. A gate stopped for a major finding or a tree change is not resumed: the fixed tree gets a code-review round first, as `wf resume` says.
4. Never start a duplicate gate: `wf` refuses while one is running. Review and gate never run side by side: no reviewer handoff while a gate runs, no gate while a reviewer is at work or before a code-review round on the tree comes back clean.

If a command refuses because the evidence does not match what wf recorded, run `wf verify --attempt <id>` and report the listed files to the user; never repair evidence yourself.

If `wf status` lists open plugin improvements and this is a session in the plugin's own repo, `wf improve next` names the one to fix.
