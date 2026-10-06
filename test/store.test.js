import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssetStore } from '../server/store.js';

const base = { id: 'A', nome: 'A', tipo: 'carro', espaco: null, x: null, y: null, atributos: null };
const pos = (over) => ({ ...base, lat: -27.6, lon: -48.5, rumo: 0, velocidade: 30, ts: 1000, ...over });

test('ignora posições mais antigas que a armazenada', () => {
  const store = new AssetStore();
  assert.equal(store.upsert(pos({ ts: 2000 }), 2000).stored, true);
  assert.equal(store.upsert(pos({ ts: 1500, lat: -1 }), 2100).stored, false);
  assert.equal(store.get('A').lat, -27.6);
});

test('deriva o rumo quando o dispositivo não informa', () => {
  const store = new AssetStore();
  store.upsert(pos({ rumo: null, ts: 1000 }), 1000);
  // ~111 m ao norte
  store.upsert(pos({ rumo: null, lat: -27.599, ts: 2000 }), 2000);
  assert.ok(Math.abs(store.get('A').rumo - 0) < 1 || Math.abs(store.get('A').rumo - 360) < 1);
  // ~100 m a leste
  store.upsert(pos({ rumo: null, lat: -27.599, lon: -48.499, ts: 3000 }), 3000);
  assert.ok(Math.abs(store.get('A').rumo - 90) < 1);
});

test('status: movimento, parado e sem sinal (via sweep)', () => {
  const store = new AssetStore({ offlineAfterMs: 60_000 });
  store.upsert(pos({ velocidade: 40 }), 1000);
  assert.equal(store.get('A').status, 'movimento');
  store.upsert(pos({ velocidade: 0, ts: 2000 }), 2000);
  assert.equal(store.get('A').status, 'parado');

  const updates = [];
  store.on('update', (a) => updates.push(a.status));
  assert.equal(store.sweep(30_000), 0);
  assert.equal(store.sweep(70_000), 1);
  assert.equal(store.get('A').status, 'offline');
  assert.deepEqual(updates, ['offline']);
  assert.equal(store.sweep(80_000), 0); // já estava offline
});

test('rastro respeita o limite e ignora pontos repetidos', () => {
  const store = new AssetStore({ trailMax: 3 });
  for (let i = 0; i < 6; i++) store.upsert(pos({ lat: -27 - i * 0.001, ts: 1000 + i }), 1000 + i);
  store.upsert(pos({ lat: -27 - 5 * 0.001, ts: 2000 }), 2000); // mesma posição
  const { points } = store.trail('A');
  assert.equal(points.length, 3);
  assert.equal(points[2][1], -27.005);
});

test('remove emite evento e apaga rastro', () => {
  const store = new AssetStore();
  store.upsert(pos(), 1000);
  let removed = null;
  store.on('remove', (id) => (removed = id));
  assert.equal(store.remove('A'), true);
  assert.equal(removed, 'A');
  assert.equal(store.trail('A'), null);
  assert.equal(store.remove('A'), false);
});

test('rastro recomeça quando o ativo troca entre mapa e planta', () => {
  const store = new AssetStore();
  store.upsert(pos({ ts: 1000 }), 1000);
  store.upsert(pos({ lat: -27.61, ts: 2000 }), 2000);
  store.upsert(pos({ espaco: 'galpao-1', lat: null, lon: null, x: 10, y: 5, ts: 3000 }), 3000);
  assert.deepEqual(store.trail('A'), { espaco: 'galpao-1', points: [[10, 5, 3000]] });
  store.upsert(pos({ ts: 4000 }), 4000); // saiu do galpão
  assert.deepEqual(store.trail('A'), { espaco: null, points: [[-48.5, -27.6, 4000]] });
});

test('publicAsset expõe receivedAt (relógio do servidor)', async () => {
  const { publicAsset } = await import('../server/store.js');
  const store = new AssetStore();
  store.upsert(pos(), 5000);
  assert.equal(publicAsset(store.get('A')).receivedAt, 5000);
});

test('limite de ativos recusa IDs novos, mas aceita atualizar os existentes', () => {
  const store = new AssetStore({ maxAssets: 2 });
  assert.equal(store.upsert(pos({ id: 'A' }), 1000).stored, true);
  assert.equal(store.upsert(pos({ id: 'B' }), 1000).stored, true);
  const full = store.upsert(pos({ id: 'C' }), 1000);
  assert.equal(full.stored, false);
  assert.match(full.reason, /MAX_ASSETS/);
  assert.equal(store.upsert(pos({ id: 'A', ts: 2000 }), 2000).stored, true);
  store.remove('B');
  assert.equal(store.upsert(pos({ id: 'C' }), 3000).stored, true);
});
