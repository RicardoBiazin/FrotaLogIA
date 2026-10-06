// Armazenamento em memória da última posição de cada ativo + rastro recente, separado
// por cliente (o mesmo id pode existir em clientes diferentes sem conflito).
//
// Para produção, esta classe é o ponto de troca: mantenha a mesma interface
// (upsert, get, list, trail, remove, sweep, count, eventos 'update'/'remove') e implemente
// com Redis (última posição) + PostGIS/TimescaleDB (histórico).
import { EventEmitter } from 'node:events';
import { bearing, bearingLocal, distanceMeters } from './geo.js';

const MOVING_KMH = 2;
const MIN_MOVE_FOR_HEADING_M = 1;

/** Campos enviados aos clientes. */
export function publicAsset(a) {
  return {
    id: a.id,
    cd: a.cd ?? null, // CD onde o veículo está (cerca), ou null
    nome: a.nome,
    tipo: a.tipo,
    espaco: a.espaco,
    lat: a.lat,
    lon: a.lon,
    x: a.x,
    y: a.y,
    rumo: a.rumo,
    velocidade: a.velocidade,
    ts: a.ts,
    status: a.status,
    atributos: a.atributos,
    receivedAt: a.receivedAt, // relógio do servidor: base do "atualizado há X"
  };
}

export class AssetStore extends EventEmitter {
  constructor({ offlineAfterMs = 60_000, trailMax = 300, maxAssets = Infinity } = {}) {
    super();
    this.offlineAfterMs = offlineAfterMs;
    this.trailMax = trailMax;
    this.maxAssets = maxAssets;
    this.clientes = new Map(); // cliente → { assets: Map<id, asset>, trails: Map<id, ponto[]> }
    this.total = 0;
  }

  #bucket(cliente, create = false) {
    let b = this.clientes.get(cliente);
    if (!b && create) {
      b = { assets: new Map(), trails: new Map() };
      this.clientes.set(cliente, b);
    }
    return b ?? null;
  }

  count(cliente) {
    return cliente === undefined ? this.total : (this.#bucket(cliente)?.assets.size ?? 0);
  }

  #status(asset, now) {
    if (now - asset.receivedAt > this.offlineAfterMs) return 'offline';
    return asset.velocidade >= MOVING_KMH ? 'movimento' : 'parado';
  }

  #deriveHeading(prev, next) {
    if (!prev || (prev.espaco ?? null) !== (next.espaco ?? null)) return 0;
    if (next.espaco) {
      const moved = Math.hypot(next.x - prev.x, next.y - prev.y);
      return moved >= MIN_MOVE_FOR_HEADING_M ? bearingLocal(prev.x, prev.y, next.x, next.y) : prev.rumo;
    }
    const moved = distanceMeters(prev.lat, prev.lon, next.lat, next.lon);
    return moved >= MIN_MOVE_FOR_HEADING_M ? bearing(prev.lat, prev.lon, next.lat, next.lon) : prev.rumo;
  }

  #pushTrail(trails, asset, prev) {
    let trail = trails.get(asset.id);
    // Trocou de mapa para planta (ou de planta): as coordenadas não se misturam.
    if (!trail || (prev && (prev.espaco ?? null) !== (asset.espaco ?? null))) {
      trail = [];
      trails.set(asset.id, trail);
    }
    const a = asset.espaco ? asset.x : asset.lon;
    const b = asset.espaco ? asset.y : asset.lat;
    const last = trail[trail.length - 1];
    if (last && last[0] === a && last[1] === b) return;
    trail.push([a, b, asset.ts]);
    if (trail.length > this.trailMax) trail.splice(0, trail.length - this.trailMax);
  }

  /** Recebe um ativo já normalizado (ver normalize.js), com `cliente` definido. */
  upsert(input, now = Date.now()) {
    const cliente = input.cliente;
    const prev = this.get(cliente, input.id);
    if (prev && input.ts < prev.ts) return { stored: false, reason: 'posição mais antiga que a já armazenada' };
    if (!prev && this.total >= this.maxAssets) {
      return { stored: false, reason: `limite de ${this.maxAssets} ativos atingido; remova ativos ou aumente MAX_ASSETS` };
    }

    const asset = { ...input, receivedAt: now };
    if (asset.rumo === null) asset.rumo = this.#deriveHeading(prev, asset);
    asset.status = this.#status(asset, now);

    const bucket = this.#bucket(cliente, true);
    bucket.assets.set(asset.id, asset);
    if (!prev) this.total++;
    this.#pushTrail(bucket.trails, asset, prev);
    this.emit('update', asset);
    return { stored: true, asset, prev };
  }

  get(cliente, id) {
    return this.#bucket(cliente)?.assets.get(id) ?? null;
  }

  list(cliente, { tipo, espaco } = {}) {
    let items = [...(this.#bucket(cliente)?.assets.values() ?? [])];
    if (typeof tipo === 'string' && tipo) items = items.filter((a) => a.tipo === tipo);
    if (typeof espaco === 'string' && espaco) items = items.filter((a) => a.espaco === espaco);
    return items;
  }

  /** { espaco, points: [[lon,lat,ts] | [x,y,ts], ...] } ou null se o ativo não existe. */
  trail(cliente, id) {
    const asset = this.get(cliente, id);
    if (!asset) return null;
    return { espaco: asset.espaco, points: this.#bucket(cliente).trails.get(id) ?? [] };
  }

  remove(cliente, id) {
    const bucket = this.#bucket(cliente);
    const existed = bucket?.assets.delete(id) ?? false;
    if (!existed) return false;
    bucket.trails.delete(id);
    this.total--;
    this.emit('remove', cliente, id);
    return true;
  }

  /** Reavalia status (ex.: virou "offline"). Emite 'update' só dos que mudaram. */
  sweep(now = Date.now()) {
    let changed = 0;
    for (const { assets } of this.clientes.values()) {
      for (const asset of assets.values()) {
        const status = this.#status(asset, now);
        if (status !== asset.status) {
          asset.status = status;
          changed++;
          this.emit('update', asset);
        }
      }
    }
    return changed;
  }
}
