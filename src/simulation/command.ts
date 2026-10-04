import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError, str, type Args, type Io } from '../io';
import { SITE_PROFILES, SIMULATED_AGENTS, siteOptions, type SiteOptions } from './options';
import { installSimulationBrowser, runSiteSimulation, type RunDependencies, type SimulationReport } from './run';
import { simulationSigner } from '../identity/sign-request';
import { resolveIdentityFlags } from '../agents';

export const SIMULATE_HELP = `doubleagent simulate <url> [options]

  --url <url>                  Alternative to the positional URL
  --scenario observe|bot|agent Observe, repeated automation, or pause-and-act pattern (default observe)
  --evidence behavior|marker  Trusted input pattern or injected marker (default behavior)
  --pause <milliseconds>       Pause between actions, 100–10000 (agent 2200, bot 350)
  --agent <catalog-id>         Marker mode agent (default browser-use.agent; use --list)
  --profile <profile>          Detector profile (default generic)
  --duration <seconds>         2–120 (default 20)
  --delay <milliseconds>       First action / marker delay (default 1500)
  --scroll <pixels>            Bounded scroll per interval; 0 disables (default 0)
  --interval <milliseconds>    Scroll interval, 250–10000 (default 1500)
  --user-agent <string>        Browser UA override; does not verify identity
  --headed                    Show Chromium (default headless)
  --report                    Allow installed SDK reporting; writes synthetic visits to its configured account
  --output <file>              JSON report (default doubleagent-simulation.json)
  --json                      Print the report as JSON; no progress output
  --agent-name <name>          Declare operator.agent-name in the browser's User-Agent
  --token-id <decimal>         Also declare an ERC-8004 reference (used with --agent-name)
  --sign-requests              Sign SDK collect/check requests using DOUBLEAGENT_ETHEREUM_PRIVATE_KEY; requires --report
  --sign-api <https-origin>    Exact telemetry API origin to sign (required with --sign-requests)
  --sign-chain-id <id>         Signing chain (default registry chain, otherwise 1)
  --resolve-identity           Attach a live registry lookup; requires the RPC environment variable
  --chain-id <decimal>         Identity chain (default 1); RPC from DOUBLEAGENT_ETHEREUM_RPC_URL
  --registry <address>         Identity registry override; required for other chains
  --reviewers <addresses>      Optional reputation reviewers (comma-separated, max 5)
  --reputation-registry <addr> Reputation registry override
  --tag1 <tag> --tag2 <tag>     Reputation metric filters
  --list                      List available agents and profiles; no browser needed
  --install-browser           Install Chromium for Playwright (Node 20+)

Isolated by default. Behavior patterns use temporary test controls on the page; site forms are not submitted.
Fixture assertions check evidence, not real-agent identity. Use a normal browser for human controls.`;

const IDENTITY_KEYS = ['agent-name', 'token-id', 'chain-id', 'registry', 'reviewers', 'reputation-registry', 'tag1', 'tag2'];
const SWITCHES = ['headed', 'report', 'json', 'list', 'install-browser', 'resolve-identity', 'sign-requests'];
const SIMULATE_FLAGS = new Set(['url', 'scenario', 'evidence', 'pause', 'agent', 'profile', 'duration', 'delay', 'scroll', 'interval', 'user-agent', 'output', 'sign-api', 'sign-chain-id', ...SWITCHES, ...IDENTITY_KEYS]);

/** Only documented options; switches take no value and the identity options need one. */
function checkFlags(flags: Args['flags']): void {
  for (const key of Object.keys(flags)) if (!SIMULATE_FLAGS.has(key)) throw new CliError(`unknown simulate option --${key}`);
  for (const key of SWITCHES) if (flags[key] !== undefined && flags[key] !== true) throw new CliError(`--${key} does not take a value`);
  if (flags.output === true) throw new CliError('--output needs a file path');
  for (const key of IDENTITY_KEYS) if (flags[key] !== undefined && typeof flags[key] !== 'string') throw new CliError(`--${key} needs a value`);
}

const given = (flags: Args['flags'], keys: string[]): boolean => keys.some((key) => flags[key] !== undefined);

/** Options that only make sense with another: identity with --agent-name, signing with --report and --sign-api. */
function checkDependentFlags(flags: Args['flags'], report: boolean): void {
  if (given(flags, IDENTITY_KEYS.filter((key) => key !== 'agent-name')) && !flags['agent-name']) throw new CliError('--agent-name is required for an identity declaration.');
  if (flags['token-id'] === undefined && given(flags, ['chain-id', 'registry'])) throw new CliError('--token-id is required for a registry reference.');
  if (!flags['resolve-identity'] && given(flags, ['reviewers', 'reputation-registry', 'tag1', 'tag2'])) throw new CliError('Reputation options need --resolve-identity.');
  if (flags['sign-requests'] && (!report || typeof flags['sign-api'] !== 'string')) throw new CliError('--sign-requests requires --report and --sign-api <https-origin>.');
  if (!flags['sign-requests'] && given(flags, ['sign-api', 'sign-chain-id'])) throw new CliError('Signing options require --sign-requests.');
}

