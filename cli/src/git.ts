import { apiHost } from './config.js';
import { run } from './proc.js';

export interface Remote {
  name: string;
  url: string;
  host: string | null;
  slug: string | null;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const stripGit = (s: string) => s.replace(/\.git$/i, '');

function finish(host: string, path: string): { host: string; slug: string } | null {
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // Keep only the first two segments, so a browser URL pasted at --repo
  // (.../owner/repo/tree/main/src) resolves the same as the clone URL.
  const slug = `${parts[0]}/${stripGit(parts[1])}`;
  if (!SLUG_RE.test(slug)) return null;
  return { host: host.toLowerCase().replace(/^www\./, ''), slug };
}

/**
 * Every form a human will paste, folded to { host, slug }. The host comes back
 * rather than being assumed: silently coercing a gitlab.com remote into a
 * GitHub slug would dispatch work at a repo that does not exist.
 */
export function normaliseRemote(raw: string): { host: string; slug: string } | null {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;

  // Bare "owner/repo", which is what --repo and --hub take directly.
  if (!s.includes(':') && SLUG_RE.test(stripGit(s))) {
    return { host: apiHost(), slug: stripGit(s) };
  }

  if (!s.includes('://')) {
    // scp-like: [user@]host:owner/repo(.git). The (?!\/) keeps a malformed
    // "https:/github.com/x/y" out of this branch.
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
    return m ? finish(m[1], m[2]) : null;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!['ssh:', 'git+ssh:', 'https:', 'http:', 'git:'].includes(u.protocol)) return null;
  // URL parsing drops any user:password@ for free, so a token-bearing clone URL
  // never survives into a slug we might echo back.
  return finish(u.hostname, u.pathname);
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.code === 0;
}

/**
 * Read URLs with `git remote get-url`, never `git config remote.X.url`: a
 * url.insteadOf rewrite is common in corporate setups and only get-url applies
 * it, so the raw config value can name a host git will never contact.
 */
export async function listRemotes(cwd?: string): Promise<Remote[]> {
  const names = await run('git', ['remote'], { cwd });
  if (names.code !== 0) return [];
  const out: Remote[] = [];
  for (const name of names.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    // `git remote get-url` has no `--` terminator, and a remote name cannot
    // legally start with `-`, so anything that does is not ours to ask about.
    if (name.startsWith('-')) continue;
    const u = await run('git', ['remote', 'get-url', name], { cwd });
    if (u.code !== 0) continue;
    const url = u.stdout.trim();
    const n = normaliseRemote(url);
    out.push({ name, url, host: n?.host ?? null, slug: n?.slug ?? null });
  }
  const rank = (n: string) => (n === 'origin' ? 0 : n === 'upstream' ? 1 : 2);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Deliberately stricter than git's own rules: this string also ends up in a
 * YAML expression, a URL, and (on Windows) an argv that passes through a shell.
 * Returns a reason, or null when the name is fine.
 */
export async function validateBranchName(name: string): Promise<string | null> {
  if (!name) return 'branch name is empty';
  if (name.length > 200) return `too long (${name.length} chars, max 200)`;
  if (!BRANCH_RE.test(name)) {
    return 'use only letters, digits, ".", "_", "-" and "/", starting with a letter or digit';
  }
  for (const bad of ['..', '//', '@{']) {
    if (name.includes(bad)) return `cannot contain "${bad}"`;
  }
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    return `cannot end with "${name.endsWith('.lock') ? '.lock' : name.slice(-1)}"`;
  }
  // Only now shell out. BRANCH_RE already guaranteed the value cannot be read
  // as a flag — `git check-ref-format --branch` has no `--` terminator, so it
  // would take "-f" as an option — and cannot be a branchname shorthand like
  // "@{-1}", which is *valid* input that resolves to your previous branch.
  const r = await run('git', ['check-ref-format', '--branch', name]);
  if (r.code !== 0) {
    return (r.stderr.trim() || 'git rejected this ref name').replace(/^fatal:\s*/, '');
  }
  return null;
}
