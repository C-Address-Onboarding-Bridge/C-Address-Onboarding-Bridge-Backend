import type { Application } from 'express';
import { createServer } from 'http';
import { Socket } from 'net';
import { createWebSocketServer, handleUpgrade } from './websocket';

export function createApiServer(app: Application) {
  const server = createServer(app);
  const wss = createWebSocketServer();

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    handleUpgrade(wss, req, socket as Socket, head);
  });

  return { server, wss };
}
