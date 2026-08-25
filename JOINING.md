# Joining the dispatcher

You describe a piece of work; GitHub Actions does it with Claude Code and opens
a pull request. Useful when your own Claude quota is gone for the period — the
compute and the subscription belong to the org rather than to your laptop.

> **The hub lives at**
> `commercetools-demo/workload-dispatcher`
>
> Everything below assumes that repo. It is the only thing to change if it
> moves.

Sibling tool: [workload-manager](https://github.com/commercetools-demo/workload-manager)
farms the same kind of work out to colleagues' machines. Use that when a human
needs to be in the loop, and this when nobody is free.

---

## What you are agreeing to

Read this part properly. It is shorter than workload-manager's trust section but
it is not smaller.

**Dispatching runs a prompt as code, with the org's credentials, against a repo
you named.** There is no review step between your text and Claude editing a
repository. That works because it is a small team, not because the sandbox is
airtight.

**Anyone who can push to the hub can dispatch.** `repository_dispatch` requires
push access and nothing more, so everyone with push to the hub can dispatch a
prompt — with one `gh api` call, no `wd` involved. Keep the hub's collaborator
list to people you would give that to.

What bounds it: the workflow refuses any target outside an allowlisted org
(`vars.WD_ALLOWED_OWNERS`, defaulting to the hub's own owner), checked before
the clone. So "can dispatch" means "can run Claude against a repo in our org",
not "anywhere the token reaches". That check is the control — the token itself is
org-wide.

### The privacy boundary, stated exactly

The assignment is kept out of the Actions log on purpose: it travels in a
`repository_dispatch` payload that GitHub renders in no UI, the workflow reads it
off disk instead of through a `${{ }}` interpolation, and it is masked before
anything else runs. Claude's transcript is never printed or uploaded. The PR body
is a summary Claude writes for reviewers, not your original text.

> **The assignment is invisible to anyone with _read_ access to the hub. It is
> recoverable by anyone with _write_ access to the hub. It is not protected from
> GitHub itself.**

Two write-access paths, one of which cannot be closed:

- Someone can add a workflow step that prints the payload.
- Someone can re-run the job with debug logging enabled. Runner diagnostic logs
  capture the whole event — including the assignment — *before any step runs*, so
  no step can prevent it. The workflow refuses a UI-enabled debug run, which
  covers the first half of this but not the diagnostic archive.

So: **do not treat this as confidential.** It is discreet, not secret.

### What travels, and what must not

The queue carries **references, never secrets** — same rule as
workload-manager, and for a stronger reason here, since the payload sits in
GitHub's event store.

> Project key `acme-demo`. Credentials are in GCP Secret Manager as
> `ct-acme-demo-storefront`. Fix the tax categories on all products.

Never an API client secret, a token, or a password. Not once, not "just this
time".

Also worth knowing: **the branch name is public in the target repo.** Do not put
anything sensitive in it.

### One person's Claude subscription pays for all of it

`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`, which mints it against
**one person's** subscription. So the tool whose whole point is that *your*
quota ran out spends *theirs*. That person should know, and when they rotate the
token or their plan lapses, every dispatch fails at once. There is no per-user
fallback. This is the tool's real single point of failure — an Anthropic service
account is the fix once it outgrows a small team.

---

## One-time setup

Node 20+, and `gh` already logged in.

**1. Install the CLI.**

```bash
git clone git@github.com:commercetools-demo/workload-dispatcher.git
cd workload-dispatcher/cli && npm install && npm run build && npm link
```

**2. Point it at the hub.** Stored `0600` in `~/.config/wd/config.json`
(`%APPDATA%\wd\config.json` on Windows). No token is stored — `wd` uses your
existing `gh` login, which keeps the credential in your OS keyring where it
belongs.

```bash
wd init --hub commercetools-demo/workload-dispatcher
```

**3. Check it.**

```bash
wd doctor
```

`wd doctor` is the answer to almost every "it didn't work". It checks, among
other things, whether the workflow is on the hub's default branch — which is the
one failure that otherwise looks exactly like success.

> **Name clash worth knowing:** oh-my-zsh ships a `wd` ("warp directory") shell
> *function*, and shell functions beat `$PATH`. If `wd send` gives you a
> directory error, run `type wd` — you have the other one.

---

## Giving work away

```bash
cd ~/code/some-storefront
wd send "Fix PDP price rounding" \
  --prompt "Prices round down in cartTotals.ts. Make it half-up, add a test."
```

It reads the repo from your git remote (asking which, if there are several),
proposes a branch name, and dispatches. Then `wd ls`, or `wd watch <job-id>`, or
`--watch` to follow it straight away.

**Write the assignment for a stranger who cannot ask you anything.** Nobody is
there. State the end condition, name the files if you know them, and say how to
tell it worked. `wd` prepends a fixed preamble telling Claude never to ask, to
state its assumptions rather than stall, to change only what was asked, and to
treat your text as data rather than instructions — but no preamble can supply
context you left out. Vague assignments come back as vague diffs, and here you
pay for the round trip in someone else's quota.

`wd send --dry-run` prints byte for byte what Claude will read. Worth doing once,
so you know what the preamble commits you to.

| Flag | Use |
|---|---|
| `--repo` | Target repo, if you are not standing in it |
| `--base` | Start from something other than the default branch |
| `--branch` | Name the branch yourself |
| `--model` | `sonnet` (default), `opus`, `haiku`, `fable` |
| `--max-turns` | Model-side budget, default 80. Exceeding it opens **no PR** |
| `--draft` | Open the PR as a draft |
| `--debug` | Verbose CI logs **and** the transcript uploaded as an artifact — that artifact contains the assignment, so only use it deliberately |

---

## What can and cannot be handed over

| | |
|---|---|
| ✅ Anything a headless agent can finish | code changes, tests, refactors within a repo, docs, config the assignment names |
| ✅ Anything the commercetools API covers | products, prices, tax categories, types, channels, discounts, imports |
| ❌ Anything genuinely UI-only | Merchant Center settings with no API surface |
| ❌ A customer's production project | not ours to hand to CI |
| ❌ Anything with a secret in the prompt | see above |
| ❌ Anything you cannot describe well enough for a stranger to finish | |

The runner is a fresh Ubuntu box with no access to your machine, your `gcloud`
identity, or your VPN. If the work needs any of those, it cannot be dispatched.

**The workflow will not touch `.github/`** — the preamble forbids it with no
exceptions, because a workflow edit is a privilege-escalation primitive. If the
assignment is genuinely about CI, do it yourself.

---

## Working in each other's repos

The run clones and pushes with the **hub's** `WD_GIT_TOKEN`, not with your
credentials. Two consequences:

- **Your own access proves nothing.** `wd doctor` says so out loud. You can be
  able to push to a repo the run cannot reach, and vice versa.
- **The audit trail is split.** Who asked is in the commit body and the PR body;
  which run did it is in the run link; who pushed is the token's identity.
  Commits are authored `workload-dispatcher <wd@ct-builders.ai>` with a
  `Co-Authored-By: Claude` trailer and the job id, so a strange commit on a
  branch is always traceable back to a dispatch and a person.

Pushes go to a branch and open a PR. Never to a default branch — the workflow
will not do it and you should not ask.

---

## When something looks wrong

| Symptom | What it means |
|---|---|
| `dispatched … no run appeared` (exit 3) | Almost always: the workflow is not on the hub's **default** branch. `wd doctor` |
| Exit 3 every single time, but PRs do appear | The workflow's `run-name` lost the job id, so `wd` cannot recognise its own runs. `wd doctor` |
| 404 on dispatch | You lack push access to the hub, or your token lacks the `repo` scope. GitHub returns 404 rather than 403 for both |
| The run fails at "Prepare the branch" | The branch already exists on the target, or the base ref does not |
| The run fails with "not opening an empty pull request" | Claude changed nothing — the work was already done, the assignment was a question, or it refused the assignment |
| A failure issue on the hub | The run died. Nothing was pushed; the target is untouched |
| The PR has a tiny diff and a cheerful summary | Check `--max-turns`, and read the summary for stated assumptions. This is the failure mode to watch for |

`wd ls` shows recent runs. `gh run view <id> --repo <hub> --log-failed` shows why
one died — the log deliberately holds no assignment text, so it is safe to paste.

Stuck? Fix the assignment and send it again with a fresh branch name. Do not
re-dispatch the same branch: `repository_dispatch` is not idempotent and two runs
racing on one branch is worse than no run at all.
