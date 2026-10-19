# Onboarding and secrets

[Back to the README](../README.md) · [Docs map](../README.md#docs)

## `wf init` (alias `wf onboard`)

Onboarding owns every policy key of the adapter: the risk paths, `review.diffRead`, the delivery stages, the ticketing operations, the `fast`/`full` test split and the screens settings.

1. **Scan.** `wf init` reads the repos as facts, with no domain vocabulary of the plugin's own: folder and module names, schema and migration folders, decimal and currency types and rounding code, auth and permission code, outbound HTTP clients, webhook handlers and queue consumers, mobile apps, CI files and test scripts, and the project's own documents (its instruction files and invariants, which name what it treats as critical). Risk is judged by what a mistake costs: money computed or moved, writes to external systems that cannot be undone, data deleted or migrated, access granted.
2. **Draft.** A cheap model drafts the policy from those facts (`wf init --json` prints them; the draft comes back with `--draft <file>`). Every risk path gets a reason that cites the files the scan found.
3. **Confirm.** `wf init` shows a per-key diff against the current adapter, with the reason for each change, and writes nothing. `wf init --confirm <key>` (repeatable) or `--confirm all` writes what the person confirms.

Onboarding cannot finish while `risk` is unconfirmed (`risk: none` is an explicit answer). `--location user` writes the adapter to the user folder instead of a repo.

## Re-running it

`wf init` can be re-run at any time to re-evaluate the project. It re-scans and shows the per-key diff; a run with nothing to change writes nothing. Keys edited by hand since onboarding wrote them are tracked by a hash in the adapter (`onboarded.hashes`), shown before any change, and kept by `--confirm all`; one is replaced only when its own key is confirmed. Its output counts against the adapter budget.

## `wf doctor`

Checks the adapter, the confirmed risk paths, hand edits, the adapter budget, each repo and its base, the project modules (committed on the base), the invariants file, the screens capture, required tools, secrets, open 0.7 attempts, product code that imports from `.workflow/`, lines of the project's instruction files that name commands 0.8 does not have, and cloud-sync conflict copies of the state folders ([state-folders.md](state-folders.md)).

## `wf sync`

Registers the project in the person's registry (`~/.agentic-workflow/registry.json`) and checks the skills it requires.

## Migrating from 0.7

`wf init --from-07` is an onboarding run seeded from the schema 1 adapter: tests, tracker and delivery modules become `{ repo, path }` modules, statuses and labels become stages, per-ticket validation steps are dropped by name, `quality` moves into the invariants, and every dropped key is printed. It refuses to finish while `screens.capture` is unset (it offers the command seeded from the old step that collected screenshots) and while `risk` is unconfirmed. It imports each project module from the base and checks its default export for its kind, and says plainly when one cannot be used as it is: a 0.7 test runner runs no tests until it is rewritten for the 0.8 runner contract (printed), and a 0.7 delivery module becomes `merge-request` and `wait-merged` with the merge left to the person until it is rewritten as a `module` stage. `idPattern` is built from the item prefixes in the old attempt folders, and `requires.tools` keeps plain command names, listing what it dropped. The work this leaves the person is in the [0.8.0 release notes](releases/v0.8.0.md#migrating-from-07). `wf migrate attempts` and `wf migrate material` are described in the [0.8.0 release notes](releases/v0.8.0.md#migrating-from-07).

## Secrets

Agents never see, type, print or move a secret value.

- The catalogue is `secrets.yaml` beside the adapter (`.workflow/secrets.yaml` in a repo, or next to the user-folder adapter): `keys: [{ key, purpose, usedBy, required, format, verify }]`. Values live in the repo's `.env.local` (gitignored) or the macOS keychain.
- `wf secrets check` lists each key with `filled`, `missing` or `invalid`, never a value; `wf doctor` does the same.
- `wf secrets guide` asks the person for each missing value with hidden input. It runs only in their own terminal.
- A key whose `usedBy` names `provision:<repo>` reaches that repo's `provision.install` when a worktree is provisioned, and nothing else (D14). A missing one refuses `wf start`; a failed install with a secret prints none of its output.
- Agent-runtime credentials and session variables never reach a project command (tests, capture, provisioning).
