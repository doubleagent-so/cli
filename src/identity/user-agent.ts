import { agentName, agentReference, IdentityInputError } from './reference';

/** Self-reported identity, never proof of control, registration, conduct or AI execution. */
export interface AgentDeclaration {
  agent_name: string;
  agent_ref: string | null;
  chain_id: string | null;
  registry_address: string | null;
  token_id: string | null;
  source: 'user-agent';
  verification: 'declared';
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
export const AGENT_UA_MAX = 1024;

/** RFC 9110 product/version syntax. The erc8004 comment is a Double Agent extension, not an ERC standard. */
export function agentUserAgent(name: string, ref?: string | null): string {
  const agent = agentName(name);
  if (!ref) return `${agent}/1.0`;
  const reference = parseReference(agent, ref);
  return `${agent}/1.0 (erc8004=${reference.agent_ref})`;
}

function parseReference(name: string, ref: string) {
  const parts = ref.split(':');
  if (parts.length !== 4 || parts[0] !== 'eip155') throw new IdentityInputError('Invalid ERC-8004 reference.');
  return agentReference({ agent_name: name, chain_id: parts[1], registry_address: parts[2], token_id: parts[3] });
}

interface Product { name: string; comments: string[] }

/** The end of a comment that starts at `pos` (just after its "("), or -1 when it is unclosed or not followed by space. */
function commentEnd(ua: string, pos: number): number {
  let depth = 1;
  while (pos < ua.length && depth) {
    if (ua[pos] === '\\') { pos += 2; continue; }
    if (ua[pos] === '(') depth++;
    if (ua[pos] === ')') depth--;
    pos++;
  }
  return depth || (pos < ua.length && !/[ \t]/.test(ua[pos])) ? -1 : pos;
}

/** The product token at `pos` and where it ends, or null when it isn't `name` or `name/version`. */
function readProduct(ua: string, pos: number): { name: string; end: number } | null {
  let end = pos;
  while (end < ua.length && !/[ \t]/.test(ua[end])) end++;
  const [name, version, extra] = ua.slice(pos, end).split('/');
  if (!TOKEN.test(name) || (version !== undefined && !TOKEN.test(version)) || extra !== undefined) return null;
  return { name, end };
}

/** The UA's products, each with the comments after it; null for any malformed part or a leading comment. */
function readProducts(ua: string): Product[] | null {
  const products: Product[] = [];
  let pos = 0;
  while (pos < ua.length) {
    while (/[ \t]/.test(ua[pos] ?? '') && pos < ua.length) pos++;
    if (pos === ua.length) break;
    if (ua[pos] === '(') {
      if (!products.length) return null;
      const start = pos + 1;
      pos = commentEnd(ua, start);
      if (pos < 0) return null;
      products[products.length - 1].comments.push(ua.slice(start, pos - 1));
    } else {
      const product = readProduct(ua, pos);
      if (!product) return null;
      products.push({ name: product.name, comments: [] });
      pos = product.end;
    }
  }
  return products;
}

const isAgentName = (name: string): boolean => { try { agentName(name); return true; } catch { return false; } };

/** The one erc8004 comment's reference, undefined without one, or null when there are several or it is malformed. */
function commentReference(name: string, comments: string[]) {
  const references = comments.filter((comment) => /erc8004/i.test(comment));
  if (!references.length) return undefined;
  if (references.length > 1) return null;
  const match = /^erc8004=(eip155:[^\s()]+)$/.exec(references[0]);
  if (!match) return null;
  try { return parseReference(name, match[1]); } catch { return null; }
}

/** Parse actual UA products, not URLs or text inside comments. Reject ambiguous/duplicate declarations. */
export function parseAgentUserAgent(ua: string): AgentDeclaration | null {
  if (!ua || ua.length > AGENT_UA_MAX || /[^\x20-\x7e\t]/.test(ua)) return null;
  const candidates = readProducts(ua)?.filter(({ name }) => isAgentName(name));
  if (candidates?.length !== 1) return null;
  const [{ name, comments }] = candidates;
  const reference = commentReference(name, comments);
  if (reference === null) return null;
  const fields = reference
    ? { agent_ref: reference.agent_ref, chain_id: reference.chain_id, registry_address: reference.registry_address, token_id: reference.token_id }
    : { agent_ref: null, chain_id: null, registry_address: null, token_id: null };
  return { agent_name: name, ...fields, source: 'user-agent', verification: 'declared' };
}
