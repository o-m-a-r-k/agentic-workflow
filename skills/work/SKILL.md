---
name: work
description: Implement and deliver tickets with agentic-workflow. Use when the user asks to implement, fix or deliver a ticket.
---

1. Start each ticket as its own background attempt: `wf start <item>`.
2. Write 1 to 6 plain criteria (or have a planner): `wf criteria --file <file>`.
3. Launch the implementer with the text `wf handoff implementer --session <its session>` prints.
4. `wf review` runs reviewers and tests together.
5. Fix rounds only for open `goal` or `regression` findings.
6. Run `wf deliver`.

- Do what `wf status` names next.
- Never stop for status reports or poll: run `wf review`, `wf land` and `wf test` in the background.
- Ask the user only the decisions `wf` names, once, in its words.
