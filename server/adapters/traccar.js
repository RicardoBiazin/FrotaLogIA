// Adaptador para o Traccar (https://www.traccar.org) usando "Position forwarding" via JSON.
// Configure no traccar.xml:
//   <entry key='forward.enable'>true</entry>
//   <entry key='forward.json'>true</entry>
//   <entry key='forward.url'>http://SEU_SERVIDOR:3000/api/ingest/traccar</entry>
// O formato do payload pode variar entre versões do Traccar: confira com um evento real.
//
// Observações: o Traccar entrega a velocidade em nós e o "course" em graus.
// A categoria do dispositivo (truck, car, ...) vira o "tipo" do ativo.

const KNOTS_TO_KMH = 1.852;

export function traccarToPositions(body) {
  const items = Array.isArray(body) ? body : [body];
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const position = item.position ?? item;
      const device = item.device ?? {};
      const id = device.uniqueId ?? position.deviceUniqueId ?? device.id ?? position.deviceId;
      return {
        id: id === undefined ? '' : String(id),
        nome: device.name,
        tipo: device.category,
        lat: position.latitude,
        lon: position.longitude,
        rumo: position.course,
        velocidade: Number(position.speed ?? 0) * KNOTS_TO_KMH,
        timestamp: position.fixTime ?? position.deviceTime ?? position.serverTime,
      };
    });
}
