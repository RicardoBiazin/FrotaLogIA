// Regras de logística da interface: resumo de CD, busca e formatação.
// Código puro (sem DOM), testado em test/logistica.test.js.

export const VIAGEM_LABEL = {
  planejada: 'planejada',
  carregando: 'carregando',
  em_transito: 'em trânsito',
  descarregando: 'descarregando',
  entregue: 'entregue',
  cancelada: 'cancelada',
};
export const ENCERRADAS = new Set(['entregue', 'cancelada']);

// Atraso só conta a partir de 1 min, para o aviso não piscar na borda do prazo.
export const ATRASO_MIN_MS = 60_000;
// Status em que a carga ainda não chegou ao destino.
const A_CAMINHO = new Set(['planejada', 'carregando', 'em_transito']);

/**
 * Atraso da viagem em ms (0 = no prazo). `previsao` é o prazo combinado; `estimativa`,
 * opcional, é a previsão atualizada de chegada. Atrasada quando o prazo já passou ou
 * quando a estimativa indica chegada depois dele.
 */
export function atrasoMs(viagem, now) {
  if (!viagem?.previsao || !A_CAMINHO.has(viagem.status)) return 0;
  const chegada = Math.max(now, viagem.estimativa ?? 0);
  const atraso = chegada - viagem.previsao;
  return atraso >= ATRASO_MIN_MS ? atraso : 0;
}

/** "4 min", "1 h 05 min". */
export function formatDuracao(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

const nf = (digits) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

export function formatPeso(kg) {
  if (kg === null || kg === undefined) return '—';
  return kg >= 1000 ? `${nf(1).format(kg / 1000)} t` : `${nf(0).format(kg)} kg`;
}

export function formatVolume(m3) {
  return m3 === null || m3 === undefined ? '—' : `${nf(1).format(m3)} m³`;
}

export function formatValor(valor) {
  return valor === null || valor === undefined ? '—' : brl.format(valor);
}

export function formatHora(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "14:32 (em 12 min)", "14:32 (atrasada 3 min)" ou "—". */
export function formatPrevisao(previsao, now) {
  if (!previsao) return '—';
  const min = Math.round((previsao - now) / 60_000);
  if (min > 0) return `${formatHora(previsao)} (em ${formatDuracao(previsao - now)})`;
  if (min === 0) return `${formatHora(previsao)} (chegando)`;
  return `${formatHora(previsao)} (atrasada ${formatDuracao(now - previsao)})`;
}

/**
 * Índice das viagens ativas por veículo. Viagem encerrada sai do índice (se ainda for a do veículo).
 * @param byId Map<id, viagem> e byVeiculo Map<veiculo, viagem>, atualizados no lugar
 */
export function applyViagem(byId, byVeiculo, viagem) {
  if (ENCERRADAS.has(viagem.status)) {
    byId.delete(viagem.id);
    if (viagem.veiculo && byVeiculo.get(viagem.veiculo)?.id === viagem.id) byVeiculo.delete(viagem.veiculo);
    return;
  }
  const anterior = byId.get(viagem.id);
  if (anterior?.veiculo && anterior.veiculo !== viagem.veiculo && byVeiculo.get(anterior.veiculo)?.id === viagem.id) {
    byVeiculo.delete(anterior.veiculo);
  }
  byId.set(viagem.id, viagem);
  if (viagem.veiculo) byVeiculo.set(viagem.veiculo, viagem);
}

/**
 * O que acontece num CD agora.
 * @param assets   dados dos ativos (como vêm do servidor)
 * @param viagens  viagens ativas
 * @returns { patio: ativo[], chegando: viagem[], empilhadeiras: ativo[] }
 */
export function resumoCentro(cdId, assets, viagens) {
  const patio = [];
  const empilhadeiras = [];
  for (const a of assets) {
    if (a.espaco === cdId) empilhadeiras.push(a);
    else if (!a.espaco && a.cd === cdId) patio.push(a);
  }
  const noPatio = new Set(patio.map((a) => a.id));
  const chegando = viagens
    .filter((v) => v.destino?.cd === cdId && v.status === 'em_transito' && !noPatio.has(v.veiculo))
    .sort((a, b) => (a.previsao ?? Infinity) - (b.previsao ?? Infinity));
  return { patio, chegando, empilhadeiras };
}

/** Busca por veículo e pelos dados do transporte (carga, origem, destino, remetente...). */
export function matchesQuery(asset, viagem, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const campos = [asset.nome, asset.id];
  if (viagem) {
    campos.push(
      viagem.id, viagem.documento, viagem.carga?.descricao, viagem.origem?.nome, viagem.destino?.nome,
      viagem.remetente?.nome, viagem.destinatario?.nome,
    );
  }
  return campos.some((c) => typeof c === 'string' && c.toLowerCase().includes(q));
}
