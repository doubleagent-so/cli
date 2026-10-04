import { createApi, DEFAULT_API, DEFAULT_PORTAL, type Api } from './api';
import { loadCredentials, type Credentials } from './config';

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  out(s: string): void;
  err(s: string): void;
  /** Interactive confirmation; absent when not attached to a TTY. */
  confirm?(question: string): Promise<boolean>;
  fetch?: typeof fetch;
  /** Injected for tests (device-flow polling). */
  sleep?(ms: number): Promise<void>;
}

export interface Args { cmd?: string; pos: string[]; flags: Record<string, string | boolean> }

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'CliError'; }
}

export const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** --api, else $DOUBLEAGENT_API, else the API saved at login, else production. */
export const apiBase = (args: Args, io: Io, creds?: Credentials | null): string =>
  (str(args.flags.api) ?? io.env.DOUBLEAGENT_API ?? creds?.api ?? DEFAULT_API).replace(/\/+$/, '');

export const portalBase = (args: Args, io: Io): string =>
  (str(args.flags.portal) ?? io.env.DOUBLEAGENT_PORTAL ?? DEFAULT_PORTAL).replace(/\/+$/, '');

export const anonApi = (args: Args, io: Io): Api => createApi(apiBase(args, io, loadCredentials(io.env)), undefined, io.fetch);

/** Session-authenticated client; commands that need it fail with a login hint. */
export function sessionApi(args: Args, io: Io): { api: Api; creds: Credentials } {
  const creds = loadCredentials(io.env);
  const session = io.env.DOUBLEAGENT_SESSION ?? creds?.session;
  if (!session) throw new CliError('not logged in: run `npx @doubleagent-so/cli login` first (or set DOUBLEAGENT_SESSION)');
  const c: Credentials = creds ?? { api: apiBase(args, io), session, saved_at: '' };
  return { api: createApi(apiBase(args, io, creds), session, io.fetch), creds: c };
}

export const json = (io: Io, v: unknown): void => io.out(JSON.stringify(v, null, 2));
