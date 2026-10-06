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

export class GeoView {
  constructor(container, config, handlers) {
    this.container = container;
    this.config = config;
    this.handlers = handlers;
    this.lastDraw = 0;
    this.ready = false;
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
      // Camada separada: se as fontes (glyphs) falharem, os ícones continuam funcionando.
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

    map.on('mouseenter', 'assets-icon', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'assets-icon', () => (map.getCanvas().style.cursor = ''));
    map.on('click', (e) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: ['assets-icon'] })[0];
      this.handlers.onSelect(hit ? hit.properties.id : null);
    });
    map.on('dragstart', () => this.handlers.onUserPan());

    this.ready = true;
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
        properties: { id: a.id, nome: a.nome, tipo: a.tipo, status: a.status, rumo: a.rumo },
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
