import { normalizePosition } from './normalize.js';
import { normalizeViagem } from './viagens.js';
import { locateCentro } from './centros.js';

/**
 * Único caminho de entrada de dados: HTTP, adaptadores e simulador passam por aqui.
 * Toda entrada pertence a um cliente (resolvido pela chave de acesso, ou o do simulador).
 */
export function createIngest({ store, viagens, eventos, tenants }) {
  function position(cliente, raw, now = Date.now()) {
    const result = normalizePosition(raw, now);
    if (!result.ok) return result;
    const asset = { ...result.asset, cliente };

    // Cerca dos CDs: na planta o CD é o próprio espaço; no mapa, o raio de cada CD
    // (com margem de saída para quem já estava dentro).
    const centros = tenants.get(cliente)?.centros ?? [];
    const atual = asset.espaco ? null : (store.get(cliente, asset.id)?.cd ?? null);
    asset.cd = asset.espaco ? asset.espaco : locateCentro(centros, asset.lat, asset.lon, atual);

    const stored = store.upsert(asset, now);
    if (!stored.stored) return { ok: false, error: stored.reason };

    const antes = stored.prev?.cd ?? null;
    if (!asset.espaco && antes !== asset.cd) {
      const nomeCd = (id) => centros.find((c) => c.id === id)?.nome ?? id;
      const base = { veiculo: asset.id, nome: asset.nome, ts: asset.ts };
      if (antes) eventos.add(cliente, { ...base, tipo: 'saida', cd: antes, cdNome: nomeCd(antes) });
      if (asset.cd) eventos.add(cliente, { ...base, tipo: 'entrada', cd: asset.cd, cdNome: nomeCd(asset.cd) });
    }
    return { ok: true };
  }

  function trip(cliente, raw, now = Date.now()) {
    const result = normalizeViagem(raw, now);
    if (!result.ok) return result;
    const stored = viagens.upsert(cliente, result.viagem);
    return stored.stored ? { ok: true } : { ok: false, error: stored.reason };
  }

  return { position, trip };
}
