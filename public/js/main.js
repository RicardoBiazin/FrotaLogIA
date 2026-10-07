// Orquestra acesso (chave do cliente), dados (WebSocket), animação (requestAnimationFrame) e interface.
import { connect } from './ws.js';
import { AnimatedAsset } from './interp.js';
import { GeoView } from './geoView.js';
import { IndoorView } from './indoorView.js';
import { TIPOS, STATUS, STATUS_IDS, tipoOf, glyphSvg } from './icons.js';
import {
  VIAGEM_LABEL, applyViagem, resumoCentro, matchesQuery, atrasoMs, formatDuracao,
  formatPeso, formatVolume, formatValor, formatPrevisao, formatHora,
} from './logistica.js';
import {
  ocupacaoPorPosicao, itensDaPosicao, resumoEstoque, matchesItem, situacaoValidade, diasAte,
  posicaoKey, parseEndereco,
} from './estoque.js';
import { GALPAO_PADRAO, validarGalpao, gerarPlanta, capacidadeGalpao, resumoGalpao } from './planta.js';
import {
  etapasViagem, progressoViagem, inventarioTop, registrar, tendencia, frotaEmpilhadeiras, atribuirDocas,
} from './painel.js';
import { familiaDe } from './estoque.js';

const $ = (selector) => document.querySelector(selector);
const els = {
  conn: $('#conn'),
  total: $('#count-total'),
  bar: $('#status-bar'),
  views: [...document.querySelectorAll('.views button')],
  search: $('#search'),
  typeFilters: $('#type-filters'),
  list: $('#asset-list'),
  empty: $('#empty'),
  map: $('#map'),
  indoor: $('#indoor'),
  indoorCanvas: $('#indoor-canvas'),
  fit: $('#fit'),
  cdPicker: $('#cd-picker'),
  cdSelect: $('#cd-select'),
  detail: $('#detail'),
  cdDetail: $('#cd-detail'),
  slotDetail: $('#slot-detail'),
  follow: $('#follow'),
  followWrap: $('#follow-wrap'),
  trail: $('#trail'),
  eventosList: $('#eventos-list'),
};

const CHAVE_KEY = 'frotalogia.chave';

const state = {
  chave: '',
  cliente: null,
  assets: new Map(), // id → AnimatedAsset
  viagens: new Map(), // id → viagem ativa
  viagemPorVeiculo: new Map(), // veiculo → viagem ativa
  eventos: [], // mais recentes primeiro
  centros: [],
  estoque: new Map(), // cd → Map<endereco, item> (CDs com prateleiras)
  selectedSlot: null, // { cd, rua, posicao }
  soAtrasados: false, // filtro do contador "em atraso"
  modo3d: false, // planta do CD em 3D isométrico
  foco: false, // tela cheia (painel lateral escondido)
  aba: 'docas', // aba do painel de operação no 3D
  series: new Map(), // indicador → amostras { t, v } (tendência)
  demo: null, // { extras, maxExtras } no cliente de demonstração
  tipos: new Set(TIPOS.map((t) => t.id)),
  query: '',
  view: 'map', // 'map' | 'indoor'
  space: null, // CD com planta exibido na aba Centros
  selectedId: null,
  selectedCd: null,
  follow: false,
  showTrail: true,
  trail: [],
  fitted: false,
};

let geo = null;
let indoor = null;
let iso = null; // vista 3D (carregada só quando aberta)
const rows = new Map();
const chipCounts = new Map();

const CARDINALS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
const cardinal = (deg) => CARDINALS[Math.round(deg / 45) % 8];
const fmt = (n, digits = 0) => n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const centroById = (id) => state.centros.find((c) => c.id === id) ?? null;
const nomeCentro = (id) => centroById(id)?.nome ?? id;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3) return 'agora';
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`;
}

/** fetch com a chave do cliente. 401 derruba a sessão. */
async function api(path) {
  const res = await fetch(path, { headers: state.chave ? { 'x-api-key': state.chave } : {} });
  if (res.status === 401) {
    logout();
    throw new Error('sessão expirada');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
}

function logout() {
  try {
    sessionStorage.removeItem(CHAVE_KEY);
  } catch {
    /* armazenamento indisponível */
  }
  location.reload();
}

// ---------- Dados ----------

function upsert(data, now) {
  const current = state.assets.get(data.id);
  if (current) current.update(data, now);
  else state.assets.set(data.id, new AnimatedAsset(data, now));
}

function trailPoint(d) {
  return d.espaco ? [d.x, d.y, d.ts] : [d.lon, d.lat, d.ts];
}

function applyTrail() {
  const points = state.showTrail ? state.trail : [];
  geo?.setTrail(points);
  indoor?.setTrail(points);
}

function onSnapshot({ cliente, assets, viagens, eventos }) {
  // Snapshot novo = (re)conexão, talvez com o servidor reiniciado: a demonstração pode ter mudado.
  if (state.cliente) atualizarSessaoDemo();
  state.cliente = cliente;
  $('#cliente-nome').textContent = cliente.nome;
  const now = performance.now();
  const ids = new Set(assets.map((a) => a.id));
  for (const id of state.assets.keys()) if (!ids.has(id)) state.assets.delete(id);
  for (const data of assets) upsert(data, now);
  state.viagens.clear();
  state.viagemPorVeiculo.clear();
  for (const v of viagens) applyViagem(state.viagens, state.viagemPorVeiculo, v);
  state.eventos = eventos;
  renderEventos();
  maybeFit();
  refreshUi();
}

/** Enquadra a frota uma única vez, quando houver dados E o mapa estiver pronto. */
function maybeFit() {
  if (state.fitted || !geo?.ready) return;
  const items = visibleItems(performance.now(), 'map');
  if (items.length === 0) return;
  state.fitted = true;
  geo.fit([...items, ...state.centros.map((c) => ({ x: c.lon, y: c.lat }))]);
}

function onBatch({ assets, viagens, estoque }) {
  const now = performance.now();
  for (const v of viagens ?? []) applyViagem(state.viagens, state.viagemPorVeiculo, v);
  for (const item of estoque ?? []) {
    const itens = state.estoque.get(item.cd);
    if (!itens) continue; // CD ainda não carregado: virá completo no carregamento
    if (item.removido) itens.delete(item.endereco);
    else itens.set(item.endereco, item);
  }
  for (const data of assets ?? []) {
    const prevEspaco = state.assets.get(data.id)?.data.espaco ?? null;
    upsert(data, now);
    if (data.id === state.selectedId) {
      // Mudou entre mapa e planta: o rastro antigo está em outro sistema de coordenadas.
      if ((data.espaco ?? null) !== prevEspaco) state.trail = [];
      const last = state.trail[state.trail.length - 1];
      const point = trailPoint(data);
      if (!last || last[0] !== point[0] || last[1] !== point[1]) {
        state.trail.push(point);
        if (state.trail.length > 500) state.trail.shift();
        applyTrail();
      }
    }
  }
}

function onRemove(id) {
  state.assets.delete(id);
  if (state.selectedId === id) select(null);
  refreshUi();
}

function onEvento(evento) {
  state.eventos.unshift(evento);
  state.eventos.length = Math.min(state.eventos.length, 30);
  renderEventos();
}

// ---------- Filtros e visibilidade ----------

/** Atraso da viagem ativa do veículo, em ms (0 = no prazo ou sem viagem). */
const atrasoDe = (id, now = Date.now()) => atrasoMs(state.viagemPorVeiculo.get(id), now);

function matches(d) {
  if (d.id === state.selectedId) return true;
  if (!state.tipos.has(d.tipo)) return false;
  if (state.soAtrasados && !atrasoDe(d.id)) return false;
  return matchesQuery(d, state.viagemPorVeiculo.get(d.id), state.query);
}

/** Itens amostrados no instante `now` para a visualização pedida. */
function visibleItems(now, view = state.view) {
  const items = [];
  const wallNow = Date.now(); // `now` é o relógio da animação; o atraso usa o de parede
  for (const asset of state.assets.values()) {
    const d = asset.data;
    if (view === 'map' ? d.espaco : d.espaco !== state.space?.id) continue;
    if (!matches(d)) continue;
    const p = asset.sample(now);
    const atraso = d.espaco ? 0 : atrasoDe(d.id, wallNow);
    items.push({
      id: d.id, nome: d.nome, tipo: d.tipo, status: d.status, x: p.x, y: p.y, rumo: p.rumo,
      atrasoTxt: atraso ? `+${formatDuracao(atraso)}` : '',
      carregado: Boolean(d.atributos?.carga),
    });
  }
  return items;
}

// Doca de cada veículo no pátio, por CD. Estável: quem encostou não troca de porta quando outro chega.
const docasPorCd = new Map(); // cd → Map<veiculo, porta | null>

function docasDoCd(cd) {
  const portas = (cd?.planta?.portas ?? []).map((p) => p.nome);
  const ids = [];
  for (const { data: d } of state.assets.values()) if (!d.espaco && d.cd === cd?.id) ids.push(d.id);
  const m = atribuirDocas(docasPorCd.get(cd?.id) ?? new Map(), ids, portas);
  if (cd) docasPorCd.set(cd.id, m);
  return m;
}

/** Veículos de rua parados no pátio do CD exibido na planta, com a doca de cada um. */
function dockedItems() {
  const items = [];
  if (!state.space) return items;
  const docas = docasDoCd(centroById(state.space.id));
  for (const { data: d } of state.assets.values()) {
    if (d.espaco || d.cd !== state.space.id || !matches(d)) continue;
    items.push({
      id: d.id, nome: d.nome, tipo: d.tipo, status: d.status,
      viagemStatus: state.viagemPorVeiculo.get(d.id)?.status, porta: docas.get(d.id) ?? null,
    });
  }
  return items;
}

// ---------- Animação ----------

function frame(now) {
  requestAnimationFrame(frame);
  const items = visibleItems(now);
  if (state.view === 'map') {
    const drawn = geo?.render(items, now);
    if (drawn && state.follow && state.selectedId) {
      const target = items.find((i) => i.id === state.selectedId);
      if (target) geo.follow(target.x, target.y);
    }
  } else {
    if (state.modo3d && iso?.ready) iso.render(items, dockedItems());
    else indoor?.render(items, dockedItems());
  }
}

// ---------- Interface ----------

function buildTypeFilters() {
  for (const tipo of TIPOS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.setAttribute('aria-pressed', 'true');
    button.innerHTML = `${glyphSvg(tipo.id, 16)}<span></span><b>0</b>`;
    button.querySelector('span').textContent = tipo.plural;
    button.addEventListener('click', () => {
      if (state.tipos.has(tipo.id)) state.tipos.delete(tipo.id);
      else state.tipos.add(tipo.id);
      button.setAttribute('aria-pressed', String(state.tipos.has(tipo.id)));
      refreshUi();
    });
    chipCounts.set(tipo.id, button.querySelector('b'));
    els.typeFilters.append(button);
  }
}

function buildCdPicker() {
  els.cdSelect.replaceChildren(
    ...state.centros
      .filter((c) => c.planta)
      .map((c) => {
        const option = document.createElement('option');
        option.value = c.id;
        option.textContent = c.nome;
        return option;
      }),
  );
}

function updateSummary() {
  const counts = { movimento: 0, parado: 0, offline: 0 };
  const byTipo = {};
  for (const asset of state.assets.values()) {
    counts[asset.data.status] = (counts[asset.data.status] ?? 0) + 1;
    byTipo[asset.data.tipo] = (byTipo[asset.data.tipo] ?? 0) + 1;
  }
  els.total.textContent = fmt(state.assets.size);
  for (const status of STATUS_IDS) {
    $(`#count-${status}`).textContent = fmt(counts[status]);
    els.bar.querySelector(`[data-status="${status}"]`).style.flexGrow = counts[status];
  }
  for (const [id, el] of chipCounts) el.textContent = fmt(byTipo[id] ?? 0);

  let pesoKg = 0;
  for (const v of state.viagens.values()) if (v.status === 'em_transito') pesoKg += v.carga?.pesoKg ?? 0;
  $('#kpi-viagens').textContent = fmt(state.viagens.size);
  $('#kpi-peso').textContent = formatPeso(pesoKg);
  $('#kpi-cds').textContent = fmt(state.centros.length);

  const now = Date.now();
  let atrasados = 0;
  for (const v of state.viagens.values()) if (v.veiculo && state.assets.has(v.veiculo) && atrasoMs(v, now)) atrasados++;
  const botao = $('#kpi-atrasados');
  botao.hidden = atrasados === 0 && !state.soAtrasados;
  botao.dataset.zero = String(atrasados === 0);
  $('#kpi-atrasados-n').textContent = fmt(atrasados);
  $('#kpi-atrasados-txt').textContent = state.soAtrasados
    ? `${atrasados === 1 ? 'veículo' : 'veículos'} em atraso · mostrando só eles`
    : `${atrasados === 1 ? 'veículo' : 'veículos'} em atraso · mostrar só eles`;
}

