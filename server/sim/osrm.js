// Busca o traçado real das ruas no OSRM e guarda em cache (.cache/routes.json).
// Se o OSRM não responder, devolve null e o simulador usa linhas retas entre os waypoints.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cache/routes.json');

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
}

/** @returns {Promise<Array<[number, number]> | null>} pontos [lat, lon] ou null */
export async function fetchRoute({ osrmUrl, key, waypoints }) {
  const cache = await readCache();
  const cacheKey = `${key}:${JSON.stringify(waypoints)}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const coords = waypoints.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `${osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const line = data.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(line) || line.length < 2) throw new Error('resposta sem geometria');
    const points = line.map(([lon, lat]) => [lat, lon]);
    cache[cacheKey] = points;
    await writeCache(cache);
    return points;
  } catch (err) {
    console.warn(`[sim] OSRM indisponível para "${key}" (${err.message}); usando linha reta.`);
    return null;
  }
}
