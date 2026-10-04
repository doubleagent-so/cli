import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgent } from '../../src/identity/erc8004';
import { agentName, agentReference, reputationQuery, ETHEREUM_REGISTRIES } from '../../src/identity/reference';
import { registryRpc, HASH, OWNER, REVIEWER } from './rpc';
const raw = { agent_name: 'acme.shopping-assistant', token_id: '9007199254740993' };
const rpcUrl = 'https://rpc.example/private-api-key';
afterEach(() => vi.useRealTimers());

describe('string identity conventions', () => {
  it('keeps conventional names independent of the catalog and preserves uint256 IDs exactly', () => {
    const ref = agentReference(raw);
    expect(ref.agent_ref).toBe(`eip155:1:${ETHEREUM_REGISTRIES.identity}:9007199254740993`);
    expect(agentName('new-operator.brand-new-agent')).toBe('new-operator.brand-new-agent');
    expect(agentReference({ ...raw, chain_id: '8453', registry_address: OWNER.toUpperCase().replace('0X', '0x') }).chain_id).toBe('8453');
    expect(reputationQuery({}, ref)).toBeNull();
    expect(reputationQuery({ reviewers: [] }, ref)).toBeNull();
    expect(reputationQuery({ reviewers: [REVIEWER, REVIEWER] }, ref)?.reviewers).toEqual([REVIEWER]);
  });
  it.each([null, [], { ...raw, token_id: 22 }, { ...raw, token_id: '01' }, { ...raw, token_id: '-1' },
    { ...raw, token_id: (2n ** 256n).toString() }, { ...raw, chain_id: '0' }, { ...raw, agent_name: 'Friendly Agent' },
    { ...raw, registry_address: '0x' + '0'.repeat(40) }, { ...raw, chain_id: '8453' }])('rejects invalid references: %j', (value) => {
    expect(() => agentReference(value as any)).toThrow();
  });
  it('requires explicit reviewers and a matching-chain reputation configuration', () => {
    const ref = agentReference(raw);
    for (const query of [{ reviewers: 'everyone' }, { reviewers: [REVIEWER], tag1: 'x'.repeat(129) }, { reviewers: Array(6).fill(REVIEWER) }, { reviewers: ['invalid'] }])
      expect(() => reputationQuery(query, ref)).toThrow();
    expect(() => reputationQuery({ reviewers: [REVIEWER] }, { ...ref, chain_id: '8453' })).toThrow();
  });
});

describe('bounded registry reads', () => {
  it('pins calls to a finalized block, never fetches metadata and never verifies the visit', async () => {
    const rpc = registryRpc();
    const result = await resolveAgent(raw, { rpcUrl, fetcher: rpc.fetcher, now: () => 0 });
    expect(result).toMatchObject({ agent_name: raw.agent_name, token_id: raw.token_id, owner_address: OWNER, agent_wallet: OWNER,
      block_number: '256', block_hash: HASH, visit_binding: 'unverified', reputation: null, resolved_at: '1970-01-01T00:00:00.000Z' });
    expect(rpc.calls.every((call) => call.url === rpcUrl)).toBe(true);
    expect(rpc.calls.filter((call) => call.method === 'eth_call').every((call) => call.params[1] === '0x100')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-api-key');
  });
  it('preserves signed values, scales, reviewer scope and revocations; bounds feedback reads', async () => {
    const rpc = registryRpc({ getSummary: [7n, -1234n, 2], getLastIndex: 7n, readFeedback: [-1234n, 2, 'successRate', 'day', true], getAgentWallet: '0x' + '0'.repeat(40) });
    const result = await resolveAgent({ ...raw, reviewers: [REVIEWER], tag1: 'successRate', tag2: 'day' }, { rpcUrl, fetcher: rpc.fetcher });
    expect(result.agent_wallet).toBeNull();
    expect(result.reputation).toMatchObject({ value: '-1234', value_decimals: 2, count: '7', feedback_truncated: true });
    expect(result.reputation?.feedback).toHaveLength(5);
    expect(result.reputation?.feedback[0]).toMatchObject({ revoked: true, feedback_index: '7' });
  });
  it('retains identity on a reputation failure, never substituting a zero rating', async () => {
    for (const overrides of [{ getIdentityRegistry: REVIEWER }, { getSummary: [1n, 10n, 19] }, { readFeedback: [1n, 19, '', '', false] }]) {
      const result = await resolveAgent({ ...raw, reviewers: [REVIEWER] }, { rpcUrl, fetcher: registryRpc(overrides).fetcher });
      expect(result).toMatchObject({ registry_status: 'registered', reputation: null, reputation_status: 'unavailable' });
    }
    const result = await resolveAgent({ ...raw, reviewers: [REVIEWER], tag1: 'other' }, { rpcUrl, fetcher: registryRpc().fetcher });
    expect(result.reputation?.feedback).toEqual([]);
  });
  it.each([
    ['wrong_chain', (c: any) => c.method === 'eth_chainId' ? { result: '0x2' } : null],
    ['invalid_block', (c: any) => c.method === 'eth_getBlockByNumber' ? { result: null } : null],
    ['block_changed', (c: any) => c.method === 'eth_getBlockByNumber' && c.params[0] === '0x100' ? { result: { hash: 'different' } } : null],
    ['rpc_error', (_c: any) => ({ error: { message: 'secret provider error' } })],
    ['invalid_contract', (c: any) => c.method === 'eth_call' ? { result: '0x' } : null],
  ])('rejects %s', async (code, change) => {
    const rpc = registryRpc({}, (c) => { const body = change(c); return body ? Response.json({ id: c.id, jsonrpc: '2.0', ...body }) : undefined; });
    await expect(resolveAgent(raw, { rpcUrl, fetcher: rpc.fetcher })).rejects.toMatchObject({ code });
  });
  it('caps responses, handles RPC failures and does not expose provider details', async () => {
    for (const [response, code] of [[new Response('x'.repeat(131073)), 'rpc_response_too_large'], [new Response('', { status: 500 }), 'rpc_unavailable'], [new Response('invalid JSON'), 'registry_unavailable']] as const) {
      await expect(resolveAgent(raw, { rpcUrl, fetcher: async () => response })).rejects.toMatchObject({ code });
    }
    await expect(resolveAgent(raw, { rpcUrl, fetcher: registryRpc({ tokenURI: 'x'.repeat(16385) }).fetcher })).rejects.toMatchObject({ code: 'invalid_metadata' });
    for (const value of ['bad', 'http://rpc.example', 'https://name:password@rpc.example'])
      await expect(resolveAgent(raw, { rpcUrl: value })).rejects.toMatchObject({ code: 'rpc_configuration' });
  });
  it('bounds lookup lifetime and supports cancellation', async () => {
    vi.useFakeTimers();
    const pending = resolveAgent(raw, { rpcUrl, fetcher: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(Error('cancelled'))); }) });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'rpc_timeout' });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    await expect(resolveAgent(raw, { rpcUrl, signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
