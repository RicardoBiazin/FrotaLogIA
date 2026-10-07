# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório.

## O que é

**FrotaLogIA** (pacote `frotalogia`): sistema de rastreamento de frota em tempo real. Qualquer objeto com posição (caminhão, carro, empilhadeira, outro) é um **ativo** com o mesmo formato. Servidor Node.js (Express + `ws`) recebe posições, mantém o estado em memória e distribui por WebSocket; o frontend (JS puro em módulos ES, sem build) anima os ativos num mapa MapLibre ou numa planta em canvas.

Usuário final: operadores de logística/frota.

**Visão do produto (definida pelo dono em 06/10/2026):** painel de **logística de transporte como um todo**, com todos os veículos da frota na estrada e nos **centros de distribuição (CDs)** em tempo real.
- Ao clicar num veículo, o card mostra **os dados do transporte**: origem e destino, o que leva (carga), peso, volume, remetente e destinatário, além da telemetria.
- No mapa dá para ver a frota inteira ou **dar zoom em cada CD** e ver o que acontece lá dentro: docas, pátio, empilhadeiras e veículos carregando/descarregando.
- **Cada cliente (empresa) tem a própria rede** em tempo real e só enxerga a dela. O cliente `demo` traz uma rede de exemplo na Grande Florianópolis (`server/demo.js`).
- Desde a v0.3.0 existem: clientes com chave, viagens (dados do transporte), CDs no mapa com cerca e planta, eventos de entrada/saída e o painel do CD. Idioma da interface e dos comentários: **português do Brasil**.

## Comandos

```bash
npm install
npm run dev     # node --watch server/index.js  → http://localhost:3000
npm test        # node --test (89 testes; devem passar sempre)
npm run dados-teste [-- CHAVE]   # manda veículo, viagem e palete de teste pela API e confere
npm run licencas  # regenera THIRD_PARTY_NOTICES.md e barra licença copyleft
npm run cliente -- <id> "<nome>" [--demo]   # cria cliente em data/clientes.json e mostra a chave uma vez
npm run device  # simula um dispositivo externo enviando posições por HTTP
```

No Windows, `FrotaLogIA.bat` faz tudo por menu (aceita a opção como argumento: `FrotaLogIA.bat 4`; `NO_BROWSER=1` não abre o navegador). Ele **precisa de CRLF** (`.gitattributes`); `chcp`, `npm` e `node` rodam com `<nul`, senão engolem a resposta digitada no `set /p` seguinte; checagens de saúde usam `127.0.0.1`, porque `localhost` tenta antes o IPv6 e estoura o tempo. Mexeu no `.bat`: teste as opções com entrada redirecionada de arquivo.

Node >= 20.12. **Não adicione dependências nativas** (precisam compilar no Windows).

**Licença: proprietária** (`LICENSE`, © Ricardo Biazin; o produto será vendido). Só entram dependências com licença permissiva (MIT, ISC, BSD, Apache-2.0); nada de GPL, AGPL, LGPL, MPL ou SSPL, nem código copiado de projetos com essas licenças. Ao adicionar ou atualizar dependência, rode `npm run licencas` e commite o `THIRD_PARTY_NOTICES.md` (o teste `test/licencas.test.js` cobra os dois). Serviço externo novo (mapa, rotas, fontes) também entra lá, com os termos de uso comercial. Frontend sem bundler: módulos ES servidos direto de `public/`.

## Arquitetura (fluxo de dados)

```
chave (x-api-key / auth no WS) → tenants.js → cliente
fonte (HTTP / adaptador / simulador)
  → ingest.position(cliente, …) → normalize.js → cerca dos CDs (centros.js) → store.js
  → ingest.trip(cliente, …)     → viagens.js (ViagemStore)
  → ingest.stock(cliente, …)    → estoque.js (EstoqueStore; endereço validado contra a planta)
  → entrada/saída de CD          → eventos.js (EventLog)
  → hub.js (por cliente, lotes de BATCH_MS) → WebSocket
  → public/js/ws.js → main.js → interp.js + logistica.js → geoView.js | indoorView.js
```