/** Linha curta do transporte na lista: onde está ou para onde vai. */
function tripLine(d) {
  const v = state.viagemPorVeiculo.get(d.id);
  if (d.espaco) return nomeCentro(d.espaco);
  if (d.cd) return `No ${nomeCentro(d.cd)}${v ? ` · ${VIAGEM_LABEL[v.status]}` : ''}`;
  if (v) return `→ ${v.destino.nome}`;
  return '';
}

function createRow(d) {
  const li = document.createElement('li');
  li.innerHTML = `<button type="button" class="row" data-id="">
    <span class="glyph"></span>
    <span><span class="name"></span><span class="code"></span><span class="trip-line"></span><span class="late"></span></span>
    <span class="meta"><span class="speed"></span><span class="state"></span></span>
  </button>`;
  li.querySelector('.glyph').innerHTML = glyphSvg(d.tipo, 22);
  return li;
}

function fillRow(li, d, line, atraso) {
  const button = li.firstElementChild;
  button.dataset.id = d.id;
  button.setAttribute('aria-pressed', String(d.id === state.selectedId));
  li.querySelector('.name').textContent = d.nome;
  li.querySelector('.code').textContent = d.id;
  li.querySelector('.trip-line').textContent = line;
  li.querySelector('.late').textContent = atraso ? `Atrasado ${formatDuracao(atraso)}` : '';
  button.classList.toggle('is-late', Boolean(atraso));
  li.querySelector('.speed').textContent = d.status === 'offline' ? '—' : `${fmt(d.velocidade)} km/h`;
  const stateEl = li.querySelector('.state');
  stateEl.textContent = STATUS[d.status].label;
  stateEl.dataset.status = d.status;
}

function renderList() {
  const items = [...state.assets.values()]
    .map((a) => a.data)
    .filter(matches)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));

  const seen = new Set();
  let previous = null;
  for (const d of items) {
    seen.add(d.id);
    let li = rows.get(d.id);
    if (!li) {
      li = createRow(d);
      rows.set(d.id, li);
    }
    const line = tripLine(d);
    const atraso = d.espaco ? 0 : atrasoDe(d.id);
    const signature = `${d.nome}|${d.status}|${Math.round(d.velocidade)}|${d.id === state.selectedId}|${line}|${atraso ? formatDuracao(atraso) : ''}`;
    if (li.dataset.sig !== signature) {
      fillRow(li, d, line, atraso);
      li.dataset.sig = signature;
    }
    const expected = previous ? previous.nextSibling : els.list.firstChild;
    if (li !== expected) els.list.insertBefore(li, expected);
    previous = li;
  }
  for (const [id, li] of rows) {
    if (!seen.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }

  els.empty.hidden = items.length > 0;
  if (items.length === 0) {
    els.empty.textContent =
      state.assets.size === 0
        ? 'Aguardando as primeiras posições…'
        : $('#estoque-busca').hidden
          ? 'Nada corresponde à busca. Limpe a busca ou ative mais tipos.'
          : 'Nenhum veículo corresponde à busca; o produto está no estoque acima.';
  }
}

function eventoTexto(e) {
  return `${e.nome} ${e.tipo === 'entrada' ? 'entrou no' : 'saiu do'} ${e.cdNome}`;
}

function renderEventos() {
  $('#eventos-count').textContent = fmt(state.eventos.length);
  $('#eventos-empty').hidden = state.eventos.length > 0;
  els.eventosList.replaceChildren(
    ...state.eventos.slice(0, 12).map((e) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'evento';
      button.dataset.id = e.veiculo;
      button.dataset.tipo = e.tipo;
      const texto = document.createElement('span');
      texto.textContent = eventoTexto(e);
      const hora = document.createElement('time');
      hora.textContent = formatHora(e.ts);
      button.append(texto, hora);
      li.append(button);
      return li;
    }),
  );
}

function setText(selector, value) {
  $(selector).textContent = value;
}

// Atributos livres do ativo (telemetria): rótulos conhecidos em português; os demais, como vieram.
const ATRIBUTO_LABEL = {
  bateria: 'Bateria',
  operador: 'Operador',
  motorista: 'Motorista',
  carga: 'Carregando',
  movimentosHoje: 'Movimentos hoje',
  placa: 'Placa',
  carregador: 'Carregador',
};

function renderAtributos(atributos) {
  const dl = $('#detail-attrs');
  const entradas = Object.entries(atributos ?? {}).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  dl.hidden = entradas.length === 0;
  const signature = JSON.stringify(entradas);
  if (dl.dataset.sig === signature) return;
  dl.dataset.sig = signature;
  dl.replaceChildren(
    ...entradas.slice(0, 12).map(([k, v]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = ATRIBUTO_LABEL[k] ?? k;
      const dd = document.createElement('dd');
      if (k === 'bateria' && typeof v === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(v)));
        dd.className = 'bateria';
        dd.dataset.nivel = pct < 25 ? 'baixa' : pct < 50 ? 'media' : 'ok';
        const barra = document.createElement('span');
        barra.className = 'barra';
        const fill = document.createElement('i');
        fill.style.width = `${pct}%`;
        barra.append(fill);
        dd.append(`${pct}%`, barra);
      } else if (k === 'carga') {
        dd.textContent = v ? String(v) : 'Vazia';
      } else {
        dd.textContent = v === null ? '—' : String(v);
      }
      div.append(dt, dd);
      if (k === 'carga' || k === 'operador') div.className = 'wide';
      return div;
    }),
  );
}

