#!/bin/sh
# hello-ticket: one ticket through wf from entry to delivery, in a throwaway copy of this folder.
#
#   bash examples/hello-ticket/demo.sh
#
# Every line after a `$` is a real command and everything under it is its real output. The agents are scripted here
# (plain shell stands in for the planner, implementer and reviewer), so the run needs no model, no network and no
# account: the tracker is the ticket files in tickets/, which the engine updates and reads back itself.
# Nothing outside the temporary folder is touched; it is removed at the end (keep it with KEEP=1).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WF_BIN="$HERE/../../bin/wf"
TMPBASE=${TMPDIR:-/tmp}
DEMO=${DEMO_DIR:-$(mktemp -d "${TMPBASE%/}/hello-ticket.XXXXXX")}
mkdir -p "$DEMO"
DEMO=$(cd "$DEMO" && pwd -P)
PROJ="$DEMO/hello-ticket"
WORK="$DEMO/work"

# wf state for this run only (project registry, leases, improvements inbox), never the user's own.
export WF_CONFIG_HOME="$DEMO/.config" WF_HOME="$DEMO/.home" WF_IMPROVEMENTS_DIR="$DEMO/.improvements"
# Read-only modes and the hash-chained manifest stay on; the immutable file flag is off so the folder can be removed
# (the evidence is read-only, so cleanup first makes it writable again).
export WF_EVIDENCE_FLAGS=0
# Run as a plain shell, not as the agent session that may have started this script.
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID GROK_SESSION_ID 2>/dev/null || true
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.test GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.test

cleanup() { if [ "${KEEP:-0}" = 1 ]; then echo "kept: $DEMO"; else chmod -R u+w "$DEMO" && rm -rf "$DEMO"; fi; }
trap cleanup EXIT

say() { printf '\n# %s\n' "$*"; }
wf() {
  printf '$ wf %s\n' "$*"
  node "$WF_BIN" "$@"
}
# A step the demo expects wf to refuse: show the refusal and its exit code, then carry on.
refused() {
  printf '$ wf %s\n' "$*"
  if node "$WF_BIN" "$@" 2>&1; then echo "(expected a refusal)"; exit 1; else echo "(exit $?: refused)"; fi
}
show() {
  printf '$ %s\n' "$*"
  "$@"
}

# A git repository with an origin, as a real project has.
mkdir -p "$PROJ" "$WORK"
(cd "$HERE" && tar cf - .workflow lib test tickets package.json) | (cd "$PROJ" && tar xf -)
printf '.wf-evidence/\n.wf-worktrees/\n' > "$PROJ/.gitignore"
git init -q --bare -b main "$DEMO/origin.git"
git -C "$PROJ" init -q -b main
git -C "$PROJ" config commit.gpgsign false
git -C "$PROJ" add -A
git -C "$PROJ" commit -q -m 'hello-ticket'
git -C "$PROJ" remote add origin "$DEMO/origin.git"
git -C "$PROJ" push -q origin main
cd "$PROJ"

say "The ticket, as a file in the repo"
show cat tickets/HT-1.md

say "Admit it: wf opens an attempt with its own worktree and moves the ticket to In Progress"
wf entry --item HT-1 --owner you
ATTEMPT=HT-1.1
WT="$PROJ/.wf-worktrees/$ATTEMPT/hello-ticket"

say "The planner freezes the acceptance criteria before any code exists"
cat > "$WORK/criteria.json" <<'EOF'
{ "plan": "greet takes an optional name",
  "criteria": [
    { "id": "C1", "text": "greet('Ada') returns 'Hello, Ada!'", "uat": "greet('Ada') prints Hello, Ada!" },
    { "id": "C2", "text": "greet() still returns 'Hello!'", "uat": "greet() prints Hello!" } ] }
EOF
wf handoff planner --agent planner-1 --attempt "$ATTEMPT"
wf plan --file "$WORK/criteria.json" --attempt "$ATTEMPT"

say "The implementer's first try forgets the comma"
wf handoff implementer --agent implementer-1 --attempt "$ATTEMPT"
cat > "$WT/lib/greet.mjs" <<'EOF'
// The whole library: a greeting.
export function greet(name) {
  return name ? `Hello ${name}!` : 'Hello!';
}
EOF
cat > "$WT/test/greet.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../lib/greet.mjs';

test('greet() says hello', () => {
  assert.equal(greet(), 'Hello!');
});

test('greet(name) greets by name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
EOF
git -C "$WT" add -A
git -C "$WT" commit -q -m 'greet by name'
refused gate --attempt "$ATTEMPT"

say "Fixed and committed: the gate runs again on the new tree"
sed -i.bak 's/`Hello ${name}!`/`Hello, ${name}!`/' "$WT/lib/greet.mjs" && rm "$WT/lib/greet.mjs.bak"
git -C "$WT" commit -q -am 'greet: add the comma'
wf gate --attempt "$ATTEMPT"

say "The implementer cannot review its own work"
refused handoff reviewer --agent implementer-1 --attempt "$ATTEMPT"

say "A fresh reviewer checks each criterion against the gate evidence"
wf handoff reviewer --agent reviewer-1 --attempt "$ATTEMPT"
cat > "$WORK/closure.json" <<'EOF'
{ "reviewer": "reviewer-1", "findings": [],
  "criteria": [
    { "id": "C1", "evidence": { "kind": "output", "ref": "unit: greet(name) greets by name, ok" } },
    { "id": "C2", "evidence": { "kind": "output", "ref": "unit: greet() says hello, ok" } } ],
  "screenshotsInspected": [] }
EOF
wf review --closure "$WORK/closure.json" --attempt "$ATTEMPT"
wf accept --attempt "$ATTEMPT"

say "Delivery: merged to main, pushed, and the ticket handed off"
printf 'greet() now takes an optional name: greet("Ada") returns "Hello, Ada!".\n' > "$WORK/summary.md"
wf deliver --attempt "$ATTEMPT" --summary-file "$WORK/summary.md"

say "Readback: the ticket file as the engine left it, and main as pushed"
show cat tickets/HT-1.md
show git --no-pager -C "$DEMO/origin.git" log --oneline -3 main
wf status --attempt "$ATTEMPT"
