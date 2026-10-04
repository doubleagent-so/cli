import { createVerifierClient } from '@slicekit/erc8128';
import { verifyMessage } from 'viem';
import { expect, it } from 'vitest';
import { simulationSigner } from '../../src/identity/sign-request';
import { account, collectRequest, KEY } from './signer';

const verify = (request: Request) => createVerifierClient({ verifyMessage: (args) => verifyMessage(args), nonceStore: { consume: async () => true } })
  .verifyRequest({ request, policy: { accountVerification: 'eoa-only', replayable: false, requiredCoveredHeadersWhenPresent: ['user-agent', 'origin'] } });

it('signs only POSTs to the telemetry endpoints of the given API, bound to the request', async () => {
  const sign = simulationSigner(KEY, '1', 'https://api.example', 'shop.example');
  const signed = await sign(collectRequest());
  expect(signed?.headers.get('signature-input')).toMatch(/erc8128/);
  expect(await verify(signed!)).toMatchObject({ ok: true, principal: { address: account.address.toLowerCase(), chainId: 1 } });
  expect(await sign(collectRequest('https://api.example/v1/check'))).not.toBeNull();
  for (const path of ['https://evil.example/v1/collect', 'https://api.example/payment', 'https://api.example/v1/collect/extra'])
    expect(await sign(collectRequest(path))).toBeNull();
  expect(await sign(new Request('https://api.example/v1/collect'))).toBeNull();
});

it('refuses to sign telemetry for another website or an oversized body', async () => {
  const sign = simulationSigner(KEY, '1', 'https://api.example', 'shop.example');
  await expect(sign(collectRequest(undefined, 'https://evil.example'))).rejects.toThrow('different website');
  const big = new Request('https://api.example/v1/collect', { method: 'POST', headers: { origin: 'https://shop.example' }, body: 'x'.repeat(65537) });
  await expect(sign(big)).rejects.toThrow('oversized body');
});

it.each([
  [undefined, '1', 'https://api.example', /DOUBLEAGENT_ETHEREUM_PRIVATE_KEY/],
  [KEY, '0', 'https://api.example', /positive safe integer/],
  [KEY, '1', 'http://api.example', /exact HTTPS origin/],
  [KEY, '1', 'https://api.example/path', /exact HTTPS origin/],
  [`0x${'00'.repeat(32)}`, '1', 'https://api.example', /Invalid Ethereum signing key/],
])('rejects an unusable key, chain or API origin (%s, %s, %s)', (key, chain, api, message) => {
  expect(() => simulationSigner(key, chain, api, 'shop.example')).toThrow(message);
});
