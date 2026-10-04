// @vitest-environment happy-dom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { startSiteProbe } from '../src/simulation/probe';
import { siteOptions } from '../src/simulation/options';

const win = window as typeof window & { doubleagent?: any; __playwright_simulation?: unknown };
let probe: ReturnType<typeof startSiteProbe> | undefined;
beforeEach(() => {
  vi.useFakeTimers(); document.body.innerHTML = '';
  Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
  sessionStorage.setItem('da-session', 'existing-session');
});
afterEach(() => { probe?.stop(); probe = undefined; delete win.doubleagent; delete win.__playwright_simulation; vi.restoreAllMocks(); vi.useRealTimers(); });
const options = (raw: Record<string, unknown> = {}) => siteOptions({ url: 'https://example.test', ...raw });

it('observes with no fixtures or storage changes and strips the installed token', async () => {
  const flush = vi.fn();
  win.doubleagent = { verdict: () => ({ class: 'bot', token: 'secret' }), flush };
  document.body.innerHTML = '<script type="application/json" src="https://cdn.doubleagent.so/sdk.js?key=private"></script>';
  const snapshots = vi.fn();
  probe = startSiteProbe(options(), snapshots); await probe.ready;
  window.dispatchEvent(new MouseEvent('click')); // untrusted interaction: diagnostic evidence only
  await vi.advanceTimersByTimeAsync(1600);
  const snapshot = probe.snapshot();
  expect(snapshot.injected).toBeNull();
  expect(snapshot.observed).toBeNull();
  expect(snapshot.installed.verdict).toEqual({ class: 'bot' });
  expect(snapshot.installed.scripts).toEqual(['https://cdn.doubleagent.so/sdk.js']);
  expect(snapshot.behaviorOnly.reasons.every((r) => !r.code.startsWith('auto.'))).toBe(true);
  expect(sessionStorage.getItem('da-session')).toBe('existing-session');
  expect(flush).not.toHaveBeenCalled();
  expect(snapshots).toHaveBeenCalled();
  probe.stop(); snapshots.mockClear();
  await vi.advanceTimersByTimeAsync(3000); expect(snapshots).not.toHaveBeenCalled();
});

it('removes only its own marker and tolerates a failing installed SDK', async () => {
  win.doubleagent = { verdict() { throw Error('incomplete'); } };
  probe = startSiteProbe(options({ scenario: 'agent', evidence: 'marker', delay: 100 })); await probe.ready;
  await vi.advanceTimersByTimeAsync(500);
  expect(probe.snapshot()).toMatchObject({ observed: true, injected: { reason: 'marker.browser_use' }, installed: { verdict: null } });
  expect(document.querySelector('#browser-use-debug-highlights')).toBeTruthy();
  probe.stop(); expect(document.querySelector('#browser-use-debug-highlights')).toBeNull();
});

it('preserves an existing marker and reports that no new fixture was injected', async () => {
  document.body.innerHTML = '<div id="browser-use-debug-highlights" data-existing="real"></div>';
  probe = startSiteProbe(options({ scenario: 'agent', evidence: 'marker', delay: 100 })); await probe.ready;
  await vi.advanceTimersByTimeAsync(500);
  expect(probe.injectionError).toMatch(/already exists/);
  expect(probe.snapshot().injected).toBeNull();
  probe.stop(); expect(document.querySelector('#browser-use-debug-highlights')?.getAttribute('data-existing')).toBe('real');
});

it('restores previous globals and cleans up newly introduced globals', async () => {
  for (const exists of [true, false]) {
    if (exists) Object.defineProperty(win, '__playwright_simulation', { value: 'previous', configurable: true });
    else delete win.__playwright_simulation;
    probe = startSiteProbe(options({ scenario: 'bot', evidence: 'marker', delay: 100 })); await probe.ready;
    await vi.advanceTimersByTimeAsync(3500);
    expect(probe.snapshot().observed).toBe(true);
    probe.stop(); expect(win.__playwright_simulation).toBe(exists ? 'previous' : undefined);
  }
});

it('records injection failure without crashing the detector', async () => {
  probe = startSiteProbe(options({ scenario: 'agent', evidence: 'marker', delay: 100 })); await probe.ready;
  vi.spyOn(document.body, 'appendChild').mockImplementation(() => { throw Error('DOM rejected'); });
  await vi.advanceTimersByTimeAsync(500);
  expect(probe.injectionError).toMatch(/DOM rejected/);
  expect(probe.snapshot().injected).toBeNull();
});
