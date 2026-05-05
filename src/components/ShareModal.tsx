import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, ChevronRight, Copy, Plus, Share2, Shield, Trash2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

interface SharePermission {
  id: number;
  context_id: number;
  path: string;
  can_list: boolean;
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
  can_delete: boolean;
}

const PERM_LABELS: { key: keyof Omit<SharePermission, "id" | "context_id" | "path">; label: string }[] = [
  { key: "can_list",   label: "List" },
  { key: "can_read",   label: "Read" },
  { key: "can_create", label: "Create" },
  { key: "can_update", label: "Edit" },
  { key: "can_delete", label: "Delete" },
];

function PermissionsPanel({ contextId }: { contextId: number }) {
  const [rules, setRules] = useState<SharePermission[]>([]);
  const [newPath, setNewPath] = useState("");
  const [addingPath, setAddingPath] = useState(false);

  const load = () =>
    invoke<SharePermission[]>("get_share_permissions", { contextId })
      .then(setRules)
      .catch(() => {});

  useEffect(() => { load(); }, [contextId]);

  const getDefault = () => rules.find((r) => r.path === "");
  const getOverrides = () => rules.filter((r) => r.path !== "");

  const toggle = async (rule: SharePermission, key: keyof Omit<SharePermission, "id" | "context_id" | "path">) => {
    const updated = { ...rule, [key]: !rule[key] };
    await invoke("set_share_permission", {
      contextId,
      path: rule.path,
      canList: updated.can_list,
      canRead: updated.can_read,
      canCreate: updated.can_create,
      canUpdate: updated.can_update,
      canDelete: updated.can_delete,
    }).catch(() => {});
    load();
  };

  const ensureDefault = async () => {
    if (!getDefault()) {
      await invoke("set_share_permission", {
        contextId, path: "",
        canList: true, canRead: true, canCreate: true, canUpdate: true, canDelete: true,
      }).catch(() => {});
      load();
    }
  };
  useEffect(() => { ensureDefault(); }, [contextId]);

  const addOverride = async () => {
    if (!newPath.trim()) return;
    await invoke("set_share_permission", {
      contextId, path: newPath.trim(),
      canList: true, canRead: true, canCreate: false, canUpdate: false, canDelete: false,
    }).catch(() => {});
    setNewPath(""); setAddingPath(false);
    load();
  };

  const deleteRule = async (id: number) => {
    await invoke("delete_share_permission", { id }).catch(() => {});
    load();
  };

  const defaultRule = getDefault();
  const overrides = getOverrides();

  return (
    <div className="flex flex-col gap-3">
      {/* Workspace default */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-widest mb-1.5">Workspace default</p>
        {defaultRule ? (
          <div className="flex flex-wrap gap-1.5">
            {PERM_LABELS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => toggle(defaultRule, key)}
                className={`px-2.5 py-1 rounded text-[10px] border transition-colors ${
                  defaultRule[key]
                    ? "bg-accent/15 border-accent/30 text-accent"
                    : "bg-surface-3 border-border text-text-muted"
                }`}
              >
                {defaultRule[key] ? "✓" : "✗"} {label}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-text-muted animate-pulse">Loading…</div>
        )}
      </div>

      {/* Per-path overrides */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] text-text-muted uppercase tracking-widest">Path overrides</p>
          <button
            onClick={() => setAddingPath((v) => !v)}
            className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent-glow transition-colors"
          >
            <Plus size={10} /> Add
          </button>
        </div>
        {addingPath && (
          <div className="flex items-center gap-1 mb-2">
            <input
              autoFocus
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addOverride(); if (e.key === "Escape") setAddingPath(false); }}
              placeholder="C:\path\to\folder or file"
              className="flex-1 h-6 px-2 rounded bg-surface-3 border border-border text-[10px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
            />
            <button onClick={addOverride} className="h-6 px-2 rounded bg-accent text-white text-[10px] hover:bg-accent/80 transition-colors">Add</button>
          </div>
        )}
        {overrides.length === 0 ? (
          <p className="text-[10px] text-text-muted italic">No overrides — workspace default applies everywhere.</p>
        ) : (
          <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
            {overrides.map((rule) => (
              <div key={rule.id} className="bg-surface-2 rounded p-2 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] text-text-secondary font-mono truncate flex-1" title={rule.path}>
                    {rule.path}
                  </span>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={9} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {PERM_LABELS.map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => toggle(rule, key)}
                      className={`px-2 py-0.5 rounded text-[9px] border transition-colors ${
                        rule[key]
                          ? "bg-accent/15 border-accent/30 text-accent"
                          : "bg-surface-3 border-border text-text-muted line-through"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ShareModal({ onClose }: { onClose: () => void }) {
  const {
    contexts, activeContextId,
    sharingMode, sharingCode, sharingPassword, sharingClients,
    sharingWorkspaceName, sharingWorkspaceIcon,
    setSharingHosted, resetSharing,
    addSharingClient, removeSharingClient,
    folderTabs,
  } = useStore();

  const activeCtx = contexts.find((c) => c.id === activeContextId);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [pwCopied, setPwCopied] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
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
        contextId: activeCtx.id,
        workspaceName: activeCtx.name,
        workspaceIcon: activeCtx.icon,
        watchedPaths,
      });
      setSharingHosted(result.code, result.password, activeCtx.name, activeCtx.icon, activeCtx.id);
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
            {!activeCtx && (
              <p className="text-[11px] text-yellow-400 bg-yellow-400/10 rounded px-3 py-2">
                Sélectionnez un workspace avant de partager.
              </p>
            )}
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
            <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 rounded-lg border border-border">
              <span className="text-[15px]">{sharingWorkspaceIcon ?? "📁"}</span>
              <div className="flex flex-col min-w-0">
                <span className="text-[12px] font-medium text-text-primary truncate">{sharingWorkspaceName ?? "Workspace"}</span>
                <span className="text-[10px] text-text-muted">Partage en cours</span>
              </div>
              <span className="ml-auto w-2 h-2 rounded-full bg-green-400 shrink-0" />
            </div>
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

            {/* Permissions */}
            {activeCtx && (
              <div className="border border-border-subtle rounded-lg overflow-hidden">
                <button
                  onClick={() => setPermOpen((v) => !v)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-[11px] text-text-secondary hover:bg-surface-2 transition-colors"
                >
                  <Shield size={11} className="text-accent shrink-0" />
                  <span className="flex-1 text-left">Permissions invités</span>
                  {permOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
                {permOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-border-subtle bg-surface-0">
                    <PermissionsPanel contextId={activeCtx.id} />
                  </div>
                )}
              </div>
            )}

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
