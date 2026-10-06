@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Pagina de codigo UTF-8 (acentos da saida do Node). O <nul importa: o chcp le a
rem entrada padrao e engoliria a primeira resposta digitada. A original volta no fim.
for /f "tokens=2 delims=:" %%c in ('chcp ^<nul') do set "CP_ORIG=%%c"
set "CP_ORIG=%CP_ORIG: =%"
set "CP_ORIG=%CP_ORIG:.=%"
chcp 65001 >nul <nul
title FrotaLogIA
cd /d "%~dp0"

rem ============================================================================
rem  FrotaLogIA - instala, testa e inicia o sistema.
rem  Uso: FrotaLogIA.bat            (menu)
rem       FrotaLogIA.bat 1..6       (escolhe a opcao direto)
rem  Variavel NO_BROWSER=1 nao abre o navegador (uso em testes automaticos).
rem ============================================================================

rem --- Porta: variavel de ambiente, senao o .env, senao 3000 ---
if not defined PORT (
  if exist ".env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do set "PORT=%%b"
  )
)
if not defined PORT set "PORT=3000"
set "URL=http://localhost:%PORT%"
rem Checagens usam 127.0.0.1: no Windows "localhost" tenta antes o IPv6 (::1), onde o
rem servidor nao escuta, e a espera estoura o tempo limite da checagem.
set "HEALTH=http://127.0.0.1:%PORT%/api/health"

call :verificar_node || goto :erro_fim

set "OPCAO=%~1"
if defined OPCAO goto :executar

:menu
echo.
echo  ================================================
echo    FrotaLogIA  -  logistica em tempo real
echo  ================================================
if exist "data\clientes.json" (
  echo    Modo: COM CHAVE  ^(data\clientes.json existe^)
) else (
  echo    Modo: DEMONSTRACAO, sem chave
)
echo.
echo    1  Iniciar  ^(instala, testa, sobe e abre o navegador^)
echo    2  Iniciar acelerado  ^(simulador 20x mais rapido^)
echo    3  Criar cliente e chave de acesso
echo    4  Rodar os testes automaticos
echo    5  Enviar dados de teste pela API  ^(servidor ligado^)
echo    6  Voltar ao modo demonstracao  ^(remove as chaves^)
echo    0  Sair
echo.
set "OPCAO="
set /p "OPCAO=  Escolha [1]: "
if not defined OPCAO set "OPCAO=1"

:executar
if "%OPCAO%"=="1" goto :iniciar
if "%OPCAO%"=="2" goto :acelerado
if "%OPCAO%"=="3" goto :cliente
if "%OPCAO%"=="4" goto :testes
if "%OPCAO%"=="5" goto :dados
if "%OPCAO%"=="6" goto :demo
if "%OPCAO%"=="0" goto :fim
echo  Opcao invalida: %OPCAO%
set "OPCAO="
goto :voltar

rem ---------------------------------------------------------------------------
:acelerado
set "SIM_SPEEDUP=20"
echo  Simulador acelerado: 20x.

:iniciar
call :ja_rodando
if not errorlevel 1 (
  echo.
  echo  O FrotaLogIA ja esta rodando em %URL%. Abrindo o navegador.
  if not "%NO_BROWSER%"=="1" start "" "%URL%"
  goto :fim
)
call :instalar || goto :erro_fim
call :rodar_testes
if errorlevel 1 (
  echo.
  echo  Alguns testes falharam. O sistema pode ter problemas.
  set "SEGUIR="
  set /p "SEGUIR=  Iniciar mesmo assim? (s/N): "
  if /i not "!SEGUIR!"=="s" goto :erro_fim
)
echo.
echo  Iniciando em %URL%  ^(Ctrl+C para parar^)
if exist "data\clientes.json" echo  O navegador vai pedir a chave de acesso do cliente.
echo.
if not "%NO_BROWSER%"=="1" (
  rem Abre o navegador quando o servidor responder, sem travar este terminal.
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
    "for($i=0;$i -lt 60;$i++){try{Invoke-RestMethod '%HEALTH%' -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break}catch{Start-Sleep -Seconds 1}}"
)
node server\index.js
echo.
echo  Servidor encerrado.
goto :fim

