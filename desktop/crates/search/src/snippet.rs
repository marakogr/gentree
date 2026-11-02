//! Plain-text snippet extraction with character-offset highlights.
//!
//! The UI never parses HTML: a snippet is up to [`MAX_SNIPPET_CHARS`]
//! characters of the original text and every highlight is a
//! `(start, end)` pair of **character** (not byte) offsets into that snippet
//! (design.md §6).

use rust_stemmers::Algorithm;

use crate::analyzer;

/// Hard cap for snippet length, in characters.
pub(crate) const MAX_SNIPPET_CHARS: usize = 240;

/// How many characters of context are kept before the first match.
const LEAD_CHARS: usize = 60;

/// Builds a snippet from the first candidate that contains a query match.
///
/// `candidates` are tried in order (typically `text`, `name`, `place`); when
/// none matches the first non-empty candidate is truncated instead. The
/// returned highlights are character offsets into the returned snippet.
pub(crate) fn build(candidates: &[&str], terms: &[String]) -> (String, Vec<(usize, usize)>) {
    let mut fallback: Option<String> = None;
    for candidate in candidates {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        let chars: Vec<char> = trimmed.chars().collect();
        let matches = find_matches(&chars, terms);
        if matches.is_empty() {
            if fallback.is_none() {
                fallback = Some(truncate_plain(&chars));
            }
            continue;
        }
        return window(&chars, &matches);
    }
    (fallback.unwrap_or_default(), Vec::new())
}

/// Cuts a window around the first match and rebases highlight offsets.
fn window(chars: &[char], matches: &[(usize, usize)]) -> (String, Vec<(usize, usize)>) {
    let total = chars.len();
    let first_match = matches[0].0;
    let mut start = first_match.saturating_sub(LEAD_CHARS);
    if start > 0 {
        // Do not begin the snippet in the middle of a word.
        while start < first_match && is_word(chars[start]) {
            start += 1;
        }
    }
    let mut end = (start + MAX_SNIPPET_CHARS).min(total);
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    let text: String = chars[start..end].iter().collect();
    let highlights = matches
        .iter()
        .filter(|(from, to)| *from >= start && *to <= end)
        .map(|(from, to)| (from - start, to - start))
        .collect();
    (text, highlights)
}

/// First [`MAX_SNIPPET_CHARS`] characters, trimmed, without highlights.
fn truncate_plain(chars: &[char]) -> String {
    let end = MAX_SNIPPET_CHARS.min(chars.len());
    chars[..end].iter().collect::<String>().trim().to_owned()
}

/// Character ranges of words that match one of the query terms.
fn find_matches(chars: &[char], terms: &[String]) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if !is_word(chars[index]) {
            index += 1;
            continue;
        }
        let from = index;
        while index < chars.len() && is_word(chars[index]) {
            index += 1;
        }
        let word: String = chars[from..index].iter().map(|c| lower_char(*c)).collect();
        if matches_term(&word, terms) {
            matches.push((from, index));
        }
    }
    matches
}

/// A word matches when it shares a prefix with the term (inflected forms such
/// as "Петрова" for "петров") or when both stem to the same token.
fn matches_term(word: &str, terms: &[String]) -> bool {
    if word.is_empty() {
        return false;
    }
    terms.iter().any(|term| {
        if term.chars().count() >= 2 && word.starts_with(term.as_str()) {
            return true;
        }
        if term.starts_with(word) && word.chars().count() >= 2 {
            return true;
        }
        let word_ru = analyzer::stem(Algorithm::Russian, word);
        let word_en = analyzer::stem(Algorithm::English, word);
        let term_ru = analyzer::stem(Algorithm::Russian, term);
        let term_en = analyzer::stem(Algorithm::English, term);
        word_ru == term_ru || word_en == term_en
    })
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric()
}

/// Lowercases a single character without changing the character count, so the
/// derived word string can still be compared with the original slice.
fn lower_char(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

#[cfg(test)]
mod tests {
    use super::{build, MAX_SNIPPET_CHARS};

    fn terms(query: &str) -> Vec<String> {
        let mut analyzer = crate::analyzer::analyzer(rust_stemmers::Algorithm::Russian);
        let mut stream = analyzer.token_stream(query);
        let mut out = Vec::new();
        while let Some(token) = stream.next() {
            out.push(token.text.clone());
        }
        out
    }

    #[test]
    fn highlights_point_at_the_matched_word() {
        let (snippet, highlights) = build(&["", "Иван Петров", ""], &terms("петров"));
        assert_eq!(snippet, "Иван Петров");
        assert_eq!(highlights, vec![(5, 11)]);
        let chars: Vec<char> = snippet.chars().collect();
        let highlighted: String = chars[5..11].iter().collect();
        assert_eq!(highlighted, "Петров");
    }

    #[test]
    fn long_text_is_truncated_and_html_free() {
        let padding = "очень длинное описание жизни ".repeat(60);
        let text = format!("{padding}Петров Иван");
        let (snippet, highlights) = build(&[text.as_str()], &terms("петров"));
        assert!(snippet.chars().count() <= MAX_SNIPPET_CHARS);
        assert!(!snippet.contains('<') && !snippet.contains('>'));
        assert_eq!(highlights.len(), 1);
        let (from, to) = highlights[0];
        assert!(from < to && to <= snippet.chars().count());
        let chars: Vec<char> = snippet.chars().collect();
        let highlighted: String = chars[from..to].iter().collect();
        assert_eq!(highlighted.to_lowercase(), "петров");
    }

    #[test]
    fn no_match_returns_plain_truncated_text() {
        let text = "а".repeat(500);
        let (snippet, highlights) = build(&[text.as_str()], &terms("петров"));
        assert_eq!(snippet.chars().count(), MAX_SNIPPET_CHARS);
        assert!(highlights.is_empty());
    }

    #[test]
    fn empty_candidates_give_empty_snippet() {
        let (snippet, highlights) = build(&["", "   "], &terms("петров"));
        assert!(snippet.is_empty());
        assert!(highlights.is_empty());
    }
}
