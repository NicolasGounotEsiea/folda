import { invoke } from "@tauri-apps/api/core";

/**
 * Vault-aware file saving.
 *
 * A file opened from an encrypted vault is handed to the viewers as a DECRYPTED
 * working copy in `%LOCALAPPDATA%\com.nxs.app\.vault-tmp\`. Writing to that path
 * naively — as `write_file` would — puts the user's edit in the temp copy, never
 * back into the vault, and the temp copy is deleted the moment the vault locks.
 * The edit is then gone, silently. That is the single worst thing this feature
 * could do to someone.
 *
 * So EVERY viewer that can save must go through here rather than calling
 * `write_file` directly. Centralising it means a future viewer inherits the
 * protection instead of re-introducing the bug.
 */

interface TempTarget {
  vault_path: string;
  name: string;
}

/**
 * Is this path a decrypted vault working copy, judged purely by LOCATION?
 *
 * Vault temp files always live in `…\com.nxs.app\.vault-tmp\` (see
 * `vault_read_file` on the Rust side). This is a synchronous, IPC-free check for
 * hot paths — chiefly the store's crash-draft persistence, which must NEVER
 * write a vault file's decrypted text into localStorage: that stores plaintext
 * on disk where it survives the vault locking AND an app restart, defeating the
 * whole feature. Prefer the async `isVaultWorkingCopy` when you can afford it
 * (it also returns false once the vault has locked); use this where you can't.
 */
export function isVaultTempPath(path: string): boolean {
  return /[\\/]\.vault-tmp[\\/]/.test(path);
}

/**
 * Is this path a decrypted vault working copy? Used by viewers to show the
 * "encrypted" indicator. Returns false for ordinary files, and also once the
 * vault has locked (the mapping is dropped with the key).
 */
export async function isVaultWorkingCopy(path: string): Promise<boolean> {
  const target = await invoke<TempTarget | null>("vault_temp_target", { path })
    .catch(() => null);
  return target !== null;
}

/**
 * Save text to `path`, re-encrypting into the vault when it is a vault working
 * copy, and writing normally when it isn't.
 *
 * Throws with a user-facing message if the vault locked mid-edit. The caller
 * MUST surface that and keep its buffer — the text is still in the editor, and
 * the fix is "unlock, save again", not "start over".
 */
export async function saveTextFile(path: string, content: string): Promise<void> {
  const target = await invoke<TempTarget | null>("vault_temp_target", { path })
    .catch(() => null);

  if (target) {
    // Tauri serializes Vec<u8> from a plain number array.
    const bytes = Array.from(new TextEncoder().encode(content));
    await invoke("vault_write_back", { tempPath: path, content: bytes });
    return;
  }

  await invoke("write_file", { path, content });
}
