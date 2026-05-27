export interface AppSettings {
  theme: "dark" | "light";
  accentColor: string;
  uiScale: 90 | 100 | 110;
  showHiddenDefault: boolean;
  dateFormat: "relative" | "absolute";
  defaultSort: "name" | "size" | "modified" | "type";
  defaultSortDir: "asc" | "desc";
  defaultLayout: "list" | "grid";
  editorLineNumbers: boolean;
  editorWordWrap: boolean;
  editorTabSize: 2 | 4 | 8;
  snapshotMode: "auto" | "manual";
  snapshotMaxCount: number;
  activityTracking: boolean;
  activityRetention: 7 | 30 | 90 | 0;
  language: "en" | "fr";
  telemetryEnabled: boolean;
  hasSeenOnboarding: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  accentColor: "#6366f1",
  uiScale: 100,
  showHiddenDefault: false,
  dateFormat: "relative",
  defaultSort: "name",
  defaultSortDir: "asc",
  defaultLayout: "list",
  editorLineNumbers: true,
  editorWordWrap: false,
  editorTabSize: 2,
  snapshotMode: "auto",
  snapshotMaxCount: 10,
  activityTracking: true,
  activityRetention: 30,
  language: "en",
  telemetryEnabled: false,
  hasSeenOnboarding: false,
};

export interface AccentPreset {
  label: string;
  color: string;
  dim: string;
  glow: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { label: "Indigo",  color: "#6366f1", dim: "#4f46e5", glow: "#818cf8" },
  { label: "Blue",    color: "#3b82f6", dim: "#2563eb", glow: "#60a5fa" },
  { label: "Emerald", color: "#10b981", dim: "#059669", glow: "#34d399" },
  { label: "Amber",   color: "#f59e0b", dim: "#d97706", glow: "#fbbf24" },
  { label: "Red",     color: "#ef4444", dim: "#dc2626", glow: "#f87171" },
  { label: "Pink",    color: "#ec4899", dim: "#db2777", glow: "#f472b6" },
  { label: "Violet",  color: "#8b5cf6", dim: "#7c3aed", glow: "#a78bfa" },
  { label: "Cyan",    color: "#06b6d4", dim: "#0891b2", glow: "#22d3ee" },
];

function hexToRgbSpace(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

export function applySettings(s: AppSettings) {
  const html = document.documentElement;

  // Theme
  html.classList.remove("light", "dark");
  html.classList.add(s.theme);

  // UI Scale — apply to root element via zoom
  const root = document.getElementById("root");
  if (root) root.style.zoom = `${s.uiScale}%`;

  // Accent color
  const preset = ACCENT_PRESETS.find((p) => p.color === s.accentColor) ?? ACCENT_PRESETS[0];
  html.style.setProperty("--color-accent",      preset.color);
  html.style.setProperty("--color-accent-rgb",  hexToRgbSpace(preset.color));
  html.style.setProperty("--color-accent-dim",  preset.dim);
  html.style.setProperty("--color-accent-glow", preset.glow);
}

/** Serialize settings to a flat key→value map for DB storage. */
export function serializeSettings(s: AppSettings): Record<string, string> {
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => [k, String(v)])
  );
}

/** Deserialize flat DB map back to AppSettings, falling back to defaults for missing keys. */
export function deserializeSettings(raw: Record<string, string>): AppSettings {
  const d = DEFAULT_SETTINGS;
  return {
    theme:             (raw.theme as AppSettings["theme"])               ?? d.theme,
    accentColor:       raw.accentColor                                   ?? d.accentColor,
    uiScale:           (Number(raw.uiScale)  as AppSettings["uiScale"]) ?? d.uiScale,
    showHiddenDefault: raw.showHiddenDefault !== undefined ? raw.showHiddenDefault === "true" : d.showHiddenDefault,
    dateFormat:        (raw.dateFormat as AppSettings["dateFormat"])     ?? d.dateFormat,
    defaultSort:       (raw.defaultSort as AppSettings["defaultSort"])   ?? d.defaultSort,
    defaultSortDir:    (raw.defaultSortDir as AppSettings["defaultSortDir"]) ?? d.defaultSortDir,
    defaultLayout:     (raw.defaultLayout as AppSettings["defaultLayout"]) ?? d.defaultLayout,
    editorLineNumbers: raw.editorLineNumbers !== undefined ? raw.editorLineNumbers === "true" : d.editorLineNumbers,
    editorWordWrap:    raw.editorWordWrap    !== undefined ? raw.editorWordWrap    === "true" : d.editorWordWrap,
    editorTabSize:     (Number(raw.editorTabSize) as AppSettings["editorTabSize"]) ?? d.editorTabSize,
    snapshotMode:      (raw.snapshotMode as AppSettings["snapshotMode"])           ?? d.snapshotMode,
    snapshotMaxCount:  raw.snapshotMaxCount !== undefined ? Math.max(2, Math.min(50, Number(raw.snapshotMaxCount))) : d.snapshotMaxCount,
    activityTracking:  raw.activityTracking  !== undefined ? raw.activityTracking  === "true" : d.activityTracking,
    activityRetention: (Number(raw.activityRetention) as AppSettings["activityRetention"]) ?? d.activityRetention,
    language:           (raw.language as AppSettings["language"])         ?? d.language,
    telemetryEnabled:   raw.telemetryEnabled   !== undefined ? raw.telemetryEnabled   === "true" : d.telemetryEnabled,
    hasSeenOnboarding:  raw.hasSeenOnboarding  !== undefined ? raw.hasSeenOnboarding  === "true" : d.hasSeenOnboarding,
  };
}
