import { createHash } from 'node:crypto';

const MAX_D = 32;

/** `428 {error:{code:'pow_required', difficulty}}` → difficulty (null when absent or not an integer). */
export function difficultyFrom(body: unknown): number | null {
  const d = (body as { error?: { difficulty?: unknown } } | null)?.error?.difficulty;
  return typeof d === 'number' && Number.isInteger(d) ? d : null;
}

const leadingZeroBits = (h: Buffer): number => {
  let bits = 0;
  for (const byte of h) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

/** Hashcash: first decimal solution with SHA-256(prefix + solution) having `d` leading zero bits. */
export function solve(prefix: string, d: number): string {
  if (d > MAX_D) throw new Error(`proof-of-work difficulty ${d} is too high`);
  for (let n = 0; ; n++) {
    if (leadingZeroBits(createHash('sha256').update(prefix + n).digest()) >= d) return String(n);
  }
}
