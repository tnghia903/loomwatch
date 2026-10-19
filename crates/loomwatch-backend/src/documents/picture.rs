//! Pictures a model is sent: as they are when they fit, else turned upright and shrunk.

use std::fs;
use std::io::Cursor;
use std::path::Path;

use base64::Engine as _;
use image::ImageDecoder as _;

use super::{MAX_PICTURE_FILE_BYTES, PICTURE_LONG_SIDE, PICTURE_MAX_BYTES, Picture};

/// The sharpest a shrunk photo is written, as JPEG quality.
const JPEG_QUALITY: u8 = 90;

pub(super) fn read(path: &Path, name: &str, size: u64) -> Result<Picture, String> {
    if size > MAX_PICTURE_FILE_BYTES {
        return Err(format!(
            "{name} is {} MB, more than the {} MB LoomWatch opens for a picture.",
            size / 1024 / 1024,
            MAX_PICTURE_FILE_BYTES / 1024 / 1024
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("{name} couldn't be read: {error}"))?;
    let unreadable = || format!("{name} couldn't be opened as a picture: it may be damaged.");
    let mut reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| unreadable())?;
    let (format, media_type) = match reader.format() {
        Some(image::ImageFormat::Png) => ("PNG", "image/png"),
        Some(image::ImageFormat::Jpeg) => ("JPEG", "image/jpeg"),
        Some(image::ImageFormat::Gif) => ("GIF", "image/gif"),
        Some(image::ImageFormat::WebP) => ("WebP", "image/webp"),
        _ => {
            return Err(format!(
                "{name} isn't a picture in a format a model takes: PNG, JPEG, GIF or WebP."
            ));
        }
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(40_000);
    limits.max_image_height = Some(40_000);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| unreadable())?;
    let (width, height) = decoder.dimensions();
    // A phone stores a photo as the camera saw it and says which way up it goes.
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let upright = orientation == image::metadata::Orientation::NoTransforms;
    if upright && width.max(height) <= PICTURE_LONG_SIDE && bytes.len() <= PICTURE_MAX_BYTES {
        return Ok(Picture {
            format: format.to_owned(),
            media_type: media_type.to_owned(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            width,
            height,
            original_width: width,
            original_height: height,
        });
    }
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| unreadable())?;
    image.apply_orientation(orientation);
    let (original_width, original_height) = (image.width(), image.height());
    if image.width().max(image.height()) > PICTURE_LONG_SIDE {
        image = image.resize(
            PICTURE_LONG_SIDE,
            PICTURE_LONG_SIDE,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let (format, media_type, encoded) = encoded(&image).ok_or_else(unreadable)?;
    Ok(Picture {
        format: format.to_owned(),
        media_type: media_type.to_owned(),
        data: base64::engine::general_purpose::STANDARD.encode(&encoded),
        width: image.width(),
        height: image.height(),
        original_width,
        original_height,
    })
}

/// A shrunk or turned picture written again: PNG when it has see-through parts and that is small
/// enough, else JPEG, see-through parts on white.
fn encoded(image: &image::DynamicImage) -> Option<(&'static str, &'static str, Vec<u8>)> {
    if image.color().has_alpha() {
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        if png.len() <= PICTURE_MAX_BYTES {
            return Some(("PNG", "image/png", png));
        }
    }
    let mut rgb = image::RgbImage::new(image.width(), image.height());
    for (x, y, pixel) in image.to_rgba8().enumerate_pixels() {
        let [red, green, blue, alpha] = pixel.0;
        let over_white = |channel: u8| {
            let mixed =
                (u32::from(channel) * u32::from(alpha) + 255 * (255 - u32::from(alpha))) / 255;
            u8::try_from(mixed).unwrap_or(u8::MAX)
        };
        rgb.put_pixel(
            x,
            y,
            image::Rgb([over_white(red), over_white(green), over_white(blue)]),
        );
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)
        .ok()?;
    Some(("JPEG", "image/jpeg", jpeg))
}
