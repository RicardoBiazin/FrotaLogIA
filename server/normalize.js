// Validação e normalização de posições recebidas (HTTP, adaptadores ou simulador).
//
// Formato aceito (campos extras são ignorados):
//   Geográfico: { id, tipo, lat, lon, rumo?, velocidade?, timestamp?, nome?, atributos? }
//   Local:      { id, tipo, espaco, x, y, rumo?, velocidade?, timestamp?, nome?, atributos? }
// Unidades: lat/lon em graus; x/y em metros; rumo em graus (0 = norte);
//           velocidade em km/h; timestamp em ISO 8601 ou epoch em ms ou s (campo "ts" também vale).

export const TIPOS = ['caminhao', 'carro', 'empilhadeira', 'outro'];

const TIPO_ALIASES = {
  caminhao: 'caminhao',
  caminhoes: 'caminhao',
  truck: 'caminhao',
  trailer: 'caminhao',
  carreta: 'caminhao',
  carro: 'carro',
  carros: 'carro',
  car: 'carro',
  van: 'carro',
  pickup: 'carro',
  suv: 'carro',
  empilhadeira: 'empilhadeira',
  forklift: 'empilhadeira',
  paleteira: 'empilhadeira',
};

const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_ATTRIBUTES_BYTES = 2048;
// Epoch abaixo disso está em segundos (em ms seria antes de 03/03/1973).
// Muitos rastreadores mandam segundos; sem a conversão a posição cairia em 1970.
const SECONDS_EPOCH_LIMIT = 1e11;

const fail = (error) => ({ ok: false, error });

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeTipo(raw) {
  if (typeof raw !== 'string') return 'outro';
  const key = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  // hasOwn: "constructor", "__proto__" etc. não podem vir do protótipo do objeto
  return Object.hasOwn(TIPO_ALIASES, key) ? TIPO_ALIASES[key] : 'outro';
}

const epochToMs = (n) => (Math.abs(n) < SECONDS_EPOCH_LIMIT ? n * 1000 : n);

function parseTimestamp(value, now) {
  if (value === undefined || value === null || value === '') return now;
  if (typeof value === 'number') return Number.isFinite(value) ? epochToMs(value) : null;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNumber)) return epochToMs(asNumber);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function normalizePosition(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('esperado um objeto JSON');

  const id = String(raw.id ?? '').trim();
  if (!id || id.length > 64) return fail('id é obrigatório (até 64 caracteres)');

  const espaco = raw.espaco ? String(raw.espaco).trim().slice(0, 64) : null;
  let lat = null;
  let lon = null;
  let x = null;
  let y = null;

  if (espaco) {
    x = toNumber(raw.x);
    y = toNumber(raw.y);
    if (x === null || y === null) return fail('posição local exige x e y numéricos (metros)');
  } else {
    lat = toNumber(raw.lat);
    lon = toNumber(raw.lon ?? raw.lng);
    if (lat === null || lon === null) return fail('lat e lon numéricos são obrigatórios');
    if (lat < -90 || lat > 90) return fail('lat fora do intervalo [-90, 90]');
    if (lon < -180 || lon > 180) return fail('lon fora do intervalo [-180, 180]');
  }

  const rumoRaw = toNumber(raw.rumo);
  const rumo = rumoRaw === null ? null : ((rumoRaw % 360) + 360) % 360; // null = derivar no store

  const velocidadeRaw = toNumber(raw.velocidade);
  const velocidade = velocidadeRaw === null ? 0 : Math.min(400, Math.max(0, velocidadeRaw));

  const ts = parseTimestamp(raw.ts ?? raw.timestamp, now);
  if (ts === null) return fail('timestamp inválido');
  if (ts > now + MAX_FUTURE_MS) return fail('timestamp no futuro');

  let atributos = null;
  if (raw.atributos && typeof raw.atributos === 'object' && !Array.isArray(raw.atributos)) {
    if (Buffer.byteLength(JSON.stringify(raw.atributos)) <= MAX_ATTRIBUTES_BYTES) atributos = raw.atributos;
  }

  const nome = raw.nome ? String(raw.nome).trim().slice(0, 80) : id;

  return {
    ok: true,
    asset: { id, nome, tipo: normalizeTipo(raw.tipo), espaco, lat, lon, x, y, rumo, velocidade, ts, atributos },
  };
}
