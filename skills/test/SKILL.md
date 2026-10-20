---
name: test
description: Decide which tests a change needs, at which level, and which existing tests it makes redundant, so every test earns its place and the suite stays fast. Use when planning, writing or reviewing tests.
---

# Tests that earn their place

A test exists to catch one failure that would matter to someone. A suite is not proof by its size: every test adds run time to every future run, and a test nobody can explain is a cost with no return.

- **Name the failure first.** Before writing a test, say what breaks, for whom, if this behaviour regresses. If you can't name one that matters, don't write it.
- **Use the cheapest level that can see that failure.** Logic is seen by a unit test. What only shows across modules, the database, a queue or a contract needs an integration test against the real thing, not mocks that would hide it. What only a user sees in the running app, and nothing lower can see, needs a browser test. Never a browser test for what a unit test catches.
- **Assert outcomes:** the state, the output, what the user sees. Not how the code got there.
- **Prefer extending a test that already sets up the scene** over adding a new one. A test written for a fix fails before the fix, on the assertion the bug predicts, not on setup.
- **Keep the suite lean as you go.** When a change adds tests, look for tests it makes redundant, or that already prove the same thing at a costlier level, and remove or merge them in the same change. Say what you removed and why.
- **A flaky test is a defect.** Find why and fix it, or delete it with its reason. Never retry it into passing.

The project supplies its specifics: which test frameworks and levels it has, where tests live, how each runs, and which runs are heavy. They come from its `AGENTS.md` and its project definition.
