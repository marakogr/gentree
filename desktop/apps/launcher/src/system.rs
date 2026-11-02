//! Interaction with the installed Gentree: version, running state, launching.

use std::path::PathBuf;
use std::process::Command;

use crate::error::{codes, LauncherError};

/// What the OS knows about the installed Gentree.
#[derive(Debug, Clone, Default)]
pub struct InstalledApp {
    pub version: Option<String>,
    /// Executable on Windows, application bundle on macOS.
    pub launch_path: Option<PathBuf>,
}

/// Reads the installed version from the Windows uninstall registry or the
/// macOS bundle metadata.
pub fn installed_app() -> Option<InstalledApp> {
    platform_installed_app()
}

pub fn installed_version() -> Option<String> {
    installed_app().and_then(|app| app.version)
}

/// Launches the installed app, or reports `not_installed`.
pub fn open_installed() -> Result<(), LauncherError> {
    let app = installed_app().ok_or_else(|| LauncherError::new(codes::NOT_INSTALLED))?;
    let path = app
        .launch_path
        .filter(|path| path.exists())
        .ok_or_else(|| LauncherError::new(codes::NOT_INSTALLED))?;
    launch(&path)
}

/// Checks whether Gentree itself (not the launcher) is running.
pub fn gentree_running() -> Result<bool, LauncherError> {
    platform_gentree_running()
}

fn launch(path: &std::path::Path) -> Result<(), LauncherError> {
    #[cfg(target_os = "windows")]
    {
        Command::new(path)
            .spawn()
            .map(|_| ())
            .map_err(|_| LauncherError::new(codes::OPEN_FAILED))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|_| LauncherError::new(codes::OPEN_FAILED))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err(LauncherError::new(codes::UNSUPPORTED_PLATFORM))
    }
}

#[cfg(any(test, target_os = "windows"))]
/// Removes the `,0` icon index and surrounding quotes from a registry
/// `DisplayIcon` value (`"C:\Programs\Gentree\Gentree.exe",0`).
pub fn strip_icon_index(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            text = &rest[..end];
        }
    }
    if let Some((path, suffix)) = text.rsplit_once(',') {
        let suffix = suffix.trim();
        if !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            text = path.trim();
        }
    }
    text.trim().to_string()
}

#[cfg(any(test, target_os = "macos"))]
/// Reads a `<key>Name</key><string>value</string>` pair from an Info.plist.
pub fn parse_plist_string(plist: &str, key: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let after_key = &plist[plist.find(&needle)? + needle.len()..];
    let value_start = after_key.find("<string>")? + "<string>".len();
    let value_end = after_key[value_start..].find("</string>")?;
    Some(
        after_key[value_start..value_start + value_end]
            .trim()
            .to_string(),
    )
}

#[cfg(any(test, target_os = "windows"))]
/// Whether `tasklist /FO CSV` output names a running `Gentree.exe`.
pub fn parse_tasklist(output: &str) -> bool {
    output.lines().any(|line| {
        line.trim()
            .split(',')
            .next()
            .map(|field| {
                field
                    .trim()
                    .trim_matches('"')
                    .eq_ignore_ascii_case("Gentree.exe")
            })
            .unwrap_or(false)
    })
}

#[cfg(any(test, target_os = "macos"))]
/// Interprets `pgrep -x Gentree`: exit 0 means running, exit 1 means not.
pub fn parse_pgrep_exit_code(code: Option<i32>) -> Option<bool> {
    match code {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn platform_installed_app() -> Option<InstalledApp> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const WOW: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    for (root, subkey) in [
        (HKEY_CURRENT_USER, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL),
        (HKEY_LOCAL_MACHINE, WOW),
    ] {
        if let Some(app) = scan_uninstall(RegKey::predef(root), subkey) {
            return Some(app);
        }
    }

    fallback_install_path().map(|path| InstalledApp {
        version: None,
        launch_path: Some(path),
    })
}

#[cfg(target_os = "windows")]
fn scan_uninstall(root: winreg::RegKey, subkey: &str) -> Option<InstalledApp> {
    use winreg::enums::{KEY_READ, KEY_WOW64_64KEY};

    let key = root
        .open_subkey_with_flags(subkey, KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    for name in key.enum_keys().flatten() {
        let Ok(entry) = key.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        let Ok(display_name) = entry.get_value::<String, _>("DisplayName") else {
            continue;
        };
        // Exact match keeps "Gentree Launcher" out of the result.
        if !display_name.trim().eq_ignore_ascii_case("Gentree") {
            continue;
        }

        let version = entry.get_value::<String, _>("DisplayVersion").ok();
        let icon = entry
            .get_value::<String, _>("DisplayIcon")
            .ok()
            .map(|raw| PathBuf::from(strip_icon_index(&raw)))
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            });
        let location = entry
            .get_value::<String, _>("InstallLocation")
            .ok()
            .map(|raw| PathBuf::from(raw.trim()).join("Gentree.exe"));

        let launch_path = icon
            .filter(|path| path.exists())
            .or_else(|| location.filter(|path| path.exists()))
            .or_else(fallback_install_path);

        return Some(InstalledApp {
            version,
            launch_path,
        });
    }
    None
}

