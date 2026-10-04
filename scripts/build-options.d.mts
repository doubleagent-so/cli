import type { BuildOptions } from 'esbuild';

export declare const CLI_ROOT: string;
export declare function cliBuildOptions(): BuildOptions & { outfile: string };
export declare function simulationProbeBuildOptions(outfile?: string): BuildOptions & { outfile: string };
