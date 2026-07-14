import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Bot, Brain, ChevronDown, Loader2, Send, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store/useStore";
import { useTranslation } from "../utils/i18n";
import type { ListEntry, Tag } from "../types";

// ── Display types ─────────────────────────────────────────────────────────────

interface DisplayMsg {
  role: "user" | "assistant";
  text: string; // "_loading_" while waiting
}

interface PlanMove {
  src: string;
  dst_dir: string;
  reason?: string;
}

// ── Anthropic types & helpers ─────────────────────────────────────────────────

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMsg {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicResp {
  content: AnthropicBlock[];
  stop_reason: string;
}

async function callAnthropic(
  apiKey: string, model: string, system: string, messages: AnthropicMsg[],
): Promise<AnthropicResp> {
  const tools = TOOLS.map((t) => ({
    name: t.name, description: t.description, input_schema: t.schema,
  }));
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: 4096, system, tools, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json() as Promise<AnthropicResp>;
}

/// Streaming variant for Anthropic. Reassembles the same AnthropicResp at the end,
/// but invokes `onTextDelta` for every text chunk so the UI can show tokens live.
/// Tool-use blocks are NOT streamed — we accumulate their input JSON and surface
/// them at end of stream. This keeps the existing tool execution path unchanged.
async function callAnthropicStream(
  apiKey: string, model: string, system: string, messages: AnthropicMsg[],
  onTextDelta: (chunk: string) => void,
  abortSignal: AbortSignal,
): Promise<AnthropicResp> {
  const tools = TOOLS.map((t) => ({
    name: t.name, description: t.description, input_schema: t.schema,
  }));
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: 4096, system, tools, messages, stream: true }),
    signal: abortSignal,
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${await res.text().catch(() => "")}`);

  // Per-block accumulators. The stream interleaves multiple content_block_* events;
  // each block has an index and a final shape we assemble in `blocks`.
  const blocks: Map<number, AnthropicBlock & { _jsonAcc?: string }> = new Map();
  let stopReason = "end_turn";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (rawEvent: string) => {
    // Each SSE event is: "event: <type>\n" + "data: <json>\n"
    const lines = rawEvent.split("\n");
    let dataLine = "";
    for (const line of lines) {
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (!dataLine) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(dataLine); } catch { return; }
    const type = payload.type as string;

    if (type === "content_block_start") {
      const idx = payload.index as number;
      const block = payload.content_block as Record<string, unknown>;
      if (block.type === "text") {
        blocks.set(idx, { type: "text", text: "" });
      } else if (block.type === "tool_use") {
        blocks.set(idx, {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: {},
          _jsonAcc: "",
        } as AnthropicBlock & { _jsonAcc?: string });
      }
    } else if (type === "content_block_delta") {
      const idx = payload.index as number;
      const delta = payload.delta as Record<string, unknown>;
      const block = blocks.get(idx);
      if (!block) return;
      if (delta.type === "text_delta" && block.type === "text") {
        const chunk = delta.text as string;
        block.text += chunk;
        onTextDelta(chunk);
      } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
        const partial = delta.partial_json as string;
        (block as AnthropicBlock & { _jsonAcc?: string })._jsonAcc =
          ((block as AnthropicBlock & { _jsonAcc?: string })._jsonAcc ?? "") + partial;
      }
    } else if (type === "content_block_stop") {
      const idx = payload.index as number;
      const block = blocks.get(idx);
      if (block?.type === "tool_use") {
        const acc = (block as AnthropicBlock & { _jsonAcc?: string })._jsonAcc ?? "";
        try { block.input = acc ? JSON.parse(acc) : {}; } catch { block.input = {}; }
        delete (block as AnthropicBlock & { _jsonAcc?: string })._jsonAcc;
      }
    } else if (type === "message_delta") {
      const delta = payload.delta as Record<string, unknown>;
      if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE event delimiter is a blank line (\n\n).
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const evt = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      handleEvent(evt);
    }
  }
  if (buffer.trim()) handleEvent(buffer);

  // Reassemble blocks in index order
  const content: AnthropicBlock[] = Array.from(blocks.entries())
    .sort(([a], [b]) => a - b)
    .map(([, b]) => {
      const clone = { ...b } as AnthropicBlock & { _jsonAcc?: string };
      delete clone._jsonAcc;
      return clone;
    });
  return { content, stop_reason: stopReason };
}

// ── Ollama types & helpers ────────────────────────────────────────────────────

type OllamaMsg =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] }
  | { role: "tool"; content: string };

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaResp {
  message: { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
}

/// Streaming variant for Ollama. Emits text deltas via `onTextDelta`. Tool calls
/// are accumulated and returned at the end.
/// Some Ollama models (notably qwen2.5, hermes, mistral with tool-use templates)
/// emit tool calls as TEXT inside `<tool_call>...</tool_call>` blocks instead of
/// using the structured `tool_calls` array. Parse them out so they actually run.
///
/// Also handles a few common variations:
///   <tool_call>{...}</tool_call>             ← qwen2.5
///   <|python_tag|>{...}<|end|>               ← some llama variants
///   ```tool_call\n{...}\n```                 ← codeblock-wrapped
function extractTextToolCalls(text: string): { cleanText: string; toolCalls: OllamaToolCall[] } {
  const toolCalls: OllamaToolCall[] = [];
  let cleanText = text;

  const tryAdd = (jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (parsed && typeof parsed.name === "string") {
        toolCalls.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments ?? parsed.parameters ?? parsed.args ?? {},
          },
        });
      }
    } catch { /* malformed JSON — ignore */ }
  };

  // 1) <tool_call>...</tool_call>
  cleanText = cleanText.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, body) => {
    tryAdd(body);
    return "";
  });

  // 2) Dangling opening tag at end of stream (no closing tag arrived in time).
  //    Only honor if we haven't already captured a tool call from a complete tag.
  if (!toolCalls.length) {
    const open = cleanText.match(/<tool_call>\s*([\s\S]*)$/i);
    if (open && open[1].trim().startsWith("{")) {
      tryAdd(open[1]);
      cleanText = cleanText.replace(/<tool_call>[\s\S]*$/i, "");
    }
  }

  // 3) llama-style python_tag wrapper
  cleanText = cleanText.replace(/<\|python_tag\|>\s*([\s\S]*?)\s*<\|(?:end|eom_id)\|>/gi, (_, body) => {
    tryAdd(body);
    return "";
  });

  // 4) ```tool_call\n{...}\n```
  cleanText = cleanText.replace(/```(?:tool_call|json)?\s*\n([\s\S]*?)\n```/gi, (match, body) => {
    if (body.trim().startsWith("{") && /"name"\s*:/.test(body)) {
      tryAdd(body);
      return "";
    }
    return match;
  });

  return { cleanText: cleanText.trim(), toolCalls };
}

async function callOllamaStream(
  baseUrl: string, model: string, system: string, messages: OllamaMsg[],
  onTextDelta: (chunk: string) => void,
  abortSignal: AbortSignal,
): Promise<OllamaResp> {
  const tools = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      tools,
      stream: true,
    }),
    signal: abortSignal,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let toolCalls: OllamaToolCall[] | undefined;
  let doneFlag = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let payload: { message?: { content?: string; tool_calls?: OllamaToolCall[] }; done?: boolean };
      try { payload = JSON.parse(line); } catch { continue; }
      if (payload.message?.content) {
        accumulatedText += payload.message.content;
        onTextDelta(payload.message.content);
      }
      if (payload.message?.tool_calls?.length) {
        toolCalls = payload.message.tool_calls;
      }
      if (payload.done) doneFlag = true;
    }
  }

  // If the model emitted tool calls as text instead of using the structured API,
  // extract them now. The streaming UI may have briefly shown the raw tags; the
  // final replacement uses the cleaned text.
  if (!toolCalls?.length) {
    const extracted = extractTextToolCalls(accumulatedText);
    if (extracted.toolCalls.length) {
      return {
        message: {
          role: "assistant",
          content: extracted.cleanText,
          tool_calls: extracted.toolCalls,
        },
        done: doneFlag,
      };
    }
  }

  return {
    message: { role: "assistant", content: accumulatedText, tool_calls: toolCalls },
    done: doneFlag,
  };
}

async function callOllama(
  baseUrl: string, model: string, system: string, messages: OllamaMsg[],
): Promise<OllamaResp> {
  const tools = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      tools,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const resp = await res.json() as OllamaResp;
  // Same fallback as the streaming path: parse text-based tool calls if structured ones are absent.
  if (!resp.message?.tool_calls?.length && resp.message?.content) {
    const extracted = extractTextToolCalls(resp.message.content);
    if (extracted.toolCalls.length) {
      resp.message.content = extracted.cleanText;
      resp.message.tool_calls = extracted.toolCalls;
    }
  }
  return resp;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

// Tools that require explicit user confirmation before executing
const DESTRUCTIVE_TOOLS = new Set(["delete_path"]);

const TOOLS: ToolDef[] = [
  // ── Read / browse ──────────────────────────────────────────────────────────
  {
    name: "list_directory",
    description: "List the contents of a directory. Returns files and folders with sizes.",
    schema: { type: "object", properties: { path: { type: "string", description: "Absolute path" } }, required: ["path"] },
  },
  {
    name: "search_files",
    description: "Search for files by name OR by content across the workspace. Works on PDFs, Word docs, spreadsheets, text files, and code. Use a distinctive keyword (e.g. 'Focus', 'budget', 'kakemono').",
    schema: { type: "object", properties: { query: { type: "string", description: "Keyword to search in file names and content" } }, required: ["query"] },
  },
  {
    name: "read_file",
    description: "Read the full text content of a plain text or code file (max ~50 KB). Does NOT work on PDFs, Word docs, or Excel files — use preview_file for those.",
    schema: { type: "object", properties: { path: { type: "string", description: "Absolute path to the file" } }, required: ["path"] },
  },
  {
    name: "preview_file",
    description: "Extract and return the first ~500 chars of text from ANY file: PDF, DOCX, XLSX, PPTX, ODT, text, code. Use this to verify a PDF contains specific content, or to understand what a document is about. The result is cached so future searches will also find it.",
    schema: { type: "object", properties: { path: { type: "string", description: "Absolute path to the file" } }, required: ["path"] },
  },
  {
    name: "get_tags",
    description: "Get all tags defined in the workspace with their names and file counts.",
    schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_file_tags",
    description: "Get the tags currently applied to a specific file or folder.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the file or folder" } },
      required: ["path"],
    },
  },
  {
    name: "copy_path",
    description: "Copy a file or folder to a destination directory (non-destructive — original is kept).",
    schema: {
      type: "object",
      properties: {
        src:     { type: "string", description: "Absolute path of the file or folder to copy" },
        dst_dir: { type: "string", description: "Absolute path of the destination directory" },
      },
      required: ["src", "dst_dir"],
    },
  },
  {
    name: "get_recent_activity",
    description: "Get a log of recently opened/modified/created files (last 30 days). Use this ONLY when the user explicitly asks about recent activity or history — NOT to find a specific file. To find a file, always use search_files.",
    schema: { type: "object", properties: { limit: { type: "number", description: "Max entries (default 20)" } }, required: [] },
  },
  {
    name: "add_tag_to_file",
    description: "Add a tag to ONE file or folder. Call this once per file. To tag multiple files, call it once for each path. Use get_tags to get the exact tag name first.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a single file or folder" },
        tag_name: { type: "string", description: "Exact tag name as returned by get_tags (e.g. 'Archives', not '[id=27]')" },
      },
      required: ["path", "tag_name"],
    },
  },
  {
    name: "navigate_to",
    description: "Navigate the file explorer to a directory. Use this when the user wants to go somewhere.",
    schema: { type: "object", properties: { path: { type: "string", description: "Absolute path of directory" } }, required: ["path"] },
  },
  {
    name: "tag_files_matching",
    description: "Tag MANY files in one call by matching their name or extension. Use this instead of calling add_tag_to_file in a loop. Example: tag every PDF in this folder as 'Archives', or every file containing 'invoice' in its name as 'Comptabilité'. Recurses into subdirectories.",
    schema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Absolute directory path to scan" },
        pattern: { type: "string", description: "Substring matched against file names, case-insensitive. Optional." },
        extension: { type: "string", description: "File extension WITHOUT the dot, e.g. 'pdf'. Optional. At least one of pattern/extension required." },
        tag_name: { type: "string", description: "Name of the tag to apply (created if it doesn't exist)" },
      },
      required: ["dir", "tag_name"],
    },
  },
  {
    name: "find_duplicates",
    description: "Find duplicate files in a folder tree. Reports groups of files sharing the same filename AND size — catches the common case of copies in multiple locations without expensive hashing.",
    schema: {
      type: "object",
      properties: { dir: { type: "string", description: "Absolute directory to scan" } },
      required: ["dir"],
    },
  },
  {
    name: "find_unused",
    description: "Find files inside a folder that haven't been opened, modified, or otherwise touched in the last N days (based on the local activity log). Useful for cleanup suggestions.",
    schema: {
      type: "object",
      properties: {
        dir:  { type: "string", description: "Absolute directory to scan" },
        days: { type: "number", description: "Number of days of inactivity (default 90)" },
      },
      required: ["dir"],
    },
  },
  {
    name: "summarize_folder",
    description: "Get a STRUCTURED summary of what a folder contains: file type breakdown, subfolder count, total size, and the dominant categories. Use this FIRST when the user asks 'what's in this folder?', 'what kind of files are here?', 'what's this folder about?'. Much more concise and useful than list_directory for high-level questions.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of the folder to summarize" } },
      required: ["path"],
    },
  },
  {
    name: "get_file_snippets",
    description: "Get a text preview (~200 chars) of files in a directory. Returns 50 files per page. For large folders, call multiple times with increasing offset (0, 50, 100…) until has_more is false. Extracts content from PDFs, DOCX, XLSX, PPTX, text files, and code.",
    schema: {
      type: "object",
      properties: {
        dir:    { type: "string", description: "Absolute path of directory to inspect" },
        offset: { type: "number", description: "Skip this many files (default 0, use for pagination)" },
        limit:  { type: "number", description: "Max files to return, capped at 50 (default 50)" },
      },
      required: ["dir"],
    },
  },
  // ── Write / create ────────────────────────────────────────────────────────
  {
    name: "create_file",
    description: "Create a new EMPTY file. Only use this when the user wants to create a blank file with NO content. If the user wants to write content into a file (new or existing), use write_file instead.",
    schema: {
      type: "object",
      properties: {
        dir:  { type: "string", description: "Parent directory path" },
        name: { type: "string", description: "File name (with extension, e.g. 'notes.txt')" },
      },
      required: ["dir", "name"],
    },
  },
  {
    name: "create_dir",
    description: "Create a new directory (including intermediate directories).",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of directory to create" } },
      required: ["path"],
    },
  },
  {
    name: "rename_path",
    description: "Rename or move a file or directory to a new path.",
    schema: {
      type: "object",
      properties: {
        old_path: { type: "string", description: "Current absolute path" },
        new_path: { type: "string", description: "New absolute path" },
      },
      required: ["old_path", "new_path"],
    },
  },
  {
    name: "write_file",
    description: "Write text content to a file (creates the file if it doesn't exist, or overwrites it if it does). Use this whenever the user wants content written to a file — whether the file is new or already exists.",
    schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "New content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "plan_moves",
    description: "Propose a batch reorganization plan. Use this INSTEAD of multiple move_path calls when reorganizing a folder. The user will see and approve the full plan before any file is moved. Destination folders are created automatically if they do not exist.",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence describing the overall organization strategy" },
        moves: {
          type: "array",
          description: "All files to move, in one single call",
          items: {
            type: "object",
            properties: {
              src:     { type: "string", description: "Absolute path of the file to move" },
              dst_dir: { type: "string", description: "Absolute path of the destination directory. Use the special value \"trash\" to safely trash a file instead of deleting it permanently." },
              reason:  { type: "string", description: "Why this file goes here (short)" },
            },
            required: ["src", "dst_dir"],
          },
        },
      },
      required: ["summary", "moves"],
    },
  },
  {
    name: "move_path",
    description: "Move a SINGLE file or folder into a destination directory. For reorganizing multiple files, use plan_moves instead.",
    schema: {
      type: "object",
      properties: {
        src:     { type: "string", description: "Absolute path of the file or folder to move" },
        dst_dir: { type: "string", description: "Absolute path of the destination directory (must already exist)" },
      },
      required: ["src", "dst_dir"],
    },
  },
  {
    name: "delete_path",
    description: "⚠ DESTRUCTIVE — permanently delete a file or directory. Requires user confirmation. Only use when the user explicitly asks to delete something.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to delete" } },
      required: ["path"],
    },
  },
  // ── Tag management ────────────────────────────────────────────────────────
  {
    name: "remove_tag_from_file",
    description: "Remove a tag from a file.",
    schema: {
      type: "object",
      properties: {
        path:     { type: "string", description: "Absolute path to the file" },
        tag_name: { type: "string", description: "Exact tag name to remove" },
      },
      required: ["path", "tag_name"],
    },
  },
  {
    name: "remember",
    description: "Save something to your persistent memory — it will be available in ALL future conversations. Use for user preferences, naming conventions, project context, recurring patterns. Be concise (1-2 sentences max).",
    schema: {
      type: "object",
      properties: { content: { type: "string", description: "What to remember (concise, specific, useful for future sessions)" } },
      required: ["content"],
    },
  },
  {
    name: "forget",
    description: "Delete a memory by its ID (visible in the memory list above). Use when a memory is outdated or wrong.",
    schema: {
      type: "object",
      properties: { id: { type: "number", description: "ID of the memory to delete" } },
      required: ["id"],
    },
  },
  {
    name: "create_tag",
    description: "Create a new tag with a name and optional color.",
    schema: {
      type: "object",
      properties: {
        name:  { type: "string", description: "Tag name" },
        color: { type: "string", description: "Hex color, e.g. #6366f1 (optional)" },
      },
      required: ["name"],
    },
  },

  // ── Workspace notes (terse descriptions — full rules live in system prompt) ─
  {
    name: "add_task",
    description: "Add a task. due_date YYYY-MM-DD, due_time HH:MM.",
    schema: {
      type: "object",
      properties: {
        text:     { type: "string" },
        due_date: { type: "string" },
        due_time: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "toggle_task",
    description: "Mark task done/undone. match = id or text substring.",
    schema: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "delete_task",
    description: "Delete a task. match = id or text substring.",
    schema: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "set_task_due",
    description: "Change/clear a task's due date+time. Empty due_date clears all.",
    schema: {
      type: "object",
      properties: {
        match:    { type: "string" },
        due_date: { type: "string" },
        due_time: { type: "string" },
      },
      required: ["match"],
    },
  },
  {
    name: "edit_task_text",
    description: "Rename a task.",
    schema: {
      type: "object",
      properties: { match: { type: "string" }, new_text: { type: "string" } },
      required: ["match", "new_text"],
    },
  },
  {
    name: "set_workspace_notes_text",
    description: "Replace the free-form notes section (tasks untouched).",
    schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "append_to_workspace_notes",
    description: "Append text to the free-form notes section.",
    schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
  {
    name: "get_workspace_notes",
    description: "Re-read notes from DB (only if you suspect the inline CURRENT TASKS section is stale).",
    schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "bulk_task_action",
    description: "Act on MULTIPLE tasks at once. Use for 'les deux/both/all/tous/tous les non finis'. action ∈ {done, undone, toggle, delete}. scope ∈ {all, undone, done, <text substring>}.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "done | undone | toggle | delete" },
        scope:  { type: "string", description: "'all', 'undone', 'done', or a text substring matching the tasks to act on" },
      },
      required: ["action", "scope"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type RefreshTagsFn = (path: string, fileId: number | null) => Promise<void>;

type PlanFn = (plan: { moves: PlanMove[]; summary: string }) => Promise<boolean>;

// ── Workspace notes helpers (shared with the AI tool executor) ────────────────

interface NoteTask {
  id: string;
  done: boolean;
  text: string;
  due?: string; // YYYY-MM-DD or YYYY-MM-DDTHH:MM
}
interface NotesState {
  tasks: NoteTask[];
  notes: string;
}

function notesParse(raw: string): NotesState {
  if (!raw || !raw.trim()) return { tasks: [], notes: "" };
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.tasks) && typeof j.notes === "string") {
      return {
        tasks: j.tasks.filter((t: unknown): t is NoteTask =>
          !!t && typeof t === "object" && typeof (t as NoteTask).text === "string"
        ).map((t: NoteTask) => ({
          id: typeof t.id === "string" ? t.id : Math.random().toString(36).slice(2, 10),
          done: !!t.done,
          text: t.text,
          due: typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t.due) ? t.due : undefined,
        })),
        notes: j.notes,
      };
    }
  } catch { /* fall through */ }
  return { tasks: [], notes: raw };
}

async function notesLoad(ctxId: number): Promise<NotesState> {
  const raw = await invoke<string>("get_workspace_note", { contextId: ctxId }).catch(() => "");
  return notesParse(raw);
}

async function notesSave(ctxId: number, state: NotesState): Promise<void> {
  const content = JSON.stringify(state);
  await invoke("save_workspace_note", { contextId: ctxId, content });
  // Notify the panel + toolbar so the UI updates live with no polling.
  window.dispatchEvent(new CustomEvent("notes-updated", {
    detail: { contextId: ctxId, content },
  }));
}

/// Match a task by exact id or by case-insensitive substring of its text.
/// If multiple text matches, prefer those due today / earliest due.
function notesFindTask(state: NotesState, match: string): NoteTask | null {
  const q = match.trim();
  if (!q) return null;
  // Exact id match first
  const byId = state.tasks.find((t) => t.id === q);
  if (byId) return byId;
  // Text substring match (case-insensitive)
  const qLower = q.toLowerCase();
  const matches = state.tasks.filter((t) => t.text.toLowerCase().includes(qLower));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  // Pick the most "urgent" — earliest due date, undone first
  matches.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.due ?? "9999"; const bd = b.due ?? "9999";
    return ad.localeCompare(bd);
  });
  return matches[0];
}

function notesFormatTask(t: NoteTask): string {
  const box = t.done ? "[x]" : "[ ]";
  const due = t.due ? ` (due ${t.due})` : "";
  return `${box} ${t.text}${due}  [id=${t.id}]`;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  tags: Tag[],
  contextId: number,
  onNavigate: (path: string) => void,
  requestConfirm?: (msg: string) => Promise<boolean>,
  refreshTags?: RefreshTagsFn,
  onRefreshDir?: (path: string) => void,
  requestPlan?: PlanFn,
): Promise<string> {
  try {
    // ── Vault guard ──────────────────────────────────────────────────────────
    // ONE check, at the single choke point every tool passes through, rather
    // than a check inside each of the ~25 cases. Adding a new tool therefore
    // gets the protection for free — the alternative (per-case guards) fails
    // the moment someone adds a tool and forgets one, and the cost of forgetting
    // here is vault plaintext in the model's context window, or an AI-driven
    // `plan_moves` dragging encrypted blobs out of their vault and rendering
    // them permanently undecryptable.
    //
    // Covers locked vaults too: see `vault_path_is_protected`.
    const pathFields = ["path", "src", "dst_dir", "dir", "from", "to", "file_path"];
    const candidates = pathFields
      .map((f) => input[f])
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    // plan_moves carries its paths one level down, inside the moves array.
    const moves = input.moves;
    if (Array.isArray(moves)) {
      for (const m of moves) {
        if (m && typeof m === "object") {
          const mm = m as Record<string, unknown>;
          for (const f of ["src", "dst_dir"]) {
            if (typeof mm[f] === "string" && mm[f]) candidates.push(mm[f] as string);
          }
        }
      }
    }
    for (const p of candidates) {
      const protectedPath = await invoke<boolean>("vault_path_is_protected", { path: p })
        .catch(() => false);
      if (protectedPath) {
        // Told to the MODEL, not just the user: it must understand this is a
        // hard boundary and stop retrying, rather than reformulating the call.
        return `Error: "${p}" is inside an encrypted vault. Vaults are off-limits — you cannot read, list, search, move, tag or delete anything inside one. Tell the user they must open the vault themselves in nxs. Do not retry.`;
      }
    }

    switch (name) {
      case "list_directory": {
        const entries = await invoke<ListEntry[]>("list_directory", { path: input.path, contextId });
        const lines = entries.slice(0, 50).map((e) =>
          `${e.is_dir ? "DIR " : "FILE"} ${e.name}${e.size ? ` (${formatSize(e.size)})` : ""}`
        );
        return lines.join("\n") + (entries.length > 50 ? `\n…and ${entries.length - 50} more` : "");
      }
      case "search_files": {
        const files = await invoke<{ name: string; path: string; tags: { name: string }[] }[]>(
          "search_files", { query: input.query, contextId }
        );
        if (files.length) {
          return files.slice(0, 20).map((f) => {
            const tagStr = f.tags?.length ? ` [${f.tags.map((t) => t.name).join(", ")}]` : "";
            return `${f.name}${tagStr} — ${f.path}`;
          }).join("\n");
        }
        // DB returned nothing — the file may not be indexed yet.
        // Fall back to a live filesystem search on the home folder.
        const homeDir = await invoke<string>("get_home_dir").catch(() => "C:\\Users");
        const liveResults = await invoke<{ name: string; path: string }[]>(
          "search_live", { query: String(input.query), path: homeDir }
        ).catch(() => []);
        if (!liveResults.length) {
          return `No files found for "${input.query}" in the index or on disk. The file may be in a folder that was never scanned. Try navigating to the folder and asking again.`;
        }
        const liveLines = liveResults.slice(0, 20).map((f) => `${f.name} — ${f.path}`).join("\n");
        return `Not found in index, but found on disk:\n${liveLines}`;
      }
      case "read_file": {
        const content = await invoke<string>("read_file_full", { path: input.path });
        return content.length > 50000 ? content.slice(0, 50000) + "\n[truncated]" : content;
      }
      case "preview_file": {
        const snippet = await invoke<string>("preview_file", { path: input.path });
        return `Content of ${input.path}:\n${snippet}`;
      }
      case "get_tags": {
        if (!tags.length) return "No tags defined.";
        return tags.map((t) => `name="${t.name}" id=${t.id} color=${t.color}`).join("\n");
      }
      case "get_file_tags": {
        let fileId: number | null = null;
        let fileTags: Tag[] = [];
        try {
          fileId = await invoke<number>("index_file_by_path", { path: input.path });
          fileTags = await invoke<Tag[]>("get_file_tags", { fileId, contextId });
        } catch (e) {
          if (String(e).includes("is_directory")) {
            fileTags = await invoke<Tag[]>("get_folder_tags", { path: input.path, contextId });
          } else throw e;
        }
        if (!fileTags.length) return `No tags on ${input.path}`;
        return `Tags on ${input.path}: ${fileTags.map((t) => t.name).join(", ")}`;
      }
      case "copy_path": {
        await invoke("copy_path", { src: input.src, dstDir: String(input.dst_dir) });
        onRefreshDir?.(String(input.dst_dir));
        return `Copied ${input.src} → ${input.dst_dir}`;
      }
      case "get_recent_activity": {
        const limit = (input.limit as number) ?? 20;
        const now = Math.floor(Date.now() / 1000);
        const rows = await invoke<{ file_name: string; action: string; timestamp: number }[]>(
          "get_timeline", { from: now - 30 * 24 * 3600, to: now, folder: null }
        );
        if (!rows.length) return "No recent activity.";
        return rows.slice(0, limit).map((r) => {
          const date = new Date(r.timestamp * 1000).toLocaleDateString();
          return `${r.action.padEnd(10)} ${r.file_name} (${date})`;
        }).join("\n");
      }
      case "add_tag_to_file": {
        const tag = tags.find((t) => t.name.toLowerCase() === String(input.tag_name).toLowerCase());
        if (!tag) return `Tag "${input.tag_name}" not found. Available: ${tags.map((t) => t.name).join(", ")}`;
        let fileId: number | null = null;
        try {
          fileId = await invoke<number>("index_file_by_path", { path: input.path });
          await invoke("add_tag_to_file", { fileId, tagId: tag.id, contextId });
        } catch (e) {
          if (String(e).includes("is_directory")) {
            await invoke("add_tag_to_folder", { path: input.path, tagId: tag.id, contextId });
          } else throw e;
        }
        await refreshTags?.(String(input.path), fileId);
        return `Tag "${tag.name}" added to ${input.path}`;
      }
      case "navigate_to": {
        onNavigate(String(input.path));
        return `Navigated to ${input.path}`;
      }
      case "tag_files_matching": {
        const tagged = await invoke<{ path: string; name: string }[]>("tag_files_matching", {
          dir: input.dir,
          pattern: input.pattern ?? null,
          extension: input.extension ?? null,
          tagName: input.tag_name,
          contextId,
        });
        // Refresh the current directory if it's the target
        onRefreshDir?.(String(input.dir));
        if (!tagged.length) return `No files matched pattern/extension. Tag "${input.tag_name}" was applied to 0 files.`;
        const preview = tagged.slice(0, 8).map((f) => `  • ${f.name}`).join("\n");
        const more = tagged.length > 8 ? `\n  …and ${tagged.length - 8} more` : "";
        return `Tagged ${tagged.length} file(s) with "${input.tag_name}":\n${preview}${more}`;
      }
      case "find_duplicates": {
        const groups = await invoke<{ size: number; paths: string[] }[]>("find_duplicates", { dir: input.dir });
        if (!groups.length) return "No duplicate files found.";
        const lines = groups.slice(0, 10).map((g) => {
          const sizeStr = formatSize(g.size);
          const names = g.paths.slice(0, 3).join("\n    ");
          const extra = g.paths.length > 3 ? `\n    …and ${g.paths.length - 3} more copies` : "";
          return `• ${g.paths.length} copies × ${sizeStr}:\n    ${names}${extra}`;
        });
        return `Found ${groups.length} duplicate group(s):\n${lines.join("\n")}`;
      }
      case "find_unused": {
        const days = (input.days as number) ?? 90;
        const rows = await invoke<{ path: string; name: string; size: number; last_activity: number | null }[]>(
          "find_unused", { dir: input.dir, days }
        );
        if (!rows.length) return `No files inactive for ${days}+ days were found in ${input.dir}.`;
        const lines = rows.slice(0, 20).map((r) => {
          const last = r.last_activity
            ? new Date(r.last_activity * 1000).toLocaleDateString()
            : "never opened";
          return `• ${r.name} — ${formatSize(r.size)} — ${last}`;
        });
        const more = rows.length > 20 ? `\n…and ${rows.length - 20} more` : "";
        return `${rows.length} file(s) inactive for ${days}+ days:\n${lines.join("\n")}${more}`;
      }
      case "summarize_folder": {
        const stats = await invoke<{
          total_size: number;
          file_count: number;
          dir_count: number;
          breakdown: { ext: string; count: number; size: number }[];
        }>("get_folder_stats", { path: input.path });

        // Group extensions into human categories
        const cats: Record<string, { count: number; size: number; exts: string[] }> = {};
        const catFor = (ext: string): string => {
          const e = ext.toLowerCase();
          if (["pdf"].includes(e)) return "PDFs";
          if (["doc", "docx", "odt", "rtf"].includes(e)) return "Word documents";
          if (["xls", "xlsx", "csv", "ods", "tsv"].includes(e)) return "Spreadsheets";
          if (["ppt", "pptx", "odp", "key"].includes(e)) return "Presentations";
          if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic"].includes(e)) return "Images";
          if (["mp4", "mkv", "avi", "mov", "webm"].includes(e)) return "Videos";
          if (["mp3", "wav", "flac", "ogg", "m4a"].includes(e)) return "Audio";
          if (["zip", "tar", "gz", "7z", "rar"].includes(e)) return "Archives";
          if (["txt", "md", "log"].includes(e)) return "Text files";
          if (["exe", "msi", "dll", "deb", "appimage"].includes(e)) return "Programs/installers";
          if (["rs", "js", "ts", "tsx", "jsx", "py", "go", "java", "c", "cpp", "h", "cs", "rb", "php", "sh", "lua"].includes(e)) return "Code files";
          if (["json", "toml", "yaml", "yml", "xml", "ini", "cfg", "conf"].includes(e)) return "Config files";
          if (!e) return "(no extension)";
          return `.${e} files`;
        };
        for (const b of stats.breakdown) {
          const cat = catFor(b.ext);
          if (!cats[cat]) cats[cat] = { count: 0, size: 0, exts: [] };
          cats[cat].count += b.count;
          cats[cat].size += b.size;
          if (b.ext && !cats[cat].exts.includes(b.ext)) cats[cat].exts.push(b.ext);
        }
        const sorted = Object.entries(cats).sort(([, a], [, b]) => b.count - a.count);
        const lines = sorted.map(([cat, v]) => {
          const extPart = v.exts.length && !cat.endsWith("files") ? ` (${v.exts.slice(0, 3).join(", ")}${v.exts.length > 3 ? "…" : ""})` : "";
          return `- ${v.count} ${cat}${extPart} — ${formatSize(v.size)}`;
        });
        return [
          `Folder: ${input.path}`,
          `${stats.file_count} files in ${stats.dir_count} subfolders, ${formatSize(stats.total_size)} total.`,
          "",
          "Breakdown by category:",
          ...lines,
        ].join("\n");
      }
      case "get_file_snippets": {
        const page = await invoke<{
          snippets: { path: string; name: string; snippet: string }[];
          total: number; offset: number; has_more: boolean;
        }>("get_file_snippets", {
          dir: input.dir,
          offset: input.offset ?? 0,
          limit: input.limit ?? 50,
        });
        if (!page.snippets.length && page.total === 0)
          return "No indexed files found in this directory.";
        const lines = page.snippets.map(
          (s) => `${s.name}: "${s.snippet.replace(/\s+/g, " ").trim()}"`
        );
        const header = `Showing files ${page.offset + 1}–${page.offset + page.snippets.length} of ${page.total} total.`;
        const more = page.has_more
          ? `\nCall again with offset=${page.offset + page.snippets.length} to see the next batch.`
          : "";
        return `${header}${more}\n\n${lines.join("\n")}`;
      }
      case "move_path": {
        await invoke("move_path", { src: input.src, dstDir: input.dst_dir });
        onRefreshDir?.(String(input.dst_dir));
        onRefreshDir?.(String(input.src).replace(/[/\\][^/\\]+$/, "") || String(input.src));
        return `Moved ${input.src} → ${input.dst_dir}`;
      }
      case "plan_moves": {
        if (!requestPlan) return "plan_moves not supported in this context.";
        const moves = (input.moves as PlanMove[]) ?? [];
        const summary = String(input.summary ?? "");
        if (!moves.length) return "No moves provided.";

        // Validate that src paths actually exist before showing the confirmation UI
        const missing: string[] = [];
        await Promise.all(moves.map(async (m) => {
          if (m.dst_dir === "trash") return; // trash is always valid
          try {
            await invoke("index_file_by_path", { path: m.src });
          } catch (e) {
            if (!String(e).includes("is_directory")) {
              missing.push(m.src.split(/[/\\]/).pop() ?? m.src);
            }
          }
        }));
        if (missing.length) {
          return `Cannot proceed — ${missing.length} file(s) not found:\n${missing.join("\n")}`;
        }

        const approved = await requestPlan({ moves, summary });
        if (!approved) return "Plan cancelled by user.";

        let done = 0;
        const errors: string[] = [];
        for (const m of moves) {
          try {
            if (m.dst_dir === "trash") {
              await invoke("move_to_trash", { paths: [m.src] });
            } else {
              await invoke("create_directory", { path: m.dst_dir }).catch(() => {});
              await invoke("move_path", { src: m.src, dstDir: m.dst_dir });
            }
            done++;
          } catch (e) {
            errors.push(`✗ ${m.src.split(/[/\\]/).pop()} → ${m.dst_dir}: ${e}`);
          }
        }
        // Refresh all affected directories
        const dirs = new Set<string>([
          ...moves.map((m) => m.dst_dir),
          ...moves.map((m) => m.src.replace(/[/\\][^/\\]+$/, "") || m.src),
        ]);
        for (const d of dirs) onRefreshDir?.(d);

        return errors.length
          ? `Moved ${done}/${moves.length} files.\n${errors.join("\n")}`
          : `Done — moved ${done} file${done !== 1 ? "s" : ""} successfully.`;
      }

      // ── Write / create ────────────────────────────────────────────────────
      case "create_file": {
        const path = await invoke<string>("create_file", { dir: input.dir, name: input.name });
        onRefreshDir?.(String(input.dir));
        // Post-action validation: confirm the file is actually on disk
        const exists = await invoke<number>("index_file_by_path", { path }).then(() => true).catch(() => false);
        return exists
          ? `✓ Verified — file exists at ${path}`
          : `Created file: ${path} (but verification failed — check the path)`;
      }
      case "create_dir": {
        await invoke("create_directory", { path: input.path });
        const parent = String(input.path).replace(/[/\\][^/\\]+$/, "") || String(input.path);
        onRefreshDir?.(parent);
        // Verify by indexing — index_file_by_path returns 'is_directory' for dirs (success signal)
        const verified = await invoke("index_file_by_path", { path: input.path })
          .then(() => false)
          .catch((e) => String(e).includes("is_directory"));
        return verified
          ? `✓ Verified — directory created at ${input.path}`
          : `Created directory: ${input.path} (verification inconclusive)`;
      }
      case "rename_path": {
        await invoke("rename_path", { oldPath: input.old_path, newPath: input.new_path });
        const parent = String(input.old_path).replace(/[/\\][^/\\]+$/, "") || String(input.old_path);
        onRefreshDir?.(parent);
        // Verify: new path exists, old does not
        const newExists = await invoke("index_file_by_path", { path: input.new_path })
          .then(() => true)
          .catch((e) => String(e).includes("is_directory"));
        const oldGone = await invoke("index_file_by_path", { path: input.old_path })
          .then(() => false)
          .catch((e) => !String(e).includes("is_directory"));
        return newExists && oldGone
          ? `✓ Verified — renamed ${input.old_path} → ${input.new_path}`
          : `Rename reported success but verification failed: new exists=${newExists}, old gone=${oldGone}`;
      }
      case "write_file": {
        await invoke("write_file", { path: input.path, content: input.content });
        // Verify: file exists and has the requested length (sanity check)
        const expectedLen = String(input.content ?? "").length;
        let actualLen = -1;
        try {
          const back = await invoke<string>("read_file_full", { path: input.path });
          actualLen = back.length;
        } catch { /* unreadable — keep -1 */ }
        return actualLen === expectedLen
          ? `✓ Verified — file written at ${input.path} (${expectedLen} chars)`
          : `File written at ${input.path} but verification gave ${actualLen} chars vs expected ${expectedLen}`;
      }
      case "delete_path": {
        if (requestConfirm) {
          const ok = await requestConfirm(`Permanently delete:\n${input.path}`);
          if (!ok) return "Cancelled by user.";
        }
        await invoke("delete_path", { path: input.path });
        return `Deleted: ${input.path}`;
      }

      // ── Tag management ────────────────────────────────────────────────────
      case "remove_tag_from_file": {
        const tag = tags.find((t) => t.name.toLowerCase() === String(input.tag_name).toLowerCase());
        if (!tag) return `Tag "${input.tag_name}" not found.`;
        let fileId: number | null = null;
        try {
          fileId = await invoke<number>("index_file_by_path", { path: input.path });
          await invoke("remove_tag_from_file", { fileId, tagId: tag.id, contextId });
        } catch (e) {
          if (String(e).includes("is_directory")) {
            await invoke("remove_tag_from_folder", { path: input.path, tagId: tag.id, contextId });
          } else throw e;
        }
        await refreshTags?.(String(input.path), fileId);
        return `Tag "${tag.name}" removed from ${input.path}`;
      }
      case "create_tag": {
        const tagId = await invoke<number>("create_tag", { name: input.name, color: input.color ?? null });
        return `Tag "${input.name}" created (id=${tagId})`;
      }
      case "remember": {
        const id = await invoke<number>("add_ai_memory", { content: input.content });
        return `Saved to memory [${id}]: ${input.content}`;
      }
      case "forget": {
        await invoke("delete_ai_memory", { id: input.id });
        return `Memory [${input.id}] deleted.`;
      }

      // ── Workspace notes ─────────────────────────────────────────────────
      case "get_workspace_notes": {
        const s = await notesLoad(contextId);
        const taskLines = s.tasks.length
          ? s.tasks.map(notesFormatTask).join("\n")
          : "(no tasks)";
        const notesBlock = s.notes.trim() ? `\n\n## Free-form notes\n${s.notes}` : "";
        return `## Tasks (${s.tasks.length})\n${taskLines}${notesBlock}`;
      }
      case "add_task": {
        const s = await notesLoad(contextId);
        const date = String(input.due_date ?? "").trim();
        const time = String(input.due_time ?? "").trim();
        let due: string | undefined;
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          due = time && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}` : date;
        }
        const id = Math.random().toString(36).slice(2, 10);
        const task: NoteTask = { id, done: false, text: String(input.text), due };
        s.tasks.push(task);
        await notesSave(contextId, s);
        const dueStr = due ? ` with due date ${due}` : "";
        return `SUCCESS: Task "${task.text}"${dueStr} was added to the workspace tasks. The task id is ${task.id}. Tell the user the task is created. Do NOT ask for confirmation.`;
      }
      case "toggle_task": {
        const s = await notesLoad(contextId);
        const t = notesFindTask(s, String(input.match));
        if (!t) {
          const hint = s.tasks.length
            ? ` Available tasks (look for the one the user meant): ${s.tasks.map((x) => `"${x.text}"`).join(", ")}.`
            : "";
          return `FAILURE: No task matched "${input.match}".${hint} Pick the right task by its actual text and retry.`;
        }
        t.done = !t.done;
        await notesSave(contextId, s);
        return `SUCCESS: Task "${t.text}" is now ${t.done ? "DONE" : "todo"}. Tell the user.`;
      }
      case "delete_task": {
        const s = await notesLoad(contextId);
        const t = notesFindTask(s, String(input.match));
        if (!t) {
          const hint = s.tasks.length
            ? ` Available tasks: ${s.tasks.map((x) => `"${x.text}"`).join(", ")}.`
            : "";
          return `FAILURE: No task matched "${input.match}".${hint} Pick the right one and retry.`;
        }
        s.tasks = s.tasks.filter((x) => x.id !== t.id);
        await notesSave(contextId, s);
        return `SUCCESS: Task "${t.text}" was deleted. Tell the user.`;
      }
      case "set_task_due": {
        const s = await notesLoad(contextId);
        const t = notesFindTask(s, String(input.match));
        if (!t) {
          const hint = s.tasks.length
            ? ` Available tasks: ${s.tasks.map((x) => `"${x.text}"`).join(", ")}.`
            : "";
          return `FAILURE: No task matched "${input.match}".${hint} Pick the right task and retry — do NOT call add_task.`;
        }
        const date = input.due_date === "" ? "" : String(input.due_date ?? "").trim();
        const time = input.due_time === "" ? "" : String(input.due_time ?? "").trim();
        if (date === "") {
          t.due = undefined;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          t.due = time && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}` : date;
        }
        // If only due_time provided and there's already a date, update time.
        if (!input.due_date && time && t.due) {
          const d = t.due.slice(0, 10);
          t.due = /^\d{2}:\d{2}$/.test(time) ? `${d}T${time}` : d;
        }
        await notesSave(contextId, s);
        return `SUCCESS: Task "${t.text}" due date is now ${t.due ?? "(cleared)"}. Tell the user.`;
      }
      case "edit_task_text": {
        const s = await notesLoad(contextId);
        const t = notesFindTask(s, String(input.match));
        if (!t) {
          const hint = s.tasks.length
            ? ` Available tasks: ${s.tasks.map((x) => `"${x.text}"`).join(", ")}.`
            : "";
          return `FAILURE: No task matched "${input.match}".${hint}`;
        }
        const old = t.text;
        t.text = String(input.new_text);
        await notesSave(contextId, s);
        return `SUCCESS: Task "${old}" renamed to "${t.text}". Tell the user.`;
      }
      case "set_workspace_notes_text": {
        const s = await notesLoad(contextId);
        s.notes = String(input.content ?? "");
        await notesSave(contextId, s);
        return `✓ Notes section replaced (${s.notes.length} chars).`;
      }
      case "append_to_workspace_notes": {
        const s = await notesLoad(contextId);
        const appended = String(input.content ?? "");
        s.notes = s.notes.trim() ? `${s.notes}\n\n${appended}` : appended;
        await notesSave(contextId, s);
        return `✓ Appended to notes (${s.notes.length} chars total).`;
      }
      case "bulk_task_action": {
        const s = await notesLoad(contextId);
        const action = String(input.action ?? "").toLowerCase().trim();
        const scopeRaw = String(input.scope ?? "").toLowerCase().trim();
        if (!s.tasks.length) return `FAILURE: No tasks exist in this workspace.`;
        if (!["done", "undone", "toggle", "delete"].includes(action))
          return `FAILURE: Unknown action "${action}". Use done | undone | toggle | delete.`;

        // Resolve which tasks to act on
        let targets: NoteTask[];
        if (scopeRaw === "all" || scopeRaw === "tous" || scopeRaw === "tout" || scopeRaw === "both" || scopeRaw === "les deux") {
          targets = [...s.tasks];
        } else if (scopeRaw === "undone" || scopeRaw === "todo" || scopeRaw === "pending") {
          targets = s.tasks.filter((t) => !t.done);
        } else if (scopeRaw === "done" || scopeRaw === "completed") {
          targets = s.tasks.filter((t) => t.done);
        } else {
          targets = s.tasks.filter((t) => t.text.toLowerCase().includes(scopeRaw));
        }
        if (!targets.length) return `FAILURE: Scope "${input.scope}" matched no task. Tasks available: ${s.tasks.map((t) => `"${t.text}"`).join(", ")}.`;

        // Apply
        if (action === "delete") {
          const ids = new Set(targets.map((t) => t.id));
          s.tasks = s.tasks.filter((t) => !ids.has(t.id));
        } else {
          for (const t of targets) {
            if (action === "done")        t.done = true;
            else if (action === "undone") t.done = false;
            else                          t.done = !t.done; // toggle
          }
        }
        await notesSave(contextId, s);
        const verb = action === "delete" ? "deleted" : action === "done" ? "marked done" : action === "undone" ? "marked todo" : "toggled";
        const list = targets.map((t) => `"${t.text}"`).join(", ");
        return `SUCCESS: ${targets.length} task(s) ${verb}: ${list}. Tell the user.`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e}`;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

interface PromptCtx {
  currentPath: string;
  listEntries: ListEntry[];
  tags: Tag[];
  tagStats: Array<{ tag_id: number; count: number }>;
  rootPaths: string[];
  contexts: Array<{ id: number; name: string; icon: string; watched_paths: string[] }>;
  activeContextId: number | null;
  selectedPaths: string[];
  viewMode: string;
  memories: { id: number; content: string }[];
  userInstructions: string;
  workspaceNotes: NotesState; // current workspace tasks + free notes, injected for context
}

/// Resolve relative date and time expressions inside the user's message and append
/// them as an explicit `[Resolved: ...]` annotation at the end of the same message.
/// Small Ollama models routinely ignore the system prompt's date block and dump
/// dates from their training data. Inlining the resolution right next to the trigger
/// word is the most reliable way to force the correct value.
function resolveRelativeDatesInMessage(text: string): string {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offsetDate = (n: number) => { const d = new Date(today); d.setDate(today.getDate() + n); return d; };

  const resolved: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, iso: string) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(`"${label}" = ${iso}`);
  };

  // ── Static keyword patterns (case-insensitive) ───────────────────────────
  const patterns: { regex: RegExp; offset: number; canonical: string }[] = [
    { regex: /\baujourd['’]hui\b/i, offset: 0, canonical: "aujourd'hui" },
    { regex: /\btoday\b/i,               offset: 0, canonical: "today" },
    { regex: /\bdemain\b/i,              offset: 1, canonical: "demain" },
    { regex: /\btomorrow\b/i,            offset: 1, canonical: "tomorrow" },
    { regex: /\baprès[- ]demain\b/i, offset: 2, canonical: "après-demain" },
    { regex: /\bday after tomorrow\b/i,   offset: 2, canonical: "day after tomorrow" },
    { regex: /\bsemaine prochaine\b/i,    offset: 7, canonical: "semaine prochaine" },
    { regex: /\bnext week\b/i,            offset: 7, canonical: "next week" },
    { regex: /\bdans une semaine\b/i,     offset: 7, canonical: "dans une semaine" },
    { regex: /\bin a week\b/i,            offset: 7, canonical: "in a week" },
    { regex: /\bdans un mois\b/i,         offset: 30, canonical: "dans un mois" },
    { regex: /\bin a month\b/i,           offset: 30, canonical: "in a month" },
  ];
  for (const p of patterns) {
    if (p.regex.test(text)) add(p.canonical, fmt(offsetDate(p.offset)));
  }

  // ── "Dans X jours" / "in X days" ─────────────────────────────────────────
  const num = (re: RegExp) => {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n < 366) add(m[0], fmt(offsetDate(n)));
    }
  };
  num(/\bdans\s+(\d+)\s+jours?\b/i);
  num(/\bin\s+(\d+)\s+days?\b/i);

  // ── Day-of-week names (lundi prochain / next Monday / etc.) ──────────────
  const days = [
    { fr: ["dimanche"],  en: ["sunday"],    idx: 0 },
    { fr: ["lundi"],     en: ["monday"],    idx: 1 },
    { fr: ["mardi"],     en: ["tuesday"],   idx: 2 },
    { fr: ["mercredi"],  en: ["wednesday"], idx: 3 },
    { fr: ["jeudi"],     en: ["thursday"],  idx: 4 },
    { fr: ["vendredi"],  en: ["friday"],    idx: 5 },
    { fr: ["samedi"],    en: ["saturday"],  idx: 6 },
  ];
  const dow = today.getDay();
  for (const d of days) {
    const names = [...d.fr, ...d.en];
    for (const name of names) {
      const re = new RegExp(`\\b${name}(?:\\s+prochain[e]?|\\s+next)?\\b`, "i");
      if (re.test(text)) {
        const delta = ((d.idx - dow) + 7) % 7 || 7; // strictly future
        add(name, fmt(offsetDate(delta)));
        break;
      }
    }
  }

  // ── Times: "à 14h", "14h30", "at 14:00", "14h" ───────────────────────────
  const timeMatches = Array.from(text.matchAll(/\b(\d{1,2})\s*h(?:\s*(\d{2}))?\b/gi));
  for (const tm of timeMatches) {
    const h = parseInt(tm[1], 10);
    const mm = tm[2] ? parseInt(tm[2], 10) : 0;
    if (h <= 23 && mm <= 59) {
      add(tm[0], `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
    }
  }
  const colonTimes = Array.from(text.matchAll(/\b(\d{1,2}):(\d{2})\b/g));
  for (const tm of colonTimes) {
    const h = parseInt(tm[1], 10);
    const mm = parseInt(tm[2], 10);
    if (h <= 23 && mm <= 59) {
      add(tm[0], `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
    }
  }

  if (!resolved.length) return text;
  return `${text}\n\n[Resolved: ${resolved.join("; ")}]`;
}

/// Compute today + a few useful relative dates as YYYY-MM-DD strings using LOCAL time.
/// Using `toISOString()` would drift across midnight in non-UTC timezones; we want the
/// date the user sees on their wall calendar, not UTC.
function computeDateBlock(): string {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const dayAfter = new Date(today); dayAfter.setDate(today.getDate() + 2);
  const inAWeek  = new Date(today); inAWeek.setDate(today.getDate() + 7);
  const inMonth  = new Date(today); inMonth.setDate(today.getDate() + 30);

  // Next Monday (1) ... Next Sunday (7). 0 = Sunday in JS; treat Mon=1.
  const dow = today.getDay();
  const daysToMon = ((1 - dow) + 7) % 7 || 7; // always strictly future
  const daysToFri = ((5 - dow) + 7) % 7 || 7;
  const nextMon = new Date(today); nextMon.setDate(today.getDate() + daysToMon);
  const nextFri = new Date(today); nextFri.setDate(today.getDate() + daysToFri);

  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];
  return [
    `- Today        = ${fmt(today)}   (${dayName})`,
    `- Tomorrow     = ${fmt(tomorrow)}`,
    `- Day after    = ${fmt(dayAfter)}`,
    `- In 7 days    = ${fmt(inAWeek)}`,
    `- In 30 days   = ${fmt(inMonth)}`,
    `- Next Monday  = ${fmt(nextMon)}`,
    `- Next Friday  = ${fmt(nextFri)}`,
  ].join("\n");
}

function buildSystemPrompt(ctx: PromptCtx): string {
  const { currentPath, listEntries, tags, tagStats, rootPaths, contexts, activeContextId, selectedPaths, viewMode, memories, userInstructions, workspaceNotes } = ctx;

  // Render the current workspace's tasks + free notes so the model can act on them
  // without an extra round-trip to get_workspace_notes. Kept compact: no padding,
  // no labels, and we omit empty sections entirely to keep token cost minimal.
  // Empty workspace → empty string, prompt drops the whole CURRENT TASKS section.
  const notesBlock = (() => {
    const hasTasks = workspaceNotes.tasks.length > 0;
    const hasNotes = workspaceNotes.notes.trim().length > 0;
    if (!hasTasks && !hasNotes) return "";
    const lines: string[] = [];
    if (hasTasks) {
      for (const t of workspaceNotes.tasks) {
        const box = t.done ? "[x]" : "[ ]";
        const due = t.due ? ` (${t.due})` : "";
        lines.push(`${box} ${t.text}${due} [${t.id}]`);
      }
    }
    if (hasNotes) {
      const snippet = workspaceNotes.notes.slice(0, 400);
      lines.push(`Notes: ${snippet}${workspaceNotes.notes.length > 400 ? "…" : ""}`);
    }
    return lines.join("\n");
  })();

  // Detect user language from browser locale for explicit language injection
  const lang = typeof navigator !== "undefined"
    ? (navigator.language.startsWith("fr") ? "French" :
       navigator.language.startsWith("de") ? "German" :
       navigator.language.startsWith("es") ? "Spanish" :
       navigator.language.startsWith("it") ? "Italian" :
       navigator.language.startsWith("pt") ? "Portuguese" : "English")
    : "English";

  // Show a compact folder summary instead of the full file list — the full list
  // was causing the model to use it as a fake search result instead of calling search_files.
  const dirs = listEntries.filter((e) => e.is_dir);
  const files = listEntries.filter((e) => !e.is_dir);
  const taggedCount = files.filter((e) => e.tags.length > 0).length;
  const folderSummary = currentPath
    ? `${dirs.length} folders, ${files.length} files${taggedCount ? ` (${taggedCount} tagged)` : ""}. Call list_directory("${currentPath}") to see the full contents.`
    : "(no folder open)";

  // Only show a few selected files if any are explicitly selected
  const selectionBlock = selectedPaths.length
    ? selectedPaths.slice(0, 10).map((p) => `  • ${p}`).join("\n")
    : "  (nothing selected)";

  const activeCtx = contexts.find((c) => c.id === activeContextId);
  const workspaceBlock = activeCtx
    ? `- **Active workspace**: "${activeCtx.icon} ${activeCtx.name}" (id=${activeCtx.id})\n- **Workspace folders**: ${activeCtx.watched_paths.join(", ")}`
    : `- **Workspace folders**: ${rootPaths.join(", ") || "(global mode)"}`;

  const allWorkspaces = contexts.length
    ? contexts.map((c) => `  • [${c.id}] ${c.icon} ${c.name} — ${c.watched_paths.join(", ")}`).join("\n")
    : "  (none)";

  const tagCountMap = Object.fromEntries(tagStats.map((s) => [s.tag_id, s.count]));
  const tagBlock = tags.length
    ? tags.map((t) => `  • name="${t.name}" (${tagCountMap[t.id] ?? 0} files)`).join("\n")
    : "  (no tags defined)";

  return `You are an AI assistant embedded in nxs, a Windows file manager. You help the user manage files by calling tools.

LANGUAGE: The user's system language is ${lang}. Always respond in ${lang} regardless of what language you were trained in.

CURRENT DATE — USE THESE EXACT VALUES, DO NOT COMPUTE OR GUESS:
${computeDateBlock()}

CRITICAL RULES:
- You have REAL tools. CALL THE TOOL — never describe what you would do or guess based on context.
- NEVER invent file names, paths, or content. You have no knowledge of files unless a tool tells you.
- NEVER claim success without having called the tool first.
- Report only what the tool returned. Do not embellish or invent.
- NEVER invent or guess a date. Your training data is outdated. Use ONLY the values from the CURRENT DATE block above. If the user says "tomorrow", pass the value next to "Tomorrow". If they say "in a week", use "In 7 days". For other relative expressions, derive them by counting days from Today.

UNDERSTANDING A FOLDER:
- When the user asks "what's in this folder?", "what kind of files are here?", "what's this about?" or any high-level question about a folder's content: call summarize_folder FIRST. It returns a clean category breakdown (PDFs, images, code…) much easier to discuss than a raw file list.
- ONLY call list_directory when you need specific file names (e.g. to tag or move). NEVER dump a raw list as an answer to "what's in here".
- If the user wants deeper insight on what specific files contain, call get_file_snippets after summarize_folder.

FINDING FILES — MANDATORY BEHAVIOR:
- The user's current folder summary is shown below. It is NOT a search result. DO NOT use it to answer file-finding questions.
- When the user asks to find a file: call search_files IMMEDIATELY with the most distinctive keyword. Do NOT ask questions first.
- NEVER say "I found a file named X" if you have not called search_files or list_directory and seen X in the result.
- DO NOT use get_recent_activity to find files — it only shows history, not file locations.
- DO NOT use list_directory as a substitute for search_files — it only shows one folder.
- If search_files returns nothing, report exactly what it said. Do not invent alternatives.
- When you find a PDF or document and need to verify its content (e.g. "does this contain Focus?"), call preview_file(path) immediately — do NOT guess or say it doesn't contain something without checking.
- preview_file works on PDF, DOCX, XLSX, PPTX, and text files. Always use it to confirm document content before telling the user a file does or doesn't match.

WRITING FILES:
- To write content: use write_file (works on new and existing files). Never use create_file for this.
- Never double-add extensions: "notes.txt" not "notes.txt.txt".

TAGGING:
- Tag names are plain strings ("Archives"). Never use "[id=27]" as a name.
- To tag MANY files in a folder by extension or name pattern: use tag_files_matching ONCE (e.g. extension="pdf", tag_name="Archives"). Never loop over add_tag_to_file when a pattern works.
- Use add_tag_to_file only when you need to tag a specific known file path.

CLEANUP & MAINTENANCE:
- "Find duplicates" / "any copies?" → find_duplicates(dir). Reports groups of files with same name + size.
- "Old files / haven't been used / what can I delete?" → find_unused(dir, days=N). Uses the local activity log.

NOTES & TASKS:
- SINGLE task: "coche/check/mark done X" → toggle_task(match=X). "supprime X" → delete_task(match=X). "ajoute X [date]" → add_task.
- MULTIPLE tasks at once: ALWAYS use bulk_task_action. Triggers: "les deux/both", "tous/all", "tous les non finis/all undone", "tous ceux qui contiennent X", "all the X", etc.
  Examples:
    "coche les deux" → bulk_task_action(action="done", scope="all")
    "supprime tous les test" → bulk_task_action(action="delete", scope="test")
    "marque tous les non finis comme faits" → bulk_task_action(action="done", scope="undone")
- NEVER ask the user to clarify when intent is clearly plural — just call bulk_task_action.
- When the user refers to "the task", "le todo", "it", "the previous one" — they mean a task that ALREADY EXISTS. Look at CURRENT TASKS below. DO NOT call add_task — call toggle_task/set_task_due/edit_task_text/delete_task with the EXACT text or id from CURRENT TASKS.
- Resolved dates appear in user msg as "[Resolved: ...]" — use those values as-is.
${notesBlock ? `\nCURRENT TASKS (live):\n${notesBlock}` : ""}

RECENT FILES / ACTIVITY:
- "what are my recent files?" / "what did I open recently?" → call get_recent_activity. NEVER invent activity. Don't pivot to organizing or other topics — answer the actual question with the tool result.

ORGANIZING:
Step 1: list_directory → Step 2: get_file_snippets → Step 3: plan_moves (one call with all moves).
For large folders (500+ files): ask the user if they want to organize by type/date (fast) or by content (reads files).
NEVER call move_path directly for batch operations — always plan_moves so the user can review.

## Current state
${workspaceBlock}
Current folder: ${currentPath || "(none)"} — ${folderSummary}
View: ${viewMode}

### All workspaces
${allWorkspaces}

### Tags defined
${tagBlock}

### Selected files
${selectionBlock}

## Path rules
- Windows absolute paths with backslashes: C:\\Users\\Name\\Documents
- "Here" / "this folder" / "current folder" = ${currentPath || "(no folder open)"}
- add_tag_to_file works on both files AND folders

## Your memory about this user
${memories.length
  ? memories.map((m) => `  [${m.id}] ${m.content}`).join("\n")
  : "  (nothing saved yet)"}
- Use remember() to save anything useful across sessions: user preferences, naming conventions, project context, recurring folder structures.
- Use forget(id) to delete an outdated or wrong memory.
- Save proactively: if the user tells you something about how they work, remember it without being asked.${
  userInstructions.trim()
    ? `\n\n## User's personal instructions (always follow)\n${userInstructions.trim()}`
    : ""
}`;
}

// ── Agentic loops (one per provider) ─────────────────────────────────────────

type ConfirmFn = (msg: string) => Promise<boolean>;

async function runAnthropicLoop(
  apiKey: string, model: string, system: string,
  history: AnthropicMsg[],
  tags: Tag[], contextId: number, onNavigate: (p: string) => void,
  onToolActivity: (name: string | null) => void,
  abortRef: React.MutableRefObject<boolean>,
  requestConfirm: ConfirmFn,
  refreshTags: RefreshTagsFn,
  onRefreshDir?: (p: string) => void,
  requestPlan?: PlanFn,
  onTextDelta?: (chunk: string) => void,
  abortController?: AbortController,
): Promise<string> {
  let msgs: AnthropicMsg[] = [...history];

  while (true) {
    if (abortRef.current) return "";
    // Streaming call: text deltas flow to the UI live; tool calls accumulate and
    // surface at end of stream (same shape as the non-streaming response).
    const resp = onTextDelta && abortController
      ? await callAnthropicStream(apiKey, model, system, msgs, onTextDelta, abortController.signal)
      : await callAnthropic(apiKey, model, system, msgs);

    const texts = resp.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
    const toolCalls = resp.content.filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use"
    );

    if (resp.stop_reason !== "tool_use" || !toolCalls.length) {
      return texts.map((b) => b.text).join("\n");
    }

    const results: AnthropicBlock[] = [];
    for (const tc of toolCalls) {
      if (abortRef.current) return texts.map((b) => b.text).join("\n");
      onToolActivity(tc.name);
      const result = await executeTool(tc.name, tc.input, tags, contextId, onNavigate,
        DESTRUCTIVE_TOOLS.has(tc.name) ? requestConfirm : undefined,
        refreshTags, onRefreshDir, requestPlan);
      results.push({ type: "tool_result", tool_use_id: tc.id, content: result });
    }
    onToolActivity(null);

    msgs = [
      ...msgs,
      { role: "assistant", content: resp.content as AnthropicBlock[] },
      { role: "user", content: results },
    ];
  }
}

async function runOllamaLoop(
  baseUrl: string, model: string, system: string,
  history: OllamaMsg[],
  tags: Tag[], contextId: number, onNavigate: (p: string) => void,
  onToolActivity: (name: string | null) => void,
  abortRef: React.MutableRefObject<boolean>,
  requestConfirm: ConfirmFn,
  refreshTags: RefreshTagsFn,
  onRefreshDir?: (p: string) => void,
  requestPlan?: PlanFn,
  onTextDelta?: (chunk: string) => void,
  abortController?: AbortController,
): Promise<string> {
  let msgs: OllamaMsg[] = [...history];

  while (true) {
    if (abortRef.current) return "";
    const resp = onTextDelta && abortController
      ? await callOllamaStream(baseUrl, model, system, msgs, onTextDelta, abortController.signal)
      : await callOllama(baseUrl, model, system, msgs);
    const { content, tool_calls } = resp.message;

    if (!tool_calls?.length) {
      return content;
    }

    msgs = [...msgs, { role: "assistant", content, tool_calls }];
    for (const tc of tool_calls) {
      if (abortRef.current) return content;
      const args = typeof tc.function.arguments === "string"
        ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
        : tc.function.arguments;
      onToolActivity(tc.function.name);
      const result = await executeTool(tc.function.name, args, tags, contextId, onNavigate,
        DESTRUCTIVE_TOOLS.has(tc.function.name) ? requestConfirm : undefined,
        refreshTags, onRefreshDir, requestPlan);
      msgs = [...msgs, { role: "tool", content: result }];
    }
    onToolActivity(null);
  }
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  onNavigate: (path: string) => void;
  onRefreshDir?: (path: string) => void;
}

export function AiPanel({ onClose, onNavigate, onRefreshDir }: Props) {
  const {
    settings, currentPath, listEntries, tags, tagStats,
    activeContextId, rootPaths, contexts, selectedPaths, viewMode,
    updateFileTags, updateFolderTags,
  } = useStore();
  const t = useTranslation();

  const [memories, setMemories] = useState<{ id: number; content: string }[]>([]);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [workspaceNotes, setWorkspaceNotes] = useState<NotesState>({ tasks: [], notes: "" });
  const [messages, setMessages] = useState<DisplayMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ msg: string } | null>(null);
  const [pendingPlan, setPendingPlan] = useState<{ moves: PlanMove[]; summary: string } | null>(null);

  // Full API-history refs (one per provider), so tool exchanges are preserved across turns
  const anthropicHistoryRef = useRef<AnthropicMsg[]>([]);
  const ollamaHistoryRef = useRef<OllamaMsg[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef(false);
  // Holds the AbortController of the in-flight streaming fetch, so the Stop button
  // can abort the stream itself in addition to flipping the loop's abort flag.
  const streamAbortRef = useRef<AbortController | null>(null);
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
  const planResolveRef = useRef<((v: boolean) => void) | null>(null);

  const refreshTags: RefreshTagsFn = async (path, fileId) => {
    const ctxId = activeContextId ?? 0;
    if (fileId !== null) {
      const freshTags = await invoke<Tag[]>("get_file_tags", { fileId, contextId: ctxId }).catch(() => []);
      updateFileTags(fileId, freshTags);
    } else {
      const freshTags = await invoke<Tag[]>("get_folder_tags", { path, contextId: ctxId }).catch(() => []);
      updateFolderTags(path, freshTags);
    }
  };

  const requestConfirm = (msg: string): Promise<boolean> =>
    new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setPendingConfirm({ msg });
    });

  const requestPlan: PlanFn = (plan) =>
    new Promise((resolve) => {
      planResolveRef.current = resolve;
      setPendingPlan(plan);
    });

  // Load memories on mount
  useEffect(() => {
    invoke<{ id: number; content: string }[]>("get_ai_memories")
      .then(setMemories)
      .catch(() => {});
  }, []);

  // Load workspace notes on mount + workspace change + on every panel mutation.
  // The notes-updated CustomEvent is dispatched by NotesPanel and by our own
  // AI mutating tools so the prompt always reflects the current state.
  useEffect(() => {
    const ctxId = activeContextId ?? 0;
    const refresh = async () => {
      try {
        const raw = await invoke<string>("get_workspace_note", { contextId: ctxId });
        setWorkspaceNotes(notesParse(raw));
      } catch { /* ignore */ }
    };
    refresh();
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ contextId: number; content: string }>).detail;
      if (detail && detail.contextId === ctxId) {
        setWorkspaceNotes(notesParse(detail.content));
      }
    };
    window.addEventListener("notes-updated", onUpdate);
    return () => window.removeEventListener("notes-updated", onUpdate);
  }, [activeContextId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, toolActivity]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError(null);
    abortRef.current = false;

    setMessages((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "_loading_" }]);
    setLoading(true);

    const system = buildSystemPrompt({
      currentPath, listEntries, tags, tagStats,
      rootPaths, contexts, activeContextId, selectedPaths, viewMode, memories,
      userInstructions: settings.aiInstructions ?? "",
      workspaceNotes,
    });

    // Streaming: text deltas update the last assistant message live, instead of
    // waiting for the full response. Tool calls still appear at the end of a stream
    // and are executed before we open the next stream in the loop.
    const streamController = new AbortController();
    streamAbortRef.current = streamController;

    let streamingText = "";
    let streamingActive = false;
    const onTextDelta = (chunk: string) => {
      if (!chunk) return;
      streamingText += chunk;
      if (!streamingActive) {
        streamingActive = true;
        // Replace the "_loading_" placeholder with a live-updating bubble
        setMessages((prev) => {
          const without = prev.filter((m) => m.text !== "_loading_");
          return [...without, { role: "assistant", text: streamingText }];
        });
      } else {
        setMessages((prev) => {
          const next = [...prev];
          const lastAssist = next.length - 1;
          if (lastAssist >= 0 && next[lastAssist].role === "assistant") {
            next[lastAssist] = { ...next[lastAssist], text: streamingText };
          }
          return next;
        });
      }
    };

    // Resolve relative date/time expressions ("demain", "à 14h", "lundi prochain")
    // and inline them as a [Resolved: …] suffix. The model sees the absolute values
    // next to the trigger words, which is dramatically more reliable on small models
    // than relying on the system prompt's date block.
    const resolvedText = resolveRelativeDatesInMessage(text);

    try {
      let assistantText = "";

      if (settings.aiProvider === "anthropic") {
        const history = anthropicHistoryRef.current;
        history.push({ role: "user", content: resolvedText });
        assistantText = await runAnthropicLoop(
          settings.claudeApiKey, settings.claudeModel, system,
          history, tags, activeContextId ?? 0, onNavigate,
          (name) => setToolActivity(name), abortRef, requestConfirm, refreshTags, onRefreshDir, requestPlan,
          onTextDelta, streamController,
        );
        history.push({ role: "assistant", content: assistantText });
      } else {
        const history = ollamaHistoryRef.current;
        history.push({ role: "user", content: resolvedText });
        assistantText = await runOllamaLoop(
          settings.ollamaUrl, settings.ollamaModel, system,
          history, tags, activeContextId ?? 0, onNavigate,
          (name) => setToolActivity(name), abortRef, requestConfirm, refreshTags, onRefreshDir, requestPlan,
          onTextDelta, streamController,
        );
        history.push({ role: "assistant", content: assistantText });
      }

      setMessages((prev) => {
        const without = prev.filter((m) => m.text !== "_loading_");
        if (streamingActive && without.length > 0 && without[without.length - 1].role === "assistant") {
          // The last bubble is the streamed one. Replace its text with the final result.
          const next = [...without];
          next[next.length - 1] = { role: "assistant", text: assistantText };
          return next;
        }
        return [...without, { role: "assistant", text: assistantText }];
      });
    } catch (e: unknown) {
      // Abort errors are expected when the user clicks "Stop" — don't show them as red errors.
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = msg.includes("aborted") || msg.includes("AbortError");
      if (!isAbort) setError(msg);
      setMessages((prev) => prev.filter((m) => m.text !== "_loading_"));
    } finally {
      streamAbortRef.current = null;
      setLoading(false);
      setToolActivity(null);
      // Refresh memories in case remember/forget was called
      invoke<{ id: number; content: string }[]>("get_ai_memories")
        .then(setMemories)
        .catch(() => {});
    }
  };

  const modelLabel = settings.aiProvider === "anthropic"
    ? (settings.claudeModel.includes("haiku") ? "Haiku" : settings.claudeModel.includes("sonnet") ? "Sonnet" : "Opus")
    : settings.ollamaModel;

  const disclaimer = settings.aiProvider === "ollama" ? t.aiDisclaimerOllama : t.aiDisclaimer;

  return (
    <div className="flex flex-col h-full bg-surface-1 border-l border-border-subtle w-[340px] shrink-0 select-text">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-[48px] border-b border-border-subtle shrink-0">
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-[12px] font-semibold text-text-primary flex-1">{t.aiTitle}</span>
        <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded max-w-[100px] truncate" title={modelLabel}>
          {modelLabel}
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
            <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
              <Bot size={20} className="text-accent" />
            </div>
            <p className="text-[12px] text-text-secondary">{t.aiEmptyDesc}</p>
            <div className="flex flex-col gap-1.5 w-full mt-1">
              {[t.aiSuggestion1, t.aiSuggestion2, t.aiSuggestion3].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); inputRef.current?.focus(); }}
                  className="text-[11px] text-text-muted hover:text-accent hover:bg-accent/5 border border-border rounded px-3 py-1.5 text-left transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={clsx("flex flex-col gap-1", msg.role === "user" ? "items-end" : "items-start")}>
            {msg.text === "_loading_" ? (
              <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-3 border border-border-subtle">
                <Loader2 size={12} className="text-accent animate-spin" />
                <span className="text-[11px] text-text-muted">{t.aiThinking}</span>
              </div>
            ) : (
              <div className={clsx(
                "px-3 py-2 rounded-xl text-[12px] max-w-full",
                msg.role === "user"
                  ? "bg-accent text-white rounded-br-sm"
                  : "bg-surface-3 border border-border-subtle text-text-primary rounded-bl-sm"
              )}>
                {msg.role === "user" ? (
                  <span className="whitespace-pre-wrap">{msg.text}</span>
                ) : (
                  <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-surface-4 [&_pre]:rounded [&_pre]:p-2 [&_code]:text-[11px] [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {toolActivity && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-2 border border-border-subtle text-[11px] text-text-muted">
            <Loader2 size={11} className="text-accent animate-spin shrink-0" />
            <span className="truncate">
              {t.aiUsingTool} <span className="font-mono text-accent">{toolActivity}</span>
            </span>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-[11px] text-red-400 break-words">
            {error}
          </div>
        )}
      </div>

      {/* Destructive action confirmation */}
      {pendingConfirm && (
        <div className="mx-3 mb-2 p-3 rounded-xl bg-surface-2 border border-amber-500/30 flex flex-col gap-2 shrink-0">
          <p className="text-[11px] text-amber-400 font-medium">⚠ Confirmation required</p>
          <p className="text-[11px] text-text-primary whitespace-pre-wrap">{pendingConfirm.msg}</p>
          <div className="flex gap-2">
            <button
              onClick={() => { confirmResolveRef.current?.(true); setPendingConfirm(null); }}
              className="flex-1 h-7 rounded bg-red-500/20 text-red-400 text-[11px] hover:bg-red-500/30 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => { confirmResolveRef.current?.(false); setPendingConfirm(null); }}
              className="flex-1 h-7 rounded bg-surface-3 text-text-secondary text-[11px] hover:bg-surface-4 transition-colors"
            >
              {t.cancel}
            </button>
          </div>
        </div>
      )}

      {/* Reorganization plan confirmation */}
      {pendingPlan && (
        <div className="mx-3 mb-2 rounded-xl bg-surface-2 border border-indigo-500/30 flex flex-col shrink-0 overflow-hidden">
          <div className="px-3 pt-2.5 pb-1.5 border-b border-border-subtle">
            <p className="text-[11px] text-indigo-400 font-semibold mb-0.5">Reorganization plan</p>
            <p className="text-[11px] text-text-secondary">{pendingPlan.summary}</p>
          </div>
          <div className="overflow-y-auto max-h-48 px-3 py-2 flex flex-col gap-1">
            {pendingPlan.moves.map((m, i) => {
              const fileName = m.src.replace(/.*[/\\]/, "");
              const destName = m.dst_dir.replace(/.*[/\\]/, "") || m.dst_dir;
              return (
                <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="text-text-secondary truncate min-w-0 flex-1">{fileName}</span>
                  <span className="text-text-muted shrink-0">→</span>
                  <span className="text-indigo-300 shrink-0 font-medium">{destName}/</span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 px-3 py-2 border-t border-border-subtle">
            <button
              onClick={() => { planResolveRef.current?.(false); setPendingPlan(null); }}
              className="flex-1 h-7 rounded bg-surface-3 text-text-secondary text-[11px] hover:bg-surface-4 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { planResolveRef.current?.(true); setPendingPlan(null); }}
              className="flex-1 h-7 rounded bg-indigo-600 text-white text-[11px] hover:bg-indigo-500 transition-colors font-medium"
            >
              Apply {pendingPlan.moves.length} move{pendingPlan.moves.length !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      )}

      {/* Memory panel */}
      <div className="border-t border-border-subtle shrink-0">
        <button
          onClick={() => setMemoriesOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
        >
          <Brain size={11} className="shrink-0" />
          <span className="flex-1 text-left">Memory ({memories.length})</span>
          <ChevronDown size={11} className={clsx("transition-transform", memoriesOpen && "rotate-180")} />
        </button>
        {memoriesOpen && (
          <div className="px-3 pb-2 flex flex-col gap-1 max-h-36 overflow-y-auto">
            {memories.length === 0 && (
              <p className="text-[11px] text-text-muted italic">Nothing saved yet.</p>
            )}
            {memories.map((m) => (
              <div key={m.id} className="flex items-start gap-1.5 group">
                <span className="text-[11px] text-text-secondary flex-1 leading-relaxed">{m.content}</span>
                <button
                  onClick={async () => {
                    await invoke("delete_ai_memory", { id: m.id });
                    setMemories((prev) => prev.filter((x) => x.id !== m.id));
                  }}
                  className="shrink-0 text-text-muted hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 mt-0.5"
                  title="Forget this"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-2 border-t border-border-subtle shrink-0">
        <div className="flex items-end gap-2 bg-surface-3 rounded-xl border border-border focus-within:border-accent transition-colors px-3 py-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder={t.aiPlaceholder}
            rows={1}
            className="flex-1 bg-transparent text-[12px] text-text-primary placeholder-text-muted resize-none outline-none min-h-[20px] max-h-[120px] overflow-y-auto leading-5"
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
            disabled={loading}
          />
          {loading ? (
            <button
              onClick={() => {
                abortRef.current = true;
                streamAbortRef.current?.abort();
                streamAbortRef.current = null;
                setLoading(false);
                setToolActivity(null);
              }}
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors shrink-0"
              title={t.aiStop}
            >
              <ChevronDown size={13} />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className={clsx(
                "w-7 h-7 flex items-center justify-center rounded-lg transition-colors shrink-0",
                input.trim() ? "bg-accent text-white hover:bg-accent/90" : "text-text-muted cursor-not-allowed"
              )}
            >
              <Send size={13} />
            </button>
          )}
        </div>
        <p className="text-[10px] text-text-muted mt-1.5 text-center">
          {disclaimer} · <span>{t.aiShiftEnter}</span>
        </p>
      </div>
    </div>
  );
}