#[cfg(target_os = "windows")]
fn fallback_install_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join(r"Programs\Gentree\Gentree.exe"));
    }
    if let Some(programs) = std::env::var_os("PROGRAMFILES") {
        candidates.push(PathBuf::from(programs).join(r"Gentree\Gentree.exe"));
    }
    candidates.into_iter().find(|path| path.exists())
}

#[cfg(target_os = "windows")]
fn platform_gentree_running() -> Result<bool, LauncherError> {
    use std::os::windows::process::CommandExt;

    /// Keeps the console window hidden while the launcher polls the process list.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Gentree.exe", "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| LauncherError::with_detail(codes::PROCESS_CHECK, "tasklist"))?;
    if !output.status.success() {
        return Err(LauncherError::with_detail(codes::PROCESS_CHECK, "tasklist"));
    }
    Ok(parse_tasklist(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(target_os = "macos")]
fn platform_installed_app() -> Option<InstalledApp> {
    let mut bases = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        bases.push(PathBuf::from(home).join("Applications"));
    }
    for base in bases {
        let bundle = base.join("Gentree.app");
        let plist = bundle.join("Contents").join("Info.plist");
        let Ok(contents) = std::fs::read_to_string(&plist) else {
            continue;
        };
        return Some(InstalledApp {
            version: parse_plist_string(&contents, "CFBundleShortVersionString"),
            launch_path: Some(bundle),
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn platform_gentree_running() -> Result<bool, LauncherError> {
    let status = Command::new("pgrep")
        .args(["-x", "Gentree"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| LauncherError::with_detail(codes::PROCESS_CHECK, "pgrep"))?;
    parse_pgrep_exit_code(status.code())
        .ok_or_else(|| LauncherError::with_detail(codes::PROCESS_CHECK, "pgrep"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_installed_app() -> Option<InstalledApp> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_gentree_running() -> Result<bool, LauncherError> {
    Err(LauncherError::new(codes::UNSUPPORTED_PLATFORM))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_registry_icon_index() {
        assert_eq!(
            strip_icon_index(r#""C:\Programs\Gentree\Gentree.exe",0"#),
            r"C:\Programs\Gentree\Gentree.exe"
        );
        assert_eq!(
            strip_icon_index(r"C:\Programs\Gentree\Gentree.exe,1"),
            r"C:\Programs\Gentree\Gentree.exe"
        );
        assert_eq!(
            strip_icon_index(r"C:\Programs\Gentree\Gentree.exe"),
            r"C:\Programs\Gentree\Gentree.exe"
        );
    }

    #[test]
    fn reads_a_plist_string() {
        let plist = r#"<?xml version="1.0"?>
<plist><dict>
  <key>CFBundleName</key><string>Gentree</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.1</string>
</dict></plist>"#;

        assert_eq!(
            parse_plist_string(plist, "CFBundleShortVersionString"),
            Some("0.2.1".to_string())
        );
        assert_eq!(parse_plist_string(plist, "CFBundleVersion"), None);
    }

    #[test]
    fn detects_gentree_in_tasklist_output() {
        assert!(parse_tasklist(
            "\"Gentree.exe\",\"1234\",\"Console\",\"1\",\"10,000 K\"\r\n"
        ));
        assert!(!parse_tasklist(
            "INFO: No tasks are running which match the specified criteria.\r\n"
        ));
        assert!(!parse_tasklist(
            "\"Gentree Launcher.exe\",\"1\",\"Console\",\"1\",\"1 K\""
        ));
        assert!(!parse_tasklist(""));
    }

    #[test]
    fn interprets_pgrep_exit_codes() {
        assert_eq!(parse_pgrep_exit_code(Some(0)), Some(true));
        assert_eq!(parse_pgrep_exit_code(Some(1)), Some(false));
        assert_eq!(parse_pgrep_exit_code(Some(2)), None);
        assert_eq!(parse_pgrep_exit_code(None), None);
    }
}
