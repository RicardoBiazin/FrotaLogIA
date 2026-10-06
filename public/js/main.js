// Orquestra acesso (chave do cliente), dados (WebSocket), animação (requestAnimationFrame) e interface.
import { connect } from './ws.js';
import { AnimatedAsset } from './interp.js';
import { GeoView } from './geoView.js';
import { IndoorView } from './indoorView.js';
import { TIPOS, STATUS, STATUS_IDS, tipoOf, glyphSvg } from './icons.js';
import {
  VIAGEM_LABEL, applyViagem, resumoCentro, matchesQuery,
  formatPeso, formatVolume, formatValor, formatPrevisao, formatHora,
} from './logistica.js';

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

function onBatch({ assets, viagens }) {
  const now = performance.now();
  for (const v of viagens ?? []) applyViagem(state.viagens, state.viagemPorVeiculo, v);
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

function matches(d) {
  if (d.id === state.selectedId) return true;
  if (!state.tipos.has(d.tipo)) return false;
  return matchesQuery(d, state.viagemPorVeiculo.get(d.id), state.query);
}

/** Itens amostrados no instante `now` para a visualização pedida. */
function visibleItems(now, view = state.view) {
  const items = [];
  for (const asset of state.assets.values()) {
    const d = asset.data;
    if (view === 'map' ? d.espaco : d.espaco !== state.space?.id) continue;
    if (!matches(d)) continue;
    const p = asset.sample(now);
    items.push({ id: d.id, nome: d.nome, tipo: d.tipo, status: d.status, x: p.x, y: p.y, rumo: p.rumo });
  }
  return items;
}

/** Veículos de rua parados no pátio do CD exibido na planta. */
function dockedItems() {
  const items = [];
  if (!state.space) return items;
  for (const { data: d } of state.assets.values()) {
    if (d.espaco || d.cd !== state.space.id || !matches(d)) continue;
    items.push({ id: d.id, nome: d.nome, tipo: d.tipo, status: d.status, viagemStatus: state.viagemPorVeiculo.get(d.id)?.status });
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
    indoor?.render(items, dockedItems());
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
    <span><span class="name"></span><span class="code"></span><span class="trip-line"></span></span>
    <span class="meta"><span class="speed"></span><span class="state"></span></span>
  </button>`;
  li.querySelector('.glyph').innerHTML = glyphSvg(d.tipo, 22);
  return li;
}

function fillRow(li, d, line) {
  const button = li.firstElementChild;
  button.dataset.id = d.id;
  button.setAttribute('aria-pressed', String(d.id === state.selectedId));
  li.querySelector('.name').textContent = d.nome;
  li.querySelector('.code').textContent = d.id;
  li.querySelector('.trip-line').textContent = line;
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
    const signature = `${d.nome}|${d.status}|${Math.round(d.velocidade)}|${d.id === state.selectedId}|${line}`;
    if (li.dataset.sig !== signature) {
      fillRow(li, d, line);
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
        : 'Nada corresponde à busca. Limpe a busca ou ative mais tipos.';
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
    setText('#trip-previsao', formatPrevisao(v.previsao, Date.now()));
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

function updateCdDetail() {
  const cd = state.selectedCd ? centroById(state.selectedCd) : null;
  if (!cd) {
    els.cdDetail.hidden = true;
    return;
  }
  els.cdDetail.hidden = false;
  const assets = [...state.assets.values()].map((a) => a.data);
  const r = resumoCentro(cd.id, assets, [...state.viagens.values()]);
  setText('#cd-name', cd.nome);
  setText('#cd-endereco', cd.endereco ?? '');
  setText('#cd-patio', fmt(r.patio.length));
  setText('#cd-chegando', fmt(r.chegando.length));
  setText('#cd-empilhadeiras', fmt(r.empilhadeiras.length));
  const now = Date.now();
  fillMini(
    '#cd-patio-list',
    r.patio.map((a) => {
      const v = state.viagemPorVeiculo.get(a.id);
      return { id: a.id, text: a.nome, meta: v ? `${VIAGEM_LABEL[v.status]} · ${v.carga.descricao}` : 'sem viagem' };
    }),
    'Nenhum veículo no pátio.',
  );
  fillMini(
    '#cd-chegando-list',
    r.chegando.map((v) => ({
      id: v.veiculo,
      text: state.assets.get(v.veiculo)?.data.nome ?? v.veiculo ?? v.id,
      meta: `${formatPrevisao(v.previsao, now)} · ${formatPeso(v.carga.pesoKg)}`,
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
  const card = [els.detail, els.cdDetail].find((c) => !c.hidden);
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
  renderList();
  updateDetail();
  updateCdDetail();
  updateCdLabels();
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
}

function setView(view) {
  state.view = view;
  for (const button of els.views) button.setAttribute('aria-selected', String(button.dataset.view === view));
  els.map.hidden = view !== 'map';
  els.indoor.hidden = view !== 'indoor';
  els.fit.hidden = view !== 'map';
  els.cdPicker.hidden = view !== 'indoor';
  if (view === 'map') geo?.resize();
  else indoor?.resize();
  updateCdDetail();
  syncIndoorInsets();
}

async function select(id) {
  state.selectedId = id;
  state.trail = [];
  setFollow(false);
  geo?.setSelected(id);
  indoor?.setSelected(id);
  applyTrail();

  const asset = id ? state.assets.get(id) : null;
  if (!asset) {
    state.selectedId = null;
    refreshUi();
    return;
  }
  state.selectedCd = null;
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.selectedId) select(null);
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

  state.centros = await api('/api/centros');
  const comPlanta = state.centros.filter((c) => c.planta);

  buildTypeFilters();
  buildCdPicker();
  bindEvents();

  indoor = new IndoorView($('#indoor'), els.indoorCanvas, { onSelect: select });
  if (comPlanta.length) showSpace(comPlanta[0].id);
  else els.views.find((b) => b.dataset.view === 'indoor').disabled = true;

  connect({
    chave: state.chave,
    onSnapshot,
    onBatch,
    onRemove,
    onEvento,
    onState: onConnectionState,
    onUnauthorized: logout,
  });
  requestAnimationFrame(frame);
  setInterval(refreshUi, 500);

  // O mapa carrega em paralelo: lista, contadores e planta não dependem dele
  // (tiles lentos ou bloqueados não podem travar o resto do app).
  geo = new GeoView(els.map, config, {
    onSelect: select,
    onSelectCd: (id) => selectCd(id),
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
