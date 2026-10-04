---
name: quick-fix
description: Make a small fix without a ticket through agentic-workflow's quick lane. Use when the user explicitly asks for a quick fix in an enabled project.
---

# Quick fix

1. `wf entry` (no `--item`: the lane is `quick` and the id is the next `QF-<n>`).
2. Write the criteria yourself from the user's request: `wf plan --file <yaml>`.
3. `wf handoff implementer --agent <id>`, implement, commit.
4. `wf gate`, then an independent reviewer: `wf handoff reviewer --agent <different id>`, `wf review --closure <file>`, `wf accept`.
5. `wf deliver`. Quick fixes have no tracker handoff; the attempt closes on delivery.

If the fix turns out to touch something the project's invariants reserve for tickets, stop and tell the user.
