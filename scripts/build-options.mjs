// esbuild options for the CLI bundle and the browser probe it injects during `simulate`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The CLI: one ESM file for Node >= 18; website simulation additionally loads Playwright on Node >= 20. */
export const cliBuildOptions = () => ({
  absWorkingDir: CLI_ROOT,
  entryPoints: [resolve(CLI_ROOT, 'src/bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: resolve(CLI_ROOT, 'dist/doubleagent.mjs'),
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});

/** The browser probe; `simulate` reads it from beside the bundle that runs it. */
export const simulationProbeBuildOptions = (outfile = resolve(CLI_ROOT, 'dist/simulation-probe.js')) => ({
  absWorkingDir: CLI_ROOT,
  entryPoints: [resolve(CLI_ROOT, 'src/simulation/probe.ts')], bundle: true,
  platform: 'browser', target: 'es2020', format: 'iife', minify: true,
  outfile, legalComments: 'none', logLevel: 'warning',
});
