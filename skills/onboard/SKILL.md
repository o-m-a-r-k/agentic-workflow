---
name: onboard
description: Write or re-evaluate a project's definition for the deliver skill with the person, proven on a practice ticket. Use when asked to set up, onboard or re-evaluate a project.
---

# Onboard

**Goal.** A definition from which a fresh agent, knowing nothing else, can take a ticket from started to delivered in this project. A description nobody has used is a guess, so prove it by use. It serves `../deliver/WORKFLOW.md`, beside this skill's folder; read that first.

## Method

1. **Describe** how the project delivers, from its own sources (repos, every instruction file that applies, harness settings and guards, CI, history) and the person's words. Each fact carries its source, or is marked unchecked.
2. **Prove it:** walk one practice ticket, as a worker would, through every step that is safe. Create and set up the worktrees, run and time the fast and the heavy checks, run each oracle and the read-only query command once, merge on a scratch branch that is never pushed, read the tracker. Then remove what you created.
3. **Fill the gaps.** Whatever the walk needed that the definition didn't say is missing. Fill it from the sources, or ask the person with a recommendation.
4. **Show the person** what you found, what you proved and what it costs, such as how long proving a change takes. Write only what they confirm: to `.agents/project.md` in a versioned folder every checkout gets (the folder that holds the repos if it is versioned, otherwise a repo the person names), with a `name`, paths relative to that folder and no `roots`; otherwise to `~/.agents/projects/<project>.md`. Facts true only on this machine go to `~/.agents/projects/<project>.local.md`. If `~/.agents/projects/<project>.md` already exists, move its machine-only facts to the `.local.md` and remove it, with the person's confirmation.

Authority to act without asking comes only from the person's own words, recorded without widening. An older process's rules move into the project's `AGENTS.md` before it is removed, on every base tickets branch from. Re-run it at any time, the same way, reading `~/.agents/records.jsonl` for this project first: what its deliveries kept missing is what the definition or its `AGENTS.md` should make easier to see. If `~/.agents/workflow.yaml` is missing on the person's own machine, create it with `roles: {}`.

## The definition

```yaml
---
name: library-app
work: .work                       # outside the repos, or excluded in each
repos:
  catalog: { path: catalog, base: { staging: develop, production: main } }
  web:     { path: web,     base: { staging: develop, production: main } }
statuses:
  started: In progress
  delivered: { staging: Ready for review, production: Released }
ticket_type: session              # or where else it comes from
roles: {}                         # optional: <harness>.<role>: { model, effort }
checks_allow: [npm test, npx vitest run, ./tools/read-db.sh, node ./tools/fact-check.mjs, node ./tools/access-matrix.mjs]
nothing_ran: [No tests found, /^0 passing/m]
screen_paths: [web/src/pages, web/src/components, web/messages]
page_paths: [web/src/pages/**]
boundaries:
  fee: [catalog/src/fees/**, catalog/src/loans/renew.*]
  access: [catalog/src/auth/**, catalog/src/policies/**]
  contract: [catalog/src/api/**, web/src/api/**]
migrations: [catalog/migrations/**]
gate:
  - catalog | always | npm test -- --changed
  - web | always | npx vitest run {files}
  - web | boundary:contract | npx vitest run src/api
  - catalog | migrations/** | npm test -- migrations | heavy
surface_kinds: [fee, access]
oracles:
  fee: node ./tools/fact-check.mjs --kind fee --stack {worktree}
  access: node ./tools/access-matrix.mjs --stack {worktree}
---
```

This is the repo-held form: paths are relative to the folder that holds `.agents/`. In `~/.agents/projects/<project>.md`, add `roots: [<the project's folder>]` and use absolute paths.

The deliver skill's scripts read these front-matter keys, each a list as `[a, b]` or as `- a` lines (`gate` only as `- a` lines, since its entries hold commas). Path lists take `**`, `*`, `?` and a leading `!` to leave files out; a plain path covers everything under it. `boundaries`, `migrations`, `page_paths` and `screen_paths` are written with the repo first (`web/src/pages/**`); `test_files` and a `gate` line's globs are relative to their repo.