/** Guarda a amostra do indicador (no máximo uma a cada 30 s) e devolve a variação em 15 min. */
function amostra(chave, v) {
  const serie = state.series.get(chave) ?? [];
  const now = Date.now();
  if (serie.length && now - serie.at(-1).t < 30_000) serie.at(-1).v = v;
  else registrar(serie, now, v);
  state.series.set(chave, serie);
  return tendencia(serie, now);
}

function mostrarTendencia(sel, delta, sufixo = '') {
  const el = $(sel);
  el.hidden = !delta;
  if (!delta) return;
  el.textContent = `${delta > 0 ? '↑' : '↓'} ${fmt(Math.abs(delta))}${sufixo}`;
  el.dataset.dir = delta > 0 ? 'sobe' : 'desce';
  el.title = 'Variação nos últimos 15 minutos';
}

const STATUS_CHIP = {
  carregando: 'Carregando', descarregando: 'Descarregando', em_transito: 'Em trânsito',
  planejada: 'Aguardando', entregue: 'Entregue', cancelada: 'Cancelada',
};

/** Painéis sobre a vista 3D: indicadores, rastreamento e abas de operação. */
function updateIsoPaineis() {
  if (!state.modo3d || !state.space) return;
  const cd = centroById(state.space.id);
  if (!cd) return;
  const now = Date.now();
  const itens = [...(state.estoque.get(cd.id)?.values() ?? [])];
  const est = resumoEstoque(itens, cd.planta, now);
  const assets = [...state.assets.values()].map((a) => a.data);
  const r = resumoCentro(cd.id, assets, [...state.viagens.values()]);

  setText('#iso-kpi-estoque', fmt(est.ocupadas));
  setText('#iso-kpi-estoque-sub', `${est.percentual}% das posições · ${fmt(est.skus)} SKUs`);
  mostrarTendencia('#iso-kpi-estoque-tend', amostra(`${cd.id}:estoque`, est.ocupadas));

  setText('#iso-kpi-patio', fmt(r.patio.length));
  setText('#iso-kpi-patio-sub', r.chegando.length ? `+${r.chegando.length} a caminho` : 'nenhum a caminho');
  mostrarTendencia('#iso-kpi-patio-tend', amostra(`${cd.id}:patio`, r.patio.length));

  // viagens ativas que saem deste CD ou chegam a ele
  const doCd = [...state.viagens.values()].filter((v) => v.origem?.cd === cd.id || v.destino?.cd === cd.id);
  const atrasadas = doCd.filter((v) => atrasoMs(v, now)).length;
  const pct = doCd.length ? Math.round(((doCd.length - atrasadas) / doCd.length) * 100) : null;
  setText('#iso-kpi-prazo', pct === null ? '—' : `${pct}%`);
  setText('#iso-kpi-prazo-sub', doCd.length ? `${atrasadas} de ${doCd.length} em atraso` : 'sem viagens ativas');
  $('#iso-kpi-prazo').dataset.alerta = String(atrasadas > 0);
  mostrarTendencia('#iso-kpi-prazo-tend', pct === null ? null : amostra(`${cd.id}:prazo`, pct), ' p.p.');

  renderRastreio(r);
  renderAbas(cd, r, assets);
}

/** Viagem mostrada no rastreamento: a do veículo selecionado; senão a de quem está no pátio; senão a próxima chegada. */
function viagemDoRastreio(r) {
  const sel = state.selectedId && state.viagemPorVeiculo.get(state.selectedId);
  if (sel) return sel;
  for (const a of r.patio) {
    const v = state.viagemPorVeiculo.get(a.id);
    if (v) return v;
  }
  return r.chegando[0] ?? null;
}

function textoProgresso(v, now) {
  const prog = progressoViagem(v, now);
  if (v.status === 'em_transito') {
    if (prog?.restanteMs === null || prog?.restanteMs === undefined) return 'Em trânsito';
    return prog.restanteMs > 30_000 ? `${formatDuracao(prog.restanteMs)} para chegar` : 'Chegando';
  }
  if (v.status === 'carregando') return `Carregando em ${v.origem.nome}`;
  if (v.status === 'descarregando') return `Descarregando em ${v.destino.nome}`;
  if (v.status === 'planejada') return 'Aguardando saída';
  return VIAGEM_LABEL[v.status];
}

function renderRastreio(r) {
  const box = $('#iso-rastreio');
  const v = viagemDoRastreio(r);
  box.hidden = !v;
  if (!v) return;
  const now = Date.now();
  const veiculo = state.assets.get(v.veiculo)?.data;
  setText('#rastreio-veiculo', `${veiculo?.nome ?? v.veiculo ?? ''} · ${v.remetente.nome}`);
  const etapas = etapasViagem(v);
  const sig = JSON.stringify([v.id, etapas.map((e) => [e.estado, e.em, e.previsto])]);
  const ol = $('#rastreio-etapas');
  if (ol.dataset.sig !== sig) {
    ol.dataset.sig = sig;
    ol.replaceChildren(
      ...etapas.map((e) => {
        const li = document.createElement('li');
        li.dataset.estado = e.estado;
        const no = document.createElement('span');
        no.className = 'no';
        no.textContent = e.estado === 'feito' ? '✓' : '';
        const b = document.createElement('b');
        b.textContent = e.label;
        const small = document.createElement('small');
        small.textContent = e.em ? formatHora(e.em) : e.previsto ? `previsto ${formatHora(e.previsto)}` : '';
        li.append(no, b, small);
        return li;
      }),
    );
  }
  setText('#rastreio-id', v.documento ?? v.id);
  setText('#rastreio-destino', `Para: ${v.destino.nome}`);
  const chip = $('#rastreio-status');
  chip.textContent = STATUS_CHIP[v.status] ?? VIAGEM_LABEL[v.status];
  chip.dataset.status = v.status;
  const atraso = atrasoMs(v, now);
  const doca = veiculo?.cd && docasPorCd.get(veiculo.cd)?.get(veiculo.id);
  const partes = [];
  if (doca) partes.push(`Doca ${doca}`);
  partes.push(textoProgresso(v, now));
  if (atraso) partes.push(`atraso de ${formatDuracao(atraso)}`);
  setText('#rastreio-linha', partes.join(' · '));
  $('#rastreio-card').dataset.id = v.veiculo ?? '';
  $('#rastreio-card').dataset.atraso = String(Boolean(atraso));
}

function linhaAba({ id, badge, titulo, sub, chip, chipStatus, bateria }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'aba-row';
  if (id) b.dataset.id = id;
  else b.dataset.livre = 'true';
  const tag = document.createElement('b');
  tag.className = 'tag';
  tag.textContent = badge ?? '';
  const txt = document.createElement('span');
  txt.className = 'aba-txt';
  const t1 = document.createElement('span');
  t1.textContent = titulo;
  const t2 = document.createElement('small');
  t2.textContent = sub ?? '';
  txt.append(t1, t2);
  b.append(tag, txt);
  if (chip) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.dataset.status = chipStatus ?? '';
    c.textContent = chip;
    b.append(c);
  }
  if (bateria !== undefined && bateria !== null) {
    const bar = document.createElement('span');
    bar.className = 'mini-bateria';
    bar.dataset.nivel = bateria < 25 ? 'baixa' : bateria < 50 ? 'media' : 'ok';
    bar.title = `Bateria ${bateria}%`;
    const fill = document.createElement('i');
    fill.style.width = `${bateria}%`;
    bar.append(fill);
    b.append(bar);
  }
  li.append(b);
  return li;
}

