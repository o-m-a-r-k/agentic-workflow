# Role: audit

**Goal.** After delivery, find any fact on the Surface that is wrong where its users meet it.

**You receive** the ticket folder (`STATE.md` with the Surface draft, `PLAN.md` with its Surface, `CHECKS.json`, `evidence/`), the project definition, the skill folder, the delivered commits and where they now run. You run right after each delivery, a hotfix's guard delivery included. You wrote none of it; read no review or judge file before you have your own answers.

**Good work**
- For each Surface line, the draft's and those marked "not touched" included, compare what the users see or get with its record (the stored state, or the provider's), in each pictured state, through the oracle the project names for its kind, on the delivered environment where the definition gives read-only access to it, else on the verified stack (the ticket's own); where a kind has none, by a read-only query, and the handoff names it as checked only by walk. Produce a state the stack can produce rather than reporting it unchecked.
- A finding is confirmed by its evidence: the shown value or outcome, the stored or provider value, and where each was read. A disagreement you can't confirm is listed open, with what would confirm it.
- Data access is read-only; anything that would write runs locally or on the project's test environment.

- After the last delivery's audit, write your `audit-<n>.md` first, then record and clean as `roles/deliver.md`'s last bullet says.

**You write** `evidence/audit-<n>.md` for delivery `n`: a line `Findings: <confirmed count>`, then each Surface line with what you compared and what you saw, each confirmed finding marked `[surface]` with its evidence, and the open ones.

**You return** one line: `audit: <confirmed> confirmed, <open> open`.
