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
# The owner is an agent session (Codex here). Bookkeeping (closing an implementer, a runtime choice) is recorded as the
# caller; the few reserved decisions (lifting a hold, skipping a check, deferring a defect) wait for `wf approve`, which the
# person runs in their own terminal and this demo never needs.
OWNER=codex:demo-owner-session

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
wf entry --item HT-1 --owner "$OWNER"
ATTEMPT=HT-1.1
WT="$PROJ/.wf-worktrees/$ATTEMPT/hello-ticket"

say "The planner surveys what exists, designs, maps the impact; wf re-runs every query and freezes the criteria"
cat > "$WORK/criteria.json" <<'EOF'
{ "survey": {
    "queries": [
      { "id": "Q1", "pattern": "greet(", "kind": "literal", "paths": ["lib/**", "test/**"], "hits": 2 },
      { "id": "Q2", "pattern": "greet(", "kind": "literal", "paths": ["tickets/**", ".workflow/**"], "hits": 3 } ],
    "consumers": [ { "id": "S1", "symbol": "greet", "query": "Q1", "hits": 2 } ],
    "flows": [ { "id": "S2", "flow": "a caller asks for a greeting", "failure": "no name given: the greeting must stay 'Hello!'", "query": "Q1", "hits": 2 } ],
    "patterns": [ { "id": "S3", "description": "tickets and docs that quote greet()", "query": "Q2", "hits": 3 } ] },
  "plan": "greet takes an optional name",
  "expect": { "files": 2, "rounds": 3, "minutes": 30 },
  "criteria": [
    { "id": "C1", "text": "greet('Ada') returns 'Hello, Ada!'", "uat": "greet('Ada') prints Hello, Ada!" },
    { "id": "C2", "text": "greet() still returns 'Hello!'", "uat": "greet() prints Hello!" } ],
  "impact": {
    "changes": [ { "id": "I1", "element": "greet(name)", "kind": "symbol", "cites": ["C1", "C2"], "covers": ["S1", "S2"],
      "consumers": { "query": "Q1", "hits": 2 },
      "flows": [ { "flow": "greet('Ada')", "failure": "greet() without a name keeps 'Hello!'", "query": "Q1", "hits": 2 } ],
      "contracts": [], "suites": [ { "suite": "unit", "query": "Q1", "hits": 2 } ] } ],
    "excluded": [ { "survey": "S3", "reason": "tickets and the invariants describe greet(); none calls it" } ] } }
EOF
wf handoff planner --agent planner-1 --attempt "$ATTEMPT"
wf plan --file "$WORK/criteria.json" --attempt "$ATTEMPT"

say "The implementer's first try forgets the comma"
wf handoff implementer --agent implementer-1 --attempt "$ATTEMPT" | tee "$WORK/implementer-handoff.txt"
IMPLEMENTER_BUNDLE=$(sed -n 's/^implementer bundle: //p' "$WORK/implementer-handoff.txt")
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

say "The implementer reports in the file its bundle names: what it changed and why, what it ran, what it left (the engine records it when the owner closes it)"
IMPLEMENTER_REPORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).implementerReportFile' "$IMPLEMENTER_BUNDLE")
mkdir -p "$(dirname "$IMPLEMENTER_REPORT")"
cat > "$IMPLEMENTER_REPORT" <<'EOF'
{ "implementer": "implementer-1",
  "summary": "greet takes an optional name; tests for both criteria added",
  "approach": "a name, when given, goes into the greeting; without one the greeting is unchanged",
  "expect": { "minutes": 10 },
  "ran": [],
  "proofs": [],
  "left": [] }
EOF

say "No gate yet: the gate runs once a code-review round on this tree comes back clean"
refused gate --attempt "$ATTEMPT"

say "The implementer is still open: no review starts until it is closed, so the tree cannot move under the reviewer"
refused handoff reviewer --agent reviewer-1 --attempt "$ATTEMPT"
say "The owner agent closes it once the implementer reports done and its work is committed (bookkeeping: recorded as the caller)"
wf handoff close --agent implementer-1 --attempt "$ATTEMPT"

say "The implementer cannot review its own work"
refused handoff reviewer --agent implementer-1 --attempt "$ATTEMPT"

