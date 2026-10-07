// Regras do painel de operação do CD (formato "jogo de estratégia" da vista 3D):
// etapas da viagem, progresso, inventário, tendência dos indicadores e frota de empilhadeiras.
// Código puro (sem DOM), testado em test/painel.test.js.

export const ETAPAS = [
  { status: 'planejada', label: 'Pedido confirmado' },
  { status: 'carregando', label: 'Carregando' },
  { status: 'em_transito', label: 'Em trânsito' },
  { status: 'descarregando', label: 'Descarregando' },
  { status: 'entregue', label: 'Entregue' },
];
const ORDEM = new Map(ETAPAS.map((e, i) => [e.status, i]));

/**
 * Etapas da viagem para o rastreamento: cada uma com estado 'feito' | 'atual' | 'futuro',
 * o horário em que aconteceu (do histórico) e, na entrega ainda por vir, a previsão.
 * Etapas puladas (ex.: viagem que já nasceu carregando) contam como feitas, sem horário.
 */
export function etapasViagem(viagem) {
  if (!viagem) return [];
  const atual = ORDEM.get(viagem.status) ?? 0;
  const quando = new Map((viagem.historico ?? []).map((h) => [h.status, h.em]));
  return ETAPAS.map((e, i) => {
    const estado = i < atual || viagem.status === 'entregue' ? 'feito' : i === atual ? 'atual' : 'futuro';
    const previsto = e.status === 'entregue' && estado !== 'feito' ? viagem.estimativa ?? viagem.previsao ?? null : null;
    return { ...e, estado, em: quando.get(e.status) ?? null, previsto };
  });
}

/**
 * Progresso da viagem (0–1) e quanto falta (ms), pelo tempo: da saída (entrada em "em trânsito")
 * até a chegada estimada (ou o prazo). Antes de sair: 0; chegou/descarregando/entregue: 1.
 */
export function progressoViagem(viagem, now) {
  if (!viagem) return null;
  if (['descarregando', 'entregue'].includes(viagem.status)) return { pct: 1, restanteMs: 0 };
  if (viagem.status !== 'em_transito') return { pct: 0, restanteMs: null };
  const saida = (viagem.historico ?? []).find((h) => h.status === 'em_transito')?.em;
  const chegada = viagem.estimativa ?? viagem.previsao;
  if (!saida || !chegada || chegada <= saida) return { pct: 0.5, restanteMs: chegada ? Math.max(0, chegada - now) : null };
  const pct = Math.min(1, Math.max(0, (now - saida) / (chegada - saida)));
  return { pct, restanteMs: Math.max(0, chegada - now) };
}

/**
 * Inventário do CD por produto: os `n` com mais unidades. Estoque baixo = um palete só
 * (no próximo pedido grande a posição esvazia).
 */
export function inventarioTop(itens, n = 4) {
  const porSku = new Map();
  for (const i of itens) {
    const p = porSku.get(i.sku) ?? { sku: i.sku, descricao: i.descricao, unidade: i.unidade, quantidade: 0, paletes: 0 };
    p.quantidade += i.quantidade ?? 0;
    p.paletes += 1;
    porSku.set(i.sku, p);
  }
  return [...porSku.values()]
    .sort((a, b) => b.quantidade - a.quantidade || a.sku.localeCompare(b.sku))
    .slice(0, n)
    .map((p) => ({ ...p, situacao: p.paletes <= 1 ? 'baixo' : 'ok' }));
}

/**
 * Série de um indicador ao longo do tempo (amostras { t, v }, mais antigas primeiro).
 * `registrar` guarda uma amostra e descarta as mais velhas que `guardarMs`.
 */
export function registrar(serie, t, v, guardarMs = 60 * 60_000) {
  if (serie.at(-1)?.v === v && t - serie.at(-1).t < 60_000) return serie; // sem mudança: não cresce
  serie.push({ t, v });
  while (serie.length > 2 && serie[0].t < t - guardarMs) serie.shift();
  return serie;
}

/** Variação do indicador na janela: valor atual menos o valor de `janelaMs` atrás (ou o mais antigo). */
export function tendencia(serie, now, janelaMs = 15 * 60_000) {
  if (serie.length < 2) return null;
  const atual = serie.at(-1).v;
  let ref = serie[0];
  for (const s of serie) {
    if (s.t <= now - janelaMs) ref = s;
    else break;
  }
  return atual - ref.v;
}

/** Frota de empilhadeiras do CD: quantas trabalhando (andando ou com carga) e a lista. */
export function frotaEmpilhadeiras(assets, cdId) {
  const lista = assets
    .filter((a) => a.espaco === cdId)
    .map((a) => {
      const carga = a.atributos?.carga ?? null;
      const trabalhando = a.status !== 'offline' && (a.velocidade >= 2 || Boolean(carga));
      const bateria = Number.isFinite(a.atributos?.bateria) ? a.atributos.bateria : null;
      let situacao = 'Parada';
      if (a.status === 'offline') situacao = 'Sem sinal';
      else if (carga) situacao = `Levando ${carga}`;
      else if (a.velocidade >= 2) situacao = 'Indo buscar palete';
      else if (bateria !== null && bateria < 25) situacao = 'Bateria baixa';
      return { id: a.id, nome: a.nome, trabalhando, bateria, situacao };
    })
    .sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR', { numeric: true }));
  return { total: lista.length, trabalhando: lista.filter((e) => e.trabalhando).length, lista };
}

/**
 * Doca de cada veículo no pátio, estável: quem já estava encostado continua na mesma porta;
 * quem chega pega a primeira porta livre (na ordem das portas); sem porta livre, fica na fila (null).
 * @param anterior Map<veiculo, porta> da rodada anterior
 * @param ids      veículos no pátio agora (na ordem de chegada que se quer respeitar)
 * @param portas   nomes das portas, na ordem
 * @returns Map<veiculo, porta | null>
 */
export function atribuirDocas(anterior, ids, portas) {
  const atual = new Map();
  const ocupadas = new Set();
  for (const id of ids) {
    const p = anterior.get(id);
    if (p && portas.includes(p) && !ocupadas.has(p)) {
      atual.set(id, p);
      ocupadas.add(p);
    }
  }
  for (const id of ids) {
    if (atual.has(id)) continue;
    const livre = portas.find((p) => !ocupadas.has(p)) ?? null;
    atual.set(id, livre);
    if (livre) ocupadas.add(livre);
  }
  return atual;
}
