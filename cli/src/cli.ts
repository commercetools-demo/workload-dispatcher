#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_EVENT_TYPE,
  DEFAULT_WORKFLOW,
  VERSION,
  configPath,
  loadConfig,
  resolved,
  saveConfig,
} from './config.js';
import { api, branchState, getRepo, transport } from './gh.js';
import { isGitRepo, listRemotes, normaliseRemote, validateBranchName } from './git.js';
import { newJobId, shortId, slugify } from './ids.js';
import { composeAssignment, PREAMBLE_VERSION, sanitise } from './preamble.js';
import { buildPayload, dispatch, propertyCount, wireSize, type PayloadOpts } from './dispatch.js';
import * as journal from './journal.js';
import * as doctor from './doctor.js';
import { install, WORKFLOW_YAML } from './install.js';
import {
  discoverRun,
  explainNoRun,
  findRun,
  listRuns,
  runNamePrefix,
  runUrl,
  statusColour,
  watchRun,
} from './runs.js';
import * as ask from './ask.js';
import { C, die, EXIT, fmt, log, warn } from './ui.js';

const HELP = `wd — hand a Claude Code assignment to GitHub Actions

  Setup
    wd init --hub <owner/repo>              Save the hub and defaults (0600)
    wd doctor [--repo o/r] [--branch b]     Preflight the hub and the target
    wd install [--print]                    Add the workflow to the hub via a PR
    wd whoami                               Show the resolved config

  Sending
    wd send [title] [options]               Dispatch an assignment
      --prompt <text> | --prompt-file <p> | (stdin)
      --repo <owner/repo>   Target repo (default: this repo's git remote)
      --base <ref>          Branch from this ref (default: target's default)
      --branch <name>       Branch to push (default: claude/<slug>-<rand>)
      --model <name>        sonnet (default) | opus | haiku | fable | full id
      --max-turns <n>       Model-side budget (default 80)
      --draft               Open the PR as a draft
      --debug               Log verbosely in CI and keep the transcript
      --watch               Follow the run to completion
      --dry-run             Print what would be sent; dispatch nothing
      --yes                 Take generated defaults; never guess the repo

  Watching
    wd ls [--limit n] [--mine]              Recent dispatched runs on the hub
    wd watch <job-id>                       Follow a run

  A prompt on stdin makes the run non-interactive — stdin is one stream, so it
  cannot also carry your answers. Pass --repo and --branch in that case.

  Env WD_HUB, WD_WORKFLOW, WD_EVENT_TYPE, WD_SUBMITTER, WD_API_BASE,
  WD_GH_BIN and GH_TOKEN override the saved config.

  Exit 0 ok · 1 error · 2 usage · 3 dispatched but no run found · 4 run failed
`;

// ------------------------------------------------------------------- helpers

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // Inverted TTY check, copied from wm: if a human is at the terminal there is
    // nothing piped in, and blocking on a read would look like a hang.
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

type Opts = Record<string, string | boolean | undefined>;

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

async function resolveTarget(flag: string | undefined): Promise<{ slug: string; via: string }> {
  const host = normaliseRemote('x/y')?.host ?? 'github.com';

  if (flag) {
    const n = normaliseRemote(flag);
    if (!n) die(`--repo "${flag}" is not a repo I can parse — use owner/repo or a github.com URL`);
    if (n.host !== host) {
      die(`--repo "${flag}" is on ${n.host}, not ${host} — wd can only dispatch to GitHub Actions`);
    }
    return { slug: n.slug, via: '--repo' };
  }

  if (!(await isGitRepo())) {
    const answer = await ask.ask('target repo (owner/repo)', '--repo');
    const n = normaliseRemote(answer);
    if (!n) die(`"${answer}" is not owner/repo`);
    return { slug: n.slug, via: 'you' };
  }

  const remotes = await listRemotes();
  const github = remotes.filter((r) => r.slug && r.host === host);
  if (!github.length) {
    const seen = remotes.map((r) => `${r.name} → ${r.url}`).join('\n  ');
    die(`no ${host} remote on this repository${seen ? `:\n  ${seen}` : ''}\npass --repo owner/repo`);
  }

  // Two remotes pointing at the same repo (an https-fetch/ssh-push pair) are
  // one choice, not two.
  const unique = [...new Map(github.map((r) => [r.slug!, r])).values()];
  if (unique.length === 1) return { slug: unique[0].slug!, via: `remote "${unique[0].name}"` };

  // Never guess. In a fork-based workflow `origin` is the personal fork and
  // `upstream` the org repo; dispatching at the fork gets a 204 and silence,
  // because the fork's default branch has no workflow.
  const chosen = await ask.askChoice(
    'which repository is this assignment for?',
    unique.map((r) => ({ label: r.slug!, hint: `(${r.name})`, value: r })),
    '--repo',
  );
  return { slug: chosen.slug!, via: `remote "${chosen.name}"` };
}

