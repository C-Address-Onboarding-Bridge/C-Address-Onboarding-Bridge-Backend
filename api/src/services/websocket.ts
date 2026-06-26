import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { config } from '../config';
import { logger } from '../logger';
import { sorobanService } from './soroban';
import { explorerService } from './explorer';

const TX_HASH_RE = /^[a-f0-9]{64}$/;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;
const POLL_INTERVAL_MS = 5_000;

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
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function validateToken(token: string | null): boolean {
  if (!config.websocket.authRequired) return true;
  if (!token) return false;
  const validKeys = config.apiKeys;
  return validKeys.includes(token);
}

async function pollStatus(client: ClientState, sub: Subscription): Promise<void> {
  try {
    const status = await sorobanService.getTransactionStatus(sub.txHash);
    const currentStatus = status.status;

    if (currentStatus !== sub.lastStatus) {
      sub.lastStatus = currentStatus;
      send(client.ws, {
        type: 'status_update',
        txHash: sub.txHash,
        status: currentStatus,
        explorerUrl: explorerService.txUrl(sub.txHash),
        timestamp: Date.now(),
      });

      if (currentStatus === 'success' || currentStatus === 'failed') {
        clearInterval(sub.intervalId);
        client.subscriptions.delete(sub.txHash);
        send(client.ws, { type: 'subscription_closed', txHash: sub.txHash, reason: 'terminal_status' });
      }
    }
  } catch (err) {
    logger.debug({ err, txHash: sub.txHash }, 'ws poll error');
  }
}

function subscribe(client: ClientState, txHash: string, lastKnownStatus: string | null = null): void {
  if (client.subscriptions.has(txHash)) {
    send(client.ws, { type: 'error', code: 'already_subscribed', txHash });
    return;
  }

  if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
    send(client.ws, { type: 'error', code: 'subscription_limit', max: MAX_SUBSCRIPTIONS_PER_CONNECTION });
    return;
  }

  if (!TX_HASH_RE.test(txHash)) {
    send(client.ws, { type: 'error', code: 'invalid_tx_hash', txHash });
    return;
  }

  const sub: Subscription = {
    txHash,
    lastStatus: lastKnownStatus,
    intervalId: setInterval(() => pollStatus(client, sub), POLL_INTERVAL_MS),
  };

  client.subscriptions.set(txHash, sub);
  send(client.ws, { type: 'subscribed', txHash, timestamp: Date.now() });

  pollStatus(client, sub).catch(() => {});
}

function unsubscribe(client: ClientState, txHash: string): void {
  const sub = client.subscriptions.get(txHash);
  if (!sub) {
    send(client.ws, { type: 'error', code: 'not_subscribed', txHash });
    return;
  }
  clearInterval(sub.intervalId);
  client.subscriptions.delete(txHash);
  send(client.ws, { type: 'unsubscribed', txHash, timestamp: Date.now() });
}

function cleanup(client: ClientState): void {
  clearInterval(client.heartbeatId);
  for (const sub of client.subscriptions.values()) {
    clearInterval(sub.intervalId);
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

  wss.on('connection', (ws: WebSocket) => {
    const client: ClientState = {
      ws,
      subscriptions: new Map(),
      isAlive: true,
      heartbeatId: setInterval(() => {
        if (!client.isAlive) {
          ws.terminate();
          return;
        }
        client.isAlive = false;
        ws.ping();
      }, HEARTBEAT_INTERVAL_MS),
    };

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (data) => {
      handleMessage(client, data.toString());
    });

    ws.on('close', () => {
      cleanup(client);
    });

    ws.on('error', (err) => {
      logger.debug({ err }, 'websocket client error');
      cleanup(client);
    });

    send(ws, { type: 'connected', timestamp: Date.now() });
  });

  return wss;
}

export function handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: import('net').Socket, head: Buffer): void {
  const { query } = parseUrl(req.url ?? '', true);
  const token = typeof query.token === 'string' ? query.token : null;

  if (!validateToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}
