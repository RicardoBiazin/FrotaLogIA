// Utilitários geográficos. Convenções do projeto:
//  - Geográfico: lat/lon em graus (WGS84). Rumo em graus, 0 = norte, sentido horário.
//  - Local (planta): x → leste, y → norte, em metros. Mesmo rumo: 0 = +y, 90 = +x.

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function bearingLocal(x1, y1, x2, y2) {
  return (toDeg(Math.atan2(x2 - x1, y2 - y1)) + 360) % 360;
}

/**
 * Trajeto como polilinha com distância acumulada.
 * Pontos: [lat, lon] (geográfico) ou [x, y] (local, metros).
 */
export class Path {
  constructor(points, { local = false } = {}) {
    if (points.length < 2) throw new Error('Path precisa de ao menos 2 pontos');
    this.points = points;
    this.local = local;
    this.cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + this.#distance(points[i - 1], points[i]));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  #distance(a, b) {
    return this.local
      ? Math.hypot(b[0] - a[0], b[1] - a[1])
      : distanceMeters(a[0], a[1], b[0], b[1]);
  }

  #heading(a, b) {
    return this.local ? bearingLocal(a[0], a[1], b[0], b[1]) : bearing(a[0], a[1], b[0], b[1]);
  }

  /** Posição a `d` metros do início. Retorna { a, b, rumo } (a,b = lat,lon ou x,y). */
  at(d, { reverse = false } = {}) {
    const dist = Math.min(this.length, Math.max(0, d));
    let i = 1;
    while (i < this.cumulative.length - 1 && this.cumulative[i] < dist) i++;
    const p0 = this.points[i - 1];
    const p1 = this.points[i];
    const segLen = this.cumulative[i] - this.cumulative[i - 1];
    const t = segLen > 0 ? (dist - this.cumulative[i - 1]) / segLen : 0;
    const rumo = this.#heading(p0, p1);
    return {
      a: p0[0] + (p1[0] - p0[0]) * t,
      b: p0[1] + (p1[1] - p0[1]) * t,
      rumo: reverse ? (rumo + 180) % 360 : rumo,
    };
  }
}
