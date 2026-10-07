// Configuração centralizada. Lê .env (se existir) e variáveis de ambiente.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile?.(); // Node >= 20.12; ignora se não houver .env
} catch {
  /* sem .env: tudo bem */
}

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const apiKey = process.env.API_KEY || '';

export const config = {
  port: num(process.env.PORT, 3000),
  // Vazio: 127.0.0.1 quando o acesso está aberto (sem clientes.json e sem API_KEY);
  // 0.0.0.0 quando há chave. Decidido em index.js, depois de carregar os clientes.
  host: process.env.HOST || '',
  apiKey,
  // Clientes e suas chaves (ver server/tenants.js). Ausente = só o cliente "demo".
  clientesFile: path.resolve(ROOT, process.env.CLIENTES_FILE || 'data/clientes.json'),
  // CDs cadastrados pela tela, um arquivo por cliente.
  centrosDir: path.resolve(ROOT, process.env.CENTROS_DIR || 'data/centros'),
  // Cliente que recebe os dados do simulador. Vazio: "demo" ou o primeiro com a rede de exemplo.
  simCliente: process.env.SIM_CLIENTE || '',
  simulate: (process.env.SIMULATE ?? 'true').toLowerCase() !== 'false',
  simSpeedup: Math.max(0.1, num(process.env.SIM_SPEEDUP, 5)),
  osrmUrl: (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, ''),
  mapStyleUrl: process.env.MAP_STYLE_URL || '',
  mapLabelFont: process.env.MAP_LABEL_FONT || '',
  offlineAfterMs: num(process.env.OFFLINE_AFTER_S, 60) * 1000,
  trailMax: Math.max(2, num(process.env.TRAIL_MAX, 300)),
  batchMs: Math.max(50, num(process.env.BATCH_MS, 250)),
  // Teto de ativos distintos: impede que IDs inventados esgotem a memória.
  maxAssets: Math.max(1, num(process.env.MAX_ASSETS, 10_000)),
  // Vista inicial do mapa: Grande Florianópolis ([lon, lat])
  mapCenter: [-48.56, -27.57],
  mapZoom: 10.5,
};
