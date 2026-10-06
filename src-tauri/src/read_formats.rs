//! What the `read` tool makes of files that are not plain text: pictures,
//! PDFs and Jupyter notebooks.
//!
//! A picture is the one tool result a model gets to see: it is stored with the
//! result like a `screenshot`'s, and the history hands it to the model in a
//! note after the results of that step (see `agent::stored_history`). A PDF
//! and a notebook are turned into text, which every model reads and which
//! costs far less than their pages as pictures.

use crate::models::Attachment;
use base64::Engine;
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

/// Largest picture handed to a model, in bytes. Model servers refuse more.
pub const MAX_PICTURE_BYTES: usize = 5 * 1024 * 1024;
/// Largest PDF whose text is extracted, in bytes.
pub const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
/// Pages of a PDF one call returns when it names none.
pub const DEFAULT_PDF_PAGES: usize = 10;
/// Longest output of one notebook cell that is shown, in bytes.
const MAX_CELL_OUTPUT_BYTES: usize = 2_000;

#[derive(Debug, PartialEq)]
pub enum Format {
    /// A picture models take, with its media type.
    Picture(&'static str),
    Pdf,
    Notebook,
    Other,
}

/// What kind of file `read` was given. Pictures and PDFs are told by how
/// their content starts, since that is what a model server checks too.
pub fn format_of(path: &Path, bytes: &[u8]) -> Format {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Format::Picture("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Format::Picture("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Format::Picture("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Format::Picture("image/webp");
    }
    if bytes.starts_with(b"%PDF-") {
        return Format::Pdf;
    }
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
    match extension.as_deref() {
        Some("ipynb") => Format::Notebook,
        _ => Format::Other,
    }
}

/// The picture as an attachment of the tool result.
pub fn picture(name: &str, mime_type: &str, bytes: &[u8]) -> Attachment {
    Attachment {
        id: Uuid::new_v4().to_string(),
        name: name.chars().take(200).collect(),
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
        kind: "image".to_string(),
        lines: None,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

/// The text of each page of a PDF. The parser gives up on some files by
/// panicking, which is reported like any other failure.
pub fn pdf_pages(bytes: &[u8]) -> Result<Vec<String>, String> {
    match std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes)) {
        Ok(Ok(pages)) => Ok(pages),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("its structure could not be parsed".to_string()),
    }
}

/// The pages a `pages` argument names (`"3"`, `"2-5"`, `"1,4-6"`), 1-based
/// and in ascending order, for a document of `total` pages.
pub fn page_selection(spec: &str, total: usize) -> Result<Vec<usize>, String> {
    let invalid = || {
        format!("pages must name pages like \"3\", \"2-5\" or \"1,4-6\"; this document has {total}.")
    };
    let mut pages: Vec<usize> = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|part| !part.is_empty()) {
        let (first, last) = match part.split_once('-') {
            Some((first, last)) => (first.trim(), last.trim()),
            None => (part, part),
        };
        let first: usize = first.parse().map_err(|_| invalid())?;
        let last: usize = last.parse().map_err(|_| invalid())?;
        if first == 0 || last < first {
            return Err(invalid());
        }
        pages.extend(first..=last.min(total));
    }
    pages.sort_unstable();
    pages.dedup();
    pages.retain(|page| *page <= total);
    if pages.is_empty() {
        return Err(invalid());
    }
    Ok(pages)
}

/// Page numbers as a model would write them: `[1, 2, 3, 7]` is `1-3, 7`.
pub fn page_ranges(pages: &[usize]) -> String {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for page in pages {
        match ranges.last_mut() {
            Some((_, last)) if *last + 1 == *page => *last = *page,
            _ => ranges.push((*page, *page)),
        }
    }
    ranges
        .iter()
        .map(|(first, last)| match first == last {
            true => first.to_string(),
            false => format!("{first}-{last}"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The chosen pages of a PDF as one text, each under a line naming it.
pub fn render_pdf(pages: &[String], chosen: &[usize]) -> String {
    let mut output = String::new();
    for number in chosen {
        let text = pages[number - 1].trim();
        output.push_str(&format!("--- page {number} ---\n"));
        output.push_str(if text.is_empty() { "(no text)" } else { text });
        output.push_str("\n\n");
    }
    output
}

/// A cell's `source` or an output's `text`: one string, or its lines.
fn joined(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(lines)) => lines.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

/// A Jupyter notebook as text: every cell with its number and kind, and what
/// a code cell printed. Pictures among the outputs are counted, not shown.
/// `None` when `content` is not a notebook of the current format.
pub fn render_notebook(content: &str) -> Option<String> {
    let notebook: Value = serde_json::from_str(content).ok()?;
    let cells = notebook.get("cells")?.as_array()?;
    let language = notebook
        .pointer("/metadata/kernelspec/language")
        .or_else(|| notebook.pointer("/metadata/language_info/name"))
        .and_then(Value::as_str);
    let mut output = format!("Jupyter notebook, {} cells", cells.len());
    if let Some(language) = language {
        output.push_str(&format!(" ({language})"));
    }
    output.push_str(". To change it, edit the cell's source in the file's JSON.\n");

    for (index, cell) in cells.iter().enumerate() {
        let kind = cell
            .get("cell_type")
            .and_then(Value::as_str)
            .unwrap_or("cell");
        output.push_str(&format!("\n[{}] {kind}\n", index + 1));
        let source = joined(cell.get("source"));
        output.push_str(source.trim_end());
        output.push('\n');

        let mut printed = String::new();
        let mut pictures = 0usize;
        for result in cell
            .get("outputs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match result.get("output_type").and_then(Value::as_str) {
                Some("stream") => printed.push_str(&joined(result.get("text"))),
                Some("error") => {
                    let text = |key: &str| result.get(key).and_then(Value::as_str).unwrap_or("");
                    printed.push_str(&format!("{}: {}\n", text("ename"), text("evalue")));
                }
                _ => {
                    let Some(data) = result.get("data").and_then(Value::as_object) else {
                        continue;
                    };
                    pictures += data.keys().filter(|key| key.starts_with("image/")).count();
                    let text = joined(data.get("text/plain"));
                    if !text.is_empty() {
                        printed.push_str(&text);
                        printed.push('\n');
                    }
                }
            }
        }
        let printed = printed.trim_end();
        if !printed.is_empty() {
            output.push_str("-- output --\n");
            output.push_str(&crate::tools::head_tail(printed, MAX_CELL_OUTPUT_BYTES));
            output.push('\n');
        }
        if pictures > 0 {
            output.push_str(&format!("-- {pictures} picture(s) in the output, not shown --\n"));
        }
    }
    Some(output)
}

/// A name for the kind of a file `read` cannot show, from how it starts.
pub fn binary_kind(bytes: &[u8]) -> &'static str {
    const KINDS: [(&[u8], &str); 9] = [
        (b"PK\x03\x04", "a zip archive (or an Office document)"),
        (b"\x1f\x8b", "a gzip archive"),
        (b"\x7fELF", "a Linux program"),
        (b"\xcf\xfa\xed\xfe", "a macOS program"),
        (b"\xca\xfe\xba\xbe", "a macOS program or Java class"),
        (b"MZ", "a Windows program"),
        (b"SQLite format 3", "an SQLite database"),
        (b"BM", "a BMP picture"),
        (b"II*\x00", "a TIFF picture"),
    ];
    KINDS
        .iter()
        .find(|(start, _)| bytes.starts_with(start))
        .map_or("a binary file", |(_, kind)| kind)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A PDF with one line of text on each of its pages.
    pub(crate) fn pdf_with(pages: &[&str]) -> Vec<u8> {
        let font = 3 + pages.len() * 2;
        let kids: Vec<String> = (0..pages.len())
            .map(|index| format!("{} 0 R", 3 + index * 2))
            .collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                pages.len()
            ),
        ];
        for (index, text) in pages.iter().enumerate() {
            let body = format!("BT /F1 18 Tf 20 100 Td ({text}) Tj ET");
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents {} 0 R /Resources << /Font << /F1 {font} 0 R >> >> >>",
                4 + index * 2
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{body}\nendstream",
                body.len()
            ));
        }
        objects.push(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_string(),
        );

