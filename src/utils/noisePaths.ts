/**
 * "Noisy" path filter for recents lists.
 *
 * The activity log records EVERY `navigated` action — including time the
 * user (or some background process: a build, a git plumbing call, an IDE
 * indexer) touched a folder deep inside `.git/objects/…` or `node_modules/`.
 * Those entries technically reflect real activity but they're not what the
 * user wants to see in a "Recent" list — they're noise that crowds out the
 * useful entries (the project folder, the document folder, etc.).
 *
 * This module exposes a single predicate `isNoisyPath(path)` that returns
 * true when the path contains any segment in the well-known noise list.
 * Matching is segment-based (between separators) and case-insensitive so a
 * folder accidentally named "Node_Modules" on case-insensitive Windows still
 * gets filtered, while a folder named `bar.git` (legitimate) does NOT match
 * `.git` because the segment check is strict.
 *
 * Used by both the Command Palette (Ctrl+K) recents and the Quick-start
 * popover anchored under the app logo. Keep the list small and conservative
 * — false negatives (letting one noisy entry through) are tolerable, but
 * false positives (hiding a real folder the user named "dist" or "build")
 * are not. Add a new entry only when it shows up repeatedly in real recents
 * for multiple users.
 */

const NOISE_SEGMENTS: readonly string[] = [
  // Version control plumbing
  ".git", ".svn", ".hg", ".bzr",
  // Node / JS toolchains
  "node_modules", ".next", ".nuxt", ".turbo", ".parcel-cache",
  // Python / Rust / .NET / Java
  "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".tox",
  "target",            // Cargo / Maven
  "bin", "obj",        // .NET — these CAN collide with user-named folders but
                       // when they sit under another `bin`/`obj` ancestor (e.g.
                       // `MyProject/bin/Debug/…`) they're almost always build
                       // artifacts; we accept the trade.
  // OS / system
  "AppData", "$Recycle.Bin", "$RECYCLE.BIN", "System Volume Information",
  // Editor / IDE
  ".vs", ".idea", ".vscode-test",
] as const;

const NOISE_LOWER = new Set(NOISE_SEGMENTS.map((s) => s.toLowerCase()));

// ─── Filename-level noise (temp / lock / backup files) ───────────────────────
//
// The path-segment filter above catches noisy FOLDERS. The filename filter
// below catches noisy FILES — Office lock files, atomic-save intermediates,
// editor backups, browser-download partials, OS metadata files, and random
// hash-suffixed temps that sync tools leave behind. These show up in the
// activity log because the file watcher records every modify event regardless
// of whether the file is a real user document or a 200 ms flash from Word's
// autosave.

// Lowercased so the basename check below is case-insensitive — Windows
// filesystems don't preserve case predictably across tools, so `Thumbs.db`
// vs `thumbs.db` would otherwise leak through.
const NOISE_FILENAME_EQ_LOWER = new Set<string>([
  "thumbs.db",       // Windows folder thumbnail cache
  "desktop.ini",     // Windows folder customization
  ".ds_store",       // macOS folder metadata
]);

const NOISE_FILENAME_PREFIX: readonly string[] = [
  "~$",          // Office (Word, Excel, PowerPoint) edit-lock indicator
  ".~lock.",     // LibreOffice / OpenOffice lock (usually ends with `#`)
  "~wrl",        // Word temp files: ~WRL0001.tmp, ~WRA0001.tmp …
  "~wra",
  "~wrd",
] as const;

const NOISE_FILENAME_SUFFIX: readonly string[] = [
  ".tmp", ".temp",
  ".crdownload", ".part", ".partial",     // browser downloads
  ".bak", ".orig",                         // generic backups
  ".swp", ".swo",                          // vim swap
  "~",                                     // emacs / `cp -b` backup tail
] as const;

// Hash-only extensions of 8+ hex chars — catches things like `file.docx.84f3a2b1`
// or `file.84f3a2b1cd` that sync tools (Dropbox, OneDrive, atomic-save flows)
// leave behind. 8 chars minimum because shorter extensions are too easy to
// false-positive on legitimate ones (think `.b612` or `.abcd` archives — rare
// but not impossible). The trailing-dot anchor `^\.` keeps `archive7z` out.
const HASH_EXT_RE = /^\.[a-f0-9]{8,}$/i;

function isNoisyFilename(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (NOISE_FILENAME_EQ_LOWER.has(lower)) return true;
  for (const p of NOISE_FILENAME_PREFIX) if (lower.startsWith(p)) return true;
  for (const s of NOISE_FILENAME_SUFFIX) if (lower.endsWith(s)) return true;
  const lastDot = lower.lastIndexOf(".");
  if (lastDot > 0 && HASH_EXT_RE.test(lower.slice(lastDot))) return true;
  return false;
}

/**
 * Returns true when ANY segment of `path` matches a noise entry, OR when the
 * file basename matches a known temp/lock/backup pattern. Segments are split
 * on both `/` and `\` so the function works for Windows-native
 * (`C:\Users\foo\.git\objects`) and POSIX-style (`/home/foo/.git/objects`)
 * paths without normalization at the call site.
 *
 * Examples that get filtered:
 *   C:\…\.git\objects\58            → noisy segment `.git`
 *   C:\…\Documents\~$Report.docx    → noisy filename prefix `~$`
 *   C:\…\Downloads\big.iso.crdownload → noisy filename suffix `.crdownload`
 *   C:\…\Sync\Memo.docx.a8f2b3c4d5  → noisy filename hash-extension
 *
 * Examples that are NOT filtered (real user files):
 *   C:\Users\foo\Projects\bar.git\README.md → `bar.git` is a literal segment, not `.git`
 *   C:\…\package-lock.json                  → no prefix/suffix/hash-ext match
 *   C:\…\IMG_20240101_a8b2c4d5.jpg          → hash is INSIDE the name, not the extension
 */
export function isNoisyPath(path: string): boolean {
  if (!path) return false;
  // Split on both separators in one pass. Empty segments (leading slash, drive
  // letter trailing colon, double-separators) are skipped via the truthy check.
  const segments = path.split(/[\\/]/);
  for (const seg of segments) {
    if (!seg) continue;
    if (NOISE_LOWER.has(seg.toLowerCase())) return true;
  }
  // Last non-empty segment is the basename; check it against the filename
  // patterns. We iterate from the end to skip a trailing empty (paths ending
  // with a separator).
  let basename = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) { basename = segments[i]; break; }
  }
  if (isNoisyFilename(basename)) return true;
  return false;
}
