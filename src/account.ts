import { ApiError, createApi, type Api } from './api';
import { deleteCredentials, loadCredentials, saveCredentials } from './config';
import { anonApi, CliError, json, sessionApi, str, type Args, type Io } from './io';
import { difficultyFrom, solve } from './pow';

const sleep = (io: Io, ms: number): Promise<void> => (io.sleep ? io.sleep(ms) : new Promise((r) => { setTimeout(r, ms); }));

// ---- login / logout ---------------------------------------------------------------------------

interface DeviceStart { device_code: string; user_code: string; verify_url: string; interval?: number; expires_in?: number }

interface DeviceToken { session: string; user?: { email?: string } }

/** One poll for the approved session: the session, or 'pending' / 'slow_down' while the human hasn't approved it. */
async function pollDeviceToken(api: Api, deviceCode: string): Promise<DeviceToken | 'pending' | 'slow_down'> {
  try {
    const { data } = await api.request<Partial<DeviceToken>>('POST', '/v1/auth/device/token', { device_code: deviceCode });
    if (!data?.session) throw new CliError('unexpected /v1/auth/device/token response');
    return data as DeviceToken;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 428 || e.code === 'authorization_pending') return 'pending';
    if (e.status === 429 || e.code === 'slow_down') return 'slow_down';
    if (e.status === 410 || e.code === 'expired') throw new CliError('the code expired before it was approved; run `npx @doubleagent-so/cli login` again');
    throw e;
  }
}

async function saveLogin(api: Api, token: DeviceToken, io: Io, asJson: boolean): Promise<void> {
  const email = token.user?.email ?? (await whoami(api.base, token.session, io));
  const path = saveCredentials(io.env, { api: api.base, session: token.session, email, saved_at: new Date().toISOString() });
  if (asJson) json(io, { ok: true, email: email ?? null, credentials: path });
  else io.out(`Logged in${email ? ` as ${email}` : ''}. Session saved to ${path}`);
}

/** Device flow: show a code, the human approves it in the portal, we poll for the session. */
export async function login(args: Args, io: Io): Promise<number> {
  const api = anonApi(args, io);
  const { data: d } = await api.request<DeviceStart>('POST', '/v1/auth/device', {});
  if (!d?.device_code || !d.user_code || !d.verify_url) throw new CliError('unexpected /v1/auth/device response');
  const asJson = !!args.flags.json;
  if (asJson) io.err(JSON.stringify({ verify_url: d.verify_url, user_code: d.user_code }));
  else io.out(`Open ${d.verify_url} and confirm the code ${d.user_code}\nWaiting for approval…`);

  await saveLogin(api, await waitForApproval(api, d, io), io, asJson);
  return 0;
}

/** Polls at the server's interval, slowing down when asked, until approval or the code's expiry. */
async function waitForApproval(api: Api, d: DeviceStart, io: Io): Promise<DeviceToken> {
  let interval = Math.max(1, d.interval ?? 5) * 1000;
  const deadline = Date.now() + (d.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(io, interval);
    const token = await pollDeviceToken(api, d.device_code);
    if (token === 'slow_down') interval += 5000;
    else if (token !== 'pending') return token;
  }
  throw new CliError('timed out waiting for approval');
}

async function whoami(base: string, session: string, io: Io): Promise<string | undefined> {
  try { return (await createApi(base, session, io.fetch).request<Me>('GET', '/v1/me')).data?.user?.email; } catch { return undefined; }
}

export async function logout(args: Args, io: Io): Promise<number> {
  const creds = loadCredentials(io.env);
  if (creds) {
    try { await sessionApi(args, io).api.request('POST', '/v1/auth/logout', { all: !!args.flags.all }); } catch { /* best effort */ }
  }
  deleteCredentials(io.env);
  if (args.flags.json) json(io, { ok: true });
  else io.out(creds ? 'Logged out.' : 'Not logged in.');
  return 0;
}

// ---- sites ------------------------------------------------------------------------------------

export interface MeSite { id: string; name?: string; status?: string; domains?: (string | { hostname: string; verified_at?: string | null })[] }
export interface Me { user?: { email?: string }; accounts?: { id: string; name?: string; role?: string; sites?: MeSite[] }[] }

