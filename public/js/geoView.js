// Visualização em mapa (MapLibre GL 6, distribuído apenas como módulo ES).
// O import é dinâmico para que uma falha ao carregar o mapa não derrube o resto do app.
import { TIPOS, STATUS_IDS, glyphImage } from './icons.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
const MIN_FRAME_MS = 33; // ~30 fps é suficiente para o GeoJSON; o ícone continua fluido

// OpenFreeMap: vetorial, gratuito e sem chave (a CARTO passou a exigir chave em 2026).
// Para produção, prefira hospedar os tiles ou contratar um provedor (MAP_STYLE_URL).
const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
// Fonte dos rótulos: precisa existir no servidor de glyphs do estilo em uso.
const DEFAULT_LABEL_FONT = 'Noto Sans Bold';
const CD_COLOR = '#18282c';
const LATE_COLOR = '#c62828';

/** Polígono aproximando o círculo de `raioM` metros em volta do ponto (para a cerca do CD). */
function circle(lon, lat, raioM, steps = 48) {
  const coords = [];
  const dLat = raioM / 111_320;
  const dLon = raioM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([lon + Math.sin(a) * dLon, lat + Math.cos(a) * dLat]);
  }
  return coords;
}

export class GeoView {
  constructor(container, config, handlers) {
    this.container = container;
    this.config = config;
    this.handlers = handlers;
    this.lastDraw = 0;
    this.ready = false;
    this.centros = [];
    this.cdLabels = new Map(); // id → texto do resumo
    this.cdSelected = null;
  }