- `checks_allow`: the command prefixes a check's `cmd:` may start with, word for word (`npm test` allows `npm test -- renew`, never `npm exec`); nothing else runs, never through a shell. A word starting `./`, `../` or `/` is a file in the definition's folder and runs from there, never from the branch under test; other commands run in the check's worktree. `{worktree}` and `{ticket}` become those folders' paths.
- `nothing_ran`: what each runner prints when it ran no test (text or `/regex/flags`); such a run fails whatever its exit code.
- `test_files`: globs of the project's test files (`**/*.test.*`, `tests/**`); unset, a default covers common layouts in JavaScript, TypeScript, Python, Go, Ruby, PHP, Java, Kotlin and C#. `gate` lists the ones a change deleted or altered for the verifier.
- `screen_paths`: `<repo>/<path>` prefixes of the screen source and locale files; a diff that touches one is a visible change and gets a read (`!<repo>` says a repo has none).
- `page_paths`: globs of the files that are pages or routes; one added there is a new page, which is shaped.
- `boundaries`: a map, one indented `<kind>: [<glob>, <glob>]` line per boundary: the code that computes or enforces that kind of fact, not every file that displays it. A change touching one runs on the critical lane. Draw it narrowly, and add a path whenever a verifier finds a fact people act on outside it.
- `migrations`: globs of migration files; a change touching one runs on the critical lane.
- `gate`: the runs that prove a change, each a line `<repo> | <when> | <command>`, with a fourth field `heavy` for a run that must go alone. `<when>` is `always`, globs within the repo, or `boundary:<kind>`, which runs the line whenever that boundary is touched in any repo: this is how a consumer's tests in another repository are run. `{files}` becomes the changed files that matched. Each command starts with an entry of `checks_allow`. A line is rerun only when what its `<when>` names is touched, so put lockfiles and shared configuration in the globs of the runs they affect.
- `skip_markers`: the strings that mark a skipped or focused test in this project's runners; unset, a default covers the common ones.
- `surface_kinds`: the kinds of fact users act on that must never be wrong; each is a key of `boundaries`.
- `oracles`: a map, one indented `<kind>: <command>` line per kind that has one, each command also on `checks_allow`. The design gives a Surface line of that kind a check that runs it, the boundary's verifier and the audit run it, and a kind with none is stated in the handoff.

A capture is `evidence/screens/<state>@<sha>.png`, with the screen's visible text beside it as `<state>@<sha>.txt`; `<state>` is the scenario or axis value from the question sheet.

Then a short section per thing a delivering agent does:

- **Set up** a fresh worktree, including what a worker starting there wouldn't find.
- **Screens**, for a project with any: its design system and where it lives; six to ten screens the person has accepted, each with one line on why; which composition suits which job; the state axes its screens have (how much data, the role, the plan, a pending change, loading or failed) and how to seed each; how a screen is captured with its visible text; the widths, languages and themes to sample; and the rulings log, each rejection as a before and after with its principle.
- **Prove** a change (this is what the `gate` lines encode): the checks available, what each one covers, how long it takes, which are heavy, and, where machines are shared, how a heavy run waits for room. A ticket picks the ones that cover what it alters and its reach, and runs a broad suite only when that reach justifies it, unless CI already does. Also: the real data volumes and how to produce them locally, how failures (a provider down, a conflict, a race) are produced in the test environment, and how two tickets' stacks are kept apart so each oracle runs against its ticket's own.
- **Check** the facts users act on. Ask the person which facts their users act on that must never be wrong (an amount owed, an appointment time, a slot's availability, a stock level, who may see or do what) and how each is read from its record (the stored state, a provider's record, the rules the `AGENTS.md` states). Those are `surface_kinds`. An oracle for a kind compares what the product shows or writes in a given state with that record, read apart from the code that shows it; a workable form is `<command> --stack <worktree> <spec.json>`, the spec naming the states and facts to compare, printing how many it compared and every disagreement, and exiting 0 when all agree, 1 on a disagreement, a value it couldn't read or nothing compared, 2 on a bad spec. Name how each runs, what it covers and how long it takes; where a kind has none yet, writing one is the person's decision, with a recommendation.
- **Reach** the environments, test accounts (by reference, never secrets) and read-only data; how an agent gets the app running to walk through as its users would; which contracts and consumers leave the project; and how everything a ticket starts, runs included, is found and removed afterwards.
- **Deliver** to each target, step by step to its delivered status: how each is taken, confirmed and undone, how long an outside step (a pipeline, a deploy) may take, which other bases a hotfix must reach, and who may take each step without asking, quoted.
- **Track** tickets: read, file, move, comment, and where screenshots go (the tracker, the pull request or a folder).

A fact true only for now says what ends it. Rules about the code belong in `AGENTS.md`.
