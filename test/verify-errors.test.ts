import { describe, expect, it } from 'vitest';
import { parseInstallCheck, verify } from '../src/verify';
import { CDN_URL, STUB } from '../src/snippet';
import { cli } from './helpers';

const page = `<html><head><script>${STUB}</script><script async src="${CDN_URL}" data-key="pk_live_abc"></script></head></html>`;
const f = (pageRes: () => Response | Promise<Response>, api: () => Response | Promise<Response>) =>
  (async (u: string) => (String(u).includes('/v1/install-check') ? api() : pageRes())) as unknown as typeof fetch;

describe('verify error matrix', () => {
  it('page fetch failure short-circuits (no install check call)', async () => {
    let apiCalls = 0;
    const r = await verify('https://down.example', { fetch: f(() => { throw new TypeError('ENOTFOUND'); }, () => { apiCalls++; return Response.json({}); }) });
    expect(r).toEqual(expect.objectContaining({ ok: false, script: false }));
    expect(r.problems).toEqual(['could not fetch https://down.example: ENOTFOUND']);
    expect(apiCalls).toBe(0);
  });

  it('non-200 page is reported but still inspected', async () => {
    const r = await verify('https://x.example', { fetch: f(() => new Response(page, { status: 503 }), () => Response.json({})) });
    expect(r.status).toBe(503);
    expect(r.problems[0]).toBe('GET https://x.example returned 503');
    expect(r.script).toBe(true);
  });

  it('install-check 5xx with text body, non-JSON 200, and --api override', async () => {
    const r = await verify('https://x.example', { api: 'https://api.test/', fetch: f(() => new Response(page), () => new Response('upstream error', { status: 502 })) });
    expect(r.installCheck).toEqual({ reachable: true, status: 502, body: 'upstream error' });
    expect(r.ok).toBe(true); // local checks drive the exit code
    const human = await cli(['verify', 'https://x.example'], { fetch: f(() => new Response(page), () => new Response('upstream error', { status: 502 })) });
    expect(human.out).toContain('install check (502): upstream error');
    const obj = await cli(['verify', 'https://x.example'], { fetch: f(() => new Response(page), () => Response.json([1], { status: 500 })) });
    expect(obj.out).toContain('install check (500): [1]');
  });

  it('malformed key, missing URL scheme, integrations listed', async () => {
    const bad = page.replace('pk_live_abc', 'pk_live_has-dash');
    const r = await cli(['verify', 'https://x.example', '--json'], { fetch: f(() => new Response(bad), () => Response.json({})) });
    expect(r.code).toBe(1);
    expect(r.json.problems).toContain('data-key "pk_live_has-dash" is not a pk_live_/pk_test_ key');
    expect((await cli(['verify', 'x.example'])).err).toMatch(/needs an http\(s\) URL/);
    const withGa = page.replace('</head>', '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head>');
    expect((await cli(['verify', 'https://x.example'], { fetch: f(() => new Response(withGa), () => Response.json({})) })).out).toContain('integrations on page: ga4');
  });

  it('parseInstallCheck tolerates non-objects and wrong types', () => {
    expect(parseInstallCheck(null)).toBeUndefined();
    expect(parseInstallCheck([1])).toBeUndefined();
    expect(parseInstallCheck('x')).toBeUndefined();
    expect(parseInstallCheck({ ok: 'yes', key: 5, integrations_detected: 'ga4', problems: 'none', last_beacon_at: 7 })).toEqual({
      ok: undefined, script_found: undefined, script_src: undefined, key: undefined, key_valid: undefined, profile_attr: undefined,
      stub_before_script: undefined, keyless: undefined, claim_url: undefined, integrations_detected: undefined, last_beacon_at: undefined, problems: undefined,
    });
    expect(parseInstallCheck({ problems: [{ code: 1, message: 'm', fix: null }] })!.problems).toEqual([{ code: undefined, message: 'm', fix: undefined }]);
  });

  it('human install-check rendering covers every field', async () => {
    const body = { ok: true, script_found: false, key: 'pk_live_abc', profile_attr: 'auto', integrations_detected: [], last_beacon_at: '2026-09-24T10:00:00Z', problems: [{ fix: 'do x' }] };
    const r = await cli(['verify', 'https://x.example'], { fetch: f(() => new Response(page), () => Response.json(body)) });
    expect(r.out).toContain('install check: ok');
    expect(r.out).toContain('script found: no');
    expect(r.out).toContain('key: pk_live_abc (valid: ?)');
    expect(r.out).toContain('data-profile: auto');
    expect(r.out).toContain('last beacon: 2026-09-24T10:00:00Z');
    expect(r.out).toContain('problem: unknown\n         fix: do x');
  });
});
