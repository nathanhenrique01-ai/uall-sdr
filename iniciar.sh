#!/bin/bash
# U-All SDR Agent - Iniciar (Linux/Mac)

cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "  U-All SDR Agent - Iniciando..."
echo "========================================"
echo ""

# Verifica Node.js
if ! command -v node &> /dev/null; then
    echo "[ERRO] Node.js nao encontrado!"
    echo "Instale em: https://nodejs.org/"
    exit 1
fi

# Instala dependencias se necessario
if [ ! -d "node_modules" ]; then
    echo "Instalando dependencias pela primeira vez..."
    npm install
    echo ""
fi

# Verifica .env
if [ ! -f ".env" ]; then
    echo "[ERRO] Arquivo .env nao encontrado!"
    echo "Copie .env.example para .env e configure."
    exit 1
fi

echo "Iniciando servidor + WhatsApp..."
echo "O dashboard vai abrir no navegador automaticamente."
echo ""
echo "Para encerrar: Ctrl+C"
echo "========================================"
echo ""

node index.js