function renderAbas(cd, r, assets) {
  const portas = cd.planta?.portas ?? [];
  const docas = docasDoCd(cd);
  const porPorta = new Map([...docas].filter(([, p]) => p).map(([id, p]) => [p, id]));
  const frota = frotaEmpilhadeiras(assets, cd.id);
  const caminhoes = [
    ...r.patio.map((a) => ({ a, v: state.viagemPorVeiculo.get(a.id), noPatio: true })),
    ...r.chegando.map((v) => ({ a: state.assets.get(v.veiculo)?.data, v, noPatio: false })),
  ].filter((c) => c.a);
  setText('#aba-docas-n', `${porPorta.size}/${portas.length}`);
  setText('#aba-emp-n', `${frota.trabalhando}/${frota.total}`);
  setText('#aba-cam-n', fmt(caminhoes.length));
  setText('#aba-cd', cd.nome);
  for (const b of document.querySelectorAll('.abas [data-aba]')) b.setAttribute('aria-selected', String(b.dataset.aba === state.aba));

  const now = Date.now();
  let linhas;
  if (state.aba === 'empilhadeiras') {
    linhas = frota.lista.map((e) => ({ id: e.id, badge: e.nome.replace(/\D+/g, '') || '•', titulo: e.nome, sub: e.situacao, bateria: e.bateria }));
    if (!linhas.length) linhas = [{ titulo: 'Nenhuma empilhadeira neste CD.' }];
  } else if (state.aba === 'caminhoes') {
    linhas = caminhoes.map(({ a, v, noPatio }) => {
      const atraso = v && atrasoMs(v, now);
      return {
        id: a.id,
        badge: noPatio ? docas.get(a.id) ?? 'fila' : '→',
        titulo: a.nome,
        sub: noPatio
          ? (v ? `${v.carga.descricao}` : 'no pátio')
          : `chega ${formatPrevisao(v.estimativa ?? v.previsao, now)}${atraso ? ` · atraso ${formatDuracao(atraso)}` : ''}`,
        chip: noPatio ? STATUS_CHIP[v?.status] ?? 'No pátio' : atraso ? 'Atrasado' : 'A caminho',
        chipStatus: noPatio ? v?.status ?? 'patio' : atraso ? 'atraso' : 'a_caminho',
      };
    });
    if (!linhas.length) linhas = [{ titulo: 'Nenhum veículo no pátio ou a caminho.' }];
  } else {
    linhas = portas.map((p) => {
      const id = porPorta.get(p.nome);
      const a = id && state.assets.get(id)?.data;
      const v = id && state.viagemPorVeiculo.get(id);
      return a
        ? { id, badge: p.nome, titulo: a.nome, sub: v ? v.carga.descricao : 'no pátio', chip: STATUS_CHIP[v?.status] ?? 'No pátio', chipStatus: v?.status ?? 'patio' }
        : { badge: p.nome, titulo: 'Livre', sub: '', chip: 'Disponível', chipStatus: 'livre' };
    });
    if (!linhas.length) linhas = [{ titulo: 'Este CD não tem docas cadastradas.' }];
  }
  const ul = $('#aba-lista');
  const sig = JSON.stringify([state.aba, linhas]);
  if (ul.dataset.sig === sig) return;
  ul.dataset.sig = sig;
  ul.replaceChildren(...linhas.map(linhaAba));
}

function updateDetail() {
  const asset = state.selectedId ? state.assets.get(state.selectedId) : null;
  if (!asset) {
    els.detail.hidden = true;
    return;
  }
  const d = asset.data;
  const tipo = tipoOf(d.tipo);
  els.detail.hidden = false;
  $('#detail-glyph').innerHTML = glyphSvg(d.tipo, 28);
  setText('#detail-name', d.nome);
  setText('#detail-id', `${tipo.label}, código ${d.id}`);
  setText('#detail-status', STATUS[d.status].label);
  setText('#detail-speed', `${fmt(d.velocidade)} km/h`);
  setText('#detail-heading', `${fmt(d.rumo)}° ${cardinal(d.rumo)}`);
  setText('#detail-age', ago(Date.now() - asset.lastSeen));
  setText(
    '#detail-pos',
    d.espaco ? `x ${fmt(d.x, 1)} m, y ${fmt(d.y, 1)} m` : `${fmt(d.lat, 5)}, ${fmt(d.lon, 5)}`,
  );
  const cd = d.espaco || d.cd;
  $('#detail-cd-wrap').hidden = !cd;
  if (cd) {
    const button = $('#detail-cd');
    button.textContent = d.espaco ? `Dentro do ${nomeCentro(cd)}` : `No pátio do ${nomeCentro(cd)}`;
    button.dataset.cd = cd;
  }
  els.followWrap.hidden = Boolean(d.espaco);
  renderAtributos(d.atributos);

  const v = state.viagemPorVeiculo.get(d.id);
  $('#trip').hidden = !v;
  $('#no-trip').hidden = Boolean(v) || Boolean(d.espaco);
  if (v) {
    setText('#trip-id', v.id);
    const badge = $('#trip-status');
    badge.textContent = VIAGEM_LABEL[v.status];
    badge.dataset.status = v.status;
    setText('#trip-origem', v.origem.nome);
    setText('#trip-destino', v.destino.nome);
    setText('#trip-carga', v.carga.descricao);
    setText('#trip-peso', formatPeso(v.carga.pesoKg));
    setText('#trip-volume', formatVolume(v.carga.volumeM3));
    setText('#trip-volumes', v.carga.volumes === null ? '—' : fmt(v.carga.volumes));
    setText('#trip-valor', formatValor(v.carga.valor));
    const agora = Date.now();
    const prog = progressoViagem(v, agora);
    $('#trip-progresso-barra').style.width = `${Math.round((prog?.pct ?? 0) * 100)}%`;
    setText('#trip-progresso-txt', textoProgresso(v, agora));
    $('#trip-progresso').dataset.atraso = String(Boolean(atrasoMs(v, agora)));
    setText('#trip-previsao', formatPrevisao(v.previsao, agora));
    $('#trip-estimativa-wrap').hidden = !v.estimativa;
    if (v.estimativa) setText('#trip-estimativa', formatPrevisao(v.estimativa, agora));
    const atraso = atrasoMs(v, agora);
    $('#trip-atraso-wrap').hidden = !atraso;
    if (atraso) {
      setText('#trip-atraso', v.previsao < agora
        ? `${formatDuracao(atraso)} além do prazo`
        : `deve chegar ${formatDuracao(atraso)} depois do prazo`);
    }
    setText('#trip-remetente', v.remetente.nome + (v.remetente.documento ? ` (${v.remetente.documento})` : ''));
    setText('#trip-destinatario', v.destinatario.nome + (v.destinatario.documento ? ` (${v.destinatario.documento})` : ''));
    setText('#trip-documento', v.documento ?? '—');
  }
}

function miniItem(text, meta, id) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini-row';
  if (id) button.dataset.id = id;
  const a = document.createElement('span');
  a.textContent = text;
  const b = document.createElement('span');
  b.className = 'muted';
  b.textContent = meta;
  button.append(a, b);
  li.append(button);
  return li;
}

function fillMini(selector, items, emptyText) {
  const el = $(selector);
  const signature = JSON.stringify(items);
  if (el.dataset.sig === signature) return;
  el.dataset.sig = signature;
  el.replaceChildren(
    ...(items.length ? items.map((i) => miniItem(i.text, i.meta, i.id)) : [miniItem(emptyText, '', null)]),
  );
}

// Movimento do dia por CD (GET /api/centros/:cd/hoje), consultado no máximo a cada 15 s.
const hojeCache = new Map(); // cd → { t, dados }

function carregarHoje(cdId) {
  const c = hojeCache.get(cdId);
  if (c && Date.now() - c.t < 15_000) return;
  hojeCache.set(cdId, { t: Date.now(), dados: c?.dados ?? null });
  api(`/api/centros/${encodeURIComponent(cdId)}/hoje`)
    .then((dados) => hojeCache.set(cdId, { t: Date.now(), dados }))
    .catch(() => {});
}

function barra(sel, frac) {
  $(sel).style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
}

function fillLista(sel, linhas, criar) {
  const el = $(sel);
  const sig = JSON.stringify(linhas);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(...linhas.map(criar));
}

