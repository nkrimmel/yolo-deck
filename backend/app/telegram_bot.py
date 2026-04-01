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

API_BASE = f"http://{settings.host}:{settings.port}"


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
        "/status — Laufende Runs\n"
        "/stop — Run abbrechen",
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
        await update.message.reply_text("Keine aktiven Runs.")
        return

    lines = []
    for run in runs:
        lines.append(f"• `{run['run_id']}` — {run['status']} ({run.get('project_id', '?')})")

    await update.message.reply_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
    )


@authorized
async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{API_BASE}/api/runs")
            res.raise_for_status()
            runs = res.json()
    except Exception as e:
        await update.message.reply_text(f"Fehler: {e}")
        return

    active = [r for r in runs if r["status"] == "running"]

    if not active:
        await update.message.reply_text("Keine aktiven Runs zum Stoppen.")
        return

    keyboard = [
        [InlineKeyboardButton(
            f"Stop {r['run_id']} ({r.get('project_id', '?')})",
            callback_data=f"stop:{r['run_id']}",
        )]
        for r in active
    ]

    await update.message.reply_text(
        "Welchen Run stoppen?",
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
        await query.edit_message_text(f"Run `{run_id}` gestoppt.", parse_mode=ParseMode.MARKDOWN)


# ── Message Handler (Prompt) ──


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if settings.telegram_allowed_users and user_id not in settings.telegram_allowed_users:
        return

    project_id = context.user_data.get("selected_project")

    if not project_id:
        await update.message.reply_text("Wähle zuerst ein Projekt mit /run")
        return

    prompt = update.message.text.strip()
    if not prompt:
        return

    status_msg = await update.message.reply_text(
        f"*{project_id}* — Starte Run...\n\n`{prompt[:200]}`",
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
            f"*{project_id}* — Run `{run_id}` gestartet\n\n`{prompt[:200]}`",
            parse_mode=ParseMode.MARKDOWN,
        )

        await stream_to_telegram(update, context, run_id)

    except Exception as e:
        logger.exception("Run fehlgeschlagen")
        await update.message.reply_text(f"Fehler: {e}")

    context.user_data.pop("selected_project", None)


# ── Live Streaming via Polling ──


async def stream_to_telegram(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    run_id: str,
):
    """Poll run details from the backend API and send parsed output to Telegram."""
    chat_id = update.effective_chat.id
    max_len = settings.telegram_max_message_length
    poll_interval = 3.0
    last_log_count = 0

    while True:
        try:
            async with httpx.AsyncClient() as client:
                res = await client.get(f"{API_BASE}/api/run/{run_id}")
                if res.status_code == 404:
                    break
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

        # Check if run finished
        status = details.get("status")
        container_status = details.get("container_status")
        is_finished = (
            status in ("completed", "failed")
            or container_status in ("exited", "removed")
        )

        if is_finished:
            exit_code = details.get("exit_code")
            if exit_code == 0:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=f"Run `{run_id}` abgeschlossen",
                    parse_mode=ParseMode.MARKDOWN,
                )
            else:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=f"Run `{run_id}` fehlgeschlagen (Exit Code: {exit_code})",
                    parse_mode=ParseMode.MARKDOWN,
                )
            break

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
