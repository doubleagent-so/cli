import { expect, it } from 'vitest';
import { cli, fakeApi, fixture, loggedIn, read } from './helpers';
import { registryRpc, REVIEWER } from './identity/rpc';
const identity = ['--agent-name', 'acme.shopping-assistant', '--token-id', '9007199254740993'];

it('resolves and exports precise references with opt-in reputation and redacted provider configuration', async () => {
  const cwd = fixture({}), rpc = registryRpc();
  const result = await cli(['agents', 'resolve', ...identity, '--reviewers', REVIEWER, '--tag1', 'successRate', '--output', 'nested/identity.json', '--json'],
    { cwd, fetch: rpc.fetcher, env: { DOUBLEAGENT_ETHEREUM_RPC_URL: 'https://rpc.example/private-key' } });
  expect(result.code).toBe(0);
  expect(result.json).toMatchObject({ token_id: '9007199254740993', agent_name: 'acme.shopping-assistant', visit_binding: 'unverified', reputation_status: 'resolved' });
  expect(result.out).not.toContain('private-key');
  expect(JSON.parse(read(cwd, 'nested/identity.json'))).toEqual(result.json);
  const human = await cli(['agents', 'resolve', ...identity], { fetch: rpc.fetcher, env: { DOUBLEAGENT_ETHEREUM_RPC_URL: 'https://rpc.example' } });
  expect(human.out).toContain('Website visit identity remains unverified');
});

it('saves, filters and removes tenant associations using login credentials instead of a local RPC', async () => {
  const env = loggedIn(), api = fakeApi({
    'POST /v1/sites/st_one/agent-identities': ({ body, headers }) => {
      expect(body.agent_name).toBe('acme.shopping-assistant'); expect(headers.authorization).toBe('Bearer das_session'); return { body: { id: 'ari_one' } };
    },
    'GET /v1/sites/st_one/agent-identities': () => ({ body: { identities: [] } }),
    'DELETE /v1/sites/st_one/agent-identities/ari_one': () => ({ status: 204 }),
  });
  expect((await cli(['agents', 'resolve', ...identity, '--site', 'st_one', '--json'], { env, fetch: api.fetch })).json).toEqual({ id: 'ari_one' });
  expect((await cli(['agents', 'list', '--site', 'st_one', '--agent-name', 'acme.shopping-assistant', '--json'], { env, fetch: api.fetch })).json).toEqual({ identities: [] });
  expect(api.calls[1].path).toContain('?agent_name=acme.shopping-assistant');
  expect((await cli(['agents', 'list', '--site', 'st_one', '--json'], { env, fetch: api.fetch })).code).toBe(0);
  expect((await cli(['agents', 'remove', 'ari_one', '--site', 'st_one', '--json'], { env, fetch: api.fetch })).json).toEqual({ removed: 'ari_one' });
});

it.each([
  ['resolve', ...identity], ['resolve', '--agent-name', 'bad', '--token-id', '1'],
  ['resolve', ...identity, '--reviewers', 'bad'], ['list'], ['remove', '--site', 'st_one'],
  ['unknown'], ['list', 'extra'], ['list', '--unknown'], ['list', '--site'], ['list', '--json=false'],
])('rejects invalid or incomplete arguments: %j', async (...args) => {
  const result = await cli(['agents', ...args]); expect(result.code).not.toBe(0);
});

it('reports network failures without leaking the RPC URL', async () => {
  const result = await cli(['agents', 'resolve', ...identity, '--json'], { env: { DOUBLEAGENT_ETHEREUM_RPC_URL: 'https://rpc.example/secret' }, fetch: async () => { throw new Error('secret'); } });
  expect(result.code).not.toBe(0); expect(result.json.error).not.toContain('secret');
});
