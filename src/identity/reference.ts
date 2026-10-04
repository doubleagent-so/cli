/** The registry's display name is not an identifier. Keep names and on-chain references separate. */
export interface AgentReference {
  agent_name: string;
  agent_ref: string;
  chain_id: string;
  registry_address: string;
  token_id: string;
}

export const ETHEREUM_REGISTRIES = {
  chain_id: '1',
  identity: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  reputation: '0x8004baa17c55a88189ae136b182e5fda19de9b63',
} as const;

export class IdentityInputError extends Error {}
function uintString(value: unknown, name: string, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n || (positive && value === '0'))
    throw new IdentityInputError(`${name} must be a canonical ${positive ? 'positive ' : ''}decimal string (uint256).`);
  return value;
}
export function address(value: unknown, name = 'registry_address'): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    throw new IdentityInputError(`${name} must be a nonzero Ethereum address.`);
  return value.toLowerCase() as `0x${string}`;
}
export function agentName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(value))
    throw new IdentityInputError('agent_name must follow operator.agent-name, for example acme.shopping-assistant.');
  return value;
}
export function agentReference(raw: Record<string, unknown>): AgentReference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IdentityInputError('Agent identity must be an object.');
  const agent_name = agentName(raw.agent_name);
  const chain_id = uintString(raw.chain_id ?? '1', 'chain_id', true);
  if (raw.registry_address === undefined && chain_id !== '1') throw new IdentityInputError('Supply registry_address for this chain.');
  const registry_address = address(raw.registry_address ?? ETHEREUM_REGISTRIES.identity);
  const token_id = uintString(raw.token_id, 'token_id');
  return { agent_name, chain_id, registry_address, token_id, agent_ref: `eip155:${chain_id}:${registry_address}:${token_id}` };
}

export interface ReputationQuery {
  registry_address: string;
  reviewers: string[];
  tag1: string;
  tag2: string;
}
export function reputationQuery(raw: Record<string, unknown>, reference: AgentReference): ReputationQuery | null {
  if (raw.reviewers === undefined || (Array.isArray(raw.reviewers) && raw.reviewers.length === 0)) return null;
  if (!Array.isArray(raw.reviewers) || raw.reviewers.length > 5) throw new IdentityInputError('reviewers must contain 1–5 trusted reviewer addresses.');
  const reviewers = [...new Set(raw.reviewers.map((reviewer) => address(reviewer, 'reviewer')))];
  const registry = raw.reputation_registry ?? (reference.chain_id === '1' && reference.registry_address === ETHEREUM_REGISTRIES.identity ? ETHEREUM_REGISTRIES.reputation : undefined);
  const tags = [raw.tag1 ?? '', raw.tag2 ?? ''];
  if (tags.some((tag) => typeof tag !== 'string' || tag.length > 128)) throw new IdentityInputError('Reputation tags must be strings of at most 128 characters.');
  return { registry_address: address(registry, 'reputation_registry'), reviewers, tag1: tags[0] as string, tag2: tags[1] as string };
}
