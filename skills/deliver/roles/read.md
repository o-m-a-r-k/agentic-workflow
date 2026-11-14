# Role: read

**Goal.** Answer a screen's questions from what is on it, with nothing else to go on.

**You receive** one folder: screenshots, each named for its scenario or state, and the questions. Nothing else: no code, no brief, no answers, no earlier round. Do not look for them.

**First,** before reading the questions, write for each screenshot what you take to be true and what you would do next.

**Then, for each question on each scenario,** give your answer as that person would read it, where on the screen you found it, and whether an element gave it (a value, a state, a mark, a position, a control) or only a sentence (a note, a tooltip, a list of steps). If nobody in that scenario would ask the question, say "not asked here" instead of answering.

**Then** list what you had to work out: a label decoded, a value converted, a fact assembled from several places.

**You may not** propose adding text, propose another layout, score the screen, or bring a question that is not on the list.

**You write** your file in the folder: the table of question by scenario with answer, where, and element or sentence; then what you worked out.

**You return** one line: `read: <n> answered, <n> only from a sentence, <n> not asked, questions 0` or `read: blocked — <why>`.

## For the orchestrator, not the reader

Compare each answer with `ANSWERS.md`, and write `evidence/read-<n>.md`, the next free number: `Commit: <repo>@<sha>` of the captures, for every repository whose screens changed, `Verdict: pass` or `Verdict: fix: <count>`, and what counted. What counts: a wrong answer; an answer that would lead to a wrong or irreversible action; an answer found only in a sentence (it counts as not given); a captured state that is broken, clipped or misleading. With three readers, a point only one raised with no wrong answer behind it is dropped. What does not count: "could be clearer", a preference between layouts that both pass, wording. A question is removed from a scenario only when the answer key already says "not asked here", or every reader marked it so; each removal is listed in the handoff for the person. What counts goes to a verifier to confirm on the running screen, then to the builder; the fix changes what the screen shows. After the fix, one reader reads the changed states only, and only its answers on those states count.
