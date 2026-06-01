/// Windows shell integration — registers / unregisters context menu entries in
/// HKCU so no admin rights are required.
///
/// Files get TWO entries — distinct verbs, distinct intents:
///
/// - `nxs` → "Reveal in nxs" — navigates to the parent folder, file is visible
///   in the file list. Same UX as Finder's "Reveal" / Explorer's "Open file
///   location". Argv: `--path "%1"`.
/// - `nxsOpen` → "Open with nxs" — actually opens the file in nxs's viewer
///   (PDF, image, editor, …). Argv: `--open "%1"`.
///
/// Folders only get one entry (`Open folder in nxs`) because "reveal" and "open"
/// collapse to the same action — navigate into the folder.
use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

// Historical verb name kept for the file-reveal entry so existing installs
// don't end up with a stale orphan key after upgrade. Self-heal rewrites it.
const FILE_REVEAL_VERB: &str = "nxs";
const FILE_OPEN_VERB: &str = "nxsOpen";
const DIR_VERB: &str = "nxs";

const FILE_REVEAL_LABEL: &str = "Reveal in nxs";
const FILE_OPEN_LABEL: &str = "Open with nxs";
const DIR_LABEL: &str = "Open folder in nxs";
const DIR_BG_LABEL: &str = "Open here in nxs";

fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// `intent_flag` is the argv flag the entry uses ("--path" for reveal, "--open"
/// for open). `arg_placeholder` is the Windows substitution token ("%1" for the
/// clicked path, "%V" for directory background).
fn write_shell_entry(
    hkcu: &RegKey,
    base: &str,
    verb: &str,
    label: &str,
    intent_flag: &str,
    exe: &str,
    arg_placeholder: &str,
) -> Result<(), String> {
    let shell_key = format!(r"{}\shell\{}", base, verb);
    let (key, _) = hkcu
        .create_subkey(&shell_key)
        .map_err(|e| e.to_string())?;
    key.set_value("", &label).map_err(|e| e.to_string())?;
    key.set_value("Icon", &format!("{},0", exe))
        .map_err(|e| e.to_string())?;

    let cmd_key = format!(r"{}\command", shell_key);
    let (cmd, _) = hkcu
        .create_subkey(&cmd_key)
        .map_err(|e| e.to_string())?;
    cmd.set_value(
        "",
        &format!(r#""{}" "{}" "{}""#, exe, intent_flag, arg_placeholder),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_shell_entry(hkcu: &RegKey, base: &str, verb: &str) -> Result<(), String> {
    let cmd_key = format!(r"{}\shell\{}\command", base, verb);
    let _ = hkcu.delete_subkey(&cmd_key);
    let shell_key = format!(r"{}\shell\{}", base, verb);
    let _ = hkcu.delete_subkey(&shell_key);
    Ok(())
}

/// Read the exe path embedded in our registered command, if any. Returns None
/// if the key doesn't exist or can't be parsed. Used to detect a stale exe path
/// after an app update so we can silently self-heal.
///
/// We probe the reveal-verb key because that one has existed since v0.1.5 — its
/// presence is the historical signal for "user opted in". An upgrade installs
/// the new `nxsOpen` key alongside via self_heal.
fn read_registered_exe() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            format!(r"Software\Classes\*\shell\{}\command", FILE_REVEAL_VERB),
            KEY_READ,
        )
        .ok()?;
    let cmd: String = key.get_value("").ok()?;
    // Extract the first quoted token from `"C:\path\to\nxs.exe" "--path" "%1"`.
    let first_quote = cmd.find('"')?;
    let rest = &cmd[first_quote + 1..];
    let close_quote = rest.find('"')?;
    Some(rest[..close_quote].to_string())
}

/// Refresh Explorer / shell association caches after registry changes.
/// Without this, Windows usually picks up the change on its own — but several
/// edge cases (long-running Explorer, deep-changed shell extensions) benefit
/// from an explicit notification. Cheap and harmless.
#[cfg(windows)]
fn notify_shell_change() {
    unsafe {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

#[cfg(not(windows))]
fn notify_shell_change() { /* no-op on non-Windows */ }

#[tauri::command]
pub fn register_shell_extension() -> Result<(), String> {
    let exe = exe_path()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // Files: two verbs — reveal (--path, navigate to parent) and open (--open,
    // open the file in nxs's viewer). The user picks the one they want from the
    // Windows context menu.
    write_shell_entry(
        &hkcu, r"Software\Classes\*",
        FILE_REVEAL_VERB, FILE_REVEAL_LABEL, "--path", &exe, "%1",
    )?;
    write_shell_entry(
        &hkcu, r"Software\Classes\*",
        FILE_OPEN_VERB, FILE_OPEN_LABEL, "--open", &exe, "%1",
    )?;
    // Directories: a single entry. "Open with nxs" on a folder navigates INTO
    // the folder — that already IS the open semantic.
    write_shell_entry(
        &hkcu, r"Software\Classes\Directory",
        DIR_VERB, DIR_LABEL, "--path", &exe, "%1",
    )?;
    // Directory background (right-click on empty space in a folder).
    write_shell_entry(
        &hkcu, r"Software\Classes\Directory\Background",
        DIR_VERB, DIR_BG_LABEL, "--path", &exe, "%V",
    )?;

    notify_shell_change();
    Ok(())
}

#[tauri::command]
pub fn unregister_shell_extension() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Both file verbs need cleanup; folder/background use the single legacy verb.
    delete_shell_entry(&hkcu, r"Software\Classes\*", FILE_REVEAL_VERB)?;
    delete_shell_entry(&hkcu, r"Software\Classes\*", FILE_OPEN_VERB)?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory", DIR_VERB)?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory\Background", DIR_VERB)?;
    notify_shell_change();
    Ok(())
}

