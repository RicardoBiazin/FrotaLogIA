import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { AssetStore } from '../server/store.js';
import { ViagemStore } from '../server/viagens.js';
import { EventLog } from '../server/eventos.js';
import { EstoqueStore } from '../server/estoque.js';
import { parseTenants, sha256 } from '../server/tenants.js';
import { createIngest } from '../server/ingest.js';
import { createApp } from '../server/app.js';
import { createHub } from '../server/hub.js';

// Simulador de mentira: registra os pedidos de incluir/remover veículos de demonstração.
const simFake = {
  cliente: 'alfa',
  incluidos: [],
  extras() {
    return this.incluidos.length;
  },
  addVehicles(tipo, quantidade) {
    if (tipo !== 'caminhao' && tipo !== 'carro') throw new Error('tipo deve ser caminhao ou carro');
    const ids = Array.from({ length: quantidade }, (_, i) => `${tipo}-${this.incluidos.length + i + 1}`);
    this.incluidos.push(...ids);
    return ids;
  },
  removeExtras() {
    const ids = this.incluidos;
    this.incluidos = [];
    return ids;
  },
};
const demo = { cliente: 'alfa', sim: simFake };

let server;
let hub;
let base;
let store;
const config = { mapStyleUrl: '', mapCenter: [0, 0], mapZoom: 5, offlineAfterMs: 60_000 };
const hex = (k) => sha256(k).toString('hex');
const CD = {
  id: 'cd-1', nome: 'CD Teste', lat: -27.6, lon: -48.6, raioM: 300,
  planta: { largura: 20, altura: 10, prateleiras: [{ id: 'A', x: 2, y: 4, w: 16, h: 2, posicoes: 4, niveis: 3 }] },
};

before(async () => {
  const tenants = parseTenants([
    { id: 'alfa', nome: 'Alfa Transportes', chaveSha256: hex('chave-alfa'), centros: [CD] },
    { id: 'beta', nome: 'Beta Logística', chaveSha256: hex('chave-beta') },
  ]);
  store = new AssetStore();
  const viagens = new ViagemStore();
  const eventos = new EventLog();
  const estoque = new EstoqueStore();
  const ingest = createIngest({ store, viagens, eventos, estoque, tenants });
  const app = createApp({ config, store, viagens, eventos, estoque, ingest, tenants, demo, version: '9.9.9' });
  server = http.createServer(app);
  hub = createHub({ server, store, viagens, eventos, estoque, tenants, batchMs: 50 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  hub.close();
  return new Promise((resolve) => server.close(resolve));
});

const A = { 'x-api-key': 'chave-alfa' };
const B = { 'x-api-key': 'chave-beta' };
const get = (path, headers = {}) => fetch(base + path, { headers });
const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const viagem = (over = {}) => ({
  id: 'VG-1', veiculo: 'T1', status: 'em_transito',
  origem: { nome: 'CD Teste', cd: 'cd-1' }, destino: { nome: 'Cliente X' },
  remetente: { nome: 'Indústria A' }, destinatario: { nome: 'Loja B' },
  carga: { descricao: 'Bebidas', pesoKg: 12_000, volumeM3: 40 },
  ...over,
});

test('leitura e escrita exigem chave; chave errada é recusada', async () => {
  assert.equal((await post('/api/positions', { id: 'A', lat: 1, lon: 1 })).status, 401);
  assert.equal((await get('/api/assets')).status, 401);
  assert.equal((await get('/api/assets', { 'x-api-key': 'errada' })).status, 401);
  assert.equal((await get('/api/viagens')).status, 401);
  assert.equal((await get('/api/centros')).status, 401);
});

test('config e health são públicos e não expõem dados de clientes', async () => {
  const cfg = await (await get('/api/config')).json();
  assert.equal(cfg.auth, true);
  assert.equal(cfg.versao, '9.9.9');
  assert.deepEqual(cfg.tipos, ['caminhao', 'carro', 'empilhadeira', 'outro']);
  const health = await (await get('/api/health')).json();
  assert.equal(health.versao, '9.9.9');
  assert.equal(health.ativos, undefined);
});

test('sessão identifica o cliente pela chave', async () => {
  assert.deepEqual(await (await get('/api/sessao', A)).json(), {
    cliente: { id: 'alfa', nome: 'Alfa Transportes' },
    demo: { pronto: true, extras: 0, maxExtras: 100 }, // alfa é o cliente do simulador neste teste
  });
  assert.equal((await (await get('/api/sessao', B)).json()).demo, null);
  assert.equal((await (await get('/api/sessao', B)).json()).cliente.id, 'beta');
});

test('aceita lote com rejeições parciais e detalha os erros', async () => {
  const res = await post(
    '/api/positions',
    [{ id: 'T1', tipo: 'truck', lat: -27.7, lon: -48.5, velocidade: 50 }, { id: '', lat: 1, lon: 1 }],
    A,
  );
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].index, 1);
});

