use base64::Engine as _;

use super::excel::{column_name, number_text};
use super::office::heading_level;
use super::*;
use crate::test_support::{docx, fake_program, minimal_pdf, png, zip_of};

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("loomwatch-documents-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn text_of(path: &Path) -> String {
    match read_here(path) {
        Ok(Document::Text { text }) => text,
        other => panic!("{other:?}"),
    }
}

fn picture_of(path: &Path) -> Picture {
    match read_here(path) {
        Ok(Document::Picture(picture)) => picture,
        other => panic!("{other:?}"),
    }
}

fn refusal(path: &Path) -> String {
    read_here(path).expect_err("refused")
}

fn bytes_of(picture: &Picture) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(&picture.data)
        .unwrap()
}

#[test]
fn kinds_come_from_the_extension_or_the_first_bytes() {
    let folder = Folder::new();
    assert_eq!(Kind::of(Path::new("Report.PDF")), Some(Kind::Pdf));
    assert_eq!(Kind::of(Path::new("plan.docx")), Some(Kind::Word));
    assert_eq!(Kind::of(Path::new("budget.xls")), Some(Kind::Excel));
    assert_eq!(Kind::of(Path::new("deck.pptx")), Some(Kind::PowerPoint));
    assert_eq!(Kind::of(Path::new("shot.jpeg")), Some(Kind::Picture));
    assert_eq!(Kind::of(Path::new("old.doc")), Some(Kind::OldOffice));
    assert_eq!(Kind::of(Path::new("IMG_0001.HEIC")), Some(Kind::Heic));
    assert_eq!(Kind::of(Path::new("Rent for March.eml")), Some(Kind::Email));
    let unnamed_pdf = folder.file("scan", &minimal_pdf(&["x"]));
    assert_eq!(Kind::of(&unnamed_pdf), Some(Kind::Pdf));
    let unnamed_png = folder.file("shot", &png(2, 2, false));
    assert_eq!(Kind::of(&unnamed_png), Some(Kind::Picture));
    let notes = folder.file("notes.md", b"# Notes");
    assert_eq!(Kind::of(&notes), None);
}

#[test]
fn a_pdf_reads_as_its_text_page_by_page() {
    let folder = Folder::new();
    let one = folder.file("memo.pdf", &minimal_pdf(&["Quarterly revenue rose"]));
    assert_eq!(text_of(&one), "Quarterly revenue rose");

    let three = folder.file("report.pdf", &minimal_pdf(&["First page", "", "Last page"]));
    assert_eq!(
        text_of(&three),
        "— Page 1 of 3 —\nFirst page\n\n— Page 2 of 3 —\n(No text on this page: it may be a \
         scanned picture.)\n\n— Page 3 of 3 —\nLast page"
    );
}

#[test]
fn a_scanned_or_broken_pdf_is_said_plainly() {
    let folder = Folder::new();
    let scanned = folder.file("scan.pdf", &minimal_pdf(&["", ""]));
    let said = refusal(&scanned);
    assert!(said.contains("scan.pdf has no text in it"), "{said}");
    assert!(said.contains("probably scanned pages"), "{said}");

    let broken = folder.file("broken.pdf", b"%PDF-1.4\nnot really");
    let said = refusal(&broken);
    assert!(
        said.starts_with("broken.pdf couldn't be read as a PDF"),
        "{said}"
    );
}

