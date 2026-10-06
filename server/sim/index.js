// Simulador de frota. Gera posições e as entrega pelo mesmo caminho dos dados reais
// (ingest → normalize → store), então trocar a fonte não exige mudar mais nada.
import { Path } from '../geo.js';
import { AGENTS, GEO_ROUTES, WAREHOUSE_PATHS } from './routes.js';
import { fetchRoute } from './osrm.js';

const rand = (min, max) => min + Math.random() * (max - min);

class Agent {
  constructor(def, path, speedup) {
    this.def = def;
    this.path = path;
    this.speedup = speedup;
    this.s = (def.start ?? 0) * path.length;
    this.dir = def.dir ?? 1;
    this.speed = 0; // m/s reais (sem aceleração de tempo)
    this.pausedUntil = 0;
    this.last = Date.now();
    this.nextDropoutAt = def.dropout ? Date.now() + rand(0.3, 1) * def.dropout.everySec * 1000 : Infinity;
    this.silentUntil = 0;
  }

  step(now) {
    const dt = Math.min((now - this.last) / 1000, 5);
    this.last = now;

    if (now < this.pausedUntil) {
      this.speed = 0;
    } else {
      const target = (this.def.speed * rand(0.85, 1.15)) / 3.6;
      this.speed += (target - this.speed) * 0.5;
      this.s += this.dir * this.speed * dt * this.speedup;

      const end = this.path.length;
      if (this.s >= end || this.s <= 0) {
        this.s = Math.min(end, Math.max(0, this.s));
        this.dir *= -1;
        this.pausedUntil = now + rand(8, 20) * 1000; // carga/descarga
      } else if (Math.random() < this.def.stopChance * dt) {
        this.pausedUntil = now + rand(6, 18) * 1000; // semáforo, fila, pausa
      }
    }

    if (now >= this.nextDropoutAt) {
      this.silentUntil = now + this.def.dropout.forSec * 1000;
      this.nextDropoutAt = this.silentUntil + this.def.dropout.everySec * 1000;
    }
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
}

export async function startSimulation({ ingest, config }) {
  const geoPaths = {};
  await Promise.all(
    Object.entries(GEO_ROUTES).map(async ([key, route]) => {
      const points = await fetchRoute({ osrmUrl: config.osrmUrl, key, waypoints: route.waypoints });
      geoPaths[key] = new Path(points ?? route.waypoints);
    }),
  );

  let running = true;
  const timers = new Map(); // um timer pendente por agente

  for (const def of AGENTS) {
    const path = def.espaco ? new Path(WAREHOUSE_PATHS[def.path], { local: true }) : geoPaths[def.route];
    // O espaço interno usa tempo real (speedup 1); as rotas urbanas usam o fator configurado.
    const agent = new Agent(def, path, def.espaco ? 1 : config.simSpeedup);
    const interval = def.intervalMs ?? 2000;

    const tick = () => {
      if (!running) return;
      const now = Date.now();
      agent.step(now);
      const position = agent.report(now);
      if (position) ingest(position, now);
      timers.set(def.id, setTimeout(tick, interval * rand(0.85, 1.15))); // jitter, como em rastreadores reais
    };
    timers.set(def.id, setTimeout(tick, rand(0, interval)));
  }

  console.log(`[sim] ${AGENTS.length} ativos simulados (tempo x${config.simSpeedup} nas rotas urbanas).`);
  return {
    stop() {
      running = false;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
