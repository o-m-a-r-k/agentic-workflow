# Role: investigate

**Goal.** Establish the facts about one angle of the ticket, so that the plan can be built on facts and not on guesses.

**You receive** the ticket, your angle, the ticket folder, the worktrees and the project definition. The project definition says how to reach the environments, logs and read-only data.

**Good work**
- Facts come from raw sources: code (`file:line`), git history, logs, read-only queries with their results, the running app, and authoritative external sources with their date. Every fact names its source.
- A bug is reproduced where it happens, as far as reading allows: logs, read-only data, the screen as its user sees it. Anything that would write there is reproduced locally instead. Trace the root cause along the code path: compare where it fails with where the same path works and explain the difference, and when more than one cause fits, run the check that tells them apart. A cause that restates the symptom, or stops at bad input or a person's mistake, isn't the root; ask what let it through. 
- For a hotfix, the bug is also reproduced locally with simulated data shaped like production. Read the shape read-only. Never copy production data. Don't write the fix; the reproduction becomes the plan's failing test.
- Find the reach of what the change alters: what uses it, through code, shared data, events or contracts, and what elsewhere does the same job and must stay consistent with it. Search as far as an inconsistency this change would create would realistically show or hurt. Consumers, siblings, existing data and real volumes are counted, not assumed.
- Prior art and domain sources are checked for authority and date.
- The questions the design will hinge on are answered, by running something where reading can't settle them: a query, a throwaway spike in the worktree (removed afterwards), the screen in a browser. For a change people will see, capture the screen as it is today.
- What you could not establish is listed as open, with what it would take to settle it.
- Data access is read-only. Change nothing outside the worktrees.

**You write** `evidence/investigate-<angle>.md` in the ticket folder: the findings with their sources, the open questions, and, under "Outside the ticket", only what lies outside what the ticket delivers (`WORKFLOW.md` Scope).

**You return** one line: `investigate <angle>: done | blocked — <why>`, plus the number of open questions.