function readOptions(args: Args): SiteOptions {
  if (args.pos.length > 1 || (args.pos.length && args.flags.url)) throw new CliError('Supply one URL, either positional or --url.');
  try { return siteOptions({ ...args.flags, url: str(args.flags.url) ?? args.pos[0], userAgent: args.flags['user-agent'] }); }
  catch (error) { throw new CliError((error as Error).message); }
}

/** A request signer for the target's telemetry, when --sign-requests asks for one. */
function signerFor(args: Args, io: Io, options: SiteOptions) {
  const { flags } = args;
  if (!flags['sign-requests']) return undefined;
  return simulationSigner(io.env.DOUBLEAGENT_ETHEREUM_PRIVATE_KEY, String(flags['sign-chain-id'] ?? flags['chain-id'] ?? '1'), String(flags['sign-api']), new URL(options.url).host);
}

/** Progress lines for a human reader; with --json nothing is printed until the report. */
function progress(io: Io, quiet: boolean): Omit<RunDependencies, 'cwd' | 'signRequest'> {
  const say = (message: string) => { if (!quiet) io.out(message); };
  let previous = '';
  return {
    onStatus: say,
    onAction: (action) => say(`${(action.elapsedMs / 1000).toFixed(1)}s  Action ${action.step}: ${action.description}`),
    onCollection: (receipt) => say(`Collection ${receipt.outcome}${receipt.status === null ? '' : ` (HTTP ${receipt.status})`}: ${receipt.endpoint}${receipt.sessionId ? `; SDK session ${receipt.sessionId}` : ''}${receipt.reason ? `; ${receipt.reason}` : ''}`),
    onSnapshot: (snapshot) => {
      // Only changes: the behavior-only class, the verdict, the fixture, or the installed SDK's verdict.
      const code = snapshot.behaviorOnly.class + ':' + snapshot.verdict.class + ':' + Boolean(snapshot.injected) + ':' + snapshot.installed.verdict?.class;
      if (quiet || code === previous) return;
      previous = code;
      io.out(`${(snapshot.elapsedMs / 1000).toFixed(1)}s  ${snapshot.verdict.class}  ${snapshot.injected ? `fixture: ${snapshot.injected.reason}` : `behavior-only: ${snapshot.behaviorOnly.class}`}  installed SDK: ${snapshot.installed.verdict?.class ?? 'unavailable'}`);
    },
  };
}

function printIntro(io: Io, options: SiteOptions): void {
  io.out(`Browser: ${options.headed ? 'visible Chromium; closes when the run finishes' : 'headless; add --headed to see the browser'}.`);
  io.out(`Dashboard reporting: ${options.report ? 'enabled through the installed SDK; this creates synthetic visits' : 'OFF (isolated); add --report to send this visit'}.`);
}

function printSummary(io: Io, report: SimulationReport, options: SiteOptions, output: string): void {
  io.out(`Completed ${report.actionsCompleted ?? 0} browser actions; captured ${report.snapshots?.length ?? 0} detector snapshots.`);
  const sessionIds = [...new Set(report.reporting.receipts?.map((receipt) => receipt.sessionId).filter(Boolean) ?? [])];
  if (sessionIds.length) io.out(`Find this SDK session in the dashboard: ${sessionIds.join(', ')}`);
  if (options.report) io.out(`Collection accepted: ${report.reporting.accepted ?? 0}; still pending: ${report.reporting.pending ?? 0}. Dashboard indexing is not verified by this command.`);
  io.out(`${report.status}: ${report.expectedSignal ?? 'behavior observation'}; reporting ${report.reporting.outcome}. Report: ${output}`);
  io.out('Behavior patterns and markers do not verify provider identity. Human controls need a person in a normal browser.');
  for (const error of report.errors) io.err(error);
}

async function writeReport(io: Io, file: string, report: SimulationReport): Promise<string> {
  const output = resolve(io.cwd, file);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  return output;
}

/** --list and --install-browser answer without running a simulation; returns null otherwise. */
async function answerWithoutRun(args: Args, io: Io): Promise<number | null> {
  if (args.flags.list) { io.out(JSON.stringify({ scenarios: ['observe', 'bot', 'agent'], agents: SIMULATED_AGENTS, profiles: SITE_PROFILES }, null, 2)); return 0; }
  if (!args.flags['install-browser']) return null;
  await installSimulationBrowser(io.cwd);
  io.out(args.flags.json ? JSON.stringify({ installed: 'chromium' }) : 'Chromium installed.');
  return 0;
}

export async function simulateCmd(args: Args, io: Io): Promise<number> {
  checkFlags(args.flags);
  const answered = await answerWithoutRun(args, io);
  if (answered !== null) return answered;
  const options = readOptions(args);
  checkDependentFlags(args.flags, options.report);
  const signRequest = signerFor(args, io, options);
  const identity = args.flags['resolve-identity'] ? await resolveIdentityFlags(args.flags, io) : undefined;
  const quiet = !!args.flags.json;
  if (!quiet) printIntro(io, options);
  const report = await runSiteSimulation(options, { cwd: io.cwd, signRequest, ...progress(io, quiet) });
  if (identity) report.registry_identity = { ...identity, association: 'simulation-parameter', visit_binding: 'unverified' };
  const output = await writeReport(io, str(args.flags.output) ?? 'doubleagent-simulation.json', report);
  if (quiet) io.out(JSON.stringify(report, null, 2));
  else printSummary(io, report, options, output);
  return report.status === 'fail' ? 1 : 0;
}
