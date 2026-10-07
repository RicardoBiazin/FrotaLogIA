// Vista 3D isométrica do CD (Three.js, câmera ortográfica). Mostra os mesmos dados da planta 2D:
// empilhadeiras em tempo real, paletes em cada nível das prateleiras e veículos nas docas.
//
// Coordenadas: a planta usa x → leste e y → norte (metros). Na cena, X = leste, Z = sul, Y = altura,
// com a origem no centro da planta. Rumo 0 = norte (-Z), sentido horário.
//
// O Three.js é carregado só quando a vista 3D é aberta (import dinâmico), como o MapLibre.
import { IndoorView } from './indoorView.js';
import { tipoOf } from './icons.js';
import { formatEndereco } from './estoque.js';

const LEVEL_H = 1.6; // altura de cada nível da prateleira (m)
const PALLET_H = 1.2;
const FLOOR_COLOR = '#f4f5f1';
const ZONE_COLOR = { doca: '#dfe9e2', expedicao: '#f8edd2', estoque: '#eef0ea', picking: '#dfe8f3' };
const SELECT_COLOR = '#0a6b4b';
const HIGHLIGHT_COLOR = '#f2b705';
const DIM_COLOR = '#d9ddd6';
const ZOOM_INICIAL = 1.2;

// Cor do palete pela família do produto (prefixo do SKU). Desconhecida: cinza azulado.
export const FAMILIAS = [
  { prefixo: 'ELE', nome: 'Eletro', cor: '#4a78b5' },
  { prefixo: 'ALI', nome: 'Alimentos', cor: '#d9a441' },
  { prefixo: 'BEB', nome: 'Bebidas', cor: '#2f9e8f' },
  { prefixo: 'HIG', nome: 'Higiene', cor: '#9b7fd1' },
  { prefixo: 'CON', nome: 'Construção', cor: '#8d8f93' },
  { prefixo: 'PNE', nome: 'Pneus', cor: '#3d4247' },
  { prefixo: 'MOV', nome: 'Móveis', cor: '#a0714f' },
  { prefixo: 'FAR', nome: 'Farmácia', cor: '#d46a8c' },
];
const OUTRO = { nome: 'Outros', cor: '#7f9bb3' };
export const familiaDe = (sku = '') => FAMILIAS.find((f) => sku.toUpperCase().startsWith(f.prefixo)) ?? OUTRO;

let THREE = null;

/** Etiqueta de texto sempre virada para a câmera. `altura` em metros. */
function label(text, { altura = 1, cor = '#18282c', fundo = 'rgba(255,255,255,0.88)', peso = 600 } = {}) {
  const px = 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${peso} ${px}px "Public Sans", system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + px;
  canvas.width = w;
  canvas.height = px * 1.6;
  ctx.font = `${peso} ${px}px "Public Sans", system-ui, sans-serif`;
  if (fundo) {
    ctx.fillStyle = fundo;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, canvas.height, px * 0.4);
    ctx.fill();
  }
  ctx.fillStyle = cor;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((altura * w) / canvas.height, altura, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function box(w, h, d, color, opts = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color, ...opts }),
  );
  mesh.castShadow = false;
  return mesh;
}

/** Empilhadeira: chassi na cor do tipo, cabine, torre e garfos para a frente (-Z). */
function forkliftModel(color) {
  const g = new THREE.Group();
  const body = box(1.2, 0.9, 2.0, color);
  body.position.y = 0.6;
  const cab = box(1.0, 1.0, 1.0, '#2b3a40', { transparent: true, opacity: 0.55 });
  cab.position.set(0, 1.55, 0.25);
  const roof = box(1.1, 0.08, 1.2, '#2b3a40');
  roof.position.set(0, 2.1, 0.25);
  const mast = box(1.0, 2.4, 0.15, '#3a4448');
  mast.position.set(0, 1.3, -1.05);
  const forkL = box(0.12, 0.06, 1.1, '#2b3236');
  forkL.position.set(-0.3, 0.2, -1.65);
  const forkR = forkL.clone();
  forkR.position.x = 0.3;
  g.add(body, cab, roof, mast, forkL, forkR);
  g.userData.body = body;
  return g;
}

