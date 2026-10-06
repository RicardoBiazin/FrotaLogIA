// Viagens (dados do transporte): o que o veículo leva, de onde, para onde, de quem e para quem.
// Chegam por POST /api/viagens (vindas do TMS/ERP do cliente) ou do simulador.
//
// Formato aceito (campos extras são ignorados):
//   { id, veiculo?, status, documento?, previsao?,
//     origem:  { nome, cd?, lat?, lon? },   destino: { nome, cd?, lat?, lon? },
//     remetente: { nome, documento? },      destinatario: { nome, documento? },
//     carga: { descricao, pesoKg?, volumeM3?, volumes?, valor? } }
// Unidades: peso em kg, volume em m³, valor em R$, previsao em ISO 8601 ou epoch (ms ou s).
import { EventEmitter } from 'node:events';

export const VIAGEM_STATUS = ['planejada', 'carregando', 'em_transito', 'descarregando', 'entregue', 'cancelada'];
export const STATUS_ENCERRADOS = new Set(['entregue', 'cancelada']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const fail = (error) => ({ ok: false, error });
const text = (v, max = 120) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

function amount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function local(raw, campo) {
  if (!raw || typeof raw !== 'object') return { error: `${campo}.nome é obrigatório` };
  const nome = text(raw.nome);
  if (!nome) return { error: `${campo}.nome é obrigatório` };
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  const temCoord = raw.lat != null && raw.lon != null && Number.isFinite(lat) && Number.isFinite(lon);
  return {
    value: {
      nome,
      cd: text(raw.cd, 64) || null,
      lat: temCoord ? lat : null,
      lon: temCoord ? lon : null,
    },
  };
}

function parte(raw, campo) {
  const nome = text(raw?.nome);
  if (!nome) return { error: `${campo}.nome é obrigatório` };
  return { value: { nome, documento: text(raw.documento, 20) || null } };
}

function parseTs(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.abs(n) < 1e11 ? n * 1000 : n;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? NaN : parsed;
}

export function normalizeViagem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('esperado um objeto JSON');
  const id = text(raw.id, 64);
  if (!ID_RE.test(id)) return fail('id é obrigatório (até 64 caracteres: letras, números e . _ : / -)');

  const status = text(raw.status, 20) || 'planejada';
  if (!VIAGEM_STATUS.includes(status)) return fail(`status inválido; use ${VIAGEM_STATUS.join(', ')}`);

  const partes = {};
  for (const [campo, fn] of [['origem', local], ['destino', local], ['remetente', parte], ['destinatario', parte]]) {
    const r = fn(raw[campo], campo);
    if (r.error) return fail(r.error);
    partes[campo] = r.value;
  }

  const c = raw.carga && typeof raw.carga === 'object' ? raw.carga : {};
  const descricao = text(c.descricao);
  if (!descricao) return fail('carga.descricao é obrigatória');
  const carga = { descricao };
  for (const campo of ['pesoKg', 'volumeM3', 'volumes', 'valor']) {
    const n = amount(c[campo]);
    if (Number.isNaN(n)) return fail(`carga.${campo} deve ser um número maior ou igual a zero`);
    carga[campo] = n;
  }

  const previsao = parseTs(raw.previsao);
  if (Number.isNaN(previsao)) return fail('previsao inválida');

  return {
    ok: true,
    viagem: {
      id,
      veiculo: text(raw.veiculo, 64) || null,
      status,
      documento: text(raw.documento, 60) || null,
      ...partes,
      carga,
      previsao,
      atualizadoEm: now,
    },
  };
}

/** Viagens por cliente. Mantém todas as ativas e só as últimas encerradas. */
export class ViagemStore extends EventEmitter {
  constructor({ maxEncerradas = 500, maxAtivas = 50_000 } = {}) {
    super();
    this.maxEncerradas = maxEncerradas;
    this.maxAtivas = maxAtivas;
    this.byCliente = new Map(); // cliente → Map<id, viagem> (ordem de atualização)
  }

  #map(cliente) {
    let m = this.byCliente.get(cliente);
    if (!m) {
      m = new Map();
      this.byCliente.set(cliente, m);
    }
    return m;
  }

  upsert(cliente, viagem) {
    const m = this.#map(cliente);
    const existed = m.has(viagem.id);
    if (!existed && !STATUS_ENCERRADOS.has(viagem.status)) {
      let ativas = 0;
      for (const v of m.values()) if (!STATUS_ENCERRADOS.has(v.status)) ativas++;
      if (ativas >= this.maxAtivas) {
        return { stored: false, reason: `limite de ${this.maxAtivas} viagens ativas atingido` };
      }
    }
    m.delete(viagem.id); // reinsere no fim: a ordem do Map vira a ordem de atualização
    m.set(viagem.id, viagem);
    this.#prune(m);
    this.emit('update', cliente, viagem);
    return { stored: true };
  }

  #prune(m) {
    let encerradas = 0;
    for (const v of m.values()) if (STATUS_ENCERRADOS.has(v.status)) encerradas++;
    for (const [id, v] of m) {
      if (encerradas <= this.maxEncerradas) break;
      if (STATUS_ENCERRADOS.has(v.status)) {
        m.delete(id);
        encerradas--;
      }
    }
  }

  get(cliente, id) {
    return this.byCliente.get(cliente)?.get(id) ?? null;
  }

  list(cliente, { status, veiculo, ativas } = {}) {
    let items = [...(this.byCliente.get(cliente)?.values() ?? [])];
    if (ativas) items = items.filter((v) => !STATUS_ENCERRADOS.has(v.status));
    if (status) items = items.filter((v) => v.status === status);
    if (veiculo) items = items.filter((v) => v.veiculo === veiculo);
    return items;
  }

  /** Viagem ativa mais recente do veículo. */
  ativaDoVeiculo(cliente, veiculo) {
    const items = this.list(cliente, { veiculo, ativas: true });
    return items[items.length - 1] ?? null;
  }
}
