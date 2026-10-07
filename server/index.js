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
// cliente: definido na partida; sim: preenchido quando o simulador terminar de subir (rotas do OSRM)
const demo = { cliente: null, sim: null };
const app = createApp({ config, store, viagens, eventos, estoque, ingest, tenants, demo, version: VERSION });
const server = http.createServer(app);
const hub = createHub({ server, store, viagens, eventos, estoque, tenants, batchMs: config.batchMs });

const sweepTimer = setInterval(() => store.sweep(), 5_000);
let simulation = null;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${config.port} já está em uso: o FrotaLogIA já está rodando ou outro programa usa essa porta.`);
    console.error(`Feche o outro programa ou escolha outra porta com PORT no .env.`);
  } else {
    console.error(`Não foi possível iniciar o servidor: ${err.message}`);
  }
  process.exit(1);
});

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
    const sim = tenants.simulado(config.simCliente);
    if (!sim) {
      console.warn(
        config.simCliente
          ? `[sim] cliente "${config.simCliente}" não existe; simulador desligado (ver SIM_CLIENTE).`
          : '[sim] nenhum cliente com a rede de exemplo; simulador desligado (ver SIM_CLIENTE).',
      );
      return;
    }
    demo.cliente = sim.id;
    startSimulation({
      ingest,
      config,
      cliente: sim.id,
      centros: sim.centros,
      removeAsset: (cliente, id) => store.remove(cliente, id),
    })
      .then((started) => {
        simulation = started;
        demo.sim = started;
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
