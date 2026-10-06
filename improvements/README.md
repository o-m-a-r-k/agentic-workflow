# Plugin improvements

The history of changes made to agentic-workflow because something went wrong in the workflow itself. Each entry names the failure (in generic words: no project, company or person names), the release that fixed it, and the scenario test that reproduces it.

Open items live in each maintainer's own inbox (`~/.agentic-workflow/improvements/`, outside every repo), recorded with `wf improve add`. `wf improve close <id> --version X --test scenarios/<file>.test.mjs --fix "..."` writes the entry here, and only when that test exists.
