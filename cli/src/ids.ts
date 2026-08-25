import { randomInt } from 'node:crypto';

// No vowels, so a generated id can never read as a word; no 0/O/1/l, so it
// survives being read out loud or copied off a screen.
const ALPHABET = '23456789bcdfghjkmnpqrstvwxz';

function rand(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** The handle on a dispatch: it goes in run-name and is how `wd watch` finds it. */
export function newJobId(): string {
  return `wd_${rand(6)}`;
}

/** Branch suffix. Four chars is plenty to keep one person's day collision-free. */
export function shortId(): string {
  return rand(4);
}

/**
 * Title to branch-safe slug. Never returns empty: an all-emoji or all-CJK title
 * would otherwise produce "claude/-a1b2", which git rejects for a reason nobody
 * would guess from the error.
 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return s || 'assignment';
}
