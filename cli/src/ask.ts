import { createInterface, type Interface } from 'node:readline/promises';
import { stderr, stdin } from 'node:process';
import { C, die, EXIT } from './ui.js';

let rl: Interface | null = null;
let stdinConsumed = false;
let assumeYes = false;

export function setAssumeYes(v: boolean): void {
  assumeYes = v;
}

/**
 * Called once the assignment has been slurped off stdin. stdin is one stream:
 * you cannot read a piped prompt from it and then ask questions on it. Rather
 * than reopening /dev/tty — which is Unix-only and, under nohup or ssh -T,
 * sends the questions to a terminal the user is not looking at — a piped prompt
 * simply makes the run non-interactive and every resolver dies naming its flag.
 */
export function markStdinConsumed(): void {
  stdinConsumed = true;
}

export function interactive(): boolean {
  return (
    !stdinConsumed &&
    !assumeYes &&
    stdin.isTTY === true &&
    !process.env.CI &&
    !process.env.WD_NO_INPUT
  );
}

function iface(): Interface {
  if (!rl) {
    // output: stderr so that `wd send --json | jq` still parses — a question in
    // the middle of a JSON document breaks it.
    rl = createInterface({ input: stdin, output: stderr, terminal: true });
    // With terminal:true readline swallows SIGINT and emits it instead. Without
    // this listener, Ctrl-C at a prompt does nothing and the user is trapped.
    rl.on('SIGINT', () => {
      close();
      stderr.write('\n');
      process.exit(EXIT.interrupted);
    });
  }
  return rl;
}

/**
 * A readline interface holds a ref on stdin, so a leaked one hangs the process
 * after main() resolves — no output, no error, nothing to debug. Every exit
 * path must come through here.
 */
export function close(): void {
  rl?.close();
  rl = null;
}

function unanswerable(what: string, flag?: string): never {
  const fix = flag ? `pass ${flag}` : 'run this in a terminal';
  die(`need an answer for "${what}" but this is not an interactive terminal — ${fix}`);
}

export async function ask(question: string, flag?: string): Promise<string> {
  if (!interactive()) unanswerable(question, flag);
  const a = (await iface().question(`${C.bold(question)}: `)).trim();
  // Ctrl-D closes stdin and question() resolves with '' — that is not an answer.
  return a || unanswerable(question, flag);
}

/** A question whose default is safe. Non-interactive takes the default. */
export async function askDefault(question: string, fallback: string, flag?: string): Promise<string> {
  if (!interactive()) {
    log_default(question, fallback, flag);
    return fallback;
  }
  const a = await iface().question(`${C.bold(question)} ${C.dim(`[${fallback}]`)}: `);
  return a.trim() || fallback;
}

function log_default(question: string, fallback: string, flag?: string): void {
  stderr.write(
    C.dim(`${question}: ${fallback} (default${flag ? `, override with ${flag}` : ''})\n`),
  );
}

export interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

/**
 * One of n. Non-interactive dies rather than guessing, even under --yes: --yes
 * accepts generated defaults, it does not resolve ambiguity. Picking `origin`
 * when `origin` is someone's fork sends their work to the wrong repo and looks
 * like it worked.
 */
export async function askChoice<T>(
  question: string,
  choices: Choice<T>[],
  flag?: string,
): Promise<T> {
  if (!choices.length) die(`nothing to choose from for "${question}"`);
  if (choices.length === 1) return choices[0].value;
  if (!interactive()) {
    for (const c of choices) stderr.write(`  ${c.label}${c.hint ? `  ${c.hint}` : ''}\n`);
    unanswerable(question, flag);
  }
  stderr.write(`${C.bold(question)}\n`);
  const w = Math.max(...choices.map((c) => c.label.length));
  choices.forEach((c, i) =>
    stderr.write(`  ${C.bold(String(i + 1))}) ${c.label.padEnd(w)}  ${c.hint ? C.dim(c.hint) : ''}\n`),
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = (await iface().question(C.dim(`1-${choices.length} [1]: `))).trim() || '1';
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
    stderr.write(C.dim(`  not 1-${choices.length}\n`));
  }
  die('no valid choice after three tries');
}

/** Loops until `validate` is happy. Returns a reason, or null when fine. */
export async function askUntil(
  question: string,
  fallback: string,
  validate: (v: string) => Promise<string | null> | string | null,
  flag?: string,
): Promise<string> {
  if (!interactive()) {
    log_default(question, fallback, flag);
    const reason = await validate(fallback);
    if (reason) die(`${question}: ${fallback} — ${reason}`);
    return fallback;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const v = await askDefault(question, fallback);
    const reason = await validate(v);
    if (!reason) return v;
    stderr.write(`  ${C.red('✗')} ${reason}\n`);
  }
  die('gave up after five invalid answers');
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  if (assumeYes) return true;
  if (!interactive()) return fallback;
  const a = (await iface().question(`${C.bold(question)} ${C.dim(fallback ? '[Y/n]' : '[y/N]')}: `))
    .trim()
    .toLowerCase();
  if (/^(y|yes)$/.test(a)) return true;
  if (/^(n|no)$/.test(a)) return false;
  return fallback;
}
