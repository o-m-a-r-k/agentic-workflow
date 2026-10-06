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
- Commit with an identity that is fine to publish (a GitHub noreply address).
- Security-sensitive paths (`hooks/`, `engine/evidence.mjs`, `engine/paths.mjs`, `engine/gate.mjs`,
  `engine/lifecycle.mjs`, `engine/cli.mjs`, `engine/attempt.mjs`): the guard is never more permissive than the frozen
  0.1.15 hook; paths go through `engine/paths.mjs`; evidence writes through the no-follow helpers.
- Workflow findings from using the plugin are in the maintainer's inbox: `wf improve next`; close one with
  `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."`.
