# YOLO Deck — Telegram Bot Integration

Telegram Bot als mobiles Frontend für YOLO Deck. Lebt im selben Repo als zusätzlicher Service neben Web UI und FastAPI-Backend. Nutzt Long Polling (nur ausgehende Verbindungen, kein Port-Forwarding nötig) und importiert `DockerManager` / `ProjectManager` direkt — kein HTTP-Umweg.

---

## Einordnung im Repo

```
yolo-deck/
├── backend/
│   ├── pyproject.toml              # + python-telegram-bot Dependency
│   ├── run_telegram.py             # NEU — Entrypoint für Bot-Prozess
│   └── app/
│       ├── main.py                 # FastAPI (Web UI Backend)
│       ├── telegram_bot.py         # NEU — Telegram Bot
│       ├── config.py               # + Telegram-Settings
│       ├── docker_manager.py       # ← shared
│       └── project_manager.py      # ← shared
├── frontend/                       # Web UI (unverändert)
├── docker-compose.yml              # + telegram-bot Service
└── .env                            # + TELEGRAM_BOT_TOKEN
```

Der Bot ist der dritte Service in `docker-compose.yml`, neben `backend` und `frontend`.

---

## Datenfluss

```
Telegram App (Phone)
    │  "Refactor auth in my-app"
    ▼
Telegram API (Cloud)
    │  Long Polling (ausgehend)
    ▼
telegram_bot.py (lokal)
    │  import DockerManager / ProjectManager
    ▼
claude-yolo Container
    │  stdout
    ▼
telegram_bot.py → Telegram API → Push auf Phone
```

---

## Voraussetzungen

- Funktionierendes YOLO Deck Setup (siehe `yolo-deck-setup.md`)
- Telegram-Account
- Bot-Token von @BotFather

---

## Schritt 1 — Bot bei Telegram registrieren

1. Öffne Telegram, suche **@BotFather**
2. Sende `/newbot`
3. Name: `YOLO Deck` (oder was dir gefällt)
4. Username: `yolo_deck_bot` (muss auf `_bot` enden, muss unique sein)
5. Du bekommst ein Token wie `7123456789:AAF...` — in `.env` eintragen

Optional bei BotFather:
```
/setdescription — "Steuert claude-yolo Container von unterwegs"
/setcommands — Folgende Befehle registrieren:
  run - Prompt an ein Projekt senden
  projects - Verfügbare Projekte auflisten
  status - Laufende Runs anzeigen
  stop - Laufenden Run abbrechen
```

---

## Schritt 2 — Dependencies

Zum bestehenden `pyproject.toml` hinzufügen:

```toml
# backend/pyproject.toml — neue Dependency
dependencies = [
    # ... bestehende Dependencies ...
    "python-telegram-bot>=21.0",
]
```

```bash
cd backend/
pip install -e .
```

---

## Schritt 3 — Konfiguration erweitern

```python
# backend/app/config.py — ergänzen

class Settings(BaseSettings):
    # ... bestehende Felder ...

    # Telegram
    telegram_bot_token: str = ""
    telegram_allowed_users: list[int] = []  # Telegram User-IDs
    telegram_max_message_length: int = 4000  # Telegram-Limit ist 4096

    model_config = {"env_file": ".env", "env_prefix": "YOLO_"}
```

```bash
# .env — ergänzen
YOLO_TELEGRAM_BOT_TOKEN=7123456789:AAF...
YOLO_TELEGRAM_ALLOWED_USERS=[123456789]  # Deine Telegram User-ID
```

Deine User-ID findest du über @userinfobot auf Telegram.

---

## Schritt 4 — Bot implementieren

