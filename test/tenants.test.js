import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTenants, loadTenants, sha256 } from '../server/tenants.js';
import { locateCentro, normalizeCentro } from '../server/centros.js';

const hex = (k) => sha256(k).toString('hex');
const CD = { id: 'cd-1', nome: 'CD', lat: -27.6, lon: -48.6, raioM: 300 };

test('resolve o cliente pela chave e recusa chave errada ou vazia', () => {
  const t = parseTenants([
    { id: 'alfa', chaveSha256: hex('a') },
    { id: 'beta', nome: 'Beta', chaveSha256: hex('b') },
  ]);
  assert.equal(t.resolve('a').id, 'alfa');
  assert.equal(t.resolve('b').nome, 'Beta');
  assert.equal(t.resolve('c'), null);
  assert.equal(t.resolve(''), null);
  assert.equal(t.resolve(undefined), null);
  assert.equal(t.open, false);
});

test('clientes.json inválido explica o problema', () => {
  const erro = (data) => assert.throws(() => parseTenants(data, { file: 'x.json' }));
  erro([]);
  erro([{ id: 'Maiúsculo', chaveSha256: hex('a') }]);
  erro([{ id: 'a', chaveSha256: 'curta' }]);
  erro([{ id: 'a', chaveSha256: hex('a') }, { id: 'a', chaveSha256: hex('b') }]);
  assert.throws(
    () => parseTenants([{ id: 'a', chaveSha256: hex('a'), centros: [{ id: 'cd', lat: 'x' }] }], { file: 'x.json' }),
    /x\.json: cliente #1 \(a\), centro #1: lat e lon/,
  );
});

test('"centros": "demo" usa a rede de exemplo', () => {
  const t = parseTenants([{ id: 'demo', chaveSha256: hex('a'), centros: 'demo' }], { demoCentros: [CD] });
  assert.equal(t.get('demo').centros[0].id, 'cd-1');
});

test('sem arquivo: cliente demo aberto sem API_KEY e fechado com ela', () => {
  const file = path.join(os.tmpdir(), 'nao-existe-frotalogia.json');
  const aberto = loadTenants({ file, apiKey: '' });
  assert.equal(aberto.open, true);
  assert.equal(aberto.resolve('qualquer').id, 'demo');
  const fechado = loadTenants({ file, apiKey: 'segredo' });
  assert.equal(fechado.open, false);
  assert.equal(fechado.resolve('segredo').id, 'demo');
  assert.equal(fechado.resolve('outra'), null);
});

test('carrega clientes de arquivo e aponta JSON quebrado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frotalogia-'));
  const file = path.join(dir, 'clientes.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'acme', chaveSha256: hex('k') }]));
  assert.equal(loadTenants({ file }).resolve('k').id, 'acme');
  fs.writeFileSync(file, '{quebrado');
  assert.throws(() => loadTenants({ file }), /JSON inválido/);
  fs.rmSync(dir, { recursive: true });
});

test('cerca do CD: dentro do raio, fora dele e o mais próximo na sobreposição', () => {
  const a = normalizeCentro(CD).centro;
  const b = normalizeCentro({ ...CD, id: 'cd-2', lon: -48.6025 }).centro; // ~250 m a oeste
  assert.equal(locateCentro([a], -27.601, -48.6), 'cd-1'); // ~110 m
  assert.equal(locateCentro([a], -27.61, -48.6), null); // ~1,1 km
  assert.equal(locateCentro([a, b], -27.6, -48.602), 'cd-2');
});

test('centro: raio limitado e planta só com números', () => {
  const r = normalizeCentro({
    ...CD,
    raioM: 99_999,
    planta: { largura: 10, altura: 5, zonas: [{ x: 0, y: 0, w: 'x', h: 1 }] },
  });
  assert.equal(r.centro.raioM, 5000);
  assert.deepEqual(r.centro.planta.zonas, []);
  assert.equal(normalizeCentro({ ...CD, planta: { largura: -1, altura: 5 } }).centro.planta, null);
  assert.equal(normalizeCentro({ ...CD, id: '../x' }).ok, false);
});

test('cerca com histerese: quem está dentro só sai depois da margem', () => {
  const a = normalizeCentro(CD).centro; // raio 300 m, margem de saída 450 m
  const lat400 = -27.6 - 400 / 111_195; // ~400 m ao sul
  assert.equal(locateCentro([a], lat400, -48.6), null); // de fora: 400 m não entra
  assert.equal(locateCentro([a], lat400, -48.6, 'cd-1'), 'cd-1'); // de dentro: ainda não saiu
  const lat500 = -27.6 - 500 / 111_195;
  assert.equal(locateCentro([a], lat500, -48.6, 'cd-1'), null);
});
