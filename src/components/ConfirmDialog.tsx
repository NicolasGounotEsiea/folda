import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "../utils/i18n";

interface Props {
  message: string;
  detail?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, detail, confirmLabel, onConfirm, onCancel }: Props) {
  const t = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const label = confirmLabel ?? t.delete;

  useEffect(() => {
    cancelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[9998] flex items-center justify-center bg-black/50">
      <div className="modal-content-in bg-surface-2 border border-border rounded-xl shadow-2xl p-5 w-[340px] flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
            <Trash2 size={16} className="text-red-400" />
          </div>
          <div>
            <p className="text-[13px] font-medium text-text-primary">{message}</p>
            {detail && <p className="text-[11px] text-text-muted mt-1">{detail}</p>}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
          >
            {t.cancel}
          </button>
          <button
            onClick={onConfirm}
            className="px-3 h-7 rounded text-[12px] bg-red-500/80 hover:bg-red-500 text-white transition-colors"
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
