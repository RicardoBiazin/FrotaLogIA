// Rotas e agentes do simulador (Grande Florianópolis + Galpão 1).
// Waypoints em [lat, lon]. O simulador pede ao OSRM o traçado real pelas ruas entre eles.

export const GEO_ROUTES = {
  'br101-palhoca-biguacu': {
    nome: 'BR-101 Palhoça → Biguaçu',
    waypoints: [[-27.6455, -48.669], [-27.495, -48.655]],
  },
  'br101-sao-jose-tijucas': {
    nome: 'São José → Tijucas',
    waypoints: [[-27.59, -48.63], [-27.241, -48.632]],
  },
  'aeroporto-centro': {
    nome: 'Aeroporto → Centro',
    waypoints: [[-27.6705, -48.5528], [-27.5985, -48.5435]],
  },
  'centro-lagoa': {
    nome: 'Centro → Lagoa da Conceição',
    waypoints: [[-27.5985, -48.5435], [-27.605, -48.466]],
  },
  'centro-jurere': {
    nome: 'Centro → Jurerê',
    waypoints: [[-27.5985, -48.5435], [-27.44, -48.502]],
  },
  'trindade-campeche': {
    nome: 'Trindade → Campeche',
    waypoints: [[-27.587, -48.52], [-27.678, -48.479]],
  },
};

// Caminhos dentro do Galpão 1, em metros [x, y] (ver server/spaces.js)
export const WAREHOUSE_PATHS = {
  corredor_expedicao: [[8, 11.5], [84, 11.5]],
  oeste_e_corredor_a: [[5, 11.5], [5, 43.5], [83, 43.5]],
  leste_e_corredor_b: [[85, 11.5], [85, 35.5], [8, 35.5]],
};

// speed: km/h de cruzeiro. stopChance: paradas aleatórias por segundo.
// dropout: simula perda de sinal periódica (aparece como "sem sinal").
export const AGENTS = [
  { id: 'TRK-001', nome: 'Caminhão 01', tipo: 'caminhao', route: 'br101-palhoca-biguacu', speed: 70, start: 0.1, stopChance: 0.004 },
  { id: 'TRK-002', nome: 'Caminhão 02', tipo: 'caminhao', route: 'br101-palhoca-biguacu', speed: 62, start: 0.7, dir: -1, stopChance: 0.004 },
  {
    id: 'TRK-003', nome: 'Caminhão 03', tipo: 'caminhao', route: 'br101-sao-jose-tijucas', speed: 75, start: 0.35, stopChance: 0.003,
    dropout: { everySec: 240, forSec: 80 },
  },
  { id: 'TRK-004', nome: 'Caminhão 04', tipo: 'caminhao', route: 'aeroporto-centro', speed: 48, start: 0.5, stopChance: 0.006 },
  { id: 'CAR-001', nome: 'Carro 01', tipo: 'carro', route: 'centro-lagoa', speed: 42, start: 0.2, stopChance: 0.008 },
  { id: 'CAR-002', nome: 'Carro 02', tipo: 'carro', route: 'centro-lagoa', speed: 38, start: 0.8, dir: -1, stopChance: 0.008 },
  { id: 'CAR-003', nome: 'Carro 03', tipo: 'carro', route: 'centro-jurere', speed: 55, start: 0.4, stopChance: 0.005 },
  { id: 'CAR-004', nome: 'Carro 04', tipo: 'carro', route: 'trindade-campeche', speed: 40, start: 0.6, stopChance: 0.008 },
  { id: 'EMP-001', nome: 'Empilhadeira 01', tipo: 'empilhadeira', espaco: 'galpao-1', path: 'corredor_expedicao', speed: 9, start: 0.1, stopChance: 0.03, intervalMs: 1000 },
  { id: 'EMP-002', nome: 'Empilhadeira 02', tipo: 'empilhadeira', espaco: 'galpao-1', path: 'oeste_e_corredor_a', speed: 8, start: 0.5, stopChance: 0.03, intervalMs: 1000 },
  { id: 'EMP-003', nome: 'Empilhadeira 03', tipo: 'empilhadeira', espaco: 'galpao-1', path: 'leste_e_corredor_b', speed: 10, start: 0.3, dir: -1, stopChance: 0.03, intervalMs: 1000 },
];