/** Caminhão ou van de ré na doca: baú encostado na porta (-Z) e cabine para fora (+Z). */
function vehicleModel(tipo, color) {
  const g = new THREE.Group();
  const grande = tipo === 'caminhao';
  const bauL = grande ? 7.5 : 3.2;
  const bau = box(2.5, grande ? 3.0 : 2.2, bauL, '#f2f2ee');
  bau.position.set(0, (grande ? 3.0 : 2.2) / 2 + 0.5, bauL / 2);
  const cab = box(2.4, grande ? 2.6 : 1.9, 2.0, color);
  cab.position.set(0, (grande ? 2.6 : 1.9) / 2 + 0.4, bauL + 1.15);
  g.add(bau, cab);
  g.userData.body = cab;
  return g;
}

export class IsoView {
  constructor(wrap, handlers) {
    this.wrap = wrap;
    this.handlers = handlers;
    this.ready = false;
    this.space = null;
    this.selectedId = null;
    this.estoque = { itens: new Map(), destaque: null, selecionada: null };
    this.estoqueSig = '';
    this.assets = new Map(); // id → { group, label, tipo, status }
    this.az = Math.PI / 4; // isométrica: 45° de azimute
    this.el = Math.atan(1 / Math.SQRT2); // ~35,26° de elevação
    this.zoom = ZOOM_INICIAL;
    this.target = null;
  }

  async init() {
    THREE = await import('/vendor/three/three.module.js');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor('#e9ece6');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;
    this.wrap.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Vista 3D do centro de distribuição');

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.target = new THREE.Vector3();
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b8bfb5', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-40, 80, 30);
    this.scene.add(sun);

    this.staticGroup = new THREE.Group();
    this.palletGroup = new THREE.Group();
    this.assetGroup = new THREE.Group();
    this.scene.add(this.staticGroup, this.palletGroup, this.assetGroup);
    this.raycaster = new THREE.Raycaster();

    this.#bindControls();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.ready = true;
    if (this.space) this.#buildStatic();
    this.resize();
  }

  // ---------- Câmera e controles ----------

