import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';
import { afterImports, htmlHeadIndex, insertAfterTag, insertBefore } from '../src/edit';
import { difficultyFrom, solve } from '../src/pow';
import { withKey, CDN_URL } from '../src/snippet';
import { cli, fixture, pkg, read } from './helpers';

describe('parseArgs', () => {
  it('handles --flag=value, -y, value flags, trailing flags, booleans before positionals', () => {
    expect(parseArgs(['init', '--key=pk_live_a', '-y', '--profile', 'saas', '--json'])).toEqual({ cmd: 'init', pos: [], flags: { key: 'pk_live_a', y: true, profile: 'saas', json: true } });
    expect(parseArgs(['keys', 'rotate', 'k1', '--site'])).toEqual({ cmd: 'keys', pos: ['rotate', 'k1'], flags: { site: true } });
    expect(parseArgs(['init', '--dry-run', 'extra'])).toEqual({ cmd: 'init', pos: ['extra'], flags: { 'dry-run': true } });
    expect(parseArgs(['x', '--name', '--json'])).toEqual({ cmd: 'x', pos: [], flags: { name: true, json: true } });
    expect(parseArgs(['x', '--note=a=b'])).toEqual({ cmd: 'x', pos: [], flags: { note: 'a=b' } });
    expect(parseArgs(['--help'])).toEqual({ pos: [], flags: { help: true } });
    for (const flag of ['headed', 'report', 'resolve-identity', 'sign-requests']) {
      expect(parseArgs(['simulate', `--${flag}`, 'https://example.com'])).toEqual({ cmd: 'simulate', pos: ['https://example.com'], flags: { [flag]: true } });
    }
  });

  it('help, -h, "help" exit 0; unknown command exits 1; a bare --key is rejected as not a public key', async () => {
    for (const a of [[], ['help'], ['--help'], ['init', '-h']]) expect((await cli(a)).code, a.join(' ')).toBe(0);
    const unknown = await cli(['nope']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/unknown command "nope"/);
    const dir = fixture({ 'index.html': '<html><head></head></html>' });
    expect((await cli(['init', '--json', '--cwd', dir, '--key'])).json.error).toBe('invalid --key: expected a value');
    expect((await cli(['init', '--json', '--cwd', dir, '--email', '--yes'])).json.error).toBe('invalid --email: expected a value');
    expect((await cli(['keys', '--site'])).err).toContain('invalid --site: expected a value');
    expect(read(dir, 'index.html')).toBe('<html><head></head></html>'); // nothing installed on a bad flag
  });
});

describe('proof of work (CLI)', () => {
  it('reads the difficulty from a pow_required error body; junk is null', () => {
    expect(difficultyFrom({ error: { code: 'pow_required', difficulty: 20, format: 'x' } })).toBe(20);
    expect(difficultyFrom({ error: { code: 'pow_required', difficulty: 1.5 } })).toBeNull();
    expect(difficultyFrom({ error: { code: 'pow_required' } })).toBeNull();
    expect(difficultyFrom({ error: 'pow_required' })).toBeNull();
    expect(difficultyFrom(null)).toBeNull();
    expect(difficultyFrom('text')).toBeNull();
  });

  it('solves to the requested zero bits (0 and 8+), refuses > 32', () => {
    expect(solve('p|', 0)).toBe('0');
    for (const d of [1, 8, 12]) {
      const s = solve('prefix|', d);
      const h = createHash('sha256').update(`prefix|${s}`).digest();
      const bits = h[0] === 0 ? 8 + Math.clz32(h[1]) - 24 : Math.clz32(h[0]) - 24;
      expect(bits, `d=${d}`).toBeGreaterThanOrEqual(Math.min(d, 8));
      if (d > 8) expect(h[0]).toBe(0);
    }
    expect(() => solve('p', 33)).toThrow(/too high/);
  });
});

