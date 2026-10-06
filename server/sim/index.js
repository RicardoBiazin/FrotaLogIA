// Simulador de frota. Gera posições e viagens e as entrega pelo mesmo caminho dos dados reais
// (ingest → normalize → store), então trocar a fonte não exige mudar mais nada.
//
// Cada veículo de rua vai e volta entre as pontas da rota. Cada trecho é uma viagem:
// carregando (parado na origem) → em_transito → entregue (ao chegar), e a próxima começa.
import { Path } from '../geo.js';
import { AGENTS, GEO_ROUTES, WAREHOUSE_PATHS } from './routes.js';
import { fetchRoute } from './osrm.js';
import { CARGAS, EMPRESAS, PESSOAS } from '../demo.js';
import { startStockSimulation } from './estoque.js';

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const round = (n, step) => Math.round(n / step) * step;

const ETA_REFRESH_MS = 15_000;

// Faixas por perfil: peso (kg), volume (m³), volumes (unidades/pallets), valor (R$)
const PERFIS = {
  transferencia: { peso: [8_000, 24_000], m3: [30, 85], vol: [12, 28], valor: [40_000, 380_000] },
  aereo: { peso: [500, 3_000], m3: [4, 18], vol: [10, 60], valor: [20_000, 250_000] },
  ultimaMilha: { peso: [200, 1_100], m3: [2, 9], vol: [15, 120], valor: [3_000, 40_000] },
};

let seq = 0;

class Agent {
  constructor(def, path, speedup, route = null) {
    this.def = def;
    this.path = path;
    this.speedup = speedup;
    this.route = route; // null nas plantas (empilhadeiras não têm viagem)
    this.s = (def.start ?? 0) * path.length;
    this.dir = def.dir ?? 1;
    this.speed = 0; // m/s reais (sem aceleração de tempo)
    this.pausedUntil = 0;
    this.atTerminal = false; // parado numa ponta (carga/descarga), não num semáforo
    this.last = Date.now();
    this.nextDropoutAt = def.dropout ? Date.now() + rand(0.3, 1) * def.dropout.everySec * 1000 : Infinity;
    this.silentUntil = 0;
    this.viagem = null;
    this.etaAt = 0;
  }

  step(now) {
    const dt = Math.min((now - this.last) / 1000, 5);
    this.last = now;
    const events = [];

    if (now < this.pausedUntil) {
      this.speed = 0;
    } else {
      if (this.atTerminal) {
        this.atTerminal = false;
        events.push('partiu');
      }
      const target = (this.def.speed * rand(0.85, 1.15)) / 3.6;
      this.speed += (target - this.speed) * 0.5;
      this.s += this.dir * this.speed * dt * this.speedup;

      const end = this.path.length;
      if (this.s >= end || this.s <= 0) {
        this.s = Math.min(end, Math.max(0, this.s));
        this.dir *= -1;
        this.speed = 0;
        this.atTerminal = true;
        this.pausedUntil = now + rand(8, 20) * 1000; // carga/descarga
        events.push('chegou');
      } else if (Math.random() < this.def.stopChance * dt) {
        this.pausedUntil = now + rand(6, 18) * 1000; // semáforo, fila, pausa
      }
    }

    if (now >= this.nextDropoutAt) {
      this.silentUntil = now + this.def.dropout.forSec * 1000;
      this.nextDropoutAt = this.silentUntil + this.def.dropout.everySec * 1000;
    }
    return events;
  }

  report(now) {
    if (now < this.silentUntil) return null; // sem sinal
    const p = this.path.at(this.s, { reverse: this.dir < 0 });
    const base = {
      id: this.def.id,
      nome: this.def.nome,
      tipo: this.def.tipo,
      rumo: p.rumo,
      velocidade: this.speed * 3.6,
      ts: now,
    };
    return this.def.espaco
      ? { ...base, espaco: this.def.espaco, x: p.a, y: p.b }
      : { ...base, lat: p.a, lon: p.b };
  }

  /** Previsão de chegada no fim do trecho atual (tempo de rua, já com a aceleração). */
  eta(now) {
    const restante = this.dir > 0 ? this.path.length - this.s : this.s;
    const ms = (restante / ((this.def.speed / 3.6) * this.speedup)) * 1000;
    return Math.round(now + Math.max(0, this.pausedUntil - now) + ms * 1.1);
  }

