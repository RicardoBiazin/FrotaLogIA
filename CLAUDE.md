# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório.

## O que é

**FrotaLogIA** (pacote `frotalogia`): sistema de rastreamento de frota em tempo real. Qualquer objeto com posição (caminhão, carro, empilhadeira, outro) é um **ativo** com o mesmo formato. Servidor Node.js (Express + `ws`) recebe posições, mantém o estado em memória e distribui por WebSocket; o frontend (JS puro em módulos ES, sem build) anima os ativos num mapa MapLibre ou numa planta em canvas.

Usuário final: operadores de logística/frota.

**Visão do produto (definida pelo dono em 06/10/2026):** painel de **logística de transporte como um todo**, com todos os veículos da frota na estrada e nos **centros de distribuição (CDs)** em tempo real.
- Ao clicar num veículo, o card mostra **os dados do transporte**: origem e destino, o que leva (carga), peso, volume, remetente e destinatário, além da telemetria.
- No mapa dá para ver a frota inteira ou **dar zoom em cada CD** e ver o que acontece lá dentro: docas, pátio, empilhadeiras e veículos carregando/descarregando.
- Hoje o código cobre a telemetria (posição, status, rastro) e uma planta de galpão fixa. Os dados de transporte e os CDs georreferenciados ainda não existem; ver o Roadmap. Idioma da interface e dos comentários: **português do Brasil**.

## Comandos

```bash
npm install
npm run dev     # node --watch server/index.js  → http://localhost:3000
npm test        # node --test (39 testes; devem passar sempre)
npm run device  # simula um dispositivo externo enviando posições por HTTP
```

Node >= 20.12. **Não adicione dependências nativas** (precisam compilar no Windows). Frontend sem bundler: módulos ES servidos direto de `public/`.

## Arquitetura (fluxo de dados)

```
fonte (HTTP / adaptador / simulador)
  → ingest.js → normalize.js → store.js (estado + rastro + status)
  → evento 'update' → hub.js (agrupa em lotes de BATCH_MS) → WebSocket
  → public/js/ws.js → main.js → AnimatedAsset (interp.js) → geoView.js | indoorView.js
```

- **Todo dado entra por `createIngest`** (`server/ingest.js`). Adaptadores e o simulador também. Não grave direto no store a partir de rotas ou adaptadores.
- `store.js` é o ponto de troca para persistência (mesma interface: `upsert/get/list/trail/remove/sweep` + eventos `update`/`remove`).
- O simulador (`server/sim/`) usa o mesmo caminho dos dados reais; desligue com `SIMULATE=false`.
- Mensagens WS (servidor → cliente): `snapshot`, `batch`, `remove`. Ver `server/hub.js`.

## Contrato de dados (invariantes)

- **Geográfico:** `lat`/`lon` em graus. **Planta:** `espaco` + `x`/`y` em metros, `x` para leste e `y` para o norte, origem no canto inferior esquerdo (o canvas inverte o `y` ao desenhar).
- **`rumo`:** graus, 0 = norte, sentido horário, nos dois modos. `null` na entrada = o store deriva da trajetória.
- **`velocidade`:** km/h. **`ts`:** epoch em ms. **Status:** `movimento` (>= 2 km/h) | `parado` | `offline` (sem posição há `OFFLINE_AFTER_S`; calculado com o relógio do servidor, não do dispositivo).
- Posição com `ts` menor que a armazenada é ignorada. `ts` mais de 5 min no futuro é rejeitado. Epoch abaixo de 10¹¹ é tratado como segundos e convertido para ms.
- `receivedAt` (relógio do servidor) vai para o cliente e é a base do "atualizado há". Mensagem só de status (mesmo `ts`) não pode reiniciar esse relógio.
- Ao trocar entre mapa e planta (`espaco` muda), o rastro recomeça no servidor e no cliente: as coordenadas não se misturam.
- Busca em tabela de sinônimos vinda de entrada externa usa `Object.hasOwn` ("constructor" e "__proto__" já corromperam o `tipo`).
- Nomes de campos de domínio são em português (`tipo`, `rumo`, `velocidade`, `espaco`, `atributos`); nomes de infraestrutura em inglês.
- Tipos válidos estão em `server/normalize.js` (`TIPOS`) e `public/js/icons.js`. Ao criar um tipo novo, atualize os dois, o desenho em `icons.js` e os testes.

## Frontend

- `public/js/interp.js` é **código puro** (sem DOM) e tem testes em `test/interp.test.js`. Mantenha assim; a lógica de animação deve continuar testável.
- Animação: cada `AnimatedAsset` desliza da pose exibida até a nova durante o intervalo típico entre atualizações (calculado pela diferença de `ts`), e projeta por velocidade/rumo por até 3 s se a atualização atrasar. Lacuna > 60 s salta direto.
- O mapa **carrega em paralelo** ao WebSocket: lista, contadores e planta não podem depender do evento `load` do MapLibre (tiles lentos já travaram o app uma vez).
- `geoView.js` atualiza uma fonte GeoJSON a ~30 fps (`setData`). Funciona bem para centenas de ativos; acima de ~2000, migre para deck.gl (`IconLayer`) ou desenhe só os ativos da área visível.
- O card de detalhes flutua sobre o palco; `syncIndoorInsets` em `main.js` afasta a planta dele. Em telas ≤ 820 px o card fica compacto.
- UI: frase em caixa normal, verbos diretos, erros dizem o que houve e como resolver. Cores por tipo e por status estão em `icons.js` e `:root` do CSS. Respeite foco visível e `prefers-reduced-motion`.

