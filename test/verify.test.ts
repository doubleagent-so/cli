import { describe, expect, it, vi } from 'vitest';
import { CDN_URL, STUB } from '../src/snippet';
import { cli } from './helpers';

const page = (head: string) => `<html><head>${head}<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head><body></body></html>`;

const fetchFor = (html: string, api: { status: number; body: unknown } | Error) => vi.fn(async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('/v1/install-check')) {
    if (api instanceof Error) throw api;
    return new Response(JSON.stringify(api.body), { status: api.status });
  }
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
}) as unknown as typeof fetch;

describe('verify', () => {
  it('passes for a correct install and reports the install check', async () => {
    const f = fetchFor(page(`<script>${STUB}</script><script async src="${CDN_URL}" data-key="pk_live_abc"></script>`), { status: 200, body: { installed: true, lastSeen: '2026-09-23' } });
    const r = await cli(['verify', 'https://shop.example/', '--json'], { fetch: f });
    expect(r.code).toBe(0);
    expect(r.json).toEqual(expect.objectContaining({ ok: true, script: true, stub: true, key: 'pk_live_abc', keyValid: true, integrations: ['ga4'] }));
    expect(r.json.installCheck).toEqual(expect.objectContaining({ reachable: true, status: 200, body: { installed: true, lastSeen: '2026-09-23' } }));
    expect(String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0])).toBe('https://api.doubleagent.so/v1/install-check?url=https%3A%2F%2Fshop.example%2F');
  });

  it('uses data-endpoint for the install check and reads next/script serialised props', async () => {
    const html = page(`<script>self.__next_s=self.__next_s||[];self.__next_s.push([0,{"children":"${STUB}","id":"doubleagent-stub"}]);self.__next_s.push(["${CDN_URL}",{"data-key":"pk_test_x1","data-endpoint":"https://api.example.test/"}])</script>`);
    const f = fetchFor(html, { status: 404, body: 'nope' });
    const r = await cli(['verify', 'https://x.example', '--json'], { fetch: f });
    expect(r.json.ok).toBe(true);
    expect(r.json.key).toBe('pk_test_x1');
    expect(String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0])).toMatch(/^https:\/\/api\.example\.test\/v1\/install-check/);
    const human = await cli(['verify', 'https://x.example'], { fetch: f });
    expect(human.out).toContain('install check: not available on this API yet');
  });

  it('fails without the tag, with the placeholder key, or without the stub', async () => {
    const down = new Error('ECONNREFUSED');
    const none = await cli(['verify', 'https://a.example', '--json'], { fetch: fetchFor(page(''), down) });
    expect(none.code).toBe(1);
    expect(none.json.problems[0]).toMatch(/not found/);
    expect(none.json.installCheck).toEqual({ reachable: false, error: 'ECONNREFUSED' });

    const ph = await cli(['verify', 'https://a.example', '--json'], { fetch: fetchFor(page(`<script>${STUB}</script><script src="${CDN_URL}" data-key="pk_test_REPLACE_ME"></script>`), down) });
    expect(ph.json.ok).toBe(false);
    expect(ph.json.problems.join(' ')).toMatch(/placeholder/);

    const nostub = await cli(['verify', 'https://a.example'], { fetch: fetchFor(page(`<script src="${CDN_URL}" data-key="pk_live_1"></script>`), down) });
    expect(nostub.code).toBe(1);
    expect(nostub.err).toMatch(/queue stub missing/);
  });

  it('renders install-check problems with fixes, tolerating missing and mistyped fields', async () => {
    const body = {
      ok: false, script_found: true, script_src: CDN_URL, key: 'pk_live_abc', key_valid: true, stub_before_script: false,
      integrations_detected: ['ga4', 7], last_beacon_at: null,
      problems: [{ code: 'stub_after_script', message: 'Queue stub comes after the SDK tag', fix: 'Move the stub <script> above the SDK tag.' }, 'raw problem', { code: 'no_beacon' }],
    };
    const f = fetchFor(page(`<script>${STUB}</script><script async src="${CDN_URL}" data-key="pk_live_abc"></script>`), { status: 200, body });
    const human = await cli(['verify', 'https://a.example'], { fetch: f });
    expect(human.out).toContain('install check: NOT ok');
    expect(human.out).toContain('stub before script: no');
    expect(human.out).toContain('integrations: ga4\n');
    expect(human.out).toContain('last beacon: never');
    expect(human.out).toContain('problem: Queue stub comes after the SDK tag [stub_after_script]\n         fix: Move the stub <script> above the SDK tag.');
    expect(human.out).toContain('problem: raw problem');
    expect(human.out).toContain('problem: no_beacon');
    const json = await cli(['verify', 'https://a.example', '--json'], { fetch: f });
    expect(json.json.installCheck.body).toEqual(body); // passed through untouched
    expect(json.json.installCheck.check.problems[0].fix).toMatch(/Move the stub/);

    const sparse = await cli(['verify', 'https://a.example'], { fetch: fetchFor(page(''), { status: 200, body: {} }) });
    expect(sparse.out).toContain('install check: no verdict');
  });

  it('accepts a keyless install and shows the claim URL from the install check', async () => {
    const f = fetchFor(page(`<script>${STUB}</script><script async src="${CDN_URL}"></script>`), { status: 200, body: { ok: true, script_found: true, keyless: true, claim_url: 'https://app.doubleagent.so/claim?domain=a.example' } });
    const r = await cli(['verify', 'https://a.example', '--json'], { fetch: f });
    expect(r.code).toBe(0);
    expect(r.json).toEqual(expect.objectContaining({ ok: true, keyless: true }));
    expect(r.json.key).toBeUndefined();
    const human = await cli(['verify', 'https://a.example'], { fetch: f });
    expect(human.out).toContain('ok   keyless install');
    expect(human.out).toContain('keyless: yes (claim at https://app.doubleagent.so/claim?domain=a.example)');
  });

  it('rejects a missing URL', async () => {
    const r = await cli(['verify']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/needs an http/);
  });
});
