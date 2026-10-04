/** Bounded collection receipts, without query strings, keys, signatures or request bodies. */
export interface CollectionReceipt {
  endpoint: string;
  sessionId: string | null;
  siteHost: string | null;
  verdictClass: string | null;
  status: number | null;
  outcome: 'accepted' | 'rejected' | 'failed' | 'blocked';
  reason: string | null;
}

export function isCollection(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname === '/v1/collect';
}

const identifier = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max && /^[a-z0-9._:-]+$/i.test(value) ? value : null;

interface CollectedPayload { sid?: unknown; page?: { host?: unknown }; verdict?: { class?: unknown } }

/** The beacon body, when it is JSON of at most 128 KB. Invalid payloads can still have useful HTTP receipts. */
function payloadOf(body: string | null): CollectedPayload | null {
  if (!body || body.length > 131072) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/** What happened to the beacon, and why when it wasn't accepted. */
function outcomeOf(status: number | null, acceptedHeader: string | undefined, blocked: boolean): Pick<CollectionReceipt, 'outcome' | 'reason'> {
  if (blocked) return { outcome: 'blocked', reason: 'isolated_mode' };
  if (status === null) return { outcome: 'failed', reason: 'network_error' };
  if (acceptedHeader === '0') return { outcome: 'rejected', reason: 'telemetry_not_accepted' };
  return status >= 200 && status < 300 ? { outcome: 'accepted', reason: null } : { outcome: 'rejected', reason: 'http_error' };
}

const verdictClassOf = (cls: unknown): string | null => (typeof cls === 'string' && ['human', 'bot', 'agent'].includes(cls) ? cls : null);

export function collectionReceipt(url: string, body: string | null, status: number | null, acceptedHeader?: string, blocked = false): CollectionReceipt {
  const endpoint = new URL(url);
  const payload = payloadOf(body);
  const { outcome, reason } = outcomeOf(status, acceptedHeader, blocked);
  return {
    endpoint: endpoint.origin + endpoint.pathname,
    sessionId: identifier(payload?.sid, 128), siteHost: identifier(payload?.page?.host, 253),
    verdictClass: verdictClassOf(payload?.verdict?.class),
    status, outcome, reason,
  };
}
