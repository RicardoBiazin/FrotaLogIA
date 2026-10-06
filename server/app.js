// Aplicação Express: API REST + arquivos estáticos.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { publicAsset } from './store.js';
import { TIPOS } from './normalize.js';
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

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ config, store, ingest, spaces, version = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  const requireKey = (req, res, next) => {
    if (!config.apiKey) return next(); // modo desenvolvimento: sem chave configurada
    if (safeEqual(req.get('x-api-key') ?? '', config.apiKey)) return next();
    res.status(401).json({ erro: 'x-api-key ausente ou inválida' });
  };

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, versao: version, ativos: store.assets.size, agora: Date.now() });
  });

  api.get('/config', (_req, res) => {
    res.json({
      versao: version,
      mapStyleUrl: config.mapStyleUrl || null,
      mapLabelFont: config.mapLabelFont || null,
      center: config.mapCenter,
      zoom: config.mapZoom,
      offlineAfterMs: config.offlineAfterMs,
      tipos: TIPOS,
    });
  });

  api.get('/spaces', (_req, res) => res.json(spaces));

  api.get('/assets', (req, res) => {
    const { tipo, espaco } = req.query;
    res.json(store.list({ tipo, espaco }).map(publicAsset));
  });

  api.get('/assets/:id', (req, res) => {
    const asset = store.get(req.params.id);
    if (!asset) return res.status(404).json({ erro: 'ativo não encontrado' });
    res.json(publicAsset(asset));
  });

  api.get('/assets/:id/trail', (req, res) => {
    const trail = store.trail(req.params.id);
    if (!trail) return res.status(404).json({ erro: 'ativo não encontrado' });
    res.json(trail);
  });

  const ingestMany = (items, res) => {
    if (items.length > MAX_BATCH) {
      return res.status(413).json({ erro: `máximo de ${MAX_BATCH} posições por requisição` });
    }
    const rejected = [];
    let accepted = 0;
    items.forEach((item, index) => {
      const result = ingest(item);
      if (result.ok) accepted++;
      else rejected.push({ index, erro: result.error });
    });
    // 202 mesmo com rejeições parciais; o corpo detalha o que falhou.
    res.status(accepted > 0 || items.length === 0 ? 202 : 400).json({ accepted, rejected });
  };

  api.post('/positions', requireKey, (req, res) => {
    const body = req.body;
    ingestMany(Array.isArray(body) ? body : [body], res);
  });

  api.post('/ingest/traccar', requireKey, (req, res) => {
    ingestMany(traccarToPositions(req.body), res);
  });

  api.delete('/assets/:id', requireKey, (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ erro: 'ativo não encontrado' });
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
