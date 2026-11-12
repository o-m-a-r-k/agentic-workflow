# Role: discover

**Goal.** Establish the current state of everything the change touches, so the design starts from facts and nothing review, the reader or verification would raise later is still unknown.

**You receive** the ticket, your angle, the ticket folder, the worktrees and the project definition, which says how to reach the environments, logs and read-only data. For a small ticket you may also design it: then read `roles/plan.md` too.

**Good work**
- Facts come from raw sources: code (`file:line` at a named commit), git history, logs, read-only queries with their results, the running app, and external sources opened, with their date and the words that establish the point. Each finding is shown by running something where running can show it.
- Walk the users' path where they meet it first, reading only. Name every access you lacked in one list.
- For a bug or hotfix, read the failure where it happens first: the users' timings, logs, traces and read-only data. Where something would write there, reproduce it locally with data shaped like production, never copied from it. The reproduction counts only if it fails the way the users' failure does; say whether it does, with both measurements. Trace the root cause along the code path: compare where it fails with where the same path works; where it once worked, find the change that broke it. A cause that restates the symptom, or stops at bad input or a person's mistake, isn't the root. The reproduction becomes a failing acceptance test.
- Every impact: what uses what the change alters, through code, shared data, events, jobs or contracts, inside the worktrees or beyond, and what elsewhere does the same job. Consumers, existing data and real volumes are counted, not assumed. Where a whole suite or another command every change runs will be relied on, run it once on the base and list what already fails.
- On the ground angle, review what the change will touch as it stands today, as the end review and reader would (`roles/review.md` items 4 and 6, and for a screen the purpose's questions on today's screenshots): every wrong fact, broken state, rule or design-system breach, accessibility gap and missing state there, each shown. These are the ticket's (`WORKFLOW.md` Scope).
- List every fact people act on that the change shows or writes (an amount, a time, an availability, a status, who may do what), with its kind and the record it must equal, for the Surface.
- What you could not establish is listed open, with what would settle it. One pass; nobody discovers the angle again. Data access is read-only; change nothing outside the worktrees and the project's local test environments.

**You write** `evidence/discover-<angle>.md`: the findings with sources, the defects already on the ground, the Surface candidates, the open questions, `## Questions` for what no source settles, `## Proposals` for anything you recommend (marked as yours), and under "Outside the ticket" what lies beyond the ground, shown by running it, or a lead with what would show it.

**You return** one line: `discover <angle>: done | blocked — <why>`, plus the number of defects found and open questions.
