fn main() {
    // `tauri_build` embeds `icons/icon.ico` into the Windows executable, but it
    // only watches the Tauri config. Watch the icon directory ourselves so a
    // new icon re-runs the build script and is actually linked into the exe.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
