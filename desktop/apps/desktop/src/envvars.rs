//! Environment lookups for settings that are read on every request.
//!
//! The process environment is frozen when the application starts, but users
//! often add `GENTREE_CHAT_API_KEY` (or rename the variable) in Windows while
//! the app is already open. Falling back to the Windows user/machine registry
//! makes the new value visible without restarting the whole application; the
//! process environment still wins, so an explicitly exported value is never
//! overridden.

/// Value of `name`, trimmed, or `None` when it is unset/blank.
pub fn value(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let from_process = std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if from_process.is_some() {
        return from_process;
    }
    windows_value(name)
}

#[cfg(windows)]
fn windows_value(name: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ)
        .ok()
        .and_then(|key| key.get_value::<String, _>(name).ok());
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            KEY_READ,
        )
        .ok()
        .and_then(|key| key.get_value::<String, _>(name).ok());
    user.or(machine)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(not(windows))]
fn windows_value(_name: &str) -> Option<String> {
    None
}