test('cada cliente só enxerga a própria frota', async () => {
  const alfa = await (await get('/api/assets', A)).json();
  assert.deepEqual(alfa.map((a) => a.id), ['T1']);
  assert.deepEqual(await (await get('/api/assets', B)).json(), []);
  assert.equal((await get('/api/assets/T1', B)).status, 404);
  assert.equal((await get('/api/assets/T1/trail', B)).status, 404);
  assert.equal((await fetch(`${base}/api/assets/T1`, { method: 'DELETE', headers: B })).status, 404);
  assert.equal((await get('/api/assets/T1', A)).status, 200);
});

test('viagem: grava, devolve no ativo e fica isolada por cliente', async () => {
  const res = await post('/api/viagens', viagem(), A);
  assert.equal(res.status, 202);
  const a = await (await get('/api/assets/T1', A)).json();
  assert.equal(a.viagem.id, 'VG-1');
  assert.equal(a.viagem.carga.pesoKg, 12_000);
  assert.equal((await get('/api/viagens/VG-1', B)).status, 404);
  assert.equal((await (await get('/api/viagens?ativas=true', A)).json()).length, 1);

  const bad = await post('/api/viagens', viagem({ id: 'VG-2', status: 'voando' }), A);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).rejected[0].erro, /status inválido/);
});

test('entrada e saída do CD viram eventos do cliente', async () => {
  await post('/api/positions', { id: 'T1', lat: -27.6, lon: -48.6, ts: Date.now() }, A); // dentro do raio
  let a = await (await get('/api/assets/T1', A)).json();
  assert.equal(a.cd, 'cd-1');
  await post('/api/positions', { id: 'T1', lat: -27.7, lon: -48.6, ts: Date.now() + 1 }, A); // ~11 km
  a = await (await get('/api/assets/T1', A)).json();
  assert.equal(a.cd, null);
  const eventos = await (await get('/api/eventos', A)).json();
  assert.deepEqual(eventos.slice(0, 2).map((e) => e.tipo), ['saida', 'entrada']);
  assert.equal(eventos[0].cdNome, 'CD Teste');
  assert.deepEqual(await (await get('/api/eventos', B)).json(), []);
});

test('centros trazem a planta no formato da tela', async () => {
  const [cd] = await (await get('/api/centros', A)).json();
  assert.equal(cd.id, 'cd-1');
  assert.equal(cd.planta.id, 'cd-1');
  assert.equal(cd.planta.largura, 20);
  assert.deepEqual(await (await get('/api/centros', B)).json(), []);
});

const palete = (over = {}) => ({
  cd: 'cd-1', endereco: 'A-02-1', sku: 'BEB-3001', descricao: 'Cerveja lata 350 ml',
  depositante: 'Atacado Serra Mar', quantidade: 90, unidade: 'cx', lote: 'L1', validade: '2027-01-01',
  ...over,
});

