import { createSignerClient } from '@slicekit/erc8128';
import { privateKeyToAccount } from 'viem/accounts';

// Public disposable test key, never funded or used outside fixtures.
export const KEY = `0x${'01'.repeat(32)}`;
export const account = privateKeyToAccount(KEY as `0x${string}`);
export const signer = createSignerClient({ address: account.address, chainId: 1, signMessage: raw => account.signMessage({ message: { raw } }) });

/** A simulated SDK collection request from shop.example. */
export function collectRequest(url = 'https://api.example/v1/collect?key=pk_test', origin = 'https://shop.example') {
  return new Request(url, { method: 'POST',
    headers: { 'user-agent': 'acme.shopping-assistant/1.0', origin, 'content-type': 'application/json' }, body: JSON.stringify({ page: { host: 'shop.example' } }) });
}
