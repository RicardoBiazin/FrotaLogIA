// Eventos operacionais por cliente (ex.: veículo entrou/saiu de um CD). Guarda os últimos N.
//   { id, tipo: 'entrada' | 'saida', veiculo, nome, cd, cdNome, ts }
import { EventEmitter } from 'node:events';

export class EventLog extends EventEmitter {
  constructor({ max = 200 } = {}) {
    super();
    this.max = max;
    this.byCliente = new Map();
    this.seq = 0;
  }

  add(cliente, evento) {
    let list = this.byCliente.get(cliente);
    if (!list) {
      list = [];
      this.byCliente.set(cliente, list);
    }
    const item = { id: ++this.seq, ...evento };
    list.push(item);
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.emit('evento', cliente, item);
    return item;
  }

  /** Mais recentes primeiro. */
  list(cliente, limit = 50) {
    const list = this.byCliente.get(cliente) ?? [];
    return list.slice(-limit).reverse();
  }
}
