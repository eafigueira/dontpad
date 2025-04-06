@echo off
setlocal

:: REQUISITOS npm install -g localtunnel
:: CONFIGURAÇÃO
set PORT=8080
set SUBDOMAIN=eafigueira

echo Iniciando servidor local...
start "Node Server" cmd /k "node server.js"

timeout /t 2 >nul

echo Abrindo túnel com LocalTunnel...
start "LocalTunnel" cmd /k "lt --port %PORT% --subdomain %SUBDOMAIN%"

timeout /t 5 >nul

echo Obtendo senha do túnel (Tunnel Password)...
for /f "delims=" %%I in ('curl -s https://loca.lt/mytunnelpassword') do set TUNNEL_PWD=%%I

echo.
echo ======================================
echo Seu app está disponível em:
echo   https://%SUBDOMAIN%.loca.lt
echo.
echo Tunnel Password (cole no navegador):
echo   %TUNNEL_PWD%
echo ======================================

pause
