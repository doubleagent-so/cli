import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { siteOptions, siteFixture, siteCommand, shellArg } from '../src/simulation/options';
import { cleanTarget, runSiteSimulation, telemetryRequest } from '../src/simulation/run';
import { simulationProbeBuildOptions } from '../scripts/build-options.mjs';
import { cli } from './helpers';
import { signer } from './identity/signer';

describe('simulation command contract', () => {
  it('defaults to behavioral observation with reporting off; marker evidence is explicit', () => {
    const options = siteOptions({ url: 'https://example.test/path#anchor', scenario: 'agent' });
    expect(options).toMatchObject({ evidence: 'behavior', report: false, pause: 2200, scroll: 0 });
    expect(siteFixture(options)).toBeUndefined();
    expect(siteFixture({ ...options, evidence: 'marker' })?.reason).toBe('marker.browser_use');
    expect(siteCommand(options)).toContain('--evidence behavior');
    expect(siteCommand(options)).toMatch(/^npx @doubleagent-so\/cli simulate --url /);
    expect(siteCommand(options, 'node dist/doubleagent.mjs simulate')).toMatch(/^node dist\/doubleagent\.mjs simulate --url /);
    expect(shellArg("'$(whoami)`x`")).toBe("''\"'\"'$(whoami)`x`'");
    expect(cleanTarget('https://example.test/path?secret=1#hash')).toBe('https://example.test/path');
  });
  it.each([
    { url: 'file:///etc/passwd' }, { url: 'https://user:pass@example.test' }, { duration: 121 },
    { pause: 0 }, { delay: 20000 }, { report: 'true' }, { evidence: 'hidden' },
    { scenario: 'human' }, { userAgent: 'hello\nworld' }, { agent: 'made-up' },
  ])('rejects invalid options: %j', (override) => {
    expect(() => siteOptions({ url: 'https://example.test', ...override })).toThrow();
  });
  it('lists presets without launching a browser and catches CLI mistakes', async () => {
    const list = await cli(['simulate', '--list']);
    expect(JSON.parse(list.out).agents.length).toBeGreaterThan(0);
    expect((await cli(['simulate', '--help'])).out).toContain('--evidence behavior|marker');
    for (const args of [['--wat'], ['--report=false'], ['--output'], ['https://a.test', '--url', 'https://b.test']])
      expect((await cli(['simulate', ...args])).code).toBe(1);
  });
  it('blocks known telemetry endpoints including query strings, not arbitrary page paths', () => {
    for (const path of ['/v1/collect?key=x', '/v1/check', '/v1/ping', '/v1/hits', '/v1/evaluate'])
      expect(telemetryRequest('https://example.test' + path)).toBe(true);
    expect(telemetryRequest('https://example.test/docs/v1/collection')).toBe(false);
  });
});

