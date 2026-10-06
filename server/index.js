import http from 'node:http';
import { config, VERSION } from './config.js';
import { AssetStore } from './store.js';
import { ViagemStore } from './viagens.js';
import { EventLog } from './eventos.js';
import { EstoqueStore } from './estoque.js';
import { loadTenants } from './tenants.js';
import { createIngest } from './ingest.js';
import { createApp } from './app.js';
import { createHub } from './hub.js';
import { CENTROS_DEMO } from './demo.js';
import { normalizeCentro } from './centros.js';
import { startSimulation } from './sim/index.js';

const demoCentros = CENTROS_DEMO.map((c) => normalizeCentro(c).centro);
let tenants;
try {
  tenants = loadTenants({ file: config.clientesFile, apiKey: config.apiKey, demoCentros });
} catch (err) {
  console.error(`Não foi possível carregar os clientes: ${err.message}`);
  process.exit(1);
}

const store = new AssetStore({
  offlineAfterMs: config.offlineAfterMs,
  trailMax: config.trailMax,
  maxAssets: config.maxAssets,
});
const viagens = new ViagemStore();
const eventos = new EventLog();
const estoque = new EstoqueStore();
const ingest = createIngest({ store, viagens, eventos, estoque, tenants });
const app = createApp({ config, store, viagens, eventos, estoque, ingest, tenants, version: VERSION });
const server = http.createServer(app);
const hub = createHub({ server, store, viagens, eventos, estoque, tenants, batchMs: config.batchMs });

const sweepTimer = setInterval(() => store.sweep(), 5_000);
let simulation = null;

// Acesso aberto (sem chave) só nesta máquina; com chave, em todas as interfaces.
const host = config.host || (tenants.open ? '127.0.0.1' : '0.0.0.0');

server.listen(config.port, host, () => {
  console.log(`FrotaLogIA v${VERSION} em http://localhost:${config.port} (escutando em ${host})`);
  console.log(`Clientes: ${tenants.list.map((t) => `${t.id} (${t.centros.length} CDs)`).join(', ')}`);
  if (tenants.open) {
    console.warn('Aviso: acesso aberto, sem chave (sem data/clientes.json e sem API_KEY). Ok só em desenvolvimento.');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(`Aviso: HOST=${host} com acesso aberto expõe a frota para a rede. Defina API_KEY ou clientes.`);
    }
  }
  if (config.simulate) {
    if (!tenants.get(config.simCliente)) {
      console.warn(`[sim] cliente "${config.simCliente}" não existe; simulador desligado (ver SIM_CLIENTE).`);
      return;
    }
    startSimulation({ ingest, config, cliente: config.simCliente, centros: tenants.get(config.simCliente).centros })
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
