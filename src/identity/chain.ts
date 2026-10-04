import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from 'viem';

// A read-only JSON-RPC client for registry lookups: HTTPS only, bounded responses, one timeout for
// the whole lookup, and contract reads pinned to one block so every answer describes the same state.

export class RegistryError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) { super(message, options); }
}

export interface RegistryOptions {
  rpcUrl: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  blockTag?: 'finalized' | 'latest';
  /** Whole-lookup budget; the default suits a dashboard request. */
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 131072;

/** RPC responses are capped before parsing/ABI decoding; registry metadata URLs are never fetched here. */
async function boundedJson(response: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> {
  if (!response.ok || !response.body) throw new RegistryError('rpc_unavailable', 'The configured RPC did not return a successful response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      // A stream is read chunk by chunk, in order.
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RegistryError('rpc_response_too_large', `RPC response exceeded ${Math.round(maxBytes / 1024)} KiB.`);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

interface Block { number: bigint; hash: string; timestamp: number | null }

interface ChainClient {
  signal: AbortSignal;
  rpc: (method: string, params: unknown[], maxBytes?: number) => Promise<unknown>;
  chainId: () => Promise<string>;
  block: (tag: string | bigint) => Promise<Block>;
  /** A view call at `block`; `signature` is one human-readable ABI function. */
  call: (to: string, signature: string, args: readonly unknown[], block: bigint, maxBytes?: number) => Promise<unknown>;
  close: () => void;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;
const abis = new Map<string, Abi>();

export function chainClient(options: RegistryOptions): ChainClient {
  let rpcUrl: URL;
  try { rpcUrl = new URL(options.rpcUrl); } catch { throw new RegistryError('rpc_configuration', 'Configure an HTTPS Ethereum RPC URL.'); }
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password) throw new RegistryError('rpc_configuration', 'The configured RPC must use HTTPS without embedded credentials.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 15000);
  let requestId = 0;

  const rpc = async (method: string, params: unknown[], maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> => {
    const id = ++requestId;
    const response = await (options.fetcher ?? fetch)(rpcUrl.href, {
      // Workers reject redirect: 'error'; with 'manual' a 3xx is !ok and fails in boundedJson.
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = await boundedJson(response, maxBytes) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
    if (!body || body.id !== id || body.jsonrpc !== '2.0' || body.error || !('result' in body))
      throw new RegistryError('rpc_error', 'RPC rejected a registry read or returned an invalid response.');
    return body.result;
  };

  const block = async (tag: string | bigint): Promise<Block> => {
    const found = await rpc('eth_getBlockByNumber', [typeof tag === 'bigint' ? hex(tag) : tag, false]) as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
    if (!found || typeof found.number !== 'string' || !/^0x[0-9a-f]+$/i.test(found.number) || typeof found.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(found.hash))
      throw new RegistryError('invalid_block', 'RPC must support finalized block lookups.');
    const timestamp = typeof found.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(found.timestamp) ? Number(BigInt(found.timestamp)) : null;
    return { number: BigInt(found.number), hash: found.hash.toLowerCase(), timestamp };
  };

  const call = async (to: string, signature: string, args: readonly unknown[], at: bigint, maxBytes?: number): Promise<unknown> => {
    let abi = abis.get(signature);
    if (!abi) { abi = parseAbi([signature]) as Abi; abis.set(signature, abi); }
    const functionName = signature.match(/^function (\w+)/)![1];
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await rpc('eth_call', [{ to, data }, hex(at)], maxBytes);
    if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(result)) throw new RegistryError('invalid_contract', 'Registry returned empty or malformed contract data.');
    return decodeFunctionResult({ abi, functionName, data: result as Hex });
  };

  const chainId = async () => {
    const chain = await rpc('eth_chainId', []);
    if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain)) throw new RegistryError('wrong_chain', 'RPC chain ID does not match the requested registry.');
    return BigInt(chain).toString();
  };

  return {
    signal: controller.signal, rpc, chainId, block, call,
    close: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); },
  };
}