describe('real browser simulation', () => {
  let server: Server, url: string, probeSource: string, collections = 0, observedUa = '', observedSignature = '', rejectTelemetry = false;
  beforeAll(async () => {
    probeSource = (await build({ ...simulationProbeBuildOptions(), write: false })).outputFiles![0].text;
    server = createServer((req, res) => {
      observedUa = req.headers['user-agent'] ?? '';
      observedSignature = String(req.headers['signature-input'] ?? '');
      if (req.url?.startsWith('/v1/collect')) { collections++; if (rejectTelemetry) res.setHeader('DA-Telemetry-Accepted', '0'); res.end('{}'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(`<html><body><h1>Simulation target</h1><button id="real">Real site button</button><script>
      document.querySelector('#real').onclick=()=>{throw Error('site button must not be clicked')};
      window.doubleagent={verdict:()=>({class:'bot',token:'do-not-export',model:'test'}),flush:()=>fetch('/v1/collect',{method:'POST'}).catch(()=>{})};
      window.doubleagent.flush();</script></body></html>`);
    });
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/?private=value`;
  });
  afterAll(() => new Promise<void>((done) => { server.close(() => done()); }));
  const run = (raw: Record<string, unknown>) => runSiteSimulation(siteOptions({ url, ...raw }), { cwd: process.cwd(), probeSource });
  it('isolates real collection, captures SDK output without its token, and observes a marker', async () => {
    collections = 0;
    const report = await run({ scenario: 'agent', evidence: 'marker', duration: 3, delay: 100 });
    expect(report.status).toBe('pass');
    expect(report.snapshots.some((s) => s.verdict.class === 'agent')).toBe(true);
    expect(report.reporting.blocked).toBeGreaterThan(0);
    expect(collections).toBe(0);
    expect(report.actionsCompleted).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/do-not-export|private=value/);
  }, 15000);
  it('requires opt-in for collection and confirms the server accepted it', async () => {
    collections = 0;
    const report = await run({ report: true, duration: 2, 'agent-name': 'acme.shopping-assistant', 'token-id': '1' });
    expect(observedUa).toContain('acme.shopping-assistant/1.0 (erc8004=');
    expect(report.declared_identity).toMatchObject({ agent_name: 'acme.shopping-assistant', verification: 'declared', token_id: '1' });
    expect(report.snapshots.every(s => s.webdriver && s.declaredIdentity?.agent_name === 'acme.shopping-assistant')).toBe(true);
    expect(report.reporting).toMatchObject({ outcome: 'accepted', mode: 'site', blocked: 0 });
    expect(report.reporting.receipts.some(r => r.status === 200 && r.outcome === 'accepted')).toBe(true);
    expect(collections).toBeGreaterThan(0);
  }, 15000);
  it('reports a telemetry queue rejection even when HTTP succeeds', async () => {
    rejectTelemetry = true;
    try {
      const report = await run({ report: true, duration: 2 });
      expect(report.status).toBe('fail');
      expect(report.reporting).toMatchObject({ outcome: 'not-confirmed', accepted: 0 });
      expect(report.reporting.receipts.every(r => r.outcome === 'rejected' && r.reason === 'telemetry_not_accepted')).toBe(true);
    } finally { rejectTelemetry = false; }
  }, 15000);
  it('signs only opted-in telemetry in Node and reports signing failures', async () => {
    const options = siteOptions({ url, report: true, duration: 2 });
    const result = await runSiteSimulation(options, { cwd: process.cwd(), probeSource,
      signRequest: async req => req.method === 'POST' ? signer.signRequest(req, { components: ['user-agent', 'origin'] }) : null });
    expect(result.signing?.signed).toBeGreaterThan(0);
    expect(result.signing?.failed).toBe(0);
    expect(observedSignature).toContain('erc8128');
    const failed = await runSiteSimulation(options, { cwd: process.cwd(), probeSource,
      signRequest: async req => { if (req.method === 'POST') throw new Error('private key must not be reported'); return null; } });
    expect(failed.status).toBe('fail');
    expect(failed.signing?.failed).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain('private key must not be reported');
  }, 15000);
  it('collects pause-and-act evidence without an agent marker or hiding webdriver', async () => {
    const report = await run({ scenario: 'agent', duration: 12 });
    expect(report.status).toBe('observed');
    expect(report.injectedFixtureObserved).toBeNull();
    expect(report.actionsCompleted).toBeGreaterThanOrEqual(4);
    expect(report.actions).toHaveLength(report.actionsCompleted);
    expect(report.actions[0]).toMatchObject({ step: 1, description: 'Entered text in Test name' });
    expect(report.snapshots.some((s) => s.signals.some((v) => v.c === 'rhythm.think_then_act'))).toBe(true);
    expect(report.snapshots.some((s) => s.verdict.class === 'agent')).toBe(true);
    expect(report.snapshots.every((s) => s.webdriver && !s.injected)).toBe(true);
    expect(report.errors).toEqual([]);
  }, 25000);
});
