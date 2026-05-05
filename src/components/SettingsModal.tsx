import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Activity, Eye, FileText, Info, LayoutList, Palette, X } from "lucide-react";
import { useState } from "react";
import { useStore } from "../store/useStore";
import { ACCENT_PRESETS, serializeSettings, type AppSettings } from "../utils/settings";

// ── i18n strings ─────────────────────────────────────────────────────────────
const T = {
  en: {
    settings: "Settings", saved: "Saved",
    sections: { appearance: "Appearance", explorer: "Explorer", editor: "Editor", activity: "Activity", about: "About" },
    appearance: {
      theme: "Theme", dark: "Dark", light: "Light",
      accent: "Accent color",
      scale: "Interface scale", scale90: "Compact (90%)", scale100: "Normal (100%)", scale110: "Large (110%)",
      language: "Language",
    },
    explorer: {
      hidden: "Show hidden files by default",
      dateFormat: "Date format", relative: "Relative (3 days ago)", absolute: "Absolute (2026-05-04)",
      defaultSort: "Default sort", name: "Name", size: "Size", modified: "Modified", type: "Type",
      sortDir: "Sort direction", asc: "Ascending", desc: "Descending",
      defaultLayout: "Default layout", list: "List", grid: "Grid",
    },
    editor: {
      lineNumbers: "Show line numbers",
      wordWrap: "Word wrap",
      tabSize: "Tab size",
      snapshotMode: "Snapshot mode",
      snapshotAuto: "Auto (on save)",
      snapshotManual: "Manual",
      snapshotMax: "Max snapshots per file",
    },
    activity: {
      tracking: "Enable activity tracking",
      retention: "Auto-delete activity older than",
      days7: "7 days", days30: "30 days", days90: "90 days", forever: "Never",
      purge: "Delete all activity now",
      purged: (n: number) => `${n} record${n !== 1 ? "s" : ""} deleted`,
    },
    about: {
      version: "Version", builtWith: "Built with Tauri 2 + React + Rust",
      changelog: "View changelog",
    },
  },
  fr: {
    settings: "Paramètres", saved: "Enregistré",
    sections: { appearance: "Apparence", explorer: "Explorateur", editor: "Éditeur", activity: "Activité", about: "À propos" },
    appearance: {
      theme: "Thème", dark: "Sombre", light: "Clair",
      accent: "Couleur d'accent",
      scale: "Taille de l'interface", scale90: "Compact (90%)", scale100: "Normal (100%)", scale110: "Grand (110%)",
      language: "Langue",
    },
    explorer: {
      hidden: "Afficher les fichiers cachés par défaut",
      dateFormat: "Format de date", relative: "Relatif (il y a 3 jours)", absolute: "Absolu (04/05/2026)",
      defaultSort: "Tri par défaut", name: "Nom", size: "Taille", modified: "Modifié", type: "Type",
      sortDir: "Sens de tri", asc: "Croissant", desc: "Décroissant",
      defaultLayout: "Vue par défaut", list: "Liste", grid: "Grille",
    },
    editor: {
      lineNumbers: "Numéros de ligne",
      wordWrap: "Retour à la ligne automatique",
      tabSize: "Taille de tabulation",
      snapshotMode: "Mode snapshot",
      snapshotAuto: "Auto (à la sauvegarde)",
      snapshotManual: "Manuel",
      snapshotMax: "Snapshots max par fichier",
    },
    activity: {
      tracking: "Activer le suivi d'activité",
      retention: "Supprimer l'activité plus vieille que",
      days7: "7 jours", days30: "30 jours", days90: "90 jours", forever: "Jamais",
      purge: "Supprimer toute l'activité",
      purged: (n: number) => `${n} entrée${n !== 1 ? "s" : ""} supprimée${n !== 1 ? "s" : ""}`,
    },
    about: {
      version: "Version", builtWith: "Construit avec Tauri 2 + React + Rust",
      changelog: "Voir le changelog",
    },
  },
} as const;

type Lang = keyof typeof T;
type Section = "appearance" | "explorer" | "editor" | "activity" | "about";

const SECTIONS: { id: Section; icon: React.ReactNode }[] = [
  { id: "appearance", icon: <Palette size={14} /> },
  { id: "explorer",   icon: <LayoutList size={14} /> },
  { id: "editor",     icon: <FileText size={14} /> },
  { id: "activity",   icon: <Activity size={14} /> },
  { id: "about",      icon: <Info size={14} /> },
];

// ── Small reusable sub-components ─────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-[12px] text-text-primary">{label}</span>
      <div className="flex items-center gap-1.5 shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        "w-9 h-5 rounded-full relative transition-colors shrink-0 cursor-pointer",
        checked ? "bg-accent" : "bg-surface-4"
      )}
    >
      <span
        className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
      />
    </div>
  );
}

