FROM node:20-bookworm

# Systempakete für typische Entwicklung
RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    python3-pip \
    jq \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Claude Code global aus dem offiziellen npm-Paket installieren
RUN npm install -g @anthropic-ai/claude-code

# Arbeitsverzeichnis im Container
WORKDIR /workspace

# Nicht-Root-User für Sicherheit
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /workspace
USER claude
