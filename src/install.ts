import { nextAppLayout, nextDocumentPath, type Stack } from './detect';
import { afterImports, htmlHeadIndex, insertAfterTag, insertBefore, insertLine } from './edit';
import type { Project } from './project';
import {
  astroSnippet, htmlSnippet, INSTALLED_RE, jsxSnippet, nextDocument, nextSnippet, nuxtConfigSnippet, nuxtPlugin,
  type SnippetOptions, withKey,
} from './snippet';

export interface Change { path: string; before: string | null; after: string }

export type PlanStatus = 'install' | 'installed' | 'update-key' | 'advice' | 'unsupported';

export interface Plan { status: PlanStatus; changes: Change[]; notes: string[] }

export class InstallError extends Error {
  constructor(message: string) { super(message); this.name = 'InstallError'; }
}

type Planner = (p: Project, o: SnippetOptions, notes: string[]) => Change[];

/** Insert the HTML snippet into the <head> of each file. */
const htmlFiles = (files: string[], snippet: (o: SnippetOptions) => string[] = htmlSnippet): Planner => (p, o, notes) => {
  const changes: Change[] = [];
  for (const path of files) {
    const before = p.read(path);
    if (before === null) continue;
    const idx = htmlHeadIndex(before);
    if (idx < 0) { notes.push(`${path}: no <head> found, skipped`); continue; }
    changes.push({ path, before, after: insertBefore(before, idx, snippet(o)) });
  }
  if (!changes.length) throw new InstallError(`no file with a <head> found (looked at ${files.join(', ') || 'nothing'})`);
  return changes;
};

/** Add `import Script from 'next/script'` unless already imported; returns the local name. */
function withScriptImport(src: string): { src: string; name: string } {
  const m = /import\s+(\w+)\s+from\s+['"]next\/script['"]/.exec(src);
  if (m) return { src, name: m[1] };
  return { src: insertLine(src, afterImports(src), "import Script from 'next/script';"), name: 'Script' };
}

/** Insert JSX right after the first opening tag matching one of `tags`. */
function afterFirstTag(src: string, tags: RegExp[], lines: string[], path: string): string {
  for (const re of tags) {
    const m = re.exec(src);
    if (m) return insertAfterTag(src, m.index, m.index + m[0].length, lines);
  }
  throw new InstallError(`${path}: could not find where to insert (${tags.map((t) => t.source).join(' or ')})`);
}

const nextApp: Planner = (p, o) => {
  const path = nextAppLayout(p)!;
  const before = p.read(path)!;
  const name = /import\s+(\w+)\s+from\s+['"]next\/script['"]/.exec(before)?.[1] ?? 'Script';
  const body = afterFirstTag(before, [/<head\b[^>]*>/, /<body\b[^>]*>/], nextSnippet(o, name), path);
  return [{ path, before, after: withScriptImport(body).src }];
};

const nextPages: Planner = (p, o) => {
  const path = nextDocumentPath(p);
  if (!path) {
    const dir = p.has('src/pages') ? 'src/pages' : 'pages';
    const ext = p.has('tsconfig.json') ? 'tsx' : 'js';
    return [{ path: `${dir}/_document.${ext}`, before: null, after: nextDocument(o) }];
  }
  let src = p.read(path)!;
  // `<Head />` has nowhere to put children: open it up first.
  src = src.replace(/^([ \t]*)<Head\s*\/>/m, (_m, ind: string) => `${ind}<Head>\n${ind}</Head>`);
  const name = /import\s+(\w+)\s+from\s+['"]next\/script['"]/.exec(src)?.[1] ?? 'Script';
  src = afterFirstTag(src, [/<Head(?:\s[^>]*)?>/], nextSnippet(o, name), path);
  return [{ path, before: p.read(path), after: withScriptImport(src).src }];
};

const remix: Planner = (p, o) => {
  const path = p.first('app/root.tsx', 'app/root.jsx', 'app/root.ts', 'app/root.js')!;
  const before = p.read(path)!;
  return [{ path, before, after: afterFirstTag(before, [/<head\b[^>]*>/], jsxSnippet(o), path) }];
};

const astro: Planner = (p, o, notes) => {
  const astroFiles = p.files().filter((f) => f.endsWith('.astro') && /<head\b/i.test(p.read(f) ?? ''));
  const layouts = astroFiles.filter((f) => f.startsWith('src/layouts/'));
  const targets = layouts.length ? layouts : astroFiles;
  if (!layouts.length && targets.length) notes.push('no src/layouts/*.astro with <head>; edited pages directly');
  return htmlFiles(targets, astroSnippet)(p, o, notes);
};

const nuxt: Planner = (p, o, notes) => {
  const path = p.first('nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs');
  const before = path ? p.read(path) : null;
  const call = before ? /defineNuxtConfig\(\s*\{/.exec(before) : null;
  if (path && before && call && !/^\s*app\s*:/m.test(before)) {
    return [{ path, before, after: insertAfterTag(before, call.index, call.index + call[0].length, nuxtConfigSnippet(o)) }];
  }
  // An existing `app:` block is too varied to edit safely: fall back to a client plugin.
  const dir = p.has('app/app.vue') ? 'app/plugins' : 'plugins';
  const ext = path?.endsWith('.ts') ? 'ts' : 'js';
  notes.push(`nuxt.config already has an \`app\` block; added ${dir}/doubleagent.client.${ext} instead (the tag is injected client-side, so \`verify\` cannot see it in server HTML)`);
  return [{ path: `${dir}/doubleagent.client.${ext}`, before: null, after: nuxtPlugin(o) }];
};

const rootHtml = (p: Project): string[] => {
  const root = p.files().filter((f) => !f.includes('/') && /\.html?$/i.test(f));
  return root.length ? root : ['public/index.html'];
};

const PLANNERS: Partial<Record<Stack['id'], Planner>> = {
  'next-app': nextApp,
  'next-pages': nextPages,
  remix,
  astro,
  nuxt,
  vite: (p, o, n) => htmlFiles(['index.html'])(p, o, n),
  sveltekit: (p, o, n) => htmlFiles(['src/app.html'])(p, o, n),
  'wordpress-theme': (p, o, n) => htmlFiles(['header.php'])(p, o, n),
  html: (p, o, n) => htmlFiles(rootHtml(p))(p, o, n),
};

/** Files that already load the SDK (script tag or npm import). */
export const installedIn = (p: Project): string[] => p.files().filter((f) => INSTALLED_RE.test(p.read(f) ?? ''));

export function planInstall(p: Project, stack: Stack, o: SnippetOptions): Plan {
  const notes: string[] = [];
  if (stack.id === 'shopify-theme') {
    notes.push('Add the SDK snippet once to the head of layout/theme.liquid. The CLI provides instructions without editing the theme; Shopify cart attributes are written by the SDK when a cart exists and consent permits.');
    return { status: 'advice', changes: [], notes };
  }
  const existing = installedIn(p);
  if (existing.length) {
    // Re-run with a key sets or replaces data-key on the existing tag; otherwise a no-op.
    const changes = o.key
      ? existing.flatMap((path) => {
        const before = p.read(path)!;
        const after = withKey(before, o.key!);
        return after !== before ? [{ path, before, after }] : [];
      })
      : [];
    if (!changes.length) notes.push(`already installed in ${existing.join(', ')}`);
    return { status: changes.length ? 'update-key' : 'installed', changes, notes };
  }
  const planner = PLANNERS[stack.id];
  if (!planner) return { status: 'unsupported', changes: [], notes };
  return { status: 'install', changes: planner(p, o, notes), notes };
}
