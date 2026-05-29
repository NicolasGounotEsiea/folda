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
  return res.json() as Promise<OllamaResp>;
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
];

// ── Tool executor ─────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type RefreshTagsFn = (path: string, fileId: number | null) => Promise<void>;

type PlanFn = (plan: { moves: PlanMove[]; summary: string }) => Promise<boolean>;

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
        return `Created file: ${path}`;
      }
      case "create_dir": {
        await invoke("create_directory", { path: input.path });
        const parent = String(input.path).replace(/[/\\][^/\\]+$/, "") || String(input.path);
        onRefreshDir?.(parent);
        return `Created directory: ${input.path}`;
      }
      case "rename_path": {
        await invoke("rename_path", { oldPath: input.old_path, newPath: input.new_path });
        const parent = String(input.old_path).replace(/[/\\][^/\\]+$/, "") || String(input.old_path);
        onRefreshDir?.(parent);
        return `Renamed: ${input.old_path} → ${input.new_path}`;
      }
      case "write_file": {
        await invoke("write_file", { path: input.path, content: input.content });
        return `File written: ${input.path}`;
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
}

function buildSystemPrompt(ctx: PromptCtx): string {
  const { currentPath, listEntries, tags, tagStats, rootPaths, contexts, activeContextId, selectedPaths, viewMode, memories } = ctx;

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

CRITICAL RULES:
- You have REAL tools. CALL THE TOOL — never describe what you would do or guess based on context.
- NEVER invent file names, paths, or content. You have no knowledge of files unless a tool tells you.
- NEVER claim success without having called the tool first.
- Report only what the tool returned. Do not embellish or invent.

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
- To tag files in a folder: call list_directory first, then add_tag_to_file once per file path.

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
- Save proactively: if the user tells you something about how they work, remember it without being asked.`;
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
): Promise<string> {
  let msgs: AnthropicMsg[] = [...history];

  while (true) {
    if (abortRef.current) return "";
    const resp = await callAnthropic(apiKey, model, system, msgs);

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
): Promise<string> {
  let msgs: OllamaMsg[] = [...history];

  while (true) {
    if (abortRef.current) return "";
    const resp = await callOllama(baseUrl, model, system, msgs);
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
    });

    try {
      let assistantText = "";

      if (settings.aiProvider === "anthropic") {
        const history = anthropicHistoryRef.current;
        history.push({ role: "user", content: text });
        assistantText = await runAnthropicLoop(
          settings.claudeApiKey, settings.claudeModel, system,
          history, tags, activeContextId ?? 0, onNavigate,
          (name) => setToolActivity(name), abortRef, requestConfirm, refreshTags, onRefreshDir, requestPlan,
        );
        history.push({ role: "assistant", content: assistantText });
      } else {
        const history = ollamaHistoryRef.current;
        history.push({ role: "user", content: text });
        assistantText = await runOllamaLoop(
          settings.ollamaUrl, settings.ollamaModel, system,
          history, tags, activeContextId ?? 0, onNavigate,
          (name) => setToolActivity(name), abortRef, requestConfirm, refreshTags, onRefreshDir, requestPlan,
        );
        history.push({ role: "assistant", content: assistantText });
      }

      setMessages((prev) => {
        const without = prev.filter((m) => m.text !== "_loading_");
        return [...without, { role: "assistant", text: assistantText }];
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages((prev) => prev.filter((m) => m.text !== "_loading_"));
    } finally {
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
    <div className="flex flex-col h-full bg-surface-1 border-l border-border-subtle w-[340px] shrink-0">
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
              onClick={() => { abortRef.current = true; setLoading(false); setToolActivity(null); }}
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