describe('edit helpers', () => {
  it('inserts inline into minified HTML (before and after tags)', () => {
    const min = '<html><head><title>x</title></head><body></body></html>';
    const idx = htmlHeadIndex(min);
    expect(insertBefore(min, idx, ['<a>', '<b>'])).toBe('<html><head><title>x</title><a><b></head><body></body></html>');
    const tag = '<body class="x">';
    const at = min.indexOf('<body');
    const src = min.replace('<body>', tag);
    expect(insertAfterTag(src, at, at + tag.length, ['<s/>'])).toContain('<body class="x"><s/></body>');
    expect(insertAfterTag('<head>', 0, 6, ['<s/>'])).toBe('<head><s/>');
  });

  it('uses tab indentation when the tag line uses tabs', () => {
    const src = '<html>\n\t<head>\n\t</head>\n</html>';
    const at = src.indexOf('<head>');
    expect(insertAfterTag(src, at, at + 6, ['<s/>'])).toBe('<html>\n\t<head>\n\t\t<s/>\n\t</head>\n</html>');
  });

  it('htmlHeadIndex: no head at all, only </head>, head without close', () => {
    expect(htmlHeadIndex('<p>hi</p>')).toBe(-1);
    expect(htmlHeadIndex('<meta></head>')).toBe(6);
    expect(htmlHeadIndex('<head><meta>')).toBe(12);
    expect(htmlHeadIndex('<HEAD><SCRIPT src=a></SCRIPT></HEAD>')).toBe(6);
  });

  it('afterImports: multi-line imports, side-effect imports, directives, none', () => {
    expect(afterImports("'use client';\nexport const a = 1;\n")).toBe(14);
    const multi = "import {\n  a,\n  b,\n} from 'x';\nimport 'side.css';\nconst z = 1;\n";
    expect(multi.slice(afterImports(multi))).toBe('const z = 1;\n');
    const sideMulti = "import {\n  a\n}\n  from 'x';\nfoo();\n";
    expect(sideMulti.slice(afterImports(sideMulti))).toBe('foo();\n');
    expect(afterImports('const a = 1;')).toBe(0);
    const noNl = "import a from 'a';";
    expect(afterImports(noNl)).toBe(noNl.length);
  });

  it('withKey leaves files without an SDK tag untouched', () => {
    expect(withKey('<html></html>', 'pk_live_x')).toBe('<html></html>');
    expect(withKey(`<script src="${CDN_URL}" data-key="old">`, 'pk_live_x')).toBe(`<script src="${CDN_URL}" data-key="pk_live_x">`);
  });
});

