# Design: <ticket id> <title>

Critical lane only. As short as the change allows; it holds the design, not the discovery again.

Read at: <repo>@<sha>
Oracles changed: none | <the path the outcome needs changed>

## Contract

Routes, payloads, errors, permissions, pagination; what each consumer in another repository must change with it.

## Data

The model, and each migration with its way back.

## Failure paths

What each write does when it fails halfway, and when the same event arrives twice or at once. Each stops safe: stuck, visible, correctable.

## Surface

- S1 (<kind>): <fact shown or written>: <where users meet it>; equals <its record>
- S2 (<kind>): not touched: <why, with its source>

## Decisions

### D1: <question>

- Choice: <what>
- Source: `<path>:<line>` at the commit above, or the decision judge's file and what its sources establish
- Beats: <the alternative>, because <why>

## Tests

Each acceptance check of the brief and each Surface line: the test or oracle that proves it, and whether it fails before the change.

## Objections answered

- <challenge-<n> objection>: <changed how | disputed, with the evidence; ruled by decide-<k>>
