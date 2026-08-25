import { api } from './gh.js';
import { C, EXIT, log } from './ui.js';

export interface RawRun {
  id: number;
  name?: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  run_number?: number;
}

export interface Run {
  id: number;
  title: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

/**
 * The whole thread between a dispatch and its run. The workflow sets
 *   run-name: wd ${{ github.event.client_payload.job_id }} · …
 * so the job id sits at the front and `includes` is enough even if GitHub
 * truncates the tail.
 */
export function runNamePrefix(jobId: string): string {
  return `wd ${jobId}`;
}

function toRun(r: RawRun): Run {
  return {
    id: r.id,
    // run-name lands in display_title; `name` is the WORKFLOW's name. Matching
    // on `name` would match every run of the workflow and return the newest —
    // a plausible wrong answer. Fall back to name only for display.
    title: r.display_title ?? r.name ?? '',
    status: r.status,
    conclusion: r.conclusion,
    url: r.html_url,
    createdAt: r.created_at,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function listRuns(hub: string, limit = 30): Promise<Run[]> {
  const res = await api<{ workflow_runs: RawRun[] }>(
    'GET',
    `/repos/${hub}/actions/runs?event=repository_dispatch&per_page=${limit}`,
  );
  if (res.status !== 200) return [];
  return (res.body?.workflow_runs ?? []).map(toRun);
}

export async function findRun(hub: string, jobId: string, sinceMs: number): Promise<Run | null> {
  const want = runNamePrefix(jobId);
  // 60s of tolerance for clock skew between us and GitHub.
  const floor = sinceMs - 60_000;
  const runs = await listRuns(hub);
  return (
    runs.find((r) => r.title.includes(want) && Date.parse(r.createdAt) >= floor) ??
    // A run whose created_at we could not parse is better returned than lost.
    runs.find((r) => r.title.includes(want)) ??
    null
  );
}

/** Front-loaded: the run usually appears in 2-6s, but occasionally takes 60. */
const SCHEDULE = [1_000, 1_500, 2_000, 3_000, 3_000, 4_000, 5_000];

export async function discoverRun(
  hub: string,
  jobId: string,
  opts: { timeoutMs: number; sinceMs: number },
): Promise<Run | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const tty = process.stderr.isTTY === true;
  if (tty) process.stderr.write(C.dim('looking for the run '));
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(SCHEDULE[Math.min(i, SCHEDULE.length - 1)]);
    if (tty) process.stderr.write(C.dim('.'));
    const hit = await findRun(hub, jobId, opts.sinceMs);
    if (hit) {
      if (tty) process.stderr.write('\n');
      return hit;
    }
  }
  if (tty) process.stderr.write('\n');
  return null;
}

/**
 * The honest answer when a 204 produced nothing. This is a diagnosis, not a
 * shrug, because the cause is almost always the same one.
 */
export function explainNoRun(
  hub: string,
  jobId: string,
  eventType: string,
  workflow: string,
): string {
  return (
    `${C.bold('the dispatch was accepted, but no run appeared.')}\n\n` +
    `GitHub answers a repository_dispatch with 204 and no run id, so "accepted"\n` +
    `only means the event was queued — not that anything was listening. No run\n` +
    `named "${runNamePrefix(jobId)}" is among ${hub}'s recent repository_dispatch runs.\n\n` +
    `In rough order of likelihood:\n` +
    `  1. ${workflow} is not on ${hub}'s DEFAULT branch. repository_dispatch only\n` +
    `     ever runs the copy on the default branch — a version on a feature branch\n` +
    `     is invisible to it. This is the usual answer.\n` +
    `  2. The workflow's on.repository_dispatch.types does not contain\n` +
    `     "${eventType}" (matched exactly, and case sensitively).\n` +
    `  3. The workflow has no run-name containing client_payload.job_id, so the\n` +
    `     run exists but wd cannot recognise it.\n` +
    `  4. Actions is disabled on the hub, or the workflow itself is disabled.\n` +
    `  5. It is simply slow. Runs have taken over a minute to appear.\n\n` +
    `${C.bold(`wd doctor`)} checks 1 through 4 directly.\n` +
    `Nothing was retried: repository_dispatch is not idempotent, so resending can\n` +
    `give you two runs racing on the same branch. If a run does start later,\n` +
    `${C.bold(`wd watch ${jobId}`)} will find it.\n\n` +
    `  https://github.com/${hub}/actions?query=event%3Arepository_dispatch`
  );
}

export function statusColour(r: Run): string {
  const key = r.conclusion ?? r.status;
  const map: Record<string, (s: string) => string> = {
    success: C.green,
    failure: C.red,
    timed_out: C.red,
    startup_failure: C.red,
    in_progress: C.blue,
    queued: C.dim,
    waiting: C.dim,
    pending: C.dim,
    cancelled: C.dim,
    skipped: C.dim,
  };
  return (map[key] ?? ((s: string) => s))(key.padEnd(10));
}

export async function watchRun(
  hub: string,
  runId: number,
  opts: { pollMs: number; timeoutMs: number },
): Promise<Run> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = '';
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  try {
    for (;;) {
      const res = await api<RawRun>('GET', `/repos/${hub}/actions/runs/${runId}`);
      // Terminal errors fail fast; transient ones are ridden out, because a
      // 502 from the API is not a reason to stop watching a live run.
      if (res.status === 401 || res.status === 404) {
        log(C.red(`could not read run ${runId} in ${hub} (HTTP ${res.status})`));
        process.exit(EXIT.error);
      }
      if (res.status === 200 && res.body) {
        const r = toRun(res.body);
        const state = r.conclusion ? `${r.status}:${r.conclusion}` : r.status;
        // Transitions only. A line per poll is unreadable in a CI log.
        if (state !== last) {
          log(`  ${statusColour(r)} ${C.dim(r.url)}`);
          last = state;
        }
        if (r.status === 'completed') return r;
      }
      if (interrupted) {
        // Ctrl-C stops the watcher. It does not stop the run — say so, or
        // people assume they cancelled it and dispatch again.
        log(C.dim(`\nstopped watching; the run keeps going:\n  ${runUrl(hub, runId)}`));
        process.exit(EXIT.ok);
      }
      if (Date.now() > deadline) {
        log(C.dim(`\nstill running after the watch timeout:\n  ${runUrl(hub, runId)}`));
        process.exit(EXIT.noRun);
      }
      await sleep(opts.pollMs);
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export function runUrl(hub: string, runId: number): string {
  return `https://github.com/${hub}/actions/runs/${runId}`;
}
