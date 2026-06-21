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

# --- Stoppen (falls aktiv) ---
if docker compose ps --status running -q 2>/dev/null | grep -q .; then
    info "Stoppe laufende Container..."
    docker compose down
else
    info "Keine laufenden Container — überspringe Stopp."
fi

# --- Build-Cache aufräumen ---
info "Räume Docker Build-Cache auf..."
docker builder prune -f

# --- claude-code Image neu bauen ---
info "Baue claude-code Container-Image..."
docker build -t claude-code:latest -f docker/Dockerfile docker/

# --- Compose Services neu bauen (ohne Cache) ---
info "Baue Backend + Frontend (--no-cache)..."
docker compose build --no-cache

# --- Starten ---
info "Starte YOLO Deck..."
docker compose up -d
info "YOLO Deck läuft — Frontend: http://localhost:3000"
