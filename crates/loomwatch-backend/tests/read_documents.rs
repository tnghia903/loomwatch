//! The daemon reads each file an agent opens in a copy of itself, `loomwatchd read-document`, so a
//! damaged file costs only that copy. These drive the real program, as the daemon does.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine as _;
use loomwatch_backend::documents::{self, Document};

const DAEMON: &str = env!("CARGO_BIN_EXE_loomwatchd");

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("loomwatch-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// One page of Helvetica text, or a page with none when `text` is empty.
fn pdf(text: &str) -> Vec<u8> {
    let stream = if text.is_empty() {
        String::new()
    } else {
        format!("BT /F1 18 Tf 50 700 Td ({text}) Tj ET")
    };
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).bytes());
    }
    let xref = bytes.len();
    bytes.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        bytes.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    bytes.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    bytes
}

fn printed(path: &Path) -> serde_json::Value {
    let output = Command::new(DAEMON)
        .arg("read-document")
        .arg(path)
        .output()
        .expect("loomwatchd runs");
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("one line of JSON")
}

#[test]
fn read_document_prints_the_file_read_as_json() {
    let folder = Folder::new();
    let memo = folder.0.join("memo.pdf");
    fs::write(&memo, pdf("Quarterly revenue rose")).unwrap();
    assert_eq!(
        printed(&memo),
        serde_json::json!({"read": {"kind": "text", "text": "Quarterly revenue rose"}})
    );
    let scan = folder.0.join("scan.pdf");
    fs::write(&scan, pdf("")).unwrap();
    let refused = printed(&scan);
    assert!(
        refused["refused"]
            .as_str()
            .is_some_and(|said| said.contains("probably scanned pages")),
        "{refused}"
    );
}

/// The whole way an agent's file goes: handed to the program, read there, and back, a picture's
/// bytes intact.
#[test]
fn the_daemon_reads_files_in_a_copy_of_itself() {
    let folder = Folder::new();
    let memo = folder.0.join("memo.pdf");
    fs::write(&memo, pdf("Quarterly revenue rose")).unwrap();
    // Read by the program named, not here: a program that isn't there reads nothing.
    documents::use_helper(folder.0.join("no-such-program"));
    let said = documents::read(&memo).unwrap_err();
    assert!(said.starts_with("memo.pdf couldn't be read"), "{said}");
    documents::use_helper(PathBuf::from(DAEMON));
    assert_eq!(
        documents::read(&memo),
        Ok(Document::Text {
            text: "Quarterly revenue rose".to_owned()
        })
    );

    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        40,
        20,
        image::Rgb([20, 120, 220]),
    ))
    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
    .unwrap();
    let shot = folder.0.join("shot.png");
    fs::write(&shot, &png).unwrap();
    let Ok(Document::Picture(picture)) = documents::read(&shot) else {
        panic!("a picture");
    };
    assert_eq!((picture.width, picture.height), (40, 20));
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&picture.data)
            .unwrap(),
        png
    );

    let broken = folder.0.join("broken.docx");
    fs::write(&broken, b"not a zip").unwrap();
    let said = documents::read(&broken).unwrap_err();
    assert!(
        said.contains("isn't a Word file LoomWatch can open"),
        "{said}"
    );
}
