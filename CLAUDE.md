# Claude project notes — workload-dispatcher

Hands a Claude Code assignment to GitHub Actions, for when the submitter's own
quota is gone. See [README.md](README.md) for the user-facing picture, and
[JOINING.md](JOINING.md) for the trust story.

Sibling of `workload-manager`, which does the same thing on colleagues' laptops.
Match its conventions: a colleague installing both should not be able to tell
they were built separately.

## Layout

- `cli/` — `@commercetools-demo/workload-dispatcher`. **Zero runtime dependencies on purpose** — colleagues
  install it globally and a dependency tree is a support burden. `node:util`
  `parseArgs`, built-in `fetch`, `node:child_process`, `node:readline/promises`.
- `.github/workflows/wd-assignment.yml` — the whole worker. Must live on the
  **hub's default branch**.
- `cli/src/workflow.generated.ts` — the workflow embedded as a string, written by
  `cli/scripts/embed-workflow.mjs` at prebuild. `package.json` ships only
  `dist`, so a sibling `.yml` would not survive a global install.

Two repos, always distinguished by name, in code and in every message:

- **hub** — where the event is sent, where the run appears, where the secrets
  live.
- **target** — detected from the cwd's git remote; travels in the payload; never
  dispatched to.

## The payload contract

The interface between the two halves. Nine of the ten properties GitHub allows;
the tenth stays free on purpose, and anything new goes inside `opts`.

```json
{ "v": 1, "job_id": "wd_k3fq9r", "repo": "owner/name", "base": "main",
  "branch": "claude/fix-a1b2", "title": "…", "submitter": "…",
  "assignment": "<preamble + fenced body>",
  "opts": { "model": "sonnet", "max_turns": 80, "debug": false,
            "dry_run": false, "draft": false } }
```

`assignment` is raw text — JSON string encoding is the only layer, which is
exactly why the workflow reads it from `$GITHUB_EVENT_PATH` and why passing it
as an action input would not work. `repo` is a **slug**, never a URL.

## Things that will bite you

**The workflow must be on the hub's DEFAULT branch.** A copy on a feature branch
is invisible to `repository_dispatch`: you get a cheerful 204 and nothing
happens. This is the single most likely first-run failure, which is why
`explainNoRun()` names it first and `wd doctor` checks it specifically. It also
makes the workflow the slowest thing here to iterate on — every change has to be
merged before it can be tested.

**204 means "queued", not "a run exists".** The endpoint answers 204 with an
empty body whether ten workflows matched, one matched, or none did. A typo in the
event type is indistinguishable from success at the HTTP layer, so finding the
run is the only proof and run discovery is not optional polish.

**`run-name:` lands in `display_title`, not `name`.** On a REST workflow-run
object `name` is the *workflow's* name. Match `display_title`. Getting this wrong
gives a CLI that always exits 3 while the work actually happens — the most
confusing possible state, and invisible to every other check. `wd doctor` greps
the hub's workflow for the expression for exactly this reason.

**A 404 from `/dispatches` usually means "no push access", not "no such repo".**
GitHub masks 403 as 404 on write endpoints so private repos cannot be
enumerated. Verified: `POST /repos/cli/cli/dispatches` returns 404 while
`GET /repos/cli/cli` returns 200. Never print "repository not found".

**`gh api --input -` needs an explicit `-X POST`.** `gh` only switches off GET
when *parameters* are added, and `--input` is not a parameter — without it the
body goes out on a GET and the dispatch silently does nothing. `--input -` is
also what keeps a 60 KB assignment out of `argv`, and therefore out of `ps aux`
and shell history.

**The payload limit is on the serialized payload.** JSON escaping doubles every
newline and quote, so a 60,000-character brief serializes past 61,000. Measure
`JSON.stringify({event_type, client_payload})` and take the worse of UTF-16
length and UTF-8 bytes. And **never truncate**: half an assignment comes back as
a confident half-diff with a green run and a PR — the same class of failure as
`workload-manager`'s empty clone.

**`bypassPermissions` is silently downgraded on a fresh runner.** Claude Code
drops it to `default` unless `skipDangerousModePermissionPrompt` is set in
user/local/flag/policy settings, and a fresh runner has no `~/.claude.json`. In
`default` mode a non-interactive permission request becomes a *denial*, so you
get an agent that quietly does less than you asked and still reports success.
The `settings:` input is what prevents this — **not** the CLI flag.

