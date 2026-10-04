import { expect, it } from 'vitest';
import { collectionReceipt, isCollection } from '../src/simulation/telemetry';

const url = 'https://api.example/v1/collect?k=pk_private&secret=do-not-print';
const body = JSON.stringify({ sid: 'session_123', page: { host: 'shop.example' }, verdict: { class: 'agent' }, token: 'do-not-print' });

it('keeps an actionable session receipt without request secrets or query strings', () => {
  const receipt = collectionReceipt(url, body, 204);
  expect(receipt).toEqual({ endpoint: 'https://api.example/v1/collect', sessionId: 'session_123', siteHost: 'shop.example', verdictClass: 'agent', status: 204, outcome: 'accepted', reason: null });
  expect(JSON.stringify(receipt)).not.toContain('do-not-print');
  expect(isCollection(url, 'POST')).toBe(true);
  expect(isCollection(url, 'OPTIONS')).toBe(false);
  expect(isCollection('https://api.example/v1/collection', 'POST')).toBe(false);
});

it('does not count a successful HTTP response when the API explicitly rejects telemetry', () => {
  expect(collectionReceipt(url, body, 204, '0')).toMatchObject({ outcome: 'rejected', reason: 'telemetry_not_accepted' });
  expect(collectionReceipt(url, body, 429)).toMatchObject({ outcome: 'rejected', reason: 'http_error' });
  expect(collectionReceipt(url, body, null)).toMatchObject({ outcome: 'failed', reason: 'network_error' });
  expect(collectionReceipt(url, body, null, undefined, true)).toMatchObject({ outcome: 'blocked', reason: 'isolated_mode' });
});

it('bounds malformed metadata and never prints terminal escapes from payloads', () => {
  for (const value of [null, '{', 'x'.repeat(131073), 'null', '{}', JSON.stringify({ sid: '\u001b[31mBAD', page: { host: 'x'.repeat(254) }, verdict: { class: 'invented' } })])
    expect(collectionReceipt(url, value, 400)).toMatchObject({ sessionId: null, siteHost: null, verdictClass: null });
});
