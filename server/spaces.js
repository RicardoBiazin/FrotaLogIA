// Plantas de ambientes internos (onde GPS não funciona), em metros.
// Origem no canto inferior esquerdo; x cresce para a direita (leste), y para cima (norte).
// Ativos com { espaco: "galpao-1", x, y } aparecem nesta planta.
//
// Substitua pelo layout real: depois dá para carregar de um JSON/banco ou de um
// arquivo CAD/GeoJSON convertido.

export const SPACES = [
  {
    id: 'galpao-1',
    nome: 'Galpão 1',
    largura: 90,
    altura: 56,
    zonas: [
      { nome: 'Docas', x: 0, y: 0, w: 90, h: 8, tipo: 'doca' },
      { nome: 'Expedição', x: 0, y: 8, w: 90, h: 7, tipo: 'expedicao' },
      { nome: 'Armazenagem', x: 0, y: 15, w: 90, h: 35, tipo: 'estoque' },
      { nome: 'Picking', x: 0, y: 50, w: 90, h: 6, tipo: 'picking' },
    ],
    portas: [8, 22, 36, 50, 64, 78].map((x, i) => ({ nome: `D${i + 1}`, x: x - 3, w: 6 })),
    prateleiras: [
      { x: 10, y: 46, w: 70, h: 3 },
      { x: 10, y: 38, w: 70, h: 3 },
      { x: 10, y: 30, w: 70, h: 3 },
      { x: 10, y: 22, w: 70, h: 3 },
    ],
  },
];
