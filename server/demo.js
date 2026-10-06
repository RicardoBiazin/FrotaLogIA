// Rede de exemplo do cliente "demo" na Grande Florianópolis: CDs, plantas e cadastros fictícios.
// Empresas, pessoas e documentos aqui são inventados. Clientes reais trazem os seus
// centros em data/clientes.json e as viagens pela API.

// Planta: metros, origem no canto inferior esquerdo; x → leste, y → norte. Docas no lado sul (y = 0).
const PLANTA_SAO_JOSE = {
  largura: 90,
  altura: 56,
  zonas: [
    { nome: 'Docas', x: 0, y: 0, w: 90, h: 8, tipo: 'doca' },
    { nome: 'Expedição', x: 0, y: 8, w: 90, h: 7, tipo: 'expedicao' },
    { nome: 'Armazenagem', x: 0, y: 15, w: 90, h: 35, tipo: 'estoque' },
    { nome: 'Picking', x: 0, y: 50, w: 90, h: 6, tipo: 'picking' },
  ],
  portas: [8, 22, 36, 50, 64, 78].map((x, i) => ({ nome: `D${i + 1}`, x: x - 3, w: 6 })),
  prateleiras: [46, 38, 30, 22].map((y) => ({ x: 10, y, w: 70, h: 3 })),
};

const PLANTA_PALHOCA = {
  largura: 60,
  altura: 40,
  zonas: [
    { nome: 'Docas', x: 0, y: 0, w: 60, h: 7, tipo: 'doca' },
    { nome: 'Expedição', x: 0, y: 7, w: 60, h: 6, tipo: 'expedicao' },
    { nome: 'Armazenagem', x: 0, y: 13, w: 60, h: 22, tipo: 'estoque' },
    { nome: 'Picking', x: 0, y: 35, w: 60, h: 5, tipo: 'picking' },
  ],
  portas: [9, 21, 33, 45].map((x, i) => ({ nome: `D${i + 1}`, x: x - 3, w: 6 })),
  prateleiras: [31, 24, 17].map((y) => ({ x: 8, y, w: 44, h: 3 })),
};

export const CENTROS_DEMO = [
  {
    id: 'cd-sao-jose', nome: 'CD São José', endereco: 'BR-101, São José (SC)',
    lat: -27.59, lon: -48.63, raioM: 350, planta: PLANTA_SAO_JOSE,
  },
  {
    id: 'cd-palhoca', nome: 'CD Palhoça', endereco: 'BR-101, Palhoça (SC)',
    lat: -27.6452, lon: -48.6689, raioM: 350, planta: PLANTA_PALHOCA,
  },
  {
    id: 'cd-biguacu', nome: 'CD Biguaçu', endereco: 'BR-101, Biguaçu (SC)',
    lat: -27.4952, lon: -48.6547, raioM: 350, planta: null,
  },
  {
    id: 'hub-aeroporto', nome: 'Hub Aeroporto', endereco: 'Terminal de cargas, Florianópolis (SC)',
    lat: -27.6705, lon: -48.5528, raioM: 400, planta: null,
  },
];

export const CARGAS = {
  transferencia: [
    'Eletrodomésticos', 'Alimentos secos', 'Bebidas', 'Material de construção',
    'Produtos de higiene e limpeza', 'Móveis desmontados', 'Pneus',
  ],
  aereo: ['Peças automotivas (urgente)', 'Medicamentos', 'Eletrônicos'],
  ultimaMilha: ['Encomendas de e-commerce', 'Compras de supermercado', 'Medicamentos'],
};

export const EMPRESAS = [
  'Distribuidora Atlântica', 'Atacado Serra Mar', 'Indústria Vale Verde', 'Comercial Ilha Sul',
  'Mercado Bela Vista', 'Construtora Horizonte', 'Farmácia Bem Estar', 'Loja Centro Ilha',
];

export const PESSOAS = ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Elisa Prado', 'Fábio Nunes'];
