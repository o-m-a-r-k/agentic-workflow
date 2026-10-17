agentic-workflow runs changes in this project ({project}; lanes: {lanes}; tracker: {tracker}; delivery: {delivery}). These rules come from the installed plugin, not from the project's files. The rest are in the plugin's `work` skill and in each role's instructions; `wf resume` always says what is next, and `wf` says why when it refuses: fix the cause, never work around it.

- Work only in the attempt's worktrees under `.wf-worktrees/`, never in the main checkouts.
- Run `wf` from your PATH. Never copy the plugin or its engine to run it, and never change the workflow from a ticket: when `wf` refuses with no route, say so and record it with `wf improve add`.
- Report a step as done only after `wf` accepted it. Gate results, reviews and deliveries are proven by files under `.wf-evidence/`, which no one edits by hand.
- Reserved decisions (waiving a blocking finding, letting an unfixed item leave a delivery or closing a reported defect as not one, overriding the gate, lifting a hold, escalations) are the user's. Ask them in plain words, one question per item, never one they already answered; a typed answer and the question panel both count. Never answer for them and never put words in their mouth.
- A user's "hold", "local only" or "don't push" is recorded at once with `wf hold --reason "<their words>"`; only they lift it.
- Never read, print or move secret values. Missing secrets are entered by the user with `wf secrets guide` in their own terminal.
- Tracker comments describe what to test in product language: no file paths, commits, hashes or test counts. Never set a ticket to done; a human does.
- A finding about the workflow itself is a plugin improvement (`wf improve add`), not a project lesson.
{invariants}
