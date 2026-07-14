import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { AlertTriangle, Check, Copy, Loader2, Lock, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { useToastStore } from "../store/useToastStore";
import { refreshVaults } from "../store/useVaultStore";
import { useTranslation } from "../utils/i18n";

/**
 * Three-step wizard to turn a folder into an encrypted vault.
 *
 * The UX here carries more weight than usual, because this is the one feature in
 * nxs where a user action can **permanently destroy their own data**: forget the
 * password AND lose the recovery code, and the files are gone. There is no
 * backdoor — that is the entire point of the feature, and it is also the biggest
 * support risk it creates.
 *
 * So the wizard is deliberately not frictionless:
 *   1. **Warn** — say plainly what encryption means and what it does NOT protect.
 *   2. **Password** — with a strength meter and a confirm field.
 *   3. **Recovery code** — shown ONCE. The user must copy it and tick a box
 *      saying they saved it before the wizard will close.
 *
 * Step 3 cannot be skipped or dismissed with Escape/backdrop, because a user who
 * closes it accidentally has just lost their only fallback.
 */

type Step = "warn" | "password" | "recovery";

/** Rough password strength, purely to nudge — never blocks. 0-4. */
function strengthOf(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^\w\s]/.test(pw)) s++;
  return Math.min(4, s);
}

export function VaultCreateWizard({
  folderPath,
  folderName,
  onClose,
  onCreated,
}: {
  folderPath: string;
  folderName: string;
  onClose: () => void;
  /** Fired after the vault exists AND its loose files are encrypted. */
  onCreated: () => void;
}) {
  const t = useTranslation();
  const addToast = useToastStore((s) => s.addToast);

  const [step, setStep] = useState<Step>("warn");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [savedAck, setSavedAck] = useState(false);
  const [encryptedCount, setEncryptedCount] = useState(0);

  const strength = strengthOf(password);
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmitPassword = password.length > 0 && password === confirm && !busy;

  const handleCreate = async () => {
    if (!canSubmitPassword) return;
    setBusy(true);
    try {
      const code = await invoke<string>("vault_create", { path: folderPath, password });
      // Unlock immediately so the loose files can be encrypted into it.
      await invoke("vault_unlock", { path: folderPath, password });
      const n = await invoke<number>("vault_encrypt_existing", { path: folderPath });
      setEncryptedCount(n);
      setRecoveryCode(code);
      await refreshVaults();
      setStep("recovery");
    } catch (e) {
      addToast({ type: "error", message: t.vaultCreateFailed, detail: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the code is still on screen to copy by hand */ }
  };

  const finish = () => {
    onCreated();
    onClose();
  };

  // Step 3 is NOT dismissible: closing it loses the only copy of the recovery
  // code. The backdrop and the ✕ are inert there by design.
  const dismissible = step !== "recovery";

  return (
    <div
      className="modal-backdrop-in fixed inset-0 z-[500] flex items-center justify-center bg-black/70"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[460px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border-subtle shrink-0">
          <Lock size={14} className="text-accent shrink-0" />
          <span className="text-[13px] text-text-primary font-medium flex-1 truncate">
            {t.vaultCreateTitle} — {folderName}
          </span>
          {dismissible && (
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* ── Step 1: the honest warning ── */}
        {step === "warn" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <ShieldAlert size={16} className="text-red-400 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1">
                <p className="text-[12px] text-red-400 font-medium">{t.vaultWarnNoRecoveryTitle}</p>
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {t.vaultWarnNoRecoveryBody}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] text-text-primary font-medium">{t.vaultWarnProtectsTitle}</p>
              <p className="text-[11px] text-text-secondary leading-relaxed">{t.vaultWarnProtects}</p>
            </div>

            <div className="flex gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-amber-400 font-medium">{t.vaultWarnLimitsTitle}</p>
                <p className="text-[11px] text-text-secondary leading-relaxed">{t.vaultWarnLimits}</p>
              </div>
            </div>

            <p className="text-[11px] text-text-muted leading-relaxed">{t.vaultWarnIndexing}</p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
              >
                {t.cancel}
              </button>
              <button
                onClick={() => setStep("password")}
                className="h-8 px-3 rounded-lg bg-accent text-white text-[12px] hover:bg-accent/80 transition-colors"
              >
                {t.vaultUnderstand}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: password ── */}
        {step === "password" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-text-secondary">{t.vaultPassword}</label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canSubmitPassword) handleCreate(); }}
                className="h-8 px-2.5 rounded-lg bg-surface-2 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
              />
              {/* Strength meter — advisory only, never blocks. A user who wants a
                  weak password on their own machine is entitled to one; what we
                  owe them is the information, not a veto. */}
              <div className="flex gap-1 mt-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className={clsx(
                      "h-1 flex-1 rounded-full transition-colors",
                      i < strength
                        ? strength <= 1 ? "bg-red-400" : strength === 2 ? "bg-amber-400" : "bg-emerald-400"
                        : "bg-surface-4",
                    )}
                  />
                ))}
              </div>
              {password.length > 0 && strength <= 1 && (
                <p className="text-[10px] text-amber-400">{t.vaultWeakPassword}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] text-text-secondary">{t.vaultPasswordConfirm}</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canSubmitPassword) handleCreate(); }}
                className={clsx(
                  "h-8 px-2.5 rounded-lg bg-surface-2 border text-[12px] text-text-primary outline-none",
                  mismatch ? "border-red-500/60" : "border-border focus:border-accent",
                )}
              />
              {mismatch && <p className="text-[10px] text-red-400">{t.vaultPasswordMismatch}</p>}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setStep("warn")}
                disabled={busy}
                className="h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 disabled:opacity-40 transition-colors"
              >
                {t.back}
              </button>
              <button
                onClick={handleCreate}
                disabled={!canSubmitPassword}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent text-white text-[12px] hover:bg-accent/80 disabled:opacity-40 transition-colors"
              >
                {busy ? <><Loader2 size={12} className="animate-spin" /> {t.vaultEncrypting}</> : <><Lock size={12} /> {t.vaultEncryptFolder}</>}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: recovery code — shown once, cannot be skipped ── */}
        {step === "recovery" && (
          <div className="p-4 flex flex-col gap-3">
            <div className="flex gap-2.5 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
              <Check size={14} className="text-emerald-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-text-secondary leading-relaxed">
                {t.vaultCreatedBody.replace("{n}", String(encryptedCount))}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-[12px] text-text-primary font-medium">{t.vaultRecoveryTitle}</p>
              <p className="text-[11px] text-text-secondary leading-relaxed">{t.vaultRecoveryBody}</p>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-surface-2 border border-border">
              <code className="flex-1 text-[15px] text-text-primary font-mono tracking-widest select-all text-center">
                {recoveryCode}
              </code>
              <button
                onClick={copyCode}
                title={t.copy}
                className="w-7 h-7 flex items-center justify-center rounded shrink-0 text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              </button>
            </div>

            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="text-[11px] text-text-secondary leading-relaxed">
                {t.vaultRecoverySavedAck}
              </span>
            </label>

            <div className="flex justify-end pt-1">
              <button
                onClick={finish}
                disabled={!savedAck}
                className="h-8 px-3 rounded-lg bg-accent text-white text-[12px] hover:bg-accent/80 disabled:opacity-40 transition-colors"
              >
                {t.done}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
