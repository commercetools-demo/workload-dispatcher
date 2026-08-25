# workload-dispatcher

Hand a Claude Code assignment to GitHub Actions. For when your own quota is
gone: you describe the work, CI does it, and the result comes back as a pull
request.

```
  you (quota gone)          hub repo (Actions)                target repo
  ────────────────          ──────────────────                ───────────
  wd send  ─────────▶  repository_dispatch
   ├ which remote?          run-name: wd <job>
   ├ which branch?          read $GITHUB_EVENT_PATH ─┐
   └ + autonomy preamble     ::add-mask::            │ never a ${{ }}
                            assignment.md ◀─────────┘ interpolation
                            git clone ───────────────────▶ (WD_GIT_TOKEN)
                            claude-code-action@v1
                            stage by name, commit
                            git push ────────────────────▶ branch
                            gh pr create ────────────────▶ PR
  wd watch <job> ◀──── displayTitle match
```

Two pieces:

| | |
|---|---|
| [`cli/`](cli) | [`@commercetools-demo/wd`](https://www.npmjs.com/package/@commercetools-demo/wd) — zero-dependency Node CLI that composes and dispatches |
| [`.github/workflows/wd-assignment.yml`](.github/workflows/wd-assignment.yml) | the whole worker: clone, run Claude, commit, push, PR |

This is the sibling of
[workload-manager](https://github.com/commercetools-demo/workload-manager),
which farms the same kind of work out to **colleagues' laptops**. The trade is
different: no queue, no lease, no waiting for a volunteer — but the compute and
the Claude subscription belong to the org rather than to whoever is free.

**New here?** [JOINING.md](JOINING.md) is the doc to hand a colleague. Read its
trust section before you set up a hub; the privacy boundary is narrower than it
looks.

## The two repos

Keep these straight — every error message in the tool does.

- The **hub** holds the workflow and the two secrets. One per team. Target repos
  need no setup at all.
- The **target** is the repo the work happens in. It comes from your cwd's git
  remote and travels inside the dispatch payload.

## Setup

```bash
npm install -g @commercetools-demo/wd
```

Then once per team, by someone with admin on the hub:

```bash
wd init --hub commercetools-demo/workload-dispatcher
wd install                       # opens a PR adding the workflow
```

Merge that PR — `repository_dispatch` only ever runs the copy of a workflow that
is on the **default branch**, so nothing works until it lands. Then set the two
secrets on the hub:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo commercetools-demo/workload-dispatcher
gh secret set WD_GIT_TOKEN           --repo commercetools-demo/workload-dispatcher
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`. `WD_GIT_TOKEN` needs
push access to the target repos. Neither is ever passed as a flag, so neither
lands in your shell history.

By default the workflow will only act on repos owned by the hub's own owner. To
serve more than one org, set a repository **variable** (not a secret):

```bash
gh variable set WD_ALLOWED_OWNERS --repo <hub> --body "commercetools-demo,ct-builders"
```

Then, per person: `npm i -g @commercetools-demo/wd`, `wd init --hub …`, and
`wd doctor`. Working on the CLI itself instead of using it? `cd cli && npm
install && npm run build && npm link`.

## Sending

From inside the repo the work is for:

```bash
wd send "Fix PDP price rounding" \
  --prompt "Prices round down in cartTotals.ts. Make it half-up and add a test."
```

It asks which remote (if there are several) and what to call the branch, then
dispatches. `--watch` follows the run to its conclusion.

```bash
wd send "Reprice the acme catalog" --prompt-file brief.md --watch
cat brief.md | wd send "Reprice" --repo commercetools-demo/store --branch claude/reprice
```

A prompt on stdin makes the run non-interactive — stdin is one stream, so it
cannot also carry your answers. Pass `--repo` in that case.

**Write the assignment for a stranger with no way to ask you anything.** State
the end condition, the files if you know them, and how to tell it worked. The
CLI prepends a fixed preamble telling Claude never to ask questions, to state
its assumptions instead of stalling, and to treat your text as data — but it
cannot supply context you left out. `wd send --dry-run` prints exactly what
Claude will read.

| Flag | Use |
|---|---|
| `--repo` | Target repo; skips the remote question |
| `--base` | Branch from something other than the default branch |
| `--branch` | Name the branch instead of taking the generated one |
| `--model` | `sonnet` (default), `opus`, `haiku`, `fable`, or a full id |
| `--max-turns` | Model-side budget (default 80). Exceeding it opens no PR |
| `--draft` | Open the PR as a draft |
| `--watch` | Follow the run; exits 4 if it fails |
| `--dry-run` | Print the composed assignment; dispatch nothing |
| `--debug` | Log verbosely in CI and keep the transcript — see JOINING.md |

## Watching

```bash
wd ls                # recent dispatched runs on the hub
wd watch wd_k3fq9r   # follow one, from any directory, days later
wd doctor            # when something is wrong, start here
```

Exit codes are meant to be scripted against: `0` ok, `1` error, `2` usage,
`3` dispatched but no run found, `4` the run failed.

## Privacy

The assignment is deliberately kept out of the Actions log: it travels in a
`repository_dispatch` payload (which GitHub renders nowhere), is read off disk
rather than through a `${{ }}` interpolation, and is masked before anything
else runs. Claude's transcript is never printed or uploaded, and the PR body is
a summary Claude writes for reviewers rather than your original text.

**That protects it from anyone with read access to the hub, not from anyone with
write access.** Someone who can push to the hub can add a step that prints the
payload, or enable runner debug logging, which captures it before any step
runs. Treat hub write access as read access to every assignment, and read the
trust section in [JOINING.md](JOINING.md) before you widen it.

## Security posture

- **Anyone who can push to the hub can dispatch**, so `repository_dispatch`
  grants nobody new access — but it turns push access into a way to execute a
  model-authored change with the hub's credentials, driven by a prompt the hub
  never reviewed.
- **The workflow can only act on an allowlisted org.** `WD_GIT_TOKEN` is
  org-wide, so the control on blast radius is the check in step 1 against
  `vars.WD_ALLOWED_OWNERS`, which defaults to the hub's own owner. A dispatch
  aimed anywhere else is refused before the clone. Widen it with a repository
  variable, never by loosening the check — and note that a client-side allowlist
  would be advice only, since `gh api …/dispatches` by hand bypasses the CLI.
- The payload carries an `owner/name` **slug**, never a URL. `git clone
  'ext::sh -c …'` is arbitrary code execution, and the workflow builds the URL
  itself.
- The clone's credential is stripped from `.git/config` before Claude runs in
  that directory, and the cross-repo token is never handed to the action.
- `--setting-sources user --strict-mcp-config` stops a target repo's own
  `.claude/settings.json` hooks and `.mcp.json` servers from executing on the
  runner.
- Changed files are staged **by name** from `git status --porcelain -z` and
  printed before committing. No `git add -A`.
- Commits are authored `workload-dispatcher <wd@ct-builders.ai>` with a
  `Co-Authored-By: Claude` trailer and the job id plus submitter in the body, so
  a strange commit is always traceable back to a dispatch and a person.
- Nothing is pushed until the very end, so a failed run leaves the target
  untouched.
- The CLI stores **no credential of its own** — it uses your `gh` login.

## Testing

`scripts/lint-workflow.sh` — 16 checks on the workflow itself, covering the
invariants whose failure mode is silent: the assignment never being
interpolated, SHA-pinned actions, the bypass gate, in-repo settings and MCP
staying disabled, and `git add -A` never appearing.

`scripts/e2e.sh` — 64 assertions (the lint is section 0) covering remote normalisation, the
multi-remote refusal, branch validation and collisions, the payload contract,
the size guard, run discovery, `--watch`, and every `doctor` check. It fakes
`gh` via `WD_GH_BIN` and dispatches nothing real.

```bash
cd cli && npm run build && ../scripts/e2e.sh
```

## License

MIT
