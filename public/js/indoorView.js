// Visualização de planta interna em <canvas>. Coordenadas em metros; y cresce para cima.
import { drawGlyph } from './icons.js';

const ZONE_FILL = {
  doca: '#e3ece6',
  expedicao: '#fbf1d9',
  estoque: '#f3f4f0',
  picking: '#e4edf6',
};
const PAD = 28;

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
    this.insets = { top: 0, bottom: 0 }; // áreas cobertas por painéis flutuantes

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

  /** Reserva faixas (px) no topo/rodapé para que painéis flutuantes não cubram a planta. */
  setInsets(top, bottom) {
    const next = { top: Math.round(top), bottom: Math.round(bottom) };
    if (next.top === this.insets.top && next.bottom === this.insets.bottom) return;
    this.insets = next;
    this.#computeLayout();
  }

  #computeLayout() {
    if (!this.space || !this.cssW) return;
    const { largura, altura } = this.space;
    const fit = (availH) => Math.min((this.cssW - PAD * 2) / largura, (availH - PAD * 2) / altura);

    // Painéis flutuantes reduzem a área útil, mas a planta nunca encolhe abaixo de 60% do
    // tamanho original (em telas pequenas é melhor deixar o painel cobrir um canto).
    const natural = fit(this.cssH);
    const scale = Math.max(0.5, natural * 0.6, fit(this.cssH - this.insets.top - this.insets.bottom));
    const usableH = this.cssH - this.insets.top - this.insets.bottom;
    const usedH = altura * scale;
    const oy =
      usedH + PAD * 2 <= usableH
        ? this.insets.top + (usableH - usedH) / 2 // cabe na área livre: centraliza nela
        : (this.cssH - usedH) / 2; // não cabe: centraliza no palco inteiro
    this.layout = { scale, ox: (this.cssW - largura * scale) / 2, oy };
  }

  #sx(x) {
    return this.layout.ox + x * this.layout.scale;
  }

  #sy(y) {
    return this.layout.oy + (this.space.altura - y) * this.layout.scale;
  }

  /** items: [{ id, nome, tipo, status, x, y, rumo }] */
  render(items) {
    const { ctx, space } = this;
    if (!space || !this.cssW) return;
    this.lastItems = items;
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
      ctx.fillText(z.nome, this.#sx(z.x) + 8, this.#sy(z.y + z.h) + 6);
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

    // prateleiras
    for (const r of space.prateleiras) {
      ctx.fillStyle = '#c9cfc6';
      ctx.fillRect(this.#sx(r.x), this.#sy(r.y + r.h), r.w * scale, r.h * scale);
      ctx.strokeStyle = '#aab2a8';
      ctx.strokeRect(this.#sx(r.x), this.#sy(r.y + r.h), r.w * scale, r.h * scale);
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

    // barra de escala (10 m)
    const barX = this.#sx(0);
    const barY = this.#sy(0) + 14;
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
  }

  #onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestDist = 22;
    for (const a of this.lastItems) {
      const d = Math.hypot(this.#sx(a.x) - mx, this.#sy(a.y) - my);
      if (d < bestDist) {
        best = a;
        bestDist = d;
      }
    }
    this.handlers.onSelect(best ? best.id : null);
  }
}
