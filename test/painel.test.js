import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etapasViagem, progressoViagem, inventarioTop, registrar, tendencia, frotaEmpilhadeiras, atribuirDocas,
} from '../public/js/painel.js';

const MIN = 60_000;
const T0 = 1_000_000_000_000;

test('etapas: feitas com horário, a atual, as futuras e a previsão de entrega', () => {
  const v = {
    status: 'em_transito', previsao: T0 + 40 * MIN, estimativa: T0 + 45 * MIN,
    historico: [{ status: 'carregando', em: T0 }, { status: 'em_transito', em: T0 + 10 * MIN }],
  };
  const e = etapasViagem(v);
  assert.deepEqual(e.map((x) => x.estado), ['feito', 'feito', 'atual', 'futuro', 'futuro']);
  assert.equal(e[0].em, null); // pulada: nasceu carregando
  assert.equal(e[1].em, T0);
  assert.equal(e[2].em, T0 + 10 * MIN);
  assert.equal(e[4].previsto, T0 + 45 * MIN); // usa a estimativa
  assert.deepEqual(etapasViagem({ status: 'entregue', historico: [] }).map((x) => x.estado), Array(5).fill('feito'));
  assert.deepEqual(etapasViagem(null), []);
});

test('progresso pelo tempo, da saída até a chegada estimada', () => {
  const v = { status: 'em_transito', estimativa: T0 + 40 * MIN, historico: [{ status: 'em_transito', em: T0 }] };
  assert.deepEqual(progressoViagem(v, T0 + 10 * MIN), { pct: 0.25, restanteMs: 30 * MIN });
  assert.deepEqual(progressoViagem(v, T0 + 50 * MIN), { pct: 1, restanteMs: 0 }); // atrasado: trava em 100%
  assert.deepEqual(progressoViagem({ ...v, status: 'carregando' }, T0), { pct: 0, restanteMs: null });
  assert.deepEqual(progressoViagem({ ...v, status: 'descarregando' }, T0), { pct: 1, restanteMs: 0 });
  assert.equal(progressoViagem(null, T0), null);
});

test('inventário: soma por produto, ordena e marca estoque baixo', () => {
  const i = (sku, quantidade) => ({ sku, descricao: sku, unidade: 'cx', quantidade });
  const top = inventarioTop([i('A', 10), i('A', 15), i('B', 40), i('C', 5), i('C', 5), i('D', 1), i('E', 2)], 3);
  assert.deepEqual(top.map((p) => [p.sku, p.quantidade, p.paletes, p.situacao]), [
    ['B', 40, 1, 'baixo'],
    ['A', 25, 2, 'ok'],
    ['C', 10, 2, 'ok'],
  ]);
});

test('tendência: diferença para o valor de 15 min atrás', () => {
  const s = [];
  registrar(s, T0, 100);
  registrar(s, T0 + 10 * MIN, 104);
  registrar(s, T0 + 20 * MIN, 110);
  assert.equal(tendencia(s, T0 + 20 * MIN), 10); // contra T0 (o último antes de 5 min)
  assert.equal(tendencia(s, T0 + 30 * MIN), 6); // contra T0 + 10 min
  assert.equal(tendencia([{ t: T0, v: 1 }], T0), null);
  // amostra repetida em menos de 1 min não cresce a série; muito antigas saem
  registrar(s, T0 + 20 * MIN + 1000, 110);
  assert.equal(s.length, 3);
  registrar(s, T0 + 3 * 60 * MIN, 120);
  assert.deepEqual(s.map((x) => x.v), [110, 120]);
});

test('frota de empilhadeiras: trabalhando, situação e bateria', () => {
  const a = (id, over) => ({ id, nome: id, espaco: 'cd', status: 'movimento', velocidade: 8, atributos: {}, ...over });
  const f = frotaEmpilhadeiras([
    a('E1', { atributos: { carga: 'Bebidas', bateria: 80 } }),
    a('E2', { velocidade: 0, status: 'parado', atributos: { bateria: 15 } }),
    a('E3', { status: 'offline', velocidade: 0 }),
    a('E4', {}),
    a('X', { espaco: 'outro' }),
  ], 'cd');
  assert.equal(f.total, 4);
  assert.equal(f.trabalhando, 2);
  assert.deepEqual(f.lista.map((e) => e.situacao), ['Levando Bebidas', 'Bateria baixa', 'Sem sinal', 'Indo buscar palete']);
  assert.equal(f.lista[0].bateria, 80);
  assert.equal(f.lista[3].bateria, null);
});

test('docas: quem está encostado não troca de porta; quem chega pega a primeira livre', () => {
  const portas = ['D1', 'D2', 'D3'];
  let m = atribuirDocas(new Map(), ['T5', 'T2'], portas);
  assert.deepEqual([...m], [['T5', 'D1'], ['T2', 'D2']]);
  m = atribuirDocas(m, ['T2', 'T9'], portas); // T5 saiu, T9 chegou
  assert.deepEqual([...m], [['T2', 'D2'], ['T9', 'D1']]);
  m = atribuirDocas(m, ['T2', 'T9', 'T1', 'T7'], portas); // lotou: T7 vai para a fila
  assert.deepEqual([...m], [['T2', 'D2'], ['T9', 'D1'], ['T1', 'D3'], ['T7', null]]);
  m = atribuirDocas(m, ['T9', 'T1', 'T7'], ['D1', 'D3']); // porta D2 deixou de existir (CD editado)
  assert.deepEqual([...m], [['T9', 'D1'], ['T1', 'D3'], ['T7', null]]);
});
