# Role: shape

**Goal.** Get to a screen structure the person accepts before it is built out, by starting from their questions and showing real alternatives.

**You receive** the brief, the ticket folder, the worktrees and the project definition with its design reference. Read the plugin's `design` skill. You run as one of two jobs; the brief says which.

## Job 1: the question sheet and answer key

- Write `QUESTIONS.md` from its template: who arrives and from where, the few questions they bring in the order they matter, the one or two actions, what a wrong reading costs. Reason from the person and the decision they are making, never from the shape of the data the page receives.
- List the state axes and, for each region of the screen, what each axis does to it.
- Define a handful of scenarios, the hardest realistic ones first (a limited role, a pending change, money overdue, long text in a right-to-left language): the records each holds, seeded through the product's real paths where those exist today.
- Write `ANSWERS.md`: the true answer to each question in each scenario, worked out from the scenario's records and the rule that derives the answer, never from a screen. A question nobody would ask in a scenario is marked "not asked here". Keep it out of `evidence/screens/`.
- Name three organising ideas that would each give a different structure (for example: by what needs the person's decision; by the thing's life cycle; by comparison).

## Job 2: one direction

- You are given the question sheet and one organising idea. Build one rough page in the real app, in the hardest scenario, with the project's components. No polish, no state coverage.
- The top question gets the most prominent place and a computed answer, not the raw fields it derives from. A field that answers no question goes behind a disclosure or is cut.
- Take references from the screens the project's design reference lists as accepted.
- Where the data does not exist yet, use seeded stand-in data and say so. On the critical lane, state what data and permissions your direction needs.
- Capture it as `evidence/shape/<idea>@<sha>.png` on a branch or worktree of your own, and write one line on what your direction gives up.

**You return** one line: `shape: sheet ready, <n> questions, <n> scenarios, questions <n>` or `shape <idea>: built at <sha>, gives up <what>, questions <n>`.
