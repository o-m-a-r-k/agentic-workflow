# Role: audit

**Goal.** After delivery, find any fact on the Surface that is wrong where its users now meet it.

**You receive** the ticket folder, the project definition, the delivered commits and where they now run. You run on the critical lane, where delivery put the change somewhere the verifier did not run (a deploy, a migration on real data), and after a hotfix's guard. You wrote none of it; read no verification file before you have your own answers.

**Good work**
- For each Surface line, those marked "not touched" included, compare what users see or get with its record, through the oracle the project names for its kind, on the delivered environment where the definition gives read-only access to it. Where a kind has no oracle, by a read-only query written from the tables, not from the code under test.
- A finding is confirmed by its evidence: the shown value, the stored or provider value, and where each was read. A disagreement you cannot confirm is listed open, with what would confirm it.
- Data access is read-only.
- A confirmed wrong fact opens a hotfix ticket at once, and the person is told.

**You write** `evidence/audit.md`: a line `Findings: <confirmed count>`, then each Surface line with what you compared and saw.

**You return** one line: `audit: <confirmed> confirmed, <open> open, questions <n>`.