function updateCdDetail() {
  const cd = state.selectedCd ? centroById(state.selectedCd) : null;
  if (!cd) {
    els.cdDetail.hidden = true;
    return;
  }
  els.cdDetail.hidden = false;
  const now = Date.now();
  const assets = [...state.assets.values()].map((a) => a.data);
  const r = resumoCentro(cd.id, assets, [...state.viagens.values()]);
  carregarHoje(cd.id);
  const hoje = hojeCache.get(cd.id)?.dados;
  setText('#cd-name', cd.nome);
  setText('#cd-endereco', cd.endereco ?? '');

  const portas = cd.planta?.portas?.length ?? 0;
  const docados = [...docasDoCd(cd).values()].filter(Boolean).length;
  setText('#cd-situacao', `${r.patio.length} no pátio · ${r.chegando.length} a caminho`);

  const itens = [...(state.estoque.get(cd.id)?.values() ?? [])];
  const est = cd.planta ? resumoEstoque(itens, cd.planta, now) : null;
  setText('#cd-estoque-n', est ? fmt(est.ocupadas) : '—');
  setText('#cd-estoque-cap', est ? `/ ${fmt(est.total)}` : 'sem prateleiras');
  barra('#cd-estoque-barra', est?.total ? est.ocupadas / est.total : 0);
  setText('#cd-docas-n', portas ? fmt(docados) : '—');
  setText('#cd-docas-cap', portas ? `/ ${portas} ocupadas` : 'sem docas cadastradas');
  barra('#cd-docas-barra', portas ? docados / portas : 0);
  setText('#cd-saidas', hoje ? fmt(hoje.saidas) : '—');
  setText('#cd-armazenagens', hoje ? fmt(hoje.armazenagens) : '—');

  // inventário: os produtos com mais unidades
  $('#cd-inv').hidden = !est || itens.length === 0;
  if (est && itens.length) {
    const venc = est.vencendo + est.vencidos;
    $('#cd-vencendo').hidden = venc === 0;
    setText('#cd-vencendo', `${venc} ${venc === 1 ? 'palete vencendo' : 'paletes vencendo'}`);
    fillLista('#cd-inv-list', inventarioTop(itens, 4), (p) => {
      const li = document.createElement('li');
      const cor = document.createElement('i');
      cor.style.background = familiaDe(p.sku).cor;
      const nome = document.createElement('span');
      nome.textContent = p.descricao;
      const qtd = document.createElement('b');
      qtd.textContent = `${fmt(p.quantidade)} ${p.unidade}`;
      const chip = document.createElement('span');
      chip.className = `chip ${p.situacao === 'baixo' ? 'alerta' : 'ok'}`;
      chip.textContent = p.situacao === 'baixo' ? 'Estoque baixo' : 'Em estoque';
      li.append(cor, nome, qtd, chip);
      return li;
    });
  }

  // frota de empilhadeiras
  const frota = frotaEmpilhadeiras(assets, cd.id);
  $('#cd-frota').hidden = frota.total === 0;
  if (frota.total) {
    setText('#cd-frota-n', `${frota.trabalhando}/${frota.total} trabalhando`);
    fillLista('#cd-frota-list', frota.lista.slice(0, 4), (e) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = e.id;
      const nome = document.createElement('b');
      nome.textContent = e.nome;
      const sit = document.createElement('span');
      sit.textContent = e.situacao;
      b.append(nome, sit);
      if (e.bateria !== null) {
        const bar = document.createElement('span');
        bar.className = 'mini-bateria';
        bar.dataset.nivel = e.bateria < 25 ? 'baixa' : e.bateria < 50 ? 'media' : 'ok';
        const fill = document.createElement('i');
        fill.style.width = `${e.bateria}%`;
        const pct = document.createElement('small');
        pct.textContent = `${e.bateria}%`;
        bar.append(fill);
        b.append(bar, pct);
      }
      li.append(b);
      return li;
    });
  }

  fillMini(
    '#cd-patio-list',
    r.patio.map((a) => {
      const v = state.viagemPorVeiculo.get(a.id);
      const doca = docasPorCd.get(cd.id)?.get(a.id);
      return { id: a.id, text: a.nome, meta: `${doca ? `Doca ${doca} · ` : ''}${v ? `${VIAGEM_LABEL[v.status]} · ${v.carga.descricao}` : 'sem viagem'}` };
    }),
    'Nenhum veículo no pátio.',
  );
  fillMini(
    '#cd-chegando-list',
    r.chegando.map((v) => ({
      id: v.veiculo,
      text: state.assets.get(v.veiculo)?.data.nome ?? v.veiculo ?? v.id,
      meta: `${atrasoMs(v, now) ? `atrasado ${formatDuracao(atrasoMs(v, now))} · ` : ''}${formatPrevisao(v.estimativa ?? v.previsao, now)} · ${formatPeso(v.carga.pesoKg)}`,
    })),
    'Nenhuma chegada prevista.',
  );
  fillMini(
    '#cd-eventos-list',
    state.eventos
      .filter((e) => e.cd === cd.id)
      .slice(0, 5)
      .map((e) => ({ id: e.veiculo, text: `${e.nome} ${e.tipo === 'entrada' ? 'entrou' : 'saiu'}`, meta: formatHora(e.ts) })),
    'Sem movimentação recente.',
  );
  $('#cd-planta').hidden = !cd.planta || (state.view === 'indoor' && state.space?.id === cd.id);
  $('#cd-editar').hidden = !cd.cadastrado;
  $('#cd-excluir').hidden = !cd.cadastrado;
  $('#cd-mapa').hidden = state.view === 'map';
}

/** Resumo de cada CD no rótulo do mapa ("2 no pátio · 1 a caminho"). */
function updateCdLabels() {
  if (!geo) return;
  const assets = [...state.assets.values()].map((a) => a.data);
  const viagens = [...state.viagens.values()];
  const labels = new Map();
  for (const cd of state.centros) {
    const r = resumoCentro(cd.id, assets, viagens);
    const parts = [`${r.patio.length} no pátio`];
    if (r.chegando.length) parts.push(`${r.chegando.length} a caminho`);
    labels.set(cd.id, parts.join(' · '));
  }
  geo.setCentroLabels(labels);
}

/** Na planta, afasta o desenho do card que estiver aberto (ele flutua sobre o palco). */
function syncIndoorInsets() {
  if (!indoor) return;
  const card = [els.detail, els.cdDetail, els.slotDetail].find((c) => !c.hidden);
  $('#iso').dataset.card = card ? 'on' : 'off';
  if (state.view !== 'indoor' || !card) {
    indoor.setInsets(0, 0);
    return;
  }
  const stage = els.indoor.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  if (rect.width < stage.width * 0.5) {
    // Tela larga: o card fica à direita; a planta usa o espaço à esquerda dele.
    indoor.setInsets(0, 0, stage.right - rect.left + 8);
  } else if (rect.top + rect.height / 2 < stage.top + stage.height / 2) {
    indoor.setInsets(rect.bottom - stage.top + 8, 0);
  } else {
    indoor.setInsets(0, stage.bottom - rect.top + 8);
  }
}

function refreshUi() {
  updateSummary();
  updateEstoqueView(); // antes da lista: a mensagem de "nada encontrado" depende dela
  renderList();
  updateDetail();
  updateCdDetail();
  updateSlotDetail();
  updateCdLabels();
  updateIsoPaineis();
  syncIndoorInsets();
}

function setFollow(on) {
  state.follow = on;
  els.follow.checked = on;
}

function showSpace(cdId) {
  const cd = centroById(cdId);
  if (!cd?.planta) return;
  state.space = cd.planta;
  els.cdSelect.value = cd.id;
  indoor.setSpace(state.space);
  iso?.setSpace(state.space);
  if (state.modo3d && state.selectedCd && state.selectedCd !== cd.id) state.selectedCd = cd.id;
  updateEstoqueView();
}

function setView(view) {
  state.view = view;
  for (const button of els.views) button.setAttribute('aria-selected', String(button.dataset.view === view));
  els.map.hidden = view !== 'map';
  els.indoor.hidden = view !== 'indoor';
  $('#map-tools').hidden = view !== 'map';
  els.cdPicker.hidden = view !== 'indoor';
  if (view === 'map') geo?.resize();
  else {
    indoor?.resize();
    iso?.resize();
  }
  updateCdDetail();
  syncIndoorInsets();
}

async function select(id) {
  state.selectedId = id;
  state.trail = [];
  setFollow(false);
  geo?.setSelected(id);
  indoor?.setSelected(id);
  iso?.setSelected(id);
  applyTrail();

  const asset = id ? state.assets.get(id) : null;
  if (!asset) {
    state.selectedId = null;
    refreshUi();
    return;
  }
  state.selectedCd = null;
  state.selectedSlot = null;
  geo?.setSelectedCd(null);

  const d = asset.data;
  if (d.espaco) {
    showSpace(d.espaco);
    setView('indoor');
  } else if (state.view === 'indoor' && d.cd === state.space?.id) {
    // Veículo na doca do CD que está aberto: continua na planta.
  } else {
    setView('map');
    const p = asset.sample(performance.now());
    geo?.flyTo(p.x, p.y);
  }
  refreshUi();

  try {
    const trail = await api(`/api/assets/${encodeURIComponent(id)}/trail`);
    if (state.selectedId === id) {
      state.trail = trail.points;
      applyTrail();
    }
  } catch {
    /* rastro é opcional */
  }
}

function selectCd(id, { openPlanta = false } = {}) {
  const cd = centroById(id);
  select(null);
  state.selectedSlot = null;
  state.selectedCd = cd ? cd.id : null;
  geo?.setSelectedCd(state.selectedCd);
  if (cd) {
    if (openPlanta && cd.planta) {
      showSpace(cd.id);
      setView('indoor');
    } else if (state.view === 'map') {
      geo?.flyTo(cd.lon, cd.lat, 14.5);
    }
  }
  refreshUi();
}

// ---------- Estoque nas prateleiras ----------

async function loadEstoque(cdId) {
  try {
    const itens = await api(`/api/centros/${encodeURIComponent(cdId)}/estoque`);
    state.estoque.set(cdId, new Map(itens.map((i) => [i.endereco, i])));
  } catch (err) {
    console.warn(`Estoque do ${nomeCentro(cdId)} indisponível:`, err.message);
  }
}

/** Itens do estoque que batem com a busca, em todos os CDs carregados. */
function buscaEstoque() {
  const q = state.query.trim();
  if (q.length < 2) return [];
  const out = [];
  for (const itens of state.estoque.values()) {
    for (const item of itens.values()) if (matchesItem(item, q)) out.push(item);
  }
  // O CD aberto na planta vem primeiro; depois por CD e endereço.
  const aberto = state.space?.id;
  return out.sort(
    (a, b) => (b.cd === aberto) - (a.cd === aberto) || a.cd.localeCompare(b.cd) || a.endereco.localeCompare(b.endereco),
  );
}

