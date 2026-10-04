import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, ttyConfirm, type Proc } from '../src/main';

function proc(argv: string[], opts: { tty?: boolean; input?: string; cwd?: string } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: opts.tty });
  const stdout = Object.assign(new PassThrough(), { isTTY: opts.tty });
  const stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', (d) => { out += d; });
  stderr.on('data', (d) => { err += d; });
  if (opts.input !== undefined) setTimeout(() => stdin.write(opts.input), 10);
  const p: Proc = { argv: ['node', 'doubleagent', ...argv], env: { DOUBLEAGENT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'da-main-')) }, cwd: () => opts.cwd ?? tmpdir(), stdin, stdout, stderr };
  return { p, out: () => out, err: () => err };
}

describe('main (process wiring)', () => {
  it('passes argv, writes stdout/stderr lines and sets exitCode', async () => {
    const ok = proc(['--help']);
    expect(await main(ok.p)).toBe(0);
    expect(ok.p.exitCode).toBe(0);
    expect(ok.out()).toContain('npx @doubleagent-so/cli init');
    const bad = proc(['nope']);
    expect(await main(bad.p)).toBe(1);
    expect(bad.err()).toContain('unknown command "nope"');
  });

  it('no prompt without a TTY on both ends', () => {
    expect(ttyConfirm(proc([]).p)).toBeUndefined();
    const half = proc([], { tty: true });
    (half.p.stdout as { isTTY?: boolean }).isTTY = false;
    expect(ttyConfirm(half.p)).toBeUndefined();
  });

  it('with a TTY: "n" declines, Enter/"y" accepts', async () => {
    for (const [answer, want] of [['n\n', false], ['No\n', false], ['\n', true], ['y\n', true]] as const) {
      const t = proc([], { tty: true, input: answer });
      expect(await ttyConfirm(t.p)!('Apply? '), JSON.stringify(answer)).toBe(want);
    }
  });

  it('interactive init honours the answer end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'da-main-site-'));
    writeFileSync(join(dir, 'index.html'), '<html><head></head></html>');
    const t = proc(['init'], { tty: true, input: 'n\n', cwd: dir });
    expect(await main(t.p)).toBe(1);
    expect(t.out()).toContain('Aborted, nothing written.');
  });
});
