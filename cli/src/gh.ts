import { apiHost, resolved, VERSION } from './config.js';
import { run } from './proc.js';
import { die, warn } from './ui.js';

export type Transport = { kind: 'gh'; bin: string } | { kind: 'fetch'; token: string };

export interface ApiResult<T> {
  status: number;
  body: T | null;
}

function ghBin(): string {
  return process.env.WD_GH_BIN ?? 'gh';
}

function parse<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

let cached: Transport | null = null;

/**
 * `gh` first, fetch second.
 *
 * `gh` is already authenticated on every machine in this team, keyring-backed,
 * and it handles org SSO authorisation, token refresh and GHES hostnames. The
 * alternative — asking colleagues to mint a classic PAT with `repo` scope and
 * keep it in a plaintext dotfile — is a broader, longer-lived credential in a
 * worse place, and it would make `wd` own the rotation UX. The fetch path is
 * kept for containers and Actions jobs, where GH_TOKEN is already in the env
 * and no stored secret is needed either.
 */
export async function transport(): Promise<Transport> {
  if (cached) return cached;
  const bin = ghBin();
  const { token } = resolved();

  const v = await run(bin, ['--version']);
  if (v.code === 0) {
    // `gh auth status` exits 0 if ANY host is logged in, so name the host we
    // are actually about to talk to.
    const a = await run(bin, ['auth', 'status', '--hostname', apiHost()]);
    if (a.code === 0) return (cached = { kind: 'gh', bin });
    if (token) {
      warn(`${bin} is installed but not authenticated for ${apiHost()} — using the token from the environment`);
      return (cached = { kind: 'fetch', token });
    }
    die(
      `${bin} is installed but not authenticated for ${apiHost()}.\n` +
        `  gh auth login --hostname ${apiHost()}    (recommended)\n` +
        `  or set GH_TOKEN in the environment       (needs the "repo" scope)`,
    );
  }
  if (token) return (cached = { kind: 'fetch', token });
  die(
    `no way to reach ${apiHost()}.\n` +
      `  install the GitHub CLI, then: gh auth login    (recommended)\n` +
      `  or set GH_TOKEN / GITHUB_TOKEN in the environment\n` +
      `  or store one: wd init --hub <owner/repo> --token <tok>`,
  );
}

/**
 * Everything goes through the REST API, even on the `gh` path — `gh api` only.
 * Using `gh run list --json` instead would give the two transports different
 * output shapes to diverge in, and would triple the size of scripts/fake-gh.sh.
 */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const t = await transport();
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  if (t.kind === 'fetch') {
    const res = await fetch(`${resolved().apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${t.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': `wd/${VERSION}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: payload,
    });
    return { status: res.status, body: parse<T>(await res.text()) };
  }

  const args = ['api', path, '-X', method, '-H', 'accept: application/vnd.github+json'];
  // --input - puts the body on stdin. An assignment passed as an argv element
  // would be readable by every other user on the machine via `ps aux`, and
  // would land in shell history. It is also required for correctness: gh only
  // switches off GET when *parameters* are added, and --input is not a
  // parameter, so -X POST above is doing real work.
  if (payload !== undefined) args.push('--input', '-');
  const r = await run(t.bin, args, { input: payload });

  if (r.code === 0) {
    // A 204 comes back as exit 0 with empty stdout — that is the whole success
    // signal for /dispatches.
    return { status: r.stdout.trim() ? 200 : 204, body: parse<T>(r.stdout) };
  }
  // gh puts the JSON error body on stdout and "gh: Not Found (HTTP 404)" on stderr.
  const m = /\(HTTP (\d{3})\)/.exec(r.stderr);
  if (m) return { status: Number(m[1]), body: parse<T>(r.stdout) };
  die(`${t.bin} api ${path} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
}

export interface RepoInfo {
  default_branch: string;
  permissions?: { push?: boolean; admin?: boolean };
  private?: boolean;
}

export async function getRepo(slug: string): Promise<ApiResult<RepoInfo>> {
  return api<RepoInfo>('GET', `/repos/${slug}`);
}

/** [] rather than a 404 when the ref is absent, which is why this beats git/ref. */
export async function matchingRefs(slug: string, branch: string): Promise<{ ref: string }[]> {
  const enc = branch.split('/').map(encodeURIComponent).join('/');
  const res = await api<{ ref: string }[]>('GET', `/repos/${slug}/git/matching-refs/heads/${enc}`);
  return res.status === 200 ? (res.body ?? []) : [];
}

/**
 * `refs/heads/foo` and `refs/heads/foo/bar` cannot coexist, so a name that is
 * not taken is still not necessarily free. Catching that here costs 200ms;
 * missing it costs a `cannot lock ref` failure ten minutes into a run nobody is
 * watching.
 */
export async function branchState(
  slug: string,
  branch: string,
): Promise<'free' | 'exists' | 'blocked-by-prefix'> {
  const names = (await matchingRefs(slug, branch)).map((r) => r.ref.replace(/^refs\/heads\//, ''));
  if (names.includes(branch)) return 'exists';
  if (names.some((n) => n.startsWith(`${branch}/`))) return 'blocked-by-prefix';
  return 'free';
}
