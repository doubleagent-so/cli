import { afterEach, describe, expect, it, vi } from 'vitest';
import { cli, fakeApi, fixture, loggedIn, networkDown, pkg } from './helpers';

const ME = { accounts: [{ id: 'acc_1', sites: [{ id: 'st_1' }] }] };
const err = (status: number, code: string, message = `${code}!`) => () => ({ status, body: { error: { code, message } } });
const html = '<html><head><title>x</title></head><body></body></html>';

afterEach(() => vi.restoreAllMocks());

/** Every API-backed command, with the route that should fail. */
const COMMANDS: { name: string; args: string[]; route: string; authed: boolean; extra?: Record<string, () => { body: unknown }> }[] = [
  { name: 'login', args: ['login'], route: 'POST /v1/auth/device', authed: false },
  { name: 'sites', args: ['sites'], route: 'GET /v1/me', authed: true },
  { name: 'keys list', args: ['keys', 'list', '--site', 'st_1'], route: 'GET /v1/sites/st_1/keys', authed: true },
  { name: 'keys create', args: ['keys', 'create', '--site', 'st_1', '--kind', 'sk', '--env', 'test'], route: 'POST /v1/sites/st_1/keys', authed: true },
  { name: 'keys rotate', args: ['keys', 'rotate', 'key_1', '--site', 'st_1'], route: 'POST /v1/sites/st_1/keys/key_1/rotate', authed: true },
  { name: 'keys revoke', args: ['keys', 'revoke', 'key_1', '--site', 'st_1'], route: 'DELETE /v1/sites/st_1/keys/key_1', authed: true },
  { name: 'keys (site lookup)', args: ['keys'], route: 'GET /v1/me', authed: true },
  { name: 'verify-domain add', args: ['verify-domain', 'a.example', '--site', 'st_1'], route: 'POST /v1/sites/st_1/domains', authed: true },
  { name: 'verify-domain verify', args: ['verify-domain', 'a.example', '--site', 'st_1'], route: 'POST /v1/sites/st_1/domains/a.example/verify', authed: true, extra: { 'POST /v1/sites/st_1/domains': () => ({ body: { token: 't' } }) } },
];

