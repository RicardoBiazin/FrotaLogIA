import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AssetStore } from '../server/store.js';
import { createIngest } from '../server/ingest.js';
import { createApp } from '../server/app.js';
import { SPACES } from '../server/spaces.js';

let server;
let base;
let store;
const config = { apiKey: 'segredo', mapStyleUrl: '', mapCenter: [0, 0], mapZoom: 5, offlineAfterMs: 60_000 };

before(async () => {
  store = new AssetStore();
  const app = createApp({ config, store, ingest: createIngest(store), spaces: SPACES, version: '9.9.9' });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('exige x-api-key para gravar', async () => {
  const res = await post('/api/positions', { id: 'A', lat: 1, lon: 1 });
  assert.equal(res.status, 401);
});

test('aceita lote com rejeições parciais e detalha os erros', async () => {
  const res = await post(
    '/api/positions',
    [{ id: 'T1', tipo: 'truck', lat: -27.6, lon: -48.5, velocidade: 50 }, { id: '', lat: 1, lon: 1 }],
    { 'x-api-key': 'segredo' },
  );
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].index, 1);
});

test('lê ativos, rastro e 404', async () => {
  const list = await (await fetch(`${base}/api/assets?tipo=caminhao`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'T1');
  assert.equal(list[0].status, 'movimento');
  const trail = await (await fetch(`${base}/api/assets/T1/trail`)).json();
  assert.equal(trail.points.length, 1);
  assert.equal((await fetch(`${base}/api/assets/nao-existe`)).status, 404);
});

test('JSON inválido responde 400', async () => {
  const res = await post('/api/positions', '{quebrado', { 'x-api-key': 'segredo' });
  assert.equal(res.status, 400);
});

test('adaptador Traccar converte nós em km/h e categoria em tipo', async () => {
  const res = await post(
    '/api/ingest/traccar',
    {
      device: { id: 7, uniqueId: 'IMEI123', name: 'Volvo FH', category: 'truck' },
      position: { latitude: -27.5, longitude: -48.6, speed: 10, course: 45, fixTime: new Date().toISOString() },
    },
    { 'x-api-key': 'segredo' },
  );
  assert.equal(res.status, 202);
  const a = await (await fetch(`${base}/api/assets/IMEI123`)).json();
  assert.equal(a.tipo, 'caminhao');
  assert.equal(a.nome, 'Volvo FH');
  assert.ok(Math.abs(a.velocidade - 18.52) < 0.01);
});

test('serve a planta e a configuração', async () => {
  const spaces = await (await fetch(`${base}/api/spaces`)).json();
  assert.equal(spaces[0].id, 'galpao-1');
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg.tipos, ['caminhao', 'carro', 'empilhadeira', 'outro']);
});

test('envia cabeçalhos de segurança (CSP só com scripts da origem)', async () => {
  for (const path of ['/', '/api/health']) {
    const res = await fetch(base + path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  }
});

test('health e config informam a versão', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).versao, '9.9.9');
  assert.equal((await (await fetch(`${base}/api/config`)).json()).versao, '9.9.9');
});

test('DELETE exige chave e remove o ativo', async () => {
  assert.equal((await fetch(`${base}/api/assets/T1`, { method: 'DELETE' })).status, 401);
  const res = await fetch(`${base}/api/assets/T1`, { method: 'DELETE', headers: { 'x-api-key': 'segredo' } });
  assert.equal(res.status, 204);
  assert.equal((await fetch(`${base}/api/assets/T1`)).status, 404);
});
