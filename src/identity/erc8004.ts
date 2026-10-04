import { chainClient, RegistryError, type RegistryOptions } from './chain';
import { address, agentReference, reputationQuery, type AgentReference, type ReputationQuery } from './reference';

interface Feedback {
  reviewer: string;
  feedback_index: string;
  value: string;
  value_decimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}
export interface RegistrySnapshot extends AgentReference {
  standard: 'erc-8004';
  registry_status: 'registered';
  visit_binding: 'unverified';
  owner_address: string;
  agent_wallet: string | null;
  agent_uri: string;
  metadata_status: 'uri-only';
  block_number: string;
  block_hash: string;
  resolved_at: string;
  reputation: {
    query: ReputationQuery;
    count: string;
    value: string;
    value_decimals: number;
    feedback: Feedback[];
    feedback_limit_per_reviewer: 5;
    feedback_truncated: boolean;
  } | null;
  reputation_status: 'not-requested' | 'resolved' | 'unavailable';
  warnings: string[];
}
type RegistryRead = (to: string, signature: string, args?: readonly unknown[]) => Promise<unknown>;

/** Each reviewer's five newest reviews, and whether any reviewer had more. */
async function readFeedback(read: RegistryRead, query: ReputationQuery, token: bigint): Promise<{ feedback: Feedback[]; truncated: boolean }> {
  let truncated = false;
  const perReviewer = await Promise.all(query.reviewers.map(async (reviewer) => {
    const last = await read(query.registry_address, 'function getLastIndex(uint256,address) view returns (uint64)', [token, reviewer]) as bigint;
    if (last > 5n) truncated = true;
    const indexes = Array.from({ length: Number(last > 5n ? 5n : last) }, (_, i) => last - BigInt(i));
    return Promise.all(indexes.map(async (index): Promise<Feedback> => {
      const [rawValue, valueDecimals, tag1, tag2, revoked] = await read(query.registry_address,
        'function readFeedback(uint256,address,uint64) view returns (int128,uint8,string,string,bool)', [token, reviewer, index]) as [bigint, number, string, string, boolean];
      if (valueDecimals > 18 || tag1.length > 1024 || tag2.length > 1024) throw new RegistryError('invalid_reputation', 'Unsupported feedback data.');
      return { reviewer, feedback_index: index.toString(), value: rawValue.toString(), value_decimals: valueDecimals, tag1, tag2, revoked };
    }));
  }));
  return { feedback: perReviewer.flat(), truncated };
}

/** The reviewers' summary and newest reviews, filtered to the query's tags. */
async function readReputation(read: RegistryRead, identityRegistry: string, query: ReputationQuery, token: bigint): Promise<NonNullable<RegistrySnapshot['reputation']>> {
  const identity = await read(query.registry_address, 'function getIdentityRegistry() view returns (address)');
  if (address(identity) !== identityRegistry) throw new RegistryError('wrong_registry', 'Reputation registry belongs to a different identity registry.');
  const [count, value, decimals] = await read(query.registry_address,
    'function getSummary(uint256,address[],string,string) view returns (uint64,int128,uint8)',
    [token, query.reviewers, query.tag1, query.tag2]) as [bigint, bigint, number];
  if (decimals > 18) throw new RegistryError('invalid_reputation', 'Unsupported reputation scale.');
  const { feedback, truncated } = await readFeedback(read, query, token);
  const matching = feedback.filter((item) => (!query.tag1 || item.tag1 === query.tag1) && (!query.tag2 || item.tag2 === query.tag2));
  return { query, count: count.toString(), value: value.toString(), value_decimals: decimals, feedback: matching, feedback_limit_per_reviewer: 5, feedback_truncated: truncated };
}

/** The token's owner, wallet and URI at the pinned block; reputation is filled in afterwards. */
function registeredSnapshot(reference: AgentReference, token: { owner: unknown; uri: unknown; wallet: unknown }, pinned: { number: bigint; hash: string }, now: number): RegistrySnapshot {
  const { owner, uri, wallet } = token;
  if (typeof uri !== 'string' || uri.length > 16384) throw new RegistryError('invalid_metadata', 'Agent URI exceeded the supported size.');
  return {
    ...reference, standard: 'erc-8004', registry_status: 'registered', visit_binding: 'unverified',
    owner_address: address(owner, 'owner'), agent_wallet: wallet === '0x0000000000000000000000000000000000000000' ? null : address(wallet, 'agent_wallet'),
    agent_uri: uri, metadata_status: 'uri-only', block_number: pinned.number.toString(), block_hash: pinned.hash,
    resolved_at: new Date(now).toISOString(), reputation: null, reputation_status: 'not-requested', warnings: [],
  };
}

/** Read-only, finalized-block lookup. A registered token does not authenticate a website visit. */
export async function resolveAgent(raw: Record<string, unknown>, options: RegistryOptions): Promise<RegistrySnapshot> {
  const reference = agentReference(raw);
  const reputation = reputationQuery(raw, reference);
  const client = chainClient(options);
  try {
    if (await client.chainId() !== reference.chain_id) throw new RegistryError('wrong_chain', 'RPC chain ID does not match the requested registry.');
    const pinned = await client.block(options.blockTag ?? 'finalized');
    const read = (to: string, signature: string, args: readonly unknown[] = []) => client.call(to, signature, args, pinned.number);
    const token = BigInt(reference.token_id);
    const [owner, uri, wallet] = await Promise.all([
      read(reference.registry_address, 'function ownerOf(uint256) view returns (address)', [token]),
      read(reference.registry_address, 'function tokenURI(uint256) view returns (string)', [token]),
      read(reference.registry_address, 'function getAgentWallet(uint256) view returns (address)', [token]),
    ]);
    const snapshot = registeredSnapshot(reference, { owner, uri, wallet }, pinned, options.now?.() ?? Date.now());
    if (reputation) {
      try {
        snapshot.reputation = await readReputation(read, reference.registry_address, reputation, token);
        snapshot.reputation_status = 'resolved';
      } catch {
        snapshot.reputation_status = 'unavailable';
        snapshot.warnings.push('Reputation could not be resolved. No rating was substituted.');
      }
    }
    // Detect an inconsistent provider/reorg before retaining the snapshot.
    const confirm = await client.rpc('eth_getBlockByNumber', [`0x${pinned.number.toString(16)}`, false]) as { hash?: string } | null;
    if (confirm?.hash?.toLowerCase() !== snapshot.block_hash) throw new RegistryError('block_changed', 'Registry block changed during lookup; retry.');
    return snapshot;
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(client.signal.aborted ? 'rpc_timeout' : 'registry_unavailable', 'Could not resolve the registry with the configured RPC.', { cause: error });
  } finally { client.close(); }
}
