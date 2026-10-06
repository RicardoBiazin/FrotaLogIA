// Visualização da planta de um CD em <canvas>. Coordenadas em metros; y cresce para cima.
// Veículos no pátio do CD aparecem encostados nas docas (lado sul, y < 0), na ordem do id;
// os que não cabem nas docas aparecem como "aguardando doca" numa linha de texto.
// Prateleiras: cada posição é uma célula colorida pelos níveis ocupados; clicar abre os níveis.
import { drawGlyph } from './icons.js';
import { posicaoKey } from './estoque.js';

const ZONE_FILL = {
  doca: '#e3ece6',
  expedicao: '#fbf1d9',
  estoque: '#f3f4f0',
  picking: '#e4edf6',
};
const PAD = 28;
const PAD_BOTTOM = 112; // espaço do pátio, abaixo das docas
const DOCK_Y = -4; // metros: logo fora da parede, em frente à porta
// Cor da posição pela fração de níveis ocupados (vazio → cheio).
const OCUPACAO_FILL = ['#eceee8', '#cdd8e1', '#a5b9ca', '#7a95ae', '#4f6d8a'];
const DESTAQUE_FILL = '#f2b705';
const VIAGEM_CURTA = { carregando: 'carregando', descarregando: 'descarregando', em_transito: 'saindo', planejada: 'aguardando' };
export class IndoorView {
  constructor(wrap, canvas, handlers) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;
    this.space = null;
    this.trail = [];
    this.selectedId = null;
    this.lastItems = [];
    this.layout = { scale: 1, ox: 0, oy: 0 };
    this.insets = { top: 0, bottom: 0, right: 0 }; // áreas cobertas por painéis flutuantes
    // Estoque da planta: Map "A-03" → níveis ocupados, posições em destaque (busca) e a selecionada.
    this.estoque = { ocupacao: new Map(), destaque: new Set(), selecionada: null };

    new ResizeObserver(() => this.resize()).observe(wrap);
    canvas.addEventListener('click', (e) => this.#onClick(e));
  }

  setSpace(space) {
    this.space = space;
    this.resize();
  }

  setSelected(id) {
    this.selectedId = id;
  }

  setEstoque(ocupacao, destaque = new Set(), selecionada = null) {
    this.estoque = { ocupacao, destaque, selecionada };
  }

  /** Células (posições) de uma prateleira, em metros, ao longo do lado maior. */
  static cells(r) {
    const horizontal = r.w >= r.h;
    const passo = (horizontal ? r.w : r.h) / r.posicoes;
    return Array.from({ length: r.posicoes }, (_, i) => ({
      posicao: i + 1,
      x: horizontal ? r.x + i * passo : r.x,
      y: horizontal ? r.y : r.y + i * passo,
      w: horizontal ? passo : r.w,
      h: horizontal ? r.h : passo,
    }));
  }

  /** points: [[x, y, ts], ...] */
  setTrail(points) {
    this.trail = points;
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.wrap;
    if (w === 0 || h === 0) return; // oculto
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
    this.#computeLayout();
  }

  /** Reserva faixas (px) no topo, rodapé ou à direita para que painéis flutuantes não cubram a planta. */
  setInsets(top, bottom, right = 0) {
    const next = { top: Math.round(top), bottom: Math.round(bottom), right: Math.round(right) };
    if (next.top === this.insets.top && next.bottom === this.insets.bottom && next.right === this.insets.right) return;
    this.insets = next;
    this.#computeLayout();
  }

  #computeLayout() {
    if (!this.space || !this.cssW) return;
    const { largura, altura } = this.space;
    const usableW = this.cssW - this.insets.right;
    const fit = (availH) => Math.min((usableW - PAD * 2) / largura, (availH - PAD - PAD_BOTTOM) / altura);