const hostOf = (d: string | { hostname: string }): string => (typeof d === 'string' ? d : d.hostname);

export async function sites(args: Args, io: Io): Promise<number> {
  const { api } = sessionApi(args, io);
  const { data: me } = await api.request<Me>('GET', '/v1/me');
  if (args.flags.json) { json(io, me); return 0; }
  const accounts = me?.accounts ?? [];
  if (!accounts.length) io.out('No accounts yet. Create one with `npx @doubleagent-so/cli init --email you@example.com`.');
  for (const a of accounts) {
    io.out(`${a.name ?? a.id} (${a.id}${a.role ? `, ${a.role}` : ''})`);
    const list = a.sites ?? [];
    if (!list.length) io.out('  (no sites)');
    for (const s of list) io.out(`  ${s.id}  ${(s.status ?? '?').padEnd(10)}  ${s.name ?? ''}  ${(s.domains ?? []).map(hostOf).join(', ')}`);
  }
  return 0;
}

/** --site, else the only site the user can see. */
async function resolveSite(args: Args, api: Api): Promise<string> {
  const flag = str(args.flags.site);
  if (flag) return flag;
  const { data: me } = await api.request<Me>('GET', '/v1/me');
  const all = (me?.accounts ?? []).flatMap((a) => a.sites ?? []);
  if (all.length === 1) return all[0].id;
  if (!all.length) throw new CliError('no sites: create one with `npx @doubleagent-so/cli init --email you@example.com`');
  throw new CliError(`several sites: pass --site (${all.map((s) => s.id).join(', ')})`);
}

// ---- keys -------------------------------------------------------------------------------------

type Time = string | number;
interface KeyRow { id: string; kind?: string; env?: string; prefix?: string; public_key?: string | null; secret?: string; key?: string; created_at?: Time; revoked_at?: Time | null; expires_at?: Time | null; last_used_at?: Time | null }

const rowsOf = (d: unknown): KeyRow[] => (Array.isArray(d) ? d : ((d as { keys?: KeyRow[] })?.keys ?? [])) as KeyRow[];
/** The API returns the key flat (with `secret` once) and may also nest a summary under `key`: merge both. */
const keyRowOf = (r: unknown): KeyRow => {
  const { key, ...flat } = (r ?? {}) as KeyRow & { key?: unknown };
  return (key && typeof key === 'object' ? { ...(key as KeyRow), ...flat } : { ...flat, ...(typeof key === 'string' ? { key } : {}) }) as KeyRow;
};

const secretOf = (k: KeyRow): string | undefined => k.secret ?? (k.key?.startsWith('sk_') ? k.key : undefined);

/** The API sends unix seconds; older shapes sent strings. */
const when = (t: string | number): string => (typeof t === 'number' ? new Date(t * 1000).toISOString() : t);

function printKey(io: Io, k: KeyRow): void {
  const expiry = k.expires_at ? `expires ${when(k.expires_at)}` : 'active';
    const state = k.revoked_at ? 'revoked' : expiry;
  io.out(`  ${k.id}  ${k.kind ?? '?'}_${k.env ?? '?'}  ${k.public_key ?? k.prefix ?? ''}  ${state}${k.last_used_at ? `  last used ${when(k.last_used_at)}` : ''}`);
}

function showSecret(io: Io, k: KeyRow): void {
  const s = secretOf(k);
  if (!s) return;
  io.out(`\nSecret key (shown once, store it server-side only, never in client code):\n  ${s}`);
}

/** --kind and --env for a new key, pk and live by default. */
function newKeyBody(args: Args): { kind: string; env: string } {
  const kind = str(args.flags.kind) ?? 'pk';
  const env = str(args.flags.env) ?? 'live';
  if (!['pk', 'sk'].includes(kind) || !['live', 'test'].includes(env)) throw new CliError('--kind must be pk|sk and --env live|test');
  return { kind, env };
}

