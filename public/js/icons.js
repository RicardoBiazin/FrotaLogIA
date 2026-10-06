// Tipos, status e desenho dos ícones (mesma silhueta no mapa, na planta e na lista).

export const TIPOS = [
  { id: 'caminhao', label: 'Caminhão', plural: 'Caminhões', color: '#1d4f91' },
  { id: 'carro', label: 'Carro', plural: 'Carros', color: '#0f9fb0' },
  { id: 'empilhadeira', label: 'Empilhadeira', plural: 'Empilhadeiras', color: '#e2501b' },
  { id: 'outro', label: 'Outro', plural: 'Outros', color: '#7a4ec4' },
];
export const TIPO_BY_ID = Object.fromEntries(TIPOS.map((t) => [t.id, t]));
export const tipoOf = (id) => TIPO_BY_ID[id] ?? TIPO_BY_ID.outro;

export const STATUS = {
  movimento: { label: 'em movimento', color: '#1f9d62' },
  parado: { label: 'parado', color: '#e0a100' },
  offline: { label: 'sem sinal', color: '#9aa5a1' },
};
export const STATUS_IDS = Object.keys(STATUS);

// Silhuetas apontando para cima (norte), em unidades de ~±18.
const SHAPES = {
  caminhao: [[0, -18], [8, 14], [0, 9], [-8, 14]],
  carro: [[0, -14], [9, 12], [0, 6], [-9, 12]],
  empilhadeira: [[0, -15], [9, -4], [9, 11], [-9, 11], [-9, -4]],
  outro: [[0, -13], [10, 0], [0, 13], [-10, 0]],
};

/**
 * Desenha o ativo centrado em (0,0), apontando para cima. Quem chama translada e rota.
 *  - em movimento: silhueta preenchida (mostra a direção)
 *  - parado: ponto preenchido (sem direção, para não sugerir movimento)
 *  - sem sinal: silhueta vazada, cinza
 */
export function drawGlyph(ctx, tipo, status, scale = 1) {
  const color = tipoOf(tipo).color;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';

  if (status === 'parado') {
    ctx.shadowColor = 'rgba(20, 32, 36, 0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  } else {
    const points = SHAPES[tipo] ?? SHAPES.outro;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    if (status === 'offline') {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = STATUS.offline.color;
      ctx.stroke();
    } else {
      ctx.shadowColor = 'rgba(20, 32, 36, 0.35)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(20, 32, 36, 0.45)';
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** ImageData para registrar no MapLibre (map.addImage com pixelRatio = dpr). */
export function glyphImage(tipo, status, { size = 48, dpr = 2 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(size / 2, size / 2);
  drawGlyph(ctx, tipo, status, 1);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Silhueta em SVG para a lista lateral. */
export function glyphSvg(tipo, size = 20) {
  const color = tipoOf(tipo).color;
  const points = (SHAPES[tipo] ?? SHAPES.outro).map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg width="${size}" height="${size}" viewBox="-20 -20 40 40" aria-hidden="true"><polygon points="${points}" fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
