import { normalizePosition } from './normalize.js';

/** Único caminho de entrada de dados: HTTP, adaptadores e simulador passam por aqui. */
export function createIngest(store) {
  return function ingest(raw, now = Date.now()) {
    const result = normalizePosition(raw, now);
    if (!result.ok) return result;
    const stored = store.upsert(result.asset, now);
    return stored.stored ? { ok: true } : { ok: false, error: stored.reason };
  };
}
