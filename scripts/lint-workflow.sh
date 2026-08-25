#!/bin/bash
# Enforces the invariants the workflow's comments claim. Every one of these has
# a failure mode that is silent — a run that works perfectly while leaking the
# assignment, or one that quietly does less than it was asked and reports
# success — so "we wrote a comment about it" is not enough.
#
# Run standalone, or as part of scripts/e2e.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WF="$ROOT/.github/workflows/wd-assignment.yml"
[ -f "$WF" ] || { echo "no workflow at $WF"; exit 1; }

# Comment-only lines are prose about the invariants and must not trip the checks
# that police them. Both flavours: YAML `#` and the `//` of the JS heredocs
# embedded in the run: bodies.
CODE="$(mktemp)"
trap 'rm -f "$CODE"' EXIT
grep -vE '^[[:space:]]*(#|//)' "$WF" > "$CODE"

pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }

echo "== workflow invariants =="

# ---------------------------------------------------------------- the big one
# The assignment must never be interpolated. Actions echoes resolved `run:`
# bodies, `env:` blocks and action `with:` inputs, so any ${{ }} carrying it
# prints it into a log every hub collaborator can read.
! grep -q 'client_payload\.assignment' "$CODE"
check "the assignment is never interpolated" $?

# Only these payload fields are safe to render: none of them is secret, and the
# run name in particular is on the most visible surface GitHub has.
BAD_FIELDS="$(grep -oE 'client_payload\.[A-Za-z_]+' "$CODE" \
  | sort -u | sed 's/client_payload\.//' \
  | grep -vxE 'job_id|repo|branch|submitter' || true)"
[ -z "$BAD_FIELDS" ]
check "only job_id/repo/branch/submitter are interpolated${BAD_FIELDS:+ (found: $BAD_FIELDS)}" $?

# toJSON(github.event) would dump the whole payload in one go.
! grep -qiE 'to_?json\([[:space:]]*github\.event' "$CODE"
check "the event object is never serialised into the log" $?

# ------------------------------------------------------------- the model step
# Both default false, but an explicit `true` is the single easiest way to undo
# the whole design, so assert the value rather than trusting the default.
! grep -qE '^[[:space:]]*(show_full_output|display_report):[[:space:]]*true' "$CODE"
check "show_full_output and display_report are not true" $?

# track_progress throws on repository_dispatch; use_commit_signing would commit
# into the hub through an MCP server scoped to github.repository.
! grep -qE '^[[:space:]]*(track_progress|use_commit_signing):[[:space:]]*true' "$CODE"
check "track_progress and use_commit_signing are not true" $?

# Without this, Claude Code silently downgrades bypassPermissions to `default`
# on a fresh runner, where a non-interactive permission request is a denial.
grep -q 'skipDangerousModePermissionPrompt' "$CODE"
check "the bypassPermissions disclaimer gate is set in settings" $?

# Without these, an arbitrary target repo's .claude/ hooks and .mcp.json servers
# execute on the runner with our tokens in the environment.
grep -q -- '--setting-sources user' "$CODE" && grep -q -- '--strict-mcp-config' "$CODE"
check "in-repo settings and MCP config are disabled" $?

# --add-dir is an accumulating flag: it swallows every following non-flag token.
LAST_FLAG="$(grep -oE '\-\-[a-z-]+ [^ ]*$' "$CODE" | grep -c 'add-dir' || true)"
grep -A1 -- '--add-dir' "$CODE" | grep -qE '^\-\-[a-z]' && ADD_DIR_LAST=1 || ADD_DIR_LAST=0
[ "$ADD_DIR_LAST" = "0" ]
check "--add-dir is the last flag in claude_args" $?

# ------------------------------------------------------------------- the job
# bypassPermissions exits 1 as root, and a container job is root by default.
! grep -qE '^[[:space:]]{4}container:' "$CODE"
check "the job declares no container (bypassPermissions exits as root)" $?

grep -q 'id -u' "$CODE"
check "there is a root preflight" $?

# A moving tag would silently replace the output sanitisation that IS the
# log-privacy story.
UNPINNED="$(grep -oE 'uses: [^ ]+@[^ ]+' "$CODE" | grep -vE '@[0-9a-f]{40}' || true)"
[ -z "$UNPINNED" ]
check "every action is pinned to a commit SHA${UNPINNED:+ (found: $UNPINNED)}" $?

# The CLI's only handle on the run it fired.
grep -qE '^run-name:.*client_payload\.job_id' "$CODE"
check "run-name carries the job id" $?

# The empty-clone guard: a clone whose remote HEAD is a dead branch exits 0 with
# an empty tree, and committing then is a success-shaped wrong answer.
grep -q 'rev-parse --verify HEAD' "$CODE"
check "the empty-clone guard is present" $?

# Staging by name is what makes a strange commit explainable, and -z is what
# stops a C-quoted path being silently dropped.
grep -q 'porcelain., .-z' "$CODE" || grep -q "'--porcelain', '-z'" "$CODE"
check "changed paths are staged from porcelain -z" $?
! grep -qE "add[^)]*-A|add -A" "$CODE"
check "git add -A is never used" $?

# The cross-repo credential must never be in the model step's environment.
python3 - "$WF" <<'PY'
import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))['jobs']['assignment']['steps']
bad = []
for s in steps:
    if 'claude-code-action' in str(s.get('uses', '')):
        env = s.get('env') or {}
        for k, v in env.items():
            if 'WD_GIT_TOKEN' in str(v):
                bad.append(k)
        # The action reads the whole job env, so a job-level token would leak too.
sys.exit(1 if bad else 0)
PY
check "WD_GIT_TOKEN is not in the model step's environment" $?

echo
echo "  $pass passed, $fail failed"
[ "$fail" = "0" ]
