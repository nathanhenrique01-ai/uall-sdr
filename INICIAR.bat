@echo off
title U-All SDR Agent
color 0B

echo.
echo  ========================================
echo   U-All SDR Agent - Iniciando...
echo  ========================================
echo.

cd /d "%~dp0"

:: Verifica se Node.js esta instalado
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Node.js nao encontrado!
    echo  Instale em: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Instala dependencias se necessario
if not exist "node_modules" (
    echo  Instalando dependencias pela primeira vez...
    echo  Isso pode levar alguns minutos...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo  [ERRO] Falha ao instalar dependencias.
        pause
        exit /b 1
    )
    echo.
    echo  Dependencias instaladas com sucesso!
    echo.
)

:: Verifica se .env existe
if not exist ".env" (
    echo  [ERRO] Arquivo .env nao encontrado!
    echo  Copie .env.example para .env e configure sua chave API.
    echo.
    pause
    exit /b 1
)

echo  Iniciando servidor + WhatsApp...
echo  O dashboard vai abrir no navegador automaticamente.
echo.
echo  Para encerrar: feche esta janela ou pressione Ctrl+C
echo  ========================================
echo.

node index.js

pause
