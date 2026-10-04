import { FIXTURES, type Fixture } from './fixtures';
import { CATALOG, DEFAULT_SIGNATURES, type Profile } from '@doubleagent-so/agent-detector';
import { agentName, agentReference } from '../identity/reference';
import { agentUserAgent, parseAgentUserAgent } from '../identity/user-agent';

export const SITE_SCENARIOS = ['observe', 'bot', 'agent'] as const;
export type SiteScenario = typeof SITE_SCENARIOS[number];
export const SIMULATED_AGENTS = CATALOG.filter((entry) => entry.class === 'agent' && FIXTURES.some((fixture) => fixture.catalogId === entry.id))
  .map(({ id, name }) => ({ id, name }));
export const SITE_PROFILES = Object.keys(DEFAULT_SIGNATURES.priors) as Profile[];
export interface SiteOptions {
  url: string;
  scenario: SiteScenario;
  evidence: 'behavior' | 'marker';
  agent: string;
  profile: Profile;
  duration: number;
  delay: number;
  scroll: number;
  interval: number;
  pause: number;
  userAgent?: string;
  declaration?: string;
  report: boolean;
  headed: boolean;
}

export function siteUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter an http:// or https:// website URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a complete URL, including https://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('Use an HTTP(S) website URL without embedded credentials.');
  url.hash = '';
  return url.href;
}

function integer(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return Number(raw);
}

/** A value that must be one of a fixed set, with a default when absent. */
function oneOf<T>(raw: unknown, fallback: T, allowed: (value: unknown) => boolean, message: string): T {
  const value = raw ?? fallback;
  if (!allowed(value)) throw new Error(message);
  return value as T;
}

function checkUserAgent(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n]/.test(value))
    throw new Error('user-agent must be a non-empty single line of at most 512 characters.');
}

/** The declared agent as a User-Agent product, with its ERC-8004 reference when a token is given. */
function declarationOf(raw: Record<string, unknown>): string | undefined {
  if (raw['agent-name'] === undefined) return undefined;
  const name = agentName(raw['agent-name']);
  const ref = raw['token-id'] === undefined ? undefined : agentReference({ agent_name: name, token_id: raw['token-id'], chain_id: raw['chain-id'], registry_address: raw.registry }).agent_ref;
  const declaration = agentUserAgent(name, ref);
  const userAgent = raw.userAgent as string | undefined;
  if (userAgent && (parseAgentUserAgent(userAgent) || /erc8004=/i.test(userAgent)))
    throw new Error('Use --agent-name for one declaration; do not also embed an identity in --user-agent.');
  return declaration;
}

export function siteOptions(raw: Record<string, unknown>): SiteOptions {
  const scenario = oneOf<SiteScenario>(raw.scenario, 'observe', (value) => SITE_SCENARIOS.includes(value as SiteScenario), 'scenario must be observe, bot or agent.');
  const evidence = oneOf<'behavior' | 'marker'>(raw.evidence, 'behavior', (value) => value === 'behavior' || value === 'marker', 'evidence must be behavior or marker.');
  const agent = oneOf<string>(raw.agent, 'browser-use.agent', (value) => SIMULATED_AGENTS.some((entry) => entry.id === value), 'Choose an agent with a browser fixture (use --list).');
  const profile = oneOf<Profile>(raw.profile, 'generic', (value) => SITE_PROFILES.includes(value as Profile), 'Unknown site profile.');
  const duration = integer(raw.duration, 'duration (seconds)', 20, 2, 120);
  const delay = integer(raw.delay, 'delay (milliseconds)', 1500, 0, 60_000);
  if (delay >= duration * 1000) throw new Error('delay must be shorter than duration.');
  checkUserAgent(raw.userAgent);
  for (const key of ['report', 'headed']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  const declaration = declarationOf(raw);
  return {
    url: siteUrl(raw.url), scenario, evidence, agent, profile,
    duration, delay, scroll: integer(raw.scroll, 'scroll (pixels)', 0, 0, 1200),
    interval: integer(raw.interval, 'interval (milliseconds)', 1500, 250, 10_000),
    pause: integer(raw.pause, 'pause (milliseconds)', scenario === 'agent' ? 2200 : 350, 100, 10_000),
    ...(raw.userAgent ? { userAgent: raw.userAgent as string } : {}), report: raw.report === true, headed: raw.headed === true,
    ...(declaration ? { declaration } : {}),
  };
}

const BOT_FIXTURE: Record<string, string> = { bot: 'playwright.automation' };

export function siteFixture(options: Pick<SiteOptions, 'scenario' | 'agent' | 'evidence'>): Fixture | undefined {
  if (options.evidence !== 'marker') return undefined;
  const id = options.scenario === 'agent' ? options.agent : BOT_FIXTURE[options.scenario ?? ''];
  return id ? FIXTURES.find((fixture) => fixture.catalogId === id) : undefined;
}

/** POSIX shell quoting: URLs and UA strings must never become executable shell syntax. */
export const shellArg = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
/** The shell command that reproduces `options`; `command` is how the simulate command is invoked. */
export function siteCommand(options: SiteOptions, command = 'npx @doubleagent-so/cli simulate'): string {
  const args = [command, '--url', shellArg(options.url), '--scenario', options.scenario];
  args.push('--evidence', options.evidence);
  if (options.scenario === 'agent' && options.evidence === 'marker') args.push('--agent', options.agent);
  args.push('--profile', options.profile, '--duration', String(options.duration), '--delay', String(options.delay),
    '--scroll', String(options.scroll), '--interval', String(options.interval), '--pause', String(options.pause));
  if (options.userAgent) args.push('--user-agent', shellArg(options.userAgent));
  if (options.declaration) {
    const claim = parseAgentUserAgent(options.declaration)!;
    args.push('--agent-name', shellArg(claim.agent_name));
    if (claim.agent_ref) args.push('--token-id', claim.token_id!, '--chain-id', claim.chain_id!, '--registry', claim.registry_address!);
  }
  if (options.headed) args.push('--headed');
  if (options.report) args.push('--report');
  return args.join(' ');
}