#[tauri::command]
pub fn is_shell_extension_registered() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Reveal verb is the historical one — its presence is the canonical signal.
    // Self-heal ensures the open verb gets installed alongside on next launch.
    hkcu.open_subkey_with_flags(
        format!(r"Software\Classes\*\shell\{}", FILE_REVEAL_VERB),
        KEY_READ,
    )
    .is_ok()
}

/// Called once on app startup. Two reasons to re-register silently:
///   1. The exe path moved (app update relocated the binary, the registry still
///      points at the old path — clicking the menu would fail or launch the old
///      installation).
///   2. The user is upgrading from a version that didn't have the `nxsOpen`
///      verb yet (v0.1.7 and earlier). We need to install the missing entry so
///      "Open with nxs" appears in the context menu without forcing them back
///      into Settings to flip the toggle off and on.
pub fn self_heal_registration() {
    if !is_shell_extension_registered() {
        return; // user never opted in
    }
    let current = match exe_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let needs_update = match read_registered_exe() {
        Some(r) => !r.eq_ignore_ascii_case(&current),
        None => true, // command unparseable — re-register
    };
    // Detect missing nxsOpen verb (upgrade from a pre-split-verb install).
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let missing_open_verb = hkcu
        .open_subkey_with_flags(
            format!(r"Software\Classes\*\shell\{}", FILE_OPEN_VERB),
            KEY_READ,
        )
        .is_err();
    if needs_update || missing_open_verb {
        let _ = register_shell_extension();
    }
}

// ── Launch-path parsing ──────────────────────────────────────────────────────

/// Intent communicated by the registered context-menu command. Drives whether
/// the frontend just navigates to the parent folder or also opens the file in
/// the embedded viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchIntent {
    /// `--path` (or bare path) — go to parent folder, do not open the file.
    /// This is the historical default and remains the fallback for any unknown
    /// invocation so old shortcuts / scripts keep working.
    Reveal,
    /// `--open` — also open the file in nxs's viewer after navigating.
    Open,
}

#[derive(Debug, Clone, Serialize)]
pub struct LaunchPath {
    pub path: String,
    pub is_dir: bool,
    pub intent: LaunchIntent,
}

/// Parse the path argument out of a process argv. Returns the path AND the
/// requested intent (reveal vs open). Reused for the initial launch and for
/// `tauri-plugin-single-instance` callbacks when another nxs.exe is launched
/// while this one is already running.
///
/// Recognized forms (in order — first match wins):
///   nxs.exe --open "C:\path\to\file.pdf"   → (path, Open)
///   nxs.exe --path "C:\some\path"          → (path, Reveal)
///   nxs.exe "C:\some\path"                 → (path, Reveal)   [bare path fallback]
pub fn parse_launch_path_from_args(args: &[String]) -> Option<(String, LaunchIntent)> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--open" {
            return iter.next().cloned().map(|p| (p, LaunchIntent::Open));
        }
        if arg == "--path" {
            return iter.next().cloned().map(|p| (p, LaunchIntent::Reveal));
        }
    }
    // Bare-path fallback: argv[1] looks like a filesystem path. Reveal intent.
    if args.len() == 2 {
        let candidate = &args[1];
        if !candidate.starts_with("--") && (candidate.contains('\\') || candidate.contains('/')) {
            return Some((candidate.clone(), LaunchIntent::Reveal));
        }
    }
    None
}

/// Turn a raw path + intent into a `LaunchPath` with reliable is_dir via
/// `fs::metadata` (rather than the brittle string heuristic that used to live
/// in the frontend). Intent is preserved as-is — it's the caller's contract.
pub fn classify_launch_path(path: String, intent: LaunchIntent) -> LaunchPath {
    let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or_else(|_| {
        // Fall back to a heuristic only if metadata fails (rare — Explorer would
        // normally pass a path that resolves). Better than crashing.
        !path.contains('.') || path.ends_with('\\') || path.ends_with('/')
    });
    LaunchPath { path, is_dir, intent }
}

#[tauri::command]
pub fn get_launch_path() -> Option<LaunchPath> {
    let args: Vec<String> = std::env::args().collect();
    parse_launch_path_from_args(&args).map(|(p, i)| classify_launch_path(p, i))
}
