import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountPowPrefix } from '../src/account';
import { skillCreateAccount, skillSnippet, skillVerify, snippetFor, SNIPPET_STACKS } from '../src/skill';
import { cli, fakeApi, fixture, pkg, read } from './helpers';

const io = (extra: Record<string, unknown> = {}) => {
  let out = '', err = '';
  return { io: { cwd: '/', env: {}, out: (s: string) => { out += `${s}\n`; }, err: (s: string) => { err += `${s}\n`; }, ...extra }, text: () => ({ out, err }) };
};

describe('snippetFor matches the CLI installer', () => {
  const cases: [string, Record<string, string>, string][] = [
    ['html', { 'index.html': '<html><head>\n</head></html>\n' }, 'index.html'],
    ['vite', { 'package.json': pkg({ vite: '6' }), 'index.html': '<html>\n  <head>\n  </head>\n</html>\n' }, 'index.html'],
    ['next-app', { 'package.json': pkg({ next: '15' }), 'app/layout.tsx': 'export default function L({ children }) {\n  return (\n    <html>\n      <body>\n        {children}\n      </body>\n    </html>\n  );\n}\n' }, 'app/layout.tsx'],
    ['astro', { 'package.json': pkg({ astro: '5' }), 'src/layouts/Layout.astro': '<html>\n  <head>\n  </head>\n</html>\n' }, 'src/layouts/Layout.astro'],
    ['sveltekit', { 'package.json': pkg({ '@sveltejs/kit': '2' }), 'src/app.html': '<html>\n\t<head>\n\t\t%sveltekit.head%\n\t</head>\n</html>\n' }, 'src/app.html'],
    ['remix', { 'package.json': pkg({ '@remix-run/react': '2' }), 'app/root.tsx': 'export default () => (\n  <html>\n    <head>\n    </head>\n  </html>\n);\n' }, 'app/root.tsx'],
    ['nuxt', { 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.ts': 'export default defineNuxtConfig({\n});\n' }, 'nuxt.config.ts'],
    ['wordpress', { 'header.php': '<head>\n  <?php wp_head(); ?>\n</head>\n' }, 'header.php'],
  ];
  it.each(cases)('%s: every snippet line appears in the file init writes (keyless and keyed)', async (stack, files, target) => {
    for (const key of [undefined, 'pk_live_abc123']) {
      const dir = fixture(files);
      await cli(['init', '--yes', '--json', '--cwd', dir, ...(key ? ['--key', key] : [])]);
      const written = read(dir, target);
      for (const line of snippetFor(stack, { key, profile: 'auto' }).lines) expect(written, `${stack} ${key}`).toContain(line.trim());
    }
  });

  it('covers every stack, rejects unknown ones and secret keys', async () => {
    expect(SNIPPET_STACKS).toEqual(expect.arrayContaining(['html', 'vite', 'next-app', 'next-pages', 'astro', 'nuxt', 'sveltekit', 'remix', 'wordpress', 'shopify', 'wix', 'squarespace', 'webflow']));
    const a = io();
    expect(await skillSnippet(['nope'], a.io)).toBe(1);
    expect(a.text().err).toMatch(/unknown stack/);
    const b = io();
    expect(await skillSnippet(['vite', '--key', 'sk_live_x'], b.io)).toBe(1);
    expect(b.text().err).toMatch(/secret key/);
    const c = io();
    expect(await skillSnippet(['vite', '--key', 'pk_test_abc', '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.text().out)).toEqual(expect.objectContaining({ stack: 'vite', file: 'index.html', lines: snippetFor('vite', { key: 'pk_test_abc', profile: 'auto' }).lines }));
    const d = io();
    expect(await skillSnippet(['shopify'], d.io)).toBe(0);
    expect(d.text().out).toContain('layout/theme.liquid');
    expect(snippetFor('shopify', { profile: 'auto' }).lines).toEqual(snippetFor('html', { profile: 'auto' }).lines);
    const e = io();
    expect(await skillSnippet([], e.io)).toBe(1);
  });
});

describe('skill command edges', () => {
  it('snippet honours --profile and rejects malformed public keys; the CLI exposes the same commands', async () => {
    const a = io();
    expect(await skillSnippet(['html', '--profile', 'ecommerce', '--key', 'pk_live_abc'], a.io)).toBe(0);
    expect(a.text().out).toContain('data-key="pk_live_abc" data-profile="ecommerce"');
    const b = io();
    expect(await skillSnippet(['html', '--key', 'pk_live_bad_key'], b.io)).toBe(1);
    expect(b.text().err).toMatch(/not a public key/);
    const c = await cli(['snippet', 'next-pages']);
    expect(c.out).toContain("import Script from 'next/script';");
    expect(c.out).toContain('# pages/_document.tsx: inside <Head>');
  });

  it('create-account: --json output, and minimal responses without verify info or login URL', async () => {
    const api = fakeApi({ 'POST /v1/accounts': () => ({ body: { account_id: 'acc_3', site_id: 'st_3', keys: { pk_live: 'pk_live_M', pk_test: '' } } }) });
    const a = io({ fetch: api.fetch });
    expect(await skillCreateAccount(['--email', 'me@x.co', '--api', 'https://api.test', '--json'], a.io)).toBe(0);
    expect(JSON.parse(a.text().out)).toEqual(expect.objectContaining({ account_id: 'acc_3', warning: expect.stringMatching(/never in client code/) }));
    const b = io({ fetch: api.fetch });
    expect(await skillCreateAccount(['--email', 'me@x.co', '--api', 'https://api.test'], b.io)).toBe(0);
    const out = b.text().out;
    expect(out).toContain('pk_live: pk_live_M');
    expect(out).not.toContain('pk_test:');
    expect(out).not.toContain('da-verify');
    expect(out).toContain('Confirm the email sent to me@x.co.');
    const noKeys = fakeApi({ 'POST /v1/accounts': () => ({ body: { account_id: 'acc_4', site_id: 'st_4' } }) });
    const c = io({ fetch: noKeys.fetch });
    expect(await skillCreateAccount(['--email', 'me@x.co', '--api', 'https://api.test'], c.io)).toBe(0);
    const d = io();
    expect(await skillCreateAccount(['--email', 'not-an-email'], d.io)).toBe(1);
  });
});

describe('skill scripts (in-process)', () => {
  it('verify prints the install check with fixes and exits non-zero on problems', async () => {
    const api = fakeApi({
      'GET /': () => ({ raw: '<html><head></head></html>' }),
      'GET /v1/install-check': () => ({ body: { ok: false, script_found: false, problems: [{ code: 'script_missing', message: 'No SDK script', fix: 'Paste the snippet into <head>' }] } }),
    });
    const a = io({ fetch: api.fetch });
    expect(await skillVerify(['https://site.test/', '--api', 'https://api.test'], a.io)).toBe(1);
    expect(a.text().out).toContain('fix: Paste the snippet into <head>');
  });

  it('create-account solves the PoW challenge and prints the keys once', async () => {
    const api = fakeApi({
      'POST /v1/accounts': ({ body, headers }) => {
        const [ts, sol] = headers['da-pow'].split(':');
        const h = createHash('sha256').update(accountPowPrefix(body.email, ts) + sol).digest();
        expect(h[0] === 0 && h[1] === 0 && h[2] >> 6 === 0).toBe(true); // ≥ 18 zero bits
        return { status: 201, body: { account_id: 'acc_1', site_id: 'st_1', keys: { pk_test: 'pk_test_T', pk_live: 'pk_live_L', sk_test: 'sk_test_S' }, verify: { hostname: 'shop.test', token: 'tok' }, login_url: 'https://app.test/l' } };
      },
    });
    const a = io({ fetch: api.fetch });
    expect(await skillCreateAccount(['--email', 'me@x.co', '--domain', 'shop.test', '--api', 'https://api.test'], a.io)).toBe(0);
    const { out } = a.text();
    expect(out).toContain('pk_live_L');
    expect(out).toContain('sk_test_S');
    expect(out).toMatch(/shown once.*never in client code/i);
    expect(out).toContain('_doubleagent.shop.test "da-verify=tok"');
    const b = io();
    expect(await skillCreateAccount([], b.io)).toBe(1);
    expect(b.text().err).toMatch(/--email/);
  });
});
