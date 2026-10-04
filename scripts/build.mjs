// Builds dist/doubleagent.mjs and the browser probe beside it (dist/simulation-probe.js).
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { cliBuildOptions, simulationProbeBuildOptions } from './build-options.mjs';

const probe = simulationProbeBuildOptions();
await build(probe);
console.log(`built ${probe.outfile}`);

const cli = cliBuildOptions();
await build(cli);
chmodSync(cli.outfile, 0o755);
console.log(`built ${cli.outfile}`);