## Armadilhas conhecidas

- `SIM_SPEEDUP` (padrão 5) acelera o movimento nas rotas urbanas, mas a `velocidade` informada continua a de cruzeiro. Use `SIM_SPEEDUP=1` para comportamento realista.
- O OSRM público (`router.project-osrm.org`) é só para demonstração; as rotas ficam em `.cache/routes.json` (ignorado no git). Sem rede, o simulador cai para linhas retas.
- O mapa padrão é o Positron do OpenFreeMap (vetorial, sem chave); a CARTO passou a devolver tiles "API KEY REQUIRED" e foi abandonada na v0.2.0. Os rótulos usam uma camada separada de propósito, para que falha de fonte não derrube os ícones; a fonte (`MAP_LABEL_FONT`) precisa existir nos glyphs do estilo.
- **CSP** em `server/app.js`: `script-src 'self'`, sem script inline. Script novo vai em arquivo de `public/`. Provedor de mapa ou de fontes novo pode exigir ajustar `connect-src`/`font-src`.
- **`HOST`:** sem `API_KEY` o servidor escuta só em `127.0.0.1`. Para testar com outra máquina, defina `API_KEY` (ou `HOST=0.0.0.0` conscientemente).
- `MAX_ASSETS` (padrão 10 000) recusa IDs novos acima do teto; atualizar ativo existente continua funcionando.
- **MapLibre GL 6 é distribuído só como módulo ES** (`maplibre-gl.mjs`, sem UMD). O `server/app.js` o serve em `/vendor/maplibre-gl/` e o `geoView.js` o carrega com `import()` dinâmico; o worker é resolvido pela própria URL do módulo, então não mude esse caminho. Não volte para a 5.x: ela tem alerta crítico no `npm audit` (bypass do sanitizador de XSS).
- Fontes (Google Fonts) são opcionais; há fallback para fontes do sistema.
- O adaptador do Traccar foi testado só com payload de exemplo.
- Estado em memória: reiniciar o servidor apaga ativos e rastros.

## Como verificar mudanças

0. A versão fica em `package.json` (e no `package-lock.json`); ela aparece ao lado do nome na interface e em `/api/health`. Incremente a cada alteração.
1. `npm test` deve passar. Teste novo para toda regra nova em `normalize`, `store`, `interp` ou API (`test/api.test.js` sobe o app numa porta aleatória).
2. Para o frontend, suba `npm run dev` e confira no navegador: mapa animando, seleção de ativo (halo, rastro, card), filtros/busca, aba Galpão e tela estreita (~400 px). Se puder usar Playwright, intercepte tiles e fontes externas para um teste determinístico.
3. Para ingestão, use `npm run device` ou `curl`/`Invoke-RestMethod` (ver `README.md`).

## Roadmap (em ordem de prioridade)

1. **Cercas virtuais (geofences).** Polígonos/círculos em `data/geofences.json`. Avaliar na ingestão (entrada/saída por ativo), emitir mensagem WS `{ type: 'event', ... }`, mostrar no mapa e em um painel de alertas. *Aceite:* testes de entrada/saída, histórico dos últimos eventos em `GET /api/events`.
2. **Histórico e replay.** Interface `HistoryStore` (append de posições, consulta por ativo e período) com implementação PostGIS ou TimescaleDB. `GET /api/assets/:id/history?from=&to=` e controle de linha do tempo na UI.
3. **Última posição em Redis + pub/sub**, para rodar mais de uma instância do servidor.
4. **Autenticação e multi-cliente.** Proteger também a leitura (API e WS), com filtros por frota/cliente.
5. **Escala.** Filtro por área visível no WS (`{ type: 'viewport', bbox }`) e deck.gl para milhares de ativos; virtualizar a lista lateral.
6. **Mais fontes.** Ingestão MQTT e adaptadores em `server/adapters/` (Sascar, Omnilink, Samsara, Geotab, FMS de fábrica). Cada adaptador só converte para o formato do ativo e chama `ingest`.
7. **Planta real.** Carregar plantas de GeoJSON/CAD, vários espaços com seletor, integração com RTLS (UWB/BLE) e calibração.
8. **Alertas operacionais.** Sem sinal por mais de N minutos, parado além do esperado, excesso de velocidade; relatórios por período.
9. **LGPD.** Retenção configurável, anonimização de rastros antigos, registro de quem consultou o quê.

Antes de grandes mudanças (itens 2 a 5), proponha um plano curto e confirme com o usuário.