```python
# backend/app/telegram_bot.py
import asyncio
import logging
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)
from telegram.constants import ParseMode, ChatAction

from .config import settings
from .docker_manager import DockerManager
from .project_manager import ProjectManager

logger = logging.getLogger(__name__)

# Shared Instanzen (dieselben Klassen wie FastAPI)
docker_mgr = DockerManager()
project_mgr = ProjectManager()


# ── Auth-Guard ──


def authorized(func):
    """Decorator: Nur erlaubte User-IDs durchlassen."""
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id
        if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
            await update.message.reply_text("⛔ Nicht autorisiert.")
            return
        return await func(update, context)
    return wrapper


# ── Commands ──


@authorized
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🚀 *YOLO Deck*\n\n"
        "Befehle:\n"
        "/run — Projekt auswählen und Prompt senden\n"
        "/projects — Projekte auflisten\n"
        "/status — Laufende Runs\n"
        "/stop — Run abbrechen",
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_projects(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Listet alle Projekte auf."""
    projects = project_mgr.list_projects()
    if not projects:
        await update.message.reply_text("Keine Projekte gefunden.")
        return

    lines = []
    for p in projects:
        branch = f" `({p.current_branch})`" if p.current_branch else ""
        lines.append(f"• *{p.name}*{branch}")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_run(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Zeigt Inline-Keyboard mit Projekten zur Auswahl."""
    projects = project_mgr.list_projects()
    if not projects:
        await update.message.reply_text("Keine Projekte gefunden.")
        return

    keyboard = []
    # 2 Projekte pro Zeile
    row = []
    for p in projects:
        row.append(InlineKeyboardButton(p.name, callback_data=f"select:{p.id}"))
        if len(row) == 2:
            keyboard.append(row)
            row = []
    if row:
        keyboard.append(row)

    await update.message.reply_text(
        "📂 Projekt wählen:",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


@authorized
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Zeigt laufende Runs."""
    runs = docker_mgr.list_active_runs()
    if not runs:
        await update.message.reply_text("Keine aktiven Runs.")
        return

    lines = []
    for run_id, info in runs.items():
        lines.append(f"• `{run_id}` — {info['status']}")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Zeigt Inline-Keyboard mit laufenden Runs zum Stoppen."""
    runs = docker_mgr.list_active_runs()
    active = {k: v for k, v in runs.items() if v["status"] == "running"}

    if not active:
        await update.message.reply_text("Keine aktiven Runs zum Stoppen.")
        return

    keyboard = [
        [InlineKeyboardButton(f"⏹ {run_id}", callback_data=f"stop:{run_id}")]
        for run_id in active
    ]

    await update.message.reply_text(
        "Welchen Run stoppen?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


# ── Callback Handler (Inline-Keyboard) ──


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Verarbeitet Inline-Keyboard Clicks."""
    query = update.callback_query
    await query.answer()

    data = query.data
    user_id = update.effective_user.id

    if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
        await query.edit_message_text("⛔ Nicht autorisiert.")
        return

    if data.startswith("select:"):
        project_id = data.split(":", 1)[1]
        # Projekt-ID im User-Context speichern
        context.user_data["selected_project"] = project_id
        await query.edit_message_text(
            f"📂 Projekt: *{project_id}*\n\n"
            f"Schick mir jetzt deinen Prompt als Nachricht.",
            parse_mode=ParseMode.MARKDOWN,
        )

    elif data.startswith("stop:"):
        run_id = data.split(":", 1)[1]
        await docker_mgr.stop_run(run_id)
        await query.edit_message_text(f"⏹ Run `{run_id}` gestoppt.")


# ── Message Handler (Prompt empfangen) ──


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Empfängt Text-Nachrichten als Prompt.
    Startet einen Run, wenn ein Projekt ausgewählt ist.
    """
    user_id = update.effective_user.id
    if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
        return

    project_id = context.user_data.get("selected_project")

    if not project_id:
        await update.message.reply_text(
            "Wähle zuerst ein Projekt mit /run"
        )
        return

    prompt = update.message.text.strip()
    if not prompt:
        return

    # Bestätigung senden
    status_msg = await update.message.reply_text(
        f"▶ *{project_id}* — Starte Run...\n\n`{prompt[:200]}`",
        parse_mode=ParseMode.MARKDOWN,
    )

    # Typing-Indikator
    await update.message.chat.send_action(ChatAction.TYPING)

    # Workspace vorbereiten und Container starten
    try:
        workspace = project_mgr.prepare_workspace(project_id)

        import uuid
        run_id = str(uuid.uuid4())[:8]

        await docker_mgr.start_run(
            run_id=run_id,
            workspace_path=workspace,
            prompt=prompt,
        )

        await status_msg.edit_text(
            f"▶ *{project_id}* — Run `{run_id}` gestartet\n\n`{prompt[:200]}`",
            parse_mode=ParseMode.MARKDOWN,
        )

        # Output streamen
        await stream_to_telegram(update, context, run_id, project_id, workspace)

    except Exception as e:
        await update.message.reply_text(f"❌ Fehler: {e}")

    # Projekt-Auswahl zurücksetzen
    context.user_data.pop("selected_project", None)


# ── Live-Streaming ──


async def stream_to_telegram(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    run_id: str,
    project_id: str,
    workspace,
):
    """
    Streamt Container-Output als Telegram-Nachrichten.
    Buffert Zeilen und sendet in Batches (Telegram Rate Limits).
    """
    chat_id = update.effective_chat.id
    buffer = []
    last_send = asyncio.get_event_loop().time()
    send_interval = 3.0  # Sekunden zwischen Nachrichten
    max_len = settings.telegram_max_message_length

    async def flush_buffer():
        nonlocal buffer, last_send
        if not buffer:
            return
        text = "\n".join(buffer)
        # Auf Telegram-Limit kürzen
        if len(text) > max_len:
            text = text[-(max_len - 20):] + "\n[...gekürzt]"
        try:
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"```\n{text}\n```",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception as e:
            logger.warning(f"Telegram send error: {e}")
        buffer = []
        last_send = asyncio.get_event_loop().time()

    async for msg_type, data in docker_mgr.stream_output(run_id):
        if msg_type == "output":
            buffer.append(data)
            now = asyncio.get_event_loop().time()
            # Sende wenn Buffer voll oder Intervall erreicht
            if now - last_send >= send_interval or len("\n".join(buffer)) > max_len * 0.8:
                await flush_buffer()

        elif msg_type == "complete":
            await flush_buffer()
            # Sync zurück ins Repo
            branch = project_mgr.sync_back(workspace, project_id)
            branch_info = f"\nBranch: `{branch}`" if branch else ""
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"✅ *Run `{run_id}` abgeschlossen*{branch_info}",
                parse_mode=ParseMode.MARKDOWN,
            )

        elif msg_type == "error":
            await flush_buffer()
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"❌ *Run `{run_id}` fehlgeschlagen*\n`{data}`",
                parse_mode=ParseMode.MARKDOWN,
            )

    # Workspace aufräumen
    project_mgr.cleanup_workspace(workspace)


# ── Bot starten ──


def run_bot():
    """Bot als eigenständiger Prozess starten."""
    if not settings.telegram_bot_token:
        logger.error("YOLO_TELEGRAM_BOT_TOKEN nicht gesetzt")
        return

    app = Application.builder().token(settings.telegram_bot_token).build()

    # Commands
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("run", cmd_run))
    app.add_handler(CommandHandler("projects", cmd_projects))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("stop", cmd_stop))

    # Inline-Keyboard Callbacks
    app.add_handler(CallbackQueryHandler(handle_callback))

    # Text-Nachrichten als Prompt
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("YOLO Deck Telegram Bot gestartet (Long Polling)")
    app.run_polling(
        drop_pending_updates=True,  # Alte Nachrichten ignorieren
        allowed_updates=["message", "callback_query"],
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_bot()
```

