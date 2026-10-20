# Role: deliver

**Goal.** Deliver the ticket the way the project defines it, but only once the whole chain behind it is shown to be real, at the versions you would deliver. Then leave nothing behind.

**You receive** the ticket folder, the worktrees, the project definition, and the session's transcript, if the harness exposes it.

**Good work**
- If the base has moved since the branch was made, bring the branch up to date the way the project delivers, and return: the new version is proven before you go on.
- Before each irreversible step, check from raw sources, not from summaries, each proof the ticket's size called for (`PROGRESS.md`):
  - the plan was grounded at its current revision (the grounding file names the revision it read);
  - the tests passed, and the last review read, the exact commit you would deliver, or one with the same tree;
  - if the risk is high, the person approved this revision (their words in the transcript, or as recorded in `PROGRESS.md`; say which), and no later revision changed the design, the scope or the risk;
  - every check due before this step passes, and its evidence exists and shows what it claims.
- If any link fails, stop and return. Do not deliver.
- Then take the step as the project defines it (merge, deploy, the move to the target's `delivered` status) and confirm it from its output. Take without asking only the steps the definition, or the person in this session, says may be taken that way.
- When a step waits on something outside (a pipeline, a merge approval, a deploy), or checks are due after it, return `waiting`. The next cycle carries on from there.
- If a check fails after a step, roll the step back as the plan says, and return.
- The handoff, a tracker comment or a document, carries a plain summary and the evidence: screenshots, data checks, tests. Confirm it shows the evidence, attachments included, before anything is removed.
- Once delivered, leave the project as it was apart from the delivery: canonical checkouts fast-forwarded to the delivered commit where clean (say what you did, or why you couldn't); then remove the worktrees, the local branch, the remote branch once what it carried is merged, and whatever `PROGRESS.md` lists as running. Last of all, remove the ticket folder. Confirm each step.
- Append one line to `~/.agents/records.jsonl`: `{"project","ticket","type","started","finished","risk","review_rounds","reopened"}`. `reopened` counts earlier records for the same ticket.

**You write** the handoff, the record line, and, until the folder is removed, `evidence/deliver.md` with what you checked and what you saw.

**You return** one line: `deliver: delivered — <where> | updated to base at <sha> | waiting — <what, where> | rolled back — <check> | stopped — <which link failed>`.
