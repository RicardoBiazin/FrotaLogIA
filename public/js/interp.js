// Interpolação de posição: transforma atualizações esparsas (a cada 2–30 s) em movimento
// contínuo a 60 fps. Código puro (sem DOM) para ser testado com `npm test`.
//
// Estratégia: ao chegar uma posição nova, o ícone desliza da posição exibida no momento
// até a nova, durante o intervalo típico entre atualizações (suavizado). Se a próxima
// atualização atrasar, projeta o movimento por velocidade e rumo por alguns segundos.

const METERS_PER_DEGREE = 111_320;

export const MIN_INTERVAL_MS = 300;
export const MAX_INTERVAL_MS = 10_000;
export const MAX_EXTRAPOLATE_MS = 3_000;
export const SNAP_GAP_MS = 60_000; // lacuna maior que isso: salta direto, sem deslizar
const MOVING_KMH = 2;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Interpola ângulos (graus) pelo caminho mais curto. */
export function lerpAngle(a, b, t) {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}

/** Pose { x, y, rumo }: no mapa x = lon e y = lat; na planta x e y em metros. */
export function poseOf(asset) {
  return asset.espaco
    ? { x: asset.x, y: asset.y, rumo: asset.rumo ?? 0 }
    : { x: asset.lon, y: asset.lat, rumo: asset.rumo ?? 0 };
}

/** Avança `meters` a partir da pose, na direção do rumo. */
export function advance(pose, meters, local) {
  const r = (pose.rumo * Math.PI) / 180;
  if (local) {
    return { x: pose.x + Math.sin(r) * meters, y: pose.y + Math.cos(r) * meters, rumo: pose.rumo };
  }
  const dLat = (Math.cos(r) * meters) / METERS_PER_DEGREE;
  const dLon = (Math.sin(r) * meters) / (METERS_PER_DEGREE * Math.cos((pose.y * Math.PI) / 180));
  return { x: pose.x + dLon, y: pose.y + dLat, rumo: pose.rumo };
}

/**
 * Quando a última posição chegou (relógio de parede). Usa o `receivedAt` do servidor
 * quando existe; sem ele, o `fallback` (hora local da chegada).
 */
export function lastSeenOf(data, fallback) {
  return Number.isFinite(data.receivedAt) ? data.receivedAt : fallback;
}

export class AnimatedAsset {
  /**
   * @param data ativo como vem do servidor
   * @param now  tempo monotônico (performance.now())
   */
  constructor(data, now) {
    this.data = data;
    this.local = Boolean(data.espaco);
    this.from = poseOf(data);
    this.to = this.from;
    this.start = now;
    this.duration = 1;
    this.interval = null;
    this.lastSeen = lastSeenOf(data, Date.now()); // relógio de parede, para "atualizado há Xs"
  }

  update(data, now) {
    const prev = this.data;
    // Mensagem só de status (ex.: virou "sem sinal") não conta como posição nova.
    this.lastSeen = lastSeenOf(data, data.ts === prev.ts ? this.lastSeen : Date.now());

    // Mesmo timestamp: só mudou metadado (ex.: status virou "sem sinal"); não reinicia o deslize.
    if (data.ts === prev.ts) {
      this.data = data;
      return;
    }

    const gap = data.ts - prev.ts;
    const sameSpace = (data.espaco ?? null) === (prev.espaco ?? null);
    const next = poseOf(data);

    if (!sameSpace || gap <= 0 || gap > SNAP_GAP_MS) {
      this.from = next;
      this.to = next;
      this.start = now;
      this.duration = 1;
      this.interval = null;
    } else {
      const sample = clamp(gap, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
      this.interval = this.interval === null ? sample : this.interval * 0.5 + sample * 0.5;
      this.from = this.sample(now);
      this.to = next;
      this.start = now;
      this.duration = this.interval;
    }

    this.local = Boolean(data.espaco);
    this.data = data;
  }

  /** Pose exibida no instante `now`. */
  sample(now) {
    const elapsed = now - this.start;
    const t = elapsed / this.duration;

    if (t < 1) {
      return {
        x: lerp(this.from.x, this.to.x, t),
        y: lerp(this.from.y, this.to.y, t),
        // A curva faz a rotação terminar no primeiro terço do deslize.
        rumo: lerpAngle(this.from.rumo, this.to.rumo, Math.min(1, t * 3)),
      };
    }

    const extra = Math.min(elapsed - this.duration, MAX_EXTRAPOLATE_MS) / 1000;
    if (this.data.velocidade >= MOVING_KMH && this.data.status !== 'offline' && extra > 0) {
      return advance(this.to, (this.data.velocidade / 3.6) * extra, this.local);
    }
    return this.to;
  }
}
