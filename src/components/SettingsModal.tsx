import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { clsx } from "clsx";
import { Activity, BookOpen, Bot, CheckCircle2, ChevronDown, Eye, FileText, FolderOpen, Info, LayoutList, Loader2, Palette, RefreshCw, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clearLog, getLogPath } from "../utils/errorLog";
import { useStore } from "../store/useStore";
import { ACCENT_PRESETS, serializeSettings, type AppSettings } from "../utils/settings";
import { useTranslation } from "../utils/i18n";

// ── i18n strings ─────────────────────────────────────────────────────────────
const T = {
  en: {
    settings: "Settings", saved: "Saved",
    sections: { appearance: "Appearance", explorer: "Explorer", editor: "Editor", activity: "Activity", ai: "AI Assistant", about: "About" },
    ai: {
      desc: "Enable a Claude-powered assistant that can browse your files, search, read content, and help you stay organized. Your file paths are sent to Anthropic when you use the assistant.",
      enable: "Enable AI Assistant",
      provider: "Provider",
      providerOllamaSub: "Free · Local · No data sent",
      providerAnthropicSub: "Paid API · Best quality",
      apiKey: "API Key",
      apiKeyHint: "Get your key at console.anthropic.com · Stored locally, never synced",
      model: "Model",
      modelHint: "Haiku is fast and cheap · Sonnet is balanced · Opus is most capable",
      ollamaUrl: "Ollama URL (advanced)",
    },
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
      telemetry: "Anonymous telemetry & crash reports",
      telemetryDesc: "Help improve nxs by sharing anonymous usage data and crash reports.",
      guide: "View onboarding guide",
      logFile: "Error log",
      logFileDesc: "Crashes and errors are saved locally in a plain text file.",
      openLog: "Open log file",
      clearLog: "Clear",
      logCleared: "Log cleared",
    },
  },
  fr: {
    settings: "Paramètres", saved: "Enregistré",
    sections: { appearance: "Apparence", explorer: "Explorateur", editor: "Éditeur", activity: "Activité", ai: "Assistant IA", about: "À propos" },
    ai: {
      desc: "Activez un assistant alimenté par Claude qui peut parcourir vos fichiers, rechercher, lire du contenu et vous aider à vous organiser. Vos chemins de fichiers sont envoyés à Anthropic lors de l'utilisation de l'assistant.",
      enable: "Activer l'assistant IA",
      provider: "Fournisseur",
      providerOllamaSub: "Gratuit · Local · Aucune donnée envoyée",
      providerAnthropicSub: "API payante · Meilleure qualité",
      apiKey: "Clé API",
      apiKeyHint: "Obtenez votre clé sur console.anthropic.com · Stockée localement, jamais synchronisée",
      model: "Modèle",
      modelHint: "Haiku est rapide et économique · Sonnet est équilibré · Opus est le plus puissant",
      ollamaUrl: "URL d'Ollama (avancé)",
    },
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
      telemetry: "Télémétrie anonyme & rapports de plantage",
      telemetryDesc: "Aidez à améliorer nxs en partageant des données d'utilisation anonymes.",
      guide: "Voir le guide de démarrage",
      logFile: "Journal d'erreurs",
      logFileDesc: "Les plantages et erreurs sont enregistrés localement dans un fichier texte.",
      openLog: "Ouvrir le fichier journal",
      clearLog: "Effacer",
      logCleared: "Journal effacé",
    },
  },
} as const;

type Lang = keyof typeof T;
type Section = "appearance" | "explorer" | "editor" | "activity" | "ai" | "about";

