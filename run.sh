#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Farben
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Voraussetzungen ---
command -v docker >/dev/null 2>&1 || error "Docker ist nicht installiert."
docker info >/dev/null 2>&1    || error "Docker-Daemon läuft nicht oder keine Berechtigung."

# --- Claude-Code Container-Image bauen (falls nicht vorhanden) ---
if ! docker image inspect claude-code:latest >/dev/null 2>&1; then
    info "Baue claude-code Container-Image..."
    docker build -t claude-code:latest -f docker/Dockerfile docker/
else
    info "claude-code Image vorhanden — überspringe Build."
fi

# --- .env prüfen / erstellen ---
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        warn ".env nicht gefunden — erstelle aus .env.example"
        cp .env.example .env
    else
        warn ".env nicht gefunden — erstelle leere .env"
        touch .env
    fi
fi

# .env laden
set -a
source .env 2>/dev/null || true
set +a

# --- Claude-Authentifizierung prüfen ---
HAS_SUBSCRIPTION=false
HAS_API_KEY=false

if [ -d "$HOME/.claude" ] && [ -f "$HOME/.claude.json" ]; then
    HAS_SUBSCRIPTION=true
fi

if [ -n "${YOLO_ANTHROPIC_API_KEY:-}" ]; then
    HAS_API_KEY=true
fi

if [ "$HAS_SUBSCRIPTION" = false ] && [ "$HAS_API_KEY" = false ]; then
    error "Keine Claude-Authentifizierung gefunden!
    Option A: Subscription-Auth — ~/.claude/ und ~/.claude.json müssen existieren
    Option B: API-Key-Auth   — YOLO_ANTHROPIC_API_KEY in .env setzen"
fi

if [ "$HAS_SUBSCRIPTION" = true ]; then
    info "Auth: Subscription-Credentials (~/.claude) gefunden."
fi
if [ "$HAS_API_KEY" = true ]; then
    info "Auth: API-Key (YOLO_ANTHROPIC_API_KEY) gesetzt."
fi

# --- Telegram-Bot prüfen ---
COMPOSE_PROFILES=""
TELEGRAM_OK=true

if [ -z "${YOLO_TELEGRAM_BOT_TOKEN:-}" ]; then
    TELEGRAM_OK=false
fi
if [ -z "${YOLO_TELEGRAM_ALLOWED_USERS:-}" ]; then
    TELEGRAM_OK=false
fi

if [ "$TELEGRAM_OK" = true ]; then
    info "Telegram-Bot: Token und Allowed-Users gesetzt — Bot wird gestartet."
else
    warn "Telegram-Bot: YOLO_TELEGRAM_BOT_TOKEN und/oder YOLO_TELEGRAM_ALLOWED_USERS fehlen in .env"
    warn "Telegram-Bot wird NICHT gestartet. Setze beide Werte in .env um ihn zu aktivieren."
fi

# --- Docker Compose starten ---
info "Starte YOLO Deck via Docker Compose..."

if [ "$TELEGRAM_OK" = true ]; then
    docker compose up --build -d
else
    docker compose up --build -d backend frontend
fi

echo ""
info "YOLO Deck läuft:"
echo "  Frontend:     http://localhost:3000"
echo "  Backend API:  http://localhost:8000"
if [ "$TELEGRAM_OK" = true ]; then
    echo "  Telegram-Bot: aktiv"
fi
echo ""
echo "  Logs:         docker compose logs -f"
echo "  Stoppen:      docker compose down"
