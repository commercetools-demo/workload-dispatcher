# @commercetools-demo/wd

Hand a Claude Code assignment to GitHub Actions. For when your own quota is
gone: you describe the work, CI does it, and the result comes back as a pull
request.

```bash
npm install -g @commercetools-demo/wd
```

Needs Node 20+ and the [GitHub CLI](https://cli.github.com) logged in — `wd`
stores no credential of its own and uses your existing `gh` login.

> **Name clash worth knowing:** oh-my-zsh ships a `wd` ("warp directory") shell
> *function*, and shell functions beat `$PATH`. If `wd send` gives you a
> directory error, run `type wd` — you have the other one.

## How it works

There are two repos in play, and the CLI keeps them strictly apart:

- The **hub** holds one workflow and two secrets. One per team.
- The **target** is the repo the work happens in. It comes from your current
  directory's git remote and travels inside the dispatch payload.

`wd send` composes your assignment (prepending a fixed preamble that tells
Claude to work unattended and never ask questions), sends a
`repository_dispatch` at the hub, then finds and optionally follows the run. The
hub's workflow clones the target, runs Claude, stages the changed paths by name,
pushes a branch and opens a PR.

The assignment is deliberately kept out of the Actions log: it travels in a
payload GitHub renders in no UI, is read off disk rather than through a `${{ }}`
interpolation, and is masked before anything else runs. That protects it from
anyone with *read* access to the hub — not from anyone with *write* access. See
the repo's `JOINING.md` for the exact boundary before you rely on it.

## Setup

```bash
wd init --hub <owner/repo>   # where the workflow and secrets live
wd install                   # opens a PR adding the workflow to the hub
wd doctor                    # preflight; run this whenever something is wrong
```

Merge that PR before expecting anything to happen — `repository_dispatch` only
ever runs the copy of a workflow that is on the **default branch**, and a copy on
a feature branch is invisible to it. That is the most common first-run failure,
and `wd doctor` checks for it specifically.

## Sending

From inside the repo the work is for:

```bash
wd send "Fix PDP price rounding" \
  --prompt "Prices round down in cartTotals.ts. Make it half-up and add a test."
```

It asks which remote (only if there are several) and what to call the branch,
then dispatches. `--watch` follows the run to its conclusion.

**Write the assignment for a stranger who cannot ask you anything.** State the
end condition, name the files if you know them, and say how to tell it worked.
`wd send --dry-run` prints byte for byte what Claude will read.

A prompt on stdin makes the run non-interactive — stdin is one stream, so it
cannot also carry your answers. Pass `--repo` in that case.

## Commands

| | |
|---|---|
| `wd send [title]` | Dispatch an assignment (`--prompt`, `--prompt-file`, or stdin) |
| `wd ls` | Recent dispatched runs on the hub |
| `wd watch <job-id>` | Follow a run, from any directory, days later |
| `wd doctor` | Preflight the hub and the target |
| `wd install` | Add the workflow to the hub via a PR |
| `wd init` / `wd whoami` | Configure and inspect |

Exit codes are meant to be scripted against: `0` ok, `1` error, `2` usage,
`3` dispatched but no run found, `4` the run failed.

Full documentation, the workflow itself, and the trust story:
**[commercetools-demo/workload-dispatcher](https://github.com/commercetools-demo/workload-dispatcher)**

MIT
