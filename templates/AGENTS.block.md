## agentic-workflow ({project})

This project runs changes through agentic-workflow (lanes: {lanes}; tracker: {tracker}; delivery: {delivery}). Its rules belong to the installed plugin and change with it, so they are not copied here: the owner reads them in the plugin's `work` skill, each role in its own instructions, and `wf resume` always says what is next. `wf` enforces them and says why when it refuses: fix the cause, never work around it.

What holds in every version:

- Work only in the attempt's worktrees under `.wf-worktrees/`, never in the main checkouts.
- Run `wf` from your PATH. Never copy the plugin or its engine to run it, and never change the workflow from a ticket: when `wf` refuses with no route, say so and record it with `wf improve add`.
- Report a step as done only after `wf` accepted it. Gate results, reviews and deliveries are proven by files under `.wf-evidence/`, which no one edits by hand.
- Reserved decisions (waiving a blocking finding, letting an unfixed item leave a delivery, overriding the gate, lifting a hold, escalations) are the user's: write each question for them before it is asked (`--ask <file.json>`: plain context, your recommendation and why, a technical line when it helps), never ask again what they already decided, ask each in your message, quoting the engine's question exactly with its options and asking nothing else, so they can type the answer (a question panel is optional; a typed reply and a panel answer both count; `wf approve <id> --from-question` reads either), or they answer with `wf approve <id>` in their own terminal. Never an agent, never words you put in their mouth.
- A user's "hold", "local only" or "don't push" is recorded at once with `wf hold --reason "<their words>"`; only they lift it.
- Never read, print or move secret values. Missing secrets are entered by the user with `wf secrets guide` in their own terminal.
- Tracker comments describe what to test in product language: no file paths, commits, hashes or test counts. Never set a ticket to done; a human does.
- A finding about the workflow itself is a plugin improvement (`wf improve add`), not a project lesson.

### Project invariants

{invariants}
