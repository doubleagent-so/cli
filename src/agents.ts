import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { agentReference, reputationQuery, resolveAgent, type RegistrySnapshot } from './identity';
import { CliError, sessionApi, str, type Args, type Io } from './io';

export const AGENTS_HELP = `doubleagent agents resolve --agent-name acme.shopping-assistant --token-id 22 [options]

  --chain-id <decimal>          Chain ID (default 1, Ethereum)
  --registry <address>          Identity contract (default official Ethereum registry)
  --reviewers <addresses>       Comma-separated trusted reviewers, at most 5; opt-in reputation reads
  --reputation-registry <addr>  Required for reputation on a custom chain/identity registry
  --tag1 <tag> --tag2 <tag>      Reputation metric filters; values keep their original scale
  --output <path>              Save the resolved snapshot JSON
  --site <site-id>              Resolve and save a site association through the authenticated API
  --api <origin>               API origin for site associations
  --json                       Print machine-readable output

Direct lookups need DOUBLEAGENT_ETHEREUM_RPC_URL (HTTPS). Site lookups use the API's own RPC endpoints.
doubleagent agents list --site st_... [--agent-name acme.shopping-assistant] [--json]
doubleagent agents remove <association-id> --site st_... [--json]

Names follow operator.agent-name. Lookups prove registry membership, not who controls a browser.
No wallet, gas payment or chain transaction is needed. Remote registration/review documents are not fetched.`;

export function identityFlags(flags: Args['flags']): Record<string, unknown> {
  return { agent_name: flags['agent-name'], token_id: flags['token-id'], chain_id: flags['chain-id'], registry_address: flags.registry,
    reviewers: typeof flags.reviewers === 'string' ? flags.reviewers.split(',').map((s) => s.trim()) : flags.reviewers,
    reputation_registry: flags['reputation-registry'], tag1: flags.tag1, tag2: flags.tag2 };
}
export async function resolveIdentityFlags(flags: Args['flags'], io: Io): Promise<RegistrySnapshot> {
  const raw = identityFlags(flags);
  try { reputationQuery(raw, agentReference(raw)); } catch (error) { throw new CliError((error as Error).message); }
  const rpcUrl = io.env.DOUBLEAGENT_ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new CliError('Set DOUBLEAGENT_ETHEREUM_RPC_URL to an HTTPS RPC for the requested chain.');
  try { return await resolveAgent(raw, { rpcUrl, fetcher: io.fetch }); }
  catch (error) { throw new CliError((error as Error).message); }
}

const AGENTS_FLAGS = new Set(['agent-name', 'token-id', 'chain-id', 'registry', 'reviewers', 'reputation-registry', 'tag1', 'tag2', 'output', 'site', 'api', 'json']);

/** Only the documented options: --json as a switch, the rest with values; and one of the three actions. */
function checkAgentsArgs(args: Args): void {
  for (const [key, value] of Object.entries(args.flags)) {
    if (!AGENTS_FLAGS.has(key)) throw new CliError(`unknown agents option --${key}`);
    if ((key === 'json' && value !== true) || (key !== 'json' && typeof value !== 'string')) throw new CliError(`invalid --${key}`);
  }
  const action = args.pos[0];
  if (!['resolve', 'list', 'remove'].includes(action) || args.pos.length > (action === 'remove' ? 2 : 1)) throw new CliError(AGENTS_HELP);
}

/** Resolves the agent: on the site when --site is given, else locally against the RPC. */
async function resolveCmd(args: Args, io: Io, site: string | undefined, path: string): Promise<unknown> {
  const raw = identityFlags(args.flags);
  try { reputationQuery(raw, agentReference(raw)); } catch (error) { throw new CliError((error as Error).message); }
  return site ? (await sessionApi(args, io).api.request('POST', path, raw)).data : resolveIdentityFlags(args.flags, io);
}

async function listCmd(args: Args, io: Io, path: string): Promise<unknown> {
  const name = args.flags['agent-name'];
  return (await sessionApi(args, io).api.request('GET', path + (name ? `?agent_name=${encodeURIComponent(String(name))}` : ''))).data;
}

async function removeCmd(args: Args, io: Io, path: string, id: string | undefined): Promise<unknown> {
  if (!id) throw new CliError('Supply the association ID to remove.');
  await sessionApi(args, io).api.request('DELETE', `${path}/${encodeURIComponent(id)}`);
  return { removed: id };
}

async function writeOutput(io: Io, file: string, result: unknown): Promise<void> {
  const output = resolve(io.cwd, file);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
}

export async function agentsCmd(args: Args, io: Io): Promise<number> {
  checkAgentsArgs(args);
  const [action, id] = args.pos;
  const site = str(args.flags.site);
  const path = site ? `/v1/sites/${encodeURIComponent(site)}/agent-identities` : '';
  if (action !== 'resolve' && !site) throw new CliError('--site is required.');
  let result: unknown;
  if (action === 'resolve') result = await resolveCmd(args, io, site, path);
  else if (action === 'list') result = await listCmd(args, io, path);
  else result = await removeCmd(args, io, path, id);
  if (args.flags.output) await writeOutput(io, String(args.flags.output), result);
  io.out(JSON.stringify(result, null, 2));
  if (!args.flags.json) io.out('Registry association only. Website visit identity remains unverified.');
  return 0;
}
