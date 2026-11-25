//! The markdown-ish text Vera's card shows: `#` headings, paragraphs, `-`
//! and `1.` lists, `>` quotes, fenced code, and inline `code`, **bold**,
//! and *italic*. Small on purpose: what a spoken answer needs to show, in
//! Hex's type, with no parser dependency.

use rune::{El, Span, col, rich, row, text};

use super::super::Paint;

enum Block {
    Heading(usize, String),
    Paragraph(String),
    Bullet(String),
    Numbered(String, String),
    Quote(String),
    Code(String),
}

fn blocks(source: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut code: Option<Vec<&str>> = None;
    let flush = |paragraph: &mut Vec<&str>, blocks: &mut Vec<Block>| {
        if !paragraph.is_empty() {
            blocks.push(Block::Paragraph(paragraph.join(" ")));
            paragraph.clear();
        }
    };
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(lines) = &mut code {
            if trimmed.starts_with("```") {
                blocks.push(Block::Code(lines.join("\n")));
                code = None;
            } else {
                lines.push(line);
            }
            continue;
        }
        if trimmed.starts_with("```") {
            flush(&mut paragraph, &mut blocks);
            code = Some(Vec::new());
            continue;
        }
        if trimmed.is_empty() {
            flush(&mut paragraph, &mut blocks);
            continue;
        }
        let hashes = trimmed.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Heading(hashes, trimmed[hashes..].trim().to_owned()));
            continue;
        }
        if let Some(item) = ["- ", "* ", "+ ", "• "]
            .iter()
            .find_map(|marker| trimmed.strip_prefix(marker))
        {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Bullet(item.trim().to_owned()));
            continue;
        }
        let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
        if digits > 0
            && digits < 4
            && let Some(item) = trimmed[digits..]
                .strip_prefix(". ")
                .or_else(|| trimmed[digits..].strip_prefix(") "))
        {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Numbered(
                trimmed[..digits].to_owned(),
                item.trim().to_owned(),
            ));
            continue;
        }
        if let Some(quote) = trimmed.strip_prefix('>') {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Quote(quote.trim().to_owned()));
            continue;
        }
        paragraph.push(trimmed);
    }
    if let Some(lines) = code {
        blocks.push(Block::Code(lines.join("\n")));
    }
    flush(&mut paragraph, &mut blocks);
    blocks
}

#[derive(Clone, Copy, PartialEq)]
enum Mark {
    Code,
    Bold,
    Italic,
}

/// `source` without its inline markers, and the spans they marked.
fn inline(source: &str) -> (String, Vec<(usize, usize, Mark)>) {
    let mut out = String::with_capacity(source.len());
    let mut spans = Vec::new();
    let mut rest = source;
    while let Some(c) = rest.chars().next() {
        let (marker, mark) = if rest.starts_with("**") || rest.starts_with("__") {
            (&rest[..2], Mark::Bold)
        } else if c == '`' {
            ("`", Mark::Code)
        } else if (c == '*' || c == '_')
            && out
                .chars()
                .last()
                .is_none_or(|before| !before.is_alphanumeric())
        {
            (&rest[..1], Mark::Italic)
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
            continue;
        };
        let body = &rest[marker.len()..];
        match body.find(marker) {
            Some(end) if end > 0 => {
                let start = out.len();
                out.push_str(&body[..end]);
                spans.push((start, out.len(), mark));
                rest = &body[end + marker.len()..];
            }
            _ => {
                out.push_str(marker);
                rest = body;
            }
        }
    }
    (out, spans)
}

fn styled(p: Paint, key: String, source: &str, font: rune::TextStyle, color: rune::Color) -> El {
    let (content, marks) = inline(source);
    let spans = marks
        .into_iter()
        .map(|(start, end, mark)| {
            let span = Span::new(start, end);
            match mark {
                Mark::Bold => span.weight(600.0),
                Mark::Italic => Span {
                    italic: true,
                    ..span
                },
                Mark::Code => Span {
                    mono: true,
                    bg: Some(p.k.c.layer_02),
                    bg_pad: 2.0,
                    size: Some(font.size - 0.5),
                    ..span
                },
            }
        })
        .collect();
    rich(content, spans)
        .key(key)
        .font(font)
        .color(color)
        .w_full()
}

