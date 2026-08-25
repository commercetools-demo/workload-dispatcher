import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { journalPath } from './config.js';

export interface Entry {
  job_id: string;
  hub: string;
  workflow: string;
  event_type: string;
  target: string;
  base: string;
  branch: string;
  title: string;
  at: string;
  chars: number;
}

const KEEP = 500;

/**
 * repository_dispatch returns 204 with no run id, so if the run never appears
 * this file is the only evidence anything happened. It is also what lets
 * `wd watch <job>` resolve the hub days later from a different directory.
 * Never holds the assignment.
 */
export function record(e: Entry): void {
  const p = journalPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  } catch {
    // A dispatch must not fail because the journal could not be written.
  }
}

export function all(): Entry[] {
  try {
    return readFileSync(journalPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Entry;
        } catch {
          return null;
        }
      })
      .filter((e): e is Entry => e !== null);
  } catch {
    return [];
  }
}

export function lookup(jobId: string): Entry | null {
  return all().reverse().find((e) => e.job_id === jobId) ?? null;
}

export function prune(): void {
  const entries = all();
  if (entries.length <= KEEP) return;
  try {
    writeFileSync(
      journalPath(),
      `${entries.slice(-KEEP).map((e) => JSON.stringify(e)).join('\n')}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best effort */
  }
}
