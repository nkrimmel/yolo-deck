"""
Parses Claude Code stream-json output into human-readable text.
Python port of frontend/src/lib/logParser.ts.
"""

import json


def parse_log_line(raw: str) -> list[str]:
    """Parse a single log line (JSON or plain text) into readable strings."""
    trimmed = raw.strip()
    if not trimmed:
        return []

    try:
        data = json.loads(trimmed)
    except (json.JSONDecodeError, ValueError):
        return [trimmed]

    if not isinstance(data, dict):
        return [trimmed]

    msg_type = data.get("type")

    # assistant message (text + tool_use blocks)
    if msg_type == "assistant" and data.get("message"):
        return _parse_assistant_message(data["message"])

    # stream_event (token-level delta) — skip, full message comes later
    if msg_type == "stream_event":
        return []

    # system messages
    if msg_type == "system":
        subtype = data.get("subtype", "")
        if subtype == "api_retry":
            return [f"[Retry {data.get('attempt', '?')}] {data.get('error', '')}"]
        if subtype == "init":
            return ["Session gestartet"]
        return []

    # result message
    if msg_type == "result":
        lines = []
        result = data.get("result")
        if result:
            lines.append(str(result))
        meta = []
        subtype = data.get("subtype")
        if subtype:
            meta.append("Erfolgreich" if subtype == "success" else subtype)
        cost = data.get("cost_usd")
        if cost is not None:
            meta.append(f"${cost:.4f}")
        duration = data.get("duration_ms")
        if duration is not None:
            meta.append(f"{duration / 1000:.1f}s")
        turns = data.get("num_turns")
        if turns is not None:
            meta.append(f"{turns} Turns")
        if meta:
            lines.append(f"── {' | '.join(meta)} ──")
        return lines

    return []


def _parse_assistant_message(message: dict) -> list[str]:
    lines = []
    content = message.get("content")
    if not isinstance(content, list):
        return lines

    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")

        if block_type == "text":
            text = block.get("text", "").strip()
            if text:
                lines.append(text)

        elif block_type == "tool_use":
            name = block.get("name", "Tool")
            desc = _format_tool_input(name, block.get("input"))
            lines.append(f"$ {name} {desc}")

        elif block_type == "tool_result":
            content_str = block.get("content", "")
            if isinstance(content_str, str) and content_str:
                preview = content_str[:300] + "..." if len(content_str) > 300 else content_str
                lines.append(preview)

    return lines


def _format_tool_input(name: str, input_data: dict | None) -> str:
    if not input_data or not isinstance(input_data, dict):
        return ""

    if name in ("Read", "Glob", "Grep"):
        return str(input_data.get("file_path") or input_data.get("path") or input_data.get("pattern") or "")
    if name in ("Edit", "Write"):
        return str(input_data.get("file_path") or "")
    if name == "Bash":
        cmd = str(input_data.get("command") or "")
        return cmd[:80] + "..." if len(cmd) > 80 else cmd
    if name in ("Task", "WebSearch", "WebFetch"):
        return str(input_data.get("description") or input_data.get("query") or input_data.get("url") or "")

    for val in input_data.values():
        if isinstance(val, str) and val:
            return val[:80] + "..." if len(val) > 80 else val
    return ""


def parse_log_lines(raw_lines: list[str]) -> list[str]:
    """Parse multiple raw log lines into readable text lines."""
    result = []
    for line in raw_lines:
        result.extend(parse_log_line(line))
    return result
