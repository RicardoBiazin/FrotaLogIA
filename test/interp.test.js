import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimatedAsset, lerpAngle, advance, SNAP_GAP_MS, MAX_EXTRAPOLATE_MS } from '../public/js/interp.js';

const geo = (over) => ({
  id: 'A', tipo: 'carro', espaco: null, lat: -27.6, lon: -48.5, x: null, y: null,
  rumo: 90, velocidade: 36, ts: 10_000, status: 'movimento', ...over,
});

test('lerpAngle usa o caminho mais curto', () => {
  assert.equal(Math.round(lerpAngle(350, 10, 0.5)), 0);
  assert.equal(Math.round(lerpAngle(10, 350, 0.5)), 0);
  assert.equal(Math.round(lerpAngle(0, 90, 0.5)), 45);
});

test('desliza entre a posição atual e a nova durante o intervalo', () => {
  // velocidade 0 isola a interpolação (sem projeção de movimento)
  const a = new AnimatedAsset(geo({ lon: -48.5, velocidade: 0 }), 0);
  a.update(geo({ lon: -48.4, velocidade: 0, ts: 12_000 }), 100); // intervalo de 2 s entre amostras
  const mid = a.sample(100 + 1000);
  assert.ok(Math.abs(mid.x - -48.45) < 1e-9);
  const end = a.sample(100 + 2000);
  assert.ok(Math.abs(end.x - -48.4) < 1e-9);
});

test('projeta por velocidade e rumo quando a atualização atrasa (e limita o tempo)', () => {
  const a = new AnimatedAsset(geo(), 0); // 36 km/h = 10 m/s, rumo leste
  const after = a.sample(1 + 1000);
  const meters = (after.x - -48.5) * 111_320 * Math.cos((-27.6 * Math.PI) / 180);
  assert.ok(meters > 9 && meters < 11);
  const capped = a.sample(60_000);
  const maxMeters = (capped.x - -48.5) * 111_320 * Math.cos((-27.6 * Math.PI) / 180);
  assert.ok(maxMeters <= (10 * MAX_EXTRAPOLATE_MS) / 1000 + 0.5);
});

test('não projeta ativo parado nem sem sinal', () => {
  const stopped = new AnimatedAsset(geo({ velocidade: 0 }), 0);
  assert.equal(stopped.sample(5000).x, -48.5);
  const offline = new AnimatedAsset(geo({ status: 'offline' }), 0);
  assert.equal(offline.sample(5000).x, -48.5);
});

test('lacuna muito grande salta direto para a nova posição', () => {
  const a = new AnimatedAsset(geo(), 0);
  a.update(geo({ lon: -47, ts: 10_000 + SNAP_GAP_MS + 1 }), 100);
  assert.equal(a.sample(100).x, -47);
});

test('mesmo timestamp só atualiza metadados (não reinicia o deslize)', () => {
  const a = new AnimatedAsset(geo(), 0);
  a.update(geo({ lon: -48.4, ts: 12_000 }), 100);
  const before = a.sample(600);
  a.update(geo({ lon: -48.4, ts: 12_000, status: 'offline' }), 600);
  assert.deepEqual(a.sample(600), before);
  assert.equal(a.data.status, 'offline');
});

test('planta: avança em metros, 0 = +y e 90 = +x', () => {
  const north = advance({ x: 0, y: 0, rumo: 0 }, 5, true);
  assert.ok(Math.abs(north.y - 5) < 1e-9 && Math.abs(north.x) < 1e-9);
  const east = advance({ x: 0, y: 0, rumo: 90 }, 5, true);
  assert.ok(Math.abs(east.x - 5) < 1e-9 && Math.abs(east.y) < 1e-9);
});

test('"atualizado há" não reinicia quando só o status muda para sem sinal', () => {
  const a = new AnimatedAsset(geo({ receivedAt: 1_000 }), 0);
  assert.equal(a.lastSeen, 1_000);
  // sweep do servidor: mesmo ts e receivedAt, status offline
  a.update(geo({ receivedAt: 1_000, status: 'offline' }), 500);
  assert.equal(a.lastSeen, 1_000);
  // posição nova
  a.update(geo({ ts: 12_000, receivedAt: 3_000 }), 600);
  assert.equal(a.lastSeen, 3_000);
});

test('sem receivedAt, mensagem só de status mantém a hora anterior', () => {
  const a = new AnimatedAsset(geo(), 0);
  const first = a.lastSeen;
  a.lastSeen = first - 90_000; // chegou há 90 s
  a.update(geo({ status: 'offline' }), 500);
  assert.equal(a.lastSeen, first - 90_000);
});
