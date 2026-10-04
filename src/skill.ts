/**
 * Commands behind the Agent Skill scripts (github.com/doubleagent-so/skills bundles its helpers from these sources,
 * so the skill and the CLI can never drift): `snippet <stack>`, `create-account --email`, and `verify` (shared).
 */
import { createAccount } from './account';
import { run } from './cli';
import { CliError, str, type Args, type Io } from './io';
import { astroSnippet, htmlSnippet, jsxSnippet, KEY_RE, nextSnippet, nuxtConfigSnippet, SECRET_KEY_RE, type SnippetOptions } from './snippet';

export interface StackSnippet {
  stack: string;
  /** File (or platform setting) to edit. */
  file: string;
  /** Where inside it. */
  where: string;
  /** Extra line to add at the top of the file (Next.js). */
  import?: string;
  /** Exact lines to insert (empty when the platform installs without code). */
  lines: string[];
  note?: string;
}

type Guide = Omit<StackSnippet, 'stack' | 'lines'> & { lines: (o: SnippetOptions) => string[] };

const NEXT_IMPORT = "import Script from 'next/script';";
const HEAD = 'inside <head>, before any other <script>';

const GUIDES: Record<string, Guide> = {
  html: { file: 'every page (*.html)', where: HEAD, lines: htmlSnippet },
  vite: { file: 'index.html', where: HEAD, lines: htmlSnippet },
  'next-app': { file: 'app/layout.tsx (or src/app/layout.tsx)', where: 'right after <head> (or first inside <body>)', import: NEXT_IMPORT, lines: (o) => nextSnippet(o) },
  'next-pages': { file: 'pages/_document.tsx', where: 'inside <Head>', import: NEXT_IMPORT, lines: (o) => nextSnippet(o) },
  astro: { file: 'src/layouts/Layout.astro (every layout with <head>)', where: HEAD, lines: astroSnippet },
  nuxt: { file: 'nuxt.config.ts', where: 'first entry inside defineNuxtConfig({ … }) (merge into an existing app.head if present)', lines: nuxtConfigSnippet },
  sveltekit: { file: 'src/app.html', where: 'inside <head>, before %sveltekit.head%', lines: htmlSnippet },
  remix: { file: 'app/root.tsx', where: 'right after <head>', lines: jsxSnippet },
  wordpress: { file: 'header.php (classic theme) or a header-code plugin', where: 'before <?php wp_head(); ?>', lines: htmlSnippet },
  wix: { file: 'Settings → Custom code → + Add Custom Code', where: 'All pages, Head, load once', lines: htmlSnippet },
  squarespace: { file: 'Settings → Developer tools → Code injection', where: 'Header', lines: htmlSnippet },
  webflow: { file: 'Site settings → Custom code', where: 'Head code, then Publish', lines: htmlSnippet },
  shopify: {
    file: 'layout/theme.liquid', where: HEAD, lines: htmlSnippet,
    note: 'Add the snippet once to the shared theme head. The SDK detects Shopify and writes cart attributes when a cart exists and consent permits.',
  },
};

export const SNIPPET_STACKS = Object.keys(GUIDES);

export function snippetFor(stack: string, o: SnippetOptions): StackSnippet {
  const g = GUIDES[stack];
  if (!g) throw new CliError(`unknown stack "${stack}" (one of: ${SNIPPET_STACKS.join(', ')})`);
  return { stack, file: g.file, where: g.where, ...(g.import ? { import: g.import } : {}), lines: g.lines(o), ...(g.note ? { note: g.note } : {}) };
}

function publicKey(args: Args): string | undefined {
  const k = str(args.flags.key);
  if (k === undefined) return undefined;
  if (SECRET_KEY_RE.test(k)) throw new CliError('that is a secret key (sk_…): it must never be put in client code');
  if (!KEY_RE.test(k)) throw new CliError(`"${k}" is not a public key (pk_live_… / pk_test_…)`);
  return k;
}

/** `snippet <stack> [--key pk_…] [--profile auto] [--json]` */
export async function snippetCmd(args: Args, io: Io): Promise<number> {
  const stack = args.pos[0];
  if (!stack) throw new CliError(`usage: snippet <stack> [--key pk_…] [--json]  (stacks: ${SNIPPET_STACKS.join(', ')})`);
  const s = snippetFor(stack, { key: publicKey(args), profile: str(args.flags.profile) ?? 'auto' });
  if (args.flags.json) { io.out(JSON.stringify(s, null, 2)); return 0; }
  io.out(`# ${s.file}: ${s.where}`);
  if (s.note) io.out(s.note);
  if (s.import) io.out(s.import);
  for (const l of s.lines) io.out(l);
  return 0;
}

/** `create-account --email you@x.com [--domain host] [--name n] [--json]`: keys are printed once. */
export async function createAccountCmd(args: Args, io: Io): Promise<number> {
  const email = str(args.flags.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CliError('usage: create-account --email you@example.com [--domain host] [--name name]');
  const domain = str(args.flags.domain)?.toLowerCase();
  const a = await createAccount(args, io, { email, domain, name: str(args.flags.name) });
  if (args.flags.json) { io.out(JSON.stringify({ ...a, warning: 'keys are shown once; sk_* is server-side only, never in client code' }, null, 2)); return 0; }
  io.out(`Created account ${a.account_id}, site ${a.site_id}.`);
  io.out('Keys (shown once; public keys go in data-key, secret keys stay server-side, never in client code):');
  for (const [k, v] of Object.entries(a.keys ?? {})) if (v) io.out(`  ${k}: ${v}`);
  const host = a.verify?.hostname ?? domain;
  if (a.verify?.token && host) io.out(`Verify the domain to see data: DNS TXT _doubleagent.${host} "da-verify=${a.verify.token}" (or meta tag / .well-known file; see references/claim)`);
  io.out(`Confirm the email sent to ${email}${a.login_url ? ` (or open ${a.login_url})` : ''}.`);
  return 0;
}

// Entry points for the built skill scripts (and tests): same behaviour as the CLI subcommands.
export const skillSnippet = (argv: string[], io: Io): Promise<number> => run(['snippet', ...argv], io);
export const skillVerify = (argv: string[], io: Io): Promise<number> => run(['verify', ...argv], io);
export const skillCreateAccount = (argv: string[], io: Io): Promise<number> => run(['create-account', ...argv], io);
