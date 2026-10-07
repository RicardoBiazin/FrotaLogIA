import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEndereco, validarEndereco, formatEndereco, ocupacaoPorPosicao, itensDaPosicao,
  resumoEstoque, situacaoValidade, matchesItem,
} from '../public/js/estoque.js';
import { normalizeEstoque, EstoqueStore } from '../server/estoque.js';
import { normalizeCentro } from '../server/centros.js';
import { familiaDe, FAMILIAS } from '../public/js/isoView.js';

const DIA = 86_400_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const PLANTA = { prateleiras: [{ id: 'A', posicoes: 14, niveis: 4 }, { id: 'B', posicoes: 10, niveis: 3 }] };
const item = (endereco, over = {}) => ({ cd: 'cd', endereco, sku: 'S1', descricao: 'Arroz 5 kg', quantidade: 10, ...over });

test('endereço RUA-POSIÇÃO-NÍVEL: leitura, formato e validação contra a planta', () => {
  assert.deepEqual(parseEndereco('a-3-2'), { rua: 'A', posicao: 3, nivel: 2 });
  assert.equal(parseEndereco('A3-2'), null);
  assert.equal(parseEndereco(null), null);
  assert.equal(formatEndereco('B', 7, 1), 'B-07-1');
  assert.equal(validarEndereco('a-3-2', PLANTA).endereco, 'A-03-2');
  assert.match(validarEndereco('C-01-1', PLANTA).error, /rua C não existe/);
  assert.match(validarEndereco('B-11-1', PLANTA).error, /posições de 1 a 10/);
  assert.match(validarEndereco('B-01-4', PLANTA).error, /níveis de 1 a 3/);
  assert.match(validarEndereco('B-00-1', PLANTA).error, /posições/);
});

test('ocupação por posição e níveis de cima para baixo', () => {
  const itens = [item('A-03-1'), item('A-03-4'), item('A-04-2'), item('lixo')];
  assert.deepEqual([...ocupacaoPorPosicao(itens)], [['A-03', 2], ['A-04', 1]]);
  assert.deepEqual(itensDaPosicao(itens, 'A', 3).map((i) => i.endereco), ['A-03-4', 'A-03-1']);
});

test('resumo: ocupação, SKUs, validade e peso', () => {
  const itens = [
    item('A-01-1', { validade: NOW + 10 * DIA, pesoKg: 100 }),
    item('A-01-2', { sku: 'S2', validade: NOW - DIA, pesoKg: 50 }),
    item('B-01-1', { validade: NOW + 90 * DIA }),
    item('B-02-1', { validade: null }),
  ];
  assert.deepEqual(resumoEstoque(itens, PLANTA, NOW), {
    total: 14 * 4 + 10 * 3, ocupadas: 4, percentual: 5, skus: 2, vencendo: 1, vencidos: 1, pesoKg: 150,
  });
  assert.equal(situacaoValidade(NOW + 30 * DIA, NOW), 'vencendo');
  assert.equal(situacaoValidade(NOW + 31 * DIA, NOW), 'ok');
  assert.equal(situacaoValidade(null, NOW), null);
});

test('busca por SKU, descrição, depositante, lote ou endereço', () => {
  const i = item('A-03-2', { depositante: 'Atacado Serra Mar', lote: 'L26001' });
  for (const q of ['arroz', 's1', 'serra mar', 'l26001', 'a-03']) assert.equal(matchesItem(i, q), true, q);
  assert.equal(matchesItem(i, 'pneu'), false);
  assert.equal(matchesItem(i, '   '), false);
});

test('servidor: normaliza palete e recusa o que não cabe na planta', () => {
  const cd = normalizeCentro({
    id: 'cd', lat: 0, lon: 0,
    planta: { largura: 20, altura: 10, prateleiras: [{ x: 1, y: 1, w: 15, h: 2 }] }, // sem id: A, 3 posições, 4 níveis
  }).centro;
  assert.deepEqual(cd.planta.prateleiras[0], { x: 1, y: 1, w: 15, h: 2, id: 'A', posicoes: 3, niveis: 4 });
  const ok = normalizeEstoque({ cd: 'cd', endereco: 'A-2-4', sku: 'S', descricao: 'D', quantidade: '5', validade: NOW / 1000 }, [cd], NOW);
  assert.equal(ok.item.endereco, 'A-02-4');
  assert.equal(ok.item.quantidade, 5);
  assert.equal(ok.item.validade, NOW);
  assert.equal(ok.item.entradaEm, NOW);
  assert.deepEqual(normalizeEstoque({ cd: 'cd', endereco: 'A-01-1', quantidade: 0 }, [cd]).remover, { cd: 'cd', endereco: 'A-01-1' });
  const erro = (over) => normalizeEstoque({ cd: 'cd', endereco: 'A-01-1', sku: 'S', descricao: 'D', quantidade: 1, ...over }, [cd]).error;
  assert.match(erro({ quantidade: -1 }), /quantidade/);
  assert.match(erro({ quantidade: undefined }), /quantidade é obrigatória/);
  assert.match(erro({ descricao: '' }), /descricao/);
  assert.match(erro({ validade: 'logo' }), /validade/);
  assert.match(erro({ pesoKg: 'pesado' }), /pesoKg/);
});

test('rua repetida na planta fica só a primeira', () => {
  const cd = normalizeCentro({
    id: 'cd', lat: 0, lon: 0,
    planta: { largura: 20, altura: 10, prateleiras: [{ id: 'A', x: 1, y: 1, w: 5, h: 1 }, { id: 'a', x: 1, y: 4, w: 5, h: 1 }] },
  }).centro;
  assert.equal(cd.planta.prateleiras.length, 1);
});

test('store: separa clientes, mantém a data de entrada do mesmo palete e emite eventos', () => {
  const s = new EstoqueStore({ maxPorCliente: 2 });
  const eventos = [];
  s.on('update', (cliente, i) => eventos.push(`${cliente}:${i.endereco}${i.removido ? ':x' : ''}`));
  s.upsert('c1', item('A-01-1', { lote: 'L1', entradaEm: 1 }));
  s.upsert('c1', item('A-01-1', { lote: 'L1', entradaEm: 99, quantidade: 4 })); // separação
  assert.equal(s.get('c1', 'cd', 'A-01-1').entradaEm, 1);
  assert.equal(s.get('c1', 'cd', 'A-01-1').quantidade, 4);
  s.upsert('c2', item('A-01-1'));
  assert.equal(s.list('c2', 'cd').length, 1);
  s.upsert('c1', item('A-01-2'));
  assert.equal(s.upsert('c1', item('A-01-3')).stored, false); // limite do cliente
  assert.equal(s.remove('c1', 'cd', 'A-01-2'), true);
  assert.equal(s.remove('c1', 'cd', 'A-01-2'), false);
  assert.deepEqual(s.search('c1', 'arroz').map((i) => i.endereco), ['A-01-1']);
  assert.deepEqual(eventos, ['c1:A-01-1', 'c1:A-01-1', 'c2:A-01-1', 'c1:A-01-2', 'c1:A-01-2:x']);
});

test('vista 3D: cor do palete pela família do produto (prefixo do SKU)', () => {
  assert.equal(familiaDe('BEB-3001').nome, 'Bebidas');
  assert.equal(familiaDe('ele-1001').nome, 'Eletro');
  assert.equal(familiaDe('XYZ-1').nome, 'Outros');
  assert.equal(familiaDe(undefined).nome, 'Outros');
  assert.equal(new Set(FAMILIAS.map((f) => f.cor)).size, FAMILIAS.length); // cores distintas
});
