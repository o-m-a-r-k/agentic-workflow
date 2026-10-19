# Contributing

Thanks for helping. Issues and pull requests are welcome; nothing is merged automatically.

## Terms

- **Project**: the whole onboarded system (one adapter, one tracker; it may hold several repos).
- **Repo**: one Git repository inside a project.
- **Component**: a part of the system that consumes another's contracts.
- **Plugin**: agentic-workflow itself.

Never use "workspace" for any of these.

## Running the suite

```bash
npm run setup                  # once: installs the pre-push hook (git config core.hooksPath .githooks)
node --test scenarios/<file>.test.mjs                                # one file
node --test scenarios/<file>.test.mjs --test-name-pattern "<name>"   # one test while iterating
npm test                       # the whole scenario suite
npm run verify                 # the suite here and in two Linux containers (a normal user and root)
```

The scenarios run the engine and the real `wf` CLI against temporary git repositories with bare remotes. CI runs the
whole suite on macOS and Linux, in shards (`node --test --test-shard=<i>/<n>`: every file runs once per OS), on pull
requests, weekly and on demand (`gh workflow run scenarios --ref <branch>`). A red CI is fixed first, from its root
cause; a Linux-only failure is real.

- Each file runs its tests one after the other, and files run side by side, so the longest file sets the floor. Keep a
  file short: split a long one over a shared fixtures module rather than letting it grow.
- Scenarios use the fixtures in `scenarios/helpers/` (an invented two-repo project, fake trackers, host transcripts,
  0.7 ledgers). A scenario that needs another stream's facts in-process uses `withDoubles`; a spawned `wf` loads doubles
  only under `WF_TEST=1`.
- Some tests wait on purpose (a lock held by another run, a capacity retry): the property they prove takes that time.

## Releasing (maintainer)

A release is one command once CI is green on the release branch (D83):

```bash
node scripts/release.mjs <version> --dry-run   # the plan, from what is known locally: nothing is fetched, pushed, created or installed
GH_TOKEN=<the repository owner's token> node scripts/release.mjs <version>
```

Before it: the dev branch (`dev/<version>`, or `--dev <branch>`) holds the release with the three version files
(`package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) and `docs/releases/v<version>.md`
(`node scripts/changelog.mjs` then regenerates `CHANGELOG.md`), and is pushed to `release/<version>`, where CI ran the
whole suite and passed. The steps, each printing what it ran and what it saw:

1. **check**: `origin/release/<version>` equals the local dev head; the version files and the notes are in it; main
   fast-forwards to it; no improvement history file is left uncommitted; **the budget**: the release commit's
   rule-shaped counts (refusal ids, commands, event types, adapter keys, words in the texts agents read) against
   `budget.json` on main, where a net increase stops the release unless a kept or active proposal committed under
   `proposals/` accounts for it (D98); CI passed on the commit.
2. **privacy**: `scenarios/privacy.test.mjs` runs (never skips) at that commit with the denylist, and every commit of
   the range is scanned: message, author, committer and each added line. A hit names the commit and line, never the name.
3. **main**: main fast-forwards to the release and is pushed.
4. **github**: the GitHub release and its tag, with the notes file.
5. **install**: the tagged archive is extracted into `~/.local/share/agentic-workflow/releases/<version>` and linked
   into `~/.local/bin/wf` (`node scripts/install.mjs`).
6. **hosts**: each host's plugin is updated; a host whose CLI is not on PATH is skipped, and the output says so.
7. **sync**: `wf sync` in each project the settings name.
8. **cleanup**: the release branch is deleted, and this version's dev worktrees and their merged branches.

The run stops at the first failure and says what it left done; a step already done is seen and skipped, so running
it again after the fix goes on. The settings live outside the repository, in `~/.agentic-workflow/release.json` (or
`WF_RELEASE_CONFIG`, or `--config <file>`), every field optional:

```json
{ "syncRoots": ["<a project root>"], "worktreeFolder": "<the folder of the dev worktrees>", "privacyDenylist": "<the denylist file>" }
```

`scenarios/release-script.test.mjs` runs the dry run and the check step; the steps after it talk to GitHub and the
hosts and are never run by the suite.

## Every fix names its failure and ships its test

- A change that fixes something cites the **named failure** it fixes, in the commit message and in a comment next to
  the code ("Named failure: ..."), in generic words.
- It ships a **scenario test** that reproduces that failure and fails without the fix. Prefer extending an existing
  scenario file.
- A change to what the engine does changes every text that states it in the same commit: role texts, skills, the
  session rules (`templates/session-rules.md`), refusal hints, docs and release notes.

## Rule-shaped changes and the budget

- **Every refusal is a fact check with a named failure and an id** from the contract's catalogue
  (`engine/contract.mjs`). A new refusal id, command, adapter key, event type, or words in a text agents read is
  rule-shaped, and counts against `budget.json`. A net increase needs a measured proposal (`proposals/<name>.json`:
  source, scope, change, what it replaces, metric, guard, expiry, status) or a replacement of something that exists.
  Bug fixes are classified by the same facts: a fix that adds a refusal is rule-shaped.
- **Automated review findings are triaged against the threat model before any code.** Agents are fallible, not
  adversarial (D6): a finding that assumes an adversarial agent (a forged transcript, a rewritten ledger) is closed as
  out of model, with the reason written down, unless an incident shows an agent doing it.
- **Nothing reruns that cannot add information.** Before a rule makes a step, a test run or a review happen again, ask
  whether the rerun could change the result.
- **A rule the person gives lives in the texts the agents read**, as a proposal with `source: person`; a note kept only
  by whoever maintains the plugin reaches no agent.
- **Design decisions live in the decision register,** [docs/DESIGN.md](docs/DESIGN.md), not in any agent's memory, a
  session's notes or a private plan. A change that decides something, or reverses an earlier decision, adds its entry
  in the same commit.

## Privacy: this repository is public

- No project, company, product, customer or person names in commits, code, comments, tests, fixtures or docs. Use
  generic words ("a report page", "the api repo", `ENG-1`), and invented neutral projects in fixtures.
- No real ticket ids, URLs, emails, paths from your machine, tokens or screenshots from a real project.
- List the names you must never publish, one per line, in `.privacy-denylist` at the repo root (gitignored, never
  committed); `scenarios/privacy.test.mjs` then fails on any tracked file that contains one.
- Commit with an identity that is fine to publish (a GitHub noreply address is a good choice).

## Security-sensitive paths

Changes to `hooks/`, `engine/hosts/`, `engine/ledger.mjs`, `engine/decisions.mjs`, `engine/base-module.mjs`,
`engine/secrets.mjs`, `engine/env.mjs`, `engine/cli.mjs`, `adapters/`, `scenarios/` and `.github/` are reviewed by the
maintainer (see `.github/CODEOWNERS`). Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Keep a PR to one change. Fill in the template: the named failure, the scenario test, the privacy check, whether
   security-sensitive paths are touched.
3. Run the scenario files your change touches before pushing.
4. By contributing you agree your work is released under the MIT license.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