describe('API error matrix (every command × 401/403/429/5xx/network)', () => {
  for (const c of COMMANDS) {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'internal'], [503, 'unavailable']] as const) {
      it(`${c.name} → ${status}`, async () => {
        const api = fakeApi({ ...c.extra, [c.route]: err(status, code) });
        const env = c.authed ? { env: loggedIn() } : {};
        const human = await cli(c.args, { ...env, fetch: api.fetch });
        expect(human.code).toBe(1);
        expect(human.err).toContain(`error: ${code}!`);
        const j = await cli([...c.args, '--json'], { ...env, fetch: api.fetch });
        expect(j.json).toEqual({ error: `${code}!`, code, status });
      });
    }
    it(`${c.name} → network down`, async () => {
      const r = await cli([...c.args, '--json'], { ...(c.authed ? { env: loggedIn() } : {}), fetch: networkDown });
      expect(r.code).toBe(1);
      expect(r.json).toEqual({ error: expect.stringMatching(/^cannot reach https:\/\/api\.(test|doubleagent\.so): fetch failed$/), code: 'network', status: 0 });
    });
  }

  it('init --email: 403, 409, 5xx and network, with nothing written', async () => {
    for (const [status, code] of [[403, 'email_blocked'], [409, 'email_exists'], [500, 'internal']] as const) {
      const dir = fixture({ 'index.html': html });
      const r = await cli(['init', '--json', '--yes', '--cwd', dir, '--email', 'a@b.co'], { fetch: fakeApi({ 'POST /v1/accounts': err(status, code) }).fetch });
      expect(r.json).toEqual({ error: `${code}!`, code, status });
      expect((await import('node:fs')).readFileSync(`${dir}/index.html`, 'utf8')).toBe(html);
    }
    const r = await cli(['init', '--json', '--yes', '--cwd', fixture({ 'index.html': html }), '--email', 'a@b.co'], { fetch: networkDown });
    expect(r.json.code).toBe('network');
  }, 30_000); // four real 18-bit proof-of-work solves: ~10 s on a CI runner

  it('non-JSON error bodies and string error codes still produce a message', async () => {
    const env = loggedIn();
    const raw = await cli(['sites', '--json'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ status: 502, raw: '<html>Bad gateway</html>' }) }).fetch });
    expect(raw.json).toEqual({ error: 'GET /v1/me → 502', code: 'http_502', status: 502 });
    const str = await cli(['sites', '--json'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ status: 403, body: { error: 'site_not_verified' } }) }).fetch });
    expect(str.json).toEqual({ error: 'GET /v1/me → 403 site_not_verified', code: 'site_not_verified', status: 403 });
  });

  it('login: 428 pending forever times out; 5xx while polling fails; malformed start/token responses', async () => {
    let t = 0;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      const api = fakeApi({
        'POST /v1/auth/device': () => ({ body: { device_code: 'd', user_code: 'U', verify_url: 'https://v', interval: 5, expires_in: 12 } }),
        'POST /v1/auth/device/token': () => ({ status: 428, body: { error: { code: 'authorization_pending' } } }),
      });
      const r = await cli(['login'], { fetch: api.fetch, sleep: async (ms) => { t += ms; } });
      expect(r.err).toMatch(/timed out waiting for approval/);
    } finally { Date.now = realNow; }

    const five = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'd', user_code: 'U', verify_url: 'https://v', interval: 0 } }),
      'POST /v1/auth/device/token': err(500, 'internal'),
    });
    expect((await cli(['login'], { fetch: five.fetch, sleep: async () => {} })).err).toContain('error: internal!');

    const bad = fakeApi({ 'POST /v1/auth/device': () => ({ body: { user_code: 'U' } }) });
    expect((await cli(['login'], { fetch: bad.fetch })).err).toMatch(/unexpected \/v1\/auth\/device response/);

    const noSession = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'd', user_code: 'U', verify_url: 'https://v' } }),
      'POST /v1/auth/device/token': () => ({ body: {} }),
    });
    expect((await cli(['login'], { fetch: noSession.fetch, sleep: async () => {} })).err).toMatch(/unexpected \/v1\/auth\/device\/token response/);
  });

  it('login --json reports the code on stderr and the result on stdout; /v1/me failure is tolerated', async () => {
    const api = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'd', user_code: 'U-1', verify_url: 'https://v' } }),
      'POST /v1/auth/device/token': () => ({ body: { session: 'das_x' } }),
      'GET /v1/me': err(500, 'internal'),
    });
    const r = await cli(['login', '--json'], { fetch: api.fetch, sleep: async () => {} });
    expect(JSON.parse(r.err)).toEqual({ verify_url: 'https://v', user_code: 'U-1' });
    expect(r.json).toEqual(expect.objectContaining({ ok: true, email: null }));
    const withUser = fakeApi({
      'POST /v1/auth/device': () => ({ body: { device_code: 'd', user_code: 'U', verify_url: 'https://v' } }),
      'POST /v1/auth/device/token': () => ({ body: { session: 'das_x', user: { email: 'u@x.co' } } }),
    });
    expect((await cli(['login'], { fetch: withUser.fetch, sleep: async () => {} })).out).toContain('Logged in as u@x.co');
  });

  it('logout: API failure still deletes local credentials; not logged in; --json; --all', async () => {
    const env = loggedIn();
    const api = fakeApi({ 'POST /v1/auth/logout': err(500, 'internal') });
    expect((await cli(['logout', '--all', '--json'], { env, fetch: api.fetch })).json).toEqual({ ok: true });
    expect(api.calls[0].body).toEqual({ all: true });
    expect((await cli(['logout'], { env, fetch: api.fetch })).out).toContain('Not logged in.');
  });
});