/** Runs one keys subcommand against the site's keys and returns the API's answer. */
async function keysRequest(sub: string, args: Args, api: Api, base: string): Promise<unknown> {
  const needId = (): string => {
    const id = args.pos[1];
    if (!id) throw new CliError(`usage: npx @doubleagent-so/cli keys ${sub} <key_id> [--site st_…]`);
    return encodeURIComponent(id);
  };
  switch (sub) {
    case 'list': return (await api.request('GET', base)).data;
    case 'create': return (await api.request('POST', base, newKeyBody(args))).data;
    case 'rotate': return (await api.request('POST', `${base}/${needId()}/rotate`, {})).data;
    case 'revoke': return (await api.request('DELETE', `${base}/${needId()}`)).data ?? { revoked: args.pos[1] };
    default: throw new CliError(`unknown keys command "${sub}" (list|create|rotate|revoke)`);
  }
}

function printKeysResult(io: Io, sub: string, site: string, result: unknown, id: string | undefined): void {
  if (sub === 'list') {
    io.out(`Keys for ${site}:`);
    rowsOf(result).forEach((k) => printKey(io, k));
    return;
  }
  if (sub === 'revoke') {
    io.out(`Revoked ${id}.`);
    return;
  }
  const k = keyRowOf(result);
  io.out(sub === 'rotate' ? 'Rotated. The old key keeps working for 24 h.' : 'Created:');
  printKey(io, k);
  showSecret(io, k);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && !!value && !Array.isArray(value);

export async function keys(args: Args, io: Io): Promise<number> {
  const { api } = sessionApi(args, io);
  const site = await resolveSite(args, api);
  const sub = args.pos[0] ?? 'list';
  const result = await keysRequest(sub, args, api, `/v1/sites/${encodeURIComponent(site)}/keys`);
  if (args.flags.json) json(io, { site, ...(isRecord(result) ? result : { keys: result }) });
  else printKeysResult(io, sub, site, result, args.pos[1]);
  return 0;
}

// ---- verify-domain ----------------------------------------------------------------------------

const METHODS = ['dns', 'meta', 'file', 'script'] as const;
type Method = (typeof METHODS)[number];

interface ServerInstructions {
  dns?: { type?: string; name?: string; value?: string };
  meta?: { html?: string };
  file?: { url?: string; body?: string };
  script?: { html?: string };
}
interface DomainInfo { hostname?: string; token?: string; methods?: string[]; instructions?: ServerInstructions }

/** Prefer the API's own instructions (exact record names/values); fall back to the documented format. */
function howTo(method: Method, host: string, info: DomainInfo): string | undefined {
  const fromServer = info.instructions ? SERVER_HOW_TO[method](info.instructions, host) : undefined;
  if (fromServer) return fromServer;
  return info.token ? instructions(method, host, info.token) : undefined;
}

/** The API's instructions for each method, when it sent all a method needs. */
const SERVER_HOW_TO: Record<Method, (i: ServerInstructions, host: string) => string | undefined> = {
  dns: ({ dns }) => (dns?.name && dns.value ? `Add a DNS ${dns.type ?? 'TXT'} record: ${dns.name}  "${dns.value}"` : undefined),
  meta: ({ meta }, host) => (meta?.html ? `Add to the <head> of https://${host}/: ${meta.html}` : undefined),
  file: ({ file }) => (file?.url && file.body ? `Serve ${file.url} containing: ${file.body}` : undefined),
  script: ({ script }, host) => (script?.html ? `Deploy this tag on https://${host}/: ${script.html}` : undefined),
};
interface VerifyResponse { verified?: boolean; detail?: string; claimed?: { sessions?: number } }

/** How to publish the domain-verification token for each method the API checks. */
export function instructions(method: Method, host: string, token: string): string {
  switch (method) {
    case 'dns': return `Add a DNS TXT record: _doubleagent.${host}  "da-verify=${token}"  (an apex record also covers subdomains)`;
    case 'meta': return `Add to the <head> of https://${host}/: <meta name="doubleagent-verification" content="${token}">`;
    case 'file': return `Serve https://${host}/.well-known/doubleagent.txt containing: da-verify=${token}`;
    case 'script': return `Deploy the SDK tag with this site's public key (data-key) on https://${host}/`;
  }
}

/** The host argument without scheme or path, and the --method flag (dns by default). */
function verifyTarget(args: Args): { host: string; method: Method } {
  const host = args.pos[0]?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new CliError('usage: npx @doubleagent-so/cli verify-domain <host> --method dns|meta|file|script [--site st_…]');
  const method = (str(args.flags.method) ?? 'dns') as Method;
  if (!METHODS.includes(method)) throw new CliError(`--method must be one of ${METHODS.join('|')}`);
  return { host, method };
}

/** Adds the domain to the site. Adding is idempotent from our side: an existing domain (409) is fine. */
async function addDomain(api: Api, path: string, host: string): Promise<DomainInfo> {
  try {
    return (await api.request<DomainInfo>('POST', path, { hostname: host })).data ?? {};
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    return ((e.body as { domain?: DomainInfo } | null)?.domain ?? (e.body as DomainInfo | null)) ?? {};
  }
}

/** Not verified: the reason, how to publish the token, and the command to try again. */
function printUnverified(io: Io, args: Args, attempt: { site: string; host: string; method: Method; detail?: string; how?: string }): void {
  const { site, host, method, detail, how } = attempt;
  io.out(`Not verified yet${detail ? `: ${detail}` : ''}.`);
  if (how) io.out(how);
  io.out(`Then run: npx @doubleagent-so/cli verify-domain ${host} --method ${method}${args.flags.site ? ` --site ${site}` : ''}`);
}

export async function verifyDomain(args: Args, io: Io): Promise<number> {
  const { host, method } = verifyTarget(args);
  const { api } = sessionApi(args, io);
  const site = await resolveSite(args, api);
  const path = `/v1/sites/${encodeURIComponent(site)}/domains`;
  const info = await addDomain(api, path, host);
  const { data: r } = await api.request<VerifyResponse>('POST', `${path}/${encodeURIComponent(host)}/verify`, { method });
  const how = howTo(method, host, info);
  const verified = !!r?.verified;
  if (args.flags.json) json(io, verifyJson({ site, host, method, verified, how }, r, info));
  else if (verified) printVerified(io, host, method, r);
  else printUnverified(io, args, { site, host, method, detail: r?.detail, how });
  return verified ? 0 : 1;
}

function verifyJson(attempt: { site: string; host: string; method: Method; verified: boolean; how?: string }, r: VerifyResponse | undefined, info: DomainInfo) {
  const { site, host, method, verified, how } = attempt;
  return { site, hostname: host, method, verified, detail: r?.detail ?? null, claimed: r?.claimed ?? null, token: info.token ?? null, instructions: how ?? info.instructions ?? null };
}

function printVerified(io: Io, host: string, method: Method, r: VerifyResponse | undefined): void {
  io.out(`Verified ${host} (${method}).`);
  if (r?.claimed?.sessions) io.out(`Claimed ${r.claimed.sessions} session(s) collected before you joined.`);
}

// ---- account creation (init --email) ----------------------------------------------------------

export interface CreatedAccount {
  account_id: string;
  site_id: string;
  keys: { pk_test?: string; pk_live?: string; sk_test?: string };
  verify?: { hostname?: string; token?: string; methods?: string[] };
  login_url?: string;
}

/** The API's default account-creation difficulty; a 428 can raise it. */
export const ACCOUNT_POW_BITS = 18;

/**
 * POST /v1/accounts with `DA-PoW: <unix_seconds>:<solution>` solved up front (a probe request would
 * spend one of the 5-per-hour attempts). A 428 `pow_required` names a higher difficulty: re-solve and retry once.
 */
export async function createAccount(args: Args, io: Io, body: { email: string; domain?: string; name?: string }): Promise<CreatedAccount> {
  const api = anonApi(args, io);
  const attempt = (bits: number) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const solution = solve(accountPowPrefix(body.email, ts), bits);
    return api.request<CreatedAccount>('POST', '/v1/accounts', body, { 'DA-PoW': `${ts}:${solution}` });
  };
  try {
    return (await attempt(ACCOUNT_POW_BITS)).data;
  } catch (e) {
    if (!(e instanceof ApiError) || !(e.status === 428 || e.code === 'pow_required')) throw e;
    const d = difficultyFrom(e.body);
    if (d === null) throw new CliError('the API rejected the proof of work and sent no difficulty');
    return (await attempt(d)).data;
  }
}

/** Hashcash preimage the Double Agent API checks for account creation: SHA-256("da-accounts|<email>|<unix_seconds>|<solution>"). */
export const accountPowPrefix = (email: string, ts: string): string => `da-accounts|${email.trim().toLowerCase()}|${ts}|`;
