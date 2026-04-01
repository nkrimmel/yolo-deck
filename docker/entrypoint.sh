#!/bin/bash
set -euo pipefail

# ── Konfiguration aus Environment ──
PROMPT="${CLAUDE_PROMPT:?CLAUDE_PROMPT muss gesetzt sein}"
OUTPUT_FORMAT="${CLAUDE_OUTPUT_FORMAT:-stream-json}"
MAX_TURNS="${CLAUDE_MAX_TURNS:-50}"
MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

# ── Git-Konfiguration (damit Claude committen kann) ──
git config --global user.name "Claude YOLO"
git config --global user.email "claude-yolo@localhost"
git config --global --add safe.directory /workspace

# ── Feature-Branch erstellen ──
BRANCH_NAME="claude-yolo/$(date +%Y%m%d-%H%M%S)"
cd /workspace

if git rev-parse --git-dir > /dev/null 2>&1; then
    git checkout -b "$BRANCH_NAME"
    echo "▶ Arbeite auf Branch: $BRANCH_NAME"
else
    echo "⚠ Kein Git-Repo erkannt, arbeite direkt im Verzeichnis"
fi

# ── Claude Code ausführen ──
echo "▶ Starte Claude Code..."
echo "▶ Prompt: $PROMPT"
echo "▶ Model: $MODEL"
echo "---"

claude -p "$PROMPT" \
    --output-format "$OUTPUT_FORMAT" \
    --max-turns "$MAX_TURNS" \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --verbose

EXIT_CODE=$?

# ── Änderungen committen ──
if git rev-parse --git-dir > /dev/null 2>&1; then
    if [ -n "$(git status --porcelain)" ]; then
        git add -A
        git commit -m "claude-yolo: $PROMPT"
        echo "---"
        echo "✅ Änderungen committed auf Branch: $BRANCH_NAME"
        echo "▶ Geänderte Dateien:"
        git diff --name-only HEAD~1
    else
        echo "---"
        echo "ℹ Keine Dateiänderungen vorgenommen."
    fi
fi

exit $EXIT_CODE