/// `memo` locked: opening it needs `user_password`; an empty one locks only printing and copying.
fn locked_pdf(user_password: &str) -> Vec<u8> {
    let mut document =
        pdf_extract::Document::load_mem(&minimal_pdf(&["Quarterly revenue rose"])).unwrap();
    document.trailer.set(
        "ID",
        pdf_extract::Object::Array(vec![
            pdf_extract::Object::string_literal("0123456789abcdef"),
            pdf_extract::Object::string_literal("0123456789abcdef"),
        ]),
    );
    let state = pdf_extract::EncryptionState::try_from(pdf_extract::EncryptionVersion::V2 {
        document: &document,
        owner_password: "owner",
        user_password,
        key_length: 128,
        permissions: pdf_extract::Permissions::PRINTABLE,
    })
    .unwrap();
    document.encrypt(&state).unwrap();
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn a_pdf_locked_with_a_password_is_said_plainly_and_one_locked_for_copying_reads() {
    let folder = Folder::new();
    let locked = folder.file("locked.pdf", &locked_pdf("secret"));
    let said = refusal(&locked);
    assert!(
        said.starts_with("locked.pdf is locked with a password"),
        "{said}"
    );
    let restricted = folder.file("restricted.pdf", &locked_pdf(""));
    assert_eq!(text_of(&restricted), "Quarterly revenue rose");
}

#[test]
fn a_word_file_keeps_headings_lists_tables_and_text_boxes_once() {
    let folder = Folder::new();
    let body = r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Trip plan</w:t></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Leave </w:t></w:r><w:r><w:t>Friday</w:t></w:r><w:r><w:tab/><w:t>early</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Passports</w:t></w:r></w:p><w:p><w:r><w:t>Old</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:t xml:space="preserve"> &amp; new</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Place</w:t></w:r></w:p><w:p><w:r><w:t>(city)</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Hu&#233;</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Boxed note</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Boxed note</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent><w:t>After the box</w:t></w:r></w:p>"#;
    let file = folder.file("trip.docx", &docx(body));
    assert_eq!(
        text_of(&file),
        "# Trip plan\nLeave Friday\tearly\n- Passports\nOld & new\nDay\tPlace (city)\n1\tHué\nBoxed \
         note\nAfter the box"
    );
}

const SHEET_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_RELS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn xlsx() -> Vec<u8> {
    let workbook = format!(
        r#"<workbook xmlns="{SHEET_NS}" xmlns:r="{DOC_RELS}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>"#
    );
    let rels = format!(
        r#"<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_RELS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{DOC_RELS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="{DOC_RELS}/styles" Target="styles.xml"/></Relationships>"#
    );
    let styles = format!(
        r#"<styleSheet xmlns="{SHEET_NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>"#
    );
    let budget = format!(
        r#"<worksheet xmlns="{SHEET_NS}"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Item</t></is></c><c r="C2" t="inlineStr"><is><t>Cost</t></is></c><c r="D2" t="inlineStr"><is><t>Paid on</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>Rent &amp; fees</t></is></c><c r="C3"><v>1200.5</v></c><c r="D3" s="1"><v>46314</v></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>Share</t></is></c><c r="C4"><f>C3*0</f><v>0.30000000000000004</v></c><c r="D4" t="b"><v>1</v></c></row></sheetData></worksheet>"#
    );
    let empty = format!(r#"<worksheet xmlns="{SHEET_NS}"><sheetData/></worksheet>"#);
    let package = format!(
        r#"<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
    );
    zip_of(&[
        ("_rels/.rels", &package),
        ("xl/workbook.xml", &workbook),
        ("xl/_rels/workbook.xml.rels", &rels),
        ("xl/styles.xml", &styles),
        ("xl/worksheets/sheet1.xml", &budget),
        ("xl/worksheets/sheet2.xml", &empty),
    ])
}

#[test]
fn an_excel_file_reads_sheet_by_sheet_as_excel_shows_it() {
    let folder = Folder::new();
    let file = folder.file("budget.xlsx", &xlsx());
    assert_eq!(
        text_of(&file),
        "Sheet 1 of 2: Budget (3 rows, 3 columns, from cell B2)\nItem\tCost\tPaid on\nRent & \
         fees\t1200.5\t2026-10-19\nShare\t0.3\tTRUE\n\nSheet 2 of 2: Empty (empty)"
    );
}

const SLIDE_NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn shape(placeholder: &str, paragraphs: &str) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr><p:txBody>{paragraphs}</p:txBody></p:sp>"#
    )
}

