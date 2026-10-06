// Manda dados de teste pela API, como faria o sistema de um cliente, e mostra o resultado.
// O servidor precisa estar rodando.
//
// Uso:
//   npm run dados-teste                       # modo aberto (sem chave)
//   npm run dados-teste -- SUA_CHAVE          # modo com chave
//   URL=http://outro:3000 npm run dados-teste
const chave = process.argv[2] ?? process.env.API_KEY ?? '';
const url = (process.env.URL ?? `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const headers = { 'content-type': 'application/json', ...(chave && { 'x-api-key': chave }) };

async function call(method, path, body) {
  const res = await fetch(url + path, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function passo(titulo, ok, detalhe) {
  console.log(`${ok ? '[ok]  ' : '[ERRO]'} ${titulo}${detalhe ? `\n       ${detalhe}` : ''}`);
  return ok;
}

try {
  await fetch(`${url}/api/health`);
} catch {
  console.error(`Servidor não respondeu em ${url}. Inicie o FrotaLogIA (opção 1 do FrotaLogIA.bat) e tente de novo.`);
  process.exit(1);
}

const sessao = await call('GET', '/api/sessao');
if (sessao.status === 401) {
  console.error('O servidor exige chave de acesso. Rode de novo informando a chave (ver data\\clientes.json / npm run cliente).');
  process.exit(1);
}
console.log(`Cliente: ${sessao.data.cliente.nome}\n`);

let falhas = 0;
const check = (...args) => passo(...args) || falhas++;

const veiculo = await call('POST', '/api/positions', {
  id: 'TESTE-01', nome: 'Caminhão de teste', tipo: 'caminhao', lat: -27.5954, lon: -48.548, velocidade: 40,
});
check('Veículo TESTE-01 enviado (aparece no centro de Florianópolis)', veiculo.status === 202);

const viagem = await call('POST', '/api/viagens', {
  id: 'VG-TESTE', veiculo: 'TESTE-01', status: 'em_transito', documento: 'CT-e 999999',
  origem: { nome: 'CD São José', cd: 'cd-sao-jose' }, destino: { nome: 'CD Biguaçu', cd: 'cd-biguacu' },
  remetente: { nome: 'Empresa Remetente de Teste' }, destinatario: { nome: 'Empresa Destinatária de Teste' },
  carga: { descricao: 'Carga de teste', pesoKg: 8000, volumeM3: 30, volumes: 12, valor: 50000 },
  previsao: Date.now() + 45 * 60_000,
});
check('Viagem VG-TESTE ligada ao TESTE-01 (clique no veículo para ver)', viagem.status === 202,
  viagem.status === 202 ? '' : JSON.stringify(viagem.data));

const centros = (await call('GET', '/api/centros')).data ?? [];
const cd = centros.find((c) => c.planta?.prateleiras?.length);
if (!cd) {
  check('Estoque', false, 'este cliente não tem CD com prateleiras; o teste de estoque foi pulado');
} else {
  const rua = cd.planta.prateleiras[0].id;
  const endereco = `${rua}-01-1`;
  const palete = await call('POST', '/api/estoque', {
    cd: cd.id, endereco, sku: 'TESTE-1', descricao: 'Produto de teste', depositante: 'Empresa de Teste',
    quantidade: 50, unidade: 'cx', lote: 'LTESTE', validade: Date.now() + 20 * 86_400_000, pesoKg: 400,
  });
  check(`Palete TESTE-1 gravado em ${cd.nome}, endereço ${endereco}`, palete.status === 202,
    palete.status === 202 ? '' : JSON.stringify(palete.data));

  const invalido = await call('POST', '/api/estoque', { cd: cd.id, endereco: 'Z-99-9', sku: 'X', descricao: 'Y', quantidade: 1 });
  check('Endereço inválido recusado com explicação', invalido.status === 400, invalido.data?.rejected?.[0]?.erro);

  const busca = await call('GET', '/api/estoque?q=TESTE-1');
  const achou = busca.data?.find?.((i) => i.sku === 'TESTE-1');
  check('Busca "TESTE-1" encontra o produto', Boolean(achou), achou && `${achou.cd} ${achou.endereco}: ${achou.quantidade} ${achou.unidade}`);
}

const sem = await fetch(`${url}/api/assets`, { headers: { 'x-api-key': 'chave-errada-de-teste' } });
check(
  'Chave errada é recusada (só vale com chave configurada)',
  sem.status === 401 || !chave,
  chave ? '' : 'modo aberto: sem chave configurada, qualquer acesso local é aceito',
);

console.log(`\n${falhas === 0 ? 'Tudo certo.' : `${falhas} verificação(ões) falharam.`} No navegador, busque "teste" para ver o veículo e o palete.`);
process.exit(falhas === 0 ? 0 : 1);
