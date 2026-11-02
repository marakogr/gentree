fn main() {
    // See the desktop build script: icon changes must re-run `tauri_build` so
    // the Windows executable gets the new resource.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
