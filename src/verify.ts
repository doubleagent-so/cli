import { detectInHtml, type IntegrationName } from './analytics';
import { KEY_RE, PLACEHOLDER_KEY } from './snippet';
import { DEFAULT_API } from './api';

const TIMEOUT_MS = 10000;

/** GET /v1/install-check response. Every field is optional: the API may omit any of them. */
export interface InstallCheck {
  ok?: boolean;
  script_found?: boolean;
  script_src?: string;
  key?: string;
  key_valid?: boolean;
  profile_attr?: string;
  keyless?: boolean;
  claim_url?: string;
  stub_before_script?: boolean;
  integrations_detected?: string[];
  last_beacon_at?: string | null;
  problems?: { code?: string; message?: string; fix?: string }[];
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Narrow an untrusted body to InstallCheck, dropping fields of the wrong type. */
export function parseInstallCheck(body: unknown): InstallCheck | undefined {
  if (!isObj(body)) return undefined;
  const bool = (k: string) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : undefined);
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const problems = Array.isArray(body.problems)
    ? body.problems.map((p) => (isObj(p)
      ? { code: typeof p.code === 'string' ? p.code : undefined, message: typeof p.message === 'string' ? p.message : undefined, fix: typeof p.fix === 'string' ? p.fix : undefined }
      : { message: String(p) }))
    : undefined;
  return {
    ok: bool('ok'), script_found: bool('script_found'), script_src: s('script_src'), key: s('key'), key_valid: bool('key_valid'),
    profile_attr: s('profile_attr'), stub_before_script: bool('stub_before_script'), keyless: bool('keyless'), claim_url: s('claim_url'),
    integrations_detected: Array.isArray(body.integrations_detected) ? body.integrations_detected.filter((x): x is string => typeof x === 'string') : undefined,
    last_beacon_at: s('last_beacon_at') ?? (body.last_beacon_at === null ? null : undefined),
    problems,
  };
}

export interface VerifyResult {
  url: string;
  ok: boolean;
  status?: number;
  script: boolean;
  stub: boolean;
  key?: string;
  keyValid: boolean;
  /** Script present without a data-key: a valid keyless install. */
  keyless: boolean;
  endpoint?: string;
  integrations: IntegrationName[];
  /** `body` is passed through as received; `check` is its parsed form when it is JSON. */
  installCheck: { reachable: boolean; status?: number; body?: unknown; check?: InstallCheck; error?: string };
  problems: string[];
}

type FetchFn = typeof fetch;

const timeoutSignal = (ms: number): AbortSignal => {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
};

/** First capture of `re` in the html, attribute or JSON form (next/script serialises props). */
const attr = (html: string, name: string): string | undefined =>
  new RegExp(`${name}["']?\\s*[:=]\\s*\\\\?["']([^"'\\\\]+)`).exec(html)?.[1];

/** The page's server HTML, or null when it can't be fetched. Either way the problem is recorded. */
async function fetchPage(f: FetchFn, url: string, result: VerifyResult): Promise<string | null> {
  try {
    const res = await f(url, { headers: { 'User-Agent': 'doubleagent-cli (install verify)', Accept: 'text/html' }, redirect: 'follow', signal: timeoutSignal(TIMEOUT_MS) });
    result.status = res.status;
    const html = await res.text();
    if (!res.ok) result.problems.push(`GET ${url} returned ${res.status}`);
    return html;
  } catch (e) {
    result.problems.push(`could not fetch ${url}: ${(e as Error).message}`);
    return null;
  }
}

/** What the HTML shows: the script tag, the queue stub, the key and endpoint, and known integrations. */
function inspectHtml(result: VerifyResult, html: string): void {
  result.script = /cdn\.doubleagent\.so\/v1\/doubleagent\.js/.test(html);
  result.stub = html.includes('window.doubleagent=window.doubleagent||');
  result.key = attr(html, 'data-key');
  result.endpoint = attr(html, 'data-endpoint');
  result.keyValid = !!result.key && KEY_RE.test(result.key) && result.key !== PLACEHOLDER_KEY;
  result.integrations = detectInHtml(html);
  result.keyless = result.script && !result.key;
}

function htmlProblems(result: VerifyResult): string[] {
  const problems: string[] = [];
  if (!result.script) problems.push('SDK script tag not found in the server HTML (client-side injection is not visible here)');
  if (result.script && !result.stub) problems.push('queue stub missing: calls made before the SDK loads will throw');
  if (result.key === PLACEHOLDER_KEY) problems.push(`placeholder key ${PLACEHOLDER_KEY} is still in place`);
  else if (result.key && !result.keyValid) problems.push(`data-key "${result.key}" is not a pk_live_/pk_test_ key`);
  return problems;
}

/** The API's own install check of the URL; a body that isn't JSON is kept as its first 500 characters. */
async function installCheck(f: FetchFn, api: string, url: string): Promise<VerifyResult['installCheck']> {
  try {
    const res = await f(`${api}/v1/install-check?url=${encodeURIComponent(url)}`, { headers: { Accept: 'application/json' }, signal: timeoutSignal(TIMEOUT_MS) });
    const check: VerifyResult['installCheck'] = { reachable: true, status: res.status };
    const text = await res.text();
    try { check.body = JSON.parse(text); } catch { check.body = text.slice(0, 500); }
    if (res.ok) check.check = parseInstallCheck(check.body);
    return check;
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
}

export async function verify(url: string, opts: { api?: string; fetch?: FetchFn } = {}): Promise<VerifyResult> {
  const f = opts.fetch ?? fetch;
  const result: VerifyResult = {
    url, ok: false, script: false, stub: false, keyValid: false, keyless: false, integrations: [],
    installCheck: { reachable: false }, problems: [],
  };
  const html = await fetchPage(f, url, result);
  if (html === null) return result;
  inspectHtml(result, html);
  result.problems.push(...htmlProblems(result));
  result.installCheck = await installCheck(f, (opts.api ?? result.endpoint ?? DEFAULT_API).replace(/\/+$/, ''), url);
  result.ok = result.script && result.stub && (result.keyless || result.keyValid);
  return result;
}
