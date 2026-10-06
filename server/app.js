// Aplicação Express: API REST + arquivos estáticos.
// Toda rota de dados exige a chave do cliente (header x-api-key) e só enxerga a rede dele.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { publicAsset } from './store.js';
import { TIPOS } from './normalize.js';
import { VIAGEM_STATUS } from './viagens.js';
import { traccarToPositions } from './adapters/traccar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BATCH = 1000;

// Só scripts da própria origem. Estilo inline é exigido pelo MapLibre (posiciona
// controles via style=); tiles e o MAP_STYLE_URL podem vir de qualquer https.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

/** CD como o navegador precisa: a planta já vem no formato da IndoorView. */
const publicCentro = (c) => ({
  id: c.id,
  nome: c.nome,
  endereco: c.endereco,
  lat: c.lat,
  lon: c.lon,
  raioM: c.raioM,
  planta: c.planta ? { ...c.planta, id: c.id, nome: c.nome } : null,
});

export function createApp({ config, store, viagens, eventos, estoque, ingest, tenants, version = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  /** Resolve o cliente pela chave; sem chave válida, 401. */
  const requireTenant = (req, res, next) => {
    const tenant = tenants.resolve(req.get('x-api-key') ?? '');
    if (!tenant) return res.status(401).json({ erro: 'x-api-key ausente ou inválida' });
    req.cliente = tenant.id;
    req.tenant = tenant;
    next();
  };

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store'); // dados de rastreamento não ficam em cache
    next();
  });

  // ---- Públicas: só o necessário para a tela de acesso e para monitoramento ----
  api.get('/health', (_req, res) => {
    res.json({ ok: true, versao: version, agora: Date.now() });
  });

  api.get('/config', (_req, res) => {
    res.json({
      versao: version,
      auth: !tenants.open,
      mapStyleUrl: config.mapStyleUrl || null,
      mapLabelFont: config.mapLabelFont || null,
      center: config.mapCenter,
      zoom: config.mapZoom,
      offlineAfterMs: config.offlineAfterMs,
      tipos: TIPOS,
      viagemStatus: VIAGEM_STATUS,
    });
  });

  // ---- Do cliente ----
  api.use(requireTenant);

  api.get('/sessao', (req, res) => res.json({ cliente: { id: req.tenant.id, nome: req.tenant.nome } }));

  api.get('/centros', (req, res) => res.json(req.tenant.centros.map(publicCentro)));

  // Estoque endereçado de um CD (posições ocupadas) e busca de produto em todos os CDs.
  api.get('/centros/:cd/estoque', (req, res) => {
    if (!req.tenant.centros.some((c) => c.id === req.params.cd)) return res.status(404).json({ erro: 'CD não encontrado' });
    res.json(estoque.list(req.cliente, req.params.cd));
  });

  api.get('/estoque', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const cd = typeof req.query.cd === 'string' ? req.query.cd : undefined;
    if (!q && !cd) return res.status(400).json({ erro: 'informe q (produto, SKU, lote, endereço) ou cd' });
    res.json(estoque.search(req.cliente, q, { cd }));
  });

  api.get('/assets', (req, res) => {
    const { tipo, espaco } = req.query;
    res.json(store.list(req.cliente, { tipo, espaco }).map(publicAsset));
  });

  api.get('/assets/:id', (req, res) => {
    const asset = store.get(req.cliente, req.params.id);
    if (!asset) return res.status(404).json({ erro: 'ativo não encontrado' });
    res.json({ ...publicAsset(asset), viagem: viagens.ativaDoVeiculo(req.cliente, asset.id) });
  });

  api.get('/assets/:id/trail', (req, res) => {
    const trail = store.trail(req.cliente, req.params.id);
    if (!trail) return res.status(404).json({ erro: 'ativo não encontrado' });
    res.json(trail);
  });

  api.get('/viagens', (req, res) => {
    const { status, veiculo } = req.query;
    res.json(
      viagens.list(req.cliente, {
        status: typeof status === 'string' ? status : undefined,
        veiculo: typeof veiculo === 'string' ? veiculo : undefined,
        ativas: req.query.ativas === 'true',
      }),
    );
  });

  api.get('/viagens/:id', (req, res) => {
    const viagem = viagens.get(req.cliente, req.params.id);
    if (!viagem) return res.status(404).json({ erro: 'viagem não encontrada' });
    res.json(viagem);
  });

  api.get('/eventos', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(eventos.list(req.cliente, limit));
  });

  const ingestMany = (items, res, fn) => {
    if (items.length > MAX_BATCH) {
      return res.status(413).json({ erro: `máximo de ${MAX_BATCH} itens por requisição` });
    }
    const rejected = [];
    let accepted = 0;
    items.forEach((item, index) => {
      const result = fn(item);
      if (result.ok) accepted++;
      else rejected.push({ index, erro: result.error });
    });
    // 202 mesmo com rejeições parciais; o corpo detalha o que falhou.
    res.status(accepted > 0 || items.length === 0 ? 202 : 400).json({ accepted, rejected });
  };
  const asList = (body) => (Array.isArray(body) ? body : [body]);

  api.post('/positions', (req, res) => {
    ingestMany(asList(req.body), res, (item) => ingest.position(req.cliente, item));
  });

  api.post('/ingest/traccar', (req, res) => {
    ingestMany(traccarToPositions(req.body), res, (item) => ingest.position(req.cliente, item));
  });

  api.post('/viagens', (req, res) => {
    ingestMany(asList(req.body), res, (item) => ingest.trip(req.cliente, item));
  });

  api.post('/estoque', (req, res) => {
    ingestMany(asList(req.body), res, (item) => ingest.stock(req.cliente, item));
  });

  api.delete('/assets/:id', (req, res) => {
    if (!store.remove(req.cliente, req.params.id)) return res.status(404).json({ erro: 'ativo não encontrado' });
    res.status(204).end();
  });

  api.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ erro: 'corpo grande demais' });
    console.error(err);
    res.status(500).json({ erro: 'erro interno' });
  });

  app.use('/api', api);
  app.use(
    '/vendor/maplibre-gl',
    express.static(path.join(ROOT, 'node_modules', 'maplibre-gl', 'dist')),
  );
  app.use(express.static(path.join(ROOT, 'public')));
  return app;
}