---

## Schritt 5 — Entrypoint für den Bot-Prozess

```python
# backend/run_telegram.py
import logging
from app.telegram_bot import run_bot

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    run_bot()
```

---

## Schritt 6 — Docker Compose erweitern

```yaml
# docker-compose.yml — neuer Service hinzufügen
services:
  # ... bestehende services (backend, frontend) ...

  telegram-bot:
    build:
      context: ./backend
      dockerfile: Dockerfile.backend
    command: ["python", "-m", "run_telegram"]
    volumes:
      - ./projects:/app/projects
      - ./workspaces:/app/workspaces
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - YOLO_ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - YOLO_TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - YOLO_TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS}
      - YOLO_PROJECTS_DIR=/app/projects
      - YOLO_WORKSPACES_DIR=/app/workspaces
    restart: unless-stopped
```

```bash
# .env — ergänzen
TELEGRAM_BOT_TOKEN=7123456789:AAF...
TELEGRAM_ALLOWED_USERS=[123456789]
```

---

## Schritt 7 — Starten und testen

```bash
# Neustart mit Telegram-Bot
docker compose up --build -d

# Logs prüfen
docker compose logs -f telegram-bot
```

Dann in Telegram:

```
Du:   /run
Bot:  📂 Projekt wählen:
      [ my-app ] [ landing-page ]

Du:   *tippt auf my-app*
Bot:  📂 Projekt: my-app
      Schick mir jetzt deinen Prompt als Nachricht.

Du:   Refactor the auth module to use JWT tokens
Bot:  ▶ my-app — Run a3f1b2c0 gestartet
      ```
      ▶ Starte Claude Code...
      ▶ Arbeite auf Branch: claude-yolo/20260401-143022
      ...
      ```
Bot:  ✅ Run a3f1b2c0 abgeschlossen
      Branch: claude-yolo/20260401-143022
```

