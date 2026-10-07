# FrotaLogIA

Logística de transporte em tempo real, **por cliente**: cada empresa vê a própria rede, com todos os veículos na estrada e nos centros de distribuição (CDs).

- **Mapa** (MapLibre GL) com os veículos animados e os CDs. Cada CD mostra quantos veículos estão no pátio e quantos estão a caminho.
- **Dados do transporte:** ao clicar num veículo, o card mostra a viagem. Ela traz origem e destino, carga, peso, volume, quantidade de volumes, valor, remetente, destinatário, documento (CT-e), prazo de entrega e chegada estimada.
- **Atrasos:** caminhões e carros fora do prazo ganham um anel vermelho no mapa com o tempo de atraso ("+12 min") e o aviso "Atrasado 12 min" na lista. O contador "veículos em atraso" no resumo mostra só os atrasados.
- **Centros de distribuição:** clique num CD para ver o pátio, as chegadas previstas e as últimas entradas e saídas. "Abrir planta" mostra o interior, com as empilhadeiras em tempo real e os caminhões encostados nas docas.
- **CD em 3D:** na aba Centros, "Ver em 3D" mostra o CD em vista isométrica, com as prateleiras e os paletes em cada nível (cor pela família do produto), as empilhadeiras se movendo em tempo real e os caminhões encostados nas docas. Arraste para girar, use a roda do mouse para aproximar e o botão direito (ou Shift) para mover. Clicar num palete ou numa empilhadeira abre o mesmo card da planta, e a busca acende os paletes encontrados.
- **Prateleiras e estoque:** na planta, cada prateleira aparece dividida em posições, coloridas pelos níveis ocupados. Clique numa posição para ver o que há em cada nível: produto, SKU, depositante, quantidade, peso, lote, data de entrada e validade, com aviso de vencido ou vencendo. Busque um produto, SKU ou lote para ver em que endereço e em que CD ele está; as posições acendem na planta.
- **Movimentação:** entradas e saídas dos CDs são detectadas sozinhas, por uma cerca virtual em volta de cada CD.
- **Multi-cliente:** cada empresa entra com a própria chave de acesso e só enxerga a própria frota, tanto na API quanto no WebSocket.
- **Simulador** com uma rede de exemplo na Grande Florianópolis: 4 CDs, 8 veículos com viagens, 5 empilhadeiras e cerca de 250 paletes nas prateleiras, com separação, recebimento e expedição acontecendo. Congestionamentos ocasionais fazem algumas entregas atrasar.
- **Demonstração:** no cliente de exemplo, o quadro "Demonstração" inclui caminhões e carros (1 a 20 por vez, até 100) com a frota rodando, em 11 rotas da região, e remove os incluídos com um clique. Assim dá para ver tudo funcionando antes de ligar dados reais.

## Começando

Requisitos: **Node.js 20.12 ou superior**.

### No Windows: `FrotaLogIA.bat`

Dê dois cliques em `FrotaLogIA.bat`. A opção 1 (padrão, basta apertar Enter) faz todo o processo: confere o Node, instala as dependências, roda os testes, sobe o servidor e abre o navegador quando ele estiver pronto. Se o FrotaLogIA já estiver rodando, só abre o navegador.

| Opção | O que faz |
|---|---|
| 1 | Iniciar (instala, testa, sobe e abre o navegador) |
| 2 | Iniciar com o simulador 20x mais rápido (os caminhões chegam logo aos CDs) |
| 3 | Criar cliente e chave de acesso (com o mesmo id, troca a chave) |
| 4 | Rodar os testes automáticos |
| 5 | Enviar dados de teste pela API, com o servidor ligado (`npm run dados-teste`) |
| 6 | Voltar ao modo demonstração (apaga `data\clientes.json`) |

Também aceita a opção direto: `FrotaLogIA.bat 4`.

### Em qualquer sistema

```bash
npm install
npm run dev        # servidor com reinício automático
# abra http://localhost:3000
```

Sem configuração, o app roda com o cliente **demo**, sem chave, e o servidor só aceita acesso desta máquina (127.0.0.1). Na primeira execução, o simulador busca o traçado real das ruas no OSRM e guarda em `.cache/routes.json`. Se o OSRM estiver inacessível, ele usa linhas retas.

Outros comandos: `npm start` (sem reinício automático), `npm test` (testes), `npm run device` (simula um rastreador externo) e `npm run dados-teste` (manda um veículo, uma viagem e um palete de teste pela API e confere as respostas).

## Clientes e chaves de acesso

Cada cliente fica em `data/clientes.json`, que é ignorado pelo git. O arquivo guarda só o **hash** da chave. Para criar um cliente:

