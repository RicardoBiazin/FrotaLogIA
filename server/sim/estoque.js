// Estoque simulado nos CDs com prateleiras. Enche ~70% das posições-palete e depois movimenta:
// separação (picking) tira unidades, expedição libera o palete, recebimento ocupa posição vazia.
// Tudo passa por ingest.stock, o mesmo caminho do WMS real.
import { PRODUTOS, EMPRESAS } from '../demo.js';
import { formatEndereco } from '../../public/js/estoque.js';

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const DIA_MS = 86_400_000;
const OCUPACAO_ALVO = 0.7;
const INTERVALO_MS = 3_000;

let lotes = 0;

function novoPalete(produto, depositante, now) {
  const quantidade = randInt(...produto.porPalete);
  lotes++;
  return {
    sku: produto.sku,
    descricao: produto.descricao,
    depositante,
    quantidade,
    unidade: produto.unidade,
    lote: `L${new Date(now).getFullYear() % 100}${String(lotes).padStart(5, '0')}`,
    validade: produto.validadeDias ? Math.round(now + rand(...produto.validadeDias) * DIA_MS) : null,
    pesoKg: Math.round(quantidade * produto.kgUn),
    entradaEm: Math.round(now - rand(0, 40) * DIA_MS),
  };
}

export function startStockSimulation({ ingest, cliente, centros }) {
  const cds = centros.filter((c) => c.planta?.prateleiras?.length);
  // Estado local do simulador: cd → endereço → palete (o servidor tem a cópia oficial).
  const estado = new Map();
  const enderecos = new Map();

  const send = (cd, endereco, palete) => {
    const r = ingest.stock(cliente, { cd: cd.id, endereco, ...(palete ?? { quantidade: 0 }) });
    if (!r.ok) console.warn(`[sim] estoque ${cd.id} ${endereco} recusado: ${r.error}`);
  };

  const now = Date.now();
  for (const cd of cds) {
    const lista = [];
    for (const r of cd.planta.prateleiras) {
      for (let p = 1; p <= r.posicoes; p++) for (let n = 1; n <= r.niveis; n++) lista.push(formatEndereco(r.id, p, n));
    }
    enderecos.set(cd.id, lista);
    const ocupados = new Map();
    estado.set(cd.id, ocupados);
    // Cada rua guarda poucas famílias de produto, como num armazém real (curva ABC por rua).
    for (const r of cd.planta.prateleiras) {
      const familia = Array.from({ length: 4 }, () => pick(PRODUTOS));
      for (let p = 1; p <= r.posicoes; p++) {
        for (let n = 1; n <= r.niveis; n++) {
          if (Math.random() > OCUPACAO_ALVO) continue;
          const endereco = formatEndereco(r.id, p, n);
          const palete = novoPalete(pick(familia), pick(EMPRESAS), now);
          ocupados.set(endereco, palete);
          send(cd, endereco, palete);
        }
      }
    }
  }

  const tick = () => {
    if (cds.length === 0) return;
    const cd = pick(cds);
    const ocupados = estado.get(cd.id);
    const lista = enderecos.get(cd.id);
    const ocupacao = ocupados.size / lista.length;
    const t = Date.now();
    const r = Math.random();

    if (r < 0.55 && ocupados.size) {
      // separação: tira parte das unidades de um palete
      const endereco = pick([...ocupados.keys()]);
      const palete = ocupados.get(endereco);
      const tirar = Math.max(1, Math.round(palete.quantidade * rand(0.1, 0.4)));
      palete.quantidade -= tirar;
      if (palete.quantidade <= 0) ocupados.delete(endereco);
      else palete.pesoKg = Math.round(palete.pesoKg * (palete.quantidade / (palete.quantidade + tirar)));
      send(cd, endereco, palete.quantidade > 0 ? palete : null);
    } else if (ocupacao > OCUPACAO_ALVO || (r < 0.75 && ocupados.size)) {
      // expedição: o palete inteiro sai
      const endereco = pick([...ocupados.keys()]);
      ocupados.delete(endereco);
      send(cd, endereco, null);
    } else {
      // recebimento: palete novo numa posição vazia
      const vazios = lista.filter((e) => !ocupados.has(e));
      if (!vazios.length) return;
      const endereco = pick(vazios);
      const palete = novoPalete(pick(PRODUTOS), pick(EMPRESAS), t);
      palete.entradaEm = t;
      ocupados.set(endereco, palete);
      send(cd, endereco, palete);
    }
  };

  const timer = setInterval(tick, INTERVALO_MS);
  const total = [...estado.values()].reduce((n, m) => n + m.size, 0);
  if (cds.length) console.log(`[sim] estoque: ${total} paletes em ${cds.length} CDs.`);
  return { stop: () => clearInterval(timer) };
}