test('estoque: grava no endereço, valida contra a planta e libera com quantidade 0', async () => {
  const res = await post('/api/estoque', [
    palete(),
    palete({ endereco: 'a-3-2', sku: 'ALI-1', descricao: 'Arroz' }), // minúscula e sem zero: normaliza
    palete({ endereco: 'B-01-1' }),
    palete({ endereco: 'A-05-1' }),
    palete({ endereco: 'A-01-4' }),
    palete({ cd: 'nao-existe' }),
    palete({ endereco: 'A-01-1', sku: '' }),
  ], A);
  const body = await res.json();
  assert.equal(body.accepted, 2);
  assert.deepEqual(body.rejected.map((r) => r.index), [2, 3, 4, 5, 6]);
  assert.match(body.rejected[0].erro, /rua B não existe/);
  assert.match(body.rejected[1].erro, /posições de 1 a 4/);
  assert.match(body.rejected[2].erro, /níveis de 1 a 3/);

  const itens = await (await get('/api/centros/cd-1/estoque', A)).json();
  assert.deepEqual(itens.map((i) => i.endereco).sort(), ['A-02-1', 'A-03-2']);
  assert.equal(itens.find((i) => i.endereco === 'A-02-1').validade, Date.parse('2027-01-01'));

  await post('/api/estoque', { cd: 'cd-1', endereco: 'A-03-2', quantidade: 0 }, A);
  assert.equal((await (await get('/api/centros/cd-1/estoque', A)).json()).length, 1);
});

test('estoque: busca de produto e isolamento por cliente', async () => {
  const achados = await (await get('/api/estoque?q=cerveja', A)).json();
  assert.deepEqual(achados.map((i) => `${i.cd} ${i.endereco}`), ['cd-1 A-02-1']);
  assert.equal((await get('/api/estoque', A)).status, 400);
  assert.deepEqual(await (await get('/api/estoque?q=cerveja', B)).json(), []);
  assert.equal((await get('/api/centros/cd-1/estoque', B)).status, 404);
  const res = await post('/api/estoque', palete(), B); // beta não tem esse CD
  assert.match((await res.json()).rejected[0].erro, /não existe para este cliente/);
});

test('demonstração: inclui e remove veículos só no cliente do simulador', async () => {
  const send = (method, body, headers) =>
    fetch(`${base}/api/demo/veiculos`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body),
    });
  const ok = await send('POST', { tipo: 'caminhao', quantidade: 3 }, A);
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { incluidos: ['caminhao-1', 'caminhao-2', 'caminhao-3'], extras: 3 });
  assert.equal((await send('POST', { tipo: 'aviao' }, A)).status, 400);
  assert.equal((await send('POST', { tipo: 'carro', quantidade: 50 }, A)).status, 400);
  assert.equal((await send('POST', { tipo: 'carro', quantidade: 1.5 }, A)).status, 400);
  // outro cliente não mexe na demonstração, nem sem chave
  assert.equal((await send('POST', { tipo: 'carro' }, B)).status, 403);
  assert.equal((await send('DELETE', null, B)).status, 403);
  assert.equal((await send('POST', { tipo: 'carro' }, {})).status, 401);
  const rem = await send('DELETE', null, A);
  assert.deepEqual((await rem.json()).removidos.length, 3);
  assert.equal(simFake.extras(), 0);

  // simulador ainda subindo: a sessão já avisa que há demonstração, e incluir responde 503
  demo.sim = null;
  assert.deepEqual((await (await get('/api/sessao', A)).json()).demo, { pronto: false, extras: 0, maxExtras: 100 });
  const cedo = await send('POST', { tipo: 'carro' }, A);
  assert.equal(cedo.status, 503);
  assert.match((await cedo.json()).erro, /iniciando/);
  demo.sim = simFake;
});

test('viagem guarda a estimativa e recusa estimativa inválida', async () => {
  const prazo = Date.now() + 60_000;
  await post('/api/viagens', viagem({ id: 'VG-EST', previsao: prazo, estimativa: prazo + 5 * 60_000 }), A);
  const v = await (await get('/api/viagens/VG-EST', A)).json();
  assert.equal(v.estimativa, prazo + 5 * 60_000);
  const bad = await post('/api/viagens', viagem({ id: 'VG-EST2', estimativa: 'logo' }), A);
  assert.match((await bad.json()).rejected[0].erro, /estimativa/);
});