```bash
npm run cliente -- acme "ACME Transportes"              # cliente novo, sem CDs
npm run cliente -- demo "Demonstração" --demo           # usa os CDs de exemplo
npm run cliente -- acme --nova-chave                    # troca a chave
```

O comando mostra a chave **uma única vez**. Entregue-a à empresa: é com ela que se entra no painel e se envia dados pela API. Reinicie o servidor depois de mudar o arquivo.

Os CDs de cada cliente ficam no mesmo arquivo:

```json
[{
  "id": "acme", "nome": "ACME Transportes", "chaveSha256": "…",
  "centros": [
    { "id": "cd-joinville", "nome": "CD Joinville", "endereco": "BR-101, Joinville (SC)",
      "lat": -26.30, "lon": -48.85, "raioM": 300 }
  ]
}]
```

`raioM` é o raio da cerca, em metros. A planta interna (`planta`) é opcional e segue o formato de `server/demo.js`. Cada prateleira da planta é uma rua: `{ "id": "A", "x": 10, "y": 22, "w": 70, "h": 3, "posicoes": 14, "niveis": 4 }`. As posições são contadas ao longo do lado maior (de oeste para leste ou de sul para norte), e os níveis de baixo para cima.

Com o arquivo presente, toda chamada à API e ao WebSocket exige chave, e o servidor passa a escutar em todas as interfaces de rede. Sem o arquivo, `API_KEY` vira a chave do cliente demo.

## Formatos

### Posição de um veículo ou equipamento

```json
{ "id": "TRK-042", "nome": "Caminhão 42", "tipo": "caminhao",
  "lat": -27.59, "lon": -48.55, "rumo": 135, "velocidade": 62,
  "timestamp": "2026-10-06T14:32:10Z" }
```

Dentro de um CD (planta, sem GPS), `espaco` é o id do CD e `x`/`y` vêm em metros:

```json
{ "id": "EMP-001", "tipo": "empilhadeira", "espaco": "cd-sao-jose", "x": 21.4, "y": 11.5 }
```

| Campo | Regra |
|---|---|
| `id` | Obrigatório, até 64 caracteres. |
| `tipo` | `caminhao`, `carro`, `empilhadeira` ou `outro`. Aceita sinônimos (`truck`, `van`, `forklift`...). Tipo desconhecido vira `outro`. |
| `lat`, `lon` | Graus (WGS84). |
| `espaco`, `x`, `y` | Planta do CD: `x` para leste e `y` para o norte, em metros, origem no canto inferior esquerdo. |
| `rumo` | Graus, 0 = norte. Opcional: se faltar, o servidor deriva da trajetória. |
| `velocidade` | km/h. A partir de 2 km/h conta como "em movimento". |
| `timestamp` (ou `ts`) | ISO 8601 ou epoch em ms ou em segundos. Posições mais antigas que a última recebida são ignoradas. |
| `atributos` | Objeto livre, até 2 KB (placa, motorista...). |

### Viagem (dados do transporte)

```json
{ "id": "VG-1023", "veiculo": "TRK-042", "status": "em_transito", "documento": "CT-e 35123",
  "origem":  { "nome": "CD Palhoça", "cd": "cd-palhoca" },
  "destino": { "nome": "Cliente em Tijucas", "lat": -27.24, "lon": -48.63 },
  "remetente": { "nome": "Indústria Vale Verde", "documento": "12.345.678/0001-90" },
  "destinatario": { "nome": "Mercado Bela Vista" },
  "carga": { "descricao": "Bebidas", "pesoKg": 12400, "volumeM3": 38, "volumes": 22, "valor": 150000 },
  "previsao": "2026-10-06T16:10:00Z", "estimativa": "2026-10-06T16:22:00Z" }
```

- `status` pode ser `planejada`, `carregando`, `em_transito`, `descarregando`, `entregue` ou `cancelada`.
- `previsao` é o **prazo combinado** de chegada. `estimativa` (opcional) é a chegada prevista atualizada, por exemplo calculada pelo rastreador ou pelo TMS.
- A viagem fica **atrasada** quando o prazo já passou ou quando a estimativa cai depois dele, com tolerância de 1 minuto. Isso vale enquanto a carga não chegou (`planejada`, `carregando` ou `em_transito`).
- Mande a viagem de novo, com o mesmo `id`, sempre que algo mudar (status, estimativa).
- Quando `origem.cd` ou `destino.cd` aponta para um CD, a viagem entra no painel daquele CD.

### Estoque (posição-palete)

O endereço segue o padrão de armazém **RUA-POSIÇÃO-NÍVEL**: `A-03-2` é a rua A, posição 3, nível 2. Cada endereço guarda um palete com um único produto.

