#!/bin/bash
# Stands in for `gh` so the whole compose -> dispatch -> discover -> watch leg is
# testable without firing a real repository_dispatch. This is the fake-claude.sh
# of this repo. Point WD_GH_BIN at it — explicit, rather than depending on PATH
# ordering.
#
# It only has to implement three surfaces (`--version`, `auth status`, `api`)
# because every module goes through the REST API even on the gh path.
#
# State lives in $FAKE_GH_DIR so assertions can read what was "sent":
#   calls.log          one line per invocation
#   dispatch.json      the body of the last POST .../dispatches
#   runlist.count      how many times the run list has been polled
#
# Behaviour switches:
#   FAKE_GH_UNAUTHED=1        `auth status` exits 1
#   FAKE_GH_MISSING=1         `--version` exits 127 (as if gh were absent)
#   FAKE_GH_NO_PUSH=1         repo permissions report push:false
#   FAKE_GH_DISPATCH_FAIL=404 force an HTTP status on .../dispatches
#   FAKE_GH_NO_WORKFLOW=1     contents lookup 404s on the default branch
#   FAKE_GH_NO_RUNNAME=1      the workflow fixture omits run-name
#   FAKE_GH_NO_SECRET=1       secret list is empty
#   FAKE_GH_BRANCH_EXISTS=1   matching-refs returns the branch
#   FAKE_GH_RUN_AFTER=n       run list stays empty until the nth poll
#   FAKE_GH_CONCLUSION=x      what the watched run concludes as
#   FAKE_GH_VIEW_DONE=n       run view reports completed from the nth call
set -uo pipefail

D="${FAKE_GH_DIR:?set FAKE_GH_DIR}"
mkdir -p "$D"
printf '%s\n' "$*" >> "$D/calls.log"

