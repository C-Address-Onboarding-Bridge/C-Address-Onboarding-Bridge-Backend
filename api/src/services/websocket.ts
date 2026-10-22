import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { config } from '../config';
import { logger } from '../logger';
import { sorobanService } from './soroban';
import { explorerService } from './explorer';
import { resolveRecord } from '../middleware/rbacAuth';
import { buildCacheKey, CACHE_TTL, getOrCompute } from './cache';

const TX_HASH_RE = /^[a-f0-9]{64}$/;
const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const STATUS_CACHE_NAMESPACE = 'status';
const MAX_CONNECTIONS_PER_KEY = 10;
const MAX_CONNECTIONS_PER_IP = 50;

interface Subscription {
  txHash: string;
  lastStatus: string | null;
  intervalId: NodeJS.Timeout;
}

interface ClientState {
  ws: WebSocket;
  subscriptions: Map<string, Subscription>;
  heartbeatId: NodeJS.Timeout;
  isAlive: boolean;
  token: string | null;
  clientIp: string | null;
}

const connectionsByToken = new Map<string, Set<ClientState>>();
const connectionsByIp = new Map<string, Set<ClientState>>();
const sharedPollers = new Map<string, NodeJS.Timeout>();

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function validateToken(token: string | null): boolean {
  if (!config.websocket.authRequired) return true;
  if (!token) return false;
  const record = resolveRecord(token);
  if (!record || record.revoked) return false;
  if (record.expiresAt !== null && Date.now() > record.expiresAt) return false;
  return true;
}

async function pollStatusOnce(txHash: string): Promise<void> {
  try {
    const cacheKey = buildCacheKey(STATUS_CACHE_NAMESPACE, txHash);
    const status = await getOrCompute(
      cacheKey,
      CACHE_TTL.status,
      async () => {
        return sorobanService.getTransactionStatus(txHash);
      }
    );

    const currentStatus = status.status;
    const allClients = Array.from(connectionsByToken.values()).flatMap((set) => Array.from(set));

    for (const client of allClients) {
      const sub = client.subscriptions.get(txHash);
      if (!sub) continue;

      if (currentStatus !== sub.lastStatus) {
        sub.lastStatus = currentStatus;
        send(client.ws, {
          type: 'status_update',
          txHash,
          status: currentStatus,
          explorerUrl: explorerService.txUrl(txHash),
          timestamp: Date.now(),
        });

        if (currentStatus === 'success' || currentStatus === 'failed') {
          clearInterval(sub.intervalId);
          client.subscriptions.delete(txHash);
          send(client.ws, { type: 'subscription_closed', txHash, reason: 'terminal_status' });
        }
      }
    }
  } catch (err) {
    logger.debug({ err, txHash }, 'ws poll error');
  }
}

function subscribe(client: ClientState, txHash: string, lastKnownStatus: string | null = null): void {
  if (client.subscriptions.has(txHash)) {
    send(client.ws, { type: 'error', code: 'already_subscribed', txHash });
    return;
  }

  if (client.subscriptions.size >= config.websocket.maxSubscriptionsPerConnection) {
    send(client.ws, { type: 'error', code: 'subscription_limit', max: config.websocket.maxSubscriptionsPerConnection });
    return;
  }

  if (!TX_HASH_RE.test(txHash)) {
    send(client.ws, { type: 'error', code: 'invalid_tx_hash', txHash });
    return;
  }

  const sub: Subscription = {
    txHash,
    lastStatus: lastKnownStatus,
    intervalId: 0 as unknown as NodeJS.Timeout,
  };

  client.subscriptions.set(txHash, sub);

  if (!sharedPollers.has(txHash)) {
    const pollerId = setInterval(() => pollStatusOnce(txHash), POLL_INTERVAL_MS);
    sharedPollers.set(txHash, pollerId);
  }

  send(client.ws, { type: 'subscribed', txHash, timestamp: Date.now() });
  pollStatusOnce(txHash).catch(() => {});
}

