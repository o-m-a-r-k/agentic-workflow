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
nice -n 10 node --test --test-concurrency=4 scenarios/<file>.test.mjs   # while working: only the files a change touches
gh workflow run scenarios --ref <branch>                                # before main: the whole suite, macOS and Linux, in CI
npm run verify                 # the whole suite here and in two Linux containers: only on a machine nothing else uses
npm test                       # the scenario suite: node --test scenarios/
node --test scenarios/<file>.test.mjs                                # one file
node --test scenarios/<file>.test.mjs --test-name-pattern "<name>"   # one test while iterating
node bench/evidence.mjs        # the evidence benchmark (writes about 3 GB to the temporary folder)
```

The scenarios run the real `wf` CLI against temporary git repositories with bare remotes. CI runs them on Linux and
macOS, on every push and pull request and weekly. A red CI is fixed first, from its root cause; a Linux-only failure
is real (see [AGENTS.md](AGENTS.md)).

GitHub's macOS job runs one scenario file at a time so competing Git-heavy fixture setup cannot consume the strict
stop-process deadline. Scenarios still run their own concurrent gate and review processes. Linux uses Node's default
file concurrency, and the local verifier retains its three platform/user legs.

Expected times on a 16-core laptop that is mostly idle: about 50 seconds for the host leg alone (it was 80), about two
minutes for `npm run verify` (it was over three; each leg prints its own time and how many test files it ran at a time), from a few
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
- A change to what the engine does changes every text that states it in the same commit (role templates, skills, the
  AGENTS block, `wf resume` lines, refusal hints, docs, release notes); `scenarios/text-payloads.test.mjs` runs every
  example payload through the engine.
- Workflow findings from using the plugin are recorded with `wf improve add` and closed with
  `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."`, which writes the history entry in
  `improvements/`. A check that caught nothing is retired instead (below).

## Checks, obligations and decisions

- **A new refusal names its incident and gets an id.** Every new check passes an explicit id to `refuse(message, hint,
  { id: 'area:check' })` (for example `review:delta-outside`) and carries a comment naming the incident it catches
  ("Named failure: ..."). The id is how the check is counted: `wf refusals` groups by it, `wf report` shows it per
  attempt and `wf improve review` asks who accounts for it. Without an id a refusal is counted under its call site
  (`file.mjs:line`), which moves whenever the file is edited.
- **A release that adds an obligation gates it by admission version.** An obligation is anything a live attempt owes now
  that it did not owe when it was admitted: a verdict, a field, a trailer, a round. Gate it with
  `obligationSince(state, '<version>')` from `engine/versions.mjs`, naming the release that adds it, so attempts
  admitted earlier are unaffected. A relaxation applies to every attempt at once and needs no gate. Named failure: one
  ticket lived through 32 releases, and four of them changed what its next handoff owed.
- **Deleting a check whose refusals show no catch needs no incident.** Read `wf refusals` and `wf improve review`, remove
  the check, delete the scenarios that asserted it, and record why with
  `wf improve close <id> --retire --version X --reason "..." [--refusal id,id]` (add the item first with
  `wf improve add ... --refusal <id>` if there is none). A retired check needs no scenario test: there is no behaviour
  left to reproduce.
- **Automated review findings are triaged against the threat model before any code.** A finding from a
  security-review hook, a model scan or an audit that assumes an adversarial agent (a forged transcript, a
  pseudo-terminal, a scrubbed environment, a rewritten ledger) is closed as out of model, with the reason written down,
  unless an incident shows an agent doing it: agents are fallible, not adversarial ([threat
  model](docs/trust-model.md#threat-model)). Named failure: an automated security-review hook drove nine releases in 95
  minutes with no incident behind any of them.
- **A change from the improvement inbox passes an experience review before it ships** (D19). The review answers four
  questions: does it add a question, a stop, a refusal, a step or text the person or the agents must read; which observed
  failure does it fix, and how often was it seen; would it have made a recent delivery worse; what does it remove? A
  change that adds weight without an observed failure is retired, not built. Named failure: 0.7.7 closed every way a
  reviewer found an owner agent could move a finding out of a delivery with another question to the person, and the
  person found the workflow "too tight", "restrictive, not helpful". The review is run by an independent reviewer on the
  strongest model available, briefed with the threat model (agents are fallible, not adversarial) and with the rule that
  a new question to the person or a new stop needs an observed failure.
- **Nothing reruns that cannot add information** (D21). Before a rule makes a step, a gate or a review run again, ask
  whether the rerun could change the result. Find waste by measuring real ledgers by kind, largest first, not incident by
  incident.
- **A rule the person gives lives in the texts the agents read**: the role templates, the skills, the engine's bundle
  and next-step texts. A note kept only by whoever maintains the plugin reaches no agent. Named failure: the person's
  test-economy rule lived in a maintainer's private notes; an implementer spent 266 minutes, on a 90-minute estimate,
  rerunning a whole end-to-end spec under load that the gate would run anyway.
- **Design decisions live in the decision register,** [docs/DESIGN.md](docs/DESIGN.md#decision-register), not in any
  agent's memory, a session's notes or a private plan. A change that decides something, or reverses an earlier
  decision, adds its entry (date, decision, the failure behind it) in the same commit. Read the register before
  reversing anything: the decision that the engine never launches agents lived in one runtime's memory only, and an
  agent on the other runtime reversed it without knowing.

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

- the guard hook checks writes made through the file tools (Edit, Write, NotebookEdit) and the working directory; it
  does not scan Bash command text (removed in 0.7.0: 334 refusals, 69% of them naming no evidence folder). Adding
  command scanning back needs an incident, not a finding that assumes an adversarial agent (see the threat model
  above). `scenarios/guard-regressions.test.mjs` keeps the file-tool cases; add the false positive a change fixes to its
  allowed list;
- path handling goes through `engine/paths.mjs`; writes into the evidence through the no-follow helpers in
  `engine/evidence.mjs`.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Keep a PR to one change. Fill in the template: the named failure, the scenario test, the privacy check, whether
   security-sensitive paths are touched.
3. Run `npm test` before pushing.
4. By contributing you agree your work is released under the MIT license.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
