# FrotaLogIA

Rastreamento em tempo real de **qualquer objeto com posição**: caminhões, carros, empilhadeiras, reboques, contêineres. Todos usam o mesmo formato de dado; só o ícone e as regras mudam por tipo.

- **Mapa** (MapLibre GL) para ativos com GPS, com animação suave entre atualizações.
- **Planta interna** (canvas) para ativos sem GPS, como empilhadeiras em galpão (tags UWB/BLE/Wi‑Fi). Coordenadas em metros.
- Servidor Node.js com **WebSocket**, API REST de ingestão e **simulador** embutido (11 ativos), para você ver tudo funcionando antes de ligar dados reais.

## Começando

Requisitos: **Node.js 20.12 ou superior**.

```bash
npm install
npm run dev        # servidor com reinício automático
# abra http://localhost:3000 (sem API_KEY, só esta máquina acessa; ver HOST)
```

Na primeira execução o simulador busca o traçado real das ruas no OSRM e guarda em `.cache/routes.json`. Se o OSRM estiver inacessível, ele usa linhas retas e o app continua funcionando.

Outros comandos: `npm start` (sem reinício automático) e `npm test` (testes).

## Usando com o Claude Code no VS Code

1. Abra a pasta no VS Code (`code .`) e aceite instalar as extensões recomendadas, incluindo a do Claude Code.
2. No terminal integrado, rode `claude` na raiz do projeto. O arquivo `CLAUDE.md` já explica a arquitetura, as convenções e o roadmap.
3. Um bom primeiro pedido: *"Leia o CLAUDE.md, rode `npm install` e `npm test`, e me confirme que tudo passa. Depois implemente o item 1 do roadmap (cercas virtuais)."*

## Formato do ativo

Posição geográfica:

```json
{ "id": "TRK-042", "nome": "Caminhão 42", "tipo": "caminhao",
  "lat": -27.59, "lon": -48.55, "rumo": 135, "velocidade": 62,
  "timestamp": "2026-10-06T14:32:10Z" }
```

Posição em planta (ambiente interno):

```json
{ "id": "EMP-001", "tipo": "empilhadeira", "espaco": "galpao-1",
  "x": 21.4, "y": 11.5, "rumo": 90, "velocidade": 8 }
```

| Campo | Regra |
|---|---|
| `id` | Obrigatório, até 64 caracteres. Identifica o ativo. |
| `tipo` | `caminhao`, `carro`, `empilhadeira` ou `outro`. Aceita sinônimos (`truck`, `car`, `forklift`...). Desconhecido vira `outro`. |
| `lat`, `lon` | Graus (WGS84). Obrigatórios fora de planta. |
| `espaco`, `x`, `y` | Planta interna: `x` para leste e `y` para o norte, em metros, origem no canto inferior esquerdo. |
| `rumo` | Graus, 0 = norte, sentido horário. **Opcional:** se faltar, o servidor deriva da trajetória. |
| `velocidade` | km/h. Acima de 2 km/h conta como "em movimento". |
| `timestamp` (ou `ts`) | ISO 8601 ou epoch em ms ou em segundos (valor abaixo de 10¹¹ é tratado como segundos). Padrão: hora de chegada. Posições mais antigas que a última já recebida são ignoradas. |
| `atributos` | Objeto livre, até 2 KB em UTF-8 (placa, motorista, carga...). |

Um ativo sem novas posições por `OFFLINE_AFTER_S` segundos (60 por padrão) aparece como **sem sinal**.

## API