say "Code review, round 1: a fresh reviewer reads the diff against the criteria and finds the missing comma"
wf handoff reviewer --agent reviewer-1 --attempt "$ATTEMPT"
cat > "$WORK/closure-1.json" <<'EOF'
{ "reviewer": "reviewer-1",
  "findings": [ { "id": "F1", "severity": "major", "status": "open", "summary": "greet('Ada') returns 'Hello Ada!': the comma is missing (C1)", "evidence": "lib/greet.mjs:3" } ],
  "criteria": [
    { "id": "C1", "evidence": { "kind": "test", "ref": "test/greet.test.mjs: greet(name) greets by name" } },
    { "id": "C2", "evidence": { "kind": "test", "ref": "test/greet.test.mjs: greet() says hello" } } ],
  "screenshotsInspected": [],
  "impactChecked": {
    "queries": [ { "query": "Q1", "hits": 2 }, { "query": "Q2", "hits": 3 } ],
    "sampled": [
      { "entry": "S1", "verdict": "matches", "evidence": "test/greet.test.mjs calls greet() and greet('Ada')" },
      { "entry": "S2", "verdict": "matches", "evidence": "lib/greet.mjs:3 falls back to 'Hello!'" },
      { "entry": "S3", "verdict": "matches", "evidence": "tickets/HT-1.md quotes greet(); no code" },
      { "entry": "I1", "verdict": "matches", "evidence": "lib/greet.mjs:2 greet(name)" } ],
    "derived": [] } }
EOF
wf review --closure "$WORK/closure-1.json" --attempt "$ATTEMPT"

say "A fix round: the owner hands the finding back to the implementer that did the work, which fixes it, commits and reports"
wf handoff implementer --agent implementer-1 --attempt "$ATTEMPT" | tee "$WORK/fix-handoff.txt"
FIX_BUNDLE=$(sed -n 's/^implementer bundle: //p' "$WORK/fix-handoff.txt")
sed -i.bak 's/`Hello ${name}!`/`Hello, ${name}!`/' "$WT/lib/greet.mjs" && rm "$WT/lib/greet.mjs.bak"
git -C "$WT" commit -q -am 'greet: add the comma'
FIX_REPORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).implementerReportFile' "$FIX_BUNDLE")
cat > "$FIX_REPORT" <<'EOF'
{ "implementer": "implementer-1",
  "summary": "the greeting with a name has its comma",
  "approach": "the template literal missed the comma the criterion names",
  "expect": { "minutes": 5 },
  "ran": [{ "command": "node --test", "result": "passed" }],
  "proofs": [],
  "left": [] }
EOF
wf handoff close --agent implementer-1 --attempt "$ATTEMPT"

say "Code review, round 2 (a delta review): a new reviewer judges only what changed since round 1 and verifies round 1's finding, which came with its bundle"
wf handoff reviewer --agent reviewer-2 --attempt "$ATTEMPT"
cat > "$WORK/closure-2.json" <<'EOF'
{ "reviewer": "reviewer-2", "findings": [], "criteria": [],
  "priorFindings": [ { "round": "reviewer-1", "id": "F1", "status": "fixed", "evidence": "lib/greet.mjs:3 now returns Hello, ${name}!" } ] }
EOF
wf review --closure "$WORK/closure-2.json" --attempt "$ATTEMPT"

say "The review is clean: one gate on the reviewed tree"
wf gate --attempt "$ATTEMPT"

say "Evidence review: a fresh reviewer checks each criterion against the gate evidence"
wf handoff reviewer --agent reviewer-3 --attempt "$ATTEMPT"
cat > "$WORK/closure-3.json" <<'EOF'
{ "reviewer": "reviewer-3", "findings": [],
  "criteria": [
    { "id": "C1", "evidence": { "kind": "output", "ref": "unit: greet(name) greets by name, ok" } },
    { "id": "C2", "evidence": { "kind": "output", "ref": "unit: greet() says hello, ok" } } ],
  "screenshotsInspected": [],
  "impactChecked": {
    "queries": [ { "query": "Q1", "hits": 2 }, { "query": "Q2", "hits": 3 } ],
    "sampled": [
      { "entry": "S1", "verdict": "matches", "evidence": "test/greet.test.mjs calls greet() and greet('Ada')" },
      { "entry": "S2", "verdict": "matches", "evidence": "lib/greet.mjs:3 falls back to 'Hello!'" },
      { "entry": "S3", "verdict": "matches", "evidence": "tickets/HT-1.md quotes greet(); no code" },
      { "entry": "I1", "verdict": "matches", "evidence": "lib/greet.mjs:2 greet(name)" } ],
    "derived": [] } }
EOF
wf review --closure "$WORK/closure-3.json" --attempt "$ATTEMPT"
wf accept --attempt "$ATTEMPT"

say "Delivery: merged to main, pushed, and the ticket handed off"
printf 'greet() now takes an optional name: greet("Ada") returns "Hello, Ada!".\n' > "$WORK/summary.md"
wf deliver --attempt "$ATTEMPT" --summary-file "$WORK/summary.md"

say "Readback: the ticket file as the engine left it, and main as pushed"
show cat tickets/HT-1.md
show git --no-pager -C "$DEMO/origin.git" log --oneline -3 main
wf status --attempt "$ATTEMPT"
