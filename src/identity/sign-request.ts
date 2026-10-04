import { createSignerClient } from '@slicekit/erc8128';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

/** Node-side simulation signer. The private key is never passed into a browser or report. */
export function simulationSigner(privateKey: string | undefined, chainId: string, apiOrigin: string, targetHost: string) {
  if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('Set DOUBLEAGENT_ETHEREUM_PRIVATE_KEY to a signing wallet private key (0x + 64 hex digits).');
  if (!/^[1-9][0-9]*$/.test(chainId) || !Number.isSafeInteger(Number(chainId))) throw new Error('Signing chain ID must be a positive safe integer.');
  const url = new URL(apiOrigin);
  if (url.protocol !== 'https:' || url.origin !== apiOrigin) throw new Error('--sign-api must be an exact HTTPS origin, without a path or trailing slash.');
  let account;
  try { account = privateKeyToAccount(privateKey as Hex); } catch { throw new Error('Invalid Ethereum signing key.'); }
  const signer = createSignerClient({ address: account.address, chainId: Number(chainId), signMessage: raw => account.signMessage({ message: { raw } }) });
  return async (request: Request): Promise<Request | null> => {
    const endpoint = new URL(request.url);
    if (endpoint.origin !== apiOrigin || !['/v1/collect', '/v1/check'].includes(endpoint.pathname) || request.method !== 'POST') return null;
    const origin = new URL(request.headers.get('origin') ?? '');
    const body = await request.clone().text();
    if (body.length > 65536 || new URL(origin).host !== targetHost || JSON.parse(body)?.page?.host !== targetHost) throw new Error('Refused to sign telemetry for a different website or an oversized body.');
    return signer.signRequest(request, { binding: 'request-bound', ttlSeconds: 60, components: ['user-agent', 'origin'] });
  };
}
