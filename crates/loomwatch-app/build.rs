//! Gives `LoomWatch.exe` its icon and version details when it is built for Windows: what the Start
//! menu, the taskbar, File Explorer and the notification area show. Nothing to do elsewhere.

fn main() {
    println!("cargo:rerun-if-changed=../../packaging/windows/LoomWatch.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut resource = winresource::WindowsResource::new();
    // Resource 1, which the notification-area icon is loaded from too (`windows::tray_icon`).
    resource
        .set_icon("../../packaging/windows/LoomWatch.ico")
        .set("ProductName", "LoomWatch")
        .set("FileDescription", "LoomWatch")
        .set("CompanyName", "LoomWatch")
        .set("LegalCopyright", "MIT OR Apache-2.0");
    // rc.exe comes with the Windows SDK that Rust's MSVC toolchain needs anyway; windres with
    // MinGW, for a build made elsewhere.
    resource
        .compile()
        .unwrap_or_else(|error| panic!("couldn't give LoomWatch.exe its icon: {error}"));
}
