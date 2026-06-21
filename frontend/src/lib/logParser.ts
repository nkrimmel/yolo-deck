import { StreamMessage, RunMetadata } from './types';

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

    // user message (contains tool_result blocks after tool calls)
    if (type === "user" && json.message) {
        return parseUserMessage(json.message as Record<string, unknown>);
    }

    // system messages — only show actionable ones, skip noise
    if (type === "system") {
        const subtype = json.subtype as string | undefined;
        if (subtype === "api_retry") {
            const attempt = json.attempt ?? "?";
            const error = json.error ?? "";
            return [{ text: `[Retry ${attempt}] ${error}`, style: "system" }];
        }
        // Skip noisy system messages (init, task_notification, task_progress, etc.)
        return [];
    }

    // Interactive session messages
    if (type === "prompt_start") {
        const promptText = (json.prompt as string) || "";
        const promptNum = (json.prompt_number as number) || 0;
        const lines: TerminalLine[] = [];
        lines.push({ text: `--- Prompt #${promptNum} ---`, style: "system" });
        if (promptText) {
            lines.push({ text: `> ${promptText}`, style: "system" });
        }
        return lines;
    }

    if (type === "idle") {
        return [{ text: "[Bereit]", style: "dim" }];
    }

    if (type === "keepalive") {
        return [];
    }

    // Suppress noisy event types
    if (type === "rate_limit_event" || type === "content_block_start" ||
        type === "content_block_delta" || type === "content_block_stop" ||
        type === "message_start" || type === "message_stop" ||
        type === "ping" || type === "error_event") {
        return [];
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

    // Unknown JSON — suppress rather than showing raw
    if (type) {
        return [];
    }
    return [{ text: trimmed, style: "text" }];
}

function parseUserMessage(message: Record<string, unknown>): TerminalLine[] {
    const lines: TerminalLine[] = [];
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return lines;

    for (const block of content) {
        const blockType = block.type as string;
        if (blockType === "tool_result") {
            const resultContent = block.content as string | undefined;
            if (resultContent) {
                const preview = resultContent.length > 300
                    ? resultContent.slice(0, 300) + "..."
                    : resultContent;
                lines.push({ text: preview, style: "tool-result" });
            }
        }
    }
    return lines;
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

/**
 * Extract cost/duration/turns metadata from stream messages.
 */
export function extractRunMetadata(lines: StreamMessage[]): RunMetadata | null {
    for (const line of lines) {
        if (line.type !== "output") continue;
        try {
            const data = JSON.parse(line.data);
            if (data.type === "result") {
                return {
                    cost: data.cost_usd ?? data.result?.cost_usd ?? undefined,
                    duration: data.duration_ms ?? data.result?.duration_ms ?? undefined,
                    turns: data.num_turns ?? data.result?.num_turns ?? undefined,
                };
            }
        } catch {
            continue;
        }
    }
    return null;
}
