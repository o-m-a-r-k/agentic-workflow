# Security

Please do not open public issues for security problems. Report them privately through GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab). Include the version and the steps to reproduce. You will get an answer there.

## Scope

The plugin is text that guides agents. It runs no code of its own. The most relevant reports are wording that could lead an agent to:

- expose a secret, or write one into a ticket folder, a handoff or a record;
- write to production data or copy it, when the method says to read it only;
- deliver without the checks the method asks for;
- treat something as the person's approval when the person did not give it.

The agents' own permissions and sandboxing belong to the harness that runs them. They are not a boundary this plugin provides.