---

## Bedienungsflow (Kurzreferenz)

```
/run            → Inline-Keyboard mit Projekten
                → Projekt antippen
                → Prompt als Textnachricht schreiben
                → Output wird live gestreamt
                → Fertig-Meldung mit Branch-Name

/projects       → Liste aller Projekte

/status         → Laufende Runs anzeigen

/stop           → Inline-Keyboard mit laufenden Runs
                → Run antippen zum Stoppen
```

---

## Sicherheitshinweise

**User-ID-Whitelist ist Pflicht.** Ohne `TELEGRAM_ALLOWED_USERS` kann jeder, der den Bot-Username kennt, Container auf deinem Rechner starten. Die User-ID ist nicht der Username — sie ist eine numerische ID, die man nicht erraten kann, aber trotzdem: setze sie.

**Bot-Token geheim halten.** Wer das Token hat, kann den Bot impersonieren. Niemals committen, immer über `.env` laden.

**Rate Limits beachten.** Telegram erlaubt ~30 Nachrichten/Sekunde pro Chat. Der `send_interval` von 3 Sekunden im Streaming-Buffer ist konservativ genug. Bei sehr verbose Runs (viel Output) wird automatisch gebuffert und gekürzt.

---

## Bekannte Limitierungen

**Kein Multi-Run pro User:** Der Bot speichert den Projekt-State pro User in `context.user_data`. Wenn du ein Projekt wählst und dann einen zweiten Run startest bevor der erste fertig ist, überschreibt sich der State. Für die nächste Iteration: Run-Queue pro User.

**Markdown-Escaping:** Claude Code Output kann Zeichen enthalten, die Telegrams Markdown-Parser brechen (`_`, `*`, `` ` ``). Die Code-Block-Wrapping (```` ``` ````) fängt das meiste ab, aber bei Edge Cases kann eine Nachricht fehlschlagen. Fallback auf `parse_mode=None` wäre eine robustere Alternative.

**Kein Datei-Versand:** Der Bot zeigt Output als Text, sendet aber keine generierten Dateien. Erweiterung: nach dem Run die Git-Diff als Datei senden, oder spezifische Output-Dateien aus dem Workspace.