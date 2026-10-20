# Changelog

## 0.9.0

A complete replacement. agentic-workflow is now a plugin made only of text: a `deliver` skill with its way of working (`WORKFLOW.md`), role briefs, templates and default role models, and an `onboard` skill that writes each project's definition. The engine, the `wf` CLI, the hooks, the adapters and the scenario suite are gone. It installs in Claude Code and Codex from the same repository.

Every finished delivery ends with a report to the person, the same as the tracker handoff: what changed, its impact and how that was proven, every screenshot, the tickets filed along the way, accepted risks, and where it lives. The report and its screenshots are kept in `~/.agents/reports/<project>/<ticket>/`, so they outlive the ticket folder.

## 0.8 and earlier

See the git history and the `v0.*` tags.