describe('command argument errors', () => {
  it('keys: missing id, unknown subcommand, bad env, no sites, create defaults to pk live', async () => {
    const env = loggedIn();
    const api = fakeApi({ 'GET /v1/me': () => ({ body: ME }), 'POST /v1/sites/st_1/keys': ({ body }) => ({ body }) });
    expect((await cli(['keys', 'rotate'], { env, fetch: api.fetch })).err).toMatch(/usage: npx @doubleagent-so\/cli keys rotate <key_id>/);
    expect((await cli(['keys', 'revoke', '--site', 'st_1'], { env, fetch: api.fetch })).err).toMatch(/usage/);
    expect((await cli(['keys', 'frob', '--site', 'st_1'], { env, fetch: api.fetch })).err).toMatch(/unknown keys command "frob"/);
    expect((await cli(['keys', 'create', '--env', 'prod', '--site', 'st_1'], { env, fetch: api.fetch })).err).toMatch(/--env live\|test/);
    const created = await cli(['keys', 'create', '--site', 'st_1', '--json'], { env, fetch: api.fetch });
    expect(created.json).toEqual({ site: 'st_1', kind: 'pk', env: 'live' });
    const none = await cli(['keys'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ body: { accounts: [{ id: 'a' }] } }) }).fetch });
    expect(none.err).toMatch(/no sites/);
    const noAccounts = await cli(['keys'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ body: {} }) }).fetch });
    expect(noAccounts.err).toMatch(/no sites/);
  });

  it('keys output shapes: bare arrays, flat rows, expiring keys, revoke with 204', async () => {
    const env = loggedIn();
    const api = fakeApi({
      'GET /v1/sites/st_1/keys': () => ({ body: [{ id: 'k1', kind: 'sk', env: 'test', prefix: 'sk_test_ab', expires_at: '2026-09-25', last_used_at: '2026-09-24' }, { id: 'k2' }] }),
      'POST /v1/sites/st_1/keys/k1/rotate': () => ({ body: { id: 'k3', kind: 'sk', env: 'test', key: 'sk_test_NEWSECRET' } }),
      'POST /v1/sites/st_1/keys': () => ({ body: { id: 'k4', kind: 'pk', env: 'test', key: 'pk_test_notsecret' } }),
      'DELETE /v1/sites/st_1/keys/k2': () => ({ status: 204 }),
    });
    const list = await cli(['keys', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(list.out).toContain('k1  sk_test  sk_test_ab  expires 2026-09-25  last used 2026-09-24');
    expect(list.out).toContain('k2  ?_?    active');
    const listJson = await cli(['keys', '--site', 'st_1', '--json'], { env, fetch: api.fetch });
    expect(listJson.json.keys).toHaveLength(2);
    const rot = await cli(['keys', 'rotate', 'k1', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(rot.out).toContain('Rotated. The old key keeps working for 24 h.');
    expect(rot.out).toContain('sk_test_NEWSECRET');
    const pk = await cli(['keys', 'create', '--site', 'st_1'], { env, fetch: api.fetch });
    expect(pk.out).not.toContain('Secret key');
    const rev = await cli(['keys', 'revoke', 'k2', '--site', 'st_1', '--json'], { env, fetch: api.fetch });
    expect(rev.json).toEqual({ site: 'st_1', revoked: 'k2' });
  });

  it('sites: no accounts, account without sites, bare-string domains, --json', async () => {
    const env = loggedIn();
    expect((await cli(['sites'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ body: { accounts: [] } }) }).fetch })).out).toMatch(/No accounts yet/);
    const r = await cli(['sites'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ body: { accounts: [{ id: 'acc_1', sites: [] }, { id: 'acc_2', name: 'B', sites: [{ id: 'st_9', domains: ['b.example'] }] }] } }) }).fetch });
    expect(r.out).toContain('acc_1 (acc_1)\n  (no sites)');
    expect(r.out).toContain('st_9  ?             b.example');
    expect((await cli(['sites', '--json'], { env, fetch: fakeApi({ 'GET /v1/me': () => ({ body: ME }) }).fetch })).json).toEqual(ME);
  });

  it('verify-domain: bad host, default method dns, 409 carrying the domain, every method prints instructions', async () => {
    const env = loggedIn();
    expect((await cli(['verify-domain'], { env })).err).toMatch(/usage: npx @doubleagent-so\/cli verify-domain/);
    expect((await cli(['verify-domain', 'not a host!'], { env })).err).toMatch(/usage/);
    for (const [method, needle] of [['dns', '_doubleagent.a.example  "da-verify=tk"'], ['meta', '<meta name="doubleagent-verification" content="tk">'], ['file', 'https://a.example/.well-known/doubleagent.txt containing: da-verify=tk'], ['script', 'Deploy the SDK tag']] as const) {
      const api = fakeApi({
        'POST /v1/sites/st_1/domains': () => ({ status: 409, body: { error: { code: 'domain_exists' }, domain: { token: 'tk' } } }),
        'POST /v1/sites/st_1/domains/a.example/verify': () => ({ body: { verified: false } }),
      });
      const args = ['verify-domain', 'a.example', '--site', 'st_1'];
      if (method !== 'dns') args.push('--method', method);
      const r = await cli(args, { env, fetch: api.fetch });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Not verified yet.');
      expect(r.out).toContain(needle);
      expect(r.out).toContain(`--method ${method} --site st_1`);
      expect(api.calls[1].body).toEqual({ method });
    }
    // JSON without token: instructions fall back to the server's, and exit 1.
    const j = await cli(['verify-domain', 'a.example', '--json'], { env, fetch: fakeApi({
      'GET /v1/me': () => ({ body: ME }),
      'POST /v1/sites/st_1/domains': () => ({ body: { instructions: 'server says' } }),
      'POST /v1/sites/st_1/domains/a.example/verify': () => ({ body: {} }),
    }).fetch });
    expect(j.code).toBe(1);
    expect(j.json).toEqual(expect.objectContaining({ site: 'st_1', verified: false, token: null, instructions: 'server says', detail: null, claimed: null }));
    // Verified without claimed sessions.
    const ok = await cli(['verify-domain', 'a.example', '--site', 'st_1'], { env, fetch: fakeApi({
      'POST /v1/sites/st_1/domains': () => ({ body: {} }),
      'POST /v1/sites/st_1/domains/a.example/verify': () => ({ body: { verified: true, claimed: { sessions: 0 } } }),
    }).fetch });
    expect(ok.out).toBe('Verified a.example (dns).\n');
  });

  it('init --email: invalid email, account without keys, PoW without challenge, PoW too hard, body challenge', async () => {
    // These cases test API errors and retries, not variable hash-search time. This timestamp
    // has a real 18-bit proof at nonce 102; contract.test.ts checks live proof verification.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_904_000);
    const dir = () => fixture({ 'package.json': pkg({ vite: '6' }), 'index.html': html });
    expect((await cli(['init', '--json', '--cwd', dir(), '--email', 'nope'])).json.error).toMatch(/not an email address/);
    const noKey = fakeApi({ 'POST /v1/accounts': () => ({ body: { account_id: 'a', site_id: 's', keys: {} } }) });
    expect((await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co'], { fetch: noKey.fetch })).json.error).toMatch(/returned no public key/);
    const noChallenge = fakeApi({ 'POST /v1/accounts': err(428, 'pow_required') });
    expect((await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co'], { fetch: noChallenge.fetch })).json.error).toMatch(/rejected the proof of work and sent no difficulty/);
    const tooHard = fakeApi({ 'POST /v1/accounts': () => ({ status: 428, body: { error: { code: 'pow_required', difficulty: 40 } } }) });
    expect((await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co'], { fetch: tooHard.fetch })).json.error).toMatch(/difficulty 40 is too high/);
    const body = fakeApi({ 'POST /v1/accounts': [
      () => ({ status: 403, body: { error: { code: 'pow_required', difficulty: 18 } } }),
      ({ headers }) => ({ body: { account_id: 'a', site_id: 's', keys: { pk_live: 'pk_live_B' }, _pow: headers['da-pow'] } }),
    ] });
    const r = await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co'], { fetch: body.fetch });
    expect(r.json.key).toBe('pk_live_B');
    expect(body.calls[1].headers['da-pow']).toMatch(/^\d{10}:\d+$/);
    const twice = fakeApi({ 'POST /v1/accounts': () => ({ status: 428, body: { error: { code: 'pow_required', difficulty: 18 } } }) });
    expect((await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co'], { fetch: twice.fetch })).json.code).toBe('pow_required');
    expect(twice.calls).toHaveLength(2); // retries once only
    // Falls back to pk_test when pk_live is absent; --name is forwarded.
    const testOnly = fakeApi({ 'POST /v1/accounts': ({ body: b }) => ({ body: { account_id: 'a', site_id: 's', keys: { pk_test: 'pk_test_Z' }, echo: b } }) });
    const t = await cli(['init', '--json', '--yes', '--cwd', dir(), '--email', 'a@b.co', '--name', 'Shop'], { fetch: testOnly.fetch });
    expect(t.json.key).toBe('pk_test_Z');
    expect(testOnly.calls[0].body).toEqual({ email: 'a@b.co', name: 'Shop' });
  });

  it('init --email on a Shopify theme creates the account without editing files', async () => {
    const api = fakeApi({ 'POST /v1/accounts': () => ({ body: { account_id: 'a', site_id: 's', keys: { pk_live: 'pk_live_S' } } }) });
    const r = await cli(['init', '--json', '--cwd', fixture({ 'layout/theme.liquid': '<html></html>' }), '--email', 'a@b.co'], { fetch: api.fetch });
    expect(r.json).toEqual(expect.objectContaining({ status: 'advice', files_changed: [], key: 'pk_live_S' }));
    expect(api.calls).toHaveLength(1);
  });

  it('interactive decline with --email creates no account', async () => {
    const api = fakeApi({});
    const r = await cli(['init', '--cwd', fixture({ 'index.html': html }), '--email', 'a@b.co'], { fetch: api.fetch, confirm: async (q) => { expect(q).toMatch(/and create an account for a@b\.co/); return false; } });
    expect(r.code).toBe(1);
    expect(api.calls).toEqual([]);
  });
});
