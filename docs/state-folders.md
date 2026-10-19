# Local workflow state and cloud sync

[Back to the README](../README.md) · [Docs map](../README.md#docs)

A project's workflow state lives in two folders at its root: `.wf-worktrees/` (each attempt's worktrees) and `.wf-evidence/` (each attempt's ledger, review bundles, launches and captures). The person's own state lives in `~/.agentic-workflow/` (`WF_USER_DIR` moves it): user-folder adapters, telemetry rows, proposals, the digest, the machine-wide test locks and extracted project modules.

New state folders (`.wf-evidence`, `.wf-worktrees`, and the older `.workflow-evidence` and `.workflow-maintenance` names) are created separately from their children. On macOS, immediately after creating the folder, the engine runs the system utility:

```text
/usr/bin/xattr -s -w com.apple.fileprovider.ignore#P 1 <new-folder>
```

`-s` selects `XATTR_NOFOLLOW`, whose link behaviour is documented in
[Apple's setxattr manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setxattr.2.html).
The file-provider ignore attribute itself is undocumented. This is a mitigation for cloud conflict copies of rapidly
changing workflow state, not a guarantee about future iCloud behaviour. Other operating systems skip the attribute.
If marking fails on macOS, creation stops before children or payloads are written, and the command is refused with the
reason. Only the newly created, still-empty folder is removed after that failure.

Existing folders are not marked automatically: setting this attribute on an already synced folder can remove its cloud
copy. Conflict copies are never merged, moved, deleted or adopted by the plugin.

When a state folder is created inside a Git repository, the engine checks all four names with `git check-ignore` and
adds missing patterns to the repository's local `info/exclude`. Existing patterns and tracked `.gitignore` files are
preserved; linked worktrees use their common Git directory; a link or a hard-linked exclude file is refused.

`wf doctor` warns about real sibling folders named `<folder> 2`, larger numbered copies, or `<folder> <UUID>`, and
separately when an evidence folder is empty while one of those siblings holds entries. These names suggest a conflict;
they do not establish its cause. Doctor changes none of them and recommends comparing the copies' ledgers before
restoring the expected folder.
