// CDs cadastrados pela tela (POST/PUT/DELETE /api/centros), gravados em data/centros/<cliente>.json.
// Somam-se aos CDs da configuração (clientes.json ou a rede de exemplo), que não são alterados aqui.
// A planta é gerada das medidas do galpão (public/js/planta.js), a mesma regra da pré-visualização.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCentro } from './centros.js';
import { validarGalpao, gerarPlanta } from '../public/js/planta.js';

export const MAX_CADASTRADOS = 100;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function slug(nome) {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cd';
}

/** Valida o formulário do CD. Devolve { dados } (como gravar) ou { error }. */
export function validarCadastro(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'esperado um objeto JSON' };
  const nome = text(raw.nome, 80);
  if (!nome) return { error: 'nome é obrigatório' };
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (raw.lat === '' || raw.lon === '' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { error: 'localização inválida: informe latitude e longitude (ou marque no mapa)' };
  }
  const raio = raw.raioM === undefined || raw.raioM === '' ? 300 : Number(raw.raioM);
  if (!Number.isFinite(raio) || raio < 30 || raio > 5000) return { error: 'raio da cerca deve ficar entre 30 e 5000 m' };
  const g = validarGalpao(raw.galpao);
  if (g.error) return { error: g.error };
  return {
    dados: { nome, endereco: text(raw.endereco, 160) || null, lat, lon, raioM: Math.round(raio), galpao: g.galpao },
  };
}

/** Registro gravado → CD no formato interno (com planta gerada). */
function paraCentro(reg) {
  const r = normalizeCentro({ ...reg, planta: gerarPlanta(reg.galpao) });
  if (!r.ok) return null;
  return { ...r.centro, cadastrado: true, galpao: reg.galpao };
}

export class CentrosCadastro extends EventEmitter {
  /** @param dir pasta dos arquivos (data/centros); @param tenants clientes (centros mutados no lugar) */
  constructor({ dir, tenants }) {
    super();
    this.dir = dir;
    this.tenants = tenants;
    this.registros = new Map(); // cliente → registro[]
  }

  #file(cliente) {
    return path.join(this.dir, `${cliente}.json`); // id do cliente já validado (minúsculas, números, - e _)
  }

  /** Lê os arquivos e acrescenta os CDs cadastrados à lista de cada cliente. */
  load() {
    for (const t of this.tenants.list) {
      const file = this.#file(t.id);
      if (!fs.existsSync(file)) continue;
      let lista;
      try {
        lista = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`${file}: JSON inválido (${err.message})`);
      }
      const regs = [];
      for (const reg of Array.isArray(lista) ? lista : []) {
        const centro = paraCentro(reg);
        if (!centro || t.centros.some((c) => c.id === centro.id)) {
          console.warn(`[cadastro] CD ignorado em ${file}: ${reg?.id ?? '?'} (inválido ou id repetido)`);
          continue;
        }
        t.centros.push(centro);
        regs.push(reg);
      }
      this.registros.set(t.id, regs);
    }
  }

  #salvar(cliente) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.#file(cliente);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.registros.get(cliente) ?? [], null, 2)}\n`);
    fs.renameSync(tmp, file); // troca atômica: nunca fica um arquivo pela metade
  }

  #tenant(cliente) {
    const t = this.tenants.get(cliente);
    if (!t) throw Object.assign(new Error('cliente não encontrado'), { status: 404 });
    return t;
  }

  criar(cliente, raw, now = Date.now()) {
    const t = this.#tenant(cliente);
    const v = validarCadastro(raw);
    if (v.error) return { error: v.error };
    const regs = this.registros.get(cliente) ?? [];
    if (regs.length >= MAX_CADASTRADOS) return { error: `limite de ${MAX_CADASTRADOS} CDs cadastrados atingido` };
    const s = slug(v.dados.nome);
    const base = (s.startsWith('cd-') ? s : `cd-${s}`).slice(0, 60); // "CD Joinville" → cd-joinville
    let id = base;
    for (let n = 2; t.centros.some((c) => c.id === id); n++) id = `${base}-${n}`;
    const reg = { id, ...v.dados, criadoEm: now, atualizadoEm: now };
    const centro = paraCentro(reg);
    t.centros.push(centro);
    regs.push(reg);
    this.registros.set(cliente, regs);
    this.#salvar(cliente);
    this.emit('change', cliente, { tipo: 'criado', centro });
    return { centro };
  }

  atualizar(cliente, id, raw, now = Date.now()) {
    const t = this.#tenant(cliente);
    const regs = this.registros.get(cliente) ?? [];
    const i = regs.findIndex((r) => r.id === id);
    if (i < 0) return this.#naoEditavel(t, id);
    const v = validarCadastro(raw);
    if (v.error) return { error: v.error };
    const reg = { ...regs[i], ...v.dados, atualizadoEm: now };
    const centro = paraCentro(reg);
    const j = t.centros.findIndex((c) => c.id === id);
    t.centros[j] = centro; // a lista é a mesma usada pela cerca: troca no lugar
    regs[i] = reg;
    this.#salvar(cliente);
    this.emit('change', cliente, { tipo: 'atualizado', centro });
    return { centro };
  }

  remover(cliente, id) {
    const t = this.#tenant(cliente);
    const regs = this.registros.get(cliente) ?? [];
    const i = regs.findIndex((r) => r.id === id);
    if (i < 0) return this.#naoEditavel(t, id);
    regs.splice(i, 1);
    const j = t.centros.findIndex((c) => c.id === id);
    if (j >= 0) t.centros.splice(j, 1);
    this.#salvar(cliente);
    this.emit('change', cliente, { tipo: 'removido', id });
    return { ok: true };
  }

  #naoEditavel(t, id) {
    return t.centros.some((c) => c.id === id)
      ? { error: 'este CD vem da configuração (clientes.json ou rede de exemplo) e não pode ser alterado pela tela', status: 409 }
      : { error: 'CD não encontrado', status: 404 };
  }
}
