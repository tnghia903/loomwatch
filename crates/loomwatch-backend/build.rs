fn main() {
    // `rust-embed` reads Vite's output at compile time. Make Cargo rebuild the daemon whenever
    // that output changes, including CSS-only fixes that otherwise leave a stale embedded UI.
    println!("cargo:rerun-if-changed=../../ui/dist");
}
