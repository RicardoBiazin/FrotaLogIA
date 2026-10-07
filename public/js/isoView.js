// Vista 3D isométrica do CD (Three.js, câmera ortográfica), em estilo "maquete":
// prédio azul em corte (as paredes viradas para a câmera ficam baixas para mostrar o interior),
// sombras suaves, pátio com vagas, caixas de papelão nas prateleiras, empilhadeiras e caminhões
// estilizados e marcadores flutuantes. Os dados são os mesmos da planta 2D, em tempo real.
//
// Coordenadas: a planta usa x → leste e y → norte (metros). Na cena, X = leste, Z = sul, Y = altura,
// com a origem no centro da planta. Rumo 0 = norte (-Z), sentido horário.
//
// O Three.js é carregado só quando a vista 3D é aberta (import dinâmico), como o MapLibre.
import { IndoorView } from './indoorView.js';
import { tipoOf } from './icons.js';
import { formatEndereco, parseEndereco } from './estoque.js';

const LEVEL_H = 1.6; // altura de cada nível da prateleira (m)
const WALL_H = 7; // pé-direito do galpão
const WALL_LOW = 0.9; // parede em corte (virada para a câmera)
const ZOOM_INICIAL = 1.2;

const C = {
  fundo: '#eef2f8',
  terreno: '#e4e9f0',
  asfalto: '#cdd5df',
  faixa: '#ffffff',
  piso: '#f7f8fa',
  parede: '#3b6fe0',
  paredeTopo: '#2b56b8',
  porta: '#dfe4ec',
  papelao: '#d4a373',
  papelaoTopo: '#e2b98c',
  madeira: '#b07d4f',
  aco: '#5d6f80',
  longarina: '#f08a24',
  selecao: '#0a6b4b',
  pin: '#2f6ff0',
  destaque: '#f2b705',
  apagado: '#d9dde3',
};
const ZONE_COLOR = { doca: '#e6edf7', expedicao: '#f6efe0', estoque: '#f7f8fa', picking: '#e9eef8' };

// Faixa colorida das caixas pela família do produto (prefixo do SKU). Desconhecida: cinza azulado.
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

// ---------- Peças reutilizáveis ----------

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
}

function mesh(geo, material, { sombra = true, recebe = false } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = sombra;
  m.receiveShadow = recebe;
  return m;
}

function box(w, h, d, color, opts) {
  return mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'string' ? mat(color) : color, opts);
}

/** Caixa de cantos arredondados (perfil w × h extrudado em d), centrada na origem. */
function roundedBox(w, h, d, r, material) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelSize: r * 0.4, bevelThickness: r * 0.4, bevelSegments: 2, curveSegments: 4 });
  geo.translate(0, 0, -d / 2);
  return mesh(geo, material);
}

function wheel(r, w) {
  const g = new THREE.CylinderGeometry(r, r, w, 16);
  g.rotateZ(Math.PI / 2);
  return mesh(g, mat('#22272b'));
}

