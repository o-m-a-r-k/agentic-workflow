# Contributing

Thanks for helping. Issues and pull requests are welcome; nothing is merged automatically.

## Terms

- **Project**: the whole onboarded system (one adapter, one tracker; it may hold several repos).
- **Repo**: one Git repository inside a project.
- **Component**: a logical part mapped to a repo or a package.
- **Plugin**: agentic-workflow itself.

Never use "workspace" for any of these.

## Running the suite

```bash
npm run setup                  # once: installs the pre-push hook (git config core.hooksPath .githooks)
npm run verify                 # before every push: the suite here and in a Linux container (non-root and root), in parallel
npm run verify -- --host-only  # this machine only, every core (not enough before a push)
npm run verify -- --linux-only # the two container legs only
npm run verify -- --serial     # one leg after the other, each with the whole machine
npm test                       # the scenario suite: node --test scenarios/
node --test scenarios/<file>.test.mjs                                # one file
node --test scenarios/<file>.test.mjs --test-name-pattern "<name>"   # one test while iterating
node bench/evidence.mjs        # the evidence benchmark (writes about 3 GB to the temporary folder)
```

The scenarios run the real `wf` CLI against temporary git repositories with bare remotes. CI runs them on Linux and
macOS, on every push and pull request and weekly. A red CI is fixed first, from its root cause; a Linux-only failure
is real (see [AGENTS.md](AGENTS.md)).

Expected times on a 16-core laptop with nothing else running: about 45 seconds for the host leg alone, about two
minutes for `npm run verify` (each leg prints its own time and how many test files it ran at a time), from a few
seconds to about 40 seconds for one file. Another heavy job on the machine (a gate, a model, a build) stretches all of
them: the suite is bound by CPU (about 500 CPU seconds a leg on macOS, 360 in Linux), mostly the `git` processes the
engine starts.

- Each file runs its tests one after the other, and files run side by side, so the longest file sets the floor for a
  leg. Keep a file under about 40 seconds: split a long one over a shared fixtures module (as
  `adapter-fault-fixtures.mjs` does) rather than letting it grow.
- `WF_VERIFY_JOBS=<n>` sets the test files at a time for every leg (default: the machine's cores shared by each leg's
  measured cost, see `scripts/verify.mjs`).
- `WF_SCENARIO_CHECK_OWNER=1` makes the scripted owner in `scenarios/helpers.mjs` look up each attempt both in-process
  and through `wf resume`, and fail on any difference. Run the suite once with it after changing how `wf resume`,
  the ledger or evidence verification work.
- Some tests wait on purpose (a gate step that sleeps until it is stopped, a lease another gate holds, a terminal
  that types after two seconds): the property they prove takes that time. Do not shorten them to win time.

## Every fix names its failure and ships its test

- A change that fixes something cites the **named failure** it fixes, in the commit message and in a comment next to
  the code ("Named failure: ..."), in generic words.
- It ships a **scenario test** that reproduces that failure and fails without the fix. Prefer extending an existing
  scenario file.
- A new refusal, limit or check must name the concrete failure it catches. "It might be safer" is not enough.
- Workflow findings from using the plugin are recorded with `wf improve add` and closed with
  `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."`, which writes the history entry in
  `improvements/`.

## Privacy: this repository is public

- No project, company, product, customer or person names in commits, code, comments, tests, fixtures or docs. Use
  generic words ("a report page", "the api repo", `ENG-1`).
- No real ticket ids, URLs, emails, paths from your machine, tokens or screenshots from a real project.
- Before pushing, check the diff, for example: `git diff origin/main | grep -iE '<your company>|<your name>|<product>'`
  must print nothing. Better: list those names, one per line, in `.privacy-denylist` at the repo root (gitignored, never
  committed); `scenarios/privacy.test.mjs` then fails on any tracked file that contains one.
- Commit with an identity that is fine to publish (a GitHub noreply address is a good choice:
  `git config user.email <id>+<user>@users.noreply.github.com`).

## Security-sensitive paths

Changes to `hooks/`, `engine/evidence.mjs`, `engine/paths.mjs`, `engine/gate.mjs`, `engine/lifecycle.mjs`,
`engine/cli.mjs`, `engine/attempt.mjs`, `scenarios/` and `.github/` are reviewed by the maintainer (see
`.github/CODEOWNERS`). For these:

- the guard must never become more permissive than the frozen 0.1.15 hook (`scenarios/guard-regressions.test.mjs`);
- path handling goes through `engine/paths.mjs`; writes into the evidence through the no-follow helpers in
  `engine/evidence.mjs`;
- add the attack your change is about to the regression corpus, and the false positive it fixes to the allowed list.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Keep a PR to one change. Fill in the template: the named failure, the scenario test, the privacy check, whether
   security-sensitive paths are touched.
3. Run `npm test` before pushing.
4. By contributing you agree your work is released under the MIT license.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
