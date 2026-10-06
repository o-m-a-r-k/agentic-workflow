## Named failure

<!-- The concrete failure this fixes or the setup it enables, in generic words (no project, company or person names). -->

## Scenario test

<!-- The test that reproduces the failure and fails without this change: scenarios/<file>.test.mjs › <test name>. -->

## Privacy check

- [ ] No project, company, product, customer or person names, real ticket ids, URLs, emails or local paths in the diff.

## Security-sensitive paths

- [ ] This touches `hooks/`, `engine/evidence.mjs`, `engine/paths.mjs`, `engine/gate.mjs`, `engine/lifecycle.mjs`, `engine/cli.mjs`, `engine/attempt.mjs`, `scenarios/` or `.github/` (the maintainer reviews these).

## How it was verified

<!-- Commands run and their result (`npm test`). -->
