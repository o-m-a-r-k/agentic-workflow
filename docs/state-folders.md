# Local workflow state and cloud sync

New `.wf-evidence`, `.workflow-evidence`, `.wf-worktrees` and `.workflow-maintenance` directories are created
separately from their children. On macOS, immediately after creating the root, the engine runs the system utility:

```text
/usr/bin/xattr -s -w com.apple.fileprovider.ignore#P 1 <new-folder>
```

`-s` selects `XATTR_NOFOLLOW`, whose link behavior is documented in
[Apple's setxattr manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setxattr.2.html).
The file-provider ignore attribute itself is undocumented. This is a mitigation for cloud conflict copies of rapidly
changing workflow state, not a guarantee about future iCloud behavior. Other operating systems skip the Apple attribute.
If marking fails on macOS, creation stops before children or payloads are written, with an error explaining the failure.
Only the newly created, still-empty directory is removed after that failure; replacements and data are retained.

Existing directories are not automatically marked: setting this attribute on an already synced directory can remove
its cloud copy. Conflict copies are never merged, moved, deleted or adopted by the plugin. This change requires no
background watcher and does not install one.

When a state root is created inside a Git repository, the engine checks all four names with `git check-ignore` and
adds missing patterns to the repository's local `info/exclude`. Existing patterns and tracked `.gitignore` files are
preserved. Linked worktrees use their common Git directory; multi-repo parents outside Git need no excludes.
Legacy folder names receive the same protection if created through the shared helper; the current engine primarily
creates the two `.wf-` folders.

`wf doctor`, including `--no-steps`, warns about real sibling directories named `<folder> 2`, larger numbered
copies, or `<folder> <UUID>`. It separately warns when an evidence folder is empty while one of those siblings
contains entries. These names suggest a conflict; they do not establish its cause. Doctor preserves every copy
and recommends comparing local evidence and ledgers before restoring the expected location.

Scenarios check first-write ordering, all four names, real macOS attributes, failure before payload creation,
existing-folder preservation, link refusal, Git ignores including linked worktrees, and non-mutating doctor warnings.
