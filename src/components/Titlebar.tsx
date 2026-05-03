import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

const appWindow = getCurrentWindow();

export function Titlebar() {
  return (
    <div
      className="drag-region flex items-center justify-between h-[38px] bg-surface-1 border-b border-border select-none shrink-0"
      style={{ borderBottom: "1px solid #1f1f1f" }}
    >
      <div className="flex items-center gap-2 px-4">
        <div className="w-3 h-3 rounded-sm bg-accent opacity-80" />
        <span className="text-[12px] text-text-secondary font-medium tracking-wide">
          Contextual Workspace
        </span>
      </div>

      <div className="no-drag flex items-center h-full">
        <button
          onClick={() => appWindow.minimize()}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Minus size={12} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => appWindow.close()}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-white hover:bg-red-600 transition-colors"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