/** Planta (ocupação, destaque da busca, posição selecionada) e lista de resultados. */
function updateEstoqueView() {
  const encontrados = buscaEstoque();
  if (indoor && state.space) {
    const itens = [...(state.estoque.get(state.space.id)?.values() ?? [])];
    const destaque = new Set();
    for (const item of encontrados) {
      const e = item.cd === state.space.id && parseEndereco(item.endereco);
      if (e) destaque.add(posicaoKey(e.rua, e.posicao));
    }
    const sel = state.selectedSlot?.cd === state.space.id ? state.selectedSlot : null;
    indoor.setEstoque(ocupacaoPorPosicao(itens), destaque, sel);
    if (iso) {
      const enderecos = state.query.trim().length >= 2
        ? new Set(encontrados.filter((i) => i.cd === state.space.id).map((i) => i.endereco))
        : null;
      iso.setEstoque(state.estoque.get(state.space.id) ?? new Map(), enderecos, sel);
    }
  }

  const box = $('#estoque-busca');
  box.hidden = encontrados.length === 0;
  if (box.hidden) return;
  const porCd = new Set(encontrados.map((i) => i.cd)).size;
  const n = encontrados.length;
  setText(
    '#estoque-busca-titulo',
    `No estoque: ${fmt(n)} ${n === 1 ? 'posição' : 'posições'}${porCd > 1 ? ` em ${porCd} CDs` : ''}`,
  );
  const list = $('#estoque-busca-list');
  const visiveis = encontrados.slice(0, 50);
  const signature = visiveis.map((i) => `${i.cd}|${i.endereco}|${i.quantidade}`).join(',');
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  list.replaceChildren(
    ...visiveis.map((item) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stock-row';
      button.dataset.cd = item.cd;
      button.dataset.endereco = item.endereco;
      const end = document.createElement('b');
      end.textContent = item.endereco;
      const desc = document.createElement('span');
      desc.textContent = item.descricao;
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = `${nomeCentro(item.cd)} · ${fmt(item.quantidade)} ${item.unidade}`;
      button.append(end, desc, meta);
      li.append(button);
      return li;
    }),
  );
}

const formatData = (ts) => new Date(ts).toLocaleDateString('pt-BR');

/** Um nível da posição: o palete que está nele, ou "Vazio". */
function nivelItem(nivel, item, now) {
  const li = document.createElement('li');
  li.className = 'nivel';
  const label = document.createElement('span');
  label.className = 'nivel-label';
  label.textContent = `Nível ${nivel}`;
  const body = document.createElement('div');
  li.append(label, body);
  if (!item) {
    li.classList.add('vazio');
    body.textContent = 'Vazio';
    return li;
  }
  const add = (cls, text) => {
    const el = document.createElement('p');
    el.className = cls;
    el.textContent = text;
    body.append(el);
    return el;
  };
  add('nivel-desc', item.descricao);
  add('muted', [item.sku, item.depositante].filter(Boolean).join(' · '));
  add('nivel-qtd', [`${fmt(item.quantidade)} ${item.unidade}`, item.pesoKg ? formatPeso(item.pesoKg) : null].filter(Boolean).join(' · '));
  const origem = [item.lote ? `Lote ${item.lote}` : null, item.entradaEm ? `entrada ${formatData(item.entradaEm)}` : null];
  add('muted', origem.filter(Boolean).join(' · '));
  const situacao = situacaoValidade(item.validade, now);
  if (situacao) {
    const dias = diasAte(item.validade, now);
    const texto = situacao === 'vencido'
      ? `Vencido em ${formatData(item.validade)}`
      : `Validade ${formatData(item.validade)}${situacao === 'vencendo' ? ` (vence em ${dias} ${dias === 1 ? 'dia' : 'dias'})` : ''}`;
    add('validade', texto).dataset.situacao = situacao;
  }
  return li;
}

function updateSlotDetail() {
  const slot = state.selectedSlot;
  const cd = slot && centroById(slot.cd);
  const rack = cd?.planta?.prateleiras.find((r) => r.id === slot.rua);
  if (!rack) {
    els.slotDetail.hidden = true;
    return;
  }
  els.slotDetail.hidden = false;
  const itens = itensDaPosicao([...(state.estoque.get(cd.id)?.values() ?? [])], slot.rua, slot.posicao);
  setText('#slot-name', `Rua ${slot.rua} · posição ${String(slot.posicao).padStart(2, '0')}`);
  setText('#slot-sub', `${cd.nome} · ${itens.length} de ${rack.niveis} níveis ocupados`);
  const list = $('#slot-niveis');
  const signature = JSON.stringify(itens.map((i) => [i.endereco, i.quantidade, i.sku, i.lote]));
  if (list.dataset.sig === signature) return;
  list.dataset.sig = signature;
  const now = Date.now();
  const porNivel = new Map(itens.map((i) => [parseEndereco(i.endereco).nivel, i]));
  const niveis = [];
  for (let n = rack.niveis; n >= 1; n--) niveis.push(nivelItem(n, porNivel.get(n), now));
  list.replaceChildren(...niveis);
}

/** Seleciona uma posição de prateleira. `open`: abre a planta do CD dela. */
function selectSlot(slot, { open = false } = {}) {
  if (slot) {
    select(null);
    state.selectedCd = null;
    geo?.setSelectedCd(null);
    if (open || state.space?.id !== slot.cd) {
      showSpace(slot.cd);
      setView('indoor');
    }
  }
  state.selectedSlot = slot;
  $('#slot-niveis').dataset.sig = '';
  refreshUi();
}

// ---------- Demonstração: incluir e remover veículos ----------

