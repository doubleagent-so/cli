import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDN_URL } from '../src/snippet';
import { cli, fixture, pkg } from './helpers';

const KEY = 'pk_live_matrix123';
const head = '<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>\n';
const layout = "export default function L({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n";

/** One fixture per supported stack (the Shopify theme is advice-only and covered elsewhere). */
const STACKS: Record<string, Record<string, string>> = {
  'next-app': { 'package.json': pkg({ next: '15' }), 'app/layout.jsx': layout },
  'next-pages': { 'package.json': pkg({ next: '14' }), 'tsconfig.json': '{}', 'pages/index.tsx': '' },
  vite: { 'package.json': pkg({ vite: '6' }), 'index.html': head },
  html: { 'index.html': head },
  astro: { 'package.json': pkg({ astro: '5' }), 'src/layouts/Base.astro': head },
  nuxt: { 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': 'export default defineNuxtConfig({\n  ssr: true,\n});\n' },
  sveltekit: { 'package.json': pkg({ '@sveltejs/kit': '2' }), 'src/app.html': head.replace('</head>', '  %sveltekit.head%\n  </head>') },
  remix: { 'package.json': pkg({ '@react-router/dev': '7' }), 'app/root.jsx': 'export default () => (\n  <html>\n    <head>\n    </head>\n  </html>\n);\n' },
  'wordpress-theme': { 'style.css': 'Theme Name: T', 'header.php': head.replace('</head>', '  <?php wp_head(); ?>\n  </head>') },
};

const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => readdirSync(d).forEach((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8');
  });
  walk(dir);
  return out;
};

describe.each(Object.entries(STACKS))('stack %s', (stack, files) => {
  it('dry run writes nothing; keyless install; idempotent; --key upgrade; idempotent again', async () => {
    const dir = fixture(files);
    const before = snapshot(dir);
    const dry = await cli(['init', '--json', '--dry-run', '--cwd', dir]);
    expect(dry.json).toEqual(expect.objectContaining({ stack, status: 'install', dry_run: true, files_changed: [] }));
    expect(dry.json.diff).toContain(CDN_URL);
    expect(snapshot(dir)).toEqual(before);

    const keyless = await cli(['init', '--json', '--cwd', dir]);
    expect(keyless.json).toEqual(expect.objectContaining({ stack, status: 'install', keyless: true }));
    const changed = keyless.json.files_changed as string[];
    expect(changed.length).toBeGreaterThan(0);
    const afterKeyless = snapshot(dir);
    for (const f of changed) {
      expect(afterKeyless[f], f).toContain(CDN_URL);
      expect(afterKeyless[f], f).not.toMatch(/data-key|dataset\.key/);
    }
    expect((await cli(['init', '--json', '--cwd', dir])).json).toEqual(expect.objectContaining({ status: 'installed', files_changed: [] }));
    expect(snapshot(dir)).toEqual(afterKeyless);

    const keyed = await cli(['init', '--json', '--cwd', dir, '--key', KEY]);
    expect(keyed.json).toEqual(expect.objectContaining({ status: 'update-key', files_changed: changed }));
    const afterKeyed = snapshot(dir);
    for (const f of changed) expect(afterKeyed[f].split(KEY).length - 1, f).toBe(1);
    expect((await cli(['init', '--json', '--cwd', dir, '--key', KEY])).json.status).toBe('installed');
    expect(snapshot(dir)).toEqual(afterKeyed);
  });

  it('fresh keyed install carries the key exactly once', async () => {
    const dir = fixture(files);
    const r = await cli(['init', '--json', '--cwd', dir, '--key', KEY]);
    expect(r.json.status).toBe('install');
    const s = snapshot(dir);
    for (const f of r.json.files_changed as string[]) expect(s[f].split(KEY).length - 1, f).toBe(1);
  });
});