bump() {
  local n
  n=$(( $(cat "$D/$1" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$D/$1"
  echo "$n"
}

# gh writes the JSON error body to stdout and "gh: <msg> (HTTP nnn)" to stderr,
# then exits 1. The CLI parses that stderr shape, so the fake must match it.
http_err() {
  printf '{"message":"%s","status":"%s"}\n' "$2" "$1"
  printf 'gh: %s (HTTP %s)\n' "$2" "$1" >&2
  exit 1
}

case "${1:-}" in
  --version)
    [ "${FAKE_GH_MISSING:-}" = 1 ] && { echo "command not found" >&2; exit 127; }
    echo "gh version 2.92.0 (2026-04-28)"
    exit 0
    ;;
  auth)
    [ "${FAKE_GH_UNAUTHED:-}" = 1 ] && { echo "not logged in" >&2; exit 1; }
    printf 'github.com\n  Logged in to github.com account behnamt (keyring)\n'
    printf '  - Token scopes: %s\n' "'gist', 'read:org', 'repo', 'workflow'"
    exit 0
    ;;
esac

[ "${1:-}" = "api" ] || { echo "fake-gh: unhandled: $*" >&2; exit 64; }

EP="$2"
BODY=""
# --input - means the request body is on stdin. Capture it, because assertions
# about what was actually dispatched are the point of this stub.
for a in "$@"; do [ "$a" = "--input" ] && BODY="$(cat)" && break; done

workflow_fixture() {
  cat <<'YML'
name: wd
on:
  repository_dispatch:
    types: [wd-assignment]
run-name: "wd ${{ github.event.client_payload.job_id }}"
jobs:
  assignment:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YML
}
workflow_fixture_no_runname() {
  workflow_fixture | grep -v '^run-name:'
}

b64() { openssl base64 -A 2>/dev/null || base64 | tr -d '\n'; }

case "$EP" in
  */dispatches)
    printf '%s' "$BODY" > "$D/dispatch.json"
    if [ -n "${FAKE_GH_DISPATCH_FAIL:-}" ]; then
      http_err "$FAKE_GH_DISPATCH_FAIL" "Not Found"
    fi
    # A real 204 is exit 0 with empty stdout. That is the whole success signal.
    exit 0
    ;;

  /user)
    echo '{"login":"behnamt"}'; exit 0 ;;

  */actions/permissions)
    echo '{"enabled":true}'; exit 0 ;;

  */actions/secrets)
    [ "${FAKE_GH_NO_SECRET:-}" = 1 ] && { echo '{"secrets":[]}'; exit 0; }
    echo '{"secrets":[{"name":"CLAUDE_CODE_OAUTH_TOKEN"},{"name":"WD_GIT_TOKEN"}]}'
    exit 0 ;;

  */branches*)
    echo '[{"name":"main"},{"name":"wd/install-abcd"}]'; exit 0 ;;

  */contents/*)
    if [ "${FAKE_GH_NO_WORKFLOW:-}" = 1 ]; then
      case "$EP" in
        *ref=main) http_err 404 "Not Found" ;;
        *) : ;;   # found on some other branch, which doctor should say out loud
      esac
    fi
    if [ "${FAKE_GH_NO_RUNNAME:-}" = 1 ]; then
      C=$(workflow_fixture_no_runname | b64)
    else
      C=$(workflow_fixture | b64)
    fi
    printf '{"sha":"deadbeef","encoding":"base64","content":"%s"}\n' "$C"
    exit 0 ;;

  */git/matching-refs/heads/*)
    if [ "${FAKE_GH_BRANCH_EXISTS:-}" = 1 ]; then
      printf '[{"ref":"refs/heads/%s"}]\n' "${EP#*matching-refs/heads/}"
    else
      echo '[]'
    fi
    exit 0 ;;

  */git/ref/heads/*)
    echo '{"object":{"sha":"cafebabe"}}'; exit 0 ;;

  */actions/runs/*)
    N=$(bump runview.count)
    if [ "$N" -lt "${FAKE_GH_VIEW_DONE:-2}" ]; then
      ST=in_progress; CC=null
    else
      ST=completed; CC="\"${FAKE_GH_CONCLUSION:-success}\""
    fi
    printf '{"id":424242,"display_title":"wd job","status":"%s","conclusion":%s,' "$ST" "$CC"
    printf '"html_url":"https://github.com/o/r/actions/runs/424242","created_at":"2026-08-25T00:00:00Z"}\n'
    exit 0 ;;

  */actions/runs*)
    N=$(bump runlist.count)
    if [ "$N" -lt "${FAKE_GH_RUN_AFTER:-1}" ]; then
      echo '{"total_count":0,"workflow_runs":[]}'; exit 0
    fi
    # Read the job id back out of the payload we recorded, so discovery is
    # tested end to end rather than against a hardcoded id.
    JOB=$(WD_FAKE_DISPATCH="$D/dispatch.json" node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.env.WD_FAKE_DISPATCH,"utf8"));process.stdout.write(j.client_payload.job_id)}catch(e){process.stdout.write("none")}' 2>/dev/null || echo none)
    printf '{"total_count":1,"workflow_runs":[{"id":424242,"name":"wd","display_title":"wd %s",' "$JOB"
    printf '"status":"in_progress","conclusion":null,'
    printf '"html_url":"https://github.com/o/r/actions/runs/424242","created_at":"%s"}]}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit 0 ;;

  */pulls)
    echo '{"html_url":"https://github.com/o/r/pull/1"}'; exit 0 ;;

  */git/refs)
    echo '{"ref":"refs/heads/wd/install-abcd"}'; exit 0 ;;

esac

# Bare /repos/owner/name. Matched by slash count rather than a glob: a case
# pattern like */*/*/* also matches /repos/o/r, because a glob * happily matches
# the empty string — which silently 404'd every repo lookup.
SLASHES="${EP//[^\/]/}"
if [ "${#SLASHES}" = 3 ] && [ "${EP#/repos/}" != "$EP" ]; then
  PUSH=true
  [ "${FAKE_GH_NO_PUSH:-}" = 1 ] && PUSH=false
  printf '{"default_branch":"main","private":true,"permissions":{"push":%s,"admin":true}}\n' "$PUSH"
  exit 0
fi

echo "fake-gh: unhandled api path: $EP" >&2
exit 64