describe('install edge cases', () => {
  it('remix without <head>, next app without head/body, html files without head: clear errors', async () => {
    const remix = fixture({ 'package.json': pkg({ '@remix-run/react': '2' }), 'app/root.tsx': 'export default () => <html></html>;' });
    expect((await cli(['init', '--json', '--cwd', remix])).json.error).toMatch(/app\/root\.tsx: could not find where to insert/);
    const next = fixture({ 'package.json': pkg({ next: '15' }), 'app/layout.tsx': 'export default ({ children }) => children;' });
    expect((await cli(['init', '--json', '--cwd', next])).json.error).toMatch(/app\/layout\.tsx: could not find where to insert \(<head\\b\[\^>\]\*> or <body\\b\[\^>\]\*>\)/);
    const html = fixture({ 'index.html': '<p>no head</p>', 'b.html': '<html><head></head></html>' });
    const r = await cli(['init', '--json', '--cwd', html]);
    expect(r.json.files_changed).toEqual(['b.html']);
    expect(r.json.notes).toEqual(['index.html: no <head> found, skipped']);
    const none = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': '<p>x</p>' });
    expect((await cli(['init', '--json', '--cwd', none])).json.error).toMatch(/no file with a <head> found \(looked at index\.html\)/);
  });

  it('astro without layouts edits pages; without any <head> fails', async () => {
    const dir = fixture({ 'package.json': pkg({ astro: '5' }), 'src/pages/index.astro': '<html><head></head><body/></html>' });
    const r = await cli(['init', '--json', '--cwd', dir]);
    expect(r.json.files_changed).toEqual(['src/pages/index.astro']);
    expect(r.json.notes[0]).toMatch(/edited pages directly/);
    const empty = fixture({ 'astro.config.mjs': 'export default {}' });
    expect((await cli(['init', '--json', '--cwd', empty])).json.error).toMatch(/looked at nothing/);
  });

  it('nuxt 4 (app/ dir) and js config put the plugin in app/plugins as .js; nuxt.config without defineNuxtConfig', async () => {
    const dir = fixture({ 'package.json': pkg({ nuxt: '4' }), 'app/app.vue': '<template/>', 'nuxt.config.js': 'export default defineNuxtConfig({\n  app: {},\n});\n' });
    expect((await cli(['init', '--json', '--cwd', dir])).json.files_changed).toEqual(['app/plugins/doubleagent.client.js']);
    const plain = fixture({ 'package.json': pkg({ nuxt: '3' }), 'nuxt.config.mjs': 'export default {}\n' });
    expect((await cli(['init', '--json', '--cwd', plain])).json.files_changed).toEqual(['plugins/doubleagent.client.js']);
    const noConfig = fixture({ 'package.json': pkg({ nuxt: '3' }) });
    expect((await cli(['init', '--json', '--cwd', noConfig])).json.files_changed).toEqual(['plugins/doubleagent.client.js']);
  });

  it('next pages router under src/, .js when there is no tsconfig, existing Script import reused in _document', async () => {
    const dir = fixture({ 'package.json': pkg({ next: '14' }), 'src/pages/index.jsx': '' });
    expect((await cli(['init', '--json', '--cwd', dir])).json.files_changed).toEqual(['src/pages/_document.js']);
    const doc = "import NS from 'next/script';\nexport default () => (\n  <Html>\n    <Head>\n    </Head>\n  </Html>\n);\n";
    const d2 = fixture({ 'package.json': pkg({ next: '14' }), 'pages/_document.jsx': doc });
    await cli(['init', '--json', '--cwd', d2]);
    expect(read(d2, 'pages/_document.jsx')).toContain('      <NS id="doubleagent-stub"');
    expect(read(d2, 'pages/_document.jsx').match(/next\/script/g)).toHaveLength(1);
  });

  it('public/index.html fallback, CNAME domain guess, invalid homepage ignored, profile flag, human output for installed/unsupported', async () => {
    const dir = fixture({ 'public/index.html': '<html><head></head></html>', CNAME: 'docs.example.org\n', 'package.json': JSON.stringify({ homepage: '.' }) });
    const r = await cli(['init', '--json', '--cwd', dir, '--profile', 'saas']);
    expect(r.json).toEqual(expect.objectContaining({ files_changed: ['public/index.html'], domain: 'docs.example.org' }));
    expect(read(dir, 'public/index.html')).toContain('data-profile="saas"');
    const again = await cli(['init', '--cwd', dir]);
    expect(again.out).toContain('Already installed: nothing to do.');
    const unsupported = await cli(['init', '--cwd', fixture({ 'README.md': '' })]);
    expect(unsupported.code).toBe(2);
    expect(unsupported.out).toContain('Could not detect a supported stack.');
    const publicCname = fixture({ 'index.html': '<html><head></head></html>', 'public/CNAME': 'p.example.org' });
    expect((await cli(['init', '--json', '--cwd', publicCname])).json.domain).toBe('p.example.org');
  });

  it('human output for keyed installs and shopify advice; claim url without domain', async () => {
    const keyed = await cli(['init', '--yes', '--cwd', fixture({ 'index.html': '<html><head></head></html>' }), '--key', 'pk_live_K']);
    expect(keyed.out).toContain('Unlock the dashboard: npx @doubleagent-so/cli login');
    expect(keyed.out).toContain('Server side: verify tokens');
    const shop = await cli(['init', '--cwd', fixture({ 'layout/theme.liquid': '' })]);
    expect(shop.out).toContain('layout/theme.liquid');
    expect(shop.out).toContain('https://cdn.doubleagent.so/v1/doubleagent.js');
    const noDomain = await cli(['init', '--json', '--dry-run', '--cwd', fixture({ 'index.html': '<html><head></head></html>' })]);
    expect(noDomain.json.claim_url).toBe('https://app.doubleagent.so/claim');
  });

  it('project walk skips dependency/build dirs and oversized files', async () => {
    const big = 'x'.repeat(600 * 1024);
    const dir = fixture({
      'index.html': '<html><head></head></html>',
      'node_modules/lib/index.html': '<script src="https://connect.facebook.net/en_US/fbevents.js"></script>',
      'dist/a.js': "gtag('config','G-1')",
      'big.js': `${big}clarity.ms/tag`,
      'src/ok.ts': 'mixpanel.init("x")',
    });
    const r = await cli(['init', '--json', '--dry-run', '--cwd', dir]);
    expect(r.json.integrations).toEqual(['mixpanel']);
  });
});

describe('installed detection after the @doubleagent-so rename', () => {
  it('treats an npm import of @doubleagent-so/js (and the legacy @doubleagent/js) as installed', async () => {
    const { INSTALLED_RE } = await import('../src/snippet');
    expect(INSTALLED_RE.test("import { doubleagent } from '@doubleagent-so/js';")).toBe(true);
    expect(INSTALLED_RE.test('import d from "@doubleagent/js"')).toBe(true);
    expect(INSTALLED_RE.test("import x from '@doubleagent-so/node';")).toBe(false);
  });
});
