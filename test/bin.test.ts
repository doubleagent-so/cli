import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// The bin is process wiring (argv, env, stdio, exit code, TTY prompt). It is exercised end to end:
// build the real bundle with esbuild, then spawn it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'dist', 'doubleagent.mjs');

describe('bin (built dist, spawned)', () => {
  beforeAll(() => { execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'ignore' }); }, 60_000);

  const run = (args: string[], cwd = tmpdir()) => spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, DOUBLEAGENT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'da-bin-')) }, stdio: ['pipe', 'pipe', 'pipe'],
  });

  it('prints help (exit 0) and rejects unknown commands (exit 1)', () => {
    const h = run(['--help']);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('npx @doubleagent-so/cli init');
    const u = run(['nope']);
    expect(u.status).toBe(1);
    expect(u.stderr).toContain('unknown command "nope"');
  });

  it('non-TTY init applies without prompting and exits 0; unsupported stack exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'da-bin-site-'));
    writeFileSync(join(dir, 'index.html'), '<html><head></head></html>');
    const r = run(['init', '--json'], dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(expect.objectContaining({ keyless: true, files_changed: ['index.html'] }));
    expect(run(['init', '--json'], mkdtempSync(join(tmpdir(), 'da-bin-empty-'))).status).toBe(2);
  });

  it('has a node shebang', () => {
    expect(execFileSync('head', ['-1', bin], { encoding: 'utf8' })).toBe('#!/usr/bin/env node\n');
  });
});
