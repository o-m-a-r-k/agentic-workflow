# Behaviour scenarios

[Back to the README](../README.md) · [Docs map](../README.md#docs)

Each scenario runs the engine, or the real `wf` CLI, against temporary git repositories with bare remotes, on invented neutral projects (repos `server` and `client` on bases `trunk` and `stable`, tickets `TK-<n>`). `npm test` runs them all; CI runs them on macOS and Linux. Fixtures are in `scenarios/helpers/`: the project pair, fake trackers, host transcripts in both layouts, and 0.7 ledgers with a batch.

## End to end

| File | What it proves |
| --- | --- |
| `e2e-push` | A push-to-main project with no CI and tickets as files: start, criteria, fast tests and a review, a fix round and a second review, landing on the base, the tracker stages, close and the telemetry row. The real `wf`, no doubles; only the reviewer host is a fake `claude` that reads what its prompt lists. |
| `e2e-modules` | Tests, tracker and delivery as the project's own modules, on two repos with different bases. |
| `e2e-from07` | `wf init --from-07` and `wf migrate attempts`, then a ticket on the migrated adapter through a connector and a module. |
| `e2e-answers` | A reserved decision: forged answers are refused; the person's turn after the question answers it. |

## Flow

| File | What it proves |
| --- | --- |
| `flow-start` | Worktrees at the fetched tip of each base; ids normalised; stages snapshotted; numbering continues after old ledgers and branches; `start:open`; close as shipped by patch-id, failing closed when the worktree is gone. |
| `flow-review` | Criteria (at most 6, hashed, edits recorded; `merge:waiver`); the bundle and its contents; the split by area and `review:size`; `review:tree`, `review:independent` and `review:coverage` from the transcript; reviewers launched in parallel with the fast tests. |
| `flow-findings` | The three classes and `finding:other-own`; the no-progress stop (a flat blocker count, a reopened finding) across abandon and restart; a waiver goes to the person. |
| `flow-merge` | `merge:unreviewed`, `merge:foreign`, `merge:untested` and `merge:risk`. |
| `flow-cli` | Help and usage; `wf status` names one next command at every step; a refusal exits 75 and is counted; `WF_DOUBLES` only under `WF_TEST=1`. |

## Tests, screens and landing

| File | What it proves |
| --- | --- |
| `tests-run` | `wf test fast` records exit code, minutes and tree; module runners load from the fetched base (an attempt cannot make its own runner pass); the counted, machine-wide lock; `risk-base` must fail at the merge-base; a tree that changes during the run records nothing. |
| `screens-capture` | Screens picked from the reverse imports of changed files, the sentinel set for shared paths in every language; the page's own `lang` and `dir`; `screens:width`, `screens:dup`; the capture manifest protocol. |
| `image-size` | Image sizes read from PNG, JPEG, GIF and WebP headers. |
| `landing-queue` | Green stacks and pushes once; red bisects and lands the rest; nothing waits for an unready ticket; a failing base blames no ticket; a moved base is rebuilt and retested. |

## Delivery and tracker

| File | What it proves |
| --- | --- |
| `delivery-stages` | The stage snapshot; holds; comments and statuses with markers, never twice; `when: labels` with `pending`; connector stages read back from the owner's call; `stage:deploy`; push and merge-request authority; `wait-merged` by patch-id (squash and rebase); `after:`; modules load as the base holds them. |
| `delivery-tracker` | `normaliseId` and numbering across spellings; search; `fileFollowUp` per mode, search first, once; the files tracker. |
| `tracker-files` | The files tracker refuses traversal and malformed ids before touching a file, never reads or writes through a link, and refuses a ticket without frontmatter or with a mismatched id. |

## Decisions and hosts

| File | What it proves |
| --- | --- |
| `decisions-answer` | The answer rule: exact options right after the question; notifications, injected content and tool results never answer; a late "yes" does not count; the question panel; a hand-appended answer breaks the chain; answers re-checked at use. |
| `decisions-digest` | The daily digest across open attempts. |
| `decisions-launch` | The bundle is the reviewer's whole prompt; the handoff names the session `wf` launched; capacity resumes in the same session on both hosts. |
| `codex-run` | A reviewer launched from a Codex session runs on Codex, read-only, in the worktrees folder, without the launcher's session variables. |
| `codex-runtime-compat` | The texts agents read name no harness and no tool only one harness has; each host restricts its reviewer to its review file. |
| `hosts-readers` | Files read, caller session, turns and usage, and connector calls, from both transcript layouts. |
| `hosts-hooks` | The hooks run only the session rules, filled from the adapter. |
| `host-boundary` | No engine module outside `engine/hosts/` names a harness. |
| `host-plugin` | A host registered from outside the engine is read like a built-in one, and the real CLI records its session as the actor. |

## Telemetry and learning

| File | What it proves |
| --- | --- |
| `telemetry-ledger` | Schema 2 events, the hash chain, 0.7 ledgers readable. |
| `telemetry-row` | Every row field from the ledger, git and transcripts; blame to the attempt; `wf report`. |
| `telemetry-legacy07` | 0.7 ledgers roll up onto the same row, batches included. |
| `learn-proposals` | The baseline band, judging, expiry, revert on missing data, the re-proposal block, the adapter budget. |
| `learn-release` | The release check: counts by name, words by total, role length, proposals that account for an increase. |
| `release-script` | The release dry run, and the check step stopping on a budget increase until a committed proposal accounts for it. |

## Configuration, onboarding and migration

| File | What it proves |
| --- | --- |
| `config-08` | Finding the adapter (repo or user folder, never both); its own git history; the normalised shape; every problem listed at once; the adapter budget. |
| `onboard-scan` | Structural facts per repo; risk areas with reasons citing files; nothing domain-specific in the engine. |
| `onboard-policy` | The per-key proposal; confirm writes with hashes; a re-run writes nothing; hand edits kept unless confirmed; risk must be confirmed; doctor names stale instruction lines. |
| `migrate-from07` | `--from-07`: the seeded conversion, every dropped key, the capture command required. `migrate material`. |
| `migrate-attempts` | Held attempts skipped and listed; open ones superseded with branches kept; shipped ones by patch-id; `--dry-run`. |

## The plugin itself

| File | What it proves |
| --- | --- |
| `contract`, `contract-fixtures` | Every cross-stream function is a facade owned by one module; the refusal, event and command catalogues agree with `budget.json`; the fixtures behave. |
| `texts-08`, `text-payloads` | Role texts within their word limits, naming only existing commands; the reviewer's text lists exactly the classes, severities and statuses the engine accepts. |
| `secrets` | Secret values are never printed; provisioning gets only its own keys; agent credentials never reach project commands. |
| `state-folders` | State folders marked before any payload; Git excludes; conflict-copy warnings in `wf doctor`. |
| `docs-links` | Every relative link in the README and docs resolves. |
| `privacy` | No tracked file contains a name from the maintainer's local denylist. |
| `verify-layout` | `npm run verify` from a linked worktree gives the container a working checkout. |