test('serve o Three.js da vista 3D (módulo e o núcleo que ele importa)', async () => {
  for (const f of ['three.module.js', 'three.core.js']) {
    const res = await fetch(`${base}/vendor/three/${f}`);
    assert.equal(res.status, 200, f);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});

test('JSON inválido responde 400', async () => {
  const res = await post('/api/positions', '{quebrado', A);
  assert.equal(res.status, 400);
});

test('adaptador Traccar converte nós em km/h e categoria em tipo', async () => {
  const res = await post(
    '/api/ingest/traccar',
    {
      device: { id: 7, uniqueId: 'IMEI123', name: 'Volvo FH', category: 'truck' },
      position: { latitude: -27.5, longitude: -48.6, speed: 10, course: 45, fixTime: new Date().toISOString() },
    },
    A,
  );
  assert.equal(res.status, 202);
  const a = await (await get('/api/assets/IMEI123', A)).json();
  assert.equal(a.tipo, 'caminhao');
  assert.equal(a.nome, 'Volvo FH');
  assert.ok(Math.abs(a.velocidade - 18.52) < 0.01);
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
  assert.equal((await get('/api/assets', A)).headers.get('cache-control'), 'no-store');
});

test('DELETE remove o ativo do próprio cliente', async () => {
  const res = await fetch(`${base}/api/assets/IMEI123`, { method: 'DELETE', headers: A });
  assert.equal(res.status, 204);
  assert.equal((await get('/api/assets/IMEI123', A)).status, 404);
});

// ---------- WebSocket ----------

function openWs() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    messages.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const next = (pred) =>
    new Promise((resolve, reject) => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('mensagem não chegou')), 2000);
    });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise((resolve) => ws.on('open', resolve));
  return { ws, next, closed, opened };
}

test('WebSocket: chave inválida fecha com 4401 e não recebe dados', async () => {
  const c = openWs();
  await c.opened;
  c.ws.send(JSON.stringify({ type: 'auth', chave: 'errada' }));
  assert.equal(await c.closed, 4401);
});

test('WebSocket: snapshot e lotes só do próprio cliente', async () => {
  const alfa = openWs();
  const beta = openWs();
  await Promise.all([alfa.opened, beta.opened]);
  alfa.ws.send(JSON.stringify({ type: 'auth', chave: 'chave-alfa' }));
  beta.ws.send(JSON.stringify({ type: 'auth', chave: 'chave-beta' }));

  const snapA = await alfa.next((m) => m.type === 'snapshot');
  assert.equal(snapA.cliente.id, 'alfa');
  assert.ok(snapA.assets.some((a) => a.id === 'T1'));
  assert.ok(snapA.viagens.some((v) => v.id === 'VG-1'));
  const snapB = await beta.next((m) => m.type === 'snapshot');
  assert.deepEqual(snapB.assets, []);

  await post('/api/positions', { id: 'SO-ALFA', lat: -27, lon: -48 }, A);
  const batch = await alfa.next((m) => m.type === 'batch' && m.assets.some((a) => a.id === 'SO-ALFA'));
  assert.ok(batch);
  await post('/api/estoque', palete({ endereco: 'A-04-3', sku: 'X-9' }), A);
  const lote = await alfa.next((m) => m.type === 'batch' && m.estoque?.some((i) => i.endereco === 'A-04-3'));
  assert.equal(lote.estoque.find((i) => i.endereco === 'A-04-3').cd, 'cd-1');
  // beta não pode receber lote nenhum (espera o timeout de 2 s do next)
  const vazou = await beta.next((m) => m.type === 'batch').then(() => true, () => false);
  assert.equal(vazou, false);
  alfa.ws.close();
  beta.ws.close();
});
