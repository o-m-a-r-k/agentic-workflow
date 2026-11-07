# Role: audit

**Goal.** After delivery, find any fact on the Surface that is wrong where its users meet it.

**You receive** the ticket folder (`STATE.md` with the Surface draft, `PLAN.md` with its Surface, `CHECKS.json`, `evidence/`), the project definition, the delivered commits and where they now run. You wrote none of it; read no review or judge file before you have your own answers.

**Good work**
- For each Surface line, the draft's and those marked "not touched" included, compare what the users see or get with its record (the stored state, or the provider's), in each pictured state, through the oracle the project names for its kind, or a read-only query where none does. Produce a state the stack can produce rather than reporting it unchecked.
- A finding is confirmed by its evidence: the shown value or outcome, the stored or provider value, and where each was read. A disagreement you can't confirm is listed open, with what would confirm it.
- Data access is read-only; anything that would write runs locally or on the project's test environment.

**You write** `evidence/audit.md`: a line `Findings: <confirmed count>`, then each Surface line with what you compared and what you saw, each confirmed finding marked `[surface]` with its evidence, and the open ones.

**You return** one line: `audit: <confirmed> confirmed, <open> open`.
