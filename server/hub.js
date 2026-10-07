// Hub WebSocket por cliente. A conexão começa sem dados: o navegador manda
//   { type: 'auth', chave }
// e só então recebe o snapshot do próprio cliente. Depois, lotes de atualizações
// agrupados (batchMs) para não inundar os navegadores.
//
// Mensagens do servidor → cliente:
//   { type: 'snapshot', cliente: { id, nome }, assets: [...], viagens: [...], eventos: [...] }
//   { type: 'batch',    assets: [...], viagens: [...], estoque: [...] }
//     (estoque: posições alteradas, com cd e endereco; { removido: true } = endereço liberado.
//      O estoque completo de um CD vem por GET /api/centros/:cd/estoque.)
//   { type: 'remove',   id }
//   { type: 'evento',   evento }
//   { type: 'centros' }  (CD criado, alterado ou excluído: recarregue GET /api/centros)
// Chave inválida: a conexão é fechada com o código 4401.
//
// Evolução natural: filtrar por área visível (cliente envia { type: 'viewport', bbox }).
import { WebSocketServer } from 'ws';
import { publicAsset } from './store.js';

export const WS_UNAUTHORIZED = 4401;
const AUTH_TIMEOUT_MS = 10_000;

export function createHub({ server, store, viagens, eventos, estoque, tenants, cadastro = null, batchMs = 250 }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  // O ws repete aqui os erros do servidor HTTP (ex.: porta ocupada); quem os trata é o index.js.
  wss.on('error', () => {});
  // cliente → { assets: Map<id, asset>, viagens: Map<id, viagem>, estoque: Map<cd|endereco, item> }
  const pending = new Map();

  const pendingOf = (cliente) => {
    let p = pending.get(cliente);
    if (!p) {
      p = { assets: new Map(), viagens: new Map(), estoque: new Map() };
      pending.set(cliente, p);
    }
    return p;
  };

  const broadcast = (cliente, message) => {
    let data = null;
    for (const ws of wss.clients) {
      if (ws.cliente !== cliente || ws.readyState !== ws.OPEN) continue;
      data ??= JSON.stringify(message);
      ws.send(data);
    }
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.cliente = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    const timer = setTimeout(() => ws.close(WS_UNAUTHORIZED, 'sem autenticação'), AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      if (ws.cliente) return; // nada mais é aceito do navegador por enquanto
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = null;
      }
      const tenant = msg?.type === 'auth' ? tenants.resolve(msg.chave) : null;
      clearTimeout(timer);
      if (!tenant) {
        ws.close(WS_UNAUTHORIZED, 'chave inválida');
        return;
      }
      ws.cliente = tenant.id;
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          cliente: { id: tenant.id, nome: tenant.nome },
          assets: store.list(tenant.id).map(publicAsset),
          viagens: viagens.list(tenant.id, { ativas: true }),
          eventos: eventos.list(tenant.id, 30),
        }),
      );
    });
    ws.on('close', () => clearTimeout(timer));
  });

  const onUpdate = (asset) => pendingOf(asset.cliente).assets.set(asset.id, publicAsset(asset));
  const onRemove = (cliente, id) => {
    pending.get(cliente)?.assets.delete(id);
    broadcast(cliente, { type: 'remove', id });
  };
  const onViagem = (cliente, viagem) => pendingOf(cliente).viagens.set(viagem.id, viagem);
  const onEvento = (cliente, evento) => broadcast(cliente, { type: 'evento', evento });
  const onEstoque = (cliente, item) => pendingOf(cliente).estoque.set(`${item.cd}|${item.endereco}`, item);
  store.on('update', onUpdate);
  store.on('remove', onRemove);
  viagens.on('update', onViagem);
  eventos.on('evento', onEvento);
  estoque.on('update', onEstoque);
  const onCentros = (cliente) => broadcast(cliente, { type: 'centros' });
  cadastro?.on('change', onCentros);

  const flushTimer = setInterval(() => {
    for (const [cliente, p] of pending) {
      if (p.assets.size === 0 && p.viagens.size === 0 && p.estoque.size === 0) continue;
      const message = {
        type: 'batch',
        assets: [...p.assets.values()],
        viagens: [...p.viagens.values()],
        estoque: [...p.estoque.values()],
      };
      p.assets.clear();
      p.viagens.clear();
      p.estoque.clear();
      broadcast(cliente, message);
    }
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
      viagens.off('update', onViagem);
      eventos.off('evento', onEvento);
      estoque.off('update', onEstoque);
      cadastro?.off('change', onCentros);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
