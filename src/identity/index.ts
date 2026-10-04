/**
 * ERC-8004 agent identity, as the CLI uses it: `operator.agent-name` names and `eip155:<chain>:<registry>:<token>`
 * references (reference.ts), User-Agent declarations (user-agent.ts), read-only registry lookups (erc8004.ts over
 * chain.ts) and ERC-8128 telemetry signing for simulations (sign-request.ts). The Double Agent API reads the same wire
 * formats, so a change here is a change to what the API accepts.
 *
 * Simulation code imports the modules directly, so the browser probe bundles user-agent.ts without viem.
 */
export { agentReference, reputationQuery, type AgentReference, type ReputationQuery } from './reference';
export { resolveAgent, type RegistrySnapshot } from './erc8004';