fn pptx() -> Vec<u8> {
    let presentation = format!(
        r#"<p:presentation {SLIDE_NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>"#
    );
    let rels = format!(
        r#"<Relationships xmlns="{RELS_NS}"><Relationship Id="rId2" Type="{DOC_RELS}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="{DOC_RELS}/slide" Target="slides/slide2.xml"/></Relationships>"#
    );
    let first_shown = format!(
        "<p:sld {SLIDE_NS}><p:cSld><p:spTree>{}{}</p:spTree></p:cSld></p:sld>",
        shape(
            r#"<p:ph type="title"/>"#,
            "<a:p><a:r><a:t>Plan for 2027</a:t></a:r></a:p>"
        ),
        shape(
            r#"<p:ph idx="1"/>"#,
            "<a:p><a:r><a:t>Hire two people</a:t></a:r></a:p><a:p><a:r><a:t>Open in Hanoi</a:t></a:r><a:br/><a:r><a:t>then Da Nang</a:t></a:r></a:p>"
        )
    );
    let first_rels = format!(
        r#"<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_RELS}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>"#
    );
    let notes = format!(
        "<p:notes {SLIDE_NS}><p:cSld><p:spTree>{}{}{}</p:spTree></p:cSld></p:notes>",
        shape(r#"<p:ph type="sldImg"/>"#, ""),
        shape(
            r#"<p:ph type="body" idx="1"/>"#,
            "<a:p><a:r><a:t>Say the numbers slowly.</a:t></a:r></a:p>"
        ),
        shape(
            r#"<p:ph type="sldNum" idx="5"/>"#,
            r#"<a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p>"#
        )
    );
    let hidden_table = format!(
        r#"<p:sld {SLIDE_NS} show="0"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Budget</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>$40k</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>"#
    );
    zip_of(&[
        ("ppt/presentation.xml", &presentation),
        ("ppt/_rels/presentation.xml.rels", &rels),
        ("ppt/slides/slide1.xml", &hidden_table),
        ("ppt/slides/slide2.xml", &first_shown),
        ("ppt/slides/_rels/slide2.xml.rels", &first_rels),
        ("ppt/notesSlides/notesSlide1.xml", &notes),
    ])
}

#[test]
fn a_powerpoint_file_reads_slide_by_slide_in_the_order_shown_with_its_notes() {
    let folder = Folder::new();
    let file = folder.file("plan.pptx", &pptx());
    assert_eq!(
        text_of(&file),
        "Slide 1 of 2\nPlan for 2027\nHire two people\nOpen in Hanoi\nthen Da Nang\nNotes:\nSay the \
         numbers slowly.\n\nSlide 2 of 2 (hidden)\nBudget\t$40k"
    );
}

#[test]
fn old_office_files_heic_photos_and_other_files_are_said_plainly() {
    let folder = Folder::new();
    let old = folder.file("minutes.doc", b"\xd0\xcf\x11\xe0");
    assert!(refusal(&old).contains("save it as a .docx or .pptx file"));
    let heic = folder.file("IMG_0042.heic", b"....ftypheic");
    assert!(refusal(&heic).contains("save it as a JPEG"));
    let notes = folder.file("notes.md", b"# Notes");
    assert!(refusal(&notes).contains("isn't a document or a picture"));
    let not_a_zip = folder.file("fake.docx", b"plain text");
    assert!(refusal(&not_a_zip).contains("isn't a Word file LoomWatch can open"));
}

#[test]
fn a_picture_that_fits_goes_as_it_is() {
    let folder = Folder::new();
    let bytes = png(40, 20, false);
    let file = folder.file("shot.png", &bytes);
    let picture = picture_of(&file);
    assert_eq!(
        (picture.format.as_str(), picture.media_type.as_str()),
        ("PNG", "image/png")
    );
    assert_eq!((picture.width, picture.height), (40, 20));
    assert_eq!(bytes_of(&picture), bytes, "not written again");
}

#[test]
fn a_larger_picture_is_shrunk_to_the_longest_side_a_model_takes() {
    let folder = Folder::new();
    let wide = folder.file("panorama.png", &png(3000, 100, false));
    let picture = picture_of(&wide);
    assert_eq!((picture.width, picture.height), (PICTURE_LONG_SIDE, 86));
    assert_eq!(
        (picture.original_width, picture.original_height),
        (3000, 100)
    );
    assert_eq!(
        picture.media_type, "image/jpeg",
        "a photo is written as JPEG"
    );
    let decoded = image::load_from_memory(&bytes_of(&picture)).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (PICTURE_LONG_SIDE, 86));

    let see_through = folder.file("logo.png", &png(3000, 100, true));
    let picture = picture_of(&see_through);
    assert_eq!(picture.media_type, "image/png", "see-through parts stay");
    assert!(
        image::load_from_memory(&bytes_of(&picture))
            .unwrap()
            .color()
            .has_alpha()
    );
}

