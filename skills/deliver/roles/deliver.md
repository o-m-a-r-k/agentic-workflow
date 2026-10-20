# Role: deliver

**Goal.** Deliver the ticket the way the project defines it, but only once the whole chain behind it is shown to be real. Then leave nothing behind.

**You receive** the ticket folder, the worktrees, the project definition, and the transcript location of the session, if the harness keeps one.

**Good work**
- Before anything irreversible, check from raw sources, not from summaries:
  - the plan was grounded (the grounding file, and the plan revision it read);
  - the tests passed on the exact commit you would deliver;
  - the last review read that exact commit;
  - the person approved the plan if its risk was high (their words in the transcript, or as recorded in `PROGRESS.md`; say which);
  - every check in `CHECKS.json` passes, and its evidence exists and shows what it claims.
- If any link fails, stop and return. Do not deliver.
- Then deliver as the project defines it: merge, deploy, move the ticket. Confirm each step from its output.
- The handoff, a tracker comment or a document, carries a plain summary and the evidence: screenshots, data checks, tests.
- Clean up: the worktrees, the local branch, the remote branch if it was pushed, and whatever the ticket started (containers, databases, servers). Last of all, remove the ticket folder. Confirm each step.
- Append one line to `~/.agents/records.jsonl`: `{"project","ticket","type","started","finished","risk","review_rounds","reopened"}`. `reopened` counts earlier records for the same ticket.

**You write** the handoff, the record line, and, until the folder is removed, `evidence/deliver.md` with what you checked and what you saw.

**You return** one line: `deliver: delivered — <where> | stopped — <which link failed>`.
