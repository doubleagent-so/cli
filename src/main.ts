import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { run } from './cli';

/** The slice of `process` the CLI uses (injectable for tests). */
export interface Proc {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  exitCode?: number | string | null;
}

/** Prompt only when both ends are a terminal; agents and pipes never block on input. */
export function ttyConfirm(p: Proc): ((q: string) => Promise<boolean>) | undefined {
  if (!p.stdin.isTTY || !p.stdout.isTTY) return undefined;
  return async (q) => {
    const rl = createInterface({ input: p.stdin, output: p.stdout });
    try { return !/^n/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
  };
}

/** `prefix` maps a script to a subcommand (the skill's verify.mjs = `verify …`). */
export async function main(p: Proc, prefix: string[] = []): Promise<number> {
  const code = await run([...prefix, ...p.argv.slice(2)], {
    cwd: p.cwd(),
    env: p.env,
    out: (s) => p.stdout.write(`${s}\n`),
    err: (s) => p.stderr.write(`${s}\n`),
    confirm: ttyConfirm(p),
  });
  p.exitCode = code;
  return code;
}
