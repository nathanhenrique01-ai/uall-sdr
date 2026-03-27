@echo off
:: Este script cria um atalho na Area de Trabalho
:: Execute uma vez e depois use o atalho para iniciar

echo Criando atalho na Area de Trabalho...

set SCRIPT_DIR=%~dp0
set DESKTOP=%USERPROFILE%\Desktop

:: Cria o atalho via PowerShell
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%DESKTOP%\U-All SDR Agent.lnk'); $sc.TargetPath = '%SCRIPT_DIR%INICIAR.bat'; $sc.WorkingDirectory = '%SCRIPT_DIR%'; $sc.IconLocation = 'shell32.dll,21'; $sc.Description = 'U-All SDR Agent - WhatsApp com IA'; $sc.Save()"

if %errorlevel% equ 0 (
    echo.
    echo  Atalho criado com sucesso na Area de Trabalho!
    echo  Procure por: "U-All SDR Agent"
    echo.
    echo  Agora e so dar duplo clique no atalho para iniciar.
) else (
    echo.
    echo  Nao foi possivel criar o atalho automaticamente.
    echo  Crie manualmente: clique direito no INICIAR.bat
    echo  e selecione "Enviar para > Area de Trabalho"
)

echo.
pause