rem ---------------------------------------------------------------------------
:cliente
call :instalar || goto :erro_fim
echo.
echo  Id do cliente: minusculas, numeros, - e _ ^(ex.: acme^).
set "CID="
set /p "CID=  Id: "
if not defined CID goto :voltar
set "CNOME="
set /p "CNOME=  Nome da empresa: "
if not defined CNOME set "CNOME=%CID%"
set "CDEMO="
set /p "CDEMO=  Usar os CDs de exemplo da Grande Florianopolis? (S/n): "
set "FLAG=--demo"
if /i "%CDEMO%"=="n" set "FLAG="
if exist "data\clientes.json" (
  findstr /c:"\"id\": \"%CID%\"" "data\clientes.json" >nul && set "FLAG=%FLAG% --nova-chave"
)
echo.
node scripts\novo-cliente.js "%CID%" "%CNOME%" %FLAG% <nul
if errorlevel 1 goto :erro_fim
echo.
echo  Guarde a chave acima. Reinicie o servidor ^(opcao 1^) para valer.
goto :voltar_pausa

rem ---------------------------------------------------------------------------
:testes
call :instalar || goto :erro_fim
call :rodar_testes
if errorlevel 1 (echo  Resultado: HA FALHAS.) else (echo  Resultado: todos os testes passaram.)
goto :voltar_pausa

rem ---------------------------------------------------------------------------
:dados
set "CHAVE="
if exist "data\clientes.json" (
  set /p "CHAVE=  Chave de acesso do cliente: "
)
echo.
node scripts\dados-teste.js !CHAVE! <nul
goto :voltar_pausa

rem ---------------------------------------------------------------------------
:demo
if not exist "data\clientes.json" (
  echo  Ja esta no modo demonstracao.
) else (
  set "CONF="
  set /p "CONF=  Remover data\clientes.json e todas as chaves? (s/N): "
  if /i "!CONF!"=="s" (
    del "data\clientes.json"
    echo  Pronto. Reinicie o servidor ^(opcao 1^) para valer.
  ) else (
    echo  Nada foi removido.
  )
)
goto :voltar_pausa

rem --- Fim de uma opcao: no menu, espera uma tecla e volta; com argumento, encerra ---
:voltar_pausa
if "%~1"=="" pause
:voltar
if "%~1"=="" goto :menu
goto :fim

rem ===========================================================================
rem  Sub-rotinas
rem ===========================================================================

:verificar_node
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nao encontrado. Instale a versao LTS em https://nodejs.org
  echo  e abra este arquivo de novo.
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo  Node.js %%v e antigo demais. O FrotaLogIA precisa da versao 20.12 ou superior.
  exit /b 1
)
exit /b 0

:instalar
echo.
echo  Conferindo dependencias...
call npm install --no-audit --no-fund --loglevel=error <nul
if errorlevel 1 (
  echo  Falha ao instalar as dependencias. Confira a conexao com a internet.
  exit /b 1
)
exit /b 0

:rodar_testes
echo.
echo  Rodando os testes automaticos...
call npm test --silent <nul > "%TEMP%\frotalogia-testes.log" 2>&1
set "RC=%ERRORLEVEL%"
for /f "tokens=2,3" %%a in ('findstr /r /c:"^.*tests [0-9]" /c:"^.*pass [0-9]" /c:"^.*fail [0-9]" "%TEMP%\frotalogia-testes.log"') do echo    %%a %%b
if not "%RC%"=="0" (
  echo  Detalhes em %TEMP%\frotalogia-testes.log
  exit /b 1
)
exit /b 0

:ja_rodando
powershell -NoProfile -Command "try{Invoke-RestMethod '%HEALTH%' -TimeoutSec 2 | Out-Null; exit 0}catch{exit 1}"
exit /b %ERRORLEVEL%

:erro_fim
echo.
if "%~1"=="" pause
call :restaurar_cp
endlocal
exit /b 1

:fim
call :restaurar_cp
endlocal
exit /b 0

:restaurar_cp
if defined CP_ORIG chcp %CP_ORIG% >nul <nul
exit /b 0
