/**
 * Parses Claude Code stream-json output into human-readable terminal lines.
 */

export interface TerminalLine {
    text: string;
    style: "text" | "tool" | "tool-result" | "system" | "result" | "error" | "dim";
}

/**
 * Parse a single log line (may be JSON or plain text) into
 * one or more formatted terminal lines.
 */
export function parseLogLine(raw: string): TerminalLine[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    // Try to parse as JSON
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(trimmed);
    } catch {
        // Not JSON — show as plain text
        return [{ text: trimmed, style: "text" }];
    }

    const type = json.type as string | undefined;

    // assistant message (contains text + tool_use blocks)
    if (type === "assistant" && json.message) {
        return parseAssistantMessage(json.message as Record<string, unknown>);
    }

    // stream_event (token-level delta)
    if (type === "stream_event" && json.event) {
        return parseStreamEvent(json.event as Record<string, unknown>);
    }

    // system messages
    if (type === "system") {
        const subtype = json.subtype as string | undefined;
        if (subtype === "api_retry") {
            const attempt = json.attempt ?? "?";
            const error = json.error ?? "";
            return [{ text: `[Retry ${attempt}] ${error}`, style: "system" }];
        }
        if (subtype === "init") {
            return [{ text: "Session gestartet", style: "system" }];
        }
        return [{ text: `[System] ${subtype || ""}`, style: "system" }];
    }

    // result message (final output)
    if (type === "result") {
        const lines: TerminalLine[] = [];
        const result = json.result as string | undefined;
        const subtype = json.subtype as string | undefined;
        const cost = json.cost_usd as number | undefined;
        const duration = json.duration_ms as number | undefined;
        const turns = json.num_turns as number | undefined;

        if (result) {
            lines.push({ text: result, style: "result" });
        }

        const meta: string[] = [];
        if (subtype) meta.push(subtype === "success" ? "Erfolgreich" : subtype);
        if (cost != null) meta.push(`$${cost.toFixed(4)}`);
        if (duration != null) meta.push(`${(duration / 1000).toFixed(1)}s`);
        if (turns != null) meta.push(`${turns} Turns`);
        if (meta.length > 0) {
            lines.push({ text: `── ${meta.join(" | ")} ──`, style: "dim" });
        }
        return lines;
    }

    // Unknown JSON — show type if available, otherwise raw
    if (type) {
        return [{ text: `[${type}] ${JSON.stringify(json).slice(0, 200)}`, style: "dim" }];
    }
    return [{ text: trimmed, style: "text" }];
}

function parseAssistantMessage(message: Record<string, unknown>): TerminalLine[] {
    const lines: TerminalLine[] = [];
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return lines;

    for (const block of content) {
        const blockType = block.type as string;

        if (blockType === "text") {
            const text = block.text as string;
            if (text?.trim()) {
                lines.push({ text: text.trim(), style: "text" });
            }
        } else if (blockType === "tool_use") {
            const name = block.name as string || "Tool";
            const input = block.input as Record<string, unknown> | undefined;
            const desc = formatToolInput(name, input);
            lines.push({ text: `$ ${name} ${desc}`, style: "tool" });
        } else if (blockType === "tool_result") {
            const content = block.content as string | undefined;
            if (content) {
                // Truncate long tool results
                const preview = content.length > 300
                    ? content.slice(0, 300) + "..."
                    : content;
                lines.push({ text: preview, style: "tool-result" });
            }
        }
    }

    return lines;
}

function parseStreamEvent(event: Record<string, unknown>): TerminalLine[] {
    const eventType = event.type as string;

    // content_block_delta — streaming text
    if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && delta.text) {
            // Skip individual deltas — they'll be in the full assistant message
            return [];
        }
    }

    // content_block_start
    if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
            const name = block.name as string || "Tool";
            return [{ text: `$ ${name}...`, style: "tool" }];
        }
    }

    // message_start, message_stop — skip
    if (eventType === "message_start" || eventType === "message_stop" ||
        eventType === "content_block_stop" || eventType === "content_block_delta") {
        return [];
    }

    return [];
}

function formatToolInput(name: string, input: Record<string, unknown> | undefined): string {
    if (!input) return "";

    // Common tools with nice formatting
    if (name === "Read" || name === "Glob" || name === "Grep") {
        return (input.file_path || input.path || input.pattern || "") as string;
    }
    if (name === "Edit" || name === "Write") {
        return (input.file_path || "") as string;
    }
    if (name === "Bash") {
        const cmd = (input.command || "") as string;
        return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    if (name === "Task" || name === "WebSearch" || name === "WebFetch") {
        return (input.description || input.query || input.url || "") as string;
    }

    // Fallback: show first string value
    for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0) {
            return val.length > 80 ? val.slice(0, 80) + "..." : val;
        }
    }
    return "";
}

/**
 * Parse all raw log lines into formatted terminal lines.
 */
export function parseLogLines(rawLines: string[]): TerminalLine[] {
    const result: TerminalLine[] = [];
    for (const line of rawLines) {
        result.push(...parseLogLine(line));
    }
    return result;
}
