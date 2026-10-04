import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountPowPrefix } from '../src/account';
import { saveCredentials } from '../src/config';
import { cli, fixture, pkg, read } from './helpers';

/** The next queued reply; the last one repeats. */
const nextOf = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]);

type Handler = (req: { body: any; headers: Record<string, string>; url: URL }) => { status?: number; body?: unknown; headers?: Record<string, string> };

/** Fake API: routes keyed "METHOD /path"; records every call. */
function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, headers });
    const key = `${method} ${url.pathname}`;
    const r = routes[key];
    if (!r) return Response.json({ error: { code: 'not_found', message: `no route ${key}` } }, { status: 404 });
    const h = Array.isArray(r) ? nextOf(r) : r;
    const res = h({ body, headers, url });
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status ?? 200, headers: res.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const configEnv = () => ({ DOUBLEAGENT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'da-cfg-')) });
const zeroBits = (s: string) => {
  let bits = 0;
  for (const b of createHash('sha256').update(s).digest()) { if (b === 0) { bits += 8; continue; } return bits + Math.clz32(b) - 24; }
  return bits;
};
const loggedIn = () => {
  const env = configEnv();
  saveCredentials(env, { api: 'https://api.test', session: 'das_session', saved_at: 'now' });
  return env;
};
const ME = { user: { email: 'me@x.co' }, accounts: [{ id: 'acc_1', name: 'Acme', role: 'owner', sites: [{ id: 'st_1', name: 'Shop', status: 'pending', domains: [{ hostname: 'shop.example.com', verified_at: null }] }] }] };

const viteHtml = '<!doctype html>\n<html>\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>\n';

describe('init --email', () => {
  it('creates the account with a proof of work up front, installs its pk_live and reports the sk once', async () => {
    const api = fakeApi({
      'POST /v1/accounts': ({ body, headers }) => {
        // DA-PoW: <unix_seconds>:<solution>, SHA-256("da-accounts|<email>|<ts>|<solution>") ≥ 18 zero bits (API default).
        const [ts, solution] = headers['da-pow'].split(':');
        expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
        expect(solution).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(zeroBits(`da-accounts|${body.email}|${ts}|${solution}`)).toBeGreaterThanOrEqual(18);
        expect(accountPowPrefix(' Me@X.co ', ts)).toBe(`da-accounts|me@x.co|${ts}|`);
        return { status: 201, body: { account_id: 'acc_1', site_id: 'st_1', keys: { pk_test: 'pk_test_T', pk_live: 'pk_live_L', sk_test: 'sk_test_S' }, verify: { hostname: 'shop.example.com', token: 'tok123', methods: ['dns', 'meta', 'file', 'script'] }, login_url: 'https://app.test/login?t=x' } };
      },
    });
    const dir = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml });
    const r = await cli(['init', '--json', '--yes', '--cwd', dir, '--email', 'me@x.co', '--domain', 'shop.example.com', '--api', 'https://api.test'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([['POST', '/v1/accounts']]); // one request, no wasted 428
    expect(api.calls[0].body).toEqual({ email: 'me@x.co', domain: 'shop.example.com' });
    expect(read(dir, 'index.html')).toContain('data-key="pk_live_L"');
    expect(read(dir, 'index.html')).not.toContain('PENDING');
    expect(r.json).toEqual(expect.objectContaining({ keyless: false, key: 'pk_live_L', files_changed: ['index.html'] }));
    expect(r.json.account.keys.sk_test).toBe('sk_test_S');
    expect(r.json.next_steps.join('\n')).toContain('_doubleagent.shop.example.com "da-verify=tok123"');

    const human = await cli(['init', '--yes', '--cwd', fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml }), '--email', 'me@x.co', '--test', '--api', 'https://api.test'], { fetch: fakeApi({ 'POST /v1/accounts': () => ({ body: { account_id: 'acc_2', site_id: 'st_2', keys: { pk_test: 'pk_test_T', sk_test: 'sk_test_S' } } }) }).fetch });
    expect(human.out).toContain('installed pk_test_T');
    expect(human.out).toContain('Test secret key (shown once, server-side only, never in client code):\n  sk_test_S');
  });

  it('re-solves at the higher difficulty a 428 asks for, then retries once', async () => {
    const api = fakeApi({
      'POST /v1/accounts': [
        () => ({ status: 428, body: { error: { code: 'pow_required', difficulty: 19, format: '<unix_seconds>:<solution>' } } }),
        ({ body, headers }) => {
          const [ts, solution] = headers['da-pow'].split(':');
          expect(zeroBits(`da-accounts|${body.email}|${ts}|${solution}`)).toBeGreaterThanOrEqual(19);
          return { status: 201, body: { account_id: 'acc_1', site_id: 'st_1', keys: { pk_live: 'pk_live_L' } } };
        },
      ],
    });
    const r = await cli(['init', '--json', '--yes', '--cwd', fixture({ 'index.html': viteHtml }), '--email', 'me@x.co', '--api', 'https://api.test'], { fetch: api.fetch });
    expect(r.json.key).toBe('pk_live_L');
    expect(api.calls).toHaveLength(2);
  });

  it('dry run never creates an account', async () => {
    const api = fakeApi({});
    const dir = fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': viteHtml });
    const r = await cli(['init', '--json', '--dry-run', '--cwd', dir, '--email', 'me@x.co'], { fetch: api.fetch });
    expect(api.calls).toEqual([]);
    expect(r.json.warnings[0]).toMatch(/no account is created/);
    expect(r.json.diff).toContain('data-key="pk_live_PENDING"');
    expect(read(dir, 'index.html')).toBe(viteHtml);
  });

  it('surfaces API errors (rate limit) as JSON', async () => {
    const api = fakeApi({ 'POST /v1/accounts': () => ({ status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } }) });
    const r = await cli(['init', '--json', '--yes', '--cwd', fixture({ 'index.html': viteHtml }), '--email', 'me@x.co'], { fetch: api.fetch });
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ error: 'slow down', code: 'rate_limited', status: 429 });
  });
});

