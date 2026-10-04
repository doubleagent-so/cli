import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, type Io } from '../src/cli';

/** The next queued reply; the last one repeats. */
const nextOf = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]);

export function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'da-cli-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');

export const pkg = (deps: Record<string, string>, extra: object = {}): string => JSON.stringify({ name: 'app', dependencies: deps, ...extra });

export interface Result { code: number; out: string; err: string; json: any }

export async function cli(args: string[], opts: Partial<Io> = {}): Promise<Result> {
  let out = '', err = '';
  // Default env points config at a throwaway dir so no test can touch the real ~/.config.
  const code = await run(args, { cwd: '/', env: { DOUBLEAGENT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'da-cfg-')) }, out: (s) => { out += `${s}\n`; }, err: (s) => { err += `${s}\n`; }, ...opts });
  let json: unknown;
  if (args.includes('--json')) json = JSON.parse(out);
  return { code, out, err, json };
}

/** init --json --yes in `dir`. */
export const init = (dir: string, ...extra: string[]) => cli(['init', '--json', '--yes', '--cwd', dir, ...extra]);

export type Handler = (req: { body: any; headers: Record<string, string>; url: URL }) => { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };

/** Fake API: routes keyed "METHOD /path" (a list is consumed in order, the last one repeats). */
export function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL, requestInit: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = requestInit.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((requestInit.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = requestInit.body ? JSON.parse(String(requestInit.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body, headers });
    const r = routes[`${method} ${url.pathname}`];
    if (!r) return Response.json({ error: { code: 'not_found', message: `no route ${method} ${url.pathname}` } }, { status: 404 });
    const h = Array.isArray(r) ? nextOf(r) : r;
    const res = h({ body, headers, url });
    const text = res.raw ?? (res.body === undefined ? null : JSON.stringify(res.body));
    return new Response(text, { status: res.status ?? 200, headers: res.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

export const networkDown = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;

/** A config dir already holding a session for https://api.test. */
export function loggedIn(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'da-cfg-'));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ api: 'https://api.test', session: 'das_session', saved_at: 'now' }), { mode: 0o600 });
  return { DOUBLEAGENT_CONFIG_DIR: dir, ...extra };
}
