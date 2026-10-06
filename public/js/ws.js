// Cliente WebSocket com reconexão exponencial.
export function connect({ onSnapshot, onBatch, onRemove, onState }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let socket = null;
  let attempt = 0;
  let timer = null;
  let closed = false;

  function open() {
    onState('connecting');
    socket = new WebSocket(url);
    socket.onopen = () => {
      attempt = 0;
      onState('open');
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'snapshot') onSnapshot(message.assets);
      else if (message.type === 'batch') onBatch(message.assets);
      else if (message.type === 'remove') onRemove(message.id);
    };
    socket.onclose = () => {
      if (closed) return;
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