  async init() {
    const maplibregl = await import('/vendor/maplibre-gl/maplibre-gl.mjs');
    this.gl = maplibregl;
    const map = new maplibregl.Map({
      container: this.container,
      style: this.config.mapStyleUrl || DEFAULT_STYLE_URL,
      center: this.config.center,
      zoom: this.config.zoom,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    await new Promise((resolve) => map.once('load', resolve));

    for (const tipo of TIPOS) {
      for (const status of STATUS_IDS) {
        map.addImage(`${tipo.id}-${status}`, glyphImage(tipo.id, status), { pixelRatio: 2 });
      }
    }

    map.addSource('trail', { type: 'geojson', data: EMPTY });
    map.addSource('assets', { type: 'geojson', data: EMPTY });
    map.addSource('centros-area', { type: 'geojson', data: EMPTY });
    map.addSource('centros', { type: 'geojson', data: EMPTY });

    // CDs: cerca (área), marcador e rótulo com o resumo. Abaixo dos veículos.
    map.addLayer({
      id: 'centros-fill',
      type: 'fill',
      source: 'centros-area',
      minzoom: 11,
      paint: { 'fill-color': CD_COLOR, 'fill-opacity': ['case', ['get', 'selected'], 0.12, 0.06] },
    });
    map.addLayer({
      id: 'centros-line',
      type: 'line',
      source: 'centros-area',
      minzoom: 11,
      paint: {
        'line-color': CD_COLOR,
        'line-width': ['case', ['get', 'selected'], 2.5, 1.2],
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.6,
      },
    });
    map.addLayer({
      id: 'centros-ponto',
      type: 'circle',
      source: 'centros',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 11, 8],
        'circle-color': CD_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    });

    map.addLayer({
      id: 'trail-line',
      type: 'line',
      source: 'trail',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0a6b4b', 'line-width': 3.5, 'line-opacity': 0.7 },
    });
    map.addLayer({
      id: 'selected-halo',
      type: 'circle',
      source: 'assets',
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': 24,
        'circle-color': '#0a6b4b',
        'circle-opacity': 0.16,
        'circle-stroke-color': '#0a6b4b',
        'circle-stroke-width': 2,
        'circle-pitch-alignment': 'map',
      },
    });
    // Veículo atrasado: anel vermelho por baixo do ícone (o rótulo "+12 min" vem com as fontes).
    map.addLayer({
      id: 'atraso-anel',
      type: 'circle',
      source: 'assets',
      filter: ['==', ['get', 'atrasado'], true],
      paint: {
        'circle-radius': 15,
        'circle-color': LATE_COLOR,
        'circle-opacity': 0.14,
        'circle-stroke-color': LATE_COLOR,
        'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: 'assets-icon',
      type: 'symbol',
      source: 'assets',
      layout: {
        'icon-image': ['concat', ['get', 'tipo'], '-', ['get', 'status']],
        'icon-rotate': ['get', 'rumo'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    try {
      // Camadas separadas: se as fontes (glyphs) falharem, os ícones continuam funcionando.
      map.addLayer({
        id: 'atraso-rotulo',
        type: 'symbol',
        source: 'assets',
        filter: ['==', ['get', 'atrasado'], true],
        layout: {
          'text-field': ['get', 'atrasoTxt'],
          'text-font': [this.config.mapLabelFont || DEFAULT_LABEL_FONT],
          'text-size': 11.5,
          'text-anchor': 'bottom',
          'text-offset': [0, -1.5],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': LATE_COLOR, 'text-halo-width': 3 },
      });
      map.addLayer({
        id: 'centros-rotulo',
        type: 'symbol',
        source: 'centros',
        layout: {
          'text-field': ['format', ['get', 'nome'], {}, '\n', {}, ['get', 'resumo'], { 'font-scale': 0.85 }],
          'text-font': [this.config.mapLabelFont || DEFAULT_LABEL_FONT],
          'text-size': 12.5,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': CD_COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
      });
      map.addLayer({
        id: 'assets-label',
        type: 'symbol',
        source: 'assets',
        minzoom: 12.5,
        layout: {
          'text-field': ['get', 'nome'],
          'text-font': [this.config.mapLabelFont || DEFAULT_LABEL_FONT],
          'text-size': 12,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': '#18282c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      });
    } catch (err) {
      console.warn('Rótulos do mapa desativados (estilo sem glyphs):', err.message);
    }

    for (const layer of ['assets-icon', 'centros-ponto', 'centros-fill']) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('click', (e) => {
      // Veículo tem prioridade sobre o CD (ele costuma estar dentro da cerca).
      const asset = map.queryRenderedFeatures(e.point, { layers: ['assets-icon'] })[0];
      if (asset) return this.handlers.onSelect(asset.properties.id);
      const cd = map.queryRenderedFeatures(e.point, { layers: ['centros-ponto', 'centros-fill'] })[0];
      if (cd) return this.handlers.onSelectCd(cd.properties.id);
      this.handlers.onSelect(null);
    });
    map.on('dragstart', () => this.handlers.onUserPan());

    this.ready = true;
    this.#drawCentros();
  }

  /** centros: [{ id, nome, lat, lon, raioM }] */
  setCentros(centros) {
    this.centros = centros;
    this.#drawCentros();
  }

  /** labels: Map<id, string> com o resumo de cada CD. Só redesenha se mudou. */
  setCentroLabels(labels) {
    let changed = labels.size !== this.cdLabels.size;
    for (const [id, text] of labels) if (this.cdLabels.get(id) !== text) changed = true;
    if (!changed) return;
    this.cdLabels = new Map(labels);
    this.#drawCentros();
  }

  setSelectedCd(id) {
    if (this.cdSelected === id) return;
    this.cdSelected = id;
    this.#drawCentros();
  }

  #drawCentros() {
    if (!this.ready) return;
    const props = (c) => ({ id: c.id, nome: c.nome, resumo: this.cdLabels.get(c.id) ?? '', selected: c.id === this.cdSelected });
    this.map.getSource('centros').setData({
      type: 'FeatureCollection',
      features: this.centros.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: props(c) })),
    });
    this.map.getSource('centros-area').setData({
      type: 'FeatureCollection',
      features: this.centros.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [circle(c.lon, c.lat, c.raioM)] },
        properties: props(c),
      })),
    });
  }

  /** items: [{ id, nome, tipo, status, x (lon), y (lat), rumo }]. Retorna true se desenhou o quadro. */
  render(items, now) {
    if (!this.ready || now - this.lastDraw < MIN_FRAME_MS) return false;
    this.lastDraw = now;
    this.map.getSource('assets').setData({
      type: 'FeatureCollection',
      features: items.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.x, a.y] },
        properties: {
          id: a.id, nome: a.nome, tipo: a.tipo, status: a.status, rumo: a.rumo,
          atrasado: Boolean(a.atrasoTxt), atrasoTxt: a.atrasoTxt ?? '',
        },
      })),
    });
    return true;
  }

  setSelected(id) {
    if (!this.ready) return;
    this.map.setFilter('selected-halo', ['==', ['get', 'id'], id ?? '']);
  }

  /** points: [[lon, lat, ts], ...] */
  setTrail(points) {
    if (!this.ready) return;
    const coordinates = points.map(([lon, lat]) => [lon, lat]);
    this.map.getSource('trail').setData(
      coordinates.length > 1
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }
        : EMPTY,
    );
  }

  follow(x, y) {
    if (this.ready) this.map.jumpTo({ center: [x, y] });
  }

  flyTo(x, y, minZoom = 14) {
    if (!this.ready) return;
    this.map.flyTo({ center: [x, y], zoom: Math.max(this.map.getZoom(), minZoom), duration: 900 });
  }

  fit(items) {
    if (!this.ready || items.length === 0) return;
    const bounds = new this.gl.LngLatBounds();
    for (const a of items) bounds.extend([a.x, a.y]);
    this.map.fitBounds(bounds, { padding: 90, maxZoom: 15, duration: 700 });
  }

  resize() {
    this.map?.resize();
  }
}
