// Simulador de frota. Gera posições e viagens e as entrega pelo mesmo caminho dos dados reais
// (ingest → normalize → store), então trocar a fonte não exige mudar mais nada.
//
// Cada veículo de rua vai e volta entre as pontas da rota. Cada trecho é uma viagem:
// carregando (parado na origem) → em_transito → entregue (ao chegar), e a próxima começa.
// O prazo (previsao) é fixado na saída; a estimativa é refeita no caminho. Congestionamentos
// ocasionais seguram o veículo e fazem parte das viagens atrasar.
//
// Na demonstração, addVehicles/removeExtras incluem e tiram veículos com a frota rodando.
import { Path } from '../geo.js';
import { AGENTS, GEO_ROUTES, WAREHOUSE_PATHS } from './routes.js';
import { fetchRoute } from './osrm.js';
import { CARGAS, EMPRESAS, PESSOAS, PRODUTOS } from '../demo.js';
import { startStockSimulation } from './estoque.js';

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const round = (n, step) => Math.round(n / step) * step;

const ETA_REFRESH_MS = 15_000;
// Congestionamento: chance por viagem e duração em minutos de rua (divididos pela aceleração).
const INCIDENTE_CHANCE = 0.35;
const INCIDENTE_MIN = [8, 25];
export const MAX_EXTRAS = 100;

// Veículos incluídos na demonstração: velocidade, paradas e rotas por tipo.
const EXTRA = {
  caminhao: { prefixo: 'TRK', nome: 'Caminhão', speed: [55, 80], stopChance: 0.004, perfis: ['transferencia', 'aereo'] },
  carro: { prefixo: 'VAN', nome: 'Van', speed: [35, 55], stopChance: 0.008, perfis: ['ultimaMilha'] },
};

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
    this.incidente = null; // { em: metros percorridos no trecho, ms, feito }
    this.inicioTrecho = this.s;
    // Empilhadeira: dados de operação que um telemetria real mandaria nos atributos.
    if (def.espaco) {
      this.operacao = { bateria: rand(45, 100), operador: pick(PESSOAS), carga: null, movimentos: Math.floor(rand(5, 40)) };
    }
  }

  /** Empilhadeira chegou na ponta do corredor: pega ou deixa um palete; a bateria vai descendo. */
  #operar(dt, chegou) {
    const op = this.operacao;
    if (!op) return;
    op.bateria -= dt * (this.speed > 0.2 ? 0.05 : 0.01); // % por segundo
    if (op.bateria < 18) op.bateria = 100; // troca de bateria
    if (chegou) {
      if (op.carga) op.movimentos++;
      op.carga = op.carga ? null : pick(PRODUTOS).descricao;
    }
  }

  /** Sorteia um congestionamento no trecho que começa agora. */
  planejarIncidente() {
    this.inicioTrecho = this.s;
    if (Math.random() >= INCIDENTE_CHANCE) {
      this.incidente = null;
      return;
    }
    const restante = this.dir > 0 ? this.path.length - this.s : this.s;
    this.incidente = {
      em: restante * rand(0.15, 0.7),
      ms: (rand(...INCIDENTE_MIN) * 60_000) / this.speedup,
      feito: false,
    };
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
      const inc = this.incidente;
      if (inc && !inc.feito && Math.abs(this.s - this.inicioTrecho) >= inc.em) {
        inc.feito = true;
        this.pausedUntil = now + inc.ms; // congestionamento
      }
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

    this.#operar(dt, events.includes('chegou'));

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
    if (!this.def.espaco) return { ...base, lat: p.a, lon: p.b };
    const op = this.operacao;
    return {
      ...base,
      espaco: this.def.espaco,
      x: p.a,
      y: p.b,
      atributos: {
        bateria: Math.round(op.bateria),
        operador: op.operador,
        carga: op.carga,
        movimentosHoje: op.movimentos,
      },
    };
  }

  /** Previsão de chegada no fim do trecho atual (tempo de rua, já com a aceleração). */
  eta(now) {
    const restante = this.dir > 0 ? this.path.length - this.s : this.s;
    const ms = (restante / ((this.def.speed / 3.6) * this.speedup)) * 1000;
    return Math.round(now + Math.max(0, this.pausedUntil - now) + ms * 1.1);
  }

  /**
   * Nova viagem saindo da ponta onde o veículo está agora. O prazo combinado é a duração
   * esperada com folga variável; `aperto` < 1 gera prazos curtos (viagem que começa atrasada).
   */
  novaViagem(now, status, aperto = rand(1.05, 1.3)) {
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
    this.viagem.previsao = Math.round(now + (this.eta(now) - now) * aperto);
    return this.viagem;
  }
}