function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Etiqueta de texto sempre virada para a câmera. `altura` em metros. */
function label(text, { altura = 1, cor = '#18282c', fundo = 'rgba(255,255,255,0.94)', peso = 600, borda = null } = {}) {
  const px = 48;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${peso} ${px}px "Public Sans", system-ui, sans-serif`;
  const w = Math.ceil(probe.measureText(text).width) + px;
  const h = Math.round(px * 1.6);
  const tex = canvasTexture(w, h, (ctx) => {
    ctx.font = `${peso} ${px}px "Public Sans", system-ui, sans-serif`;
    if (fundo) {
      ctx.fillStyle = fundo;
      ctx.beginPath();
      ctx.roundRect(2, 2, w - 4, h - 4, h / 2);
      ctx.fill();
      if (borda) {
        ctx.strokeStyle = borda;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }
    ctx.fillStyle = cor;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px / 2, h / 2 + 2);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((altura * w) / h, altura, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Marcador em gota (como num mapa), apontando para baixo. */
function pin(color) {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.4 });
  const head = mesh(new THREE.SphereGeometry(0.75, 24, 16), m);
  head.position.y = 1.55;
  const tip = mesh(new THREE.ConeGeometry(0.62, 1.3, 24), m);
  tip.rotation.x = Math.PI;
  tip.position.y = 0.75;
  const dot = mesh(new THREE.SphereGeometry(0.3, 16, 12), mat('#ffffff'), { sombra: false });
  dot.position.set(0, 1.6, 0.55);
  g.add(head, tip, dot);
  g.scale.setScalar(1.4);
  g.userData.base = 0;
  return g;
}

/** Empilhadeira estilizada: chassi na cor do tipo, rodas, contrapeso, grade de proteção, torre e garfos (-Z). */
function forkliftModel(color) {
  const g = new THREE.Group();
  const corpo = mat(color, { roughness: 0.5 });
  const escuro = mat('#2b3236');
  const chassi = roundedBox(1.3, 0.8, 2.1, 0.18, corpo);
  chassi.position.y = 0.75;
  const contrapeso = box(1.3, 0.7, 0.5, escuro);
  contrapeso.position.set(0, 0.85, 1.05);
  const banco = box(0.6, 0.35, 0.55, '#3a4246');
  banco.position.set(0, 1.35, 0.35);
  const teto = box(1.25, 0.08, 1.4, escuro);
  teto.position.set(0, 2.45, 0.05);
  g.add(chassi, contrapeso, banco, teto);
  for (const [x, z] of [[-0.55, -0.6], [0.55, -0.6], [-0.55, 0.7], [0.55, 0.7]]) {
    const post = box(0.07, 1.3, 0.07, escuro);
    post.position.set(x, 1.8, z);
    g.add(post);
  }
  for (const [x, z, r] of [[-0.62, -0.55, 0.36], [0.62, -0.55, 0.36], [-0.62, 0.75, 0.3], [0.62, 0.75, 0.3]]) {
    const w = wheel(r, 0.28);
    w.position.set(x, r, z);
    g.add(w);
  }
  const mastro = new THREE.Group();
  for (const x of [-0.42, 0.42]) {
    const rail = box(0.12, 2.6, 0.14, escuro);
    rail.position.set(x, 1.4, -1.15);
    mastro.add(rail);
  }
  const barra = box(0.96, 0.1, 0.14, escuro);
  barra.position.set(0, 2.65, -1.15);
  mastro.add(barra);
  for (const x of [-0.28, 0.28]) {
    const garfo = box(0.12, 0.06, 1.2, '#1d2225');
    garfo.position.set(x, 0.18, -1.8);
    mastro.add(garfo);
  }
  // palete com caixas nos garfos (aparece quando a empilhadeira está carregada)
  const carga = new THREE.Group();
  const base = box(1.1, 0.14, 1.1, C.madeira);
  base.position.y = 0.3;
  const caixas = box(1.0, 0.9, 1.0, C.papelao);
  caixas.position.y = 0.82;
  carga.add(base, caixas);
  carga.position.z = -1.85;
  carga.visible = false;
  g.add(mastro, carga);
  g.userData.body = chassi;
  g.userData.carga = carga;
  return g;
}

let logoTex = null;
function marcaFrotaLogIA() {
  logoTex ??= canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = C.parede;
    ctx.beginPath();
    ctx.roundRect(40, 58, 140, 140, 28);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 96px "Public Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('F', 82, 130);
    ctx.fillStyle = '#1f3f8f';
    ctx.font = '700 120px "Bricolage Grotesque", "Public Sans", system-ui, sans-serif';
    ctx.fillText('FrotaLogIA', 210, 132);
  });
  return logoTex;
}

/** Caminhão ou van de ré na doca: baú arredondado encostado na porta (-Z) e cabine para fora (+Z). */
function vehicleModel(tipo, color) {
  const g = new THREE.Group();
  const grande = tipo === 'caminhao';
  const L = grande ? 8 : 3.6;
  const H = grande ? 3.1 : 2.3;
  const W = 2.5;
  const bau = roundedBox(W, H, L, 0.25, mat('#fbfbfd', { roughness: 0.6 }));
  bau.position.set(0, H / 2 + 0.75, L / 2);
  // marca nas laterais do baú
  for (const lado of [-1, 1]) {
    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(L * 0.7, (L * 0.7) / 4),
      new THREE.MeshStandardMaterial({ map: marcaFrotaLogIA(), roughness: 0.7 }),
    );
    logo.position.set(lado * (W / 2 + 0.13), H / 2 + 0.85, L / 2);
    logo.rotation.y = (lado * Math.PI) / 2;
    g.add(logo);
  }
  const cabine = roundedBox(2.4, grande ? 2.4 : 1.8, 2.0, 0.3, mat(color, { roughness: 0.45 }));
  cabine.position.set(0, (grande ? 2.4 : 1.8) / 2 + 0.55, L + 1.2);
  const vidro = box(2.1, 0.8, 0.05, mat('#1c2b3a', { roughness: 0.2, metalness: 0.3 }));
  vidro.position.set(0, (grande ? 2.4 : 1.8) + 0.25, L + 2.25);
  g.add(bau, cabine, vidro);
  const eixos = grande ? [1.2, 2.4, L - 0.5, L + 1.4] : [0.8, L + 1.4];
  for (const z of eixos) {
    for (const x of [-1.15, 1.15]) {
      const w = wheel(0.5, 0.4);
      w.position.set(x, 0.5, z);
      g.add(w);
    }
  }
  g.userData.body = cabine;
  return g;
}

function tree(scale = 1) {
  const g = new THREE.Group();
  const tronco = mesh(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 8), mat('#8a6a4a'));
  tronco.position.y = 0.7;
  const copa = mesh(new THREE.ConeGeometry(1.3, 3.2, 10), mat('#6fb38a', { roughness: 0.9 }));
  copa.position.y = 2.9;
  const copa2 = mesh(new THREE.ConeGeometry(1.0, 2.2, 10), mat('#7cc296', { roughness: 0.9 }));
  copa2.position.y = 4.1;
  g.add(tronco, copa, copa2);
  g.scale.setScalar(scale);
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
    this.assets = new Map(); // id → { group, tag, ring, pin, kind, tipo, status }
    this.walls = []; // { mesh, normal: Vector3 }
    this.doors = []; // { panel, porta }
    this.lintels = []; // parede acima das portas de doca (some com a parede sul em corte)
    this.pins = [];
    this.az = Math.PI / 4; // isométrica: 45° de azimute
    this.el = Math.atan(1 / Math.SQRT2); // ~35,26° de elevação
    this.zoom = ZOOM_INICIAL;
    this.target = null;
  }

  async init() {
    THREE = await import('/vendor/three/three.module.js');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0); // o fundo em degradê vem do CSS
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.wrap.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Vista 3D do centro de distribuição');

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.target = new THREE.Vector3(0, 0, 4);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c3cfe0', 1.5));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-50, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.staticGroup = new THREE.Group();
    this.palletGroup = new THREE.Group();
    this.assetGroup = new THREE.Group();
    this.pinGroup = new THREE.Group();
    this.scene.add(this.staticGroup, this.palletGroup, this.assetGroup, this.pinGroup);
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();

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
    this.#cutaway();
  }

  /** Paredes viradas para a câmera ficam baixas (corte), para o interior aparecer de qualquer ângulo. */
  #cutaway() {
    const olhar = new THREE.Vector3(Math.sin(this.az), 0, Math.cos(this.az));
    let sulAberto = false;
    for (const w of this.walls) {
      const corte = w.normal.dot(olhar) > 0.15;
      const h = corte ? WALL_LOW : WALL_H;
      w.mesh.scale.y = h;
      w.mesh.position.y = h / 2;
      w.cap.position.y = h + 0.1;
      if (w.sul) sulAberto = corte;
    }
    for (const d of this.doors) d.panel.visible = !sulAberto;
    for (const l of this.lintels) l.visible = !sulAberto;
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
    const tamanho = s ? Math.max(s.largura, s.altura + 16) * 0.62 : 50;
    const aspect = w / h;
    const half = aspect >= 1 ? tamanho : tamanho / aspect;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.#updateCamera();
  }

  // ---------- Cena fixa: terreno, prédio, docas, prateleiras ----------

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
        if (o.material) {
          [].concat(o.material).forEach((m) => {
            if (m.map && m.map !== logoTex) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
  }

  #plane(w, d, color, x, z, y = 0) {
    const m = mesh(new THREE.PlaneGeometry(w, d), mat(color, { roughness: 0.95 }), { sombra: false, recebe: true });
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    return m;
  }

  #buildStatic() {
    const s = this.space;
    this.#clear(this.staticGroup);
    this.walls = [];
    this.doors = [];
    this.lintels = [];
    this.hitBoxes = [];
    const G = this.staticGroup;
    const L = s.largura;
    const A = s.altura;

    // sombra cobre o prédio e o pátio
    const sc = this.sun.shadow.camera;
    const r = Math.max(L, A) * 0.8 + 20;
    Object.assign(sc, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 300 });
    sc.updateProjectionMatrix();

    // terreno, pátio de manobra (sul) e rua
    G.add(this.#plane(L + 120, A + 120, C.terreno, 0, 10, -0.05));
    const patioD = 24;
    G.add(this.#plane(L + 16, patioD, C.asfalto, 0, A / 2 + patioD / 2, -0.03));
    G.add(this.#plane(L + 120, 9, '#c3ccd8', 0, A / 2 + patioD + 6, -0.04));
    for (let x = -L / 2 - 50; x < L / 2 + 50; x += 6) {
      G.add(this.#plane(3, 0.25, C.faixa, x, A / 2 + patioD + 6, -0.02));
    }

    // piso e zonas
    G.add(this.#plane(L, A, C.piso, 0, 0, 0));
    for (const z of s.zonas ?? []) {
      const c = this.#toWorld(z.x + z.w / 2, z.y + z.h / 2);
      G.add(this.#plane(z.w, z.h, ZONE_COLOR[z.tipo] ?? C.piso, c.x, c.z, 0.01));
    }
    // corredores pintados (faixa amarela nas bordas da expedição)
    const exp = (s.zonas ?? []).find((z) => z.tipo === 'expedicao');
    if (exp) {
      for (const y of [exp.y, exp.y + exp.h]) {
        const c = this.#toWorld(L / 2, y);
        G.add(this.#plane(L - 1, 0.18, '#f2c94c', c.x, c.z, 0.02));
      }
    }

    // paredes (em corte conforme a câmera), com acabamento no topo e portas de enrolar nas docas
    const paredeMat = mat(C.parede, { roughness: 0.55 });
    const topoMat = mat(C.paredeTopo, { roughness: 0.5 });
    const wall = (x1, y1, x2, y2, normal, sul = false) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.01) return;
      const m = mesh(new THREE.BoxGeometry(len, 1, 0.4), paredeMat, { recebe: true });
      const cap = mesh(new THREE.BoxGeometry(len + 0.1, 0.2, 0.6), topoMat);
      const a = this.#toWorld((x1 + x2) / 2, (y1 + y2) / 2);
      const rot = Math.atan2(y2 - y1, x2 - x1);
      m.position.set(a.x, WALL_H / 2, a.z);
      cap.position.set(a.x, WALL_H + 0.1, a.z);
      m.rotation.y = rot;
      cap.rotation.y = rot;
      G.add(m, cap);
      this.walls.push({ mesh: m, cap, normal: new THREE.Vector3(...normal), sul });
    };
    wall(0, A, L, A, [0, 0, -1]);
    wall(0, 0, 0, A, [-1, 0, 0]);
    wall(L, 0, L, A, [1, 0, 0]);
    const portas = [...(s.portas ?? [])].sort((a, b) => a.x - b.x);
    let x = 0;
    const portaTex = canvasTexture(64, 256, (ctx, w, h) => {
      ctx.fillStyle = C.porta;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#b9c2cf';
      ctx.lineWidth = 3;
      for (let y = 8; y < h; y += 16) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    });
    for (const p of portas) {
      wall(x, 0, p.x, 0, [0, 0, 1], true);
      x = p.x + p.w;
      const c = this.#toWorld(p.x + p.w / 2, 0);
      // lintel acima da porta
      const lintel = box(p.w, WALL_H - 4.2, 0.4, paredeMat);
      lintel.position.set(c.x, 4.2 + (WALL_H - 4.2) / 2, c.z);
      this.lintels.push(lintel);
      const panel = mesh(new THREE.PlaneGeometry(p.w - 0.3, 4.2), new THREE.MeshStandardMaterial({ map: portaTex, roughness: 0.6 }));
      panel.position.set(c.x, 2.1, c.z + 0.05);
      G.add(lintel, panel);
      this.doors.push({ panel, porta: p });
      // vaga pintada e número da doca no pátio
      for (const dx of [-p.w / 2, p.w / 2]) {
        const linha = this.#plane(0.2, 14, C.faixa, c.x + dx, A / 2 + 7.5, -0.02);
        G.add(linha);
      }
      const n = label(p.nome, { altura: 1.4, fundo: C.parede, cor: '#ffffff', peso: 700 });
      n.position.set(c.x, 5.2, c.z + 0.6);
      G.add(n);
    }
    wall(x, 0, L, 0, [0, 0, 1], true);

    // nome do CD numa placa sobre a parede norte
    const placa = label(s.nome ?? 'CD', { altura: 2.6, fundo: '#ffffff', cor: C.paredeTopo, peso: 700, borda: C.parede });
    const pc = this.#toWorld(L / 2, A);
    placa.position.set(pc.x, WALL_H + 2.2, pc.z);
    G.add(placa);

    // árvores nos cantos do terreno
    for (const [tx, tz, sc2] of [
      [-L / 2 - 8, -A / 2 - 6, 1.2], [-L / 2 - 12, -A / 2 + 6, 0.9], [L / 2 + 9, -A / 2 - 4, 1.1],
      [L / 2 + 12, A / 2 - 8, 1.0], [-L / 2 - 10, A / 2 - 4, 1.0], [L / 2 + 7, -A / 2 + 10, 0.8],
    ]) {
      const t = tree(sc2);
      t.position.set(tx, 0, tz);
      G.add(t);
    }

    // prateleiras: montantes, longarinas e caixas de clique (uma por posição)
    const steel = mat(C.aco, { roughness: 0.5, metalness: 0.3 });
    const beamMat = mat(C.longarina, { roughness: 0.5 });
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const rack of s.prateleiras ?? []) {
      const altura = rack.niveis * LEVEL_H + 0.3;
      const horizontal = rack.w >= rack.h;
      const comp = horizontal ? rack.w : rack.h;
      const prof = horizontal ? rack.h : rack.w;
      for (let i = 0; i <= rack.posicoes; i++) {
        for (const lado of [0, 1]) {
          const along = (i / rack.posicoes) * comp;
          const across = lado * prof;
          const w = this.#toWorld(horizontal ? rack.x + along : rack.x + across, horizontal ? rack.y + across : rack.y + along);
          const up = box(0.12, altura, 0.12, steel);
          up.position.set(w.x, altura / 2, w.z);
          G.add(up);
        }
      }
      for (let n = 1; n <= rack.niveis; n++) {
        for (const lado of [0, 1]) {
          const geo = horizontal ? new THREE.BoxGeometry(comp, 0.12, 0.1) : new THREE.BoxGeometry(0.1, 0.12, comp);
          const beam = mesh(geo, beamMat);
          const c = horizontal
            ? this.#toWorld(rack.x + comp / 2, rack.y + lado * prof)
            : this.#toWorld(rack.x + lado * prof, rack.y + comp / 2);
          beam.position.set(c.x, (n - 1) * LEVEL_H + 0.15, c.z);
          G.add(beam);
        }
      }
      const l = label(`Rua ${rack.id}`, { altura: 1.5 });
      const lp = horizontal ? this.#toWorld(rack.x - 3, rack.y + rack.h / 2) : this.#toWorld(rack.x + rack.w / 2, rack.y - 3);
      l.position.set(lp.x, altura + 0.6, lp.z);
      G.add(l);
      for (const c of IndoorView.cells(rack)) {
        const hit = new THREE.Mesh(new THREE.BoxGeometry(c.w, altura, c.h), hitMat);
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        hit.position.set(w.x, altura / 2, w.z);
        hit.userData.slot = { rua: rack.id, posicao: c.posicao };
        G.add(hit);
        this.hitBoxes.push(hit);
      }
    }
    this.#cutaway();
    this.#buildPallets();
  }

  // ---------- Paletes (caixas de papelão com a faixa da família) ----------

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
    this.#clear(this.pinGroup);
    this.pins = [];
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
      const N = slots.length;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const base = new THREE.InstancedMesh(geo, mat(C.madeira), N);
      const caixa = new THREE.InstancedMesh(geo, mat('#ffffff', { roughness: 0.85 }), N);
      const faixa = new THREE.InstancedMesh(geo, mat('#ffffff', { roughness: 0.6 }), N);
      // etiqueta no topo: é o que aparece na vista isométrica, então leva a cor da família
      const etiqueta = new THREE.InstancedMesh(geo, mat('#ffffff', { roughness: 0.5 }), N);
      for (const im of [base, caixa, faixa, etiqueta]) {
        im.castShadow = true;
        im.receiveShadow = true;
      }
      const m = new THREE.Matrix4();
      const color = new THREE.Color();
      slots.forEach(({ c, n, item }, i) => {
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        const sx = c.w * 0.8;
        const sz = c.h * 0.8;
        const y0 = (n - 1) * LEVEL_H + 0.21;
        m.makeScale(sx, 0.14, sz).setPosition(w.x, y0 + 0.07, w.z);
        base.setMatrixAt(i, m);
        m.makeScale(sx * 0.94, 1.15, sz * 0.94).setPosition(w.x, y0 + 0.14 + 0.575, w.z);
        caixa.setMatrixAt(i, m);
        m.makeScale(sx * 0.95, 0.22, sz * 0.95).setPosition(w.x, y0 + 0.14 + 0.62, w.z);
        faixa.setMatrixAt(i, m);
        m.makeScale(sx * 0.62, 0.05, sz * 0.62).setPosition(w.x, y0 + 0.14 + 1.15 + 0.02, w.z);
        etiqueta.setMatrixAt(i, m);
        const achado = destaque?.has(item.endereco);
        color.set(destaque && !achado ? C.apagado : C.papelao);
        caixa.setColorAt(i, color);
        color.set(destaque ? (achado ? C.destaque : C.apagado) : familiaDe(item.sku).cor);
        faixa.setColorAt(i, color);
        etiqueta.setColorAt(i, color);
      });
      caixa.userData.slots = slots.map(({ r, c }) => ({ rua: r.id, posicao: c.posicao }));
      faixa.userData.slots = caixa.userData.slots;
      etiqueta.userData.slots = caixa.userData.slots;
      this.palletGroup.add(base, caixa, faixa, etiqueta);
      this.pallets = [etiqueta, caixa, faixa];
    } else {
      this.pallets = [];
    }

    // marcadores: um por posição encontrada na busca (no topo da prateleira)
    if (destaque?.size) {
      const vistos = new Set();
      for (const end of destaque) {
        const e = parseEndereco(end);
        const key = e && `${e.rua}-${e.posicao}`;
        if (!e || vistos.has(key)) continue;
        vistos.add(key);
        const r = s.prateleiras.find((p) => p.id === e.rua);
        const c = r && IndoorView.cells(r)[e.posicao - 1];
        if (c) this.#addPin(C.pin, c, r);
      }
    }

    // posição selecionada: contorno e marcador verde
    if (selecionada) {
      const r = s.prateleiras.find((p) => p.id === selecionada.rua);
      const c = r && IndoorView.cells(r)[selecionada.posicao - 1];
      if (c) {
        const altura = r.niveis * LEVEL_H + 0.4;
        const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(c.w + 0.3, altura, c.h + 0.3));
        const edges = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: C.selecao }));
        const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
        edges.position.set(w.x, altura / 2, w.z);
        const glow = new THREE.Mesh(
          new THREE.BoxGeometry(c.w + 0.3, altura, c.h + 0.3),
          new THREE.MeshBasicMaterial({ color: C.selecao, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        glow.position.copy(edges.position);
        this.palletGroup.add(edges, glow);
        this.#addPin(C.selecao, c, r);
      }
    }
  }

  #addPin(color, c, r) {
    const p = pin(color);
    const w = this.#toWorld(c.x + c.w / 2, c.y + c.h / 2);
    p.userData.base = r.niveis * LEVEL_H + 0.6;
    p.position.set(w.x, p.userData.base, w.z);
    p.userData.fase = Math.random() * Math.PI * 2;
    this.pinGroup.add(p);
    this.pins.push(p);
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
      const tag = label(nome, { altura: kind === 'doca' ? 1.4 : 1.05 });
      tag.position.y = kind === 'doca' ? 5.4 : 3.4;
      if (kind === 'doca') tag.position.z = 5;
      group.add(tag);
      const ring = mesh(
        new THREE.RingGeometry(1.7, 2.2, 40),
        new THREE.MeshBasicMaterial({ color: C.selecao, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
        { sombra: false },
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      const marcador = pin(C.selecao);
      marcador.userData.base = kind === 'doca' ? 6.2 : 4.2;
      marcador.position.y = marcador.userData.base;
      if (kind === 'doca') marcador.position.z = 5;
      group.add(ring, marcador);
      a = { group, tag, ring, marcador, kind, tipo, status: null };
      this.assets.set(id, a);
      this.assetGroup.add(group);
    }
    if (a.status !== status) {
      a.group.userData.body.material.color.set(cor);
      a.status = status;
    }
    const sel = id === this.selectedId;
    a.ring.visible = sel;
    a.marcador.visible = sel;
    a.tag.visible = !sel;
    return a;
  }

  /**
   * items: ativos dentro da planta { id, nome, tipo, status, x, y, rumo, carregado } (já interpolados);
   * docked: veículos no pátio do CD { id, nome, tipo, status, viagemStatus }.
   */
  render(items, docked = []) {
    if (!this.ready || !this.space) return;
    const t = this.clock.getElapsedTime();
    const vivos = new Set();
    for (const it of items) {
      const a = this.#asset(it.id, it.tipo, it.status, it.nome, 'planta');
      const w = this.#toWorld(it.x, it.y);
      a.group.position.set(w.x, 0, w.z);
      a.group.rotation.y = (-it.rumo * Math.PI) / 180;
      a.group.userData.carga.visible = Boolean(it.carregado);
      vivos.add(it.id);
    }
    const portas = [...(this.space.portas ?? [])].sort((p, q) => p.x - q.x);
    const ocupadas = new Set();
    [...docked].sort((p, q) => p.id.localeCompare(q.id)).slice(0, portas.length).forEach((it, i) => {
      const p = portas[i];
      const a = this.#asset(it.id, it.tipo, it.status, it.nome, 'doca');
      const w = this.#toWorld(p.x + p.w / 2, -0.3);
      a.group.position.set(w.x, 0, w.z);
      a.group.rotation.y = 0;
      ocupadas.add(p);
      vivos.add(it.id);
    });
    for (const [id, a] of this.assets) {
      if (!vivos.has(id)) {
        this.assetGroup.remove(a.group);
        this.assets.delete(id);
      }
    }
    // porta de enrolar aberta onde há veículo encostado
    for (const d of this.doors) {
      const aberta = ocupadas.has(d.porta);
      d.panel.scale.y = aberta ? 0.15 : 1;
      d.panel.position.y = aberta ? 4.2 - 0.32 : 2.1;
    }
    // marcadores flutuam
    for (const p of this.pins) p.position.y = p.userData.base + Math.sin(t * 2.2 + p.userData.fase) * 0.25;
    for (const a of this.assets.values()) {
      if (a.marcador.visible) a.marcador.position.y = a.marcador.userData.base + Math.sin(t * 2.2) * 0.25;
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
    for (const im of this.pallets ?? []) {
      const hit = this.raycaster.intersectObject(im)[0];
      if (hit) return this.handlers.onSelectSlot(im.userData.slots[hit.instanceId]);
    }
    const slot = this.raycaster.intersectObjects(this.hitBoxes ?? [])[0];
    if (slot) return this.handlers.onSelectSlot(slot.object.userData.slot);
    this.handlers.onSelect(null);
  }
}
