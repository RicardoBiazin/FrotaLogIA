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
  // Ruas A (perto das docas) a D: 14 posições de 5 m e 4 níveis cada = 224 posições-palete.
  prateleiras: [22, 30, 38, 46].map((y, i) => ({ id: 'ABCD'[i], x: 10, y, w: 70, h: 3, posicoes: 14, niveis: 4 })),
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
  // Ruas A a C: 11 posições de 4 m e 4 níveis cada = 132 posições-palete.
  prateleiras: [17, 24, 31].map((y, i) => ({ id: 'ABC'[i], x: 8, y, w: 44, h: 3, posicoes: 11, niveis: 4 })),
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

// Produtos de exemplo para o estoque simulado. `porPalete`: faixa de unidades por posição-palete;
// `kgUn`: peso de cada unidade; `validadeDias`: faixa de validade a partir de hoje (null = não perece).
export const PRODUTOS = [
  { sku: 'ELE-1001', descricao: 'Geladeira frost free 375 L', unidade: 'un', porPalete: [2, 4], kgUn: 62, validadeDias: null },
  { sku: 'ELE-1002', descricao: 'Micro-ondas 30 L', unidade: 'un', porPalete: [12, 24], kgUn: 14, validadeDias: null },
  { sku: 'ELE-1003', descricao: 'Smart TV 50 polegadas', unidade: 'un', porPalete: [8, 16], kgUn: 13, validadeDias: null },
  { sku: 'ELE-1004', descricao: 'Notebook 15 polegadas', unidade: 'cx', porPalete: [20, 40], kgUn: 2.4, validadeDias: null },
  { sku: 'ALI-2001', descricao: 'Arroz tipo 1 5 kg (fardo 6 un)', unidade: 'fardo', porPalete: [30, 40], kgUn: 30, validadeDias: [120, 360] },
  { sku: 'ALI-2002', descricao: 'Feijão carioca 1 kg (fardo 10 un)', unidade: 'fardo', porPalete: [50, 70], kgUn: 10, validadeDias: [90, 300] },
  { sku: 'ALI-2003', descricao: 'Café torrado 500 g (caixa 20 un)', unidade: 'cx', porPalete: [40, 60], kgUn: 10, validadeDias: [20, 240] },
  { sku: 'BEB-3001', descricao: 'Cerveja lata 350 ml (caixa 12 un)', unidade: 'cx', porPalete: [80, 120], kgUn: 4.6, validadeDias: [15, 180] },
  { sku: 'BEB-3002', descricao: 'Água mineral 500 ml (fardo 12 un)', unidade: 'fardo', porPalete: [80, 100], kgUn: 6.2, validadeDias: [60, 360] },
  { sku: 'HIG-4001', descricao: 'Sabão em pó 1 kg (caixa 20 un)', unidade: 'cx', porPalete: [40, 50], kgUn: 20, validadeDias: [200, 700] },
  { sku: 'HIG-4002', descricao: 'Papel higiênico 12 rolos (fardo 4 un)', unidade: 'fardo', porPalete: [24, 36], kgUn: 4.5, validadeDias: null },
  { sku: 'CON-5001', descricao: 'Cimento CP-II 50 kg', unidade: 'sc', porPalete: [30, 40], kgUn: 50, validadeDias: [25, 90] },
  { sku: 'CON-5002', descricao: 'Argamassa AC-I 20 kg', unidade: 'sc', porPalete: [50, 70], kgUn: 20, validadeDias: [60, 180] },
  { sku: 'PNE-6001', descricao: 'Pneu 295/80 R22.5', unidade: 'un', porPalete: [6, 10], kgUn: 65, validadeDias: null },
  { sku: 'PNE-6002', descricao: 'Pneu 175/70 R14', unidade: 'un', porPalete: [20, 30], kgUn: 7.5, validadeDias: null },
  { sku: 'MOV-7001', descricao: 'Sofá 3 lugares (desmontado)', unidade: 'vol', porPalete: [3, 6], kgUn: 28, validadeDias: null },
  { sku: 'FAR-8001', descricao: 'Medicamento genérico (caixa 100 un)', unidade: 'cx', porPalete: [30, 60], kgUn: 3, validadeDias: [10, 400] },
];
