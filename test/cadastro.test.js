import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { validarGalpao, gerarPlanta, capacidadeGalpao, resumoGalpao } from '../public/js/planta.js';
import { validarEndereco } from '../public/js/estoque.js';
import { CentrosCadastro, validarCadastro } from '../server/cadastro.js';
import { parseTenants, sha256 } from '../server/tenants.js';
import { AssetStore } from '../server/store.js';
import { ViagemStore } from '../server/viagens.js';
import { EventLog } from '../server/eventos.js';
import { EstoqueStore } from '../server/estoque.js';
import { createIngest } from '../server/ingest.js';
import { createApp } from '../server/app.js';
import { locateCentro } from '../server/centros.js';

const G = { largura: 80, comprimento: 56, docas: 6, ruas: 4, niveis: 4 };

// ---------- gerador de planta ----------

test('planta gerada: zonas, docas espaçadas e ruas dentro da armazenagem', () => {
  const p = gerarPlanta(validarGalpao(G).galpao);
  assert.equal(p.largura, 80);
  assert.equal(p.altura, 56);
  assert.deepEqual(p.zonas.map((z) => z.tipo), ['doca', 'expedicao', 'estoque', 'picking']);
  assert.equal(p.portas.length, 6);
  assert.deepEqual(p.portas.map((d) => d.nome), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  for (const d of p.portas) assert.ok(d.x >= 0 && d.x + d.w <= 80);
  assert.deepEqual(p.prateleiras.map((r) => r.id), ['A', 'B', 'C', 'D']);
  const arm = p.zonas.find((z) => z.tipo === 'estoque');
  for (const r of p.prateleiras) {
    assert.ok(r.y >= arm.y && r.y + r.h <= arm.y + arm.h, `rua ${r.id} dentro da armazenagem`);
    assert.equal(r.niveis, 4);
    assert.equal(r.posicoes, 24); // (80 - 14) / 2,7
  }
  // corredor entre ruas de ao menos 3,5 m
  for (let i = 1; i < p.prateleiras.length; i++) {
    assert.ok(p.prateleiras[i].y - (p.prateleiras[i - 1].y + 3) >= 3.5);
  }
  assert.equal(validarEndereco('D-24-4', p).endereco, 'D-24-4');
  assert.deepEqual(resumoGalpao(validarGalpao(G).galpao), { posicoesPalete: 4 * 24 * 4, area: 4480, porRua: 24 });
});

test('galpão: posições por rua manuais, sem docas e sem ruas (cross-docking)', () => {
  assert.equal(gerarPlanta(validarGalpao({ ...G, posicoes: 10 }).galpao).prateleiras[0].posicoes, 10);
  const cross = gerarPlanta(validarGalpao({ ...G, docas: 0, ruas: 0 }).galpao);
  assert.deepEqual([cross.portas.length, cross.prateleiras.length], [0, 0]);
});

test('galpão: medidas fora do limite ou que não cabem são recusadas com explicação', () => {
  const erro = (over) => validarGalpao({ ...G, ...over }).error;
  assert.match(erro({ largura: 5 }), /largura deve ficar entre 20 e 500/);
  assert.match(erro({ niveis: 2.5 }), /níveis deve ser um número inteiro/);
  assert.match(erro({ docas: 'muitas' }), /docas deve ser um número/);
  assert.match(erro({ ruas: 9 }), /cabem no máximo 4 ruas .* 6,5 m/);
  assert.match(erro({ largura: 30, docas: 7 }), /cabem no máximo 6 docas em 30 m/);
  assert.deepEqual(capacidadeGalpao(80, 56), { ruas: 4, docas: 16, posicoes: 24 });
  assert.match(validarGalpao(null).error, /medidas/);
});

test('cadastro: nome, localização e raio', () => {
  const ok = { nome: 'CD Teste', lat: -27, lon: -48, galpao: G };
  assert.equal(validarCadastro(ok).dados.raioM, 300); // padrão
  assert.match(validarCadastro({ ...ok, nome: ' ' }).error, /nome/);
  assert.match(validarCadastro({ ...ok, lat: '' }).error, /localização/);
  assert.match(validarCadastro({ ...ok, lon: 200 }).error, /localização/);
  assert.match(validarCadastro({ ...ok, raioM: 10 }).error, /raio/);
  assert.match(validarCadastro({ ...ok, galpao: { ...G, ruas: 30 } }).error, /ruas/);
});

// ---------- API ----------

const hex = (k) => sha256(k).toString('hex');
const CD_CONFIG = { id: 'cd-config', nome: 'CD da configuração', lat: -27.6, lon: -48.6, raioM: 300 };
let dir;
let server;
let base;
let tenants;
let estoque;
let cadastro;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frotalogia-cd-'));
  tenants = parseTenants([
    { id: 'alfa', chaveSha256: hex('a'), centros: [CD_CONFIG] },
    { id: 'beta', chaveSha256: hex('b') },
  ]);
  cadastro = new CentrosCadastro({ dir, tenants });
  cadastro.load();
  const store = new AssetStore();
  estoque = new EstoqueStore();
  const ingest = createIngest({ store, viagens: new ViagemStore(), eventos: new EventLog(), estoque, tenants });
  cadastro.on('change', (cliente, ev) => {
    if (ev.tipo === 'removido') estoque.limparCd(cliente, ev.id, null);
    else if (ev.tipo === 'atualizado') estoque.limparCd(cliente, ev.centro.id, ev.centro.planta);
  });
  const app = createApp({
    config: { mapCenter: [0, 0], mapZoom: 5, offlineAfterMs: 60_000 },
    store, viagens: new ViagemStore(), eventos: new EventLog(), estoque, ingest, tenants, cadastro,
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve) => server.close(resolve));
});

