/** Minimal JSON client for the Double Agent API (account, site and key routes). */
import { trimTrailing } from './text';
export const DEFAULT_API = 'https://api.doubleagent.so';
export const DEFAULT_PORTAL = 'https://app.doubleagent.so';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: unknown, readonly headers?: Headers) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResponse<T> { status: number; data: T; headers: Headers }

export interface Api {
  base: string;
  request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
}

/** A JSON body, the raw text when it isn't JSON, or null when empty. */
function parseBody(text: string): unknown {
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/** The API's `{ error: { code, message } }` (or `{ error: "code" }`) as an ApiError; otherwise the HTTP status. */
function apiErrorOf(method: string, path: string, res: Response, data: unknown): ApiError {
  const err = (data as { error?: { code?: string; message?: string } | string } | null)?.error;
  const code = typeof err === 'string' ? err : err?.code ?? `http_${res.status}`;
  const message = (typeof err === 'object' && err?.message) || `${method} ${path} → ${res.status}${typeof err === 'string' ? ` ${err}` : ''}`;
  return new ApiError(res.status, code, message, data, res.headers);
}

/** Every request gives up after this long: a hung connection must never hang the CLI or a helper. */
export const API_TIMEOUT_MS = 30_000;

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export function createApi(
  base: string,
  session: string | undefined,
  f: typeof fetch = fetch,
  { timeoutMs = API_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Api {
  const root = trimTrailing(base, '/');
  return {
    base: root,
    async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
      let res: Response;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const hasBody = body !== undefined;
        res = await f(`${root}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(session ? { authorization: `Bearer ${session}` } : {}),
            'user-agent': 'doubleagent-cli',
            ...headers,
          },
          body: hasBody ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (e) {
        if (isTimeout(e)) throw new ApiError(0, 'timeout', `${root} did not answer within ${timeoutMs / 1000} s`);
        throw new ApiError(0, 'network', `cannot reach ${root}: ${(e as Error).message}`);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        if (isTimeout(e)) throw new ApiError(0, 'timeout', `${root} did not answer within ${timeoutMs / 1000} s`);
        throw new ApiError(0, 'network', `lost the connection to ${root}: ${(e as Error).message}`);
      }
      const data = parseBody(text);
      if (!res.ok) throw apiErrorOf(method, path, res, data);
      return { status: res.status, data: data as T, headers: res.headers };
    },
  };
}
