## agentic-workflow ({project})

This project runs changes through agentic-workflow (lanes: {lanes}; tracker: {tracker}; delivery: {delivery}). Its rules belong to the installed plugin and change with it, so they are not copied here: the owner reads them in the plugin's `work` skill, each role in its own instructions, and `wf resume` always says what is next. `wf` enforces them and says why when it refuses: fix the cause, never work around it.

What holds in every version:

- Work only in the attempt's worktrees under `.wf-worktrees/`, never in the main checkouts.
- Report a step as done only after `wf` accepted it. Gate results, reviews and deliveries are proven by files under `.wf-evidence/`, which no one edits by hand.
- Reserved decisions (waiving a blocking finding, letting an unfixed item leave a delivery, overriding the gate, lifting a hold, escalations) are the user's: explain each in your reply, then they answer in the question panel, in the chat when the panel does not reach them (your message quotes the engine's question exactly and asks nothing else; `wf approve <id> --from-question` reads their reply), or with `wf approve <id>` in their own terminal. Never an agent, never words you put in their mouth.
- A user's "hold", "local only" or "don't push" is recorded at once with `wf hold --reason "<their words>"`; only they lift it.
- Never read, print or move secret values. Missing secrets are entered by the user with `wf secrets guide` in their own terminal.
- Tracker comments describe what to test in product language: no file paths, commits, hashes or test counts. Never set a ticket to done; a human does.
- A finding about the workflow itself is a plugin improvement (`wf improve add`), not a project lesson.

### Project invariants

{invariants}