describe('login / logout', () => {
  it('device flow: shows the code, polls through pending and slow_down, saves a 0600 session', async () => {
    const env = configEnv();
    const sleeps: number[] = [];
    const api = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'dad_1', user_code: 'WXYZ-1234', verify_url: 'https://app.test/device', interval: 5, expires_in: 600 } }),
      'POST /v1/auth/device/token': [
        () => ({ status: 428, body: { error: { code: 'authorization_pending' } } }),
        () => ({ status: 429, body: { error: { code: 'slow_down' } } }),
        () => ({ body: { session: 'das_new' } }),
      ],
      'GET /v1/me': ({ headers }) => ({ body: headers.authorization === 'Bearer das_new' ? ME : {} }),
    });
    const r = await cli(['login', '--api', 'https://api.test'], { env, fetch: api.fetch, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Open https://app.test/device and confirm the code WXYZ-1234');
    expect(r.out).toContain('Logged in as me@x.co');
    expect(sleeps).toEqual([5000, 5000, 10000]);
    const path = join(env.DOUBLEAGENT_CONFIG_DIR, 'credentials.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expect.objectContaining({ api: 'https://api.test', session: 'das_new', email: 'me@x.co' }));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const out = await cli(['logout'], { env, fetch: api.fetch });
    expect(out.out).toContain('Logged out.');
    expect(() => statSync(path)).toThrow();
  });

  it('fails clearly when the code expires', async () => {
    const api = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'dad_1', user_code: 'A', verify_url: 'https://app.test/device', interval: 1 } }),
      'POST /v1/auth/device/token': () => ({ status: 410, body: { error: { code: 'expired' } } }),
    });
    const r = await cli(['login'], { env: configEnv(), fetch: api.fetch, sleep: async () => {} });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired/);
  });
});