const SECTIONS: { id: Section; icon: React.ReactNode }[] = [
  { id: "appearance", icon: <Palette size={14} /> },
  { id: "explorer",   icon: <LayoutList size={14} /> },
  { id: "editor",     icon: <FileText size={14} /> },
  { id: "activity",   icon: <Activity size={14} /> },
  { id: "ai",         icon: <Bot size={14} /> },
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

// ── Ollama manager sub-component ──────────────────────────────────────────────

type OllamaStatus = "checking" | "running" | "offline";

interface PullProgress { status: string; percent: number | null }

const SUGGESTED_MODELS = [
  { name: "llama3.2:3b",   label: "Llama 3.2 3B",  size: "~2 GB",  tools: true  },
  { name: "llama3.2:1b",   label: "Llama 3.2 1B",  size: "~1 GB",  tools: true  },
  { name: "phi3:mini",     label: "Phi-3 Mini",    size: "~2.3 GB", tools: true  },
  { name: "mistral:7b",    label: "Mistral 7B",    size: "~4.5 GB", tools: true  },
  { name: "gemma2:2b",     label: "Gemma 2 2B",    size: "~1.6 GB", tools: false },
];

function OllamaManager({
  ollamaUrl, currentModel, t, onModelSelect,
}: {
  ollamaUrl: string;
  currentModel: string;
  t: ReturnType<typeof import("../utils/i18n").useTranslation>;
  onModelSelect: (m: string) => void;
}) {
  const [status, setStatus] = useState<OllamaStatus>("checking");
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [pullDone, setPullDone] = useState<string | null>(null);
  const abortRef = useRef(false);

  const check = async () => {
    setStatus("checking");
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error();
      const data = await res.json() as { models: { name: string }[] };
      setInstalledModels(data.models.map((m) => m.name));
      setStatus("running");
    } catch {
      setStatus("offline");
      setInstalledModels([]);
    }
  };

  useEffect(() => { check(); }, [ollamaUrl]);

  const pull = async (name: string) => {
    if (pulling) return;
    abortRef.current = false;
    setPulling(name);
    setPullProgress({ status: "Connecting…", percent: null });
    setPullDone(null);
    try {
      const res = await fetch(`${ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stream: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done || abortRef.current) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as { status: string; completed?: number; total?: number };
            const percent = obj.total && obj.completed ? Math.round((obj.completed / obj.total) * 100) : null;
            setPullProgress({ status: obj.status, percent });
          } catch { /* ignore bad line */ }
        }
      }
      setPullDone(name);
      await check();
      onModelSelect(name);
    } catch (e) {
      setPullProgress({ status: `Error: ${e}`, percent: null });
    } finally {
      setPulling(null);
    }
  };

  const statusDot = {
    checking: <Loader2 size={11} className="animate-spin text-text-muted" />,
    running:  <CheckCircle2 size={11} className="text-emerald-400" />,
    offline:  <XCircle size={11} className="text-red-400" />,
  }[status];

  const statusLabel = {
    checking: t.ollamaChecking,
    running:  t.ollamaRunning,
    offline:  t.ollamaOffline,
  }[status];

  return (
    <div className="flex flex-col gap-3">
      {/* Status */}
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center gap-1.5">
          {statusDot}
          <span className="text-[12px] text-text-primary">{statusLabel}</span>
        </div>
        <button
          onClick={check}
          className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
        >
          <RefreshCw size={11} /> {t.ollamaRefresh}
        </button>
      </div>

      {status === "offline" && (
        <div className="p-3 rounded-lg bg-surface-2 border border-border-subtle flex flex-col gap-2">
          <p className="text-[11px] text-text-muted">{t.ollamaInstallDesc}</p>
          <button
            onClick={() => shellOpen("https://ollama.com/download").catch(() => {})}
            className="self-start flex items-center gap-1.5 h-7 px-3 rounded bg-accent text-white text-[11px] hover:bg-accent/90 transition-colors"
          >
            {t.ollamaDownload}
          </button>
        </div>
      )}

      {status === "running" && (
        <>
          {/* Installed models */}
          <div>
            <p className="text-[11px] text-text-muted uppercase tracking-widest font-semibold mb-1.5">{t.ollamaInstalledModels}</p>
            {installedModels.length === 0 ? (
              <p className="text-[11px] text-text-muted italic">{t.ollamaNoModels}</p>
            ) : (
              <div className="flex flex-col gap-1">
                {installedModels.map((m) => (
                  <button
                    key={m}
                    onClick={() => onModelSelect(m)}
                    className={clsx(
                      "flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] border transition-colors",
                      currentModel === m
                        ? "bg-accent/10 border-accent/30 text-accent"
                        : "bg-surface-3 border-border text-text-secondary hover:text-text-primary hover:bg-surface-4"
                    )}
                  >
                    <span className="font-mono">{m}</span>
                    {currentModel === m && <span className="text-[10px] opacity-70">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Download a model */}
          <div className="border-t border-border-subtle pt-3">
            <p className="text-[11px] text-text-muted uppercase tracking-widest font-semibold mb-2">{t.ollamaDownloadModel}</p>

            {/* Suggested */}
            <div className="flex flex-col gap-1 mb-2">
              {SUGGESTED_MODELS.filter((m) => !installedModels.includes(m.name)).map((m) => (
                <div key={m.name} className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-surface-3 border border-border">
                  <div className="flex flex-col">
                    <span className="text-[11px] text-text-primary font-mono">{m.name}</span>
                    <span className="text-[10px] text-text-muted">{m.label} · {m.size}{!m.tools ? " · ⚠️ no tools" : ""}</span>
                  </div>
                  <button
                    onClick={() => pull(m.name)}
                    disabled={!!pulling}
                    className="text-[10px] px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
                  >
                    {pulling === m.name ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
                  </button>
                </div>
              ))}
            </div>

            {/* Custom */}
            <div className="flex gap-1.5 items-center">
              <input
                type="text"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                placeholder={t.ollamaModelPlaceholder}
                className="flex-1 h-7 px-2.5 rounded bg-surface-3 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors font-mono"
                onKeyDown={(e) => { if (e.key === "Enter" && pullName.trim()) pull(pullName.trim()); }}
              />
              <button
                onClick={() => pullName.trim() && pull(pullName.trim())}
                disabled={!pullName.trim() || !!pulling}
                className="h-7 px-3 rounded bg-surface-3 border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-4 disabled:opacity-40 transition-colors"
              >
                {pulling ? t.ollamaPulling : t.ollamaPull}
              </button>
            </div>

            {/* Pull progress */}
            {pulling && pullProgress && (
              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted truncate">{pullProgress.status}</span>
                  {pullProgress.percent !== null && (
                    <span className="text-[10px] text-accent ml-2 shrink-0">{pullProgress.percent}%</span>
                  )}
                </div>
                {pullProgress.percent !== null && (
                  <div className="h-1 rounded bg-surface-4 overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all duration-300"
                      style={{ width: `${pullProgress.percent}%` }}
                    />
                  </div>
                )}
                <button
                  onClick={() => { abortRef.current = true; setPulling(null); setPullProgress(null); }}
                  className="self-start text-[10px] text-red-400 hover:text-red-300"
                >
                  Cancel
                </button>
              </div>
            )}

            {pullDone && (
              <p className="text-[11px] text-emerald-400 mt-1.5">✓ {t.ollamaModelDone}: {pullDone}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function SettingsModal({ onClose, onShowGuide }: { onClose: () => void; onShowGuide?: () => void }) {
  const { settings, updateSettings, setShowHidden } = useStore();
  const [section, setSection] = useState<Section>("appearance");
  const [saveFlash, setSaveFlash] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const [logClearedMsg, setLogClearedMsg] = useState(false);
  const [shellRegistered, setShellRegistered] = useState<boolean | null>(null);
  const [shellMsg, setShellMsg] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("is_shell_extension_registered").then(setShellRegistered).catch(() => setShellRegistered(false));
  }, []);

  const lang = settings.language as Lang;
  const t = T[lang] ?? T.en;
  const ti = useTranslation(); // for OllamaManager (uses i18n.ts keys)

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

                {/* Windows shell integration */}
                <div className="mt-4 pt-4 border-t border-border-subtle">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] text-text-primary">"Open with nxs" in Explorer</span>
                      <span className="text-[11px] text-text-muted">
                        Adds nxs to the Windows right-click menu for files and folders
                      </span>
                      {shellMsg && <span className="text-[11px] text-accent mt-0.5">{shellMsg}</span>}
                    </div>
                    <Toggle
                      checked={shellRegistered === true}
                      onChange={async (v) => {
                        try {
                          if (v) {
                            await invoke("register_shell_extension");
                            setShellRegistered(true);
                            setShellMsg("Registered ✓");
                          } else {
                            await invoke("unregister_shell_extension");
                            setShellRegistered(false);
                            setShellMsg("Removed");
                          }
                          setTimeout(() => setShellMsg(null), 3000);
                        } catch (e) {
                          setShellMsg(`Error: ${e}`);
                        }
                      }}
                    />
                  </div>
                </div>
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

                <Row label="Content indexing">
                  <Toggle
                    checked={settings.contentIndexing}
                    onChange={(v) => patch({ contentIndexing: v })}
                  />
                </Row>
                <p className="text-[11px] text-text-muted -mt-1 mb-2">
                  When enabled, the content of PDFs, Word docs, and spreadsheets is extracted in the background after adding a folder to a workspace. This makes search work on file contents, not just file names. New and modified files are always indexed regardless of this setting.
                </p>

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

            {/* ── AI Assistant ── */}
            {section === "ai" && (
              <div className="flex flex-col gap-3">
                {/* Enable toggle */}
                <Row label={t.ai.enable}>
                  <Toggle checked={settings.claudeEnabled} onChange={(v) => patch({ claudeEnabled: v })} />
                </Row>

                {settings.claudeEnabled && (
                  <>
                    {/* Provider selector */}
                    <div className="py-2 border-t border-border-subtle">
                      <p className="text-[11px] text-text-muted uppercase tracking-widest font-semibold mb-2">{t.ai.provider}</p>
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { id: "ollama",    label: "Ollama",         sub: t.ai.providerOllamaSub },
                          { id: "anthropic", label: "Anthropic API",  sub: t.ai.providerAnthropicSub },
                        ] as const).map((p) => (
                          <button
                            key={p.id}
                            onClick={() => patch({ aiProvider: p.id })}
                            className={clsx(
                              "flex flex-col items-start px-3 py-2 rounded-lg border text-left transition-colors",
                              settings.aiProvider === p.id
                                ? "bg-accent/10 border-accent/40 text-accent"
                                : "bg-surface-3 border-border text-text-secondary hover:bg-surface-4"
                            )}
                          >
                            <span className="text-[12px] font-medium">{p.label}</span>
                            <span className="text-[10px] opacity-70 mt-0.5">{p.sub}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Ollama section */}
                    {settings.aiProvider === "ollama" && (
                      <div className="border-t border-border-subtle pt-3">
                        <OllamaManager
                          ollamaUrl={settings.ollamaUrl}
                          currentModel={settings.ollamaModel}
                          t={ti}
                          onModelSelect={(m) => patch({ ollamaModel: m })}
                        />
                        {/* URL customisation */}
                        <div className="mt-3 pt-3 border-t border-border-subtle">
                          <p className="text-[11px] text-text-muted mb-1">{t.ai.ollamaUrl}</p>
                          <input
                            type="text"
                            value={settings.ollamaUrl}
                            onChange={(e) => patch({ ollamaUrl: e.target.value })}
                            placeholder="http://localhost:11434"
                            className="w-full h-7 px-2.5 rounded bg-surface-3 border border-border text-[11px] text-text-primary outline-none focus:border-accent transition-colors font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {/* Anthropic section */}
                    {settings.aiProvider === "anthropic" && (
                      <div className="border-t border-border-subtle pt-3 flex flex-col gap-1">
                        <div className="py-1">
                          <p className="text-[12px] text-text-primary mb-1.5">{t.ai.apiKey}</p>
                          <input
                            type="password"
                            value={settings.claudeApiKey}
                            onChange={(e) => patch({ claudeApiKey: e.target.value })}
                            placeholder="sk-ant-…"
                            className="w-full h-7 px-2.5 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors font-mono"
                            spellCheck={false}
                          />
                          <p className="text-[10px] text-text-muted mt-1">{t.ai.apiKeyHint}</p>
                        </div>
                        <Row label={t.ai.model}>
                          <SegmentedControl
                            value={settings.claudeModel}
                            options={[
                              { value: "claude-haiku-4-5-20251001" as const, label: "Haiku" },
                              { value: "claude-sonnet-4-6" as const,         label: "Sonnet" },
                              { value: "claude-opus-4-7" as const,           label: "Opus" },
                            ]}
                            onChange={(v) => patch({ claudeModel: v })}
                          />
                        </Row>
                        <p className="text-[10px] text-text-muted">{t.ai.modelHint}</p>
                      </div>
                    )}
                  </>
                )}
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
                    <p className="text-[13px] font-semibold text-text-primary">nxs</p>
                    <p className="text-[11px] text-text-muted">{t.about.builtWith}</p>
                  </div>
                  <div className="ml-auto">
                    <span className="text-[11px] text-text-muted bg-surface-3 px-2 py-1 rounded">
                      {t.about.version} 0.1.2
                    </span>
                  </div>
                </div>

                <Row label={t.about.telemetry}>
                  <Toggle
                    checked={settings.telemetryEnabled}
                    onChange={(v) => patch({ telemetryEnabled: v })}
                  />
                </Row>
                <p className="text-[11px] text-text-muted -mt-1 mb-2">{t.about.telemetryDesc}</p>

                {onShowGuide && (
                  <button
                    onClick={onShowGuide}
                    className="flex items-center gap-2 h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors self-start mb-2"
                  >
                    <BookOpen size={13} /> {t.about.guide}
                  </button>
                )}

                <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-2 border border-border-subtle mb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[12px] text-text-primary font-medium">{t.about.logFile}</p>
                      <p className="text-[11px] text-text-muted mt-0.5">{t.about.logFileDesc}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        const path = await getLogPath().catch(() => null);
                        if (path) invoke("reveal_in_explorer", { path }).catch(() => {});
                      }}
                      className="flex items-center gap-1.5 h-7 px-3 rounded bg-surface-3 border border-border text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors"
                    >
                      <FolderOpen size={11} /> {t.about.openLog}
                    </button>
                    <button
                      onClick={async () => {
                        await clearLog().catch(() => {});
                        setLogClearedMsg(true);
                        setTimeout(() => setLogClearedMsg(false), 2000);
                      }}
                      className="flex items-center gap-1.5 h-7 px-3 rounded bg-surface-3 border border-border text-[11px] text-text-secondary hover:text-red-400 hover:border-red-500/30 transition-colors"
                    >
                      <Trash2 size={11} /> {t.about.clearLog}
                    </button>
                    {logClearedMsg && (
                      <span className="text-[11px] text-emerald-400">{t.about.logCleared} ✓</span>
                    )}
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