function unsubscribe(client: ClientState, txHash: string): void {
  const sub = client.subscriptions.get(txHash);
  if (!sub) {
    send(client.ws, { type: 'error', code: 'not_subscribed', txHash });
    return;
  }
  client.subscriptions.delete(txHash);

  const hasOtherSubscribers = Array.from(connectionsByToken.values())
    .flatMap((set) => Array.from(set))
    .some((c) => c.subscriptions.has(txHash));

  if (!hasOtherSubscribers) {
    const pollerId = sharedPollers.get(txHash);
    if (pollerId) {
      clearInterval(pollerId);
      sharedPollers.delete(txHash);
    }
  }

  send(client.ws, { type: 'unsubscribed', txHash, timestamp: Date.now() });
}

function cleanup(client: ClientState): void {
  clearInterval(client.heartbeatId);

  if (client.token) {
    const clients = connectionsByToken.get(client.token);
    if (clients) clients.delete(client);
  }

  if (client.clientIp) {
    const clients = connectionsByIp.get(client.clientIp);
    if (clients) clients.delete(client);
  }

  for (const txHash of client.subscriptions.keys()) {
    const hasOtherSubscribers = Array.from(connectionsByToken.values())
      .flatMap((set) => Array.from(set))
      .filter((c) => c !== client)
      .some((c) => c.subscriptions.has(txHash));

    if (!hasOtherSubscribers) {
      const pollerId = sharedPollers.get(txHash);
      if (pollerId) {
        clearInterval(pollerId);
        sharedPollers.delete(txHash);
      }
    }
  }

  client.subscriptions.clear();
}

function handleMessage(client: ClientState, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(client.ws, { type: 'error', code: 'invalid_json' });
    return;
  }

  const action = String(msg.action ?? '');

  switch (action) {
    case 'subscribe': {
      const txHash = String(msg.txHash ?? '');
      const lastKnown = typeof msg.lastKnownStatus === 'string' ? msg.lastKnownStatus : null;
      subscribe(client, txHash, lastKnown);
      break;
    }
    case 'unsubscribe': {
      const txHash = String(msg.txHash ?? '');
      unsubscribe(client, txHash);
      break;
    }
    case 'list': {
      send(client.ws, {
        type: 'subscriptions',
        txHashes: Array.from(client.subscriptions.keys()),
        timestamp: Date.now(),
      });
      break;
    }
    default:
      send(client.ws, { type: 'error', code: 'unknown_action', action });
  }
}

export function createWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const token = (ws as any).__wsToken || null;
    const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || '0.0.0.0';

    const client: ClientState = {
      ws,
      subscriptions: new Map(),
      isAlive: true,
      token,
      clientIp,
      heartbeatId: setInterval(() => {
        if (!client.isAlive) {
          ws.terminate();
          return;
        }
        client.isAlive = false;
        ws.ping();
      }, HEARTBEAT_INTERVAL_MS),
    };

    if (token) {
      const clients = connectionsByToken.get(token) || new Set();
      clients.add(client);
      connectionsByToken.set(token, clients);
    }

    const clients = connectionsByIp.get(clientIp) || new Set();
    clients.add(client);
    connectionsByIp.set(clientIp, clients);

    send(ws, { type: 'connected', timestamp: Date.now() });

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (data: Buffer | string) => {
      handleMessage(client, data.toString());
    });

    ws.on('close', () => {
      cleanup(client);
    });

    ws.on('error', (err) => {
      logger.debug({ err }, 'ws client error');
      cleanup(client);
    });
  });

  return wss;
}

export function handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: import('net').Socket, head: Buffer): void {
  const protocol = req.headers['sec-websocket-protocol'];
  const token = typeof protocol === 'string' ? protocol : null;
  const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || '0.0.0.0';

  if (!validateToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized');
    socket.destroy();
    return;
  }

  if (token) {
    const tokenConnections = connectionsByToken.get(token)?.size ?? 0;
    if (tokenConnections >= MAX_CONNECTIONS_PER_KEY) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nToo many connections for this key');
      socket.destroy();
      return;
    }
  }

  const ipConnections = connectionsByIp.get(clientIp)?.size ?? 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nToo many connections from this IP');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as any).__wsToken = token;
    wss.emit('connection', ws, req);
  });
}
