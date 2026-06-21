import aiosqlite
import json
import uuid
from pathlib import Path
from datetime import datetime, timezone

from .config import settings


def _db_path() -> str:
    return settings.database_path


async def init_db():
    """Create tables if they don't exist."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                project_name TEXT,
                prompt TEXT,
                model TEXT,
                provider TEXT,
                status TEXT,
                exit_code INTEGER,
                cost_usd REAL,
                duration_ms REAL,
                num_turns INTEGER,
                started_at TEXT,
                finished_at TEXT,
                logs_json TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS prompt_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL,
                model TEXT,
                created_at TEXT
            )
        """)
        await db.commit()


async def save_run(run_data: dict):
    """INSERT OR REPLACE a run record."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        await db.execute(
            """INSERT OR REPLACE INTO runs
               (id, project_id, project_name, prompt, model, provider,
                status, exit_code, cost_usd, duration_ms, num_turns,
                started_at, finished_at, logs_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_data.get("id"),
                run_data.get("project_id"),
                run_data.get("project_name"),
                run_data.get("prompt"),
                run_data.get("model"),
                run_data.get("provider"),
                run_data.get("status"),
                run_data.get("exit_code"),
                run_data.get("cost_usd"),
                run_data.get("duration_ms"),
                run_data.get("num_turns"),
                run_data.get("started_at"),
                run_data.get("finished_at"),
                run_data.get("logs_json"),
            ),
        )
        await db.commit()


async def get_run_history(limit: int = 50, offset: int = 0) -> list[dict]:
    """Return recent runs without logs_json for performance."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT id, project_id, project_name, prompt, model, provider,
                      status, exit_code, cost_usd, duration_ms, num_turns,
                      started_at, finished_at
               FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?""",
            (limit, offset),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_run(run_id: str) -> dict | None:
    """Return a single run by id, including logs_json."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM runs WHERE id = ?", (run_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def delete_history():
    """Delete all run history."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        await db.execute("DELETE FROM runs")
        await db.commit()


async def save_template(name: str, prompt: str, model: str | None = None) -> dict:
    """Create a new prompt template."""
    path = _db_path()
    template = {
        "id": str(uuid.uuid4()),
        "name": name,
        "prompt": prompt,
        "model": model,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    async with aiosqlite.connect(path) as db:
        await db.execute(
            """INSERT INTO prompt_templates (id, name, prompt, model, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (template["id"], template["name"], template["prompt"],
             template["model"], template["created_at"]),
        )
        await db.commit()
    return template


async def get_templates() -> list[dict]:
    """Return all prompt templates."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM prompt_templates ORDER BY created_at DESC"
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def delete_template(template_id: str):
    """Delete a prompt template by id."""
    path = _db_path()
    async with aiosqlite.connect(path) as db:
        await db.execute("DELETE FROM prompt_templates WHERE id = ?", (template_id,))
        await db.commit()
