import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What `login` stores. The session token is a bearer credential: the file is 0600. */
export interface Credentials { api: string; session: string; email?: string; saved_at: string }

/** $DOUBLEAGENT_CONFIG_DIR, else $XDG_CONFIG_HOME/doubleagent, else ~/.config/doubleagent. */
export function configDir(env: Record<string, string | undefined>): string {
  return env.DOUBLEAGENT_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'doubleagent');
}

export const credentialsPath = (env: Record<string, string | undefined>): string => join(configDir(env), 'credentials.json');

export function loadCredentials(env: Record<string, string | undefined>): Credentials | null {
  try {
    const c = JSON.parse(readFileSync(credentialsPath(env), 'utf8')) as Partial<Credentials>;
    return typeof c.session === 'string' && typeof c.api === 'string' ? (c as Credentials) : null;
  } catch { return null; }
}

export function saveCredentials(env: Record<string, string | undefined>, c: Credentials): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode is ignored when the file already existed
  return path;
}

export function deleteCredentials(env: Record<string, string | undefined>): void {
  rmSync(credentialsPath(env), { force: true });
}