/// The card's body.
pub(super) fn render(p: Paint, source: &str) -> El {
    let body = p.k.ty.ui;
    let mut column = col().key("markdown").w_full().gap(8.0);
    for (index, block) in blocks(source).into_iter().enumerate() {
        let key = format!("b{index}");
        column = column.child(match block {
            Block::Heading(level, line) => {
                let font = if level <= 2 {
                    p.k.ty.body_medium
                } else {
                    p.k.ty.ui_medium
                };
                styled(p, key, &line, font, p.text())
                    .role("heading")
                    .level(level as u32)
                    .mt(if index == 0 { 0.0 } else { 4.0 })
            }
            Block::Paragraph(line) => styled(p, key, &line, body, p.text()),
            Block::Bullet(line) => list_item(p, key, "•".into(), &line),
            Block::Numbered(number, line) => list_item(p, key, format!("{number}."), &line),
            Block::Quote(line) => row()
                .key(key)
                .w_full()
                .gap(8.0)
                .child(el_bar(p))
                .child(styled(p, "q".into(), &line, body, p.muted()).shrink()),
            Block::Code(code) => col()
                .key(key)
                .w_full()
                .px(12.0)
                .py(8.0)
                .radius(p.k.radius.md)
                .fill(p.k.c.layer_02)
                .child(
                    text(code)
                        .key("code")
                        .font(p.k.ty.mono)
                        .color(p.text())
                        .wrap(),
                ),
        });
    }
    column
}

fn list_item(p: Paint, key: String, marker: String, line: &str) -> El {
    row()
        .key(key)
        .w_full()
        .gap(8.0)
        .child(
            text(marker)
                .key("marker")
                .font(p.k.ty.ui)
                .color(p.muted())
                .w(10.0)
                .a11y_hidden(),
        )
        .child(styled(p, "item".into(), line, p.k.ty.ui, p.text()).shrink())
}

fn el_bar(p: Paint) -> El {
    rune::el()
        .key("bar")
        .w(2.0)
        .min_h(18.0)
        .radius(1.0)
        .fill(p.k.c.border_base)
        .a11y_hidden()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_marks_are_stripped_and_spanned() {
        let (text, spans) = inline("Run `pnpm test` then **ship** it, *gently*.");
        assert_eq!(text, "Run pnpm test then ship it, gently.");
        assert_eq!(spans.len(), 3);
        assert!(spans[0].2 == Mark::Code && &text[spans[0].0..spans[0].1] == "pnpm test");
        assert!(spans[1].2 == Mark::Bold && &text[spans[1].0..spans[1].1] == "ship");
        assert!(spans[2].2 == Mark::Italic && &text[spans[2].0..spans[2].1] == "gently");
        // snake_case and a lone star stay as written.
        assert_eq!(inline("my_var * 2").0, "my_var * 2");
        assert_eq!(inline("unclosed `tick").0, "unclosed `tick");
    }

    #[test]
    fn blocks_split_as_markdown_does() {
        let source =
            "# Build\nAll green.\nShipped.\n\n- one\n- two\n1. first\n> note\n```\nfn x() {}\n```";
        let kinds: Vec<&str> = blocks(source)
            .iter()
            .map(|block| match block {
                Block::Heading(..) => "h",
                Block::Paragraph(_) => "p",
                Block::Bullet(_) => "b",
                Block::Numbered(..) => "n",
                Block::Quote(_) => "q",
                Block::Code(_) => "c",
            })
            .collect();
        assert_eq!(kinds, ["h", "p", "b", "b", "n", "q", "c"]);
    }
}
