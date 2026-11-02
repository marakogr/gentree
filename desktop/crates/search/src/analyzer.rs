//! Language analyzers for the Tantivy index.
//!
//! Russian and English stemming are implemented as a custom [`TokenFilter`]
//! backed by `rust_stemmers`, so the index does not depend on Tantivy's
//! optional `stemmer`/`russian` feature flags (design.md §6).
//!
//! Snowball stemming is not idempotent (`петров` → `петр`, but `петрова` →
//! `петров`), so both the index-time filter and query-time term preparation
//! stem to a fixed point. Without that, searching `Петрова` would miss a
//! document indexed as `Петров` — the common male/female surname pair in
//! genealogy data.

use std::borrow::Cow;

use rust_stemmers::{Algorithm, Stemmer};
use tantivy::tokenizer::{
    LowerCaser, SimpleTokenizer, TextAnalyzer, Token, TokenFilter, TokenStream, Tokenizer,
};

/// Registered name of the Russian analyzer.
pub(crate) const RU_STEM: &str = "ru_stem";
/// Registered name of the English analyzer.
pub(crate) const EN_STEM: &str = "en_stem";

/// Upper bound for fixed-point stemming; Snowball converges in 2–3 passes.
const MAX_STEM_PASSES: usize = 5;

/// Lowercase + Snowball stemming token filter.
#[derive(Clone, Copy)]
pub(crate) struct StemFilter {
    algorithm: Algorithm,
}

impl StemFilter {
    pub(crate) fn new(algorithm: Algorithm) -> Self {
        Self { algorithm }
    }
}

impl TokenFilter for StemFilter {
    type Tokenizer<T: Tokenizer> = StemTokenizer<T>;

    fn transform<T: Tokenizer>(self, tokenizer: T) -> StemTokenizer<T> {
        StemTokenizer {
            algorithm: self.algorithm,
            inner: tokenizer,
        }
    }
}

/// Tokenizer produced by [`StemFilter`].
#[derive(Clone)]
pub(crate) struct StemTokenizer<T> {
    algorithm: Algorithm,
    inner: T,
}

impl<T: Tokenizer> Tokenizer for StemTokenizer<T> {
    type TokenStream<'a> = StemTokenStream<T::TokenStream<'a>>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        StemTokenStream {
            stemmer: Stemmer::create(self.algorithm),
            tail: self.inner.token_stream(text),
        }
    }
}

/// Token stream that rewrites every token to its fixed-point stem.
pub(crate) struct StemTokenStream<T> {
    stemmer: Stemmer,
    tail: T,
}

impl<T: TokenStream> TokenStream for StemTokenStream<T> {
    fn advance(&mut self) -> bool {
        if !self.tail.advance() {
            return false;
        }
        let token = self.tail.token_mut();
        let stemmed = stem_to_fixpoint(&self.stemmer, &token.text);
        if stemmed != token.text {
            token.text = stemmed;
        }
        true
    }

    fn token(&self) -> &Token {
        self.tail.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.tail.token_mut()
    }
}

/// Builds the analyzer registered under [`RU_STEM`] / [`EN_STEM`].
pub(crate) fn analyzer(algorithm: Algorithm) -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .filter(StemFilter::new(algorithm))
        .build()
}

/// Stems a single already-lowercased term exactly like the index pipeline.
pub(crate) fn stem(algorithm: Algorithm, term: &str) -> String {
    stem_to_fixpoint(&Stemmer::create(algorithm), term)
}

fn stem_to_fixpoint(stemmer: &Stemmer, text: &str) -> String {
    let mut current = text.to_owned();
    for _ in 0..MAX_STEM_PASSES {
        let next = match stemmer.stem(&current) {
            Cow::Borrowed(borrowed) => borrowed.to_owned(),
            Cow::Owned(owned) => owned,
        };
        if next == current {
            break;
        }
        current = next;
    }
    current
}

#[cfg(test)]
mod tests {
    use super::{analyzer, stem, StemFilter, RU_STEM};
    use rust_stemmers::Algorithm;

    fn tokenize(algorithm: Algorithm, text: &str) -> Vec<String> {
        let mut analyzer = analyzer(algorithm);
        let mut stream = analyzer.token_stream(text);
        let mut tokens = Vec::new();
        while let Some(token) = stream.next() {
            tokens.push(token.text.clone());
        }
        tokens
    }

    #[test]
    fn russian_analyzer_lowercases_and_stems() {
        let tokens = tokenize(Algorithm::Russian, "Иван ПЕТРОВА");
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0], stem(Algorithm::Russian, "иван"));
        assert_eq!(tokens[1], stem(Algorithm::Russian, "петрова"));
        assert!(tokens
            .iter()
            .all(|token| token.chars().all(|c| !c.is_uppercase())));
    }

    #[test]
    fn english_analyzer_lowercases_and_stems() {
        let tokens = tokenize(Algorithm::English, "Ivan PETROV studies");
        assert_eq!(
            tokens,
            vec!["ivan".to_owned(), "petrov".to_owned(), "studi".to_owned()]
        );
    }

    #[test]
    fn russian_stemming_reaches_a_fixed_point() {
        // Male and female surname forms must share one term, otherwise
        // searching for one never finds the other.
        assert_eq!(
            stem(Algorithm::Russian, "петров"),
            stem(Algorithm::Russian, "петрова")
        );
        assert_eq!(
            stem(Algorithm::Russian, "иван"),
            stem(Algorithm::Russian, "иваном")
        );
    }

    #[test]
    fn cyrillic_term_survives_english_stemmer() {
        assert_eq!(stem(Algorithm::English, "петрова"), "петрова");
    }

    #[test]
    fn filter_is_registered_under_the_contract_names() {
        assert_eq!(RU_STEM, "ru_stem");
        let _ = StemFilter::new(Algorithm::Russian);
        let _ = StemFilter::new(Algorithm::English);
    }
}