async function apiSend(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(state.chave && { 'x-api-key': state.chave }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401) {
    logout();
    throw new Error('sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro ?? `HTTP ${res.status}`);
  return data;
}

let demoPoll = null;

/** Reconsulta a sessão até o simulador ficar pronto (ele sobe depois de buscar as rotas). */
async function atualizarSessaoDemo() {
  try {
    const sessao = await api('/api/sessao');
    state.demo = sessao.demo;
  } catch {
    return;
  }
  renderDemo();
  clearTimeout(demoPoll);
  if (state.demo && !state.demo.pronto) demoPoll = setTimeout(atualizarSessaoDemo, 3000);
}

function renderDemo(mensagem) {
  const box = $('#demo');
  box.hidden = !state.demo;
  if (!state.demo) return;
  const pronto = state.demo.pronto !== false;
  for (const b of document.querySelectorAll('[data-demo-tipo]')) b.disabled = !pronto;
  if (!pronto) {
    setText('#demo-status', 'O simulador está iniciando…');
    $('#demo-remover').hidden = true;
    return;
  }
  const { extras, maxExtras } = state.demo;
  $('#demo-remover').hidden = extras === 0;
  $('#demo-remover').textContent = `Remover incluídos (${extras})`;
  setText('#demo-status', mensagem ?? (extras
    ? `${extras} de ${maxExtras} veículos incluídos.`
    : 'Inclua veículos na frota simulada.'));
}

async function demoIncluir(tipo) {
  const quantidade = Number($('#demo-qtd').value);
  const botoes = document.querySelectorAll('[data-demo-tipo]');
  botoes.forEach((b) => (b.disabled = true));
  try {
    const r = await apiSend('POST', '/api/demo/veiculos', { tipo, quantidade });
    state.demo.extras = r.extras;
    const nome = tipo === 'caminhao' ? 'caminhão' : 'carro';
    renderDemo(`${r.incluidos.length} ${r.incluidos.length === 1 ? nome : `${nome === 'caminhão' ? 'caminhões' : 'carros'}`} incluído${r.incluidos.length === 1 ? '' : 's'}: ${r.incluidos.join(', ')}.`);
  } catch (err) {
    renderDemo(`Não foi possível incluir: ${err.message}`);
  } finally {
    botoes.forEach((b) => (b.disabled = false));
  }
}

async function demoRemover() {
  try {
    const r = await apiSend('DELETE', '/api/demo/veiculos');
    state.demo.extras = 0;
    renderDemo(`${r.removidos.length} veículos removidos.`);
  } catch (err) {
    renderDemo(`Não foi possível remover: ${err.message}`);
  }
}

// ---------- Vista 3D isométrica do CD ----------

async function setModo3d(on) {
  const botao = $('#modo-3d');
  if (on && !iso) {
    botao.disabled = true;
    botao.textContent = 'Carregando 3D…';
    try {
      const { IsoView, FAMILIAS } = await import('./isoView.js');
      iso = new IsoView($('#iso'), {
        onSelect: select,
        onSelectSlot: (cell) => selectSlot(cell && state.space ? { cd: state.space.id, ...cell } : null),
      });
      $('#iso-familias').replaceChildren(
        ...FAMILIAS.map((f) => {
          const li = document.createElement('li');
          const dot = document.createElement('i');
          dot.style.background = f.cor;
          li.append(dot, f.nome);
          return li;
        }),
      );
      $('#iso').hidden = false; // o renderizador precisa do tamanho do contêiner
      await iso.init();
      iso.setSelected(state.selectedId);
      if (state.space) iso.setSpace(state.space);
    } catch (err) {
      console.error(err);
      iso = null;
      on = false;
      botao.textContent = 'Ver em 3D';
      $('#iso').hidden = true;
      alert(`Não foi possível abrir a vista 3D: ${err.message}. O navegador precisa de WebGL ativado.`);
    } finally {
      botao.disabled = false;
    }
  }
  state.modo3d = on;
  try {
    localStorage.setItem('frotalogia.3d', on ? '1' : '0');
  } catch {
    /* preferência só nesta sessão */
  }
  botao.setAttribute('aria-pressed', String(on));
  botao.textContent = on ? 'Ver planta 2D' : 'Ver em 3D';
  $('#iso-reset').hidden = !on;
  $('#iso').hidden = !on;
  els.indoorCanvas.hidden = on;
  document.querySelector('.stage').classList.toggle('modo3d', on);
  if (on) {
    // como no painel de operação: sem nada selecionado, o card do CD fica aberto
    if (!state.selectedId && !state.selectedSlot && state.space) state.selectedCd = state.space.id;
    iso.resize();
    updateEstoqueView();
    updateIsoPaineis();
    refreshUi();
  } else {
    indoor?.resize();
  }
}

// ---------- Cadastro de CD (novo / editar / excluir) ----------

const cdForm = { editando: null, preview: null, marcando: false, timer: null };
const numero = (v) => (typeof v === 'string' ? Number(v.replace(',', '.').trim()) : Number(v));

/** Recarrega a lista de CDs (cadastro feito aqui ou em outra tela, avisado pelo WebSocket). */
async function recarregarCentros() {
  state.centros = await api('/api/centros');
  buildCdPicker();
  geo?.setCentros(state.centros);
  const comPlanta = state.centros.filter((c) => c.planta);
  els.views.find((b) => b.dataset.view === 'indoor').disabled = comPlanta.length === 0;
  for (const id of [...state.estoque.keys()]) if (!comPlanta.some((c) => c.id === id)) state.estoque.delete(id);
  await Promise.all(comPlanta.map((c) => loadEstoque(c.id)));
  const atual = state.space && centroById(state.space.id);
  if (atual?.planta) showSpace(atual.id); // a planta pode ter mudado numa edição
  else if (comPlanta[0]) showSpace(comPlanta[0].id);
  else {
    state.space = null;
    if (state.view === 'indoor') setView('map');
  }
  if (state.selectedCd && !centroById(state.selectedCd)) selectCd(null);
  if (state.selectedSlot && !centroById(state.selectedSlot.cd)) state.selectedSlot = null;
  refreshUi();
}

function lerForm() {
  const f = $('#cd-form').elements;
  return {
    nome: f.nome.value,
    endereco: f.endereco.value,
    lat: f.lat.value === '' ? '' : numero(f.lat.value),
    lon: f.lon.value === '' ? '' : numero(f.lon.value),
    raioM: f.raioM.value === '' ? '' : numero(f.raioM.value),
    galpao: {
      largura: numero(f.largura.value),
      comprimento: numero(f.comprimento.value),
      docas: numero(f.docas.value),
      ruas: numero(f.ruas.value),
      niveis: numero(f.niveis.value),
      posicoes: f.posicoes.value === '' ? null : numero(f.posicoes.value),
    },
  };
}

/** Pré-visualização da planta e capacidade, a cada mudança nas medidas. */
function atualizarPreview() {
  const dados = lerForm();
  const g = dados.galpao;
  const cap = Number.isFinite(g.largura) && Number.isFinite(g.comprimento) ? capacidadeGalpao(g.largura, g.comprimento) : null;
  setText('#cd-capacidade', cap
    ? `Nestas medidas cabem até ${cap.ruas} ruas e ${cap.docas} docas; ${cap.posicoes} posições por rua no automático.`
    : '');
  const v = validarGalpao(g);
  const erro = $('#cd-form-erro');
  if (v.error) {
    setText('#cd-resumo', '');
    erro.textContent = v.error.charAt(0).toUpperCase() + v.error.slice(1) + '.';
    erro.hidden = false;
    return;
  }
  erro.hidden = true;
  const r = resumoGalpao(v.galpao);
  setText('#cd-resumo', `${fmt(r.posicoesPalete)} posições-palete (${fmt(r.porRua)} por rua) · ${fmt(r.area)} m² · ${v.galpao.docas} docas`);
  const planta = { ...gerarPlanta(v.galpao), id: 'previa', nome: dados.nome || 'Novo CD' };
  cdForm.preview ??= new IndoorView($('#cd-preview-wrap'), $('#cd-preview-canvas'), { onSelect: () => {} });
  cdForm.preview.setSpace(planta);
  requestAnimationFrame(() => cdForm.preview.render([], []));
}

function abrirFormCd(cd = null) {
  cdForm.editando = cd;
  const f = $('#cd-form').elements;
  const g = cd?.galpao ?? GALPAO_PADRAO;
  // Novo CD: começa no centro do mapa, para "Marcar no mapa" ser só um ajuste.
  const centro = geo?.map?.getCenter?.();
  f.nome.value = cd?.nome ?? '';
  f.endereco.value = cd?.endereco ?? '';
  f.lat.value = cd ? cd.lat : centro ? centro.lat.toFixed(5) : '';
  f.lon.value = cd ? cd.lon : centro ? centro.lng.toFixed(5) : '';
  f.raioM.value = cd?.raioM ?? 300;
  for (const k of ['largura', 'comprimento', 'docas', 'ruas', 'niveis']) f[k].value = g[k];
  f.posicoes.value = g.posicoes ?? '';
  setText('#cd-form-titulo', cd ? `Editar ${cd.nome}` : 'Novo centro de distribuição');
  setText('#cd-salvar', cd ? 'Salvar alterações' : 'Criar CD');
  $('#cd-form-erro').hidden = true;
  $('#cd-dialog').showModal();
  atualizarPreview();
  f.nome.focus();
}

function marcarNoMapa(lngLat) {
  if (!cdForm.marcando) return false;
  cdForm.marcando = false;
  $('#marcar-aviso').hidden = true;
  const f = $('#cd-form').elements;
  f.lat.value = lngLat.lat.toFixed(5);
  f.lon.value = lngLat.lng.toFixed(5);
  $('#cd-dialog').showModal();
  atualizarPreview();
  return true;
}

function iniciarMarcacao() {
  cdForm.marcando = true;
  $('#cd-dialog').close();
  setView('map');
  $('#marcar-aviso').hidden = false;
}

function cancelarMarcacao() {
  cdForm.marcando = false;
  $('#marcar-aviso').hidden = true;
  $('#cd-dialog').showModal();
}

async function salvarCd(e) {
  e.preventDefault();
  const erro = $('#cd-form-erro');
  const botao = $('#cd-salvar');
  botao.disabled = true;
  try {
    const dados = lerForm();
    const cd = cdForm.editando
      ? await apiSend('PUT', `/api/centros/${encodeURIComponent(cdForm.editando.id)}`, dados)
      : await apiSend('POST', '/api/centros', dados);
    $('#cd-dialog').close();
    await recarregarCentros();
    setView('map');
    selectCd(cd.id);
  } catch (err) {
    erro.textContent = `Não foi possível salvar: ${err.message}.`;
    erro.hidden = false;
  } finally {
    botao.disabled = false;
  }
}

async function excluirCd() {
  const cd = state.selectedCd && centroById(state.selectedCd);
  if (!cd?.cadastrado) return;
  if (!confirm(`Excluir o ${cd.nome}? Os paletes cadastrados nele também saem do estoque. Não dá para desfazer.`)) return;
  try {
    await apiSend('DELETE', `/api/centros/${encodeURIComponent(cd.id)}`);
    selectCd(null);
    await recarregarCentros();
  } catch (err) {
    alert(`Não foi possível excluir: ${err.message}`);
  }
}

/** Tela cheia: esconde o painel lateral; a busca vai para a barra de cima. */
function setFoco(on) {
  state.foco = on;
  document.body.classList.toggle('foco', on);
  document.querySelector('[data-ctl="tela"]')?.setAttribute('aria-pressed', String(on));
  document.querySelector('.busca-foco').hidden = !on;
  $('#search-foco').value = state.query;
  requestAnimationFrame(() => {
    geo?.resize();
    indoor?.resize();
    iso?.resize();
  });
}

function bindEvents() {
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    refreshUi();
  });
  const onRowClick = (e) => {
    const row = e.target.closest('[data-id]');
    if (row?.dataset.id) select(state.selectedId === row.dataset.id ? null : row.dataset.id);
  };
  els.list.addEventListener('click', onRowClick);
  els.eventosList.addEventListener('click', onRowClick);
  for (const list of ['#cd-patio-list', '#cd-chegando-list', '#cd-eventos-list']) {
    $(list).addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (row?.dataset.id && state.assets.has(row.dataset.id)) select(row.dataset.id);
    });
  }
  for (const button of els.views) {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (view === 'indoor' && !state.space) return;
      setView(view);
      const selected = state.selectedId && state.assets.get(state.selectedId);
      if (selected && Boolean(selected.data.espaco) !== (view === 'indoor')) select(null);
    });
  }
  els.cdSelect.addEventListener('change', () => {
    showSpace(els.cdSelect.value);
    if (state.selectedCd) selectCd(els.cdSelect.value, { openPlanta: true });
  });
  els.fit.addEventListener('click', () => geo?.fit(visibleItems(performance.now(), 'map')));
  els.follow.addEventListener('change', () => {
    state.follow = els.follow.checked;
  });
  els.trail.addEventListener('change', () => {
    state.showTrail = els.trail.checked;
    applyTrail();
  });
  $('#detail-close').addEventListener('click', () => select(null));
  $('#detail-cd').addEventListener('click', (e) => selectCd(e.currentTarget.dataset.cd));
  $('#cd-close').addEventListener('click', () => selectCd(null));
  $('#cd-planta').addEventListener('click', () => selectCd(state.selectedCd, { openPlanta: true }));
  $('#cd-mapa').addEventListener('click', () => {
    const id = state.selectedCd;
    setView('map');
    selectCd(id);
  });
  $('#sair').addEventListener('click', logout);
  for (const b of document.querySelectorAll('[data-novo-cd]')) b.addEventListener('click', () => abrirFormCd());
  $('#cd-editar').addEventListener('click', () => abrirFormCd(centroById(state.selectedCd)));
  $('#cd-excluir').addEventListener('click', excluirCd);
  $('#cd-form').addEventListener('submit', salvarCd);
  $('#cd-form').addEventListener('input', () => {
    clearTimeout(cdForm.timer);
    cdForm.timer = setTimeout(atualizarPreview, 150);
  });
  for (const b of document.querySelectorAll('[data-fechar]')) b.addEventListener('click', () => $('#cd-dialog').close());
  $('#cd-marcar').addEventListener('click', iniciarMarcacao);
  $('#marcar-cancelar').addEventListener('click', cancelarMarcacao);
  $('#modo-3d').addEventListener('click', () => setModo3d(!state.modo3d));
  $('#iso-reset').addEventListener('click', () => iso?.resetView());
  document.querySelector('.iso-controles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctl]');
    if (!b) return;
    const alterna = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      return on;
    };
    switch (b.dataset.ctl) {
      case 'mais': return iso?.zoomBy(1.25);
      case 'menos': return iso?.zoomBy(0.8);
      case 'esq': return iso?.rotateBy(Math.PI / 8);
      case 'dir': return iso?.rotateBy(-Math.PI / 8);
      case 'telhado': return iso?.setTelhado(alterna() ? 'auto' : 'nunca');
      case 'cores': {
        document.querySelector('.iso-legenda').hidden = !alterna();
        return undefined;
      }
      case 'tela': return setFoco(!state.foco);
      default: return undefined;
    }
  });
  document.querySelector('.abas').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aba]');
    if (!b) return;
    state.aba = b.dataset.aba;
    updateIsoPaineis();
  });
  $('#aba-lista').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) select(row.dataset.id);
  });
  $('#rastreio-card').addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.id;
    if (id) select(id);
  });
  $('#cd-frota-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) select(row.dataset.id);
  });
  $('#search-foco').addEventListener('input', (e) => {
    state.query = e.target.value;
    els.search.value = state.query;
    refreshUi();
  });
  for (const b of document.querySelectorAll('[data-demo-tipo]')) {
    b.addEventListener('click', () => demoIncluir(b.dataset.demoTipo));
  }
  $('#demo-remover').addEventListener('click', demoRemover);
  $('#kpi-atrasados').addEventListener('click', () => {
    state.soAtrasados = !state.soAtrasados;
    $('#kpi-atrasados').setAttribute('aria-pressed', String(state.soAtrasados));
    refreshUi();
  });
  $('#slot-close').addEventListener('click', () => selectSlot(null));
  $('#estoque-busca-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-endereco]');
    if (!row) return;
    const end = parseEndereco(row.dataset.endereco);
    selectSlot({ cd: row.dataset.cd, rua: end.rua, posicao: end.posicao }, { open: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cdForm.marcando) return cancelarMarcacao();
    if (state.selectedId) select(null);
    else if (state.selectedSlot) selectSlot(null);
    else if (state.foco) setFoco(false);
    else if (state.selectedCd) selectCd(null);
  });
}

