// Estoque nas prateleiras do CD: endereçamento, ocupação e busca.
// Código puro (sem DOM), usado pelo servidor (validação) e pela tela; testado em test/estoque.test.js.
//
// Endereço no padrão de armazém: RUA-POSIÇÃO-NÍVEL, ex.: "A-03-2" = rua A, posição 3, nível 2.
//  - rua: id da prateleira na planta ("A", "B"...)
//  - posição: 1..posicoes, ao longo da prateleira (de oeste para leste, ou de sul para norte)
//  - nível: 1..niveis, de baixo para cima (1 = chão)
// Cada endereço é uma posição-palete com um único produto.

const ENDERECO_RE = /^([A-Z0-9]{1,4})-(\d{1,3})-(\d{1,2})$/;
const DIA_MS = 86_400_000;
export const VENCE_EM_DIAS = 30;

export const pad2 = (n) => String(n).padStart(2, '0');
export const formatEndereco = (rua, posicao, nivel) => `${rua}-${pad2(posicao)}-${nivel}`;
export const posicaoKey = (rua, posicao) => `${rua}-${pad2(posicao)}`;

/** { rua, posicao, nivel } ou null. Aceita minúsculas e posição sem zero à esquerda. */
export function parseEndereco(text) {
  const m = ENDERECO_RE.exec(String(text ?? '').trim().toUpperCase());
  if (!m) return null;
  return { rua: m[1], posicao: Number(m[2]), nivel: Number(m[3]) };
}

/** Confere o endereço contra a planta do CD. Devolve o endereço canônico ou { error }. */
export function validarEndereco(text, planta) {
  const e = parseEndereco(text);
  if (!e) return { error: 'endereço inválido; use RUA-POSIÇÃO-NÍVEL, ex.: A-03-2' };
  const rack = (planta?.prateleiras ?? []).find((r) => r.id === e.rua);
  if (!rack) return { error: `rua ${e.rua} não existe neste CD` };
  if (e.posicao < 1 || e.posicao > rack.posicoes) return { error: `rua ${e.rua} tem posições de 1 a ${rack.posicoes}` };
  if (e.nivel < 1 || e.nivel > rack.niveis) return { error: `rua ${e.rua} tem níveis de 1 a ${rack.niveis}` };
  return { endereco: formatEndereco(e.rua, e.posicao, e.nivel), ...e };
}

/** Situação da validade: 'vencido' | 'vencendo' (até VENCE_EM_DIAS) | 'ok' | null (sem validade). */
export function situacaoValidade(validade, now) {
  if (!validade) return null;
  if (validade < now) return 'vencido';
  return validade - now <= VENCE_EM_DIAS * DIA_MS ? 'vencendo' : 'ok';
}

export function diasAte(ts, now) {
  return Math.ceil((ts - now) / DIA_MS);
}

/** Ocupação por posição: Map "A-03" → níveis ocupados. */
export function ocupacaoPorPosicao(itens) {
  const map = new Map();
  for (const item of itens) {
    const e = parseEndereco(item.endereco);
    if (!e) continue;
    const key = posicaoKey(e.rua, e.posicao);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** Itens de uma posição (todos os níveis), do nível mais alto para o chão. */
export function itensDaPosicao(itens, rua, posicao) {
  return itens
    .map((item) => ({ item, e: parseEndereco(item.endereco) }))
    .filter(({ e }) => e && e.rua === rua && e.posicao === posicao)
    .sort((a, b) => b.e.nivel - a.e.nivel)
    .map(({ item }) => item);
}

/** Resumo do estoque do CD: posições-palete, ocupação, SKUs e validade. */
export function resumoEstoque(itens, planta, now) {
  const total = (planta?.prateleiras ?? []).reduce((n, r) => n + (r.posicoes ?? 0) * (r.niveis ?? 0), 0);
  const skus = new Set();
  let vencendo = 0;
  let vencidos = 0;
  let pesoKg = 0;
  for (const item of itens) {
    skus.add(item.sku);
    pesoKg += item.pesoKg ?? 0;
    const s = situacaoValidade(item.validade, now);
    if (s === 'vencendo') vencendo++;
    else if (s === 'vencido') vencidos++;
  }
  return {
    total,
    ocupadas: itens.length,
    percentual: total ? Math.round((itens.length / total) * 100) : 0,
    skus: skus.size,
    vencendo,
    vencidos,
    pesoKg,
  };
}

/** Busca por SKU, descrição, depositante, lote ou endereço. */
export function matchesItem(item, query) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [item.sku, item.descricao, item.depositante, item.lote, item.endereco].some(
    (c) => typeof c === 'string' && c.toLowerCase().includes(q),
  );
}
