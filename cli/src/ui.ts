const useColor = !process.env.NO_COLOR && process.stderr.isTTY !== false;
const wrap = (code: string) => (s: string) => (useColor ? `${code}${s}\x1b[0m` : s);

export const C = {
  dim: wrap('\x1b[90m'),
  bold: wrap('\x1b[1m'),
  red: wrap('\x1b[31m'),
  green: wrap('\x1b[32m'),
  yellow: wrap('\x1b[33m'),
  blue: wrap('\x1b[34m'),
};

/**
 * Exit codes are part of the interface: a script has to tell "your arguments
 * were wrong" from "it dispatched but I could not find the run", because only
 * the second one means work may still be happening.
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  noRun: 3,
  runFailed: 4,
  interrupted: 130,
} as const;

export function die(msg: string, code: number = EXIT.error): never {
  console.error(`${C.red('error:')} ${msg}`);
  process.exit(code);
}

export function warn(msg: string): void {
  console.error(`${C.yellow('warning:')} ${msg}`);
}

/** Progress and prose go to stderr so `--json` stdout stays parseable. */
export function log(msg: string): void {
  console.error(msg);
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
