import type { Project } from './project';

/** Integration names as in @doubleagent-so/js `IntegrationName`. */
export type IntegrationName =
  | 'ga4' | 'gtm' | 'meta' | 'tiktok' | 'gads' | 'shopify' | 'stripe' | 'mixpanel' | 'segment'
  | 'posthog' | 'amplitude' | 'klaviyo' | 'mailchimp' | 'hubspot' | 'intercom' | 'clarity' | 'hotjar';

interface Rule { name: IntegrationName; deps?: string[]; source?: RegExp }

/** Evidence that a vendor SDK is on the site: an npm dependency or a snippet in source. */
const RULES: Rule[] = [
  { name: 'ga4', deps: ['react-ga4', 'vue-gtag', '@next/third-parties', 'nuxt-gtag'], source: /gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-|<GoogleAnalytics\b/ },
  { name: 'gtm', deps: ['react-gtm-module', '@gtm-support/vue-gtm'], source: /googletagmanager\.com\/gtm\.js|['"]GTM-[A-Z0-9]+['"]|<GoogleTagManager\b/ },
  { name: 'gads', source: /gtag\/js\?id=AW-|['"]AW-\d+|googleadservices\.com/ },
  { name: 'meta', deps: ['react-facebook-pixel', 'react-meta-pixel'], source: /connect\.facebook\.net\/[^'"]*fbevents\.js|\bfbq\(\s*['"](init|track)/ },
  { name: 'tiktok', source: /analytics\.tiktok\.com|\bttq\.(load|page|track)\(/ },
  { name: 'klaviyo', deps: ['klaviyo-sdk'], source: /static\.klaviyo\.com|klaviyo\.js|_learnq/ },
  { name: 'mixpanel', deps: ['mixpanel-browser'], source: /cdn\.mxpnl\.com|mixpanel\.init\(/ },
  { name: 'segment', deps: ['@segment/analytics-next', '@segment/snippet'], source: /cdn\.segment\.com\/analytics\.js/ },
  { name: 'posthog', deps: ['posthog-js'], source: /posthog\.init\(|[a-z]+\.posthog\.com\/static\/array\.js/ },
  { name: 'amplitude', deps: ['@amplitude/analytics-browser', '@amplitude/unified', 'amplitude-js'], source: /cdn\.amplitude\.com/ },
  { name: 'hubspot', source: /js\.hs-scripts\.com|js\.hs-analytics\.net|_hsq/ },
  { name: 'intercom', deps: ['@intercom/messenger-js-sdk', 'react-use-intercom'], source: /widget\.intercom\.io|\bIntercom\(\s*['"]boot/ },
  { name: 'clarity', deps: ['@microsoft/clarity'], source: /clarity\.ms\/tag/ },
  { name: 'hotjar', deps: ['@hotjar/browser', 'react-hotjar'], source: /static\.hotjar\.com|\bhj\(\s*['"]/ },
  { name: 'stripe', deps: ['@stripe/stripe-js', '@stripe/react-stripe-js'], source: /js\.stripe\.com\/v3/ },
  { name: 'mailchimp', source: /list-manage\.com\/subscribe/ },
];

export interface Detected { name: IntegrationName; evidence: string }

/** Integrations that `integrations: 'auto'` will activate once their SDK loads on the page. */
export function detectIntegrations(p: Project, extraSources: Record<string, string> = {}): Detected[] {
  const found = new Map<IntegrationName, string>();
  for (const r of RULES) {
    const dep = r.deps?.find((d) => p.dep(d));
    if (dep) found.set(r.name, `dependency ${dep}`);
  }
  const sources: [string, string][] = Object.entries(extraSources);
  for (const f of p.files()) {
    const txt = p.read(f);
    if (txt) sources.push([f, txt]);
  }
  for (const [file, txt] of sources) {
    for (const r of RULES) {
      if (!found.has(r.name) && r.source?.test(txt)) found.set(r.name, file);
    }
  }
  if (p.has('layout/theme.liquid')) found.set('shopify', 'layout/theme.liquid');
  return RULES.map((r) => r.name).concat('shopify').filter((n, i, a) => a.indexOf(n) === i && found.has(n))
    .map((name) => ({ name, evidence: found.get(name)! }));
}

/** Scan fetched HTML (verify) with the same source rules. */
export function detectInHtml(html: string): IntegrationName[] {
  const out = RULES.filter((r) => r.source?.test(html)).map((r) => r.name);
  if (/cdn\.shopify\.com|Shopify\.theme/.test(html)) out.push('shopify');
  return out;
}
