# Maintaining agentic-workflow

Rules for agents working on this repository (the plugin itself). Terms: project, repo, component, plugin (README,
"Terms"); never "workspace".

## CI is always green

- Never push without a green `npm run verify`: the scenario suite on this machine and in a Linux container, as a
  non-root user and as root. `npm run setup` installs the pre-push hook that runs it.
- After every push, watch CI to completion: `gh run watch <id> --exit-status` (find the id with `gh run list --limit 1`).
  Report a release only with the green run id.
- A red CI is fixed before any other work. Find the root cause; never retry, skip or loosen a test to make it pass.
- Linux-only failures are real (the runner differs: inode reuse, filesystems, timing, process tables). Reproduce them
  in the container `npm run verify` uses.

## Every change

- A fix names the failure it fixes (commit message and a "Named failure:" comment in the code) and ships a scenario
  test that reproduces it and fails without the fix.
- This repository is public: no project, company, product or person names anywhere (code, tests, fixtures, docs,
  commit messages). `scenarios/privacy.test.mjs` checks tracked files against your local `.privacy-denylist`
  (gitignored; create it with the names you must never publish).
- A change to what the engine does changes, in the same commit, every text that states it: role templates, skills, the
  AGENTS block, `wf resume` lines and refusal hints, docs and release notes. `scenarios/text-payloads.test.mjs` runs every
  example payload through the engine and `scenarios/final-review-0.7.test.mjs` checks every named command; a reading of
  the prose is still owed. Named failure (0.7.0): the engine was relaxed first and the texts followed a day later, so
  agents were told to do what the engine refused.
- Parallel streams or agents that change one tree run the full suite on the combined tree before any of them reports done; their changes to one file merge field by field (the union of both), never one side per hunk.
- A maintainer release goes to main after a green `npm run verify`, with no pull request (one that exists is merged by the maintainer); the commit messages are scanned against the privacy denylist as well as the diff, and the release is tagged from the pushed commit once CI is green.
- Commit with an identity that is fine to publish (a GitHub noreply address).
- Security-sensitive paths (`hooks/`, `engine/evidence.mjs`, `engine/paths.mjs`, `engine/gate.mjs`,
  `engine/lifecycle.mjs`, `engine/cli.mjs`, `engine/attempt.mjs`): paths go through `engine/paths.mjs`; evidence writes
  through the no-follow helpers; the guard checks file-tool writes and does not scan Bash text (CONTRIBUTING.md).
- Workflow findings from using the plugin are in the maintainer's inbox: `wf improve next`; close one with
  `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."`, or retire a check that caught
  nothing with `wf improve close <id> --retire --version X --reason "..."`.

## Checks and decisions (CONTRIBUTING.md has the detail)

- Agents are fallible, not adversarial (docs/trust-model.md, threat model). Triage an automated security-review finding
  against it before writing code; one that assumes an adversarial agent is closed as out of model unless an incident
  shows the behaviour.
- A new refusal passes an explicit id to `refuse()` and names its incident in a comment. A release that adds an
  obligation gates it with `obligationSince(state, '<version>')`, so attempts admitted earlier are unaffected.
- Deleting a check whose refusals show no catch needs no incident (`wf refusals`, `wf improve review`).
- A design decision is written in the decision register (docs/DESIGN.md) in the change that makes it, never left in
  an agent's memory; read the register before reversing one.
