import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cli, fixture } from './helpers';
import { runSiteSimulation, installSimulationBrowser } from '../src/simulation/run';
import { registryRpc } from './identity/rpc';
vi.mock('../src/simulation/run', () => ({ runSiteSimulation: vi.fn(), installSimulationBrowser: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('declares identity without an RPC and validates explicit signing/lookup options', async () => {
  const cwd = fixture({});
  vi.mocked(runSiteSimulation).mockResolvedValue({ status: 'observed', reporting: { outcome: 'blocked' }, errors: [] } as any);
  const result = await cli(['simulate', 'https://example.test', '--agent-name', 'new.agent', '--token-id', '1', '--json'], { cwd });
  expect(result.code).toBe(0);
  expect(result.json.registry_identity).toBeUndefined();
  expect(runSiteSimulation).toHaveBeenCalledWith(expect.objectContaining({ declaration: expect.stringContaining('new.agent/1.0') }), expect.objectContaining({ signRequest: undefined }));
  for (const args of [['--sign-requests'], ['--sign-api', 'https://api.example'], ['--chain-id', '1'],
    ['--agent-name', 'new.agent', '--registry', '0x1111111111111111111111111111111111111111'],
    ['--agent-name', 'new.agent', '--reviewers', '0x1111111111111111111111111111111111111111']]) {
    expect((await cli(['simulate', 'https://example.test', ...args, '--json'], { cwd })).code).toBe(1);
  }
});

it('attaches a registry snapshot while declaring identity in the User-Agent without changing classification', async () => {
  const cwd = fixture({}), rpc = registryRpc();
  vi.mocked(runSiteSimulation).mockResolvedValue({ status: 'observed', snapshots: [{ verdict: { class: 'bot' } }], reporting: { outcome: 'blocked' }, errors: [] } as any);
  const result = await cli(['simulate', 'https://example.test', '--agent-name', 'acme.shopping-assistant', '--token-id', '1', '--resolve-identity', '--json'],
    { cwd, fetch: rpc.fetcher, env: { DOUBLEAGENT_ETHEREUM_RPC_URL: 'https://rpc.example' } });
  expect(result.code).toBe(0);
  expect(result.json.registry_identity).toMatchObject({ association: 'simulation-parameter', visit_binding: 'unverified', token_id: '1' });
  expect(result.json.snapshots[0].verdict.class).toBe('bot');
  expect(runSiteSimulation).toHaveBeenCalledWith(expect.objectContaining({ declaration: expect.stringContaining('acme.shopping-assistant/1.0 (erc8004=') }), expect.anything());
  expect((await cli(['simulate', 'https://example.test', '--agent-name', '--json'])).json.error).toContain('needs a value');
});

it('forwards parameters, writes a nested JSON report and emits machine output only', async () => {
  const cwd = fixture({});
  const report = { status: 'observed', snapshots: [], reporting: { outcome: 'blocked' }, errors: [] };
  vi.mocked(runSiteSimulation).mockResolvedValue(report as any);
  const result = await cli(['simulate', '--url', 'https://example.test', '--scenario', 'bot', '--duration', '2', '--output', 'results/run.json', '--user-agent', 'Test/1.0', '--json'], { cwd });
  expect(result.code).toBe(0); expect(result.json).toEqual(report);
  expect(JSON.parse(readFileSync(join(cwd, 'results/run.json'), 'utf8'))).toEqual(report);
  expect(runSiteSimulation).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'bot', userAgent: 'Test/1.0', report: false }), expect.objectContaining({ cwd }));
});

it('prints changed evidence once and returns a failed assertion with its report', async () => {
  const cwd = fixture({});
  vi.mocked(runSiteSimulation).mockImplementation(async (_options, deps) => {
    const snapshot = { elapsedMs: 1000, verdict: { class: 'bot' }, behaviorOnly: { class: 'human' }, installed: {} } as any;
    deps.onStatus?.('Page ready.');
    deps.onAction?.({ step: 1, elapsedMs: 1500, description: 'Entered text in Test name' });
    deps.onCollection?.({ endpoint: 'https://api.example/v1/collect', status: 204, sessionId: 'sdk_session', siteHost: 'example.test', verdictClass: 'bot', outcome: 'accepted', reason: null });
    deps.onCollection?.({ endpoint: 'https://api.example/v1/collect', status: null, sessionId: null, siteHost: null, verdictClass: null, outcome: 'failed', reason: 'network_error' });
    deps.onSnapshot?.(snapshot); deps.onSnapshot?.(snapshot);
    deps.onSnapshot?.({ ...snapshot, injected: { reason: 'marker.test' }, installed: { verdict: { class: 'agent' } } });
    return { status: 'fail', actionsCompleted: 1, snapshots: [snapshot], expectedSignal: 'marker.test', reporting: { outcome: 'not-confirmed', accepted: 1, pending: 0, receipts: [{ sessionId: 'sdk_session' }] }, errors: ['fixture unavailable'] } as any;
  });
  const result = await cli(['simulate', 'https://example.test', '--report', '--headed'], { cwd });
  expect(result.code).toBe(1); expect(result.err).toContain('fixture unavailable');
  expect(result.out.match(/behavior-only: human/g)).toHaveLength(1);
  expect(result.out).toContain('fixture: marker.test');
  expect(result.out).toContain('Browser: visible Chromium');
  expect(result.out).toContain('Dashboard reporting: enabled');
  expect(result.out).toContain('Action 1: Entered text in Test name');
  expect(result.out).toContain('Collection accepted (HTTP 204)');
  expect(result.out).toContain('Completed 1 browser actions');
  expect(result.out).toContain('Find this SDK session in the dashboard: sdk_session');
  expect(readFileSync(join(cwd, 'doubleagent-simulation.json'), 'utf8')).toContain('not-confirmed');
});

it('sets up the browser on explicit request and reports invalid options without running it', async () => {
  expect((await cli(['simulate', '--install-browser'])).out).toContain('Chromium installed');
  expect((await cli(['simulate', '--install-browser', '--json'])).json).toEqual({ installed: 'chromium' });
  expect(installSimulationBrowser).toHaveBeenCalledTimes(2);
  expect((await cli(['simulate', '--scenario', 'invalid', '--json'])).json.error).toMatch(/scenario/);
  expect(runSiteSimulation).not.toHaveBeenCalled();
});
