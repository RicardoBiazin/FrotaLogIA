// Centros de distribuição (CDs): ponto no mapa + raio da cerca + planta interna opcional.
// Um veículo dentro do raio está "no CD" (pátio/docas); ativos com { espaco: <id do CD>, x, y }
// aparecem na planta desse CD.
import { distanceMeters } from './geo.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RAIO_PADRAO_M = 300;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const RUA_RE = /^[A-Z0-9]{1,4}$/;
const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const intIn = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/**
 * Prateleira (rua de porta-paletes): retângulo + id da rua, posições ao longo do lado maior e níveis.
 * Sem id, recebe A, B, C... na ordem da lista; sem posições, uma a cada ~5 m; sem níveis, 4.
 */
function normalizeRack(r, i) {
  const comprimento = Math.max(r.w, r.h);
  const id = typeof r.id === 'string' && RUA_RE.test(r.id.trim().toUpperCase()) ? r.id.trim().toUpperCase() : LETRAS[i] ?? `R${i + 1}`;
  return {
    id,
    posicoes: intIn(r.posicoes, 1, 200, Math.max(1, Math.round(comprimento / 5))),
    niveis: intIn(r.niveis, 1, 20, 4),
  };
}

/** Planta: { largura, altura (m), zonas[], portas[], prateleiras[] }. Descarta o que não for número. */
function normalizePlanta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const largura = num(raw.largura);
  const altura = num(raw.altura);
  if (!(largura > 0 && altura > 0 && largura <= 5000 && altura <= 5000)) return null;
  const validRects = (list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, 500)
      .filter((r) => r && [r.x, r.y, r.w, r.h].every((v) => num(v) !== null) && r.w > 0 && r.h > 0);
  const rects = (list, extra = () => ({})) =>
    validRects(list).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, ...extra(r) }));
  // Rua repetida invalidaria o endereçamento: fica só a primeira.
  const racks = (list) =>
    rects(list, (r) => r)
      .map((r, i) => ({ x: r.x, y: r.y, w: r.w, h: r.h, ...normalizeRack(r, i) }))
      .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i);
  return {
    largura,
    altura,
    zonas: rects(raw.zonas, (z) => ({ nome: text(z.nome, 40), tipo: text(z.tipo, 20) })),
    prateleiras: racks(raw.prateleiras),
    portas: (Array.isArray(raw.portas) ? raw.portas : [])
      .slice(0, 100)
      .filter((p) => p && num(p.x) !== null && num(p.w) !== null)
      .map((p) => ({ nome: text(p.nome, 10), x: p.x, w: p.w })),
  };
}

export function normalizeCentro(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'esperado um objeto' };
  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) return { ok: false, error: `id "${id}" inválido` };
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, error: 'lat e lon numéricos são obrigatórios' };
  }
  const raio = num(raw.raioM) ?? RAIO_PADRAO_M;
  return {
    ok: true,
    centro: {
      id,
      nome: text(raw.nome, 80) || id,
      endereco: text(raw.endereco, 160) || null,
      lat,
      lon,
      raioM: Math.min(5000, Math.max(30, raio)),
      planta: normalizePlanta(raw.planta),
    },
  };
}

/** Margem de saída: a estrada perto da borda faz o GPS entrar e sair várias vezes. */
export const exitRadius = (c) => c.raioM + Math.max(150, c.raioM * 0.5);

/**
 * CD que contém o ponto (o mais próximo, se houver sobreposição), ou null.
 * `atual`: CD onde o veículo já estava. Ele só sai depois de passar da margem de saída
 * (histerese), para não gerar entradas e saídas em sequência na borda da cerca.
 */
export function locateCentro(centros, lat, lon, atual = null) {
  if (atual) {
    const c = centros.find((x) => x.id === atual);
    if (c && distanceMeters(lat, lon, c.lat, c.lon) <= exitRadius(c)) return c.id;
  }
  let best = null;
  let bestDist = Infinity;
  for (const c of centros) {
    const d = distanceMeters(lat, lon, c.lat, c.lon);
    if (d <= c.raioM && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best ? best.id : null;
}
