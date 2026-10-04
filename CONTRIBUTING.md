# Contributing

Thanks for helping. The project is at design stage, so the most useful contributions right now are:

- **Issues** describing a project setup the design doesn't cover (stack, tracker, delivery method, monorepo layout, mobile).
- **Design feedback** on [docs/DESIGN.md](docs/DESIGN.md), with a concrete scenario.

## Rules the project holds itself to

- A new refusal, limit or check must name the concrete failure it catches. "It might be safer" is not enough.
- The engine stays framework- and tracker-agnostic. Anything specific to one stack or service belongs in an adapter.
- Tests cover real behaviour: fail-closed evidence, safety, regressions. Prefer extending an existing scenario to adding a new file.

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Keep a PR to one change. Explain what it fixes or enables and how you verified it.
3. Run `npm test` (the scenario suite in `scenarios/`) before pushing.
4. By contributing you agree your work is released under the MIT license.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