**`bypassPermissions` also exits 1 as root**, so the job must stay on a
GitHub-hosted runner with no `container:`. There is a `Refuse to run as root`
preflight that fails before the clone with the three workarounds spelled out
(`--user 1001`, `IS_SANDBOX=1`, or `--permission-mode dontAsk` plus an
allow-list), because otherwise this surfaces as a bare exit 1 inside the model
step, in a log that is deliberately quiet. `scripts/lint-workflow.sh` asserts
both the preflight and the absence of `container:`.

**`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` forces mode `default`.** So the hardening
that would stop the agent reading the job's environment is mutually exclusive
with running unattended. A `bypassPermissions` agent can read every credential
the runner user can. That is why the clone's token is stripped before Claude
runs and the cross-repo token is never handed to the action — it narrows the
window it cannot close.

**The action repoints `origin` at the hub.** Its `configureGitAuth()` runs
`git remote set-url origin https://x-access-token:<hub token>@github.com/<HUB>`
inside the workspace, because `context.repository` is the hub rather than the
clone. Pushing to `origin` after that puts the target's branch in the dispatcher
repo and then opens a PR against the wrong place. Push by explicit URL, and pass
`gh pr create --repo`.

**The action always rewrites `$RUNNER_TEMP/claude-prompts/`** from the `prompt`
input, so pre-writing that file does nothing. The static pointer is not a style
choice; it is the only route in. And `src/entrypoints/run.ts` does
`console.log("Context prompt: …")` unconditionally, so anything in `prompt:` is
printed verbatim.

**A target repo's `.claude/` and `.mcp.json` execute by default.** The action
forces `enableAllProjectMcpServers: true`, `settingSources` defaults to
user/project/local, and its own defence (`restoreConfigFromBase`) only runs for
PR events — never `repository_dispatch`. Without `--setting-sources user
--strict-mcp-config` you are running arbitrary repos' hooks on your runner with
your tokens in the environment.

**Interpolating `client_payload` into a `run:` body is the one-line mistake**
that undoes the whole privacy design, and it looks completely harmless. Actions
echoes resolved `run:` bodies and `env:` blocks. `$GITHUB_ENV` is a log surface
too — anything written there appears in every later step's env block. Only
`job_id`, `repo`, `branch` and `submitter` may ever be interpolated, and
`run-name:` is the most visible surface GitHub has.

This one is **enforced, not just documented**: `scripts/lint-workflow.sh` fails
if `client_payload.assignment` appears anywhere, if any payload field outside
that allowlist is interpolated, or if `toJSON(github.event)` shows up. It runs as
section 0 of `scripts/e2e.sh`. Verified to actually fail by breaking the
invariant on purpose.

**`::add-mask::` is a seatbelt, not the design.** It only masks output produced
after it runs and matches literal substrings, so a multi-line value needs each
line masked separately — and lines under 12 characters are skipped deliberately,
because masking `main` or `true` turns the rest of the log into `***` and hides
the errors you need to read.

**A clone can succeed with an empty tree.** If the remote's HEAD points at a
branch that no longer exists, `git clone` warns and exits 0, and committing then
produces a root commit of only new files — a success-shaped wrong answer. Guarded
with `git rev-parse --verify HEAD`, same as `workload-manager`.

**Use `git status --porcelain -z`.** Porcelain v1 C-quotes paths with non-ASCII
or embedded quotes, and the strip-the-quotes approach that works 95% of the time
is how you lose a renamed file with an umlaut in it. (`workload-manager`'s
`publish()` has this bug — worth fixing there.)

**`parseArgs({ strict: false })` swallows typos.** `wm`'s CLI uses it; `wd`
deliberately does not. A typo'd `--brnach` there would dispatch a real run onto
a wrong generated branch and spend someone's quota on it, so unknown flags exit
2. This is the one convention worth *not* matching.

**A readline interface holds a ref on stdin.** Leak one and the process prints
its result then hangs — no output, no error. Everything goes through
`ask.close()` in `main()`'s `finally`. `rl.on('SIGINT')` is also needed: with
`terminal: true`, Ctrl-C at a prompt never reaches the default handler.

