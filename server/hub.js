// Hub WebSocket: envia um snapshot ao conectar e depois lotes de atualizações.
// As atualizações são agrupadas (batchMs) para não inundar os navegadores.
//
// Mensagens do servidor → cliente:
//   { type: 'snapshot', assets: [...] }
//   { type: 'batch',    assets: [...] }
//   { type: 'remove',   id }
//
// Evolução natural: filtrar por área visível (cliente envia { type: 'viewport', bbox }).
import { WebSocketServer } from 'ws';
import { publicAsset } from './store.js';

export function createHub({ server, store, batchMs = 250 }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  const pending = new Map();

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'snapshot', assets: store.list().map(publicAsset) }));
  });

  const onUpdate = (asset) => pending.set(asset.id, publicAsset(asset));
  const onRemove = (id) => {
    pending.delete(id);
    broadcast({ type: 'remove', id });
  };
  store.on('update', onUpdate);
  store.on('remove', onRemove);

  const flushTimer = setInterval(() => {
    if (pending.size === 0) return;
    const assets = [...pending.values()];
    pending.clear();
    broadcast({ type: 'batch', assets });
  }, batchMs);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  return {
    clientCount: () => wss.clients.size,
    close() {
      clearInterval(flushTimer);
      clearInterval(heartbeat);
      store.off('update', onUpdate);
      store.off('remove', onRemove);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
