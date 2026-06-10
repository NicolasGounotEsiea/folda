import { X } from "lucide-react";
import { useEffect } from "react";
import { useStore } from "../store/useStore";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center px-1.5 py-0.5 rounded bg-surface-3 border border-border text-[10px] font-mono text-text-secondary whitespace-nowrap">
      {children}
    </kbd>
  );
}

function Row({ keys, label }: { keys: React.ReactNode[]; label: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border-subtle last:border-0">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1">{title}</p>
      <div className="mb-4">{children}</div>
    </div>
  );
}

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const { settings } = useStore();
  const lang = settings.language;

  const T = {
    en: {
      title: "Keyboard shortcuts",
      navigation: "Navigation",
      selection: "Selection",
      files: "Files",
      editor: "Editor",
      app: "App",
      nav_up_down: "Move selection up / down",
      nav_enter: "Open file or folder",
      nav_backspace: "Go up one level",
      nav_back_fwd: "Back / Forward",
      nav_search: "Focus search",
      nav_clear: "Clear search / Deselect",
      nav_palette: "Command palette",
      sel_all: "Select all",
      sel_range: "Range select",
      sel_add: "Add to selection",
      file_rename: "Rename",
      file_trash: "Move to trash",
      file_delete: "Delete permanently",
      file_copy: "Copy",
      file_cut: "Cut",
      file_paste: "Paste",
      ed_save: "Save",
      ed_undo: "Undo",
      ed_redo: "Redo",
      app_shortcuts: "Show shortcuts",
      app_settings: "Not bound — use toolbar",
    },
    fr: {
      title: "Raccourcis clavier",
      navigation: "Navigation",
      selection: "Sélection",
      files: "Fichiers",
      editor: "Éditeur",
      app: "Application",
      nav_up_down: "Monter / descendre dans la liste",
      nav_enter: "Ouvrir fichier ou dossier",
      nav_backspace: "Remonter d'un niveau",
      nav_back_fwd: "Précédent / Suivant",
      nav_search: "Rechercher",
      nav_clear: "Effacer / Désélectionner",
      nav_palette: "Palette de commandes",
      sel_all: "Tout sélectionner",
      sel_range: "Sélection étendue",
      sel_add: "Ajouter à la sélection",
      file_rename: "Renommer",
      file_trash: "Mettre à la corbeille",
      file_delete: "Supprimer définitivement",
      file_copy: "Copier",
      file_cut: "Couper",
      file_paste: "Coller",
      ed_save: "Enregistrer",
      ed_undo: "Annuler",
      ed_redo: "Rétablir",
      app_shortcuts: "Afficher les raccourcis",
      app_settings: "Non assigné — utiliser la barre d'outils",
    },
  } as const;

  const t = T[lang] ?? T.en;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop-in fixed inset-0 z-[500] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle shrink-0">
          <span className="text-[13px] font-semibold text-text-primary">{t.title}</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 flex flex-col gap-0">
          <div className="grid grid-cols-2 gap-x-8">
            <div>
              <Section title={t.navigation}>
                <Row keys={["↑", "↓"]}   label={t.nav_up_down} />
                <Row keys={["Enter"]}     label={t.nav_enter} />
                <Row keys={["Backspace"]} label={t.nav_backspace} />
                <Row keys={["Alt+←", "Alt+→"]} label={t.nav_back_fwd} />
                <Row keys={["Ctrl+F"]}   label={t.nav_search} />
                <Row keys={["Esc"]}      label={t.nav_clear} />
                <Row keys={["Ctrl+K"]}   label={t.nav_palette} />
              </Section>

              <Section title={t.selection}>
                <Row keys={["Ctrl+A"]}        label={t.sel_all} />
                <Row keys={["Shift+Click"]}   label={t.sel_range} />
                <Row keys={["Ctrl+Click"]}    label={t.sel_add} />
              </Section>
            </div>

            <div>
              <Section title={t.files}>
                <Row keys={["F2"]}         label={t.file_rename} />
                <Row keys={["Del"]}        label={t.file_trash} />
                <Row keys={["Shift+Del"]}  label={t.file_delete} />
                <Row keys={["Ctrl+C"]}     label={t.file_copy} />
                <Row keys={["Ctrl+X"]}     label={t.file_cut} />
                <Row keys={["Ctrl+V"]}     label={t.file_paste} />
              </Section>

              <Section title={t.editor}>
                <Row keys={["Ctrl+S"]} label={t.ed_save} />
                <Row keys={["Ctrl+Z"]} label={t.ed_undo} />
                <Row keys={["Ctrl+Y"]} label={t.ed_redo} />
              </Section>

              <Section title={t.app}>
                <Row keys={["?"]} label={t.app_shortcuts} />
              </Section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
