// Estoque endereçado nas prateleiras dos CDs (uma posição-palete por endereço).
// Chega por POST /api/estoque (vindo do WMS do cliente) ou do simulador.
//
// Formato aceito:
//   { cd, endereco: "A-03-2", sku, descricao, depositante?, quantidade, unidade?,
//     lote?, validade?, pesoKg?, volumeM3?, entradaEm? }
// quantidade 0 (ou "remover": true) libera o endereço.
// Datas em ISO 8601 ou epoch (ms ou s). Peso em kg, volume em m³.
import { EventEmitter } from 'node:events';
import { validarEndereco } from '../public/js/estoque.js';

const fail = (error) => ({ ok: false, error });
const text = (v, max = 120) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

function amount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function parseTs(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n) < 1e11 ? n * 1000 : n;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * @param centros CDs do cliente (com planta)
 * @returns { ok, item } | { ok, remover: { cd, endereco } } | { ok: false, error }
 */
export function normalizeEstoque(raw, centros, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('esperado um objeto JSON');
  const cdId = text(raw.cd, 64);
  const cd = centros.find((c) => c.id === cdId);
  if (!cd) return fail(`CD "${cdId}" não existe para este cliente`);
  if (!cd.planta?.prateleiras?.length) return fail(`"${cd.nome}" não tem prateleiras cadastradas`);
  const e = validarEndereco(raw.endereco, cd.planta);
  if (e.error) return fail(e.error);

  const quantidade = amount(raw.quantidade);
  if (Number.isNaN(quantidade)) return fail('quantidade deve ser um número maior ou igual a zero');
  if (raw.remover === true || quantidade === 0) return { ok: true, remover: { cd: cd.id, endereco: e.endereco } };
  if (quantidade === null) return fail('quantidade é obrigatória (0 libera o endereço)');

  const sku = text(raw.sku, 40);
  if (!sku) return fail('sku é obrigatório');
  const descricao = text(raw.descricao);
  if (!descricao) return fail('descricao é obrigatória');

  const extras = {};
  for (const campo of ['pesoKg', 'volumeM3']) {
    const n = amount(raw[campo]);
    if (Number.isNaN(n)) return fail(`${campo} deve ser um número maior ou igual a zero`);
    extras[campo] = n;
  }
  for (const campo of ['validade', 'entradaEm']) {
    const ts = parseTs(raw[campo]);
    if (Number.isNaN(ts)) return fail(`${campo} inválida`);
    extras[campo] = ts;
  }

  return {
    ok: true,
    item: {
      cd: cd.id,
      endereco: e.endereco,
      sku,
      descricao,
      depositante: text(raw.depositante) || null,
      quantidade,
      unidade: text(raw.unidade, 10) || 'un',
      lote: text(raw.lote, 40) || null,
      ...extras,
      entradaEm: extras.entradaEm ?? now,
      atualizadoEm: now,
    },
  };
}

/** Estoque por cliente → CD → endereço. */
export class EstoqueStore extends EventEmitter {
  constructor({ maxPorCliente = 200_000 } = {}) {
    super();
    this.maxPorCliente = maxPorCliente;
    this.byCliente = new Map(); // cliente → { total, cds: Map<cd, Map<endereco, item>> }
  }

  #bucket(cliente, create = false) {
    let b = this.byCliente.get(cliente);
    if (!b && create) {
      b = { total: 0, cds: new Map() };
      this.byCliente.set(cliente, b);
    }
    return b ?? null;
  }

  upsert(cliente, item) {
    const b = this.#bucket(cliente, true);
    let cd = b.cds.get(item.cd);
    if (!cd) {
      cd = new Map();
      b.cds.set(item.cd, cd);
    }
    const anterior = cd.get(item.endereco);
    if (!anterior && b.total >= this.maxPorCliente) {
      return { stored: false, reason: `limite de ${this.maxPorCliente} posições ocupadas atingido` };
    }
    // Recebimento do mesmo produto e lote no mesmo endereço mantém a data de entrada original.
    const mesmoPalete = anterior && anterior.sku === item.sku && anterior.lote === item.lote;
    const salvo = mesmoPalete ? { ...item, entradaEm: anterior.entradaEm } : item;
    cd.set(item.endereco, salvo);
    if (!anterior) b.total++;
    this.emit('update', cliente, salvo);
    return { stored: true };
  }

  remove(cliente, cdId, endereco) {
    const b = this.#bucket(cliente);
    const existed = b?.cds.get(cdId)?.delete(endereco) ?? false;
    if (existed) {
      b.total--;
      this.emit('update', cliente, { cd: cdId, endereco, removido: true });
    }
    return existed;
  }

  get(cliente, cdId, endereco) {
    return this.#bucket(cliente)?.cds.get(cdId)?.get(endereco) ?? null;
  }

  list(cliente, cdId) {
    return [...(this.#bucket(cliente)?.cds.get(cdId)?.values() ?? [])];
  }

  /** Onde está o produto: busca por SKU, descrição, depositante, lote ou endereço em todos os CDs. */
  search(cliente, query, { cd, limit = 200 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const out = [];
    for (const [cdId, itens] of this.#bucket(cliente)?.cds ?? []) {
      if (cd && cd !== cdId) continue;
      for (const item of itens.values()) {
        const campos = [item.sku, item.descricao, item.depositante, item.lote, item.endereco];
        if (!q || campos.some((c) => typeof c === 'string' && c.toLowerCase().includes(q))) {
          out.push(item);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
}
