import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, Share2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

export function ShareModal({ onClose }: { onClose: () => void }) {
  const {
    contexts, activeContextId,
    sharingMode, sharingCode, sharingPassword, sharingClients,
    setSharingHosted, resetSharing,
    addSharingClient, removeSharingClient,
    folderTabs,
  } = useStore();

  const activeCtx = contexts.find((c) => c.id === activeContextId);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [pwCopied, setPwCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  // Listen for client connect/disconnect events
  useEffect(() => {
    const u1 = listen<{ name: string }>("sharing://client-joined", (e) => addSharingClient(e.payload.name));
    const u2 = listen<{ name: string }>("sharing://client-left", (e) => removeSharingClient(e.payload.name));
    return () => { u1.then((f) => f()); u2.then((f) => f()); };
  }, [addSharingClient, removeSharingClient]);

  const handleStart = async () => {
    if (!activeCtx) return;
    setIsStarting(true);
    setError(null);
    try {
      const watchedPaths = activeCtx.watched_paths.length > 0
        ? activeCtx.watched_paths
        : folderTabs.map((t) => t.path);

      const result = await invoke<{ code: string; password: string }>("start_sharing", {
        workspaceName: activeCtx.name,
        workspaceIcon: activeCtx.icon,
        watchedPaths,
      });
      setSharingHosted(result.code, result.password);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    await invoke("stop_sharing").catch(console.error);
    resetSharing();
  };

  const copy = async (text: string, which: "code" | "pw") => {
    await navigator.clipboard.writeText(text);
    if (which === "code") { setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000); }
    else { setPwCopied(true); setTimeout(() => setPwCopied(false), 2000); }
  };

  const isHosting = sharingMode === "hosting";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={ref}
        className="bg-surface-1 border border-border rounded-xl shadow-2xl w-[420px] max-w-[96vw] p-5 flex flex-col gap-4"
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <Share2 size={16} className="text-accent shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary flex-1">Workspace partagé</span>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary">
            <X size={14} />
          </button>
        </div>

        {!isHosting ? (
          <>
            <p className="text-[12px] text-text-secondary leading-relaxed">
              Hébergez votre workspace <strong className="text-text-primary">{activeCtx?.icon} {activeCtx?.name}</strong> en local.
              Les autres utilisateurs pourront se connecter avec le code et le mot de passe générés.
            </p>
            <p className="text-[11px] text-text-muted">
              Tant que cette session est active, vos invités voient les fichiers en temps réel.
              La session s'arrête quand vous cliquez sur « Arrêter ».
            </p>
            {error && (
              <p className="text-[11px] text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</p>
            )}
            <button
              onClick={handleStart}
              disabled={isStarting || !activeCtx}
              className="h-8 px-4 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isStarting ? "Démarrage…" : "Démarrer le partage"}
            </button>
          </>
        ) : (
          <>
            <p className="text-[12px] text-text-secondary">
              Partagez ces informations avec vos invités pour qu'ils puissent se connecter.
            </p>

            {/* Code */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-text-muted uppercase tracking-widest">Adresse</label>
              <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg px-3 h-8">
                <span className="text-[12px] text-text-primary flex-1 font-mono">{sharingCode}</span>
                <button
                  onClick={() => copy(sharingCode!, "code")}
                  className="text-text-muted hover:text-text-primary transition-colors"
                  title="Copier"
                >
                  {codeCopied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                </button>
              </div>
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-text-muted uppercase tracking-widest">Mot de passe</label>
              <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg px-3 h-8">
                <span className="text-[12px] text-text-primary flex-1 font-mono tracking-widest">{sharingPassword}</span>
                <button
                  onClick={() => copy(sharingPassword!, "pw")}
                  className="text-text-muted hover:text-text-primary transition-colors"
                  title="Copier"
                >
                  {pwCopied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                </button>
              </div>
            </div>

            {/* Connected clients */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Users size={12} className="text-text-muted" />
                <span className="text-[11px] text-text-muted">
                  {sharingClients.length === 0
                    ? "En attente de connexion…"
                    : `${sharingClients.length} invité${sharingClients.length > 1 ? "s" : ""} connecté${sharingClients.length > 1 ? "s" : ""}`}
                </span>
                {sharingClients.length > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 ml-0.5" />
                )}
              </div>
              {sharingClients.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {sharingClients.map((name) => (
                    <div key={name} className="flex items-center gap-2 px-2 py-1 bg-surface-2 rounded text-[11px] text-text-secondary">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                      {name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={handleStop}
              className="h-8 px-4 rounded-lg border border-red-500/40 text-red-400 text-[12px] font-medium hover:bg-red-500/10 transition-colors"
            >
              Arrêter le partage
            </button>
          </>
        )}
      </div>
    </div>
  );
}
