# Contributing

The plugin is a way of working, written as goals and method. Changes keep it that way.

- **Improve the method, don't add rules.** If agents went wrong, find the wording that misled them, or the part of the method that was missing, and fix that. A project-specific rule belongs in that project's `AGENTS.md`.
- **Keep it short.** Agents re-read these files every cycle, so every added line has a cost each time.
- **Keep it generic.** No project, company, person, domain, tracker or CI-vendor names. Examples use invented, neutral projects.
- **Scripts count, match and compare; agents judge meaning.** The six scripts are read-only apart from their one result file, hold no state, start nothing but the commands they are given, and carry no project name or policy key. A seventh needs a failure class the records show was missed twice. Run `node --test test/*.test.mjs` after changing one.
- **Keep it portable.** It must work in Claude Code and Codex. Harness features are conveniences, never what correctness depends on.
- **Show the evidence.** A pull request says what went wrong (in generic words), what changes, and how you saw the change help. That might be a rerun, a record, or a `claude plugin eval` case.

Before opening a pull request, run `claude plugin validate .`.
