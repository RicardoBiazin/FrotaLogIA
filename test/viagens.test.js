import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeViagem, ViagemStore } from '../server/viagens.js';

const NOW = Date.parse('2026-10-06T14:00:00Z');
const base = (over = {}) => ({
  id: 'VG-1', veiculo: 'T1', status: 'em_transito',
  origem: { nome: 'CD Palhoça', cd: 'cd-palhoca', lat: -27.6, lon: -48.6 },
  destino: { nome: 'Cliente X' },
  remetente: { nome: 'Indústria A', documento: '12.345.678/0001-90' },
  destinatario: { nome: 'Loja B' },
  carga: { descricao: 'Bebidas', pesoKg: '12000', volumeM3: 40.5, volumes: 20, valor: 150000 },
  previsao: '2026-10-06T15:30:00Z',
  ...over,
});

test('normaliza viagem completa (números em texto viram número)', () => {
  const r = normalizeViagem(base(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.viagem.carga.pesoKg, 12000);
  assert.equal(r.viagem.origem.cd, 'cd-palhoca');
  assert.equal(r.viagem.destino.cd, null);
  assert.equal(r.viagem.destino.lat, null);
  assert.equal(r.viagem.previsao, Date.parse('2026-10-06T15:30:00Z'));
  assert.equal(r.viagem.atualizadoEm, NOW);
});

test('rejeita viagem sem o essencial ou com valores inválidos', () => {
  const erro = (over) => normalizeViagem(base(over), NOW).error;
  assert.match(erro({ id: '' }), /id/);
  assert.match(erro({ status: 'voando' }), /status/);
  assert.match(erro({ destino: { nome: '' } }), /destino\.nome/);
  assert.match(erro({ remetente: null }), /remetente\.nome/);
  assert.match(erro({ carga: { pesoKg: 1 } }), /carga\.descricao/);
  assert.match(erro({ carga: { descricao: 'x', pesoKg: -1 } }), /pesoKg/);
  assert.match(erro({ carga: { descricao: 'x', volumeM3: 'muito' } }), /volumeM3/);
  assert.match(erro({ previsao: 'amanhã' }), /previsao/);
  assert.equal(normalizeViagem([], NOW).ok, false);
});

test('status padrão é "planejada" e previsão em segundos vira ms', () => {
  const r = normalizeViagem(base({ status: undefined, previsao: NOW / 1000 + 60 }), NOW);
  assert.equal(r.viagem.status, 'planejada');
  assert.equal(r.viagem.previsao, NOW + 60_000);
});

test('store: ativa do veículo, isolamento por cliente e evento', () => {
  const store = new ViagemStore();
  const updates = [];
  store.on('update', (cliente, v) => updates.push(`${cliente}:${v.id}`));
  store.upsert('c1', normalizeViagem(base(), NOW).viagem);
  store.upsert('c2', normalizeViagem(base({ veiculo: 'OUTRO' }), NOW).viagem);
  assert.equal(store.ativaDoVeiculo('c1', 'T1').id, 'VG-1');
  assert.equal(store.ativaDoVeiculo('c2', 'T1'), null);
  store.upsert('c1', normalizeViagem(base({ status: 'entregue' }), NOW).viagem);
  assert.equal(store.ativaDoVeiculo('c1', 'T1'), null);
  assert.equal(store.list('c1').length, 1);
  assert.equal(store.list('c1', { ativas: true }).length, 0);
  assert.deepEqual(updates, ['c1:VG-1', 'c2:VG-1', 'c1:VG-1']);
});

test('store: guarda só as últimas encerradas e limita as ativas', () => {
  const store = new ViagemStore({ maxEncerradas: 2, maxAtivas: 1 });
  for (let i = 1; i <= 4; i++) {
    store.upsert('c1', normalizeViagem(base({ id: `E${i}`, status: 'entregue' }), NOW).viagem);
  }
  assert.deepEqual(store.list('c1').map((v) => v.id), ['E3', 'E4']);
  assert.equal(store.upsert('c1', normalizeViagem(base({ id: 'A1' }), NOW).viagem).stored, true);
  const full = store.upsert('c1', normalizeViagem(base({ id: 'A2' }), NOW).viagem);
  assert.equal(full.stored, false);
  assert.match(full.reason, /viagens ativas/);
  // atualizar a ativa existente continua valendo
  const update = store.upsert('c1', normalizeViagem(base({ id: 'A1', status: 'descarregando' }), NOW).viagem);
  assert.equal(update.stored, true);
});

test('store: histórico de status com horário, só quando o status muda', () => {
  const store = new ViagemStore();
  const v = (status, t) => normalizeViagem(base({ status }), NOW + t).viagem;
  store.upsert('c1', v('carregando', 0));
  store.upsert('c1', v('carregando', 1000)); // mesma etapa (ex.: estimativa nova): não repete
  store.upsert('c1', v('em_transito', 60_000));
  store.upsert('c1', v('descarregando', 120_000));
  assert.deepEqual(store.get('c1', 'VG-1').historico, [
    { status: 'carregando', em: NOW },
    { status: 'em_transito', em: NOW + 60_000 },
    { status: 'descarregando', em: NOW + 120_000 },
  ]);
  // a entrada não consegue forjar o histórico
  store.upsert('c1', { ...v('entregue', 180_000), historico: [] });
  assert.equal(store.get('c1', 'VG-1').historico.length, 4);
});
