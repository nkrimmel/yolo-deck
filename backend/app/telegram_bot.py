import asyncio
import logging
from functools import wraps

import httpx
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
from .log_parser import parse_log_line

logger = logging.getLogger(__name__)

API_BASE = settings.telegram_api_base or f"http://{settings.host}:{settings.port}"


# ── Auth Guard ──


def authorized(func):
    """Decorator: only allow whitelisted user IDs."""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id
        if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
            await update.message.reply_text("Nicht autorisiert.")
            return
        return await func(update, context)
    return wrapper


# ── Commands ──


@authorized
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "*YOLO Deck*\n\n"
        "Befehle:\n"
        "/run — Projekt auswählen und Prompt senden\n"
        "/projects — Projekte auflisten\n"
        "/status — Laufende Sessions\n"
        "/stop — Session beenden",
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_projects(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{API_BASE}/api/projects")
            res.raise_for_status()
            projects = res.json()
    except Exception as e:
        await update.message.reply_text(f"Fehler: {e}")
        return

    if not projects:
        await update.message.reply_text("Keine Projekte gefunden.")
        return

    lines = []
    for p in projects:
        branch = f" `({p.get('current_branch')})`" if p.get("current_branch") else ""
        lines.append(f"• *{p['name']}*{branch}")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_run(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # If user has an active idle session, hint about it
    active_run = context.user_data.get("active_run_id")
    if active_run:
        await update.message.reply_text(
            f"Du hast noch eine aktive Session (`{active_run}`).\n"
            "Schick einfach eine Nachricht als Follow-up, "
            "oder beende sie mit /stop.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{API_BASE}/api/projects")
            res.raise_for_status()
            projects = res.json()

        logger.info("cmd_run: %d Projekte gefunden", len(projects))
        if not projects:
            await update.message.reply_text("Keine Projekte gefunden.")
            return

        keyboard = []
        row = []
        for p in projects:
            row.append(InlineKeyboardButton(p["name"], callback_data=f"select:{p['id']}"))
            if len(row) == 2:
                keyboard.append(row)
                row = []
        if row:
            keyboard.append(row)

        await update.message.reply_text(
            "Projekt wählen:",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    except Exception as e:
        logger.exception("cmd_run fehlgeschlagen")
        await update.message.reply_text(f"Fehler: {e}")


@authorized
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{API_BASE}/api/runs")
            res.raise_for_status()
            runs = res.json()
    except Exception as e:
        await update.message.reply_text(f"Fehler: {e}")
        return

    if not runs:
        await update.message.reply_text("Keine aktiven Sessions.")
        return

    status_labels = {
        "running": "Läuft",
        "idle": "Bereit",
        "queued": "Warteschlange",
        "completed": "Fertig",
        "failed": "Fehler",
    }

    lines = []
    for run in runs:
        status = run.get("status", "?")
        label = status_labels.get(status, status)
        lines.append(f"• `{run['run_id']}` — {label} ({run.get('project_id', '?')})")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Quick stop: if user has an active session, offer to stop it directly
    active_run = context.user_data.get("active_run_id")

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{API_BASE}/api/runs")
            res.raise_for_status()
            runs = res.json()
    except Exception as e:
        await update.message.reply_text(f"Fehler: {e}")
        return

    stoppable = [r for r in runs if r["status"] in ("running", "idle")]

    if not stoppable:
        # Clear stale active_run_id if session is gone
        context.user_data.pop("active_run_id", None)
        context.user_data.pop("active_project_id", None)
        await update.message.reply_text("Keine aktiven Sessions zum Beenden.")
        return

    keyboard = []
    for r in stoppable:
        status = "Bereit" if r["status"] == "idle" else "Läuft"
        keyboard.append([InlineKeyboardButton(
            f"Beenden: {r['run_id']} ({r.get('project_id', '?')}) [{status}]",
            callback_data=f"stop:{r['run_id']}",
        )])

    await update.message.reply_text(
        "Welche Session beenden?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


# ── Callback Handler (Inline Keyboard) ──


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data
    user_id = update.effective_user.id

    if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
        await query.edit_message_text("Nicht autorisiert.")
        return

    if data.startswith("select:"):
        project_id = data.split(":", 1)[1]
        context.user_data["selected_project"] = project_id
        await query.edit_message_text(
            f"Projekt: *{project_id}*\n\n"
            f"Schick mir jetzt deinen Prompt als Nachricht.",
            parse_mode=ParseMode.MARKDOWN,
        )

    elif data.startswith("stop:"):
        run_id = data.split(":", 1)[1]
        try:
            async with httpx.AsyncClient() as client:
                await client.post(f"{API_BASE}/api/run/{run_id}/stop")
        except Exception:
            pass
        # Clear active session if this was it
        if context.user_data.get("active_run_id") == run_id:
            context.user_data.pop("active_run_id", None)
            context.user_data.pop("active_project_id", None)
        await query.edit_message_text(
            f"Session `{run_id}` beendet.",
            parse_mode=ParseMode.MARKDOWN,
        )

    elif data.startswith("end_session:"):
        run_id = data.split(":", 1)[1]
        try:
            async with httpx.AsyncClient() as client:
                await client.post(f"{API_BASE}/api/run/{run_id}/stop")
        except Exception:
            pass
        if context.user_data.get("active_run_id") == run_id:
            context.user_data.pop("active_run_id", None)
            context.user_data.pop("active_project_id", None)
        await query.edit_message_text(
            f"Container `{run_id}` beendet.",
            parse_mode=ParseMode.MARKDOWN,
        )


# ── Message Handler (Prompt) ──


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
        return

    prompt = update.message.text.strip()
    if not prompt:
        return

    # Check if user has an active idle session → send follow-up prompt
    active_run = context.user_data.get("active_run_id")
    if active_run:
        await _send_followup(update, context, active_run, prompt)
        return

    # Otherwise, start a new session
    project_id = context.user_data.get("selected_project")
    if not project_id:
        await update.message.reply_text("Wähle zuerst ein Projekt mit /run")
        return

    await _start_new_session(update, context, project_id, prompt)


async def _start_new_session(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    project_id: str,
    prompt: str,
):
    """Start a new run and stream output until idle or finished."""
    status_msg = await update.message.reply_text(
        f"*{project_id}* — Starte Session...\n\n`{prompt[:200]}`",
        parse_mode=ParseMode.MARKDOWN,
    )

    await update.message.chat.send_action(ChatAction.TYPING)

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{API_BASE}/api/run",
                json={"project_id": project_id, "prompt": prompt},
                timeout=30,
            )
            res.raise_for_status()
            run = res.json()

        run_id = run["run_id"]

        await status_msg.edit_text(
            f"*{project_id}* — Session `{run_id}` gestartet\n\n`{prompt[:200]}`",
            parse_mode=ParseMode.MARKDOWN,
        )

        # Stream until idle or finished
        result = await stream_to_telegram(update, context, run_id)

        if result == "idle":
            # Session is alive — store for follow-up
            context.user_data["active_run_id"] = run_id
            context.user_data["active_project_id"] = project_id
            # Keep selected_project for context
        else:
            # Session ended
            context.user_data.pop("active_run_id", None)
            context.user_data.pop("active_project_id", None)
            context.user_data.pop("selected_project", None)

    except Exception as e:
        logger.exception("Run fehlgeschlagen")
        await update.message.reply_text(f"Fehler: {e}")
        context.user_data.pop("selected_project", None)


async def _send_followup(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    run_id: str,
    prompt: str,
):
    """Send a follow-up prompt to an idle session."""
    project_id = context.user_data.get("active_project_id", "?")

    await update.message.chat.send_action(ChatAction.TYPING)

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{API_BASE}/api/run/{run_id}/prompt",
                json={"prompt": prompt},
                timeout=30,
            )
            if res.status_code == 409:
                # Session is not idle (maybe still running)
                await update.message.reply_text(
                    "Session ist noch nicht bereit. Bitte warten..."
                )
                return
            if res.status_code == 404:
                # Session gone
                await update.message.reply_text(
                    "Session nicht mehr vorhanden. Starte eine neue mit /run"
                )
                context.user_data.pop("active_run_id", None)
                context.user_data.pop("active_project_id", None)
                return
            res.raise_for_status()
    except httpx.HTTPStatusError:
        await update.message.reply_text(f"Fehler beim Senden des Follow-up Prompts.")
        return
    except Exception as e:
        logger.exception("Follow-up fehlgeschlagen")
        await update.message.reply_text(f"Fehler: {e}")
        return

    await update.message.reply_text(
        f"*{project_id}* — Follow-up gesendet\n\n`{prompt[:200]}`",
        parse_mode=ParseMode.MARKDOWN,
    )

    # Stream until idle or finished
    result = await stream_to_telegram(update, context, run_id)

    if result != "idle":
        # Session ended
        context.user_data.pop("active_run_id", None)
        context.user_data.pop("active_project_id", None)


# ── Live Streaming via Polling ──


async def stream_to_telegram(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    run_id: str,
) -> str:
    """Poll run details and send parsed output to Telegram.

    Returns:
        "idle" if session is waiting for follow-up,
        "finished" if session completed/failed.
    """
    chat_id = update.effective_chat.id
    max_len = settings.telegram_max_message_length
    poll_interval = 3.0
    last_log_count = 0

    while True:
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get(f"{API_BASE}/api/run/{run_id}")
                if res.status_code == 404:
                    return "finished"
                res.raise_for_status()
                details = res.json()
        except Exception as e:
            logger.warning("Poll error: %s", e)
            await asyncio.sleep(poll_interval)
            continue

        raw_logs = details.get("logs", [])
        new_lines = raw_logs[last_log_count:]
        last_log_count = len(raw_logs)

        # Parse JSON logs to readable text
        parsed = []
        for line in new_lines:
            parsed.extend(parse_log_line(line))

        if parsed:
            text = "\n".join(parsed)
            if len(text) > max_len:
                text = text[-(max_len - 20):] + "\n[...gekürzt]"
            try:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                )
            except Exception as e:
                logger.warning("Telegram send error: %s", e)

        # Check status
        status = details.get("status")
        container_status = details.get("container_status")

        # Idle — session is waiting for follow-up
        if status == "idle":
            keyboard = [[InlineKeyboardButton(
                "Container beenden",
                callback_data=f"end_session:{run_id}",
            )]]
            await context.bot.send_message(
                chat_id=chat_id,
                text=(
                    f"Session `{run_id}` — *Bereit*\n\n"
                    "Schick eine Nachricht als Follow-up Prompt, "
                    "oder beende den Container."
                ),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard),
            )
            return "idle"

        # Finished
        is_finished = (
            status in ("completed", "failed")
            or container_status in ("exited", "removed")
        )

        if is_finished:
            exit_code = details.get("exit_code")
            if exit_code == 0:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=f"Session `{run_id}` abgeschlossen",
                    parse_mode=ParseMode.MARKDOWN,
                )
            else:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=f"Session `{run_id}` fehlgeschlagen (Exit Code: {exit_code})",
                    parse_mode=ParseMode.MARKDOWN,
                )
            return "finished"

        await asyncio.sleep(poll_interval)


# ── Bot starten ──


def run_bot():
    if not settings.telegram_bot_token:
        logger.error("YOLO_TELEGRAM_BOT_TOKEN nicht gesetzt")
        return

    app = Application.builder().token(settings.telegram_bot_token).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("run", cmd_run))
    app.add_handler(CommandHandler("projects", cmd_projects))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("YOLO Deck Telegram Bot gestartet (Long Polling)")
    app.run_polling(
        drop_pending_updates=True,
        allowed_updates=["message", "callback_query"],
    )
