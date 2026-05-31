import { create } from "zustand";

export type ToastType = "success" | "error" | "warning" | "info";

/// Optional CTA rendered on the toast as a small button. The toast is
/// auto-dismissed after `onClick` fires — callers don't need to dismiss
/// manually.
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  detail?: string;
  action?: ToastAction;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (t) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
