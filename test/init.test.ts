import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDN_URL, STUB } from '../src/snippet';
import { cli, fixture, init, pkg, read } from './helpers';

const KEY = 'pk_live_abc123';

const nextLayout = `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'App' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
`;

const viteHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>App</title>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

/** Runs init twice: the second run must change nothing. */
async function installTwice(dir: string, files: string[], ...extra: string[]) {
  const first = await init(dir, '--key', KEY, ...extra);
  expect(first.code).toBe(0);
  const snapshot = files.map((f) => read(dir, f));
  const second = await init(dir, '--key', KEY, ...extra);
  expect(second.json.status).toBe('installed');
  expect(second.json.files_changed).toEqual([]);
  expect(files.map((f) => read(dir, f))).toEqual(snapshot);
  return first.json;
}

describe('init per stack', () => {
  it('Next.js app router: next/script beforeInteractive in app/layout, import added once', async () => {
    const dir = fixture({ 'package.json': pkg({ next: '15.0.0', react: '19' }), 'app/layout.tsx': nextLayout });
    const r = await installTwice(dir, ['app/layout.tsx']);
    expect(r).toEqual(expect.objectContaining({ stack: 'next-app', files_changed: ['app/layout.tsx'] }));
    const src = read(dir, 'app/layout.tsx');
    expect(src).toContain("import './globals.css';\nimport Script from 'next/script';\n");
    expect(src).toContain(`      <body className="antialiased">\n        <Script id="doubleagent-stub" strategy="beforeInteractive">\n          {\`${STUB}\`}\n        </Script>\n        <Script src="${CDN_URL}" strategy="beforeInteractive" data-key="${KEY}" data-profile="auto" />\n        {children}`);
    expect(src.match(/next\/script/g)).toHaveLength(1);
  });

  it('Next.js app router reuses an existing next/script import and prefers <head>', async () => {
    const layout = nextLayout.replace("import './globals.css';", "import './globals.css';\nimport NextScript from 'next/script';").replace('<html lang="en">\n', '<html lang="en">\n      <head>\n        <meta name="x" />\n      </head>\n');
    const dir = fixture({ 'package.json': pkg({ next: '15' }), 'src/app/layout.tsx': layout });
    await installTwice(dir, ['src/app/layout.tsx']);
    const src = read(dir, 'src/app/layout.tsx');
    expect(src).toContain('<head>\n        <NextScript id="doubleagent-stub"');
    expect(src).not.toContain("import Script from 'next/script'");
  });

  it('Next.js pages router: edits _document (opening <Head />) or creates one', async () => {
    const doc = `import { Html, Head, Main, NextScript } from 'next/document';\n\nexport default function Document() {\n  return (\n    <Html>\n      <Head />\n      <body>\n        <Main />\n        <NextScript />\n      </body>\n    </Html>\n  );\n}\n`;
    const dir = fixture({ 'package.json': pkg({ next: '14' }), 'pages/index.tsx': 'export default () => null;', 'pages/_document.tsx': doc });
    await installTwice(dir, ['pages/_document.tsx']);
    const src = read(dir, 'pages/_document.tsx');
    expect(src).toContain('      <Head>\n        <Script id="doubleagent-stub" strategy="beforeInteractive">');
    expect(src).toContain('/>\n      </Head>\n      <body>');
    expect(src).toContain("import Script from 'next/script';");

    const dir2 = fixture({ 'package.json': pkg({ next: '14' }), 'tsconfig.json': '{}', 'pages/index.tsx': 'export default () => null;' });
    const r = await installTwice(dir2, ['pages/_document.tsx']);
    expect(r.planned_changes).toEqual([{ path: 'pages/_document.tsx', created: true }]);
    expect(read(dir2, 'pages/_document.tsx')).toContain(`data-key="${KEY}"`);
  });

  it('Vite (Lovable): index.html head, before the first script; reports integrations and platform', async () => {
    const dir = fixture({ 'package.json': pkg({ vite: '6', react: '19' }, { devDependencies: { 'lovable-tagger': '1' } }), 'index.html': viteHtml });
    const r = await installTwice(dir, ['index.html']);
    expect(r).toEqual(expect.objectContaining({ stack: 'vite', platform: 'lovable' }));
    expect(r.integrations).toContain('ga4');
    const html = read(dir, 'index.html');
    const stubAt = html.indexOf(STUB), sdkAt = html.indexOf(CDN_URL), gtagAt = html.indexOf('googletagmanager');
    expect(stubAt).toBeGreaterThan(0);
    expect(stubAt).toBeLessThan(sdkAt);
    expect(sdkAt).toBeLessThan(gtagAt);
    expect(html).toContain(`    <title>App</title>\n    <script>${STUB}</script>\n    <script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto"></script>\n    <script async src="https://www.googletagmanager.com`);
  });

  it('Bolt / v0 platforms are reported', async () => {
    const bolt = fixture({ 'package.json': pkg({ vite: '5' }), '.bolt/config.json': '{}', 'index.html': viteHtml });
    expect((await init(bolt)).json.platform).toBe('bolt');
    const v0 = fixture({ 'package.json': pkg({ next: '15' }), 'README.md': 'Built with v0.dev', 'app/layout.tsx': nextLayout });
    expect((await init(v0)).json).toEqual(expect.objectContaining({ stack: 'next-app', platform: 'v0' }));
  });

  it('plain HTML: every root page, before </head> when no scripts', async () => {
    const page = '<html><head>\n  <title>x</title>\n</head><body></body></html>\n';
    const dir = fixture({ 'index.html': page, 'about.html': page, 'assets/x.html': page });
    const r = await installTwice(dir, ['index.html', 'about.html']);
    expect(r.stack).toBe('html');
    expect(r.files_changed.sort()).toEqual(['about.html', 'index.html']);
    expect(read(dir, 'assets/x.html')).toBe(page);
    expect(read(dir, 'index.html')).toContain(`  <title>x</title>\n  <script>${STUB}</script>\n  <script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto"></script>\n</head>`);
  });

  it('Astro: is:inline scripts in the layout', async () => {
    const layout = '---\nconst { title } = Astro.props;\n---\n<html>\n  <head>\n    <title>{title}</title>\n  </head>\n  <body><slot /></body>\n</html>\n';
    const dir = fixture({ 'package.json': pkg({ astro: '5' }), 'src/layouts/Layout.astro': layout, 'src/pages/index.astro': '<Layout />' });
    await installTwice(dir, ['src/layouts/Layout.astro']);
    expect(read(dir, 'src/layouts/Layout.astro')).toContain(`    <script is:inline>${STUB}</script>\n    <script is:inline async src="${CDN_URL}"`);
  });

  it('Nuxt: app.head.script in nuxt.config, or a client plugin when app: exists', async () => {
    const dir = fixture({ 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n' });
    await installTwice(dir, ['nuxt.config.ts']);
    const cfg = read(dir, 'nuxt.config.ts');
    expect(cfg).toContain(`defineNuxtConfig({\n  app: {\n    head: {\n      script: [\n        { innerHTML: ${JSON.stringify(STUB)} },\n        { src: '${CDN_URL}', async: true, 'data-key': '${KEY}', 'data-profile': 'auto' },`);
    expect(cfg).toContain('  devtools: { enabled: true },');

    const dir2 = fixture({ 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': "export default defineNuxtConfig({\n  app: { baseURL: '/' },\n});\n" });
    const r = await installTwice(dir2, ['plugins/doubleagent.client.ts']);
    expect(r.notes.join(' ')).toMatch(/client plugin|plugins\/doubleagent\.client\.ts/);
    expect(read(dir2, 'plugins/doubleagent.client.ts')).toContain(`s.dataset.key = '${KEY}';`);
    expect(read(dir2, 'nuxt.config.ts')).not.toContain('doubleagent');
  });

  it('SvelteKit: src/app.html before %sveltekit.head%', async () => {
    const html = '<!doctype html>\n<html>\n\t<head>\n\t\t<meta charset="utf-8" />\n\t\t%sveltekit.head%\n\t</head>\n\t<body>%sveltekit.body%</body>\n</html>\n';
    const dir = fixture({ 'package.json': pkg({ '@sveltejs/kit': '2' }), 'src/app.html': html });
    await installTwice(dir, ['src/app.html']);
    expect(read(dir, 'src/app.html')).toContain(`\t\t<script>${STUB}</script>\n\t\t<script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto"></script>\n\t\t%sveltekit.head%`);
  });

  it('Remix: plain <script> JSX in app/root.tsx <head>', async () => {
    const root = 'import { Links, Meta } from "@remix-run/react";\n\nexport default function App() {\n  return (\n    <html>\n      <head>\n        <Meta />\n        <Links />\n      </head>\n    </html>\n  );\n}\n';
    const dir = fixture({ 'package.json': pkg({ '@remix-run/react': '2' }), 'app/root.tsx': root });
    await installTwice(dir, ['app/root.tsx']);
    expect(read(dir, 'app/root.tsx')).toContain(`      <head>\n        <script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(STUB)} }} />\n        <script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto" />\n        <Meta />`);
  });

  it('WordPress theme: header.php before wp_head()', async () => {
    const header = '<!DOCTYPE html>\n<html <?php language_attributes(); ?>>\n<head>\n  <meta charset="<?php bloginfo( \'charset\' ); ?>">\n  <?php wp_head(); ?>\n</head>\n';
    const dir = fixture({ 'style.css': '/*\nTheme Name: Mine\n*/', 'header.php': header });
    const r = await installTwice(dir, ['header.php']);
    expect(r.stack).toBe('wordpress-theme');
    expect(read(dir, 'header.php')).toContain(`  <script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto"></script>\n  <?php wp_head(); ?>`);
  });

  it.each([
    { options: [], key: undefined, profile: 'auto' },
    { options: ['--key', KEY, '--profile', 'ecommerce'], key: KEY, profile: 'ecommerce' },
  ])('Shopify theme: supplies the requested snippet without editing the theme ($profile)', async ({ options, key, profile }) => {
    const theme = '<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>';
    const dir = fixture({ 'layout/theme.liquid': theme, 'config/settings_schema.json': '[]' });
    const r = await init(dir, ...options);
    expect(r.json).toEqual(expect.objectContaining({ stack: 'shopify-theme', status: 'advice', files_changed: [] }));
    expect(r.json.next_steps.join(' ')).toContain('layout/theme.liquid');
    expect(r.json.next_steps.join(' ')).toContain('https://cdn.doubleagent.so/v1/doubleagent.js');
    expect(r.json.next_steps.join(' ')).toContain(`data-profile="${profile}"`);
    if (key) expect(r.json.next_steps.join(' ')).toContain(`data-key="${key}"`);
    else expect(r.json.next_steps.join(' ')).not.toContain('data-key');
    expect(r.json.integrations).toContain('shopify');
    expect(read(dir, 'layout/theme.liquid')).toBe(theme);
  });

  it('unknown stack: exit 2 with the manual snippet', async () => {
    const dir = fixture({ 'README.md': 'hi' });
    const r = await init(dir);
    expect(r.code).toBe(2);
    expect(r.json.status).toBe('unsupported');
    expect(r.json.next_steps.join('\n')).toContain(CDN_URL);
  });
});

describe('init options', () => {
  it('defaults to keyless with a claim URL; a later --key adds data-key, a new key replaces it', async () => {
    const dir = fixture({ 'package.json': pkg({ vite: '6' }, { homepage: 'https://shop.example.com/app' }), 'index.html': viteHtml });
    const first = await init(dir);
    expect(first.json).toEqual(expect.objectContaining({ keyless: true, key: null, domain: 'shop.example.com', claim_url: 'https://app.doubleagent.so/claim?domain=shop.example.com', warnings: [] }));
    expect(first.json.next_steps[0]).toContain('https://app.doubleagent.so/claim?domain=shop.example.com');
    expect(read(dir, 'index.html')).toContain(`<script async src="${CDN_URL}" data-profile="auto"></script>`);
    expect(read(dir, 'index.html')).not.toContain('data-key');

    const second = await init(dir, '--key', KEY);
    expect(second.json).toEqual(expect.objectContaining({ status: 'update-key', keyless: false, files_changed: ['index.html'] }));
    expect(read(dir, 'index.html')).toContain(`<script async src="${CDN_URL}" data-key="${KEY}" data-profile="auto"></script>`);
    expect((await init(dir, '--key', KEY)).json.status).toBe('installed');
    await init(dir, '--key', 'pk_live_rotated');
    expect(read(dir, 'index.html')).toContain('data-key="pk_live_rotated"');
    expect(read(dir, 'index.html').match(/data-key=/g)).toHaveLength(1);

    const portal = await cli(['init', '--json', '--dry-run', '--cwd', fixture({ 'index.html': viteHtml }), '--portal', 'https://portal.test', '--domain', 'x.test']);
    expect(portal.json.claim_url).toBe('https://portal.test/claim?domain=x.test');
  });

  it('keyless snippets per flavour carry no key, and --key upgrades each flavour in place', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ 'package.json': pkg({ next: '15' }), 'app/layout.tsx': nextLayout }, 'app/layout.tsx'],
      [{ 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': 'export default defineNuxtConfig({\n  devtools: { enabled: true },\n});\n' }, 'nuxt.config.ts'],
      [{ 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': "export default defineNuxtConfig({\n  app: { baseURL: '/' },\n});\n" }, 'plugins/doubleagent.client.ts'],
    ];
    for (const [files, target] of cases) {
      const dir = fixture(files);
      await init(dir);
      const keyless = read(dir, target);
      expect(keyless, target).toContain(CDN_URL);
      expect(keyless, target).not.toMatch(/data-key|dataset\.key/);
      await init(dir, '--key', KEY);
      const keyed = read(dir, target);
      expect(keyed.match(new RegExp(KEY, 'g')), target).toHaveLength(1);
      expect(keyed.replace(/ data-key="[^"]+"| 'data-key': '[^']+',|\n\s*s\.dataset\.key = '[^']+';/, ''), target).toBe(keyless);
    }
  });

  it('reads DOUBLEAGENT_KEY and rejects malformed and secret keys', async () => {
    const dir = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml });
    const r = await cli(['init', '--json', '--cwd', dir], { env: { DOUBLEAGENT_KEY: 'pk_test_env1' } });
    expect(r.json).toEqual(expect.objectContaining({ keyless: false, key: 'pk_test_env1', claim_url: null }));
    expect(read(dir, 'index.html')).toContain('data-key="pk_test_env1"');
    const secret = await cli(['init', '--json', '--cwd', dir, '--key', 'sk_live_secret']);
    expect(secret.code).toBe(1);
    expect(secret.json.error).toMatch(/secret key .* never be put in client code/);
    const bad = await cli(['init', '--json', '--cwd', dir, '--key', 'pk_live_has_underscores']);
    expect(bad.json.error).toMatch(/not a public key/);
    const both = await cli(['init', '--json', '--cwd', dir, '--key', KEY, '--email', 'a@b.co']);
    expect(both.json.error).toMatch(/either --email/);
  });

  it('--dry-run prints the diff and writes nothing', async () => {
    const dir = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml });
    const r = await cli(['init', '--dry-run', '--cwd', dir, '--key', KEY]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--- a/index.html\n+++ b/index.html\n@@ -3,6 +3,8 @@');
    expect(r.out).toContain(`+    <script>${STUB}</script>`);
    expect(r.out).toContain('Dry run: nothing written.');
    expect(read(dir, 'index.html')).toBe(viteHtml);
  });

  it('asks for confirmation when interactive, and honours "no"', async () => {
    const dir = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml });
    const asked: string[] = [];
    const r = await cli(['init', '--cwd', dir, '--key', KEY], { confirm: async (q) => { asked.push(q); return false; } });
    expect(asked).toEqual(['Apply 1 change(s)? [Y/n] ']);
    expect(r.code).toBe(1);
    expect(read(dir, 'index.html')).toBe(viteHtml);
    const yes = await cli(['init', '--yes', '--cwd', dir, '--key', KEY], { confirm: async () => { throw new Error('should not ask'); } });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('Wrote index.html.');
  });

  it('new-file diffs come from /dev/null', async () => {
    const dir = fixture({ 'package.json': pkg({ next: '14' }), 'pages/index.js': '' });
    const r = await init(dir, '--key', KEY);
    expect(r.json.diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/pages\/_document\.js\n@@ -0,0 \+1,\d+ @@/);
    expect(existsSync(join(dir, 'pages/_document.js'))).toBe(true);
  });

  it('detects analytics from deps and source', async () => {
    const dir = fixture({
      'package.json': pkg({ vite: '6', 'posthog-js': '1', 'mixpanel-browser': '2', '@segment/analytics-next': '1', '@stripe/stripe-js': '4' }),
      'index.html': viteHtml.replace('</head>', "<script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','1');</script>\n<script src=\"https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X\"></script>\n</head>"),
      'src/gtm.ts': "const id = 'GTM-ABCD12';",
    });
    const r = await init(dir, '--dry-run');
    expect(r.json.integrations).toEqual(['ga4', 'gtm', 'meta', 'klaviyo', 'mixpanel', 'segment', 'posthog', 'stripe']);
    const human = await cli(['init', '--dry-run', '--cwd', dir]);
    expect(human.out).toContain('Integrations that will auto-activate: ga4 (index.html), gtm (src/gtm.ts), meta (index.html)');
  });
});

describe('cli', () => {
  it('prints help and rejects unknown commands', async () => {
    expect((await cli([])).out).toContain('npx @doubleagent-so/cli init');
    expect((await cli(['frobnicate'])).code).toBe(1);
  });
});
