// Simula um dispositivo externo enviando posições por HTTP, como um rastreador real faria.
// Serve para testar a ingestão sem depender do simulador interno.
//
// Uso:
//   node scripts/fake-device.js                       # círculo de 600 m perto de Florianópolis
//   node scripts/fake-device.js MEU-01 caminhao       # id e tipo
//   URL=http://localhost:3000 API_KEY=segredo node scripts/fake-device.js
const id = process.argv[2] ?? 'DEV-001';
const tipo = process.argv[3] ?? 'carro';
const url = (process.env.URL ?? 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.API_KEY ?? '';
const center = { lat: -27.5954, lon: -48.548 };
const radiusM = 600;
const speedKmh = 40;
const intervalMs = 3000;

const circumference = 2 * Math.PI * radiusM;
const angularSpeed = ((speedKmh / 3.6) / circumference) * 360; // graus/s
let angle = Math.random() * 360;

async function send() {
  angle = (angle + angularSpeed * (intervalMs / 1000)) % 360;
  const rad = (angle * Math.PI) / 180;
  const lat = center.lat + (radiusM * Math.cos(rad)) / 111_320;
  const lon = center.lon + (radiusM * Math.sin(rad)) / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const body = { id, nome: `Dispositivo ${id}`, tipo, lat, lon, velocidade: speedKmh, timestamp: new Date().toISOString() };
  // O rumo é omitido de propósito: o servidor deriva a direção a partir das posições.
  try {
    const res = await fetch(`${url}/api/positions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { 'x-api-key': apiKey }) },
      body: JSON.stringify(body),
    });
    console.log(new Date().toLocaleTimeString(), res.status, lat.toFixed(5), lon.toFixed(5));
  } catch (err) {
    console.error('Falha ao enviar:', err.message);
  }
}

console.log(`Enviando posições de ${id} (${tipo}) para ${url} a cada ${intervalMs / 1000}s. Ctrl+C para parar.`);
send();
setInterval(send, intervalMs);