```json
{ "cd": "cd-sao-jose", "endereco": "A-03-2", "sku": "BEB-3001",
  "descricao": "Cerveja lata 350 ml (caixa 12 un)", "depositante": "Atacado Serra Mar",
  "quantidade": 96, "unidade": "cx", "lote": "L2600173", "validade": "2027-03-10",
  "pesoKg": 442, "entradaEm": "2026-09-09" }
```

- O endereço é conferido contra a planta do CD: rua, posição ou nível inexistente é recusado com a explicação.
- Mande o endereço de novo a cada movimentação. `"quantidade": 0` libera a posição.

## API

Tudo, exceto `/api/config` e `/api/health`, exige o header `x-api-key` com a chave do cliente.

| Método e caminho | O que faz |
|---|---|
| `POST /api/positions` | Posições: um objeto ou uma lista (até 1000). Responde `202` com `{ accepted, rejected: [{ index, erro }] }`. |
| `POST /api/viagens` | Viagens: um objeto ou uma lista (até 1000). Mesma resposta. |
| `POST /api/ingest/traccar` | Encaminhamento de posições do [Traccar](https://www.traccar.org). |
| `GET /api/assets?tipo=&espaco=` | Veículos e equipamentos com a última posição e o CD onde estão (`cd`). |
| `GET /api/assets/:id` | Um ativo, com a viagem ativa. `/:id/trail` devolve o rastro recente. |
| `DELETE /api/assets/:id` | Remove um ativo. |
| `GET /api/viagens?status=&veiculo=&ativas=true` e `/api/viagens/:id` | Viagens do cliente. |
| `GET /api/centros` | CDs do cliente, com a planta. |
| `POST /api/estoque` | Paletes nos endereços: um objeto ou uma lista (até 1000). `quantidade: 0` libera o endereço. |
| `GET /api/centros/:cd/estoque` | Todas as posições ocupadas de um CD. |
| `GET /api/estoque?q=&cd=` | Onde está o produto: busca por SKU, descrição, depositante, lote ou endereço em todos os CDs. |
| `GET /api/eventos?limit=` | Últimas entradas e saídas de CD. |
| `GET /api/sessao` | Qual cliente a chave identifica e, no cliente de demonstração, quantos veículos foram incluídos. |
| `POST /api/demo/veiculos` | Só no cliente do simulador: `{ "tipo": "caminhao" \| "carro", "quantidade": 1..20 }` inclui veículos. |
| `DELETE /api/demo/veiculos` | Só no cliente do simulador: remove os veículos incluídos (as viagens deles viram canceladas). |
| `GET /api/config`, `/api/health` | Configuração da tela e saúde (públicas, sem dados de cliente). |
| `WS /ws` | Mande `{ "type": "auth", "chave": "…" }`. Em seguida chegam o snapshot do cliente e depois os lotes de atualização. Chave errada fecha com o código 4401. |

### Enviando uma posição de teste

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/positions `
  -ContentType 'application/json' -Headers @{ 'x-api-key' = 'SUA_CHAVE' } `
  -Body '{"id":"MEU-01","tipo":"caminhao","lat":-27.59,"lon":-48.55,"velocidade":40}'
```

Bash:

```bash
curl -X POST http://localhost:3000/api/positions \
  -H 'content-type: application/json' -H 'x-api-key: SUA_CHAVE' \
  -d '{"id":"MEU-01","tipo":"caminhao","lat":-27.59,"lon":-48.55,"velocidade":40}'
```

No modo aberto (cliente demo sem chave), o header pode ser omitido. Para um dispositivo que se move sem parar: `API_KEY=SUA_CHAVE npm run device`.

### Traccar

No `traccar.xml`, aponte o encaminhamento para o servidor e mande a chave do cliente no header:

```xml
<entry key='forward.enable'>true</entry>
<entry key='forward.json'>true</entry>
<entry key='forward.url'>http://SEU_SERVIDOR:3000/api/ingest/traccar</entry>
<entry key='forward.header'>x-api-key: SUA_CHAVE</entry>
```

A categoria do dispositivo (`truck`, `car`...) vira o `tipo`, e a velocidade em nós é convertida para km/h. O adaptador foi testado só com um payload de exemplo, então confirme o formato com a sua versão do Traccar.

## Configuração (`.env`)

Copie `.env.example` para `.env`. Todas as variáveis são opcionais.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP e WebSocket. |
| `HOST` | automático | `127.0.0.1` no modo aberto e `0.0.0.0` quando há chave. |
| `CLIENTES_FILE` | `data/clientes.json` | Clientes, chaves (hash) e CDs. |
| `API_KEY` | vazio | Sem `clientes.json`, é a chave do cliente demo. Vazio = acesso aberto (só desenvolvimento). |
| `SIMULATE` | `true` | Liga o simulador. Desligue ao usar dados reais. |
| `SIM_CLIENTE` | automático | Cliente que recebe os dados simulados. Vazio: o `demo` ou, sem ele, o primeiro cliente criado com `--demo`. |
| `SIM_SPEEDUP` | `5` | Aceleração do tempo nas rotas (1 = tempo real). |
| `OSRM_URL` | servidor público | O público serve só para demonstração. |
| `MAP_STYLE_URL` | vazio | `style.json` do MapLibre. Vazio usa o Positron do [OpenFreeMap](https://openfreemap.org). |
| `MAP_LABEL_FONT` | `Noto Sans Bold` | Fonte dos rótulos. Precisa existir no servidor de fontes (glyphs) do estilo. |
| `OFFLINE_AFTER_S` | `60` | Segundos sem posição até o ativo aparecer como "sem sinal". |
| `TRAIL_MAX` | `300` | Pontos de rastro por ativo. |
| `BATCH_MS` | `250` | Agrupamento das atualizações enviadas ao navegador. |
| `MAX_ASSETS` | `10000` | Máximo de ativos somando todos os clientes. Protege a memória do servidor. |

## Estrutura

```
server/
  index.js        inicialização (clientes, HTTP, WebSocket, simulador)
  app.js          API REST por cliente e arquivos estáticos
  hub.js          WebSocket: autenticação, snapshot e lotes por cliente
  tenants.js      clientes e chaves de acesso
  centros.js      CDs, cerca virtual e planta (ruas, posições e níveis)
  estoque.js      paletes nos endereços das prateleiras
  viagens.js      viagens (dados do transporte)
  eventos.js      entradas e saídas de CD
  normalize.js    validação das posições
  store.js        última posição, rastro e status (troque por Redis/PostGIS)
  ingest.js       único caminho de entrada de dados
  demo.js         rede de exemplo da Grande Florianópolis
  adapters/       conversores de fontes externas (Traccar)
  sim/            simulador (rotas, OSRM, veículos, viagens e estoque)
public/
  index.html, css/style.css
  js/main.js        orquestra acesso, dados, animação e interface
  js/logistica.js   resumo de CD, busca e formatação (código puro, testado)
  js/estoque.js     endereços, ocupação e validade (código puro, também usado pelo servidor)
  js/interp.js      interpolação do movimento (código puro, testado)
  js/geoView.js     mapa (MapLibre)    js/indoorView.js  planta do CD (canvas)
  js/isoView.js     CD em 3D isométrico (Three.js, carregado só quando aberto)
test/             81 testes (node --test)
scripts/          novo-cliente.js, dados-teste.js, fake-device.js, licencas.js
FrotaLogIA.bat    menu do Windows: instala, testa, inicia, cria cliente
```

## Antes de ir para produção

- **Persistência:** tudo fica em memória. Reiniciar o servidor apaga posições, viagens, eventos e estoque.
- **Acesso:** hoje cada empresa tem uma única chave, sem usuários individuais. Use HTTPS (proxy reverso com TLS) para a chave não trafegar em texto puro. Revogue a chave de quem sair com `npm run cliente -- <id> --nova-chave`.
- **LGPD:** a posição de um veículo revela a rotina do motorista e é dado pessoal. Defina base legal, retenção, controle de acesso e registro de consultas.
- **Limite de requisições:** o servidor não limita requisições por cliente. Configure isso no proxy reverso (nginx, Caddy).
- **Provedor de mapa:** o OpenFreeMap e o OSRM públicos servem para desenvolvimento. Em produção, hospede os seus ou contrate um provedor (MapTiler, Stadia, Mapbox...) e revise os termos de uso.
- **Fontes externas:** o navegador busca o Google Fonts e os tiles direto nos provedores, que recebem o IP de quem usa o painel.

O roadmap, com as prioridades, está no `CLAUDE.md`.

## Licença

**Software proprietário. © 2026 Ricardo Biazin. Todos os direitos reservados** (ver `LICENSE`). Usar, copiar, distribuir ou oferecer como serviço depende de autorização por escrito.

As dependências usam licenças permissivas (MIT, ISC, BSD e Apache-2.0), que permitem a venda em produto fechado desde que os avisos sejam mantidos. Os avisos estão em `THIRD_PARTY_NOTICES.md`, gerado por `npm run licencas`. O `npm test` falha se entrar uma dependência copyleft (GPL, AGPL, LGPL...) ou se os avisos ficarem desatualizados.
