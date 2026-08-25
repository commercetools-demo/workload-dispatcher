import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_WORKFLOW = 'wd-assignment.yml';
export const DEFAULT_EVENT_TYPE = 'wd-assignment';
export const VERSION = '0.1.0';

export interface CliConfig {
  /** The hub: "owner/repo" whose DEFAULT branch holds the workflow. */
  hub?: string;
  /** Workflow file name inside the hub's .github/workflows/. */
  workflow?: string;
  /** repository_dispatch event_type the hub's workflow listens for. */
  eventType?: string;
  /** Recorded in the payload and used by `wd ls --mine`. */
  submitter?: string;
  /**
   * Only used when `gh` is missing. Storing a GitHub token is a downgrade from
   * the keyring `gh` already uses, so `wd init` warns when this is set.
   */
  token?: string;
}

/** %APPDATA%\wd on Windows, $XDG_CONFIG_HOME/wd or ~/.config/wd elsewhere. */
export function configPath(): string {
  if (platform() === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'wd', 'config.json');
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'wd', 'config.json');
}

/**
 * repository_dispatch returns 204 with no run id, so if the run never shows up
 * this file is the only evidence the dispatch happened at all. It is also how
 * `wd watch <job>` knows which hub to look in, days later, from another dir.
 */
export function journalPath(): string {
  return join(process.env.WD_HOME ?? homedir(), '.wd', 'dispatched.jsonl');
}

export function loadConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(next: CliConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  // 0600 because this may hold a fallback token.
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export interface Resolved {
  hub: string;
  workflow: string;
  eventType: string;
  submitter: string;
  token: string;
  apiBase: string;
  cfg: CliConfig;
}

/** Env beats config file, so CI and one-off shells can override. */
export function resolved(): Resolved {
  const cfg = loadConfig();
  return {
    hub: (process.env.WD_HUB ?? cfg.hub ?? '').replace(/\/+$/, ''),
    workflow: process.env.WD_WORKFLOW ?? cfg.workflow ?? DEFAULT_WORKFLOW,
    eventType: process.env.WD_EVENT_TYPE ?? cfg.eventType ?? DEFAULT_EVENT_TYPE,
    submitter: process.env.WD_SUBMITTER ?? cfg.submitter ?? userInfo().username,
    // Env only, in this order, so the common CI case needs no stored secret.
    token:
      process.env.WD_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      cfg.token ??
      '',
    // A real feature (GitHub Enterprise), which is also what lets e2e point the
    // fetch transport at a local stub.
    apiBase: (process.env.WD_API_BASE ?? 'https://api.github.com').replace(/\/+$/, ''),
    cfg,
  };
}

/** The host the API base talks to — used to reject a non-GitHub remote. */
export function apiHost(): string {
  try {
    const h = new URL(resolved().apiBase).hostname;
    return h === 'api.github.com' ? 'github.com' : h;
  } catch {
    return 'github.com';
  }
}
