import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw, XCircle } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store/useStore";
import { useToastStore } from "../store/useToastStore";

// Self-contained strings — the component is mounted in a single place
// (Settings → About) and doesn't need to participate in the global i18n
// table. Keeps the SettingsModal local T map free of updater clutter and
// avoids a refactor of the global `AppStrings` type for a tiny block of UI.
const STRINGS = {
  en: {
    check:       "Check for updates",
    checking:    "Checking…",
    upToDate:    "You're on the latest version",
    available:   "Update available",
    install:     "Install now",
    downloading: "Downloading",
    installed:   "Update installed — relaunching",
    retry:       "Try again",
    checkFailed: "Update check failed",
    installFailed: "Update install failed",
  },
  fr: {
    check:       "Vérifier les mises à jour",
    checking:    "Vérification…",
    upToDate:    "Tu es sur la dernière version",
    available:   "Mise à jour disponible",
    install:     "Installer maintenant",
    downloading: "Téléchargement",
    installed:   "Mise à jour installée — redémarrage",
    retry:       "Réessayer",
    checkFailed: "Échec de la vérification",
    installFailed: "Échec de l'installation",
  },
} as const;

/**
 * In-app update flow — wraps `@tauri-apps/plugin-updater`.
 *
 * Five user-visible states modelled as a discriminated union so the render
 * stays exhaustive and switching between them doesn't leak stale data:
 *
 *   - `idle`        — initial state. Render the "Check for updates" button.
 *   - `checking`    — the `check()` call is in flight.
 *   - `up-to-date`  — current build is the latest. Show ✓ for a few seconds.
 *   - `available`   — an `Update` is returned. Show version + notes + install button.
 *   - `downloading` — `downloadAndInstall()` running. Show progress bar.
 *   - `error`       — anything went wrong. Show the error text + retry.
 *
 * After install completes we call `relaunch()` from `tauri-plugin-process`
 * — the Windows installer runs in passive mode (config in tauri.conf.json)
 * which replaces the .exe and lets us restart cleanly into the new build.
 */
type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; downloaded: number; contentLength: number | null }
  | { kind: "error"; message: string };

export function UpdateChecker() {
  const lang = useStore((s) => s.settings.language);
  const t = STRINGS[lang === "fr" ? "fr" : "en"];
  const addToast = useToastStore((s) => s.addToast);
  const [state, setState] = useState<State>({ kind: "idle" });

  // Auto-clear the "up to date" state after 4 s so the button comes back —
  // otherwise the user is stuck with a green checkmark forever.
  useEffect(() => {
    if (state.kind !== "up-to-date") return;
    const timer = setTimeout(() => setState({ kind: "idle" }), 4000);
    return () => clearTimeout(timer);
  }, [state.kind]);

  const handleCheck = async () => {
    setState({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({ kind: "available", update });
      } else {
        setState({ kind: "up-to-date" });
      }
    } catch (e) {
      // The most common failure is "endpoint not reachable" (offline) or
      // "signature verification failed" (manifest mismatch). Both render
      // as a single error blob with the raw message; the toast logs it
      // longer-term for the user to copy if they need to report it.
      const message = String(e);
      setState({ kind: "error", message });
      addToast({ type: "error", message: t.checkFailed, detail: message });
    }
  };

  const handleInstall = async (update: Update) => {
    setState({ kind: "downloading", update, downloaded: 0, contentLength: null });
    try {
      let totalLength: number | null = null;
      await update.downloadAndInstall((event) => {
        // The plugin emits 3 event types. We use Started to grab the total
        // size, Progress to advance the bar, and Finished as a sanity log.
        if (event.event === "Started") {
          totalLength = event.data.contentLength ?? null;
          setState((s) =>
            s.kind === "downloading" ? { ...s, contentLength: totalLength } : s,
          );
        } else if (event.event === "Progress") {
          const inc = event.data.chunkLength;
          setState((s) =>
            s.kind === "downloading"
              ? { ...s, downloaded: s.downloaded + inc }
              : s,
          );
        }
      });
      // downloadAndInstall returns when the .exe replacement finished. We
      // then relaunch into the new build. Inform the user with a toast so
      // they understand why their window is about to flash away.
      addToast({ type: "success", message: t.installed });
      await relaunch();
    } catch (e) {
      const message = String(e);
      setState({ kind: "error", message });
      addToast({ type: "error", message: t.installFailed, detail: message });
    }
  };

  // ── Render branches ────────────────────────────────────────────────────────
  if (state.kind === "checking") {
    return (
      <button
        disabled
        className="flex items-center gap-2 h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary self-start"
      >
        <Loader2 size={13} className="animate-spin" /> {t.checking}
      </button>
    );
  }

  if (state.kind === "up-to-date") {
    return (
      <div className="flex items-center gap-2 h-8 px-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-[12px] text-emerald-400 self-start">
        <CheckCircle2 size={13} /> {t.upToDate}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/5">
        <div className="flex items-center gap-2 text-[12px] text-red-400">
          <XCircle size={13} className="shrink-0" />
          <span className="truncate" title={state.message}>{state.message}</span>
        </div>
        <button
          onClick={handleCheck}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] text-text-secondary border border-border bg-surface-3 hover:bg-surface-4 hover:text-text-primary transition-colors self-start"
        >
          <RotateCw size={11} /> {t.retry}
        </button>
      </div>
    );
  }

  if (state.kind === "available") {
    return (
      <div className="flex flex-col gap-3 p-3 rounded-lg border border-accent/30 bg-accent/5">
        {/* Header row: version + install button. Stays compact regardless
            of how long the release notes are below. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-text-primary font-medium">
            {t.available} v{state.update.version}
          </p>
          <button
            onClick={() => handleInstall(state.update)}
            className="flex items-center gap-1.5 h-7 px-3 rounded text-[11px] text-white bg-accent hover:bg-accent/80 transition-colors shrink-0"
          >
            <Download size={11} /> {t.install}
          </button>
        </div>

        {/* Release notes — rendered as markdown via react-markdown + remark-gfm
            (same stack as the AI panel). Wrapped in a scrollable max-h
            container so long changelogs don't push the modal off-screen.
            The prose-invert utilities give us decent typography for headings,
            lists, code, and bold without writing a per-element style sheet. */}
        {state.update.body && (
          <div className="max-h-48 overflow-y-auto pr-1 text-[11px] text-text-secondary leading-relaxed update-notes-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {state.update.body}
            </ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  if (state.kind === "downloading") {
    const total = state.contentLength;
    const pct = total && total > 0 ? Math.min(100, Math.round((state.downloaded / total) * 100)) : null;
    return (
      <div className="flex flex-col gap-2 p-3 rounded-lg border border-accent/30 bg-accent/5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] text-text-primary">
            <Loader2 size={13} className="animate-spin text-accent shrink-0" />
            <span>
              {t.downloading} v{state.update.version}
              {pct !== null && <span className="text-text-muted tabular-nums"> · {pct}%</span>}
            </span>
          </div>
        </div>
        {/* Progress bar — only renders when we know the total content length.
            Indeterminate downloads (no Content-Length header) just show the
            spinner above. */}
        {pct !== null && (
          <div className="h-1 rounded-full bg-surface-3 overflow-hidden">
            <div
              className={clsx("h-full bg-accent transition-[width] duration-150")}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  // idle
  return (
    <button
      onClick={handleCheck}
      className="flex items-center gap-2 h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors self-start"
    >
      <RefreshCw size={13} /> {t.check}
    </button>
  );
}