| Método e caminho | O que faz |
|---|---|
| `POST /api/positions` | Recebe um objeto ou uma lista (até 1000). Responde `202` com `{ accepted, rejected: [{ index, erro }] }`. |
| `POST /api/ingest/traccar` | Recebe o encaminhamento de posições do [Traccar](https://www.traccar.org). |
| `GET /api/assets?tipo=&espaco=` | Lista os ativos com a última posição. |
| `GET /api/assets/:id` e `/:id/trail` | Um ativo e seu rastro recente. |
| `DELETE /api/assets/:id` | Remove um ativo. |
| `GET /api/spaces`, `/api/config`, `/api/health` | Plantas, configuração do cliente e saúde (as duas últimas trazem a `versao`). |
| `WS /ws` | Snapshot ao conectar e depois lotes de atualizações. |

Se `API_KEY` estiver definida, os endpoints de escrita exigem o header `x-api-key`. Os ativos devolvidos trazem `receivedAt` (epoch em ms, relógio do servidor), base do "atualizado há".

### Enviando uma posição de teste

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/positions `
  -ContentType 'application/json' `
  -Body '{"id":"MEU-01","tipo":"caminhao","lat":-27.59,"lon":-48.55,"velocidade":40}'
```

Bash:

```bash
curl -X POST http://localhost:3000/api/positions \
  -H 'content-type: application/json' \
  -d '{"id":"MEU-01","tipo":"caminhao","lat":-27.59,"lon":-48.55,"velocidade":40}'
```

Para um dispositivo que se move continuamente, use `npm run device` (ou `node scripts/fake-device.js MEU-02 carro`).

### Traccar

No `traccar.xml`, aponte o encaminhamento de posições para o servidor:

```xml
<entry key='forward.enable'>true</entry>
<entry key='forward.json'>true</entry>
<entry key='forward.url'>http://SEU_SERVIDOR:3000/api/ingest/traccar</entry>
```

A categoria do dispositivo no Traccar (`truck`, `car`...) vira o `tipo`, e a velocidade em nós é convertida para km/h. O adaptador foi testado com um payload de exemplo; confirme o formato com a sua versão do Traccar.

## Como a animação fica suave

Os dados chegam a cada 2–30 s, mas a tela atualiza 60 vezes por segundo. Em `public/js/interp.js`, cada ativo desliza da posição exibida até a nova durante o intervalo típico entre atualizações; o rumo gira pelo caminho mais curto. Se a próxima posição atrasar, o ícone projeta o movimento por velocidade e rumo por até 3 s. Ativos parados aparecem como ponto (sem direção) e ativos sem sinal como contorno cinza.

## Configuração (`.env`)

Copie `.env.example` para `.env`. Todas as variáveis são opcionais.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP e WebSocket. |
| `HOST` | `127.0.0.1` sem `API_KEY`; `0.0.0.0` com | Interface de rede. Sem chave, só esta máquina acessa; para receber de outra máquina (ex.: Traccar), defina `API_KEY`. |
| `API_KEY` | vazio | Exige `x-api-key` nas rotas de escrita. |
| `SIMULATE` | `true` | Liga o simulador. Desligue ao usar dados reais. |
| `SIM_SPEEDUP` | `5` | Aceleração do tempo nas rotas urbanas (1 = tempo real). |
| `OSRM_URL` | servidor público | O público serve só para demonstração. |
| `MAP_STYLE_URL` | vazio | `style.json` do MapLibre. Vazio usa o Positron do [OpenFreeMap](https://openfreemap.org). |
| `MAP_LABEL_FONT` | `Noto Sans Bold` | Fonte dos rótulos; precisa existir no servidor de glyphs do estilo. |
| `OFFLINE_AFTER_S` | `60` | Segundos sem sinal até virar "sem sinal". |
| `TRAIL_MAX` | `300` | Pontos de rastro por ativo. |
| `BATCH_MS` | `250` | Agrupamento das atualizações enviadas ao navegador. |
| `MAX_ASSETS` | `10000` | Máximo de ativos distintos. Acima disso, IDs novos são recusados (protege a memória). |

## Estrutura

```
server/
  index.js        inicialização (HTTP + WebSocket + simulador)
  app.js          API REST e arquivos estáticos
  hub.js          WebSocket: snapshot e lotes
  normalize.js    validação do formato do ativo
  store.js        última posição, rastro e status (troque por Redis/PostGIS)
  ingest.js       único caminho de entrada de dados
  spaces.js       plantas dos ambientes internos
  adapters/       conversores de fontes externas (Traccar)
  sim/            simulador (rotas, OSRM, agentes)
public/
  index.html, css/style.css
  js/main.js      orquestra dados, animação e interface
  js/interp.js    interpolação (código puro, testado)
  js/geoView.js   mapa (MapLibre)    js/indoorView.js  planta (canvas)
test/             39 testes (node --test)
scripts/          fake-device.js
```

## Antes de ir para produção

- **LGPD:** a posição de um veículo revela a rotina do motorista e é dado pessoal. Defina base legal, retenção, controle de acesso e registro de consultas.
- **Provedor de mapa:** o OpenFreeMap e o servidor OSRM públicos servem para desenvolvimento. Em produção, hospede os seus ou contrate um provedor (MapTiler, Stadia, Mapbox...) e revise os termos de uso. (Os tiles públicos da CARTO, usados até a v0.1, passaram a exigir chave.)
- **Autenticação:** hoje só a escrita é protegida por chave; a leitura (API e WebSocket) é aberta para quem alcança o servidor. Não exponha à internet sem um proxy com autenticação.
- **HTTPS e limite de requisições:** o servidor fala HTTP puro e não limita requisições por cliente. Em produção, ponha-o atrás de um proxy reverso (nginx, Caddy) com TLS e rate limiting.
- **Fontes externas:** o navegador busca o Google Fonts e os tiles do mapa direto nos provedores, que recebem o IP de quem usa o painel. Para LGPD estrita, hospede ambos.
- **Persistência:** o armazenamento é em memória; reiniciar o servidor apaga posições e rastros.

O roadmap detalhado, com critérios de aceite, está no `CLAUDE.md`.
