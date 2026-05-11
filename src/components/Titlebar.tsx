import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useStore } from "../store/useStore";
import { saveAndClose } from "../utils/appClose";

export function Titlebar() {
  const { sharingMode, sharingWorkspaceName, sharingWorkspaceIcon, sharingClients } = useStore();

  return (
    <div
      className="flex items-center justify-between h-[38px] bg-surface-1 border-b border-border select-none shrink-0"
      style={{ borderBottom: "1px solid #1f1f1f" }}
    >
      <div className="flex flex-1 items-center gap-2 px-4 h-full" data-tauri-drag-region>
        <img src="/nxs-icon.svg" alt="nxs" className="h-[22px] w-[22px] rounded-[4px] shrink-0" />

        {/* Sharing indicator */}
        {sharingMode === "hosting" && sharingWorkspaceName && (
          <div className="flex items-center gap-1.5 ml-3 px-2 py-0.5 rounded bg-green-500/15 border border-green-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            <span className="text-[11px] text-green-400 font-medium">
              {sharingWorkspaceIcon} {sharingWorkspaceName}
              {sharingClients.length > 0 && ` · ${sharingClients.length}`}
            </span>
          </div>
        )}
        {sharingMode === "joined" && (
          <div className="flex items-center gap-1.5 ml-3 px-2 py-0.5 rounded bg-accent/15 border border-accent/30">
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            <span className="text-[11px] text-accent font-medium">Guest</span>
          </div>
        )}
      </div>

      <div className="flex items-center h-full">
        <button
          onClick={() => getCurrentWindow().minimize().catch(console.error)}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Minus size={12} />
        </button>
        <button
          onClick={() => getCurrentWindow().toggleMaximize().catch(console.error)}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => saveAndClose()}
          className="w-11 h-full flex items-center justify-center text-text-muted hover:text-white hover:bg-red-600 transition-colors"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