const call = (method, p, body, chave = 'a') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': chave }, body: body && JSON.stringify(body) });
const novoCd = { nome: 'CD Joinville', endereco: 'BR-101, Joinville (SC)', lat: -26.27, lon: -48.85, raioM: 400, galpao: G };

test('API: cria CD com planta gerada, grava em disco e passa a valer na cerca', async () => {
  const res = await call('POST', '/api/centros', novoCd);
  assert.equal(res.status, 201);
  const cd = await res.json();
  assert.equal(cd.id, 'cd-joinville');
  assert.equal(cd.cadastrado, true);
  assert.equal(cd.planta.prateleiras.length, 4);
  assert.equal(cd.planta.id, 'cd-joinville');
  // mesmo nome de novo: id único
  assert.equal((await (await call('POST', '/api/centros', novoCd)).json()).id, 'cd-joinville-2');
  const lista = await (await call('GET', '/api/centros')).json();
  assert.deepEqual(lista.map((c) => [c.id, c.cadastrado]), [['cd-config', false], ['cd-joinville', true], ['cd-joinville-2', true]]);
  // gravado e válido para a cerca de veículos
  const salvo = JSON.parse(fs.readFileSync(path.join(dir, 'alfa.json'), 'utf8'));
  assert.equal(salvo.length, 2);
  assert.equal(locateCentro(tenants.get('alfa').centros, -26.27, -48.85), 'cd-joinville');
  // outro cliente não vê
  assert.deepEqual(await (await call('GET', '/api/centros', null, 'b')).json(), []);
});

test('API: recusa dados inválidos e não mexe nos CDs da configuração', async () => {
  const bad = await call('POST', '/api/centros', { ...novoCd, galpao: { ...G, ruas: 20 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).erro, /ruas/);
  assert.equal((await call('PUT', '/api/centros/cd-config', novoCd)).status, 409);
  assert.equal((await call('DELETE', '/api/centros/cd-config')).status, 409);
  assert.equal((await call('DELETE', '/api/centros/nao-existe')).status, 404);
  assert.equal((await call('DELETE', '/api/centros/cd-joinville', null, 'b')).status, 404); // de outro cliente
  assert.equal((await call('POST', '/api/centros', novoCd, 'errada')).status, 401);
});

test('API: editar reduz as ruas e tira do estoque os endereços que sumiram; excluir limpa tudo', async () => {
  for (const endereco of ['A-01-1', 'D-01-1']) {
    const r = await call('POST', '/api/estoque', { cd: 'cd-joinville', endereco, sku: 'S', descricao: 'Caixa', quantidade: 5 });
    assert.equal(r.status, 202);
  }
  const res = await call('PUT', '/api/centros/cd-joinville', { ...novoCd, nome: 'CD Joinville Sul', galpao: { ...G, ruas: 2 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).nome, 'CD Joinville Sul');
  assert.deepEqual(estoque.list('alfa', 'cd-joinville').map((i) => i.endereco), ['A-01-1']); // rua D não existe mais
  assert.equal((await call('DELETE', '/api/centros/cd-joinville')).status, 200);
  assert.equal(estoque.list('alfa', 'cd-joinville').length, 0);
  assert.equal(tenants.get('alfa').centros.some((c) => c.id === 'cd-joinville'), false);
});

test('cadastro: recarrega do disco ao reiniciar', () => {
  const t2 = parseTenants([{ id: 'alfa', chaveSha256: hex('a'), centros: [CD_CONFIG] }]);
  new CentrosCadastro({ dir, tenants: t2 }).load();
  assert.deepEqual(t2.get('alfa').centros.map((c) => c.id), ['cd-config', 'cd-joinville-2']);
});
