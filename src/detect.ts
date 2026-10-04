import type { Project } from './project';

export type StackId =
  | 'next-app' | 'next-pages' | 'nuxt' | 'sveltekit' | 'astro' | 'remix' | 'vite' | 'html'
  | 'shopify-theme' | 'wordpress-theme' | 'unknown';

/** AI app builders that generate a regular Vite/Next project. */
export type Platform = 'lovable' | 'bolt' | 'v0';

export interface Stack { id: StackId; label: string; platform?: Platform }

const LABELS: Record<StackId, string> = {
  'next-app': 'Next.js (app router)',
  'next-pages': 'Next.js (pages router)',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  astro: 'Astro',
  remix: 'Remix / React Router',
  vite: 'Vite',
  html: 'Static HTML',
  'shopify-theme': 'Shopify theme',
  'wordpress-theme': 'WordPress theme',
  unknown: 'Unknown',
};

const SRC_EXT = ['tsx', 'jsx', 'ts', 'js'];
const withExt = (base: string): string[] => SRC_EXT.map((e) => `${base}.${e}`);

export const nextAppLayout = (p: Project): string | undefined => p.first(...withExt('app/layout'), ...withExt('src/app/layout'));
export const nextDocumentPath = (p: Project): string | undefined => p.first(...withExt('pages/_document'), ...withExt('src/pages/_document'));

/** A JavaScript framework, by its dependency or config file; the first match wins. */
function detectFramework(p: Project): StackId | undefined {
  if (p.dep('next')) return nextAppLayout(p) ? 'next-app' : 'next-pages';
  if (p.dep('nuxt') || p.first('nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs')) return 'nuxt';
  if (p.dep('@sveltejs/kit')) return 'sveltekit';
  if (p.dep('astro') || p.first('astro.config.mjs', 'astro.config.ts', 'astro.config.js')) return 'astro';
  if ((p.dep('@remix-run/react') || p.dep('@react-router/dev')) && p.first(...withExt('app/root'))) return 'remix';
  if (p.dep('vite') && p.has('index.html')) return 'vite';
  return undefined;
}

const hasHtml = (p: Project): boolean =>
  p.has('index.html') || p.has('public/index.html') || p.files().some((f) => !f.includes('/') && /\.html?$/i.test(f));

function detectId(p: Project): StackId {
  if (p.has('layout/theme.liquid')) return 'shopify-theme';
  if (p.has('header.php') || /Theme Name:/i.test(p.read('style.css') ?? '')) return 'wordpress-theme';
  return detectFramework(p) ?? (hasHtml(p) ? 'html' : 'unknown');
}

function detectPlatform(p: Project): Platform | undefined {
  if (p.dep('lovable-tagger')) return 'lovable';
  if (p.has('.bolt')) return 'bolt';
  const readme = p.read('README.md') ?? '';
  if (/lovable\.(dev|app)/i.test(readme)) return 'lovable';
  if (/\bv0\.(dev|app)\b/i.test(readme)) return 'v0';
  return undefined;
}

export function detectStack(p: Project): Stack {
  const id = detectId(p);
  return { id, label: LABELS[id], platform: detectPlatform(p) };
}
