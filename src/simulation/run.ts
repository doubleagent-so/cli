import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Page, BrowserType, Request as BrowserRequest, Route } from 'playwright';
import type { SiteOptions } from './options';
import { siteFixture } from './options';
import type { SiteSnapshot } from './probe';
import { behaviorActions } from './actions';
import type { RegistrySnapshot } from '../identity';
import { AGENT_UA_MAX, parseAgentUserAgent } from '../identity/user-agent';
import { collectionReceipt, isCollection, type CollectionReceipt } from './telemetry';

export interface SimulationAction { step: number; elapsedMs: number; description: string }

const exec = promisify(execFile);
const TELEMETRY = /\/v1\/(?:collect|check|ping|hits|evaluate)(?:\/|$)/;
export function telemetryRequest(url: string): boolean { return TELEMETRY.test(new URL(url).pathname); }
export function cleanTarget(url: string): string { const parsed = new URL(url); return parsed.origin + parsed.pathname; }

export function playwrightRuntime(cwd: string) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Website simulation needs Node.js 20 or later.');
  for (const from of [import.meta.url, join(cwd, 'package.json')]) {
    try {
      const require = createRequire(from);
      const module = require('playwright') as { chromium: BrowserType };
      return { ...module, cli: join(dirname(require.resolve('playwright/package.json')), 'cli.js') };
    } catch { /* Standalone skill helpers can use the website project's Playwright installation. */ }
  }
  throw new Error('Playwright is unavailable. Install playwright@1.63.0 in this project, or use npx @doubleagent-so/cli simulate.');
}

export async function installSimulationBrowser(cwd: string) {
  const { cli } = playwrightRuntime(cwd);
  await exec(process.execPath, [cli, 'install', 'chromium'], { maxBuffer: 8 * 1024 * 1024 });
}

export interface SimulationReport {
  schemaVersion: '1';
  registry_identity?: RegistrySnapshot & { association: 'simulation-parameter' };
  runId: string;
  target: string;
  options: Omit<SiteOptions, 'url'>;
  startedAt: string;
  finishedAt: string;
  browser: string;
  status: 'observed' | 'pass' | 'fail';
  expectedSignal: string | null;
  injectedFixtureObserved: boolean | null;
  actionsCompleted: number;
  actions: SimulationAction[];
  declared_identity?: ReturnType<typeof parseAgentUserAgent>;
  reporting: { mode: 'isolated' | 'site'; accepted: number; blocked: number; outcome: 'blocked' | 'accepted' | 'not-confirmed'; receipts: CollectionReceipt[]; pending: number };
  snapshots: SiteSnapshot[];
  errors: string[];
  signing?: { signed: number; failed: number };
  limits: string[];
}
export interface RunDependencies {
  cwd: string;
  probeSource?: string;
  chromium?: BrowserType;
  signal?: AbortSignal;
  onSnapshot?(snapshot: SiteSnapshot, preview?: string): void;
  onStatus?(message: string): void;
  onAction?(action: SimulationAction): void;
  onCollection?(receipt: CollectionReceipt): void;
  previews?: boolean;
  signRequest?(request: Request): Promise<Request | null>;
}

/** Cleanup must not mask the run's own result or error. */
async function ignoreCloseError(closing: Promise<void> | undefined): Promise<void> {
  try {
    await closing;
  } catch {
    // already closed, or the browser crashed: nothing left to release
  }
}

type Actions = Awaited<ReturnType<typeof behaviorActions>>;

const pause = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

const LIMITS = [
  'Behavior scenarios are scripted patterns using trusted browser input on temporary test controls, not real LLM agents or tasks on the website.',
  'Behavior-only is a diagnostic score excluding identity and environment signals. The full verdict remains authoritative for this test.',
  'Fixture pass means the requested signal was observed, not that a real AI agent or provider was verified.',
  'Playwright remains detectable. Observe is not proof of a human visit; human controls require a person in a normal browser.',
  'Local detector output and the installed SDK/server verdict can differ; both are reported when available.',
  'Isolated blocks standard Double Agent telemetry paths; the target website can still receive page requests and its other analytics.',
];
const REPORTING_LIMIT = 'Reporting uses the installed SDK and its consent/settings. Accepted collection is not proof of dashboard indexing; synthetic visits are not automatically labelled as tests.';

