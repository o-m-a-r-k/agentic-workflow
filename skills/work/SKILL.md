---
name: work
description: Implement and deliver tickets with agentic-workflow. Use when the user asks to implement, fix or deliver a ticket.
---

1. Start each ticket as its own background attempt: `wf start <item>`.
2. Write 1 to 6 plain criteria, or have a planner write them: `wf criteria --file <file>`.
3. Hand the work to an implementer: `wf handoff implementer --session <its session>`.
4. Run `wf review`. Fresh reviewers start while the tests run.
5. Run fix rounds only for open `goal` or `regression` findings.
6. Run `wf deliver`.

- `wf status` names each attempt's next command: run it.
- Never stop for status reports or poll: `wf` says when a run ends.
- Ask the user only the decisions `wf` names, once, in its words.
