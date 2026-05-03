import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogIn, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

export function JoinModal({ onClose }: { onClose: () => void }) {
  const { setSharingJoined, resetSharing, setListEntries, pushNav, addRemoteFolderTabs } = useStore();

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !isConnecting) onClose();
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [onClose, isConnecting]);

  // Listen for host disconnect
  useEffect(() => {
    const u = listen("sharing://disconnected", () => {
      resetSharing();
      setConnected(false);
    });
    return () => { u.then((f) => f()); };
  }, [resetSharing]);

  const handleConnect = async () => {
    const trimCode = code.trim();
    const trimPw = password.trim();
    const trimName = displayName.trim() || "Invité";
    if (!trimCode || !trimPw) {
      setError("L'adresse et le mot de passe sont requis.");
      return;
    }
    setIsConnecting(true);
    setError(null);
    try {
      const info = await invoke<{ name: string; icon: string; root_paths: string[] }>(
        "join_shared_workspace",
        { code: trimCode, password: trimPw, displayName: trimName },
      );
      setSharingJoined(info.name, info.root_paths);
      addRemoteFolderTabs(info.root_paths);

      if (info.root_paths.length > 0) {
        const entries = await invoke<import("../types").ListEntry[]>("list_remote_dir", { path: info.root_paths[0] });
        setListEntries(entries);
        pushNav(info.root_paths[0]);
      }
      setConnected(true);
      setTimeout(onClose, 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLeave = async () => {
    await invoke("leave_shared_workspace").catch(console.error);
    resetSharing();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={ref}
        className="bg-surface-1 border border-border rounded-xl shadow-2xl w-[380px] max-w-[96vw] p-5 flex flex-col gap-4"
      >
        {/* Header */}
        <div className="flex items-center gap-2">
          <LogIn size={16} className="text-accent shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary flex-1">Rejoindre un workspace</span>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary">
            <X size={14} />
          </button>
        </div>

        {connected ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <span className="text-2xl">✅</span>
            <p className="text-[13px] text-text-primary font-medium">Connecté !</p>
            <p className="text-[11px] text-text-muted text-center">Vous parcourez maintenant le workspace distant.</p>
            <button
              onClick={handleLeave}
              className="mt-2 h-8 px-4 rounded-lg border border-red-500/40 text-red-400 text-[12px] font-medium hover:bg-red-500/10 transition-colors"
            >
              Se déconnecter
            </button>
          </div>
        ) : (
          <>
            <p className="text-[12px] text-text-secondary">
              Entrez l'adresse et le mot de passe partagés par l'hôte.
            </p>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted uppercase tracking-widest">Adresse (IP:Port)</label>
                <input
                  className="h-8 bg-surface-2 border border-border rounded-lg px-3 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
                  placeholder="192.168.1.10:9412"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted uppercase tracking-widest">Mot de passe</label>
                <input
                  className="h-8 bg-surface-2 border border-border rounded-lg px-3 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono tracking-widest"
                  placeholder="ABCD1234"
                  value={password}
                  onChange={(e) => setPassword(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted uppercase tracking-widest">Votre nom (optionnel)</label>
                <input
                  className="h-8 bg-surface-2 border border-border rounded-lg px-3 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
                  placeholder="Invité"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                />
              </div>
            </div>

            {error && (
              <p className="text-[11px] text-red-400 bg-red-400/10 rounded px-3 py-2">{error}</p>
            )}

            <button
              onClick={handleConnect}
              disabled={isConnecting || !code || !password}
              className="h-8 px-4 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isConnecting ? "Connexion…" : "Se connecter"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