/** What the page left once the run's time was up. */
interface RunResult { startedAt: string; browser: string; userAgent: string | undefined; injectionError: string | null; actionsCompleted: number }

/** One run: its browser, the evidence it gathers and the telemetry it saw. `run()` always closes the browser. */
class SiteSimulation {
  readonly #options: SiteOptions;
  readonly #deps: RunDependencies;
  readonly #chromium: BrowserType;
  readonly #source: string;
  readonly #fixture: ReturnType<typeof siteFixture>;
  readonly #snapshots: SiteSnapshot[] = [];
  readonly #errors: string[] = [];
  readonly #actions: SimulationAction[] = [];
  readonly #receipts: CollectionReceipt[] = [];
  readonly #pending = new Set<BrowserRequest>();
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #accepted = 0;
  #blocked = 0;
  #signed = 0;
  #signFailed = 0;

  constructor(options: SiteOptions, deps: RunDependencies, chromium: BrowserType, source: string) {
    this.#options = options;
    this.#deps = deps;
    this.#chromium = chromium;
    this.#source = source;
    this.#fixture = siteFixture(options);
  }

  async run(): Promise<SimulationReport> {
    const startedAt = new Date().toISOString();
    const cancel = () => { void ignoreCloseError(this.#context?.close()); }; // abort listener: close in the background
    const { signal } = this.#deps;
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const browser = await this.#launch();
      const userAgent = await this.#userAgent(browser);
      const page = await this.#open(browser, userAgent);
      const actions = await behaviorActions(page, this.#options);
      const { scenario, evidence, duration } = this.#options;
      this.#deps.onStatus?.(`Page ready. Running ${scenario} / ${evidence} for ${duration}s${actions ? `, pausing ${this.#options.pause}ms between actions` : ''}.`);
      await this.#observe(page, actions);
      const injectionError = await page.evaluate(() => (window as any).__daSiteProbe.injectionError) as string | null;
      if (injectionError) this.#errors.push(injectionError);
      if (this.#options.report) await this.#flush(page);
      return this.#report({ startedAt, browser: browser.version(), userAgent, injectionError, actionsCompleted: actions?.count ?? 0 });
    } finally {
      signal?.removeEventListener('abort', cancel);
      await ignoreCloseError(this.#context?.close());
      await ignoreCloseError(this.#browser?.close());
    }
  }

  async #launch(): Promise<Browser> {
    this.#deps.onStatus?.(`Launching ${this.#options.headed ? 'visible' : 'headless'} Chromium…`);
    try { this.#browser = await this.#chromium.launch({ headless: !this.#options.headed }); }
    catch (error) { throw new Error(`Chromium could not start. Run doubleagent simulate --install-browser first. ${String(error)}`, { cause: error }); }
    return this.#browser;
  }

  /** The --user-agent override; with a declaration, Chromium's own product and version plus the declaration. */
  async #userAgent(browser: Browser): Promise<string | undefined> {
    const { declaration } = this.#options;
    if (!declaration) return this.#options.userAgent;
    // Keep Chromium's actual product/version and webdriver evidence, then add the declaration.
    const base = this.#options.userAgent ?? await chromiumUserAgent(browser);
    const userAgent = `${base} ${declaration}`;
    if (userAgent.length > AGENT_UA_MAX) throw new Error('Combined User-Agent exceeds 1024 characters.');
    return userAgent;
  }

  /** A fresh context with telemetry routing and the probe, opened on the target once the probe is ready. */
  async #open(browser: Browser, userAgent: string | undefined): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block',
      ...(userAgent ? { userAgent } : {}) });
    this.#context = context;
    this.#deps.signal?.throwIfAborted();
    await context.route('**/*', (route) => this.#route(route));
    await context.addInitScript({ content: `window.__daSiteOptions=${JSON.stringify(this.#options)};\n${this.#source}` });
    const page = await context.newPage();
    page.on('pageerror', (error) => { if (this.#errors.length < 20) this.#errors.push(error.message.slice(0, 300)); });
    this.#watchCollection(page);
    this.#deps.onStatus?.(`Opening ${cleanTarget(this.#options.url)}…`);
    await page.goto(this.#options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => Boolean((window as any).__daSiteProbe), undefined, { timeout: 15_000 });
    await page.evaluate(() => (window as any).__daSiteProbe.ready);
    return page;
  }

  /** Isolated runs block telemetry; reporting runs pass it on, signed when a signer is given. */
  async #route(route: Route): Promise<void> {
    const { report } = this.#options;
    if (!report && telemetryRequest(route.request().url())) {
      this.#blocked++;
      await route.abort();
    } else if (report && this.#deps.signRequest) {
      await this.#continueSigned(route, this.#deps.signRequest);
    } else {
      await route.continue();
    }
  }

  /** A request the signer can't sign goes on unsigned; one whose signing fails is blocked. */
  async #continueSigned(route: Route, sign: NonNullable<RunDependencies['signRequest']>): Promise<void> {
    try {
      const req = route.request();
      const body = req.postDataBuffer();
      const authenticated = await sign(new Request(req.url(), { method: req.method(), headers: await req.allHeaders(),
        ...(body ? { body: new Uint8Array(body) } : {}) }));
      if (authenticated) { this.#signed++; await route.continue({ headers: Object.fromEntries(authenticated.headers) }); }
      else await route.continue();
    } catch {
      this.#signFailed++;
      if (this.#errors.length < 20) this.#errors.push('Request signing failed; that request was blocked.');
      await route.abort();
    }
  }

  /** Tracks each collection request until it gets a response or fails, and records its receipt. */
  #watchCollection(page: Page): void {
    const collect = (request: BrowserRequest, status: number | null, acceptedHeader?: string) => {
      if (!isCollection(request.url(), request.method())) return;
      this.#pending.delete(request);
      const receipt = collectionReceipt(request.url(), request.postData(), status, acceptedHeader, !this.#options.report);
      if (receipt.outcome === 'accepted') this.#accepted++;
      if (this.#receipts.length < 50) this.#receipts.push(receipt);
      this.#deps.onCollection?.(receipt);
    };
    page.on('request', (request) => { if (isCollection(request.url(), request.method())) this.#pending.add(request); });
    page.on('requestfailed', (request) => collect(request, null));
    page.on('response', (response) => {
      collect(response.request(), response.status(), response.headers()['da-telemetry-accepted']);
    });
  }

  /** Until the duration is up: a snapshot every half second, actions at the pause, scrolls at the interval. */
  async #observe(page: Page, actions: Actions): Promise<void> {
    const options = this.#options;
    const runningAt = Date.now();
    const until = Date.now() + options.duration * 1000;
    const due = { scroll: Date.now() + options.interval, action: Date.now() + options.delay, preview: 0 };
    while (Date.now() < until) {
      this.#deps.signal?.throwIfAborted();
      await this.#snapshot(page, due);
      if (actions && Date.now() >= due.action) {
        await this.#act(actions, runningAt);
        due.action = Date.now() + options.pause;
      }
      if (options.scroll && Date.now() >= due.scroll) {
        await page.mouse.wheel(0, options.scroll);
        due.scroll = Date.now() + options.interval;
      }
      await pause(Math.min(500, Math.max(0, until - Date.now())));
    }
  }

  /** Records the probe's snapshot, with a screenshot at most every two seconds when previews are on. */
  async #snapshot(page: Page, due: { preview: number }): Promise<void> {
    const snapshot = await page.evaluate(() => (window as any).__daSiteProbe.snapshot()) as SiteSnapshot;
    this.#snapshots.push(snapshot);
    let preview: string | undefined;
    if (this.#deps.previews && Date.now() >= due.preview) {
      preview = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 })).toString('base64');
      due.preview = Date.now() + 2000;
    }
    this.#deps.onSnapshot?.(snapshot, preview);
  }

  async #act(actions: NonNullable<Actions>, runningAt: number): Promise<void> {
    const description = await actions.next();
    const action = { step: actions.count, elapsedMs: Date.now() - runningAt, description };
    this.#actions.push(action);
    this.#deps.onAction?.(action);
  }

  /** Flushes the installed SDK, then waits for its collection requests (including signature verification). */
  async #flush(page: Page): Promise<void> {
    this.#deps.onStatus?.('Flushing the installed SDK and waiting for collection responses…');
    const canReport = await page.evaluate(() => {
      const sdk = (window as any).doubleagent;
      if (typeof sdk?.flush !== 'function') return false;
      sdk.flush(); return true;
    });
    if (!canReport) this.#errors.push('No installed Double Agent SDK was available to report this visit.');
    // Give beacon dispatch time to start, then wait for in-flight requests.
    const drainStarted = Date.now();
    do { await pause(100); }
    while (Date.now() - drainStarted < 1200 || (this.#pending.size > 0 && Date.now() - drainStarted < 6500));
  }

  /** Fails on any signing problem, a probe injection error, an unseen fixture, or reporting nothing accepted. */
  #status(injectionError: string | null, observed: boolean | null): SimulationReport['status'] {
    const unsigned = !!this.#deps.signRequest && !this.#signed;
    const unreported = this.#options.report && !this.#accepted;
    if (this.#signFailed || unsigned || injectionError || (this.#fixture && !observed) || unreported) return 'fail';
    return this.#fixture ? 'pass' : 'observed';
  }

  #reporting(): SimulationReport['reporting'] {
    const { report } = this.#options;
    let outcome: SimulationReport['reporting']['outcome'] = 'blocked';
    if (report) outcome = this.#accepted ? 'accepted' : 'not-confirmed';
    return { mode: report ? 'site' : 'isolated', accepted: this.#accepted, blocked: this.#blocked, outcome, receipts: [...this.#receipts], pending: this.#pending.size };
  }

  #report(result: RunResult): SimulationReport {
    const fixture = this.#fixture;
    const observed = fixture ? this.#snapshots.some((row) => row.injected?.id === fixture.id && row.observed) : null;
    const { url: _url, ...options } = this.#options;
    return {
      schemaVersion: '1', runId: randomUUID(), target: cleanTarget(this.#options.url), options,
      startedAt: result.startedAt, finishedAt: new Date().toISOString(), browser: result.browser,
      status: this.#status(result.injectionError, observed),
      expectedSignal: fixture?.reason ?? null, injectedFixtureObserved: observed,
      actionsCompleted: result.actionsCompleted,
      actions: this.#actions,
      declared_identity: parseAgentUserAgent(result.userAgent ?? ''),
      ...(this.#deps.signRequest ? { signing: { signed: this.#signed, failed: this.#signFailed } } : {}),
      reporting: this.#reporting(), snapshots: this.#snapshots, errors: this.#errors,
      limits: this.#options.report ? [...LIMITS, REPORTING_LIMIT] : [...LIMITS],
    };
  }
}

/** Chromium's own User-Agent, read from a throwaway context. */
async function chromiumUserAgent(browser: Browser): Promise<string> {
  const initial = await browser.newContext();
  try { return await (await initial.newPage()).evaluate(() => navigator.userAgent); }
  finally { await initial.close(); }
}

/** A fresh context per run; actions only use temporary inert simulation controls. */
export async function runSiteSimulation(options: SiteOptions, deps: RunDependencies): Promise<SimulationReport> {
  const chromium = deps.chromium ?? playwrightRuntime(deps.cwd).chromium;
  const source = deps.probeSource ?? readFileSync(new URL('./simulation-probe.js', import.meta.url), 'utf8');
  return new SiteSimulation(options, deps, chromium, source).run();
}
