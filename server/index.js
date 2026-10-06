import http from 'node:http';
import { config, VERSION } from './config.js';
import { AssetStore } from './store.js';
import { createIngest } from './ingest.js';
import { createApp } from './app.js';
import { createHub } from './hub.js';
import { SPACES } from './spaces.js';
import { startSimulation } from './sim/index.js';

const store = new AssetStore({
  offlineAfterMs: config.offlineAfterMs,
  trailMax: config.trailMax,
  maxAssets: config.maxAssets,
});
const ingest = createIngest(store);
const app = createApp({ config, store, ingest, spaces: SPACES, version: VERSION });
const server = http.createServer(app);
const hub = createHub({ server, store, batchMs: config.batchMs });

const sweepTimer = setInterval(() => store.sweep(), 5_000);
let simulation = null;

server.listen(config.port, config.host, () => {
  console.log(`FrotaLogIA v${VERSION} em http://localhost:${config.port} (escutando em ${config.host})`);
  if (!config.apiKey) {
    console.warn('Aviso: API_KEY não definida; a escrita está aberta (ok só em desenvolvimento).');
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.warn(`Aviso: HOST=${config.host} sem API_KEY expõe a escrita para a rede. Defina API_KEY.`);
    }
  }
  if (config.simulate) {
    startSimulation({ ingest, config })
      .then((sim) => {
        simulation = sim;
      })
      .catch((err) => console.error('Falha ao iniciar o simulador:', err));
  }
});

function shutdown() {
  console.log('\nEncerrando…');
  clearInterval(sweepTimer);
  simulation?.stop();
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