describe('sites / keys / verify-domain', () => {
  it('require login', async () => {
    const r = await cli(['sites'], { env: configEnv() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/npx @doubleagent-so\/cli login/);
  });

  it('sites lists accounts and sites with the saved session', async () => {
    const api = fakeApi({ 'GET /v1/me': () => ({ body: ME }) });
    const r = await cli(['sites'], { env: loggedIn(), fetch: api.fetch });
    expect(api.calls[0].headers.authorization).toBe('Bearer das_session');
    expect(api.calls[0].path).toBe('/v1/me');
    expect(r.out).toContain('Acme (acc_1, owner)');
    expect(r.out).toContain('st_1  pending     Shop  shop.example.com');
  });

  it('keys list / create sk (shown once) / rotate / revoke, resolving the only site', async () => {
    const api = fakeApi({
      'GET /v1/me': () => ({ body: ME }),
      'GET /v1/sites/st_1/keys': () => ({ body: { keys: [{ id: 'key_a', kind: 'pk', env: 'live', public_key: 'pk_live_A', created_at: 't' }, { id: 'key_b', kind: 'sk', env: 'live', prefix: 'sk_live_Ab12', revoked_at: 't2' }] } }),
      'POST /v1/sites/st_1/keys': ({ body }) => ({ body: { key: { id: 'key_c', kind: body.kind, env: body.env, prefix: 'sk_live_Zz', secret: 'sk_live_SECRET' } } }),
      'POST /v1/sites/st_1/keys/key_a/rotate': () => ({ body: { key: { id: 'key_d', kind: 'pk', env: 'live', public_key: 'pk_live_NEW' } } }),
      'DELETE /v1/sites/st_1/keys/key_b': () => ({ status: 204 }),
    });
    const env = loggedIn();
    const list = await cli(['keys'], { env, fetch: api.fetch });
    expect(list.out).toContain('key_a  pk_live  pk_live_A  active');
    expect(list.out).toContain('key_b  sk_live  sk_live_Ab12  revoked');
    const created = await cli(['keys', 'create', '--kind', 'sk', '--env', 'live'], { env, fetch: api.fetch });
    expect(created.out).toContain('Secret key (shown once, store it server-side only, never in client code):\n  sk_live_SECRET');
    const rotated = await cli(['keys', 'rotate', 'key_a', '--site', 'st_1', '--json'], { env, fetch: api.fetch });
    expect(rotated.json).toEqual(expect.objectContaining({ site: 'st_1', key: expect.objectContaining({ public_key: 'pk_live_NEW' }) }));
    const revoked = await cli(['keys', 'revoke', 'key_b', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(revoked.out).toContain('Revoked key_b.');
    expect(api.calls.filter((c) => c.path === '/v1/me')).toHaveLength(2); // --site skips the lookup
    const bad = await cli(['keys', 'create', '--kind', 'xx', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(bad.err).toMatch(/--kind must be/);
  });

  it('asks for --site when there are several', async () => {
    const two = { accounts: [{ id: 'acc_1', sites: [{ id: 'st_1' }, { id: 'st_2' }] }] };
    const r = await cli(['keys'], { env: loggedIn(), fetch: fakeApi({ 'GET /v1/me': () => ({ body: two }) }).fetch });
    expect(r.err).toMatch(/several sites: pass --site \(st_1, st_2\)/);
  });

  it('verify-domain adds the domain, verifies, and reports claimed sessions', async () => {
    const api = fakeApi({
      'POST /v1/sites/st_1/domains': ({ body }) => ({ body: { hostname: body.hostname, token: 'tok9', methods: ['dns', 'meta', 'file', 'script'] } }),
      'POST /v1/sites/st_1/domains/shop.example.com/verify': [
        () => ({ body: { verified: false, detail: 'TXT record not found' } }),
        () => ({ body: { verified: true, claimed: { sessions: 42 } } }),
      ],
    });
    const env = loggedIn();
    const miss = await cli(['verify-domain', 'https://Shop.Example.com/', '--method', 'dns', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(miss.code).toBe(1);
    expect(miss.out).toContain('Not verified yet: TXT record not found.');
    expect(miss.out).toContain('_doubleagent.shop.example.com  "da-verify=tok9"');
    expect(api.calls[1].body).toEqual({ method: 'dns' });
    const hit = await cli(['verify-domain', 'shop.example.com', '--method', 'meta', '--site', 'st_1', '--json'], { env, fetch: api.fetch });
    expect(hit.code).toBe(0);
    expect(hit.json).toEqual(expect.objectContaining({ verified: true, claimed: { sessions: 42 }, method: 'meta' }));
  });

  it('verify-domain prints the API-provided instructions for the chosen method', async () => {
    const instructions = {
      dns: { type: 'TXT', name: '_doubleagent.b.example', value: 'da-verify=srv' },
      meta: { html: '<meta name="doubleagent-verification" content="srv">' },
      file: { url: 'https://b.example/.well-known/doubleagent.txt', body: 'da-verify=srv' },
      script: { html: '<script async src="https://cdn.doubleagent.so/v1/doubleagent.js" data-key="pk_live_X"></script>' },
    };
    const api = fakeApi({
      'POST /v1/sites/st_1/domains': () => ({ body: { hostname: 'b.example', token: 'srv', methods: ['dns', 'meta', 'file', 'script'], instructions } }),
      'POST /v1/sites/st_1/domains/b.example/verify': () => ({ body: { verified: false, detail: 'not found' } }),
    });
    const env = loggedIn();
    const out = async (m: string) => (await cli(['verify-domain', 'b.example', '--method', m, '--site', 'st_1'], { env, fetch: api.fetch })).out;
    expect(await out('dns')).toContain('Add a DNS TXT record: _doubleagent.b.example  "da-verify=srv"');
    expect(await out('meta')).toContain('Add to the <head> of https://b.example/: <meta name="doubleagent-verification" content="srv">');
    expect(await out('file')).toContain('Serve https://b.example/.well-known/doubleagent.txt containing: da-verify=srv');
    expect(await out('script')).toContain('data-key="pk_live_X"');
  });

  it('verify-domain tolerates an already-added domain (409) and rejects unknown methods', async () => {
    const api = fakeApi({
      'POST /v1/sites/st_1/domains': () => ({ status: 409, body: { error: { code: 'domain_exists' } } }),
      'POST /v1/sites/st_1/domains/a.example/verify': () => ({ body: { verified: true } }),
    });
    const env = loggedIn();
    expect((await cli(['verify-domain', 'a.example', '--method', 'script', '--site', 'st_1'], { env, fetch: api.fetch })).out).toContain('Verified a.example (script).');
    expect((await cli(['verify-domain', 'a.example', '--method', 'carrier-pigeon', '--site', 'st_1'], { env, fetch: api.fetch })).err).toMatch(/--method must be/);
  });
});
