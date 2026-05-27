import { invoke } from "@tauri-apps/api/core";

function fmt(level: string, message: string, detail?: string): string {
  const ts = new Date().toISOString();
  const header = `[${ts}] ${level.toUpperCase().padEnd(5)}  ${message}`;
  if (!detail) return header;
  const indented = detail.trim().split("\n").map((l) => `  ${l}`).join("\n");
  return `${header}\n${indented}`;
}

export function logError(message: string, stack?: string): void {
  invoke("write_log", { entry: fmt("error", message, stack) }).catch(() => {});
}

export function logWarn(message: string): void {
  invoke("write_log", { entry: fmt("warn", message) }).catch(() => {});
}

export function logInfo(message: string): void {
  invoke("write_log", { entry: fmt("info", message) }).catch(() => {});
}

export function getLogPath(): Promise<string> {
  return invoke<string>("get_log_path");
}

export function clearLog(): Promise<void> {
  return invoke("clear_log");
}