/// A JPEG whose EXIF says to turn it a quarter clockwise, as a phone held upright writes it.
fn turned_jpeg(width: u32, height: u32) -> Vec<u8> {
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&image::RgbImage::from_pixel(
            width,
            height,
            image::Rgb([10, 200, 10]),
        ))
        .unwrap();
    let exif: &[u8] = &[
        0xff, 0xe1, 0x00, 0x22, b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0x00, 0x2a, 0, 0, 0, 8,
        0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0x00, 0x06, 0, 0, 0, 0, 0, 0,
    ];
    let mut turned = jpeg[..2].to_vec();
    turned.extend_from_slice(exif);
    turned.extend_from_slice(&jpeg[2..]);
    turned
}

#[test]
fn a_phone_photo_is_turned_the_way_up_it_was_taken() {
    let folder = Folder::new();
    let file = folder.file("photo.jpg", &turned_jpeg(40, 20));
    let picture = picture_of(&file);
    assert_eq!((picture.width, picture.height), (20, 40));
    let decoded = image::load_from_memory(&bytes_of(&picture)).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (20, 40));
}

#[test]
fn text_is_tidied_and_held_to_the_limit() {
    assert_eq!(tidy("  a  \r\n\r\n\r\n\u{c}b\t \n\n"), "  a\n\nb");
    let long = "é".repeat(MAX_TEXT_BYTES);
    let held = within_limit(long, "big.pdf");
    assert!(held.len() < MAX_TEXT_BYTES + 200);
    assert!(
        held.ends_with(
            "The rest of big.pdf is past the 8 MB of text LoomWatch reads from one file."
        )
    );
}

#[test]
fn cells_read_as_excel_shows_them() {
    assert_eq!(number_text(1200.0), "1200");
    assert_eq!(number_text(0.1 + 0.2), "0.3");
    assert_eq!(number_text(-3.25), "-3.25");
    assert_eq!(number_text(1e-20), "1e-20");
    assert_eq!(column_name(0), "A");
    assert_eq!(column_name(25), "Z");
    assert_eq!(column_name(27), "AB");
    assert_eq!(heading_level("Heading3"), 3);
    assert_eq!(heading_level("Title"), 1);
    assert_eq!(heading_level("Normal"), 0);
}

