import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDir, credentialsPath, deleteCredentials, loadCredentials, saveCredentials } from '../src/config';
import { cli, fakeApi } from './helpers';

const tmp = () => mkdtempSync(join(tmpdir(), 'da-cfgt-'));
const creds = { api: 'https://api.test', session: 'das_1', saved_at: 'now' };

describe('credential store', () => {
  it('resolves $DOUBLEAGENT_CONFIG_DIR, then $XDG_CONFIG_HOME, then $HOME/.config, then homedir()', () => {
    expect(configDir({ DOUBLEAGENT_CONFIG_DIR: '/x/da', XDG_CONFIG_HOME: '/xdg' })).toBe('/x/da');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' })).toBe('/xdg/doubleagent');
    expect(configDir({ XDG_CONFIG_HOME: '', HOME: '/h' })).toBe('/h/.config/doubleagent');
    expect(configDir({})).toBe(join(homedir(), '.config', 'doubleagent'));
    expect(credentialsPath({ DOUBLEAGENT_CONFIG_DIR: '/x' })).toBe('/x/credentials.json');
  });

  it('writes the file 0600 inside a 0700 directory, and keeps 0600 when re-saving over a wider file', () => {
    const base = tmp();
    const env = { XDG_CONFIG_HOME: base };
    const path = saveCredentials(env, creds);
    expect(path).toBe(join(base, 'doubleagent', 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, 'doubleagent')).mode & 0o777).toBe(0o700);
    chmodSync(path, 0o644);
    saveCredentials(env, { ...creds, session: 'das_2' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadCredentials(env)?.session).toBe('das_2');
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('treats missing, corrupt or incomplete files as logged out; delete is idempotent', () => {
    const dir = tmp();
    const env = { DOUBLEAGENT_CONFIG_DIR: dir };
    expect(loadCredentials(env)).toBeNull();
    writeFileSync(join(dir, 'credentials.json'), '{not json');
    expect(loadCredentials(env)).toBeNull();
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ session: 'das_x' }));
    expect(loadCredentials(env)).toBeNull();
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ api: 'a', session: 5 }));
    expect(loadCredentials(env)).toBeNull();
    deleteCredentials(env);
    deleteCredentials(env);
    expect(() => statSync(join(dir, 'credentials.json'))).toThrow();
  });

  it('commands: corrupt file → not logged in; DOUBLEAGENT_SESSION works without a file; saved api is used', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), 'garbage');
    expect((await cli(['sites'], { env: { DOUBLEAGENT_CONFIG_DIR: dir } })).err).toMatch(/not logged in/);

    const api = fakeApi({ 'GET /v1/me': () => ({ body: { accounts: [] } }) });
    await cli(['sites', '--api', 'https://override.test'], { env: { DOUBLEAGENT_CONFIG_DIR: tmp(), DOUBLEAGENT_SESSION: 'das_env' }, fetch: api.fetch });
    expect(api.calls[0]).toEqual(expect.objectContaining({ path: '/v1/me', headers: expect.objectContaining({ authorization: 'Bearer das_env' }) }));

    const saved = tmp();
    saveCredentials({ DOUBLEAGENT_CONFIG_DIR: saved }, { ...creds, api: 'https://saved.test/' });
    const seen: string[] = [];
    const f = (async (u: string) => { seen.push(u); return Response.json({ accounts: [] }); }) as unknown as typeof fetch;
    await cli(['sites'], { env: { DOUBLEAGENT_CONFIG_DIR: saved }, fetch: f });
    await cli(['sites'], { env: { DOUBLEAGENT_CONFIG_DIR: saved, DOUBLEAGENT_API: 'https://env.test' }, fetch: f });
    expect(seen).toEqual(['https://saved.test/v1/me', 'https://env.test/v1/me']);
  });
});