**A piped prompt makes the run non-interactive.** stdin is one stream. Reopening
`/dev/tty` would work on macOS and Linux, break on Windows, and under `nohup`
send the questions to a terminal nobody is watching — considered and rejected.

**Never auto-retry a dispatch.** The event is not idempotent, so a retried
timeout can start two runs racing on the same branch, and the second one's push
fails in a way nobody can read.

**The owner allowlist is the control on blast radius, not the token.**
`WD_GIT_TOKEN` is org-wide, so what stops "can dispatch" from meaning "can push
anywhere that token reaches" is the check in step 1 against
`vars.WD_ALLOWED_OWNERS`, defaulting to `github.repository_owner`. Widen it with
a repository variable; never by loosening the check. A CLI-side allowlist would
be advice only — `gh api .../dispatches` by hand bypasses the CLI entirely.

**`gh secret list` shows repo secrets only, never values.** An org-inherited
secret is invisible, and one that appears may be expired. `doctor` says
"present" or "cannot tell", never "works".

**`gh auth status` output is not an API** — its format has moved between
releases and between stdout and stderr. Parse it for advisory output only; the
authoritative scope check is the 404 from the real call.

## Testing

`scripts/lint-workflow.sh` — 16 invariant checks on the workflow itself, run as
section 0 of the e2e suite. These police the things whose failure mode is silent:
the assignment never being interpolated, the actions staying SHA-pinned, the
bypass gate being present, in-repo settings/MCP staying disabled, and
`git add -A` never appearing. Confirm it can still fail by breaking an invariant
on purpose — a lint nobody has seen go red is not a lint.

`scripts/e2e.sh` — 64 assertions, dispatching nothing real. `scripts/fake-gh.sh`
stands in for `gh` via `WD_GH_BIN` (the `WM_CLAUDE_BIN` of this repo). The git
repo is a real `git init` with two remotes, so remote detection and the
multi-remote refusal are exercised for real; only `gh` is faked.
`XDG_CONFIG_HOME` and `WD_HOME` are redirected into the scratch dir so the suite
can never touch a real `~/.config/wd`.

```bash
cd cli && npm run build && ../scripts/e2e.sh
```

The trick worth keeping: the fake reads the job id back out of the payload it
just recorded and returns a matching `display_title`, so run discovery is tested
end to end rather than against a hardcoded id.

**`fake-claude.sh` does not port.** The action drives Claude through the Agent
SDK's `query()`, not `claude -p`, so a shell script emitting `stream-json` cannot
satisfy the control-request handshake and `path_to_claude_code_executable` wants
a real binary. That is the concrete price of using the action instead of the CLI.
The stub therefore moves up a level: `opts.dry_run` swaps the whole action step
for a two-line one, which still exercises clone → guard → branch → stage →
commit → push → PR.

## Not yet done

- **No real `repository_dispatch` has ever been sent.** Everything is verified
  against `scripts/fake-gh.sh`. Two assumptions are only checked there: that
  `gh api -X POST` on a 204 endpoint exits 0 with empty stdout, and that
  `display_title` carries the `run-name` for a `repository_dispatch` event
  specifically. Send one dry run to a scratch hub before telling colleagues this
  works.
- **The workflow has never run.** It parses, and every claim in its comments was
  checked against the action's source and the Claude Code binary it pins — but
  the clone → Claude → push → PR leg has not executed once. Do a
  `opts.dry_run` dispatch against a scratch repo first; it needs no quota.
- **`cli/` has never actually been published.** The metadata is ready
  (`publishConfig.access: public`, MIT, `prepack` builds so a publish cannot
  ship a stale `dist`), and `behnam777` owns the `@commercetools-demo` npm org,
  but `npm publish` has not been run. Do a `npm publish --dry-run` first and
  check the file list is exactly `dist/`, `README.md`, `LICENSE`,
  `package.json`.
- **`wd install` has only been exercised against the fake.** The real path
  creates a branch, writes a file through the Contents API and opens a PR; only
  the first of those is covered by anything.
- **The owner allowlist has never been exercised against a real dispatch.** Its
  default (`github.repository_owner`) is what keeps an org-wide `WD_GIT_TOKEN`
  from being an org-wide capability, so it is worth a deliberate negative test:
  dispatch at a repo outside the org and confirm step 1 refuses.
