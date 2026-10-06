// Clientes (multi-cliente). Cada cliente tem a própria rede: veículos, viagens, CDs e eventos,
// e só enxerga o que é dele. A chave de acesso identifica o cliente na API e no WebSocket.
//
// Fonte: data/clientes.json (ignorado no git), criado com `npm run cliente -- <id> "<nome>"`:
//   [{ "id": "acme", "nome": "ACME Transportes", "chaveSha256": "<hex>",
//      "centros": [{ "id": "cd-1", "nome": "CD Joinville", "lat": -26.3, "lon": -48.8, "raioM": 300 }] }]
// O arquivo guarda só o hash SHA-256 da chave, nunca a chave.
//
// Sem o arquivo, existe um único cliente "demo" com os CDs de exemplo. A chave dele é a
// API_KEY; sem API_KEY o acesso é aberto (modo de desenvolvimento, só em 127.0.0.1).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeCentro } from './centros.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest();

export class Tenants {
  /** @param list [{ id, nome, chaveSha256?: Buffer | null, centros: [...] }] */
  constructor(list, { open = false } = {}) {
    this.list = list;
    this.byId = new Map(list.map((t) => [t.id, t]));
    this.open = open; // sem chave: tudo resolve para o único cliente
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  /** Cliente dono da chave, ou null. Compara todos os hashes em tempo constante. */
  resolve(key) {
    if (this.open) return this.list[0];
    if (typeof key !== 'string' || key === '') return null;
    const digest = sha256(key);
    let found = null;
    for (const t of this.list) {
      if (crypto.timingSafeEqual(digest, t.chaveSha256) && !found) found = t;
    }
    return found;
  }
}

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

/** Valida o conteúdo de clientes.json. Lança erro com a posição exata do problema. */
export function parseTenants(data, { file = 'clientes.json', demoCentros = [] } = {}) {
  if (!Array.isArray(data) || data.length === 0) fail(file, 'esperada uma lista com ao menos um cliente');
  const ids = new Set();
  const list = data.map((raw, i) => {
    const where = `cliente #${i + 1}`;
    if (!raw || typeof raw !== 'object') fail(file, `${where} não é um objeto`);
    const id = String(raw.id ?? '');
    if (!ID_RE.test(id)) fail(file, `${where}: id "${id}" inválido (minúsculas, números, - e _; até 40)`);
    if (ids.has(id)) fail(file, `${where}: id "${id}" repetido`);
    ids.add(id);
    const hash = String(raw.chaveSha256 ?? '').toLowerCase();
    if (!HEX64.test(hash)) fail(file, `${where} (${id}): chaveSha256 ausente ou inválida`);
    const centrosRaw = raw.centros === 'demo' ? demoCentros : raw.centros ?? [];
    if (!Array.isArray(centrosRaw)) fail(file, `${where} (${id}): centros deve ser uma lista ou "demo"`);
    const centros = centrosRaw.map((c, j) => {
      const r = normalizeCentro(c);
      if (!r.ok) fail(file, `${where} (${id}), centro #${j + 1}: ${r.error}`);
      return r.centro;
    });
    return {
      id,
      nome: String(raw.nome ?? id).trim().slice(0, 80) || id,
      chaveSha256: Buffer.from(hash, 'hex'),
      centros,
    };
  });
  return new Tenants(list);
}

/** Carrega os clientes do arquivo ou, sem ele, o cliente "demo". */
export function loadTenants({ file, apiKey = '', demoCentros = [] }) {
  if (file && fs.existsSync(file)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: JSON inválido (${err.message})`);
    }
    return parseTenants(data, { file, demoCentros });
  }
  const demo = {
    id: 'demo',
    nome: 'Demonstração',
    chaveSha256: apiKey ? sha256(apiKey) : null,
    centros: demoCentros,
  };
  return new Tenants([demo], { open: !apiKey });
}