// ------------------------------------------------------------------ commands

async function cmdInit(opts: Opts, positionals: string[]): Promise<void> {
  const cfg = loadConfig();
  const hubFlag = str(opts.hub) ?? positionals[0];
  if (hubFlag) {
    const n = normaliseRemote(hubFlag);
    if (!n) die(`--hub "${hubFlag}" is not owner/repo`);
    cfg.hub = n.slug;
  }
  if (str(opts.workflow)) cfg.workflow = str(opts.workflow);
  if (str(opts['event-type'])) cfg.eventType = str(opts['event-type']);
  if (str(opts.submitter)) cfg.submitter = str(opts.submitter);
  if (str(opts.token)) {
    cfg.token = str(opts.token);
    warn(
      'a token in config.json is a downgrade from the keyring gh already uses.\n' +
        '         Prefer: gh auth login. wd only reads this when gh is missing.',
    );
  }
  if (!cfg.hub) die('nothing to save — pass --hub <owner/repo>');
  saveConfig(cfg);
  log(`${C.green('✓')} saved ${configPath()}`);
  log(C.dim(`  hub        ${cfg.hub}`));
  log(C.dim(`  workflow   ${cfg.workflow ?? DEFAULT_WORKFLOW}`));
  log(C.dim(`  event type ${cfg.eventType ?? DEFAULT_EVENT_TYPE}`));
  log('');
  log(`Next: ${C.bold('wd doctor')}`);
}

async function cmdWhoami(): Promise<void> {
  const r = resolved();
  const t = await transport();
  log(`config      ${configPath()}`);
  log(`hub         ${r.hub || C.red('(not set — run wd init)')}`);
  log(`workflow    ${r.workflow}`);
  log(`event type  ${r.eventType}`);
  log(`submitter   ${r.submitter}`);
  log(`api         ${r.apiBase}`);
  log(`transport   ${t.kind === 'gh' ? `gh (${t.bin})` : 'fetch with a token from the environment'}`);
  if (t.kind === 'gh') {
    const me = await api<{ login: string }>('GET', '/user');
    log(`account     ${me.body?.login ?? '(could not read /user)'}`);
  }
  // Never print the token, not even truncated: it is a repo-write credential
  // and there is nothing a prefix tells you that "set" does not.
  log(`token       ${r.token ? C.dim('set (from the environment or config)') : C.dim('not set')}`);
  log(`version     wd ${VERSION}, preamble v${PREAMBLE_VERSION}`);
}

