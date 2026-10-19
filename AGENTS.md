# Maintaining agentic-workflow

Rules for agents working on this repository (the plugin itself). Terms: project, repo, component, plugin
(CONTRIBUTING.md, "Terms"); never "workspace".

## CI is always green

- A commit reaches main only once GitHub CI ran the whole scenario suite on it (macOS and Linux) and passed: push the
  release branch, run CI on it (`gh workflow run scenarios --ref <branch>`), and fast-forward main once it is green.
  `npm run setup` installs the pre-push hook that checks this. On a shared machine, run only the scenario files a change
  touches, a few at a time, at low priority.
- After every push, watch CI to completion (`gh run watch <id> --exit-status`). Report a release only with the green
  run id.
- A red CI is fixed before any other work. Find the root cause; never retry, skip or loosen a test to make it pass.
- Linux-only failures are real. Reproduce them in the container `npm run verify` uses.

## Every change

- A fix names the failure it fixes (commit message and a "Named failure:" comment in the code) and ships a scenario
  test that reproduces it and fails without the fix.
- This repository is public: no project, company, product or person names anywhere (code, tests, fixtures, docs,
  commit messages). `scenarios/privacy.test.mjs` checks tracked files against your local `.privacy-denylist`.
- A change to what the engine does changes, in the same commit, every text that states it: role texts, skills, the
  session rules (`templates/session-rules.md`), refusal hints, docs and release notes.
- A rule-shaped change (a refusal id, a command, an adapter key, an event type, words in a text agents read) counts
  against `budget.json`; a net increase needs a measured proposal under `proposals/` or a replacement (D98).
  `scripts/release.mjs` refuses a release that grows past the budget.
- Parallel streams or agents that change one tree run the full suite on the combined tree before any of them reports
  done; their changes to one file merge field by field, never one side per hunk.
- Commit with an identity that is fine to publish (a GitHub noreply address).

## Checks and decisions (CONTRIBUTING.md has the detail)

- Agents are fallible, not adversarial (D6). Triage an automated security-review finding against that before writing
  code; one that assumes an adversarial agent is closed as out of model unless an incident shows the behaviour.
- Every refusal is a fact check with an id from the contract's catalogue and a named failure.
- A design decision is written in the decision register (docs/DESIGN.md) in the change that makes it, never left in
  an agent's memory; read the register before reversing one.
