import { api, getRepo } from './gh.js';
import { resolved } from './config.js';
import { shortId } from './ids.js';
import { C, die, log } from './ui.js';
import { WORKFLOW_YAML } from './workflow.generated.js';

export { WORKFLOW_YAML };

interface ContentsResponse {
  sha?: string;
  content?: string;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Always a PR, never a direct push to the default branch — even with
 * permission. Adding a workflow that runs arbitrary prompts with the hub's
 * credentials is a security-relevant change, and forcing a PR is what creates
 * the moment where somebody else looks at it.
 */
export async function install(hub: string, opts: { yes: boolean }): Promise<void> {
  const r = resolved();
  const path = `.github/workflows/${r.workflow}`;

  const repo = await getRepo(hub);
  if (repo.status !== 200 || !repo.body) die(`cannot read ${hub} (HTTP ${repo.status})`);
  const base = repo.body.default_branch;

  const existing = await api<ContentsResponse>(
    'GET',
    `/repos/${hub}/contents/${path}?ref=${encodeURIComponent(base)}`,
  );
  if (existing.status === 200 && existing.body?.content) {
    const current = Buffer.from(existing.body.content, 'base64').toString('utf8');
    if (current === WORKFLOW_YAML) {
      log(`${C.green('✓')} ${path} is already installed on ${hub}@${base}, byte for byte.`);
      return;
    }
    log(
      `${C.yellow('⚠')} ${path} exists on ${hub}@${base} but differs from this version of wd\n` +
        `  installed: ${current.length} bytes\n` +
        `  this wd:   ${WORKFLOW_YAML.length} bytes\n` +
        `  A PR will be opened to update it.`,
    );
  }

  const head = `wd/install-${shortId()}`;
  const ref = await api<{ object: { sha: string } }>(
    'GET',
    `/repos/${hub}/git/ref/heads/${encodeURIComponent(base)}`,
  );
  if (ref.status !== 200 || !ref.body) die(`cannot read ${hub}'s ${base} ref (HTTP ${ref.status})`);

  // The Contents API cannot create a branch, so make the ref first.
  const made = await api('POST', `/repos/${hub}/git/refs`, {
    ref: `refs/heads/${head}`,
    sha: ref.body.object.sha,
  });
  if (made.status < 200 || made.status >= 300) die(`could not create branch ${head} on ${hub} (HTTP ${made.status})`);

  const put = await api('PUT', `/repos/${hub}/contents/${path}`, {
    message: `Add the wd assignment workflow\n\nInstalled by \`wd install\`.`,
    content: b64(WORKFLOW_YAML),
    branch: head,
    ...(existing.status === 200 && existing.body?.sha ? { sha: existing.body.sha } : {}),
  });
  if (put.status !== 200 && put.status !== 201) {
    // The confusing one: GitHub refuses workflow writes without the `workflow`
    // scope, with a message about OAuth apps that nobody reads as "add a scope".
    const hint =
      put.status === 403 || put.status === 404
        ? `\nIf this mentions the "workflow" scope, run: gh auth refresh -h github.com -s workflow`
        : '';
    die(`could not write ${path} on ${hub} (HTTP ${put.status})${hint}`);
  }

  const body = [
    `This adds the \`wd\` assignment workflow, the GitHub Actions half of`,
    `workload-dispatcher.`,
    '',
    `**What merging this enables.** Anyone with **push access** to this`,
    `repository can then run Claude Code against any repository \`WD_GIT_TOKEN\``,
    `can reach, by sending a \`repository_dispatch\` event — with`,
    `\`contents: write\` on the target and this repo's Actions secrets in scope.`,
    `\`repository_dispatch\` already requires push access, so this grants nobody`,
    `new *access*; it turns push access here into a way to execute a`,
    `model-authored change using this repository's credentials, driven by a`,
    `prompt written by whoever sent the event.`,
    '',
    `**It also means write access here is read access to every assignment.**`,
    `Assignments are kept out of the Actions log by design, but anyone who can`,
    `push can add a step that prints them, or enable runner debug logging.`,
    '',
    `Runs push to the branch named in the event and open a PR. They never push`,
    `to \`${base}\`.`,
    '',
    `Two secrets are needed before this does anything:`,
    `\`CLAUDE_CODE_OAUTH_TOKEN\` (from \`claude setup-token\`) and`,
    `\`WD_GIT_TOKEN\` (push access to the target repos).`,
  ].join('\n');

  const pr = await api<{ html_url: string }>('POST', `/repos/${hub}/pulls`, {
    title: `Add the wd assignment workflow`,
    head,
    base,
    body,
  });
  if (pr.status < 200 || pr.status >= 300 || !pr.body) die(`could not open the PR on ${hub} (HTTP ${pr.status})`);

  log(`${C.green('✓')} opened ${pr.body.html_url}`);
  log('');
  log(`Then set the two secrets — never as a flag, so they stay out of your shell history:`);
  log(C.dim(`  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${hub}`));
  log(C.dim(`  gh secret set WD_GIT_TOKEN --repo ${hub}`));
  log('');
  log(`${C.bold('The workflow only becomes dispatchable once that PR is merged')} —`);
  log(`repository_dispatch reads the copy on the default branch and nothing else.`);
}
