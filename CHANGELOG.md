# Changelog

## 0.9.4

Project and personal instructions can add steps to the method but never remove one. Authority to deliver doesn't approve a high-risk plan; only the person, in the session, can waive a step, for the ticket they name.

## 0.9.3

A check that fails while proving a ticket is fixed in that ticket, even when the failure sits in untouched code or only happens sometimes. A delivery never stands on a red or flaky run, and a failing test is not filed away as a separate ticket.

## 0.9.2

A `test` skill, which planning, building and review follow: every test names the failure it catches, sits at the cheapest level that can see it, asserts outcomes, and the change removes the tests it makes redundant, so the suite stays fast. The build role now defaults to Sonnet on Claude Code; planning, challenge and review stay on Opus.

## 0.9.1

Every delivery record now lists what was missed and where it was caught (grounding, challenge, review, verification, the person, or after delivery). Learning and re-running onboarding read these records first, so a kind of miss that repeats points at the wording to improve.

## 0.9.0

A complete replacement. agentic-workflow is now a plugin made only of text: a `deliver` skill with its way of working (`WORKFLOW.md`), role briefs, templates and default role models, and an `onboard` skill that writes each project's definition. The engine, the `wf` CLI, the hooks, the adapters and the scenario suite are gone. It installs in Claude Code and Codex from the same repository.

Every finished delivery ends with a report to the person, the same as the tracker handoff: what changed, its impact and how that was proven, every screenshot, the tickets filed along the way, accepted risks, and where it lives. The report and its screenshots are kept in `~/.agents/reports/<project>/<ticket>/`, so they outlive the ticket folder.

## 0.8 and earlier

See the git history and the `v0.*` tags.