  /** Nova viagem saindo da ponta onde o veículo está agora. */
  novaViagem(now, status) {
    const { pontas, perfil, waypoints } = this.route;
    const [iOrigem, iDestino] = this.dir > 0 ? [0, 1] : [1, 0];
    const ponta = (i) => ({ ...pontas[i], lat: waypoints[i === 0 ? 0 : waypoints.length - 1][0], lon: waypoints[i === 0 ? 0 : waypoints.length - 1][1] });
    const f = PERFIS[perfil];
    const remetente = pick(EMPRESAS);
    let destinatario = pick(perfil === 'ultimaMilha' ? PESSOAS : EMPRESAS);
    if (destinatario === remetente) destinatario = pick(PESSOAS);
    seq++;
    this.viagem = {
      id: `VG-${String(seq).padStart(5, '0')}`,
      veiculo: this.def.id,
      status,
      documento: `CT-e ${String(100_000 + seq)}`,
      origem: ponta(iOrigem),
      destino: ponta(iDestino),
      remetente: { nome: remetente },
      destinatario: { nome: destinatario },
      carga: {
        descricao: pick(CARGAS[perfil]),
        pesoKg: round(rand(...f.peso), 10),
        volumeM3: round(rand(...f.m3), 0.5),
        volumes: Math.round(rand(...f.vol)),
        valor: round(rand(...f.valor), 100),
      },
    };
    return this.viagem;
  }
}

export async function startSimulation({ ingest, config, cliente, centros = [] }) {
  const geoPaths = {};
  await Promise.all(
    Object.entries(GEO_ROUTES).map(async ([key, route]) => {
      const points = await fetchRoute({ osrmUrl: config.osrmUrl, key, waypoints: route.waypoints });
      geoPaths[key] = new Path(points ?? route.waypoints);
    }),
  );

  let running = true;
  const timers = new Map(); // um timer pendente por agente

  const sendTrip = (agent, now, status) => {
    const v = agent.viagem;
    v.status = status;
    if (status !== 'entregue') v.previsao = agent.eta(now);
    const r = ingest.trip(cliente, v, now);
    if (!r.ok) console.warn(`[sim] viagem ${v.id} recusada: ${r.error}`);
  };

  for (const def of AGENTS) {
    const route = def.espaco ? null : GEO_ROUTES[def.route];
    const path = def.espaco
      ? new Path(WAREHOUSE_PATHS[def.espaco][def.path], { local: true })
      : geoPaths[def.route];
    // A planta usa tempo real (speedup 1); as rotas urbanas usam o fator configurado.
    const agent = new Agent(def, path, def.espaco ? 1 : config.simSpeedup, route);
    const interval = def.intervalMs ?? 2000;

    if (route) {
      agent.novaViagem(Date.now(), 'em_transito');
      sendTrip(agent, Date.now(), 'em_transito');
    }

    const tick = () => {
      if (!running) return;
      const now = Date.now();
      const events = agent.step(now);
      if (route) {
        if (events.includes('chegou')) {
          sendTrip(agent, now, 'entregue');
          agent.novaViagem(now, 'carregando');
          sendTrip(agent, now, 'carregando');
          agent.etaAt = now;
        } else if (events.includes('partiu')) {
          sendTrip(agent, now, 'em_transito');
          agent.etaAt = now;
        } else if (now - agent.etaAt > ETA_REFRESH_MS) {
          sendTrip(agent, now, agent.viagem.status);
          agent.etaAt = now;
        }
      }
      const position = agent.report(now);
      if (position) ingest.position(cliente, position, now);
      timers.set(def.id, setTimeout(tick, interval * rand(0.85, 1.15))); // jitter, como em rastreadores reais
    };
    timers.set(def.id, setTimeout(tick, rand(0, interval)));
  }

  const stock = startStockSimulation({ ingest, cliente, centros });

  console.log(`[sim] ${AGENTS.length} ativos simulados para o cliente "${cliente}" (tempo x${config.simSpeedup} nas rotas urbanas).`);
  return {
    stop() {
      running = false;
      stock.stop();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