  #bindControls() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.pan) {
        // Arrasta o alvo no plano do chão, na direção da tela.
        const k = this.#metersPerPixel();
        const right = new THREE.Vector3(Math.cos(this.az), 0, -Math.sin(this.az));
        const fwd = new THREE.Vector3(-Math.sin(this.az), 0, -Math.cos(this.az));
        this.target.addScaledVector(right, -dx * k).addScaledVector(fwd, (dy * k) / Math.sin(this.el));
      } else {
        this.az -= dx * 0.008;
        this.el = Math.min(1.45, Math.max(0.3, this.el + dy * 0.006));
      }
      this.#updateCamera();
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && drag.moved < 5) this.#onClick(e);
      drag = null;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(8, Math.max(0.4, this.zoom * Math.exp(-e.deltaY * 0.0015)));
        this.#updateCamera();
      },
      { passive: false },
    );
  }

  #metersPerPixel() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.cssH || 1);
  }

  /** Volta para a vista isométrica inicial, enquadrando o CD inteiro. */
  resetView() {
    this.az = Math.PI / 4;
    this.el = Math.atan(1 / Math.SQRT2);
    this.zoom = ZOOM_INICIAL;
    this.target?.set(0, 0, 4);
    this.#updateCamera();
  }

  #updateCamera() {
    if (!this.ready) return;
    const d = 300;
    const { az, el } = this;
    this.camera.position.set(
      this.target.x + d * Math.cos(el) * Math.sin(az),
      this.target.y + d * Math.sin(el),
      this.target.z + d * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(this.target);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    if (!this.ready) return;
    const { clientWidth: w, clientHeight: h } = this.wrap;
    if (!w || !h) return;
    this.cssW = w;
    this.cssH = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    // Enquadra a planta inteira (com o pátio das docas) na altura ou na largura disponível.
    const s = this.space;
    const tamanho = s ? Math.max(s.largura, s.altura + 14) * 0.62 : 50;
    const aspect = w / h;
    const half = aspect >= 1 ? tamanho : tamanho / aspect;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.#updateCamera();
  }

  // ---------- Cena fixa: piso, zonas, paredes, docas, prateleiras ----------

  #toWorld(x, y) {
    return { x: x - this.space.largura / 2, z: this.space.altura / 2 - y };
  }

  setSpace(space) {
    this.space = space;
    this.estoqueSig = '';
    for (const a of this.assets.values()) this.assetGroup.remove(a.group);
    this.assets.clear();
    if (!this.ready) return;
    this.#buildStatic();
    this.resize();
    this.resetView();
  }

  #clear(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose();
        if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); });
      });
    }
  }

  #buildStatic() {
    const s = this.space;
    this.#clear(this.staticGroup);
    this.#clear(this.palletGroup);
    this.hitBoxes = [];
    const G = this.staticGroup;

    // pátio (lado sul, fora do prédio) e piso
    const patio = new THREE.Mesh(new THREE.PlaneGeometry(s.largura + 20, 22), new THREE.MeshLambertMaterial({ color: '#d5d9d2' }));
    patio.rotation.x = -Math.PI / 2;
    patio.position.set(0, -0.02, s.altura / 2 + 11);
    const piso = new THREE.Mesh(new THREE.PlaneGeometry(s.largura, s.altura), new THREE.MeshLambertMaterial({ color: FLOOR_COLOR }));
    piso.rotation.x = -Math.PI / 2;
    G.add(patio, piso);

    for (const z of s.zonas ?? []) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(z.w, z.h),
        new THREE.MeshLambertMaterial({ color: ZONE_COLOR[z.tipo] ?? '#eceee8' }),
      );
      m.rotation.x = -Math.PI / 2;
      const c = this.#toWorld(z.x + z.w / 2, z.y + z.h / 2);
      m.position.set(c.x, 0.01, c.z);
      G.add(m);
      if (z.nome) {
        const l = label(z.nome, { altura: 1.4, cor: '#51646a', fundo: null, peso: 600 });
        const p = this.#toWorld(z.x + z.w - 2, z.y + 1.2);
        l.position.set(p.x - l.scale.x / 2, 0.8, p.z);
        G.add(l);
      }
    }

    // paredes baixas (deixam ver dentro), com vão em cada porta de doca
    const wallH = 1.2;
    const wallMat = new THREE.MeshLambertMaterial({ color: '#9aa7a3', transparent: true, opacity: 0.85 });
    const wall = (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.01) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, wallH, 0.3), wallMat);
      const a = this.#toWorld((x1 + x2) / 2, (y1 + y2) / 2);
      m.position.set(a.x, wallH / 2, a.z);
      m.rotation.y = Math.atan2(y2 - y1, x2 - x1);
      G.add(m);
    };
    wall(0, s.altura, s.largura, s.altura);
    wall(0, 0, 0, s.altura);
    wall(s.largura, 0, s.largura, s.altura);
    const portas = [...(s.portas ?? [])].sort((a, b) => a.x - b.x);
    let x = 0;
    for (const p of portas) {
      wall(x, 0, p.x, 0);
      x = p.x + p.w;
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(p.w, 1.2), new THREE.MeshLambertMaterial({ color: HIGHLIGHT_COLOR }));
      mark.rotation.x = -Math.PI / 2;
      const c = this.#toWorld(p.x + p.w / 2, -0.6);
      mark.position.set(c.x, 0.02, c.z);
      const l = label(p.nome, { altura: 1.3, fundo: null, cor: '#18282c' });
      l.position.set(c.x, 0.9, c.z + 1.6);
      G.add(mark, l);
    }
    wall(x, 0, s.largura, 0);

    // prateleiras: montantes, longarinas e caixas de clique (uma por posição)
    const steel = new THREE.MeshLambertMaterial({ color: '#5d6f80' });
    const beamMat = new THREE.MeshLambertMaterial({ color: '#e07b24' });
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const r of s.prateleiras ?? []) {
      const altura = r.niveis * LEVEL_H + 0.3;
      const horizontal = r.w >= r.h;
      const cells = IndoorView.cells(r);
      const comp = horizontal ? r.w : r.h;
      const prof = horizontal ? r.h : r.w;
      // montantes nas divisas das posições, dos dois lados
      for (let i = 0; i <= r.posicoes; i++) {
        for (const lado of [0, 1]) {
          const along = (i / r.posicoes) * comp;
          const across = lado * prof;
          const px = horizontal ? r.x + along : r.x + across;
          const py = horizontal ? r.y + across : r.y + along;
          const up = new THREE.Mesh(new THREE.BoxGeometry(0.12, altura, 0.12), steel);
          const w = this.#toWorld(px, py);
          up.position.set(w.x, altura / 2, w.z);
          G.add(up);
        }
      }
      // longarinas em cada nível, dos dois lados
      for (let n = 1; n <= r.niveis; n++) {
        for (const lado of [0, 1]) {
          const geo = horizontal ? new THREE.BoxGeometry(comp, 0.1, 0.1) : new THREE.BoxGeometry(0.1, 0.1, comp);
          const beam = new THREE.Mesh(geo, beamMat);
          const c = horizontal
            ? this.#toWorld(r.x + comp / 2, r.y + lado * prof)
            : this.#toWorld(r.x + lado * prof, r.y + comp / 2);
          beam.position.set(c.x, (n - 1) * LEVEL_H + 0.15, c.z);
          G.add(beam);
        }
      }
      // letra da rua na ponta oeste/sul
      const l = label(`Rua ${r.id}`, { altura: 1.6 });
      const lp = horizontal ? this.#toWorld(r.x - 3, r.y + r.h / 2) : this.#toWorld(r.x + r.w / 2, r.y - 3);
      l.position.set(lp.x, altura + 0.6, lp.z);
      G.add(l);
      // caixas invisíveis para o clique (posição inteira, todos os níveis)
      for (const c of cells) {
        const hit = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? c.w : c.w, altura, horizontal ? c.h : c.h), hitMat);
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        hit.position.set(w.x, altura / 2, w.z);
        hit.userData.slot = { rua: r.id, posicao: c.posicao };
        G.add(hit);
        this.hitBoxes.push(hit);
      }
    }
    this.#buildPallets();
  }

  // ---------- Paletes ----------

  /**
   * itens: Map<endereco, item> do CD; destaque: Set<endereco> da busca (null = sem busca);
   * selecionada: { rua, posicao } ou null.
   */
  setEstoque(itens, destaque = null, selecionada = null) {
    this.estoque = { itens, destaque, selecionada };
    const sig = [
      [...itens.values()].map((i) => `${i.endereco}:${i.sku}:${i.quantidade}`).join(','),
      destaque ? [...destaque].join(',') : '-',
      selecionada ? `${selecionada.rua}-${selecionada.posicao}` : '',
    ].join('|');
    if (sig === this.estoqueSig) return;
    this.estoqueSig = sig;
    if (this.ready && this.space) this.#buildPallets();
  }

  #buildPallets() {
    this.#clear(this.palletGroup);
    const s = this.space;
    const { itens, destaque, selecionada } = this.estoque;
    const slots = [];
    for (const r of s.prateleiras ?? []) {
      for (const c of IndoorView.cells(r)) {
        for (let n = 1; n <= r.niveis; n++) {
          const item = itens.get(formatEndereco(r.id, c.posicao, n));
          if (item) slots.push({ r, c, n, item });
        }
      }
    }
    if (slots.length) {
      const base = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.15, 1), new THREE.MeshLambertMaterial({ color: '#b58a5a' }), slots.length);
      const carga = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#ffffff' }), slots.length);
      const m = new THREE.Matrix4();
      const color = new THREE.Color();
      slots.forEach(({ r, c, n, item }, i) => {
        const horizontal = r.w >= r.h;
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        const sx = (horizontal ? c.w : c.w) * 0.82;
        const sz = (horizontal ? c.h : c.h) * 0.82;
        const y0 = (n - 1) * LEVEL_H + 0.2;
        // carga mais baixa quando o palete está quase vazio (quantidade não é conhecida em unidades de altura)
        const h = PALLET_H;
        m.makeScale(sx, 1, sz).setPosition(w.x, y0 + 0.075, w.z);
        base.setMatrixAt(i, m);
        m.makeScale(sx * 0.95, h, sz * 0.95).setPosition(w.x, y0 + 0.15 + h / 2, w.z);
        carga.setMatrixAt(i, m);
        const realce = destaque ? destaque.has(item.endereco) : true;
        color.set(destaque ? (realce ? HIGHLIGHT_COLOR : DIM_COLOR) : familiaDe(item.sku).cor);
        carga.setColorAt(i, color);
      });
      carga.userData.slots = slots.map(({ r, c }) => ({ rua: r.id, posicao: c.posicao }));
      this.palletGroup.add(base, carga);
      this.pallets = carga;
    } else {
      this.pallets = null;
    }

    // contorno da posição selecionada (todos os níveis)
    if (selecionada) {
      const r = s.prateleiras.find((p) => p.id === selecionada.rua);
      const c = r && IndoorView.cells(r)[selecionada.posicao - 1];
      if (c) {
        const altura = r.niveis * LEVEL_H + 0.4;
        const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(c.w + 0.3, altura, c.h + 0.3));
        const edges = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: SELECT_COLOR }));
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        edges.position.set(w.x, altura / 2, w.z);
        const glow = new THREE.Mesh(
          new THREE.BoxGeometry(c.w + 0.3, altura, c.h + 0.3),
          new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        glow.position.copy(edges.position);
        this.palletGroup.add(edges, glow);
      }
    }
  }

  // ---------- Empilhadeiras e veículos (tempo real) ----------

  setSelected(id) {
    this.selectedId = id;
  }

  #asset(id, tipo, status, nome, kind) {
    let a = this.assets.get(id);
    const cor = status === 'offline' ? '#9aa5a1' : tipoOf(tipo).color;
    if (!a || a.kind !== kind || a.tipo !== tipo) {
      if (a) this.assetGroup.remove(a.group);
      const group = kind === 'doca' ? vehicleModel(tipo, cor) : forkliftModel(cor);
      group.traverse((o) => (o.userData.assetId = id));
      const tag = label(nome, { altura: kind === 'doca' ? 1.5 : 1.1 });
      tag.position.y = kind === 'doca' ? 5 : 3;
      if (kind === 'doca') tag.position.z = 5;
      group.add(tag);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.6, 2.1, 32),
        new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      group.add(ring);
      a = { group, tag, ring, kind, tipo, status: null, texto: nome };
      this.assets.set(id, a);
      this.assetGroup.add(group);
    }
    if (a.status !== status) {
      a.group.userData.body.material.color.set(cor);
      a.status = status;
    }
    a.ring.visible = id === this.selectedId;
    return a;
  }

  /**
   * items: ativos dentro da planta { id, nome, tipo, status, x, y, rumo } (já interpolados);
   * docked: veículos no pátio do CD { id, nome, tipo, status, viagemStatus }.
   */
  render(items, docked = []) {
    if (!this.ready || !this.space) return;
    const vivos = new Set();
    for (const it of items) {
      const a = this.#asset(it.id, it.tipo, it.status, it.nome, 'planta');
      const w = this.#toWorld(it.x, it.y);
      a.group.position.set(w.x, 0, w.z);
      a.group.rotation.y = (-it.rumo * Math.PI) / 180;
      vivos.add(it.id);
    }
    const portas = [...(this.space.portas ?? [])].sort((p, q) => p.x - q.x);
    [...docked].sort((p, q) => p.id.localeCompare(q.id)).slice(0, portas.length).forEach((it, i) => {
      const p = portas[i];
      const a = this.#asset(it.id, it.tipo, it.status, it.nome, 'doca');
      const w = this.#toWorld(p.x + p.w / 2, -0.4);
      a.group.position.set(w.x, 0, w.z);
      a.group.rotation.y = 0;
      vivos.add(it.id);
    });
    for (const [id, a] of this.assets) {
      if (!vivos.has(id)) {
        this.assetGroup.remove(a.group);
        this.assets.delete(id);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- Clique ----------

  #onClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const asset = this.raycaster.intersectObjects(this.assetGroup.children, true).find((h) => h.object.userData.assetId && !h.object.isSprite);
    if (asset) return this.handlers.onSelect(asset.object.userData.assetId);
    if (this.pallets) {
      const hit = this.raycaster.intersectObject(this.pallets)[0];
      if (hit) return this.handlers.onSelectSlot(this.pallets.userData.slots[hit.instanceId]);
    }
    const slot = this.raycaster.intersectObjects(this.hitBoxes ?? [])[0];
    if (slot) return this.handlers.onSelectSlot(slot.object.userData.slot);
    this.handlers.onSelect(null);
  }
}