function SegmentedControl<T extends string | number>({
  value, options, onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center rounded-md overflow-hidden border border-border bg-surface-3 h-7">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={clsx(
            "px-3 h-full text-[11px] transition-colors",
            value === opt.value
              ? "bg-accent text-white"
              : "text-text-muted hover:text-text-secondary"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings, setShowHidden } = useStore();
  const [section, setSection] = useState<Section>("appearance");
  const [saveFlash, setSaveFlash] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);

  const lang = settings.language as Lang;
  const t = T[lang] ?? T.en;

  const patch = async (p: Partial<AppSettings>) => {
    updateSettings(p);
    const next = { ...settings, ...p };
    const flat = serializeSettings(next);
    await Promise.all(
      Object.entries(flat).map(([key, value]) =>
        invoke("set_setting", { key, value }).catch(console.error)
      )
    );
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1200);
  };

  const handlePurge = async () => {
    try {
      const deleted = await invoke<number>("purge_old_activity", { retentionDays: 0 });
      setPurgeMsg(t.activity.purged(deleted));
      setTimeout(() => setPurgeMsg(null), 3000);
    } catch (e) { console.error(e); }
  };

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60">
      <div className="bg-surface-1 border border-border rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex overflow-hidden">

        {/* Sidebar */}
        <div className="w-[160px] bg-surface-2 border-r border-border-subtle flex flex-col shrink-0 py-2">
          <div className="px-4 py-2 mb-1">
            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-widest">
              {t.settings}
            </span>
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={clsx(
                "flex items-center gap-2.5 px-4 h-8 text-[12px] transition-colors text-left",
                section === s.id
                  ? "bg-accent/10 text-accent border-r-2 border-accent"
                  : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              )}
            >
              {s.icon}
              {t.sections[s.id]}
            </button>
          ))}
          <div className="flex-1" />
          {saveFlash && (
            <div className="mx-3 mb-2 px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 text-[10px] text-center">
              {t.saved} ✓
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle shrink-0">
            <span className="text-[13px] font-semibold text-text-primary">
              {t.sections[section]}
            </span>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {/* Section content */}
          <div className="flex-1 overflow-y-auto px-6 py-2">

            {/* ── Appearance ── */}
            {section === "appearance" && (
              <div>
                <Row label={t.appearance.theme}>
                  <SegmentedControl
                    value={settings.theme}
                    options={[
                      { value: "dark",  label: t.appearance.dark  },
                      { value: "light", label: t.appearance.light },
                    ]}
                    onChange={(v) => patch({ theme: v })}
                  />
                </Row>

                <Row label={t.appearance.accent}>
                  <div className="flex items-center gap-1.5">
                    {ACCENT_PRESETS.map((p) => (
                      <button
                        key={p.color}
                        onClick={() => patch({ accentColor: p.color })}
                        title={p.label}
                        className={clsx(
                          "w-5 h-5 rounded-full transition-transform hover:scale-110",
                          settings.accentColor === p.color && "ring-2 ring-offset-2 ring-offset-surface-1 ring-white/60 scale-110"
                        )}
                        style={{ background: p.color }}
                      />
                    ))}
                  </div>
                </Row>

                <Row label={t.appearance.scale}>
                  <SegmentedControl
                    value={settings.uiScale}
                    options={[
                      { value: 90  as const, label: "90%" },
                      { value: 100 as const, label: "100%" },
                      { value: 110 as const, label: "110%" },
                    ]}
                    onChange={(v) => patch({ uiScale: v })}
                  />
                </Row>

                <Row label={t.appearance.language}>
                  <SegmentedControl
                    value={settings.language}
                    options={[
                      { value: "en", label: "English" },
                      { value: "fr", label: "Français" },
                    ]}
                    onChange={(v) => patch({ language: v })}
                  />
                </Row>
              </div>
            )}

            {/* ── Explorer ── */}
            {section === "explorer" && (
              <div>
                <Row label={t.explorer.hidden}>
                  <Toggle
                    checked={settings.showHiddenDefault}
                    onChange={(v) => { patch({ showHiddenDefault: v }); setShowHidden(v); }}
                  />
                </Row>

                <Row label={t.explorer.dateFormat}>
                  <SegmentedControl
                    value={settings.dateFormat}
                    options={[
                      { value: "relative", label: t.explorer.relative.split(" (")[0] },
                      { value: "absolute", label: t.explorer.absolute.split(" (")[0] },
                    ]}
                    onChange={(v) => patch({ dateFormat: v })}
                  />
                </Row>

                <Row label={t.explorer.defaultSort}>
                  <SegmentedControl
                    value={settings.defaultSort}
                    options={[
                      { value: "name",     label: t.explorer.name     },
                      { value: "modified", label: t.explorer.modified },
                      { value: "size",     label: t.explorer.size     },
                      { value: "type",     label: t.explorer.type     },
                    ]}
                    onChange={(v) => patch({ defaultSort: v })}
                  />
                </Row>

                <Row label={t.explorer.sortDir}>
                  <SegmentedControl
                    value={settings.defaultSortDir}
                    options={[
                      { value: "asc",  label: t.explorer.asc  },
                      { value: "desc", label: t.explorer.desc },
                    ]}
                    onChange={(v) => patch({ defaultSortDir: v })}
                  />
                </Row>

                <Row label={t.explorer.defaultLayout}>
                  <SegmentedControl
                    value={settings.defaultLayout}
                    options={[
                      { value: "list", label: t.explorer.list },
                      { value: "grid", label: t.explorer.grid },
                    ]}
                    onChange={(v) => patch({ defaultLayout: v })}
                  />
                </Row>
              </div>
            )}

            {/* ── Editor ── */}
            {section === "editor" && (
              <div>
                <Row label={t.editor.lineNumbers}>
                  <Toggle
                    checked={settings.editorLineNumbers}
                    onChange={(v) => patch({ editorLineNumbers: v })}
                  />
                </Row>

                <Row label={t.editor.wordWrap}>
                  <Toggle
                    checked={settings.editorWordWrap}
                    onChange={(v) => patch({ editorWordWrap: v })}
                  />
                </Row>

                <Row label={t.editor.tabSize}>
                  <SegmentedControl
                    value={settings.editorTabSize}
                    options={[
                      { value: 2 as const, label: "2" },
                      { value: 4 as const, label: "4" },
                      { value: 8 as const, label: "8" },
                    ]}
                    onChange={(v) => patch({ editorTabSize: v })}
                  />
                </Row>

                <div className="pt-3 pb-1">
                  <p className="text-[10px] text-text-muted uppercase tracking-widest font-semibold mb-0.5">Snapshots</p>
                  <p className="text-[10px] text-text-muted">Lightweight file history — files &gt; 1 MB are skipped.</p>
                </div>

                <Row label={t.editor.snapshotMode}>
                  <SegmentedControl
                    value={settings.snapshotMode}
                    options={[
                      { value: "auto" as const,   label: t.editor.snapshotAuto   },
                      { value: "manual" as const, label: t.editor.snapshotManual },
                    ]}
                    onChange={(v) => patch({ snapshotMode: v })}
                  />
                </Row>

                <Row label={t.editor.snapshotMax}>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={2}
                      max={50}
                      step={1}
                      value={settings.snapshotMaxCount}
                      onChange={(e) => patch({ snapshotMaxCount: Number(e.target.value) })}
                      className="w-28 accent-[var(--color-accent)]"
                    />
                    <span className="text-[11px] text-text-primary w-6 text-right">{settings.snapshotMaxCount}</span>
                  </div>
                </Row>
              </div>
            )}

            {/* ── Activity ── */}
            {section === "activity" && (
              <div>
                <Row label={t.activity.tracking}>
                  <Toggle
                    checked={settings.activityTracking}
                    onChange={(v) => patch({ activityTracking: v })}
                  />
                </Row>

                <Row label={t.activity.retention}>
                  <SegmentedControl
                    value={settings.activityRetention}
                    options={[
                      { value: 7  as const, label: t.activity.days7   },
                      { value: 30 as const, label: t.activity.days30  },
                      { value: 90 as const, label: t.activity.days90  },
                      { value: 0  as const, label: t.activity.forever },
                    ]}
                    onChange={(v) => patch({ activityRetention: v })}
                  />
                </Row>

                <div className="pt-4 flex items-center justify-between">
                  <div>
                    <p className="text-[12px] text-text-primary">{t.activity.purge}</p>
                    {purgeMsg && (
                      <p className="text-[11px] text-emerald-400 mt-0.5">{purgeMsg}</p>
                    )}
                  </div>
                  <button
                    onClick={handlePurge}
                    className="h-7 px-3 rounded bg-surface-3 border border-border text-[11px] text-red-400 hover:bg-red-500/10 hover:border-red-500/30 transition-colors"
                  >
                    {t.activity.purge}
                  </button>
                </div>
              </div>
            )}

            {/* ── About ── */}
            {section === "about" && (
              <div className="flex flex-col gap-4 py-2">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-surface-2 border border-border-subtle">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                    <Eye size={20} />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-text-primary">Contextual Workspace</p>
                    <p className="text-[11px] text-text-muted">{t.about.builtWith}</p>
                  </div>
                  <div className="ml-auto">
                    <span className="text-[11px] text-text-muted bg-surface-3 px-2 py-1 rounded">
                      {t.about.version} 0.1.2
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[12px] text-text-muted">
                  <p>Tauri 2 · React 18 · TypeScript · Rust · SQLite</p>
                  <p className="mt-1">© 2026 — All rights reserved</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
