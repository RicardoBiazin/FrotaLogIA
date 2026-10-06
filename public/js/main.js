// Orquestra dados (WebSocket), animação (requestAnimationFrame) e interface.
import { connect } from './ws.js';
import { AnimatedAsset } from './interp.js';
import { GeoView } from './geoView.js';
import { IndoorView } from './indoorView.js';
import { TIPOS, STATUS, STATUS_IDS, tipoOf, glyphSvg } from './icons.js';

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
  detail: $('#detail'),
  follow: $('#follow'),
  followWrap: $('#follow-wrap'),
  trail: $('#trail'),
};

const state = {
  assets: new Map(), // id → AnimatedAsset
  tipos: new Set(TIPOS.map((t) => t.id)),
  query: '',
  view: 'map', // 'map' | 'indoor'
  spaces: [],
  space: null,
  selectedId: null,
  follow: false,
  showTrail: true,
  trail: [],
  fitted: false,
  connected: false,
};

let geo = null;
let indoor = null;
const rows = new Map();
const chipCounts = new Map();

const CARDINALS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
const cardinal = (deg) => CARDINALS[Math.round(deg / 45) % 8];
const fmt = (n, digits = 0) => n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3) return 'agora';
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)} h`;
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

function onSnapshot(list) {
  const now = performance.now();
  const ids = new Set(list.map((a) => a.id));
  for (const id of state.assets.keys()) if (!ids.has(id)) state.assets.delete(id);
  for (const data of list) upsert(data, now);
  maybeFit();
  refreshUi();
}

/** Enquadra a frota uma única vez, quando houver dados E o mapa estiver pronto. */
function maybeFit() {
  if (state.fitted || !geo?.ready) return;
  const items = visibleItems(performance.now(), 'map');
  if (items.length === 0) return;
  state.fitted = true;
  geo.fit(items);
}

function onBatch(list) {
  const now = performance.now();
  for (const data of list) {
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

// ---------- Filtros e visibilidade ----------

function matches(d) {
  if (d.id === state.selectedId) return true;
  if (!state.tipos.has(d.tipo)) return false;
  const q = state.query.trim().toLowerCase();
  return !q || d.nome.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
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
    indoor?.render(items);
  }
}

// ---------- Interface ----------

function buildTypeFilters() {
  for (const tipo of TIPOS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.setAttribute('aria-pressed', 'true');
    button.innerHTML = `${glyphSvg(tipo.id, 16)}<span>${tipo.plural}</span><b>0</b>`;
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
}

function createRow(d) {
  const li = document.createElement('li');
  li.innerHTML = `<button type="button" class="row" data-id="">
    <span class="glyph"></span>
    <span><span class="name"></span><span class="code"></span></span>
    <span class="meta"><span class="speed"></span><span class="state"></span></span>
  </button>`;
  li.querySelector('.glyph').innerHTML = glyphSvg(d.tipo, 22);
  return li;
}

function fillRow(li, d) {
  const button = li.firstElementChild;
  button.dataset.id = d.id;
  button.setAttribute('aria-pressed', String(d.id === state.selectedId));
  li.querySelector('.name').textContent = d.nome;
  li.querySelector('.code').textContent = d.id;
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
    const signature = `${d.nome}|${d.status}|${Math.round(d.velocidade)}|${d.id === state.selectedId}`;
    if (li.dataset.sig !== signature) {
      fillRow(li, d);
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
        : 'Nenhum ativo corresponde ao filtro. Limpe a busca ou ative mais tipos.';
  }
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
  $('#detail-name').textContent = d.nome;
  $('#detail-id').textContent = `${tipo.label}, código ${d.id}`;
  $('#detail-status').textContent = STATUS[d.status].label;
  $('#detail-speed').textContent = `${fmt(d.velocidade)} km/h`;
  $('#detail-heading').textContent = `${fmt(d.rumo)}° ${cardinal(d.rumo)}`;
  $('#detail-age').textContent = ago(Date.now() - asset.lastSeen);
  $('#detail-pos').textContent = d.espaco
    ? `x ${fmt(d.x, 1)} m, y ${fmt(d.y, 1)} m`
    : `${fmt(d.lat, 5)}, ${fmt(d.lon, 5)}`;
  els.followWrap.hidden = Boolean(d.espaco);
}

/** Na planta, afasta o desenho do card de detalhes (que flutua sobre o palco). */
function syncIndoorInsets() {
  if (!indoor) return;
  if (state.view !== 'indoor' || els.detail.hidden) {
    indoor.setInsets(0, 0);
    return;
  }
  const stage = els.indoor.getBoundingClientRect();
  const card = els.detail.getBoundingClientRect();
  if (card.top + card.height / 2 < stage.top + stage.height / 2) {
    indoor.setInsets(card.bottom - stage.top + 8, 0);
  } else {
    indoor.setInsets(0, stage.bottom - card.top + 8);
  }
}

function refreshUi() {
  updateSummary();
  renderList();
  updateDetail();
  syncIndoorInsets();
}

function setFollow(on) {
  state.follow = on;
  els.follow.checked = on;
}

function setView(view) {
  state.view = view;
  for (const button of els.views) button.setAttribute('aria-selected', String(button.dataset.view === view));
  els.map.hidden = view !== 'map';
  els.indoor.hidden = view !== 'indoor';
  els.fit.hidden = view !== 'map';
  if (view === 'map') geo?.resize();
  else indoor?.resize();
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

  const d = asset.data;
  if (d.espaco) {
    state.space = state.spaces.find((s) => s.id === d.espaco) ?? state.space;
    indoor.setSpace(state.space);
    setView('indoor');
  } else {
    setView('map');
    const p = asset.sample(performance.now());
    geo?.flyTo(p.x, p.y);
  }
  refreshUi();

  try {
    const res = await fetch(`/api/assets/${encodeURIComponent(id)}/trail`);
    if (res.ok && state.selectedId === id) {
      state.trail = (await res.json()).points;
      applyTrail();
    }
  } catch {
    /* rastro é opcional */
  }
}

function bindEvents() {
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    refreshUi();
  });
  els.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) select(state.selectedId === row.dataset.id ? null : row.dataset.id);
  });
  for (const button of els.views) {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      setView(view);
      const selected = state.selectedId && state.assets.get(state.selectedId);
      if (selected && Boolean(selected.data.espaco) !== (view === 'indoor')) select(null);
    });
  }
  els.fit.addEventListener('click', () => geo?.fit(visibleItems(performance.now(), 'map')));
  els.follow.addEventListener('change', () => {
    state.follow = els.follow.checked;
  });
  els.trail.addEventListener('change', () => {
    state.showTrail = els.trail.checked;
    applyTrail();
  });
  $('#detail-close').addEventListener('click', () => select(null));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedId) select(null);
  });
}

const CONNECTION_LABEL = { connecting: 'Conectando…', open: 'Ao vivo', closed: 'Reconectando…' };
function onConnectionState(value) {
  els.conn.dataset.state = value;
  els.conn.textContent = CONNECTION_LABEL[value];
}

async function boot() {
  const [config, spaces] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/spaces').then((r) => r.json()),
  ]);
  state.spaces = spaces;
  state.space = spaces[0] ?? null;
  if (config.versao) $('#version').textContent = `v${config.versao}`;

  buildTypeFilters();
  bindEvents();

  indoor = new IndoorView($('#indoor'), els.indoorCanvas, { onSelect: select });
  if (state.space) indoor.setSpace(state.space);
  else els.views.find((b) => b.dataset.view === 'indoor').disabled = true;

  connect({ onSnapshot, onBatch, onRemove, onState: onConnectionState });
  requestAnimationFrame(frame);
  setInterval(refreshUi, 500);

  // O mapa carrega em paralelo: lista, contadores e planta não dependem dele
  // (tiles lentos ou bloqueados não podem travar o resto do app).
  geo = new GeoView(els.map, config, { onSelect: select, onUserPan: () => setFollow(false) });
  geo.init()
    .then(() => {
      geo.setSelected(state.selectedId);
      applyTrail();
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
