import { api, getRepo, transport } from './gh.js';
import { branchState } from './gh.js';
import { isGitRepo, listRemotes } from './git.js';
import { resolved } from './config.js';
import { C, log } from './ui.js';

type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  level: Level;
  label: string;
  detail: string;
}

const mark = (l: Level) => (l === 'ok' ? C.green('✓') : l === 'warn' ? C.yellow('⚠') : C.red('✗'));

function decode(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

export async function runChecks(opts: { repo?: string; branch?: string }): Promise<Check[]> {
  const out: Check[] = [];
  const push = (level: Level, label: string, detail: string) => out.push({ level, label, detail });
  const r = resolved();

  // ---------------------------------------------------------------- the hub
  const t = await transport(); // dies with instructions if there is no way in
  push('ok', 'transport', t.kind === 'gh' ? `gh (${t.bin})` : 'fetch with a token from the environment');

  if (!r.hub) {
    push('fail', 'hub configured', 'no hub — run: wd init --hub <owner/repo>');
    return out;
  }
  push('ok', 'hub configured', r.hub);

  const hub = await getRepo(r.hub);
  if (hub.status !== 200 || !hub.body) {
    push('fail', 'hub reachable', `GET /repos/${r.hub} returned ${hub.status}`);
    return out;
  }
  const defaultBranch = hub.body.default_branch;
  push('ok', 'hub reachable', `default branch ${defaultBranch}`);

  if (hub.body.permissions?.push) {
    push('ok', 'push access to the hub', 'yes — repository_dispatch needs it');
  } else {
    push(
      'fail',
      'push access to the hub',
      'no. repository_dispatch requires push access, and the dispatch will come back as a 404',
    );
  }

  const acts = await api<{ enabled?: boolean }>('GET', `/repos/${r.hub}/actions/permissions`);
  if (acts.status === 200 && acts.body?.enabled === false) {
    push('fail', 'Actions enabled', 'Actions is disabled on the hub');
  } else if (acts.status === 200) {
    push('ok', 'Actions enabled', 'yes');
  } else {
    push('warn', 'Actions enabled', `could not check (HTTP ${acts.status}) — needs admin`);
  }

  // The check that matters most, and the one that explains nine out of ten
  // "dispatched but nothing happened" reports.
  const wfPath = `.github/workflows/${r.workflow}`;
  const onDefault = await api<{ content?: string }>(
    'GET',
    `/repos/${r.hub}/contents/${wfPath}?ref=${encodeURIComponent(defaultBranch)}`,
  );
  if (onDefault.status === 200 && onDefault.body?.content) {
    push('ok', 'workflow on the default branch', `${wfPath} @ ${defaultBranch}`);

    const yml = decode(onDefault.body.content);
    // A regex, not a YAML parser: adding a dependency to a deliberately
    // zero-dependency CLI to check two lines is not worth it, and an honest
    // "could not confirm" beats a hard check that is wrong.
    const typesRe = new RegExp(
      `repository_dispatch:[\\s\\S]{0,300}?types:[^\\n]*\\b${r.eventType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    );
    if (typesRe.test(yml)) {
      push('ok', 'workflow listens for the event type', r.eventType);
    } else {
      push(
        'fail',
        'workflow listens for the event type',
        `could not find "${r.eventType}" in on.repository_dispatch.types — it is matched exactly, and case sensitively`,
      );
    }

    // Without this the run happens but wd can never find it — the most
    // confusing possible state, and invisible to every other check.
    if (/run-name:[^\n]*client_payload\.job_id/.test(yml)) {
      push('ok', 'workflow run-name carries the job id', 'wd can find its runs');
    } else {
      push(
        'fail',
        'workflow run-name carries the job id',
        'no run-name referencing client_payload.job_id — runs will work but wd will never find them, and every send will exit 3',
      );
    }
  } else {
    // Say where it *is*, because "I added it on a branch" is the usual story.
    const branches = await api<{ name: string }[]>('GET', `/repos/${r.hub}/branches?per_page=100`);
    const found: string[] = [];
    for (const b of branches.body ?? []) {
      if (b.name === defaultBranch) continue;
      const hit = await api('GET', `/repos/${r.hub}/contents/${wfPath}?ref=${encodeURIComponent(b.name)}`);
      if (hit.status === 200) found.push(b.name);
      if (found.length >= 3) break;
    }
    push(
      'fail',
      'workflow on the default branch',
      found.length
        ? `${wfPath} is on ${found.join(', ')} but NOT on ${defaultBranch}. repository_dispatch only ever runs the copy on the default branch — merge it.`
        : `${wfPath} is not on ${defaultBranch}. Run: wd install`,
    );
  }

  const secrets = await api<{ secrets: { name: string }[] }>('GET', `/repos/${r.hub}/actions/secrets`);
  if (secrets.status === 200) {
    const names = (secrets.body?.secrets ?? []).map((s) => s.name);
    for (const want of ['CLAUDE_CODE_OAUTH_TOKEN', 'WD_GIT_TOKEN']) {
      if (names.includes(want)) {
        // Present is not the same as valid: the API never returns a value, so
        // this must never be reported as "works".
        push('ok', `secret ${want}`, 'set at repo level (the API cannot tell you whether it still works)');
      } else {
        push(
          'warn',
          `secret ${want}`,
          'not set at repo level. It may be inherited from the org, which this endpoint cannot see — check with an org admin',
        );
      }
    }
  } else {
    push(
      'warn',
      'hub secrets',
      `could not list (HTTP ${secrets.status}) — listing secrets needs admin on the hub`,
    );
  }

  // ------------------------------------------------------------- the target
  const inRepo = await isGitRepo();
  if (!inRepo && !opts.repo) {
    push('warn', 'target', 'not a git repository here, and no --repo given');
    return out;
  }

  let target = opts.repo ?? '';
  if (!target) {
    const remotes = (await listRemotes()).filter((x) => x.slug);
    const distinct = [...new Set(remotes.map((x) => x.slug!))];
    if (!distinct.length) {
      push('fail', 'target', 'no GitHub remote on this repository');
      return out;
    }
    if (distinct.length > 1) {
      push('warn', 'target', `${distinct.length} GitHub remotes (${distinct.join(', ')}) — wd will ask, or pass --repo`);
    }
    target = distinct[0];
  }
  push('ok', 'target', target);

  const tr = await getRepo(target);
  if (tr.status !== 200 || !tr.body) {
    push('fail', 'target reachable', `GET /repos/${target} returned ${tr.status}`);
    return out;
  }
  // The single most misleading check in the tool, so it says so.
  push(
    'warn',
    'push access to the target',
    `${tr.body.permissions?.push ? 'you can push' : 'you cannot push'} — but the run pushes with the hub's WD_GIT_TOKEN, not your credentials, so this proves nothing either way`,
  );

  const base = tr.body.default_branch;
  const baseRef = await api('GET', `/repos/${target}/git/ref/heads/${encodeURIComponent(base)}`);
  push(
    baseRef.status === 200 ? 'ok' : 'fail',
    'target base ref exists',
    baseRef.status === 200 ? base : `${base} does not resolve (HTTP ${baseRef.status})`,
  );

  if (opts.branch) {
    const st = await branchState(target, opts.branch);
    push(
      st === 'free' ? 'ok' : 'fail',
      'requested branch is free',
      st === 'free'
        ? opts.branch
        : st === 'exists'
          ? `${opts.branch} already exists on ${target}`
          : `${opts.branch} is blocked: a branch below it (${opts.branch}/…) already exists, and git cannot have both`,
    );
  }

  return out;
}

export function print(checks: Check[]): number {
  const w = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    log(`${mark(c.level)} ${c.label.padEnd(w)}  ${C.dim(c.detail)}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  log('');
  log(
    fails
      ? C.red(`${fails} problem${fails === 1 ? '' : 's'} to fix`) + C.dim(warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '')
      : C.green('all good') + C.dim(warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''),
  );
  return fails ? 1 : 0;
}