- **Multi-cliente é a base, não um filtro.** Store, viagens, eventos e o hub são separados por `cliente`; toda rota de dados passa por `requireTenant` (`server/app.js`) e todo WS começa com `{ type: 'auth', chave }`. Nunca leia ou grave sem o cliente; teste o isolamento (`test/api.test.js`) ao mexer em rota ou mensagem.
- Clientes vêm de `data/clientes.json` (ignorado no git; só o **hash** SHA-256 da chave). Sem o arquivo existe só o `demo`: com `API_KEY` a chave dele é essa; sem, o acesso é aberto e o servidor escuta só em 127.0.0.1.
- **Todo dado entra por `createIngest`** (`server/ingest.js`): `position` e `trip`. Adaptadores e o simulador também. Não grave direto nos stores a partir de rotas ou adaptadores.
- `store.js` e `viagens.js` são os pontos de troca para persistência (mesma interface + eventos `update`/`remove`).
- O simulador (`server/sim/`) gera posições **e viagens** (cada ida/volta da rota é uma viagem) para `SIM_CLIENTE` (vazio: o `demo` ou o primeiro cliente com `"centros": "demo"`); desligue com `SIMULATE=false`.
- Mensagens WS (servidor → navegador): `snapshot` (com `cliente`, `assets`, `viagens` ativas e `eventos`), `batch` (`assets` + `viagens`), `remove`, `evento`. Chave recusada fecha com 4401. Ver `server/hub.js`.

## Contrato de dados (invariantes)

- **Geográfico:** `lat`/`lon` em graus. **Planta:** `espaco` + `x`/`y` em metros, `x` para leste e `y` para o norte, origem no canto inferior esquerdo (o canvas inverte o `y` ao desenhar).
- **`rumo`:** graus, 0 = norte, sentido horário, nos dois modos. `null` na entrada = o store deriva da trajetória.
- **`velocidade`:** km/h. **`ts`:** epoch em ms. **Status:** `movimento` (>= 2 km/h) | `parado` | `offline` (sem posição há `OFFLINE_AFTER_S`; calculado com o relógio do servidor, não do dispositivo).
- Posição com `ts` menor que a armazenada é ignorada. `ts` mais de 5 min no futuro é rejeitado. Epoch abaixo de 10¹¹ é tratado como segundos e convertido para ms.
- `receivedAt` (relógio do servidor) vai para o cliente e é a base do "atualizado há". Mensagem só de status (mesmo `ts`) não pode reiniciar esse relógio.
- Ao trocar entre mapa e planta (`espaco` muda), o rastro recomeça no servidor e no cliente: as coordenadas não se misturam.
- Busca em tabela de sinônimos vinda de entrada externa usa `Object.hasOwn` ("constructor" e "__proto__" já corromperam o `tipo`).
- **CD** (`server/centros.js`): ponto + `raioM` (cerca) + `planta` opcional. Veículo de rua dentro do raio recebe `cd`; ele só sai depois de `raio + max(150 m, 50%)` (histerese: a estrada perto da borda fazia o GPS entrar e sair em sequência). Ativo de planta usa `espaco` = id do CD.
- **Estoque** (`server/estoque.js` + `public/js/estoque.js`): endereço `RUA-POSIÇÃO-NÍVEL` (`A-03-2`), uma posição-palete por endereço, `quantidade: 0` libera. Prateleira da planta = rua, com `id`, `posicoes` (ao longo do lado maior) e `niveis` (1 = chão). A validação de endereço mora em `public/js/estoque.js` e é importada pelo servidor: uma regra só para os dois lados. O estoque completo vem por `GET /api/centros/:cd/estoque`; o WS manda só as posições alteradas no `batch` (`removido: true` = liberada).
- **Atraso** (`atrasoMs` em `public/js/logistica.js`): `previsao` é o prazo combinado e **não** é recalculado; `estimativa` é a chegada prevista atualizada. Atrasada = `max(agora, estimativa) - previsao >= 1 min`, só em `planejada | carregando | em_transito`. O simulador fixa o prazo na saída e refaz só a estimativa; quem recalcular `previsao` no caminho apaga todos os atrasos.
- **Demonstração** (`POST/DELETE /api/demo/veiculos`): só para o cliente do simulador (`demo.sim.cliente`), até `MAX_EXTRAS` (100) veículos incluídos, que nascem pelo mesmo `spawn` dos fixos (`server/sim/index.js`).
- **Cadastro de CD** (`server/cadastro.js` + `public/js/planta.js`): o CD criado pela tela guarda só as medidas (`galpao`); a planta é sempre gerada por `gerarPlanta` (mesma função na pré-visualização e no servidor). Gravado em `data/centros/<cliente>.json` com troca atômica (tmp + rename). Os CDs entram na **mesma lista** `tenant.centros` usada pela cerca (alterada no lugar). Editar/excluir só vale para `cadastrado: true`; os da configuração respondem 409. Mudança avisa os navegadores (`{ type: 'centros' }`) e limpa do estoque os endereços que sumiram (`estoque.limparCd`).
- **Viagem** (`server/viagens.js`): `status` em `planejada | carregando | em_transito | descarregando | entregue | cancelada`; peso em kg, volume em m³, valor em R$. O navegador guarda só as ativas, indexadas por veículo (`applyViagem` em `logistica.js`).
- Nomes de campos de domínio são em português (`tipo`, `rumo`, `velocidade`, `espaco`, `atributos`); nomes de infraestrutura em inglês.
- Tipos válidos estão em `server/normalize.js` (`TIPOS`) e `public/js/icons.js`. Ao criar um tipo novo, atualize os dois, o desenho em `icons.js` e os testes.

