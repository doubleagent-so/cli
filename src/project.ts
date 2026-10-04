import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Read-only view of the project directory. */
export interface Project {
  cwd: string;
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; name?: string } | null;
  has(rel: string): boolean;
  read(rel: string): string | null;
  /** First existing path among candidates. */
  first(...rels: string[]): string | undefined;
  dep(name: string): boolean;
  /** Source files (relative paths), skipping build output and dependencies. */
  files(): string[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', '.svelte-kit', 'out', 'vendor', '.vercel', '.netlify', 'coverage', '.astro', '.cache']);
const SOURCE_EXT = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|liquid|php)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;

export function openProject(cwd: string): Project {
  const has = (rel: string) => existsSync(join(cwd, rel));
  const read = (rel: string): string | null => {
    try { return readFileSync(join(cwd, rel), 'utf8'); } catch { return null; }
  };
  let pkg: Project['pkg'] = null;
  try { pkg = JSON.parse(read('package.json') ?? 'null'); } catch { pkg = null; }
  let cache: string[] | undefined;

  return {
    cwd, pkg, has, read,
    first: (...rels) => rels.find(has),
    dep: (name) => !!(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]),
    files() {
      if (cache) return cache;
      const out: string[] = [];
      const walk = (dir: string) => {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (out.length >= MAX_FILES) return;
          const abs = join(dir, name);
          let st;
          try { st = statSync(abs); } catch { continue; }
          if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs); }
          else if (SOURCE_EXT.test(name) && st.size <= MAX_BYTES) out.push(relative(cwd, abs).replace(/\\/g, '/'));
        }
      };
      walk(cwd);
      return (cache = out.sort());
    },
  };
}