async function cmdSend(opts: Opts, positionals: string[]): Promise<void> {
  const r = resolved();
  if (!r.hub) die('no hub configured — run: wd init --hub <owner/repo>');

  // 1. The assignment. Same precedence as `wm submit`.
  let body = '';
  const promptFile = str(opts['prompt-file']);
  if (promptFile) {
    try {
      body = readFileSync(promptFile, 'utf8');
    } catch (err) {
      die(`could not read --prompt-file ${promptFile}: ${(err as Error).message}`);
    }
  } else if (str(opts.prompt)) {
    body = str(opts.prompt)!;
  } else {
    body = await readStdin();
    // stdin is one stream: having used it for the assignment, it cannot also
    // carry answers. Every resolver from here on dies naming its flag instead
    // of hanging on a terminal that will never type anything.
    if (body.trim()) ask.markStdinConsumed();
  }
  body = sanitise(body);
  if (!body) {
    die('no assignment — pass --prompt <text>, --prompt-file <path>, or pipe it in on stdin');
  }

  // 2. The target, and push access before any more questions.
  const { slug: target, via } = await resolveTarget(str(opts.repo));
  log(`${C.dim('target  ')} ${target} ${C.dim(`(from ${via})`)}`);

  const repo = await getRepo(target);
  if (repo.status !== 200 || !repo.body) {
    die(`cannot read ${target} (HTTP ${repo.status}) — check the name and your access`);
  }

  // 3. Base ref.
  const base = str(opts.base) ?? (await ask.askDefault('base', repo.body.default_branch, '--base'));

  // 4. Title: positionals, then the assignment's first line.
  const firstLine = body.split('\n')[0].replace(/^#+\s*/, '').trim();
  const title =
    positionals.join(' ').trim() ||
    str(opts.title) ||
    (firstLine ? firstLine.slice(0, 72) : '') ||
    (await ask.ask('title', '--title'));

  // 5. Branch: generated default, validated, and checked for collisions.
  const suggested = `claude/${slugify(title)}-${shortId()}`;
  const branch = await ask.askUntil(
    'branch',
    str(opts.branch) ?? suggested,
    async (v) => {
      const bad = await validateBranchName(v);
      if (bad) return bad;
      const st = await branchState(target, v);
      if (st === 'exists') return `${v} already exists on ${target}`;
      if (st === 'blocked-by-prefix') {
        return `${v} is blocked: a branch below it (${v}/…) exists, and git cannot have both`;
      }
      return null;
    },
    '--branch',
  );

  // 6. Compose and size-check.
  const jobId = newJobId();
  const assignment = composeAssignment(body, {
    jobId,
    title,
    target,
    base,
    branch,
    submitter: r.submitter,
  });

  const payloadOpts: PayloadOpts = {
    model: str(opts.model) ?? 'sonnet',
    max_turns: Number(str(opts['max-turns']) ?? 80),
    debug: opts.debug === true,
    dry_run: false,
    draft: opts.draft === true,
  };
  if (!Number.isInteger(payloadOpts.max_turns) || payloadOpts.max_turns < 1) {
    die(`--max-turns must be a positive integer`);
  }

  const payload = buildPayload({
    job_id: jobId,
    repo: target,
    base,
    branch,
    title,
    submitter: r.submitter,
    assignment,
    opts: payloadOpts,
  });

  const size = wireSize(r.eventType, payload);
  log('');
  log(`${C.dim('hub     ')} ${r.hub} ${C.dim(`(${r.workflow}, ${r.eventType})`)}`);
  log(`${C.dim('branch  ')} ${base} → ${C.bold(branch)}`);
  log(`${C.dim('job     ')} ${jobId}`);
  log(`${C.dim('payload ')} ${fmt(size)} chars, ${propertyCount(payload)} properties`);
  log('');

  if (opts['dry-run']) {
    // Print the composed assignment byte for byte: this is the only way to
    // inspect the preamble, and there is deliberately no flag to change it.
    process.stdout.write(assignment);
    log('');
    log(C.dim('--dry-run: nothing was dispatched.'));
    return;
  }

  if (!(await ask.confirm('dispatch?', true))) {
    log(C.dim('nothing dispatched.'));
    return;
  }

  const sinceMs = Date.now();
  journal.record({
    job_id: jobId,
    hub: r.hub,
    workflow: r.workflow,
    event_type: r.eventType,
    target,
    base,
    branch,
    title,
    at: new Date(sinceMs).toISOString(),
    chars: size,
  });
  journal.prune();

  await dispatch(r.hub, r.eventType, payload);

  // A clickable link immediately, so there is something to follow even if
  // discovery fails. 204 means queued, not started — say so.
  log(`${C.green('✓')} dispatched ${C.bold(jobId)} to ${r.hub} ${C.dim('(202/204: queued, not yet started)')}`);
  log(C.dim(`  https://github.com/${r.hub}/actions?query=event%3Arepository_dispatch`));

  if (opts['no-discover']) return;

  const timeoutMs = Number(str(opts['discover-timeout']) ?? 90) * 1000;
  const run = await discoverRun(r.hub, jobId, { timeoutMs, sinceMs });
  if (!run) {
    log('');
    log(explainNoRun(r.hub, jobId, r.eventType, r.workflow));
    process.exit(EXIT.noRun);
  }
  log(`${C.green('✓')} run started  ${run.url}`);

  if (opts.watch) {
    const final = await watchRun(r.hub, run.id, {
      pollMs: Number(str(opts.poll) ?? 6) * 1000,
      timeoutMs: Number(str(opts['watch-timeout']) ?? 3600) * 1000,
    });
    if (final.conclusion !== 'success') {
      log(C.red(`run ${final.conclusion ?? final.status}`));
      log(C.dim(`  gh run view ${final.id} --repo ${r.hub} --log-failed`));
      process.exit(EXIT.runFailed);
    }
    log(C.green('run succeeded — the pull request is on the target repo'));
  }
}

async function cmdLs(opts: Opts): Promise<void> {
  const r = resolved();
  if (!r.hub) die('no hub configured — run: wd init --hub <owner/repo>');
  const limit = Number(str(opts.limit) ?? 20);
  const runs = (await listRuns(r.hub, Math.min(100, Math.max(1, limit)))).filter((x) =>
    x.title.startsWith('wd '),
  );

  const mine = opts.mine ? new Set(journal.all().map((e) => e.job_id)) : null;
  const shown = runs
    .filter((x) => !mine || [...mine].some((j) => x.title.includes(j)))
    .slice(0, limit);

  if (!shown.length) {
    log(C.dim(`no wd runs on ${r.hub} yet`));
    return;
  }
  for (const x of shown) {
    log(`${statusColour(x)} ${C.dim(x.createdAt.replace('T', ' ').replace('Z', ''))}  ${x.title}`);
  }
  log('');
  log(C.dim(`${shown.length} run(s) on ${r.hub}`));
}

async function cmdWatch(positionals: string[], opts: Opts): Promise<void> {
  const jobId = positionals[0] ?? die('usage: wd watch <job-id>', EXIT.usage);
  // The journal is what makes this work days later from another directory.
  const entry = journal.lookup(jobId);
  const hub = str(opts.hub) ?? entry?.hub ?? resolved().hub;
  if (!hub) die(`no hub known for ${jobId} — pass --hub <owner/repo>`);

  const run = await findRun(hub, jobId, entry ? Date.parse(entry.at) : 0);
  if (!run) {
    log(
      explainNoRun(
        hub,
        jobId,
        entry?.event_type ?? resolved().eventType,
        entry?.workflow ?? resolved().workflow,
      ),
    );
    process.exit(EXIT.noRun);
  }
  log(`${C.dim('run')} ${run.url}`);
  const final = await watchRun(hub, run.id, {
    pollMs: Number(str(opts.poll) ?? 6) * 1000,
    timeoutMs: Number(str(opts['watch-timeout']) ?? 3600) * 1000,
  });
  if (final.conclusion !== 'success') {
    log(C.red(`run ${final.conclusion ?? final.status}`));
    log(C.dim(`  gh run view ${final.id} --repo ${hub} --log-failed`));
    process.exit(EXIT.runFailed);
  }
  log(C.green('run succeeded'));
}

// -------------------------------------------------------------------- router

const OPTIONS = {
  // send
  prompt: { type: 'string' },
  'prompt-file': { type: 'string' },
  repo: { type: 'string' },
  base: { type: 'string' },
  branch: { type: 'string' },
  title: { type: 'string' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  draft: { type: 'boolean' },
  debug: { type: 'boolean' },
  watch: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'no-discover': { type: 'boolean' },
  'discover-timeout': { type: 'string' },
  'watch-timeout': { type: 'string' },
  poll: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  // config / global
  hub: { type: 'string' },
  workflow: { type: 'string' },
  'event-type': { type: 'string' },
  submitter: { type: 'string' },
  token: { type: 'string' },
  // ls
  limit: { type: 'string' },
  mine: { type: 'boolean' },
  // install
  print: { type: 'boolean' },
  // misc
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    process.stdout.write(HELP);
    return;
  }

  let values: Opts;
  let positionals: string[];
  try {
    // strict:true, unlike wm's cli.ts. A typo'd `--brnach` there is swallowed
    // silently; here it would dispatch a real run onto a wrong generated branch
    // and spend someone's quota on it, so the typo has to be fatal.
    const parsed = parseArgs({
      args: argv.slice(1),
      options: OPTIONS as never,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Opts;
    positionals = parsed.positionals;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      die(`${(err as Error).message.split('. ')[0]} — run \`wd help\``, EXIT.usage);
    }
    throw err;
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.yes) ask.setAssumeYes(true);

  switch (verb) {
    case 'init':
    case 'login':
      return cmdInit(values, positionals);
    case 'whoami':
      return cmdWhoami();
    case 'send':
    case 'submit':
    case 'dispatch':
      return cmdSend(values, positionals);
    case 'ls':
    case 'list':
      return cmdLs(values);
    case 'watch':
      return cmdWatch(positionals, values);
    case 'doctor': {
      const checks = await doctor.runChecks({
        repo: str(values.repo),
        branch: str(values.branch),
      });
      process.exit(doctor.print(checks));
      break;
    }
    case 'install': {
      if (values.print) {
        // The only zero-permission mode, and how the checked-in copy of the
        // workflow is kept in sync.
        process.stdout.write(WORKFLOW_YAML);
        return;
      }
      const hub = str(values.hub) ?? resolved().hub;
      if (!hub) die('no hub configured — run: wd init --hub <owner/repo>');
      return install(hub, { yes: values.yes === true });
    }
    default:
      die(`unknown command "${verb}" — run \`wd help\``, EXIT.usage);
  }
}

main()
  .catch((err) => {
    die(err instanceof Error ? err.message : String(err));
  })
  // A readline interface holds a ref on stdin, so without this the process
  // prints its result and then hangs — no output, no error, nothing to debug.
  .finally(() => ask.close());
