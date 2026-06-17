import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { useTranslation } from "../utils/i18n";
import { saveAndClose } from "../utils/appClose";
import { NxsLogo } from "./NxsLogo";
import { QuickStartPopover } from "./QuickStartPopover";

export function Titlebar() {
  const { sharingMode, sharingWorkspaceName, sharingWorkspaceIcon, sharingClients } = useStore();
  const t = useTranslation();
  // Logo button → quick-start popover. State is local; we never need it
  // anywhere else and a store entry would just add re-render churn.
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const logoBtnRef = useRef<HTMLButtonElement>(null);

  const toggleQuickStart = () => {
    if (popoverOpen) { setPopoverOpen(false); return; }
    // Capture the logo button's rect at open time. The popover positions
    // itself absolutely from this rect — no need to track follow-along
    // window resizes for V1 (the popover closes on outside-click anyway, so
    // if the window does resize while it's open, user closes + re-opens).
    const rect = logoBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorRect(rect);
    setPopoverOpen(true);
  };

  return (
    <>
    <div
      className="flex items-center justify-between h-[38px] bg-surface-1 border-b border-border select-none shrink-0"
      style={{ borderBottom: "1px solid #1f1f1f" }}
    >
      <div className="flex flex-1 items-center gap-2 px-4 h-full" data-tauri-drag-region>
        {/* Inline accent-following logo (default variant) — picks up the
            user's accent CSS variables so it never clashes with the chosen
            theme. The OS-level taskbar icon stays brand-blue independently
            via the static public/nxs-icon.svg.

            Wrapped in a button: click opens the quick-start popover (recent
            paths + workspaces switcher). The `data-tauri-drag-region` parent
            would otherwise capture the click for window-drag — we add a
            sibling `data-tauri-drag-region="false"` attribute on the button
            to break out of the drag area for this specific surface. */}
        <button
          ref={logoBtnRef}
          onClick={toggleQuickStart}
          data-tauri-drag-region="false"
          className="flex items-center justify-center rounded hover:bg-surface-3 transition-colors p-0.5 shrink-0"
          title={t.quickStartTitle}
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
        >
          <NxsLogo size={22} />
        </button>

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
    {popoverOpen && anchorRect && (
      <QuickStartPopover
        anchorRect={anchorRect}
        anchorEl={logoBtnRef.current}
        onClose={() => setPopoverOpen(false)}
      />
    )}
    </>
  );
}
