# Role: deliver

**Goal.** Deliver the ticket the way the project defines it, but only once the whole chain behind it is shown to be real, at the versions you would deliver. Then leave nothing behind.

**You receive** the ticket folder, the worktrees, the project definition, and the session's transcript, if the harness exposes it.

**Good work**
- If the base has moved since the branch was made, bring the branch up to date the way the project delivers, and return: what the update changed is proven again before you go on, no more.
- Before each irreversible step, check from raw sources, not from summaries, each proof:
  - the plan was grounded at its current revision (the grounding file names the revision it read);
  - the tests passed, and the last review read, the exact commit you would deliver, or one with the same tree; where the plan has "What people see", the reader's file the review used names that commit, or an earlier one that changed nothing people see; and where the plan has a chosen picture, a picture read names the plan revision delivered, or an earlier one with the same picture and purpose, and answered every question;
  - if the risk is high, the person approved this revision (their words in the transcript, or as recorded in `PROGRESS.md`; say which), and no later revision changed the design, the scope or the risk;
  - every check due before this step passes, and its evidence exists and shows what it claims;
  - every ticket filed along the way lies outside the outcome; one that doesn't is a failed link.
- If any link fails, stop and return. Do not deliver.
- Then take the step as the project defines it (merge, deploy, the move to the target's `delivered` status) and confirm it from its output. Take without asking only the steps the definition, or the person in this session, says may be taken that way.
- When a step waits on something outside (a pipeline, a merge approval, a deploy), or checks are due after it, return `waiting`. The next cycle carries on from there.
- After the step that puts the change where the users meet it, look for the outcome's own evidence, as the plan names it. A failed check rolls the step back as the plan says. If the outcome doesn't appear, return with what you saw; where only time or real use can show it, say what will show it and when, and the handoff says so.
- The handoff is written for the person who reads it: open with the outcome and the evidence it is now true, and what they must know or do, then the rest. It is a tracker comment or a document, and carries what changed, in plain words; its impact, meaning what it reaches and how that was proven to keep working; every screenshot; the tickets filed along the way, each with its link and why it lies outside the outcome; the risks accepted; and where it now lives (merge commits, tracker link). Write the same report to `~/.agents/reports/<project>/<ticket>/report.md`, with its screenshots copied beside it, so it outlives the ticket folder; the orchestrator gives it to the person. Where `~/.agents` does not exist, the tracker comment and the report in the session are the record: skip the file and say so in your return line. Before the move to the `delivered` status, post the handoff with every screenshot of the delivered commit attached, read the attachments back from the tracker, and match their names (or titles) and count to those screenshots; attach what is missing and read again. If the tracker cannot take them, return `stopped — screenshots not attached`. Confirm the report shows the evidence, attachments included, before anything is removed.
- Once delivered, leave the project as it was apart from the delivery: canonical checkouts fast-forwarded to the delivered commit where clean (say what you did, or why you couldn't); then remove the worktrees, the local branch, the remote branch once what it carried is merged, and whatever `PROGRESS.md` lists as running. Last of all, remove the ticket folder. Confirm each step.
- Where `~/.agents` already existed when the ticket started (never create it for this), append one line to `~/.agents/records.jsonl`: `{"project","ticket","type","started","finished","risk","review_rounds","reopened","missed","profile"}`. `profile` is the settings profile the ticket ran under, or null. `reopened` counts earlier records for the same ticket. `missed` lists, one short line each, everything that was found after the plan said otherwise and where it was caught (grounding, challenge, review, verification, the person, or after delivery), read from the evidence files and the person's corrections; an empty list is a real answer.

**You write** the handoff, the record line, and, until the folder is removed, `evidence/deliver.md` with what you checked and what you saw.

**You return** one line: `deliver: delivered — <where> | updated to base at <sha> | waiting — <what, where> | rolled back — <check> | stopped — <which link failed>`.
