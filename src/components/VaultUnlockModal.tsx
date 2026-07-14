import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Eye, EyeOff, Loader2, Lock, X } from "lucide-react";
import { useState } from "react";
import { refreshVaults } from "../store/useVaultStore";
import { useTranslation } from "../utils/i18n";

/**
 * Unlock a vault with its password, or — when the password is lost — with the
 * recovery code, which also resets the password in the same step.
 *
 * Two modes rather than a separate "reset password" screen: a user who has
 * forgotten their password is already stressed, and making them find a second
 * dialog is exactly when they give up. The recovery path is one click away.
 */
export function VaultUnlockModal({
  folderPath,
  folderName,
  onClose,
  onUnlocked,
}: {
  folderPath: string;
  folderName: string;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const t = useTranslation();
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "password") {
        if (!password) { setBusy(false); return; }
        await invoke("vault_unlock", { path: folderPath, password });
      } else {
        if (!recoveryCode.trim() || !newPassword) { setBusy(false); return; }
        // Reset the password from the code, then unlock with the new one. Two
        // steps backend-side, one action from the user's point of view.
        await invoke("vault_reset_password", {
          path: folderPath,
          recoveryCode: recoveryCode.trim(),
          newPassword,
        });
        await invoke("vault_unlock", { path: folderPath, password: newPassword });
      }
      await refreshVaults();
      onUnlocked();
      onClose();
    } catch (e) {
      // The backend deliberately does not distinguish "wrong password" from
      // "tampered key slot" — surface whatever it says, unchanged.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === "password"
    ? password.length > 0
    : recoveryCode.trim().length > 0 && newPassword.length > 0;

  return (
    <div
      className="modal-backdrop-in fixed inset-0 z-[500] flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[400px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border-subtle shrink-0">
          <Lock size={14} className="text-amber-400 shrink-0" />
          <span className="text-[13px] text-text-primary font-medium flex-1 truncate">
            {folderName}
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {mode === "password" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-text-secondary">{t.vaultPassword}</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoFocus
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                    className="w-full h-8 pl-2.5 pr-8 rounded-lg bg-surface-2 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
              </div>
              <button
                onClick={() => { setMode("recovery"); setError(null); }}
                className="text-[11px] text-accent hover:underline self-start"
              >
                {t.vaultForgotPassword}
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] text-text-secondary leading-relaxed">
                {t.vaultRecoveryUseBody}
              </p>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-text-secondary">{t.vaultRecoveryCode}</label>
                <input
                  autoFocus
                  value={recoveryCode}
                  onChange={(e) => { setRecoveryCode(e.target.value); setError(null); }}
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  spellCheck={false}
                  className="h-8 px-2.5 rounded-lg bg-surface-2 border border-border text-[12px] text-text-primary font-mono tracking-wider placeholder-text-muted outline-none focus:border-accent"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] text-text-secondary">{t.vaultNewPassword}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                  className="h-8 px-2.5 rounded-lg bg-surface-2 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
                />
              </div>
              <button
                onClick={() => { setMode("password"); setError(null); }}
                className="text-[11px] text-accent hover:underline self-start"
              >
                {t.vaultUsePasswordInstead}
              </button>
            </>
          )}

          {error && (
            <p className="text-[11px] text-red-400 leading-relaxed">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
            >
              {t.cancel}
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit || busy}
              className={clsx(
                "flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent text-white text-[12px] transition-colors",
                (!canSubmit || busy) ? "opacity-40" : "hover:bg-accent/80",
              )}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
              {t.vaultUnlock}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