    // Painéis flutuantes reduzem a área útil, mas a planta nunca encolhe abaixo de 60% do
    // tamanho original (em telas pequenas é melhor deixar o painel cobrir um canto).
    const natural = fit(this.cssH);
    const scale = Math.max(0.5, natural * 0.6, fit(this.cssH - this.insets.top - this.insets.bottom));
    const usableH = this.cssH - this.insets.top - this.insets.bottom;
    const usedH = altura * scale;
    const oy =
      usedH + PAD + PAD_BOTTOM <= usableH
        ? this.insets.top + (usableH - usedH - PAD_BOTTOM + PAD) / 2 // cabe na área livre: centraliza nela
        : (this.cssH - usedH - PAD_BOTTOM + PAD) / 2; // não cabe: centraliza no palco inteiro
    this.layout = { scale, ox: (usableW - largura * scale) / 2, oy };
  }

  #sx(x) {
    return this.layout.ox + x * this.layout.scale;
  }

  #sy(y) {
    return this.layout.oy + (this.space.altura - y) * this.layout.scale;
  }

  /** Veículos do pátio nas docas (na ordem do id) e os que sobram, aguardando doca. */
  #dockSlots(docked) {
    const portas = this.space.portas ?? [];
    const sorted = [...docked].sort((a, b) => a.id.localeCompare(b.id));
    const slots = sorted.slice(0, portas.length).map((a, i) => {
      const p = portas[i];
      return { ...a, px: this.#sx(p.x + p.w / 2), py: this.#sy(DOCK_Y), rumo: 180 };
    });
    return { slots, fila: sorted.slice(portas.length) };
  }

  /**
   * items: [{ id, nome, tipo, status, x, y, rumo }] (dentro da planta)
   * docked: [{ id, nome, tipo, status, viagemStatus }] (no pátio do CD)
   */
  render(items, docked = []) {
    const { ctx, space } = this;
    if (!space || !this.cssW) return;
    const { slots, fila } = this.#dockSlots(docked);
    this.lastItems = [
      ...items.map((a) => ({ id: a.id, px: this.#sx(a.x), py: this.#sy(a.y) })),
      ...slots.map((a) => ({ id: a.id, px: a.px, py: a.py })),
    ];
    const { scale } = this.layout;
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // piso
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.#sx(0), this.#sy(space.altura), space.largura * scale, space.altura * scale);

    // zonas
    ctx.font = '600 11px "Public Sans", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const z of space.zonas) {
      ctx.fillStyle = ZONE_FILL[z.tipo] ?? '#f3f4f0';
      ctx.fillRect(this.#sx(z.x), this.#sy(z.y + z.h), z.w * scale, z.h * scale);
      ctx.fillStyle = 'rgba(24, 40, 44, 0.55)';
      // Canto inferior direito: à esquerda ficam as letras das ruas e no topo as pontas das prateleiras.
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(z.nome, this.#sx(z.x + z.w) - 8, this.#sy(z.y) - 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    // grade de 10 m
    ctx.strokeStyle = 'rgba(24, 40, 44, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 10; x < space.largura; x += 10) {
      ctx.moveTo(this.#sx(x), this.#sy(0));
      ctx.lineTo(this.#sx(x), this.#sy(space.altura));
    }
    for (let y = 10; y < space.altura; y += 10) {
      ctx.moveTo(this.#sx(0), this.#sy(y));
      ctx.lineTo(this.#sx(space.largura), this.#sy(y));
    }
    ctx.stroke();

    // prateleiras: uma célula por posição, cor pela ocupação dos níveis
    const { ocupacao, destaque, selecionada } = this.estoque;
    ctx.font = '700 12px "Public Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const r of space.prateleiras) {
      for (const c of IndoorView.cells(r)) {
        const key = posicaoKey(r.id, c.posicao);
        const ocupados = Math.min(r.niveis, ocupacao.get(key) ?? 0);
        const idx = Math.round((ocupados / r.niveis) * (OCUPACAO_FILL.length - 1));
        const px = this.#sx(c.x);
        const py = this.#sy(c.y + c.h);
        ctx.fillStyle = destaque.has(key) ? DESTAQUE_FILL : OCUPACAO_FILL[idx];
        ctx.fillRect(px, py, c.w * scale, c.h * scale);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, c.w * scale - 1, c.h * scale - 1);
      }
      ctx.strokeStyle = '#8796a3';
      ctx.lineWidth = 1;
      ctx.strokeRect(this.#sx(r.x), this.#sy(r.y + r.h), r.w * scale, r.h * scale);
      ctx.fillStyle = '#18282c';
      ctx.textAlign = 'right';
      ctx.fillText(r.id, this.#sx(r.x) - 6, this.#sy(r.y + r.h / 2));
      ctx.textAlign = 'left';
    }
    if (selecionada) {
      const r = space.prateleiras.find((p) => p.id === selecionada.rua);
      const c = r && IndoorView.cells(r)[selecionada.posicao - 1];
      if (c) {
        ctx.strokeStyle = '#0a6b4b';
        ctx.lineWidth = 3;
        ctx.strokeRect(this.#sx(c.x) - 1, this.#sy(c.y + c.h) - 1, c.w * scale + 2, c.h * scale + 2);
      }
    }

    // paredes e portas das docas
    ctx.strokeStyle = '#18282c';
    ctx.lineWidth = 3;
    ctx.strokeRect(this.#sx(0), this.#sy(space.altura), space.largura * scale, space.altura * scale);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 10px "Public Sans", system-ui, sans-serif';
    for (const p of space.portas ?? []) {
      ctx.fillRect(this.#sx(p.x), this.#sy(0) - 2, p.w * scale, 5);
      ctx.fillStyle = 'rgba(24, 40, 44, 0.7)';
      ctx.fillText(p.nome, this.#sx(p.x) + 4, this.#sy(0) - 16);
      ctx.fillStyle = '#ffffff';
    }

    // barra de escala (10 m), acima da planta
    const barX = this.#sx(0);
    const barY = this.#sy(space.altura) - 12;
    ctx.strokeStyle = '#18282c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + 10 * scale, barY);
    ctx.moveTo(barX, barY - 4);
    ctx.lineTo(barX, barY + 4);
    ctx.moveTo(barX + 10 * scale, barY - 4);
    ctx.lineTo(barX + 10 * scale, barY + 4);
    ctx.stroke();
    ctx.fillStyle = '#18282c';
    ctx.textBaseline = 'middle';
    ctx.fillText('10 m', barX + 10 * scale + 8, barY);

    // legenda da ocupação, à direita da escala
    ctx.font = '500 11px "Public Sans", system-ui, sans-serif';
    const box = 10;
    const legendaW = ctx.measureText('Níveis ocupados: vazio').width + 6 + OCUPACAO_FILL.length * (box + 3) + ctx.measureText('cheio').width + 2;
    const livre = this.#sx(space.largura) - (barX + 10 * scale + 50);
    if (space.prateleiras.length && legendaW <= livre) {
      const right = this.#sx(space.largura) - ctx.measureText('cheio').width - 2;
      let x = right - OCUPACAO_FILL.length * (box + 3);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#51646a';
      ctx.fillText('Níveis ocupados: vazio', x - 6, barY);
      ctx.textAlign = 'left';
      for (const color of OCUPACAO_FILL) {
        ctx.fillStyle = color;
        ctx.fillRect(x, barY - box / 2, box, box);
        x += box + 3;
      }
      ctx.fillStyle = '#51646a';
      ctx.fillText('cheio', x + 2, barY);
    }

    // rastro do ativo selecionado
    if (this.trail.length > 1) {
      ctx.strokeStyle = 'rgba(10, 107, 75, 0.7)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.trail.forEach(([x, y], i) => {
        const px = this.#sx(x);
        const py = this.#sy(y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // ativos
    ctx.textBaseline = 'middle';
    ctx.font = '600 12px "Public Sans", system-ui, sans-serif';
    for (const a of items) {
      const px = this.#sx(a.x);
      const py = this.#sy(a.y);
      if (a.id === this.selectedId) {
        ctx.beginPath();
        ctx.arc(px, py, 24, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 107, 75, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#0a6b4b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((a.rumo * Math.PI) / 180);
      drawGlyph(ctx, a.tipo, a.status, 1.15);
      ctx.restore();

      const fitsRight = px + 18 + ctx.measureText(a.nome).width < this.cssW - 8;
      ctx.textAlign = fitsRight ? 'left' : 'right';
      const lx = fitsRight ? px + 18 : px - 18;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeText(a.nome, lx, py);
      ctx.fillStyle = '#18282c';
      ctx.fillText(a.nome, lx, py);
      ctx.textAlign = 'left';
    }

    // pátio: veículos nas docas; os que sobram, numa linha de texto
    if (fila.length > 0) {
      ctx.font = '600 11.5px "Public Sans", system-ui, sans-serif';
      ctx.fillStyle = '#51646a';
      ctx.textBaseline = 'middle';
      const texto = `Aguardando doca: ${fila.map((a) => a.nome).join(', ')}`;
      ctx.fillText(texto, this.#sx(0), this.#sy(DOCK_Y) + 62, space.largura * scale);
    }
    ctx.textAlign = 'center';
    for (const a of slots) {
      if (a.id === this.selectedId) {
        ctx.beginPath();
        ctx.arc(a.px, a.py, 22, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 107, 75, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#0a6b4b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(a.px, a.py);
      ctx.rotate((a.rumo * Math.PI) / 180);
      drawGlyph(ctx, a.tipo, a.status === 'offline' ? 'offline' : 'movimento', 1.05);
      ctx.restore();
      const linhas = [a.nome, VIAGEM_CURTA[a.viagemStatus] ?? 'no pátio'];
      ctx.font = '600 11px "Public Sans", system-ui, sans-serif';
      linhas.forEach((t, i) => {
        const ly = a.py + 26 + i * 13;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.strokeText(t, a.px, ly);
        ctx.fillStyle = i === 0 ? '#18282c' : '#51646a';
        ctx.fillText(t, a.px, ly);
        ctx.font = '500 10.5px "Public Sans", system-ui, sans-serif';
      });
    }
    ctx.textAlign = 'left';
  }

  /** Posição de prateleira sob o ponto (px da tela), ou null. */
  #cellAt(mx, my) {
    if (!this.space) return null;
    const { scale } = this.layout;
    for (const r of this.space.prateleiras) {
      for (const c of IndoorView.cells(r)) {
        const px = this.#sx(c.x);
        const py = this.#sy(c.y + c.h);
        if (mx >= px && mx <= px + c.w * scale && my >= py && my <= py + c.h * scale) {
          return { rua: r.id, posicao: c.posicao };
        }
      }
    }
    return null;
  }

  #onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestDist = 22;
    for (const a of this.lastItems) {
      const d = Math.hypot(a.px - mx, a.py - my);
      if (d < bestDist) {
        best = a;
        bestDist = d;
      }
    }
    // Veículo bem em cima do clique ganha; senão a prateleira; senão o veículo mais perto.
    const cell = this.#cellAt(mx, my);
    if (best && (bestDist < 12 || !cell)) return this.handlers.onSelect(best.id);
    if (cell) return this.handlers.onSelectSlot?.(cell);
    this.handlers.onSelect(null);
  }
}