export async function startSimulation({ ingest, config, cliente, centros = [], removeAsset = () => {} }) {
  const geoPaths = {};
  await Promise.all(
    Object.entries(GEO_ROUTES).map(async ([key, route]) => {
      const points = await fetchRoute({ osrmUrl: config.osrmUrl, key, waypoints: route.waypoints });
      geoPaths[key] = new Path(points ?? route.waypoints);
    }),
  );

  let running = true;
  const agents = new Map(); // id → { agent, timer, extra }

  const sendTrip = (agent, now, status) => {
    const v = agent.viagem;
    v.status = status;
    v.estimativa = status === 'entregue' || status === 'cancelada' ? null : agent.eta(now);
    const r = ingest.trip(cliente, v, now);
    if (!r.ok) console.warn(`[sim] viagem ${v.id} recusada: ${r.error}`);
  };

  function spawn(def, { extra = false } = {}) {
    const route = def.espaco ? null : GEO_ROUTES[def.route];
    const path = def.espaco
      ? new Path(WAREHOUSE_PATHS[def.espaco][def.path], { local: true })
      : geoPaths[def.route];
    // A planta usa tempo real (speedup 1); as rotas urbanas usam o fator configurado.
    const agent = new Agent(def, path, def.espaco ? 1 : config.simSpeedup, route);
    const interval = def.intervalMs ?? 2000;
    const entry = { agent, timer: null, extra };
    agents.set(def.id, entry);

    if (route) {
      // Já na estrada: parte das viagens começa com prazo curto, para haver atrasos desde o início.
      agent.novaViagem(Date.now(), 'em_transito', Math.random() < 0.25 ? rand(0.5, 0.8) : rand(1.05, 1.3));
      agent.planejarIncidente();
      sendTrip(agent, Date.now(), 'em_transito');
    }

    const tick = () => {
      if (!running || agents.get(def.id) !== entry) return;
      const now = Date.now();
      const events = agent.step(now);
      if (route) {
        if (events.includes('chegou')) {
          sendTrip(agent, now, 'entregue');
          agent.novaViagem(now, 'carregando');
          sendTrip(agent, now, 'carregando');
          agent.etaAt = now;
        } else if (events.includes('partiu')) {
          agent.planejarIncidente();
          sendTrip(agent, now, 'em_transito');
          agent.etaAt = now;
        } else if (now - agent.etaAt > ETA_REFRESH_MS) {
          sendTrip(agent, now, agent.viagem.status);
          agent.etaAt = now;
        }
      }
      const position = agent.report(now);
      if (position) ingest.position(cliente, position, now);
      entry.timer = setTimeout(tick, interval * rand(0.85, 1.15)); // jitter, como em rastreadores reais
    };
    entry.timer = setTimeout(tick, rand(0, interval));
  }

  for (const def of AGENTS) spawn(def);

  /** Próximo número livre do tipo (TRK-005, VAN-005...). */
  const proximo = (prefixo) => {
    let max = 0;
    for (const id of agents.keys()) {
      const m = new RegExp(`^${prefixo}-(\\d+)$`).exec(id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  };

  const extras = () => [...agents.values()].filter((e) => e.extra).length;

  /** Inclui `quantidade` veículos do tipo na frota em movimento. Devolve os ids criados. */
  function addVehicles(tipo, quantidade) {
    const cfg = EXTRA[tipo];
    if (!cfg) throw new Error(`tipo deve ser ${Object.keys(EXTRA).join(' ou ')}`);
    const livres = MAX_EXTRAS - extras();
    if (livres <= 0) throw new Error(`a demonstração já tem ${MAX_EXTRAS} veículos incluídos; remova alguns antes`);
    const rotas = Object.entries(GEO_ROUTES).filter(([, r]) => cfg.perfis.includes(r.perfil)).map(([k]) => k);
    const ids = [];
    for (let i = 0; i < Math.min(quantidade, livres); i++) {
      const n = proximo(cfg.prefixo);
      const id = `${cfg.prefixo}-${String(n).padStart(3, '0')}`;
      spawn(
        {
          id,
          nome: `${cfg.nome} ${String(n).padStart(2, '0')}`,
          tipo,
          route: pick(rotas),
          speed: Math.round(rand(...cfg.speed)),
          start: rand(0.05, 0.95),
          dir: Math.random() < 0.5 ? 1 : -1,
          stopChance: cfg.stopChance,
        },
        { extra: true },
      );
      ids.push(id);
    }
    return ids;
  }

  /** Tira da frota todos os veículos incluídos na demonstração (viagens viram canceladas). */
  function removeExtras() {
    const ids = [];
    const now = Date.now();
    for (const [id, entry] of agents) {
      if (!entry.extra) continue;
      clearTimeout(entry.timer);
      agents.delete(id);
      if (entry.agent.viagem) sendTrip(entry.agent, now, 'cancelada');
      removeAsset(cliente, id);
      ids.push(id);
    }
    return ids;
  }

  const stock = startStockSimulation({ ingest, cliente, centros });

  console.log(`[sim] ${AGENTS.length} ativos simulados para o cliente "${cliente}" (tempo x${config.simSpeedup} nas rotas urbanas).`);
  return {
    cliente,
    addVehicles,
    removeExtras,
    extras,
    stop() {
      running = false;
      stock.stop();
      for (const e of agents.values()) clearTimeout(e.timer);
      agents.clear();
    },
  };
}
