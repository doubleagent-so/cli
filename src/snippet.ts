/** What the installer writes: the install snippet from https://doubleagent.so/docs/. */

export const CDN_URL = 'https://cdn.doubleagent.so/v1/doubleagent.js';
export const STUB = 'window.doubleagent=window.doubleagent||{q:[],push(){this.q.push(arguments)}};';
/** Old installs may still carry this; `verify` flags it. */
export const PLACEHOLDER_KEY = 'pk_test_REPLACE_ME';
/** Same shape the Double Agent API accepts for a public key; new keys have 24 chars. */
export const KEY_RE = /^pk_(live|test)_[A-Za-z0-9]{1,64}$/;
export const SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]{1,64}$/;
/** Presence of either means the SDK is already installed in a file. */
export const INSTALLED_RE = /cdn\.doubleagent\.so\/v1\/doubleagent\.js|from\s+['"]@doubleagent(?:-so)?\/js['"]/;

/** No `key` = keyless install (data is claimable later by verifying the domain). */
export interface SnippetOptions { key?: string; profile: string }

const attr = (key?: string): string => (key ? ` data-key="${key}"` : '');

/** Plain HTML (index.html, app.html, header.php). The stub runs first so early calls queue. */
export const htmlSnippet = ({ key, profile }: SnippetOptions): string[] => [
  `<script>${STUB}</script>`,
  `<script async src="${CDN_URL}"${attr(key)} data-profile="${profile}"></script>`,
];

/** Astro processes <script> tags unless they are `is:inline`. */
export const astroSnippet = ({ key, profile }: SnippetOptions): string[] => [
  `<script is:inline>${STUB}</script>`,
  `<script is:inline async src="${CDN_URL}"${attr(key)} data-profile="${profile}"></script>`,
];

/** next/script with beforeInteractive (app/layout or pages/_document). */
export const nextSnippet = ({ key, profile }: SnippetOptions, Script = 'Script'): string[] => [
  `<${Script} id="doubleagent-stub" strategy="beforeInteractive">`,
  `  {\`${STUB}\`}`,
  `</${Script}>`,
  `<${Script} src="${CDN_URL}" strategy="beforeInteractive"${attr(key)} data-profile="${profile}" />`,
];

/** Plain JSX (Remix / React Router root.tsx). */
export const jsxSnippet = ({ key, profile }: SnippetOptions): string[] => [
  `<script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(STUB)} }} />`,
  `<script async src="${CDN_URL}"${attr(key)} data-profile="${profile}" />`,
];

/** nuxt.config `app.head.script` entries. */
export const nuxtConfigSnippet = ({ key, profile }: SnippetOptions): string[] => [
  'app: {',
  '  head: {',
  '    script: [',
  `      { innerHTML: ${JSON.stringify(STUB)} },`,
  `      { src: '${CDN_URL}', async: true,${key ? ` 'data-key': '${key}',` : ''} 'data-profile': '${profile}' },`,
  '    ],',
  '  },',
  '},',
];

/** Fallback when nuxt.config already has an `app` block: a client plugin that injects the tag. */
export const nuxtPlugin = ({ key, profile }: SnippetOptions): string => `// Added by \`npx @doubleagent-so/cli init\`: loads the Double Agent SDK.
export default defineNuxtPlugin(() => {
  ${STUB}
  const s = document.createElement('script');
  s.async = true;
  s.src = '${CDN_URL}';
${key ? `  s.dataset.key = '${key}';\n` : ''}  s.dataset.profile = '${profile}';
  document.head.appendChild(s);
});
`;

/** New pages/_document when the project has none. */
export const nextDocument = (o: SnippetOptions): string => `import { Html, Head, Main, NextScript } from 'next/document';
import Script from 'next/script';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
${nextSnippet(o).map((l) => `        ${l}`).join('\n')}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
`;

/**
 * Set (or replace) the key on an existing install, whatever flavour wrote it. Returns the source
 * unchanged when there is no SDK tag to attach it to.
 */
export function withKey(src: string, key: string): string {
  if (/data-key="|'data-key':|dataset\.key = '/.test(src)) {
    return src
      .replace(/(data-key=")[^"]*(")/g, `$1${key}$2`)
      .replace(/('data-key':\s*')[^']*(')/g, `$1${key}$2`)
      .replace(/(dataset\.key = ')[^']*(')/g, `$1${key}$2`);
  }
  const url = CDN_URL.replace(/[./]/g, '\\$&');
  return src
    .replace(new RegExp(`(src="${url}")`, 'g'), `$1 data-key="${key}"`)
    .replace(new RegExp(`(src: '${url}',)`, 'g'), `$1 'data-key': '${key}',`)
    .replace(new RegExp(`^([ \\t]*)(s\\.src = '${url}';)$`, 'gm'), `$1$2\n$1s.dataset.key = '${key}';`);
}
