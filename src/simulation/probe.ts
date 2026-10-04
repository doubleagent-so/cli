import { createEngine, DEFAULT_SIGNATURES, fuse, type Signal, type Verdict } from '@doubleagent-so/agent-detector';
import { applyFixture } from './fixtures';
import { siteFixture, type SiteOptions } from './options';
import { parseAgentUserAgent, type AgentDeclaration } from '../identity/user-agent';
const signatureVersion = DEFAULT_SIGNATURES.version;

export interface SiteSnapshot {
  at: string;
  elapsedMs: number;
  url: string;
  scenario: string;
  signatureVersion: string;
  source: 'local-detector';
  injected: { id: string; reason: string; value: string } | null;
  observed: boolean | null;
  webdriver: boolean;
  declaredIdentity: AgentDeclaration | null;
  verdict: Verdict;
  behaviorOnly: Verdict;
  features: Record<string, number>;
  stats: { events: number; durationMs: number; reliability: number };
  signals: { c: string; g: string; t?: string; h?: 1 }[];
  installed: { verdict: Verdict | null; scripts: string[] };
}

type ProbeWindow = Window & typeof globalThis & {
  __daSiteProbe?: ReturnType<typeof startSiteProbe>;
  __daSiteOptions?: SiteOptions;
  doubleagent?: { verdict?(): Verdict | null; flush?(): void };
};

/** Same detector as the SDK, with independent state and no network, storage or integration writes. */
export function startSiteProbe(options: SiteOptions, onSnapshot?: (snapshot: SiteSnapshot) => void) {
  const w = window as ProbeWindow;
  const fixture = siteFixture(options);
  const started = performance.now();
  let injected = false;
  let closed = false;
  let ready = false;
  let injectionError: string | null = null;
  let marker: Element | null = null;
  let oldGlobal: PropertyDescriptor | undefined;
  const engine = createEngine(w, { profile: options.profile, interval: 500 });
  const inject = () => {
    if (!fixture || closed) return;
    try {
      if (fixture.kind === 'global') oldGlobal = Object.getOwnPropertyDescriptor(w, fixture.value);
      else if (document.querySelector(fixture.value)) { injectionError = 'The requested marker already exists; no fixture was injected.'; return; }
      applyFixture(document, w, fixture);
      if (fixture.kind === 'marker') marker = document.body.lastElementChild;
      injected = true;
    } catch (error) { injectionError = String(error); }
  };
  const injectionTimer = setTimeout(inject, options.delay);
  const cleanUrl = (value: string) => { try { const u = new URL(value, location.href); return u.origin + u.pathname; } catch { return ''; } };
  const snapshot = (): SiteSnapshot => {
    const payload = engine.payload();
    const behaviorOnly = fuse({
      signals: payload.signals.filter((s) => ['D', 'R', 'C'].includes(s.g)).map((s) => ({
        code: s.c, group: s.g, llr: s.l, target: s.t, detail: s.d,
      } as Signal)),
      sig: DEFAULT_SIGNATURES, profile: payload.page.profile, action: payload.page.action, sessionId: engine.sessionId,
      behaviorReliability: payload.stats.reliability, driveReliability: payload.stats.driveReliability,
    });
    let installed: Verdict | null = null;
    try {
      const value = w.doubleagent?.verdict?.();
      if (value) { const { token: _token, ...verdict } = value; installed = verdict; }
    } catch { /* An incomplete SDK must not stop the independent probe. */ }
    return {
      at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), url: cleanUrl(location.href),
      scenario: options.scenario, signatureVersion, source: 'local-detector',
      injected: injected && fixture ? { id: fixture.id, reason: fixture.reason, value: fixture.value } : null,
      observed: fixture ? payload.signals.some((signal) => signal.c === fixture.reason) : null,
      webdriver: navigator.webdriver, declaredIdentity: parseAgentUserAgent(navigator.userAgent), verdict: engine.score(),
      behaviorOnly, features: payload.features, stats: payload.stats,
      signals: payload.signals.map(({ c, g, t, h }) => ({ c, g, t, h })),
      installed: { verdict: installed, scripts: [...document.scripts].filter((script) => /doubleagent/i.test(script.src)).map((script) => cleanUrl(script.src)) },
    };
  };
  // Reading a snapshot must not recurse through the detector's verdict callback.
  const publish = () => { if (ready && !closed) onSnapshot?.(snapshot()); };
  const tick = setInterval(publish, 500);
  const publishWhenReady = async () => {
    await engine.ready;
    ready = true;
    publish();
  };
  void publishWhenReady(); // background: the probe returns now; snapshots start once the detector is ready
  return {
    snapshot, ready: engine.ready,
    get injectionError() { return injectionError; },
    stop() {
      closed = true;
      clearTimeout(injectionTimer); clearInterval(tick); engine.stop();
      marker?.remove();
      if (injected && fixture?.kind === 'global') {
        if (oldGlobal) Object.defineProperty(w, fixture.value, oldGlobal);
        else Reflect.deleteProperty(w, fixture.value);
      }
    },
  };
}

// The CLI installs options before any page script, then this probe starts when the DOM is ready.
const w = window as ProbeWindow;
if (w.__daSiteOptions && w.top === w) {
  const start = () => { w.__daSiteProbe?.stop(); w.__daSiteProbe = startSiteProbe(w.__daSiteOptions!); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
