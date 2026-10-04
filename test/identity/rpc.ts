import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { ETHEREUM_REGISTRIES } from '../../src/identity/reference';

export const OWNER = '0x1111111111111111111111111111111111111111';
export const REVIEWER = '0x2222222222222222222222222222222222222222';
export const HASH = '0x' + 'ab'.repeat(32);
const abi = parseAbi([
  'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)',
  'function getAgentWallet(uint256) view returns (address)', 'function getIdentityRegistry() view returns (address)',
  'function getSummary(uint256,address[],string,string) view returns (uint64,int128,uint8)',
  'function getLastIndex(uint256,address) view returns (uint64)',
  'function readFeedback(uint256,address,uint64) view returns (int128,uint8,string,string,bool)',
]);
export interface RpcCall { url: string; id: number; method: string; params: any[]; name?: string }
/** A fake ERC-8004 JSON-RPC provider. `overrides` replace contract results by function name (a function receives the decoded args). */
export function registryRpc(overrides: Record<string, unknown> = {}, intercept?: (call: RpcCall) => Response | undefined) {
  const calls: RpcCall[] = [];
  const defaults: Record<string, unknown> = { ownerOf: OWNER, tokenURI: 'https://metadata.example/agent.json', getAgentWallet: OWNER,
    getIdentityRegistry: ETHEREUM_REGISTRIES.identity, getSummary: [2n, 9977n, 2], getLastIndex: 2n,
    readFeedback: [9977n, 2, 'successRate', 'day', false] };
  const contractResult = (decoded: { functionName: string; args: unknown }) => {
    const chosen = decoded.functionName in overrides ? overrides[decoded.functionName] : defaults[decoded.functionName];
    return encodeFunctionResult({ abi, functionName: decoded.functionName as never, result: (typeof chosen === 'function' ? chosen(decoded.args) : chosen) as never });
  };
  const rpcResult = (call: RpcCall, decoded: { functionName: string; args: unknown } | undefined): unknown => {
    if (call.method === 'eth_chainId') return '0x1';
    if (call.method === 'eth_getBlockByNumber') return { number: call.params[0] === 'finalized' || call.params[0] === 'latest' ? '0x100' : call.params[0], hash: HASH, timestamp: '0x6970e000' };
    if (decoded) return contractResult(decoded);
    throw new Error('Unexpected RPC method ' + call.method);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    const call: RpcCall = { url: String(input), ...body };
    const decoded = body.method === 'eth_call' ? decodeFunctionData({ abi, data: body.params[0].data }) : undefined;
    if (decoded) call.name = decoded.functionName;
    calls.push(call);
    const intercepted = intercept?.(call); if (intercepted) return intercepted;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: rpcResult(call, decoded) });
  };
  return { fetcher, calls };
}
