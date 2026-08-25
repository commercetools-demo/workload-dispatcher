import { api } from './gh.js';
import { PREAMBLE_VERSION } from './preamble.js';
import { VERSION } from './config.js';
import { C, die, fmt } from './ui.js';

export interface PayloadOpts {
  model: string;
  max_turns: number;
  debug: boolean;
  dry_run: boolean;
  draft: boolean;
}

/**
 * The contract between the two halves. The workflow reads these exact keys, so
 * treat every name here as frozen at v1 — additive changes go inside `opts`.
 *
 * `repo` is a SLUG, never a URL. `git clone 'ext::sh -c "…"'` is arbitrary code
 * execution, and dispatching this workflow needs only push access to the hub,
 * which every teammate has. The workflow builds the URL from the slug.
 */
export interface ClientPayload {
  v: number;
  job_id: string;
  repo: string;
  base: string;
  branch: string;
  title: string;
  submitter: string;
  assignment: string;
  opts: PayloadOpts;
}

// Both hard GitHub limits on client_payload, not conventions.
const MAX_PROPS = 10;
const MAX_CHARS = 65_535;
// Margin: we measure our shape of the request, GitHub measures theirs.
const RESERVE = 1_024;

export function buildPayload(p: Omit<ClientPayload, 'v'>): ClientPayload {
  return { v: 1, ...p };
}

/** Nine of the ten allowed properties. The tenth stays free on purpose. */
export function propertyCount(p: ClientPayload): number {
  return Object.keys(p).length;
}

export function wireSize(eventType: string, p: ClientPayload): number {
  const wire = JSON.stringify({ event_type: eventType, client_payload: p });
  // The limit is on the SERIALIZED payload. JSON escaping turns every newline
  // and every quote into two characters, so a 60,000-character brief with 900
  // line breaks serialises past 61,000 — budgeting against prompt.length lets
  // through a payload GitHub then rejects with a bare 422, after the user has
  // already answered three interactive questions. It is not documented whether
  // GitHub counts UTF-16 units or UTF-8 bytes, so take the worse of the two.
  return Math.max(wire.length, Buffer.byteLength(wire, 'utf8'));
}

export function assertPayload(eventType: string, p: ClientPayload): void {
  const n = propertyCount(p);
  if (n > MAX_PROPS) {
    die(`internal: client_payload has ${n} top-level properties, GitHub allows ${MAX_PROPS}`);
  }

  const size = wireSize(eventType, p);
  const budget = MAX_CHARS - RESERVE;
  if (size <= budget) {
    if (size > budget * 0.8) {
      console.error(
        C.yellow(`warning:`) + ` assignment is ${fmt(size)} of ${fmt(MAX_CHARS)} characters`,
      );
    }
    return;
  }

  const overhead = wireSize(eventType, { ...p, assignment: '' });
  // Never truncate. A half-sent assignment produces a run that succeeds, pushes
  // a branch and reports a summary for work that was never fully described —
  // the same success-shaped wrong answer as workload-manager's empty clone.
  die(
    `the assignment is too big for a repository_dispatch event.\n` +
      `  composed assignment  ${fmt(p.assignment.length)} chars\n` +
      `  payload, encoded     ${fmt(size)} chars (metadata and preamble: ${fmt(overhead)})\n` +
      `  GitHub's limit       ${fmt(MAX_CHARS)} (wd reserves ${fmt(RESERVE)})\n` +
      `  over by              ${fmt(size - budget)}\n\n` +
      `Nothing was dispatched. wd will not truncate an assignment — half a brief\n` +
      `comes back as a confident half-diff. Do one of these instead:\n` +
      `  · commit the long brief to ${p.repo} and make the assignment "read docs/brief.md"\n` +
      `  · point at an issue: "do what github.com/${p.repo}/issues/123 describes"\n` +
      `  · split it into two assignments on two branches`,
  );
}

export async function dispatch(hub: string, eventType: string, p: ClientPayload): Promise<void> {
  assertPayload(eventType, p);
  const res = await api('POST', `/repos/${hub}/dispatches`, {
    event_type: eventType,
    client_payload: p,
  });
  if (res.status === 204) return;
  die(explainDispatchFailure(hub, res.status, res.body));
}

export function explainDispatchFailure(hub: string, status: number, body: unknown): string {
  const detail =
    body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : '';

  if (status === 404) {
    // Verified against live gh: POST /repos/cli/cli/dispatches returns 404
    // while GET /repos/cli/cli returns 200. GitHub masks 403 as 404 on write
    // endpoints so private repos cannot be enumerated, so it will not tell you
    // which of these it is.
    return (
      `dispatch to ${hub} was refused with 404.\n` +
      `GitHub answers 404 rather than 403 for writes you are not allowed to make,\n` +
      `so this means one of:\n` +
      `  · you do not have push access to ${hub}\n` +
      `  · your token is missing the "repo" scope — gh auth refresh -s repo,workflow\n` +
      `  · the hub does not exist, or was renamed\n` +
      `Check with: gh api repos/${hub} --jq .permissions`
    );
  }
  if (status === 403) {
    return (
      `dispatch to ${hub} was forbidden (403)${detail ? `: ${detail}` : ''}.\n` +
      `Usually SSO authorisation for the org, or a fine-grained token without\n` +
      `contents: write on the hub. Run: gh auth status`
    );
  }
  if (status === 401) {
    return `token rejected by ${hub} (401). Run: gh auth login`;
  }
  if (status === 422) {
    return (
      `GitHub rejected the payload (422)${detail ? `: ${detail}` : ''}.\n` +
      `That means >10 top-level properties or >${fmt(MAX_CHARS)} characters — both of which\n` +
      `wd pre-checks, so this is a bug in wd. Please report it.`
    );
  }
  return `dispatch to ${hub} failed with ${status}${detail ? `: ${detail}` : ''}`;
}