#[test]
fn a_helper_answers_with_the_file_read_or_why_not() {
    let folder = Folder::new();
    let file = folder.file("memo.pdf", b"%PDF-");
    let answering = fake_program(
        &folder.0.join("answers"),
        "#!/bin/sh\nprintf '{\"read\":{\"kind\":\"text\",\"text\":\"Quarterly revenue rose\"}}'\n",
    );
    assert_eq!(
        read_with(&answering, &file, Duration::from_secs(10)),
        Ok(Document::Text {
            text: "Quarterly revenue rose".to_owned()
        })
    );
    let refusing = fake_program(
        &folder.0.join("refuses"),
        "#!/bin/sh\nprintf '{\"refused\":\"memo.pdf has no text in it.\"}'\n",
    );
    assert_eq!(
        read_with(&refusing, &file, Duration::from_secs(10)),
        Err("memo.pdf has no text in it.".to_owned())
    );
    let crashing = fake_program(&folder.0.join("crashes"), "#!/bin/sh\nexit 101\n");
    let said = read_with(&crashing, &file, Duration::from_secs(10)).unwrap_err();
    assert!(
        said.starts_with("memo.pdf couldn't be read: it may be damaged"),
        "{said}"
    );
    let stuck = fake_program(&folder.0.join("stuck"), "#!/bin/sh\nexec sleep 30\n");
    let started = Instant::now();
    let said = read_with(&stuck, &file, Duration::from_millis(300)).unwrap_err();
    assert!(
        said.starts_with("memo.pdf took longer than 30 seconds"),
        "{said}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn the_answer_is_what_the_helper_prints() {
    let folder = Folder::new();
    let file = folder.file("memo.pdf", &minimal_pdf(&["Quarterly revenue rose"]));
    let read: Answer = serde_json::from_str(&answer(&file)).unwrap();
    assert!(
        matches!(read, Answer::Read(Document::Text { ref text }) if text == "Quarterly revenue rose"),
        "{read:?}"
    );
    let missing: Answer = serde_json::from_str(&answer(&folder.0.join("gone.pdf"))).unwrap();
    assert!(matches!(missing, Answer::Refused(_)), "{missing:?}");
}

fn bounded(program: &Path, deadline: Duration, limit: usize) -> Result<Vec<u8>, Stopped> {
    bounded_output(&mut Command::new(program), deadline, limit)
}

/// ADR 0048: a file that keeps its reader busy, or makes it write without end, costs a bounded time
/// and a bounded amount of memory.
#[test]
fn a_reader_is_bounded_in_time_and_size() {
    let folder = Folder::new();
    let script = |name: &str, body: &str| {
        fake_program(&folder.0.join(name), &format!("#!/bin/sh\n{body}\n"))
    };

    let slow = script("slow", "exec sleep 30");
    let started = Instant::now();
    assert_eq!(
        bounded(&slow, Duration::from_millis(300), 1024),
        Err(Stopped::Late)
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );

    let endless = script("endless", "exec yes loomwatch");
    let text = bounded(&endless, Duration::from_secs(10), 1000).expect("text");
    assert_eq!(text.len(), 1000);
    assert!(text.starts_with(b"loomwatch\nloomwatch\n"));

    // More output than the limit, then a failing exit: the output read is still kept, however the
    // exit and the reader's "enough" are ordered.
    let then_fails = script("then-fails", "head -c 4000 /dev/zero | tr '\\0' x; exit 1");
    for _ in 0..20 {
        let text = bounded(&then_fails, Duration::from_secs(10), 1000);
        assert_eq!(text.map(|text| text.len()), Ok(1000));
    }

    let fails = script("fails", "printf 'half'; exit 1");
    assert_eq!(
        bounded(&fails, Duration::from_secs(10), 1000),
        Err(Stopped::Failed)
    );

    let quick = script("quick", "printf 'Quarterly revenue rose'");
    assert_eq!(
        bounded(&quick, Duration::from_secs(10), 1000).as_deref(),
        Ok(&b"Quarterly revenue rose"[..])
    );
}

// Emails ------------------------------------------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A message as Mail writes one to a file: a text and an HTML version of the same words, the text
/// one quoted-printable with soft line breaks and an accented letter.
const RENT_EMAIL: &str = "From: Lan Nguyen <lan@example.com>\r
To: Maya <maya@example.com>, landlord@example.com\r
Cc: Minh Tran <minh@example.com>\r
Date: Sat, 24 Oct 2026 10:31:00 +0700\r
Subject: Rent for March\r
MIME-Version: 1.0\r
Content-Type: multipart/alternative; boundary=\"Apple-Mail=_A1\"\r
\r
--Apple-Mail=_A1\r
Content-Type: text/plain; charset=utf-8\r
Content-Transfer-Encoding: quoted-printable\r
\r
Hi Maya,=0A=0AThe rent for March goes up to 1,450 a month, from the caf=C3=A9 =\r
side of the building.=20\r
\r
Lan\r
--Apple-Mail=_A1\r
Content-Type: text/html; charset=utf-8\r
Content-Transfer-Encoding: quoted-printable\r
\r
<html><body><p>Hi Maya,</p><p>The rent for March goes up to 1,450 a month.</p></body></html>\r
--Apple-Mail=_A1--\r
";

#[test]
fn an_email_reads_as_who_wrote_to_whom_when_its_subject_and_its_words() {
    let folder = Folder::new();
    let text = text_of(&folder.file("Rent for March.eml", RENT_EMAIL.as_bytes()));
    assert!(text.starts_with(
        "From: Lan Nguyen <lan@example.com>\nTo: Maya <maya@example.com>, landlord@example.com\nCc: Minh Tran <minh@example.com>\nDate: Sat, 24 Oct 2026 10:31:00 +0700\nSubject: Rent for March\n\nHi Maya,\n\nThe rent for March goes up to 1,450 a month, from the café side of the building."
    ), "{text}");
    // The words once, from the text version: no codes, no markup, no MIME.
    assert!(
        !text.contains("=20") && !text.contains("=C3") && !text.contains("<p>"),
        "{text}"
    );
    assert!(
        !text.contains("Apple-Mail") && !text.contains("Content-Type"),
        "{text}"
    );
    assert_eq!(text.matches("The rent for March").count(), 1, "{text}");
}

#[test]
fn an_email_in_base64_and_encoded_headers_reads_in_its_own_language() {
    let folder = Folder::new();
    // As Gmail sends Vietnamese: the name and subject as encoded words, the body in base64.
    let body = "Chào anh,\n\nCuộc họp chuyển sang thứ Sáu lúc 9 giờ sáng.\n\nTrân trọng,\nHương";
    let email = format!(
        "From: =?UTF-8?B?{}?= <huong@example.com>\r\nTo: tnghia@example.com\r\nSubject: =?UTF-8?B?{}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        b64("Phạm Thu Hương".as_bytes()),
        b64("Lịch họp tuần sau".as_bytes()),
        b64(body.as_bytes())
    );
    let text = text_of(&folder.file("Lich hop.eml", email.as_bytes()));
    assert!(
        text.contains("From: Phạm Thu Hương <huong@example.com>"),
        "{text}"
    );
    assert!(text.contains("Subject: Lịch họp tuần sau"), "{text}");
    assert!(
        text.contains("Cuộc họp chuyển sang thứ Sáu lúc 9 giờ sáng."),
        "{text}"
    );
    // A Japanese message in Shift_JIS, one of the charsets read through `full_encoding`.
    let japanese = format!(
        "From: tanaka@example.co.jp\r\nSubject: =?ISO-2022-JP?B?{}?=\r\nContent-Type: text/plain; charset=Shift_JIS\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        b64(b"\x1b$BF|K\\8l\x1b(B"),
        b64(b"\x93\xfa\x96\x7b\x8c\xea\x82\xcc\x83\x81\x81\x5b\x83\x8b")
    );
    let text = text_of(&folder.file("Japanese.eml", japanese.as_bytes()));
    assert!(text.contains("Subject: 日本語"), "{text}");
    assert!(text.contains("日本語のメール"), "{text}");
}

#[test]
fn an_html_only_email_reads_as_its_text() {
    let folder = Folder::new();
    let email = "From: news@example.com\r\nSubject: October news\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head><style>p { color: red }</style></head><body><h1>October</h1><p>Our office moves to <b>12 Lake Road</b>.</p><ul><li>Parking is free</li></ul></body></html>\r\n";
    let text = text_of(&folder.file("October news.eml", email.as_bytes()));
    assert!(text.contains("Our office moves to 12 Lake Road."), "{text}");
    assert!(text.contains("Parking is free"), "{text}");
    assert!(
        !text.contains('<') && !text.contains("color: red"),
        "{text}"
    );
}

#[test]
fn an_email_names_its_attachments_and_reads_a_forwarded_message_in_its_place() {
    let folder = Folder::new();
    let pdf = minimal_pdf(&["Invoice 2041: 1,450"]);
    let forwarded = "From: landlord@example.com\r\nTo: lan@example.com\r\nSubject: New rent\r\nContent-Type: text/plain\r\n\r\nFrom March the rent is 1,450.\r\n";
    let email = format!(
        "From: lan@example.com\r\nTo: maya@example.com\r\nSubject: Fwd: New rent\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nSee below, and the invoice.\r\n--b1\r\nContent-Type: application/pdf; name=\"Invoice 2041.pdf\"\r\nContent-Disposition: attachment; filename=\"Invoice 2041.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--b1\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\n\r\n{forwarded}--b1\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--b1--\r\n",
        b64(&pdf),
        b64(&png(2, 2, false))
    );
    let text = text_of(&folder.file("Fwd New rent.eml", email.as_bytes()));
    assert!(text.contains("See below, and the invoice."), "{text}");
    // The forwarded message, read where it was attached.
    assert!(text.contains("--- Attached message ---\nFrom: landlord@example.com\nTo: lan@example.com\nSubject: New rent\n\nFrom March the rent is 1,450.\n--- End of attached message ---"), "{text}");
    // The PDF named, with its size, and not read; the unnamed picture in the words not listed.
    assert!(text.contains("Attached files (named here; their contents aren't part of this text):\n- Invoice 2041.pdf ("), "{text}");
    assert!(
        !text.contains("Invoice 2041: 1,450") && !text.contains("JVBER"),
        "{text}"
    );
    assert_eq!(text.matches("\n- ").count(), 1, "{text}");
}

#[test]
fn a_file_named_eml_that_isnt_an_email_is_said_plainly() {
    let folder = Folder::new();
    let damaged = folder.file("broken.eml", &[0xff, 0xfe, 0x00, 0x01]);
    assert_eq!(
        refusal(&damaged),
        "broken.eml isn't an email LoomWatch can read: it may be damaged."
    );
}
