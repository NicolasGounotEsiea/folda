/// Windows shell integration — registers / unregisters "Open with nxs" context
/// menu entries in HKCU so no admin rights are required.
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

    Ok(())
}

#[tauri::command]
pub fn unregister_shell_extension() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    delete_shell_entry(&hkcu, r"Software\Classes\*")?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory")?;
    delete_shell_entry(&hkcu, r"Software\Classes\Directory\Background")?;
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

/// Returns the `--path` argument passed on the command line (from shell context
/// menu), if any.  Called once by the frontend on startup.
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == "--path" {
            return iter.next().cloned();
        }
    }
    // Also handle a bare path argument (single arg that looks like a path)
    if args.len() == 2 {
        let candidate = &args[1];
        if !candidate.starts_with("--") && (candidate.contains('\\') || candidate.contains('/')) {
            return Some(candidate.clone());
        }
    }
    None
}
