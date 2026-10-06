import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyViagem, resumoCentro, matchesQuery, formatPeso, formatVolume, formatPrevisao,
} from '../public/js/logistica.js';

const v = (over) => ({
  id: 'V1', veiculo: 'T1', status: 'em_transito',
  origem: { nome: 'CD A', cd: 'a' }, destino: { nome: 'CD B', cd: 'b' },
  remetente: { nome: 'Indústria Vale Verde' }, destinatario: { nome: 'Loja Centro' },
  carga: { descricao: 'Bebidas', pesoKg: 1000 }, documento: 'CT-e 123', previsao: 0,
  ...over,
});

test('formata peso, volume e previsão', () => {
  assert.equal(formatPeso(850), '850 kg');
  assert.equal(formatPeso(12_400), '12,4 t');
  assert.equal(formatPeso(null), '—');
  assert.equal(formatVolume(38.5), '38,5 m³');
  const now = new Date(2026, 9, 6, 14, 0).getTime();
  assert.equal(formatPrevisao(now + 12 * 60_000, now), '14:12 (em 12 min)');
  assert.equal(formatPrevisao(now + 95 * 60_000, now), '15:35 (em 1 h 35 min)');
  assert.equal(formatPrevisao(now - 3 * 60_000, now), '13:57 (atrasada 3 min)');
  assert.equal(formatPrevisao(null, now), '—');
});

test('índice de viagens ativas: troca de veículo e encerramento', () => {
  const byId = new Map();
  const byVeiculo = new Map();
  applyViagem(byId, byVeiculo, v());
  assert.equal(byVeiculo.get('T1').id, 'V1');
  applyViagem(byId, byVeiculo, v({ veiculo: 'T2' })); // viagem passou para outro veículo
  assert.equal(byVeiculo.has('T1'), false);
  assert.equal(byVeiculo.get('T2').id, 'V1');
  applyViagem(byId, byVeiculo, v({ id: 'V2', veiculo: 'T2' })); // nova viagem do mesmo veículo
  applyViagem(byId, byVeiculo, v({ veiculo: 'T2', status: 'entregue' })); // a antiga encerra
  assert.equal(byVeiculo.get('T2').id, 'V2'); // não apaga a viagem nova
  assert.equal(byId.has('V1'), false);
});

test('resumo do CD: pátio, a caminho e empilhadeiras', () => {
  const assets = [
    { id: 'T1', cd: 'b', espaco: null },
    { id: 'T2', cd: null, espaco: null },
    { id: 'E1', cd: 'b', espaco: 'b' },
  ];
  const viagens = [
    v({ id: 'V1', veiculo: 'T1' }), // já está no pátio: não conta como "a caminho"
    v({ id: 'V2', veiculo: 'T2', previsao: 200 }),
    v({ id: 'V3', veiculo: 'T3', previsao: 100 }),
    v({ id: 'V4', veiculo: 'T4', status: 'carregando' }),
  ];
  const r = resumoCentro('b', assets, viagens);
  assert.deepEqual(r.patio.map((a) => a.id), ['T1']);
  assert.deepEqual(r.empilhadeiras.map((a) => a.id), ['E1']);
  assert.deepEqual(r.chegando.map((x) => x.id), ['V3', 'V2']); // ordenado pela previsão
});

test('busca encontra pelo veículo e pelos dados do transporte', () => {
  const asset = { id: 'TRK-001', nome: 'Caminhão 01' };
  assert.equal(matchesQuery(asset, null, ''), true);
  assert.equal(matchesQuery(asset, null, 'trk'), true);
  assert.equal(matchesQuery(asset, v(), 'bebidas'), true);
  assert.equal(matchesQuery(asset, v(), 'vale verde'), true);
  assert.equal(matchesQuery(asset, v(), 'ct-e 123'), true);
  assert.equal(matchesQuery(asset, v(), 'cd b'), true);
  assert.equal(matchesQuery(asset, v(), 'pneus'), false);
  assert.equal(matchesQuery(asset, null, 'bebidas'), false);
});
