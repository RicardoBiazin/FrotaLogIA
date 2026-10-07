// Gera a planta de um CD a partir das medidas do galpão (cadastro de CD pela tela).
// Código puro (sem DOM): o servidor usa para validar e gravar, a tela para a pré-visualização.
//
// Layout (metros; x → leste, y → norte, origem no canto sudoeste):
//   docas (8 m) no lado sul, com as portas · expedição (7 m) · armazenagem com as ruas de
//   prateleira na horizontal · picking (6 m) no fundo, lado norte.

export const GALPAO_LIMITES = {
  largura: [20, 500],
  comprimento: [30, 500],
  docas: [0, 40],
  ruas: [0, 26],
  niveis: [1, 10],
  posicoes: [1, 200],
};
export const GALPAO_PADRAO = { largura: 80, comprimento: 56, docas: 6, ruas: 4, niveis: 4, posicoes: null };

const DOCA_H = 8;
const EXPEDICAO_H = 7;
const PICKING_H = 6;
const MARGEM_ESQ = 8; // espaço para a letra da rua
const MARGEM_DIR = 6;
const RACK_PROF = 3; // profundidade da prateleira
const CORREDOR_MIN = 3.5; // corredor mínimo para a empilhadeira
const PORTA_LARG = 4;
const POSICAO_LARG = 2.7; // posição-palete padrão ao longo da rua

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function armazenagem(comprimento) {
  return comprimento - DOCA_H - EXPEDICAO_H - PICKING_H;
}

/** Quanto cabe num galpão dessas medidas. */
export function capacidadeGalpao(largura, comprimento) {
  return {
    ruas: Math.max(0, Math.min(26, Math.floor((armazenagem(comprimento) - 4) / (RACK_PROF + CORREDOR_MIN)))),
    docas: Math.max(0, Math.floor(largura / (PORTA_LARG + 1))),
    posicoes: Math.max(1, Math.round((largura - MARGEM_ESQ - MARGEM_DIR) / POSICAO_LARG)),
  };
}

/**
 * Confere as medidas. Devolve { galpao } normalizado (números inteiros onde cabe) ou { error }.
 * `posicoes` vazio = automático (uma posição-palete a cada ~2,7 m).
 */
export function validarGalpao(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'informe as medidas do galpão' };
  const g = {};
  const nomes = { largura: 'largura', comprimento: 'comprimento', docas: 'docas', ruas: 'ruas', niveis: 'níveis', posicoes: 'posições por rua' };
  for (const [campo, [min, max]] of Object.entries(GALPAO_LIMITES)) {
    const v = raw[campo];
    if (campo === 'posicoes' && (v === null || v === undefined || v === '')) {
      g.posicoes = null;
      continue;
    }
    const n = Number(v);
    const inteiro = campo !== 'largura' && campo !== 'comprimento';
    if (!Number.isFinite(n) || (inteiro && !Number.isInteger(n))) {
      return { error: `${nomes[campo]} deve ser um número${inteiro ? ' inteiro' : ''}` };
    }
    if (n < min || n > max) return { error: `${nomes[campo]} deve ficar entre ${min} e ${max}` };
    g[campo] = n;
  }
  const cap = capacidadeGalpao(g.largura, g.comprimento);
  if (g.ruas > cap.ruas) {
    const porRua = String(RACK_PROF + CORREDOR_MIN).replace('.', ',');
    return { error: `cabem no máximo ${cap.ruas} ruas num galpão de ${g.comprimento} m de comprimento (cada rua ocupa ${porRua} m com o corredor)` };
  }
  if (g.docas > cap.docas) {
    return { error: `cabem no máximo ${cap.docas} docas em ${g.largura} m de largura (${PORTA_LARG} m por porta, com folga)` };
  }
  return { galpao: g };
}

/** Planta no formato da IndoorView a partir de medidas já validadas. */
export function gerarPlanta(g) {
  const L = g.largura;
  const A = g.comprimento;
  const arm = armazenagem(A);
  const yArm = DOCA_H + EXPEDICAO_H;
  const zonas = [
    { nome: 'Docas', x: 0, y: 0, w: L, h: DOCA_H, tipo: 'doca' },
    { nome: 'Expedição', x: 0, y: DOCA_H, w: L, h: EXPEDICAO_H, tipo: 'expedicao' },
    { nome: 'Armazenagem', x: 0, y: yArm, w: L, h: arm, tipo: 'estoque' },
    { nome: 'Picking', x: 0, y: A - PICKING_H, w: L, h: PICKING_H, tipo: 'picking' },
  ];
  const vao = L / Math.max(1, g.docas);
  const portas = Array.from({ length: g.docas }, (_, i) => ({
    nome: `D${i + 1}`,
    x: Math.round((vao * (i + 0.5) - PORTA_LARG / 2) * 10) / 10,
    w: PORTA_LARG,
  }));
  const compRua = L - MARGEM_ESQ - MARGEM_DIR;
  const posicoes = g.posicoes ?? capacidadeGalpao(L, A).posicoes;
  const passo = g.ruas ? (arm - 4) / g.ruas : 0;
  const prateleiras = Array.from({ length: g.ruas }, (_, i) => ({
    id: LETRAS[i],
    x: MARGEM_ESQ,
    y: Math.round((yArm + 2 + passo * i + (passo - RACK_PROF) / 2) * 10) / 10,
    w: compRua,
    h: RACK_PROF,
    posicoes,
    niveis: g.niveis,
  }));
  return { largura: L, altura: A, zonas, portas, prateleiras };
}

/** Resumo para mostrar no formulário: posições-palete e área. */
export function resumoGalpao(g) {
  const planta = gerarPlanta(g);
  const posicoes = planta.prateleiras.reduce((n, r) => n + r.posicoes * r.niveis, 0);
  return { posicoesPalete: posicoes, area: Math.round(g.largura * g.comprimento), porRua: planta.prateleiras[0]?.posicoes ?? 0 };
}
