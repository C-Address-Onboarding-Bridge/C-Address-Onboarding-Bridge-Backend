import http from 'http';
import https from 'https';
import { Gauge } from 'prom-client';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../index';
import { register } from './metrics';

/**
 * HTTP keep-alive connection pooling for outbound Soroban RPC traffic.
 *
 * The Stellar SDK performs every RPC call through a single shared axios
 * instance (`SorobanRpc.AxiosClient`). By default that instance opens a fresh
 * TCP (and TLS) connection per request, which adds handshake latency and churns
 * sockets. Installing keep-alive agents lets axios reuse a pool of sockets per
 * origin, so repeated calls to the same RPC endpoint ride existing connections.
 */

interface AgentOptions {
  maxSockets: number;
  maxFreeSockets: number;
  keepAliveMsecs: number;
}

function buildAgents(opts: AgentOptions): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const shared = {
    keepAlive: true,
    maxSockets: opts.maxSockets,
    maxFreeSockets: opts.maxFreeSockets,
    keepAliveMsecs: opts.keepAliveMsecs,
    scheduling: 'lifo' as const,
  };
  return {
    httpAgent: new http.Agent(shared),
    httpsAgent: new https.Agent(shared),
  };
}

// Fall back to sane defaults so the module is robust even when invoked with a
// partial config (e.g. mocked in unit tests).
const agentConfig: AgentOptions = config.httpAgent ?? {
  maxSockets: 50,
  maxFreeSockets: 10,
  keepAliveMsecs: 15000,
};

const { httpAgent, httpsAgent } = buildAgents(agentConfig);

let applied = false;

/**
 * Installs the keep-alive agents on the Stellar SDK's shared axios client.
 * Idempotent — safe to call from every module that touches the RPC pool.
 */
export function applyKeepAliveAgents(): void {
  if (applied) return;
  const client = SorobanRpc.AxiosClient as { defaults: { httpAgent?: http.Agent; httpsAgent?: https.Agent } };
  client.defaults.httpAgent = httpAgent;
  client.defaults.httpsAgent = httpsAgent;
  applied = true;
  // `logger` may be undefined if this runs during the index module's cyclic
  // initialization; the log line is non-essential, so guard it.
  logger?.info?.(
    { maxSockets: agentConfig.maxSockets, maxFreeSockets: agentConfig.maxFreeSockets },
    'soroban rpc keep-alive agents installed',
  );
}

export interface AgentStats {
  /** Sockets currently in use (one per in-flight request). */
  activeSockets: number;
  /** Idle keep-alive sockets available for reuse. */
  freeSockets: number;
  /** Requests queued because all sockets are busy. */
  pendingRequests: number;
}

function countSockets(record: Record<string, unknown[]> | undefined): number {
  if (!record) return 0;
  return Object.values(record).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
}

/**
 * Snapshot of socket reuse across both agents — surfaced via metrics so the
 * connection pool's effectiveness (free sockets ⇒ reuse) is observable.
 */
export function getAgentStats(): AgentStats {
  const agents = [httpAgent, httpsAgent] as Array<{
    sockets?: Record<string, unknown[]>;
    freeSockets?: Record<string, unknown[]>;
    requests?: Record<string, unknown[]>;
  }>;
  let activeSockets = 0;
  let freeSockets = 0;
  let pendingRequests = 0;
  for (const a of agents) {
    activeSockets += countSockets(a.sockets);
    freeSockets += countSockets(a.freeSockets);
    pendingRequests += countSockets(a.requests);
  }
  return { activeSockets, freeSockets, pendingRequests };
}

/** Drains all idle keep-alive sockets. Called during graceful shutdown. */
export function destroyAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}

// ─── Socket-reuse metrics ────────────────────────────────────────────────────
// Sampled on every scrape so the pool's connection-reuse effectiveness is
// observable (a high free-socket count means connections are being reused).

const rpcSocketsFree = new Gauge({
  name: 'rpc_keepalive_sockets_free',
  help: 'Free (reusable) Soroban RPC keep-alive sockets',
  registers: [register],
});

const rpcSocketsPending = new Gauge({
  name: 'rpc_keepalive_pending_requests',
  help: 'Soroban RPC requests waiting for an available socket',
  registers: [register],
});

new Gauge({
  name: 'rpc_keepalive_sockets_active',
  help: 'Active Soroban RPC keep-alive sockets',
  registers: [register],
  collect() {
    const s = getAgentStats();
    this.set(s.activeSockets);
    rpcSocketsFree.set(s.freeSockets);
    rpcSocketsPending.set(s.pendingRequests);
  },
});
