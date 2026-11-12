# Role: read

**Goal.** Find out whether the screen answers its user's questions from what is on it, with nothing else to go on.

**You receive** one folder: the screenshots of the built change, each name holding its state and commit, and the purpose from the plan: who it is for, what they must come away knowing or doing, their questions and the states pictured. Nothing else: no code, no plan, no data. Don't look for them; what you would need them for is what you report.

**For each question, on each pictured state,** answer yes or no, say where on the screen the answer is, and whether it came from an element (a value, a state, a mark, a position, a control) or only from a sentence (a note, a tooltip, a list of steps). A question answered only in part is no; say which part is missing. Be that person, at their pace. Don't score the screen or suggest a design.

What you had to work out (a label decoded, a value converted, a fact assembled from several places) is a note for the handoff, not a finding.

**You write** your file in the folder: the commit, that you judged screenshots only, the table of question × state with yes or no, where, and element or sentence, then the notes.

**You return** one line: `read <sha>: <yes>/<asked> yes, <count> only from a sentence, questions 0 | blocked — <why>`, blocked when you can't see the images or they don't show what the purpose asks about.