## Frontend

- `public/js/interp.js`, `public/js/logistica.js` e `public/js/estoque.js` são **código puro** (sem DOM), testados em `test/interp.test.js` e `test/logistica.test.js`. Regra nova de tela (resumo de CD, busca, formatação) vai para `logistica.js`, com teste.
- **Vista 3D** (`public/js/isoView.js`): Three.js com câmera ortográfica isométrica e controles próprios (sem os addons do Three, que importam `'three'` por nome e exigiriam import map inline, barrado pela CSP). O Three.js é servido de `node_modules/three/build` em `/vendor/three/` e carregado por `import()` só ao abrir o 3D. Cena: X = leste, Z = sul (= -y da planta), Y = altura; rumo vira `rotation.y = -rumo`. Paletes são `InstancedMesh` (base, caixa, faixa e etiqueta no topo) reconstruídos quando o estoque, a busca ou a seleção mudam; caixas invisíveis por posição tornam clicável também a posição vazia. Estilo "maquete" (v0.7.0): paredes azuis em corte calculado pela direção da câmera (`#cutaway`: normal da parede · direção da câmera > 0,15 → parede baixa, e a verga e as portas da parede sul somem junto), sombras (`PCFSoftShadowMap`), marcadores em gota, painéis HTML sobre a cena (`.iso-kpis`, `.iso-docas`, atualizados em `updateIsoPaineis`). Não use a marca/nome de referências visuais de terceiros; o baú leva a marca FrotaLogIA.
- Na planta, cada prateleira é desenhada por posição, com a cor pelos níveis ocupados (`OCUPACAO_FILL` em `indoorView.js`); a busca acende as posições em amarelo. Clique: veículo bem em cima ganha, senão a posição da prateleira.
- Na planta, os veículos de rua no pátio do CD aparecem encostados nas docas (`portas`, na ordem do id); os que sobram viram uma linha "Aguardando doca".
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

Na v0.8.0: cadastro de CD pela tela. Na v0.7.0: 3D em estilo maquete, indicadores e docas sobre a cena, atributos de operação da empilhadeira. Na v0.6.0: CD em 3D isométrico. Na v0.5.0: atrasos no mapa, na lista e no card; inclusão de veículos na demonstração. Feito na v0.3.0: cerca circular dos CDs com eventos (`GET /api/eventos`, WS `evento`) e autenticação por cliente na leitura e na escrita. Na v0.4.0: estoque endereçado nas prateleiras (rua-posição-nível), com busca de produto.

1. **Persistência e cadastro.** Banco (PostgreSQL/PostGIS) para clientes, CDs, viagens e eventos; tela de cadastro de CDs e de clientes no lugar do `data/clientes.json`. Hoje reiniciar apaga tudo.
2. **Usuários por cliente.** Hoje é uma chave por empresa; o próximo passo é usuário/senha (ou SSO) com papéis (operador, gestor) e registro de quem consultou o quê (LGPD).
3. **Integração com TMS/ERP e CT-e.** Receber viagens do sistema do cliente (webhook, importação de XML do CT-e/MDF-e) em vez de só `POST /api/viagens`.
4. **Histórico e replay.** Interface `HistoryStore` (append de posições, consulta por ativo e período) com implementação PostGIS ou TimescaleDB. `GET /api/assets/:id/history?from=&to=` e controle de linha do tempo na UI.
5. **Última posição em Redis + pub/sub**, para rodar mais de uma instância do servidor.
6. **Escala.** Filtro por área visível no WS (`{ type: 'viewport', bbox }`) e deck.gl para milhares de ativos; virtualizar a lista lateral.
7. **Mais fontes.** Ingestão MQTT e adaptadores em `server/adapters/` (Sascar, Omnilink, Samsara, Geotab, FMS de fábrica). Cada adaptador só converte para o formato do ativo e chama `ingest`.
8. **Estoque de verdade (WMS).** Integração com o WMS do cliente, mais de um palete por endereço (picking fracionado), histórico de movimentação por endereço e inventário.
9. **Planta real e docas.** Plantas de GeoJSON/CAD, cercas em polígono, doca atribuída pelo WMS/RTLS (hoje é pela ordem do id) e integração com RTLS (UWB/BLE).
10. **Alertas operacionais.** Atraso na previsão, sem sinal por mais de N minutos, parado além do esperado, tempo de pátio, excesso de velocidade; relatórios por período.
11. **LGPD.** Retenção configurável, anonimização de rastros antigos, registro de quem consultou o quê.

Antes de grandes mudanças (itens 1 a 6), proponha um plano curto e confirme com o usuário.