const CONNECTION_LABEL = { connecting: 'Conectando…', open: 'Ao vivo', closed: 'Reconectando…' };
function onConnectionState(value) {
  els.conn.dataset.state = value;
  els.conn.textContent = CONNECTION_LABEL[value];
}

/** Pede a chave de acesso até o servidor aceitar. */
async function login() {
  let saved = '';
  try {
    saved = sessionStorage.getItem(CHAVE_KEY) ?? '';
  } catch {
    /* armazenamento indisponível */
  }
  const tryKey = async (chave) => {
    const res = await fetch('/api/sessao', { headers: { 'x-api-key': chave } });
    return res.ok;
  };
  if (saved && (await tryKey(saved))) return saved;

  const overlay = $('#login');
  const form = $('#login-form');
  const input = $('#login-chave');
  const erro = $('#login-erro');
  overlay.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async function onSubmit(e) {
      e.preventDefault();
      erro.hidden = true;
      const chave = input.value.trim();
      let ok = false;
      try {
        ok = await tryKey(chave);
      } catch {
        erro.textContent = 'Sem conexão com o servidor. Tente de novo.';
        erro.hidden = false;
        return;
      }
      if (!ok) {
        erro.textContent = 'Chave não reconhecida. Confira com o administrador da sua empresa.';
        erro.hidden = false;
        input.select();
        return;
      }
      try {
        sessionStorage.setItem(CHAVE_KEY, chave);
      } catch {
        /* sem armazenamento: vale só nesta aba */
      }
      form.removeEventListener('submit', onSubmit);
      overlay.hidden = true;
      resolve(chave);
    });
  });
}

async function boot() {
  const config = await fetch('/api/config').then((r) => r.json());
  if (config.versao) $('#version').textContent = `v${config.versao}`;
  if (config.auth) {
    state.chave = await login();
    $('#sair').hidden = false;
  }

  const sessao = await api('/api/sessao');
  $('#cliente-nome').textContent = sessao.cliente.nome;
  state.demo = sessao.demo;
  state.centros = await api('/api/centros');
  const comPlanta = state.centros.filter((c) => c.planta);

  buildTypeFilters();
  buildCdPicker();
  bindEvents();
  renderDemo();
  if (state.demo && !state.demo.pronto) atualizarSessaoDemo();

  indoor = new IndoorView($('#indoor'), els.indoorCanvas, {
    onSelect: select,
    onSelectSlot: (cell) => selectSlot(cell && state.space ? { cd: state.space.id, ...cell } : null),
  });
  // Estoque de todos os CDs com prateleiras: a busca de produto olha a rede inteira.
  Promise.all(comPlanta.map((c) => loadEstoque(c.id))).then(refreshUi);
  if (comPlanta.length) showSpace(comPlanta[0].id);
  else els.views.find((b) => b.dataset.view === 'indoor').disabled = true;
  // Reabre a vista 3D se foi a última escolha.
  let gosta3d = false;
  try {
    gosta3d = localStorage.getItem('frotalogia.3d') === '1';
  } catch {
    /* sem armazenamento */
  }
  if (gosta3d && comPlanta.length) setModo3d(true);

  connect({
    chave: state.chave,
    onSnapshot,
    onBatch,
    onRemove,
    onEvento,
    onState: onConnectionState,
    onUnauthorized: logout,
    onCentros: () => recarregarCentros(),
  });
  requestAnimationFrame(frame);
  setInterval(refreshUi, 500);

  // O mapa carrega em paralelo: lista, contadores e planta não dependem dele
  // (tiles lentos ou bloqueados não podem travar o resto do app).
  geo = new GeoView(els.map, config, {
    onSelect: select,
    onSelectCd: (id) => selectCd(id),
    onMapClick: (lngLat) => marcarNoMapa(lngLat),
    onUserPan: () => setFollow(false),
  });
  geo.setCentros(state.centros);
  geo
    .init()
    .then(() => {
      geo.setSelected(state.selectedId);
      geo.setSelectedCd(state.selectedCd);
      applyTrail();
      updateCdLabels();
      maybeFit();
    })
    .catch((err) => {
      console.error(err);
      els.map.textContent = `Não foi possível iniciar o mapa: ${err.message}`;
      geo = null;
    });
}

boot().catch((err) => {
  console.error(err);
  els.empty.hidden = false;
  els.empty.textContent = `Falha ao iniciar: ${err.message}`;
});
