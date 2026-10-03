#!/bin/bash
# Click — Standalone AI Assistant Launcher (Linux/macOS)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  CLICK - Standalone AI Assistant"
echo "============================================"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python3 not found! Please install Python 3.10+"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found! Please install Node.js 18+"
    exit 1
fi

# Install Python dependencies
echo "[1/3] Checking Python dependencies..."
pip3 install -r backend/requirements.txt --quiet 2>/dev/null
echo "      Done."

# Install Electron dependencies
echo "[2/3] Checking Electron dependencies..."
cd electron && npm install --silent 2>/dev/null && cd ..
echo "      Done."

# Start Python backend in background
echo "[3/3] Starting Click..."
echo ""
echo "  Backend:  http://127.0.0.1:8765"
echo "  Electron: Starting..."
echo ""

python3 backend/server.py &
BACKEND_PID=$!

# Wait for backend
sleep 3

# Start Electron
cd electron
npx electron .
cd ..

# Cleanup
kill $BACKEND_PID 2>/dev/null
echo ""
echo "Click closed."
