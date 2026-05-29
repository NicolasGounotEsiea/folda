/// Windows shell integration — registers / unregisters "Open with nxs" context
/// menu entries in HKCU so no admin rights are required.
use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

const APP_NAME: &str = "nxs";
const FILE_LABEL: &str = "Open with nxs";
const DIR_LABEL: &str = "Open folder in nxs";
const DIR_BG_LABEL: &str = "Open here in nxs";

fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

fn write_shell_entry(
    hkcu: &RegKey,
    base: &str,
    label: &str,
    exe: &str,
    arg_placeholder: &str,
) -> Result<(), String> {
    let shell_key = format!(r"{}\shell\{}", base, APP_NAME);
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
    cmd.set_value("", &format!(r#""{}" "--path" "{}""#, exe, arg_placeholder))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_shell_entry(hkcu: &RegKey, base: &str) -> Result<(), String> {
    let cmd_key = format!(r"{}\shell\{}\command", base, APP_NAME);
    let _ = hkcu.delete_subkey(&cmd_key);
    let shell_key = format!(r"{}\shell\{}", base, APP_NAME);
    let _ = hkcu.delete_subkey(&shell_key);
    Ok(())
}

/// Read the exe path embedded in our registered command, if any. Returns None
/// if the key doesn't exist or can't be parsed. Used to detect a stale exe path
/// after an app update so we can silently self-heal.
fn read_registered_exe() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            format!(r"Software\Classes\*\shell\{}\command", APP_NAME),
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

    // Files: *\shell
    write_shell_entry(&hkcu, r"Software\Classes\*", FILE_LABEL, &exe, "%1")?;
    // Directories
    write_shell_entry(&hkcu, r"Software\Classes\Directory", DIR_LABEL, &exe, "%1")?;
    // Directory background (right-click on empty space in a folder)
    write_shell_entry(&hkcu, r"Software\Classes\Directory\Background", DIR_BG_LABEL, &exe, "%V")?;

    notify_shell_change();
    Ok(())
}

#[tauri::command]
pub fn unregister_shell_extension() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    delete_shell_entry(&hkcu, r"Software\Classes\*")?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory")?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory\Background")?;
    notify_shell_change();
    Ok(())
}

#[tauri::command]
pub fn is_shell_extension_registered() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(
        format!(r"Software\Classes\*\shell\{}", APP_NAME),
        KEY_READ,
    )
    .is_ok()
}

/// Called once on app startup. If the user previously opted in to shell
/// integration and the binary has since moved (e.g. after an app update), the
/// registry still points at the old path. Detect this and silently re-register
/// against the current binary so the context menu keeps working without forcing
/// the user back into Settings.
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
    if needs_update {
        let _ = register_shell_extension();
    }
}

// ── Launch-path parsing ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LaunchPath {
    pub path: String,
    pub is_dir: bool,
}

/// Parse the path argument out of a process argv. Reused for the initial
/// launch and for `tauri-plugin-single-instance` callbacks when another nxs.exe
/// is launched while this one is already running.
///
/// Recognized forms:
///   nxs.exe --path "C:\some\path"
///   nxs.exe "C:\some\path"           (bare path arg, must contain a separator)
pub fn parse_launch_path_from_args(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--path" {
            return iter.next().cloned();
        }
    }
    // Bare-path fallback: argv[1] looks like a filesystem path.
    if args.len() == 2 {
        let candidate = &args[1];
        if !candidate.starts_with("--") && (candidate.contains('\\') || candidate.contains('/')) {
            return Some(candidate.clone());
        }
    }
    None
}

/// Turn a raw path into a `LaunchPath` with reliable is_dir via `fs::metadata`
/// instead of the brittle string heuristic that used to live in the frontend.
pub fn classify_launch_path(path: String) -> LaunchPath {
    let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or_else(|_| {
        // Fall back to a heuristic only if metadata fails (rare — Explorer would
        // normally pass a path that resolves). Better than crashing.
        !path.contains('.') || path.ends_with('\\') || path.ends_with('/')
    });
    LaunchPath { path, is_dir }
}

#[tauri::command]
pub fn get_launch_path() -> Option<LaunchPath> {
    let args: Vec<String> = std::env::args().collect();
    parse_launch_path_from_args(&args).map(classify_launch_path)
}
