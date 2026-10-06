import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Path, bearing, distanceMeters } from '../server/geo.js';

test('1 grau de latitude ≈ 111,2 km', () => {
  const d = distanceMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111_195) < 100);
});

test('rumo: norte = 0, leste = 90', () => {
  assert.ok(Math.abs(bearing(0, 0, 1, 0) - 0) < 0.01);
  assert.ok(Math.abs(bearing(0, 0, 0, 1) - 90) < 0.01);
});

test('Path local: posição, rumo e inversão', () => {
  const path = new Path([[0, 0], [0, 10], [10, 10]], { local: true });
  assert.equal(path.length, 20);
  const mid = path.at(5);
  assert.deepEqual([mid.a, mid.b, mid.rumo], [0, 5, 0]);
  const second = path.at(15);
  assert.deepEqual([second.a, second.b, second.rumo], [5, 10, 90]);
  assert.equal(path.at(5, { reverse: true }).rumo, 180);
  assert.equal(path.at(999).a, 10); // limita ao fim
});

test('Path geográfico percorre a distância pedida', () => {
  const path = new Path([[-27.6, -48.5], [-27.59, -48.5]]);
  const p = path.at(path.length / 2);
  assert.ok(Math.abs(p.a - -27.595) < 1e-6);
});
