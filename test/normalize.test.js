import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePosition } from '../server/normalize.js';

const NOW = Date.parse('2026-10-06T14:00:00Z');

test('aceita posição geográfica válida e normaliza campos', () => {
  const r = normalizePosition(
    { id: 'TRK-1', tipo: 'Caminhão', lat: -27.59, lon: -48.55, rumo: 370, velocidade: 62, timestamp: '2026-10-06T13:59:58Z' },
    NOW,
  );
  assert.equal(r.ok, true);
  assert.equal(r.asset.tipo, 'caminhao');
  assert.equal(r.asset.rumo, 10);
  assert.equal(r.asset.ts, Date.parse('2026-10-06T13:59:58Z'));
  assert.equal(r.asset.nome, 'TRK-1');
  assert.equal(r.asset.espaco, null);
});

test('aceita posição local (planta) e exige x e y', () => {
  const ok = normalizePosition({ id: 'EMP-1', tipo: 'empilhadeira', espaco: 'galpao-1', x: '12.5', y: 40 }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.asset.x, 12.5);
  assert.equal(ok.asset.lat, null);

  const bad = normalizePosition({ id: 'EMP-1', espaco: 'galpao-1', x: 1 }, NOW);
  assert.equal(bad.ok, false);
});

test('rejeita id ausente, lat/lon inválidos e timestamp no futuro', () => {
  assert.equal(normalizePosition({ lat: 1, lon: 1 }, NOW).ok, false);
  assert.equal(normalizePosition({ id: 'a', lat: 91, lon: 0 }, NOW).ok, false);
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 181 }, NOW).ok, false);
  assert.equal(normalizePosition({ id: 'a', lat: 'x', lon: 0 }, NOW).ok, false);
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, ts: NOW + 10 * 60_000 }, NOW).ok, false);
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, ts: 'não é data' }, NOW).ok, false);
  assert.equal(normalizePosition(null, NOW).ok, false);
  assert.equal(normalizePosition([], NOW).ok, false);
});

test('mapeia aliases de tipo e usa "outro" como padrão', () => {
  const tipo = (t) => normalizePosition({ id: 'a', tipo: t, lat: 0, lon: 0 }, NOW).asset.tipo;
  assert.equal(tipo('truck'), 'caminhao');
  assert.equal(tipo('CAR'), 'carro');
  assert.equal(tipo('forklift'), 'empilhadeira');
  assert.equal(tipo('drone'), 'outro');
  assert.equal(tipo(undefined), 'outro');
});

test('rumo ausente fica null (o store deriva) e velocidade negativa vira 0', () => {
  const r = normalizePosition({ id: 'a', lat: 0, lon: 0, velocidade: -5 }, NOW);
  assert.equal(r.asset.rumo, null);
  assert.equal(r.asset.velocidade, 0);
});

test('aceita "lng" como sinônimo de lon', () => {
  const r = normalizePosition({ id: 'a', lat: 1, lng: 2 }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.asset.lon, 2);
});

test('tipo com nome de propriedade do Object ("constructor", "__proto__") vira "outro"', () => {
  for (const t of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
    const r = normalizePosition({ id: 'a', tipo: t, lat: 0, lon: 0 }, NOW);
    assert.equal(r.asset.tipo, 'outro', t);
  }
});

test('epoch em segundos é convertido para ms (número ou texto)', () => {
  const seconds = Math.floor(NOW / 1000) - 10;
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, ts: seconds }, NOW).asset.ts, seconds * 1000);
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, timestamp: String(seconds) }, NOW).asset.ts, seconds * 1000);
  // em ms continua igual
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, ts: NOW - 10_000 }, NOW).asset.ts, NOW - 10_000);
  // segundos no futuro também são barrados
  assert.equal(normalizePosition({ id: 'a', lat: 0, lon: 0, ts: Math.floor(NOW / 1000) + 600 }, NOW).ok, false);
});

test('limite de atributos é em bytes, não em caracteres', () => {
  const r = normalizePosition({ id: 'a', lat: 0, lon: 0, atributos: { obs: 'ç'.repeat(1500) } }, NOW);
  assert.equal(r.asset.atributos, null); // 1500 caracteres, mas ~3000 bytes
});