        let mut file = "%PDF-1.4\n".to_string();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(file.len());
            file.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let table = file.len();
        file.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for offset in offsets {
            file.push_str(&format!("{offset:010} 00000 n \n"));
        }
        file.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n",
            objects.len() + 1
        ));
        file.into_bytes()
    }

    #[test]
    fn pictures_and_pdfs_are_told_by_their_content() {
        let named = |name: &str, bytes: &[u8]| format_of(Path::new(name), bytes);
        assert_eq!(
            named("shot.bin", b"\x89PNG\r\n\x1a\n...."),
            Format::Picture("image/png")
        );
        assert_eq!(
            named("photo.jpg", b"\xff\xd8\xff\xe0"),
            Format::Picture("image/jpeg")
        );
        assert_eq!(named("a.gif", b"GIF89a.."), Format::Picture("image/gif"));
        assert_eq!(
            named("a.webp", b"RIFF\x10\0\0\0WEBPVP8 "),
            Format::Picture("image/webp")
        );
        assert_eq!(named("paper", b"%PDF-1.7\n"), Format::Pdf);
        assert_eq!(named("analysis.ipynb", b"{}"), Format::Notebook);
        // A picture's name on other content shows nothing a model could take.
        assert_eq!(named("broken.png", b"<html>"), Format::Other);
        assert_eq!(named("main.rs", b"fn main() {}"), Format::Other);
    }

    #[test]
    fn a_pdf_gives_the_text_of_each_page() {
        let pages = pdf_pages(&pdf_with(&["Pumas are fast.", "Second page here."])).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].trim(), "Pumas are fast.");
        let text = render_pdf(&pages, &[2]);
        assert_eq!(text, "--- page 2 ---\nSecond page here.\n\n");
    }

    #[test]
    fn a_file_that_only_claims_to_be_a_pdf_is_an_error() {
        assert!(pdf_pages(b"%PDF-1.4\nnothing of a document follows").is_err());
    }

    #[test]
    fn pages_are_chosen_by_number_and_range() {
        assert_eq!(page_selection("3", 10).unwrap(), vec![3]);
        assert_eq!(page_selection("2-4", 10).unwrap(), vec![2, 3, 4]);
        assert_eq!(page_selection("4-6, 1", 10).unwrap(), vec![1, 4, 5, 6]);
        // A range that runs past the end stops at the last page.
        assert_eq!(page_selection("9-20", 10).unwrap(), vec![9, 10]);
        for invalid in ["", "0", "5-2", "x", "11", "1-"] {
            let error = page_selection(invalid, 10).unwrap_err();
            assert!(error.contains("this document has 10"), "{invalid}: {error}");
        }
    }

    #[test]
    fn page_numbers_are_written_as_ranges() {
        assert_eq!(page_ranges(&[1, 2, 3, 7]), "1-3, 7");
        assert_eq!(page_ranges(&[4]), "4");
        assert_eq!(page_ranges(&[]), "");
    }

    #[test]
    fn a_notebook_shows_its_cells_and_what_they_printed() {
        let notebook = serde_json::json!({
            "metadata": { "kernelspec": { "language": "python" } },
            "cells": [
                { "cell_type": "markdown", "source": ["# Speed\n", "of pumas"] },
                {
                    "cell_type": "code",
                    "source": "print(80)",
                    "outputs": [
                        { "output_type": "stream", "text": ["80\n"] },
                        { "output_type": "display_data", "data": {
                            "image/png": "AAAA", "text/plain": ["<Figure>"]
                        } },
                        { "output_type": "error", "ename": "ValueError", "evalue": "too fast" }
                    ]
                }
            ]
        });
        let text = render_notebook(&notebook.to_string()).unwrap();
        assert!(text.starts_with("Jupyter notebook, 2 cells (python)."), "{text}");
        assert!(text.contains("\n[1] markdown\n# Speed\nof pumas\n"), "{text}");
        assert!(
            text.contains("\n[2] code\nprint(80)\n-- output --\n80\n<Figure>\nValueError: too fast\n"),
            "{text}"
        );
        assert!(text.contains("-- 1 picture(s) in the output, not shown --"), "{text}");
        // The picture's data never reaches the text.
        assert!(!text.contains("AAAA"));
    }

    #[test]
    fn json_that_is_no_notebook_is_not_rendered_as_one() {
        assert!(render_notebook("{\"worksheets\": []}").is_none());
        assert!(render_notebook("not json").is_none());
    }

    #[test]
    fn a_binary_file_is_named_by_its_kind() {
        assert_eq!(binary_kind(b"PK\x03\x04rest"), "a zip archive (or an Office document)");
        assert_eq!(binary_kind(b"SQLite format 3\0"), "an SQLite database");
        assert_eq!(binary_kind(b"\0\x01\x02"), "a binary file");
    }
}
