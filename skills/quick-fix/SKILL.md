---
name: quick-fix
description: Make a small fix without a ticket through agentic-workflow's quick lane. Use when the user explicitly asks for a quick fix in an enabled project.
---

# Quick fix

With more than one open attempt, pass `--attempt <id>` to every `wf` command.

1. `wf entry` (no `--item`: the lane is `quick` and the id is the next `QF-<n>`).
2. Write the criteria yourself from the user's request: `wf plan --file <yaml>`.
3. `wf handoff implementer --agent <id>`, implement, commit. While iterating run only the specs you changed; before the gate run the repo's lint and full unit suite once.
4. Independent review once it is committed: `wf handoff reviewer --agent <new id>` (a fresh agent every round, never the implementer or an earlier reviewer) and start it blind, with exactly the one line that command prints and nothing else (no hints, summaries, focus areas or earlier findings), then `wf review --closure <file>`. `wf gate` may run in parallel (never edit the worktree while it runs). Fix findings through the implementer, commit, `wf gate`, and hand the fixed tree to a new reviewer; the round handed the tree after its gate passed is the evidence pass. `wf accept` needs a passing gate and a clean closure written after it on the current tree. A `--focused` gate does not count for acceptance or delivery.
5. `wf deliver`. Quick fixes have no tracker handoff; the attempt closes on delivery.
6. After the review and at delivery, `wf export --attempt <id>`; publish it as one private Artifact per attempt, updated in place, when an Artifact tool is available, otherwise give the file path. It is a view of the evidence, never its source, and carries no secrets.

Start the agent type `wf handoff` prints (`wf-implementer`, `wf-reviewer`), never `general-purpose`, and never pass `model` on the Agent call. Start it under the name the handoff prints (`name it <id>`; for the reviewer on stderr). If that type is not registered in this session, or the handoff warns that its role file changed after the session started, ask the user to restart the session. If the fix turns out to touch something the project's invariants reserve for tickets, stop and tell the user.
