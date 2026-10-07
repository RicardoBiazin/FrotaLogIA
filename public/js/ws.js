// Cliente WebSocket com autenticação e reconexão exponencial.
// A primeira mensagem é { type: 'auth', chave }; chave recusada (código 4401) não reconecta.
const WS_UNAUTHORIZED = 4401;

export function connect({ chave, onSnapshot, onBatch, onRemove, onEvento, onCentros, onState, onUnauthorized }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let socket = null;
  let attempt = 0;
  let timer = null;
  let closed = false;

  function open() {
    onState('connecting');
    socket = new WebSocket(url);
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', chave: chave ?? '' }));
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'snapshot') {
        attempt = 0;
        onState('open');
        onSnapshot(message);
      } else if (message.type === 'batch') onBatch(message);
      else if (message.type === 'remove') onRemove(message.id);
      else if (message.type === 'evento') onEvento(message.evento);
      else if (message.type === 'centros') onCentros?.();
    };
    socket.onclose = (event) => {
      if (closed) return;
      if (event.code === WS_UNAUTHORIZED) {
        closed = true;
        onState('closed');
        onUnauthorized();
        return;
      }
      onState('closed');
      const delay = Math.min(10_000, 500 * 2 ** attempt++) + Math.random() * 300;
      timer = setTimeout(open, delay);
    };
    socket.onerror = () => socket.close();
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
