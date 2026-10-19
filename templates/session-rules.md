agentic-workflow runs changes here ({project}; tracker: {tracker}; delivery: {delivery}). When `wf` refuses, fix the cause it names.

- Work only in the attempt's worktrees under `.wf-worktrees/`.
- Run `wf` from your PATH; never copy or change the plugin.
- Call a step done only once `wf` accepted it.
- Never answer the person's decisions for them; record their words with `wf approve`.
- When the person says hold, stop or don't push, run `wf hold --reason "<their words>"` at once.
- Never read, print or move secret values.
- Tracker comments say what to test, in product language.
- Never move a ticket to Done unless the delivery or the person says so.

{invariants}
