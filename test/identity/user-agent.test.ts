import { expect, it } from 'vitest';
import { agentReference } from '../../src/identity/reference';
import { agentUserAgent, parseAgentUserAgent } from '../../src/identity/user-agent';

const name = 'acme.shopping-assistant';
const ref = agentReference({ agent_name: name, token_id: '9007199254740993' });
const browser = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
it('round-trips unknown names and exact string references as declarations alongside a normal UA', () => {
  expect(parseAgentUserAgent(`${browser} ${agentUserAgent(name, ref.agent_ref)}`)).toEqual({ ...ref, source: 'user-agent', verification: 'declared' });
  expect(parseAgentUserAgent(`${browser} ${agentUserAgent(name)}`)).toMatchObject({ agent_name: name, agent_ref: null });
  expect(parseAgentUserAgent('acme.agent')).toMatchObject({ agent_name: 'acme.agent' });
  expect(parseAgentUserAgent('acme.agent/1.0 (nested (comment) with \\) escape)')).toMatchObject({ agent_name: 'acme.agent' });
});
it.each(['', browser, '(acme.agent/1)', 'Mozilla/5.0 (acme.agent/1.0)', 'https://acme.agent',
  'acme.agent/1.0 other.agent/2', 'acme.agent/1 acme.agent/1', 'acme.agent/', 'acme.agent/1/2',
  'acme.agent/1 (unclosed', 'acme.agent/1 (hi)junk', 'acme.agent/1\n', 'acme.agent/1 👋', 'x'.repeat(1025),
  'acme.agent/1 (ERC8004=bad)', 'acme.agent/1 (erc8004=eip155:1:bad:1)',
  'acme.agent/1 (erc8004=bad) (erc8004=bad)', 'acme.agent/1 (erc8004=eip155:1:0x1111111111111111111111111111111111111111:01)',
])('does not assign an ambiguous or malformed identity: %s', ua => expect(parseAgentUserAgent(ua)).toBeNull());
it('validates generated references', () => {
  expect(() => agentUserAgent(name, 'eip155:1:extra:parts:1')).toThrow();
  expect(() => agentUserAgent('invalid')).toThrow();
});
