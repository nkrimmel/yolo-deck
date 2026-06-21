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

# --- Docker Compose stoppen ---
info "Stoppe YOLO Deck..."
docker compose down

echo ""
info "YOLO Deck gestoppt."
