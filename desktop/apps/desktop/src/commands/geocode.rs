//! Online address suggestions for the event `place` and `RESIDENCE.address`
//! fields (ADR-0016).
//!
//! The feature is on by default and has an explicit switch: while
//! `geocoder.enabled` is false no request may leave the machine and the command
//! returns an empty list. Suggestions are additive, so free text always stays
//! possible.
//!
//! Privacy: the query, the provider response and the DaData key are never
//! logged. Errors carry only the stable `GEOCODER_UNAVAILABLE` code — no query,
//! key, URL or response body.

use std::sync::Mutex;
use std::time::Duration;

use gentree_config::GeocoderProvider;
use gentree_core::error::codes;
use gentree_core::{AppError, PlaceGeo, PlacePrecision, PlaceSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::settings::ConfigState;

/// Shortest query worth a network call.
const MIN_QUERY_CHARS: usize = 3;
/// Longest prefix of the query that is sent to a provider.
const MAX_QUERY_CHARS: usize = 200;
/// Suggestions returned to the UI after deduplication.
const MAX_SUGGESTIONS: usize = 8;
/// Photon's page size; also sent as DaData's `count`.
const REQUEST_LIMIT: usize = 8;
const USER_AGENT: &str = concat!("Gentree/", env!("CARGO_PKG_VERSION"));

/// One address suggestion. `source` is `"photon"`, `"dadata"` or `"wikidata"`;
/// the UI uses it only as a label, never to re-query a provider directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceSuggestion {
    pub label: String,
    pub hint: String,
    pub source: String,
    /// The provider's point for this exact object, when the answer has usable
    /// coordinates (ADR-0020). A suggestion without a point is still usable as
    /// free text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<PlaceGeo>,
    /// True for a modern suggestion found by rewriting a historical place name
    /// (for example "Горький, улица Горького" → "Нижний Новгород, улица
    /// Горького"). The UI keeps the typed historical text; the modern label is
    /// only shown next to the point.
    #[serde(default, skip_serializing_if = "is_false")]
    pub historical: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Geocoder settings cloned out of the shared config. The mutex guard is
/// released before the first `await`, because the command future must be
/// `Send`.
#[derive(Debug, Clone)]
struct GeocoderSettings {
    provider: GeocoderProvider,
    photon_base_url: String,
    dadata_base_url: String,
    api_key_env: String,
    timeout_seconds: u64,
}

#[derive(Debug, Clone)]
struct HistoricalSettings {
    api_url: String,
    timeout_seconds: u64,
}

/// Historical results are capped so modern suggestions still fit the list.
const MAX_HISTORICAL_SUGGESTIONS: usize = 4;

#[tauri::command]
pub async fn place_suggest(
    state: State<'_, Mutex<ConfigState>>,
    query: String,
) -> Result<Vec<PlaceSuggestion>, AppError> {
    let (modern, historical) = {
        let guard = crate::lock_or(state.inner(), "settings state poisoned")?;
        let config = guard.config();
        let modern = config.geocoder.enabled.then(|| GeocoderSettings {
            provider: config.geocoder.provider,
            photon_base_url: config.geocoder.photon_base_url.clone(),
            dadata_base_url: config.geocoder.dadata_base_url.clone(),
            api_key_env: config.geocoder.api_key_env.clone(),
            timeout_seconds: config.geocoder.timeout_seconds,
        });
        let historical = config
            .historical_geocoder
            .enabled
            .then(|| HistoricalSettings {
                api_url: config.historical_geocoder.api_url.clone(),
                timeout_seconds: config.historical_geocoder.timeout_seconds,
            });
        (modern, historical)
    };
    if modern.is_none() && historical.is_none() {
        return Ok(Vec::new());
    }

    let Some(query) = normalize_query(&query) else {
        return Ok(Vec::new());
    };
    let timeout = modern
        .as_ref()
        .map(|settings| settings.timeout_seconds)
        .unwrap_or(0)
        .max(
            historical
                .as_ref()
                .map(|settings| settings.timeout_seconds)
                .unwrap_or(0),
        );
    let client = http_client(timeout)?;

    let modern_results = match &modern {
        Some(settings) => modern_suggestions(&client, settings, &query).await,
        None => None,
    };
    let historical_results = match &historical {
        Some(settings) => wikidata(&client, &settings.api_url, &query).await.ok(),
        None => None,
    };
    // A historical city name in front of a street ("Горький, улица Горького")
    // is not a Wikidata label of the street itself. Resolve the city and ask
    // the modern provider for the address inside today's city.
    let contextual_results =
        contextual_suggestions(&client, modern.as_ref(), historical.as_ref(), &query).await;
    let modern_results = merge_contextual_modern(modern_results, contextual_results);
    combine_suggestions(modern_results, historical_results)
}

/// Keeps the contextual results first: they are the ones that match the
/// historical city the user typed, while the original query may only return
/// same-named streets in other cities.
fn merge_contextual_modern(
    modern: Option<Vec<PlaceSuggestion>>,
    contextual: Option<Vec<PlaceSuggestion>>,
) -> Option<Vec<PlaceSuggestion>> {
    match (modern, contextual) {
        (Some(modern), Some(contextual)) => Some(merge_suggestions(contextual, modern)),
        (None, Some(contextual)) => Some(contextual),
        (modern, None) => modern,
    }
}

/// Modern providers keep their existing routing; a failure is `None` so the
/// historical provider can still answer.
async fn modern_suggestions(
    client: &reqwest::Client,
    settings: &GeocoderSettings,
    query: &str,
) -> Option<Vec<PlaceSuggestion>> {
    match settings.provider {
        GeocoderProvider::Photon => photon(client, &settings.photon_base_url, query).await.ok(),
        GeocoderProvider::Dadata => {
            let key = crate::envvars::value(&settings.api_key_env)?;
            dadata(client, &settings.dadata_base_url, &key, query)
                .await
                .ok()
        }
        GeocoderProvider::Both => both(client, settings, query).await.ok(),
    }
}

/// Historical matches come first; modern matches fill the remaining slots. A
/// failure of either side is silent while the other side has results.
fn combine_suggestions(
    modern: Option<Vec<PlaceSuggestion>>,
    historical: Option<Vec<PlaceSuggestion>>,
) -> Result<Vec<PlaceSuggestion>, AppError> {
    match (modern, historical) {
        (None, None) => Err(unavailable()),
        (Some(modern), None) => Ok(modern),
        (None, Some(mut historical)) => {
            historical.truncate(MAX_HISTORICAL_SUGGESTIONS);
            Ok(historical)
        }
        (Some(modern), Some(mut historical)) => {
            historical.truncate(MAX_HISTORICAL_SUGGESTIONS);
            Ok(merge_suggestions(historical, modern))
        }
    }
}

/// Administrative words that may precede a settlement name in imported
/// addresses ("г. Горький", "пос. Ивановка").
const ADMIN_PLACE_PREFIXES: [&str; 20] = [
    "г",
    "гор",
    "город",
    "пгт",
    "пос",
    "поселок",
    "посёлок",
    "рп",
    "р.п",
    "рабочий",
    "с",
    "село",
    "дер",
    "деревня",
    "ст",
    "станица",
    "х",
    "хутор",
    "аул",
    "кишлак",
];

/// Street-type words. A query that starts with one of these has no city in
/// front of it, so there is nothing to rewrite.
const STREET_PLACE_WORDS: [&str; 22] = [
    "улица",
    "ул",
    "проспект",
    "пр",
    "пр-т",
    "переулок",
    "пер",
    "проезд",
    "площадь",
    "пл",
    "бульвар",
    "б-р",
    "шоссе",
    "ш",
    "набережная",
    "наб",
    "тупик",
    "аллея",
    "дом",
    "д",
    "квартира",
    "кв",
];

/// Splits a typed address into a possible settlement name and the rest.
/// `None` when the text has no remainder or already starts with a street type.
fn leading_place(query: &str) -> Option<(String, String)> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return None;
    }
    let separator = |character: char| character == ',' || character == ';';
    let (head, tail) = match trimmed.find(separator) {
        Some(index) => (
            trimmed[..index].trim(),
            trimmed[index..].trim_start_matches(separator).trim(),
        ),
        None => (trimmed, ""),
    };
    let head = strip_admin_prefixes(head);
    if head.is_empty() {
        return None;
    }
    let (candidate, remainder) = if tail.is_empty() {
        // Without a comma the first word is the only safe boundary.
        let candidate = head.split_whitespace().next()?;
        (candidate, head[candidate.len()..].trim())
    } else {
        (head, tail)
    };
    if remainder.is_empty() || is_street_word(candidate) {
        return None;
    }
    Some((candidate.to_owned(), remainder.to_owned()))
}

fn strip_admin_prefixes(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start();
        let Some((word, rest)) = split_first_word(trimmed) else {
            return "";
        };
        let normalized = word.trim_matches('.').to_lowercase();
        if ADMIN_PLACE_PREFIXES.contains(&normalized.as_str()) {
            text = rest;
        } else {
            return trimmed;
        }
    }
}

fn split_first_word(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    if text.is_empty() {
        return None;
    }
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    Some((&text[..end], &text[end..]))
}

fn is_street_word(candidate: &str) -> bool {
    candidate
        .split_whitespace()
        .next()
        .map(|word| word.trim_matches('.').to_lowercase())
        .is_some_and(|word| STREET_PLACE_WORDS.contains(&word.as_str()))
}

/// Modern suggestions for a historical city + street query. Wikidata supplies
/// the modern city label; the address tail is kept as typed. Results are marked
/// `historical` so the UI keeps the user's historical text.
async fn contextual_suggestions(
    client: &reqwest::Client,
    modern: Option<&GeocoderSettings>,
    historical: Option<&HistoricalSettings>,
    query: &str,
) -> Option<Vec<PlaceSuggestion>> {
    let modern = modern?;
    let historical = historical?;
    let (candidate, remainder) = leading_place(query)?;
    let resolved = wikidata(client, &historical.api_url, &candidate)
        .await
        .ok()?;
    let modern_label = resolved
        .iter()
        .find(|suggestion| {
            suggestion
                .point
                .as_ref()
                .is_some_and(|point| point.precision == PlacePrecision::Settlement)
        })
        .map(|suggestion| suggestion.label.clone())
        .filter(|label| !same_text(label, &candidate))?;
    let rewritten = format!("{modern_label} {remainder}");
    let mut suggestions = modern_suggestions(client, modern, &rewritten).await?;
    for suggestion in &mut suggestions {
        suggestion.historical = true;
    }
    Some(suggestions)
}

/// `both`: Latin queries go to Photon only; Cyrillic queries ask DaData first
/// (when a key exists) and then Photon. One failing provider does not hide the
/// other's results; two failures are `GEOCODER_UNAVAILABLE`.
async fn both(
    client: &reqwest::Client,
    settings: &GeocoderSettings,
    query: &str,
) -> Result<Vec<PlaceSuggestion>, AppError> {
    if !has_cyrillic(query) {
        return photon(client, &settings.photon_base_url, query)
            .await
            .map_err(|_| unavailable());
    }

    let dadata_results = match crate::envvars::value(&settings.api_key_env) {
        Some(key) => dadata(client, &settings.dadata_base_url, &key, query)
            .await
            .ok(),
        None => None,
    };
    let photon_results = photon(client, &settings.photon_base_url, query).await.ok();

    match (dadata_results, photon_results) {
        (Some(first), Some(second)) => Ok(merge_suggestions(first, second)),
        (Some(first), None) => Ok(first),
        (None, Some(second)) => Ok(second),
        (None, None) => Err(unavailable()),
    }
}

fn http_client(timeout_seconds: u64) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(1)))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| unavailable())
}

/// One code for every geocoder failure. Never includes the query, the key, the
/// URL or the provider body.
fn unavailable() -> AppError {
    AppError::new(
        codes::GEOCODER_UNAVAILABLE,
        "Address suggestions are unavailable",
    )
}

/// Trims, caps and rejects a query that is too short to be useful.
fn normalize_query(raw: &str) -> Option<String> {
    let capped: String = raw.trim().chars().take(MAX_QUERY_CHARS).collect();
    let capped = capped.trim_end();
    (capped.chars().count() >= MIN_QUERY_CHARS).then(|| capped.to_owned())
}

/// Cyrillic block plus the Cyrillic Supplement block; covers Russian, Ukrainian
/// and Belarusian input.
fn has_cyrillic(text: &str) -> bool {
    text.chars()
        .any(|character| matches!(character, '\u{0400}'..='\u{052F}'))
}

/// Trim, collapse whitespace and lowercase, so two providers that describe the
/// same place in different spacing still collapse to one suggestion.
fn normalize_label(label: &str) -> String {
    let mut normalized = String::with_capacity(label.len());
    for word in label.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.push_str(word);
    }
    normalized.to_lowercase()
}

fn same_text(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

/// Appends a non-empty part unless an equal part is already present.
fn push_part(parts: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    if parts.iter().any(|part| same_text(part, value)) {
        return;
    }
    parts.push(value.to_owned());
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Concatenates two result lists, keeps the first source per normalized label
/// and caps the result. Callers put the preferred provider first. A duplicate
/// may still contribute a missing point to the kept suggestion.
fn merge_suggestions(
    first: Vec<PlaceSuggestion>,
    second: Vec<PlaceSuggestion>,
) -> Vec<PlaceSuggestion> {
    let mut merged: Vec<PlaceSuggestion> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for suggestion in first.into_iter().chain(second) {
        let label = normalize_label(&suggestion.label);
        if label.is_empty() {
            continue;
        }
        if let Some(position) = seen.get(&label).copied() {
            let existing = &mut merged[position];
            if existing.point.is_none() {
                existing.point = suggestion.point;
            }
            continue;
        }
        seen.insert(label, merged.len());
        merged.push(suggestion);
        if merged.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    merged
}

fn finish(suggestions: Vec<PlaceSuggestion>) -> Vec<PlaceSuggestion> {
    merge_suggestions(suggestions, Vec::new())
}

/// Wikidata historical names (ADR-0021). Two API calls: entity search, then
/// coordinates/types/labels for the best ids. Only the typed place name leaves
/// the machine; no key is sent.
async fn wikidata(
    client: &reqwest::Client,
    api_url: &str,
    query: &str,
) -> Result<Vec<PlaceSuggestion>, ()> {
    let language = if has_cyrillic(query) { "ru" } else { "en" };
    let limit = MAX_HISTORICAL_SUGGESTIONS.to_string();
    let search_body = client
        .get(api_url)
        .query(&[
            ("action", "wbsearchentities"),
            ("search", query),
            ("language", language),
            ("uselang", language),
            ("format", "json"),
            ("limit", limit.as_str()),
            ("type", "item"),
        ])
        .send()
        .await
        .map_err(|_| ())?
        .text()
        .await
        .map_err(|_| ())?;

    let ids = parse_wikidata_ids(&search_body).map_err(|_| ())?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_param = ids.join("|");
    let languages = format!("{language}|ru|en");
    let entities_body = client
        .get(api_url)
        .query(&[
            ("action", "wbgetentities"),
            ("ids", ids_param.as_str()),
            ("props", "claims|labels|descriptions"),
            ("languages", languages.as_str()),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|_| ())?
        .text()
        .await
        .map_err(|_| ())?;
    parse_wikidata_entities(&entities_body, &ids, language).map_err(|_| ())
}

#[derive(Debug, Default, Deserialize)]
struct WikidataSearchResponse {
    #[serde(default)]
    search: Vec<WikidataSearchHit>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataSearchHit {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataEntitiesResponse {
    #[serde(default)]
    entities: std::collections::HashMap<String, WikidataEntity>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataEntity {
    #[serde(default)]
    labels: std::collections::HashMap<String, WikidataText>,
    #[serde(default)]
    descriptions: std::collections::HashMap<String, WikidataText>,
    #[serde(default)]
    claims: std::collections::HashMap<String, Vec<WikidataClaim>>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataText {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataClaim {
    #[serde(default)]
    mainsnak: WikidataSnak,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataSnak {
    #[serde(default)]
    datavalue: Option<WikidataDataValue>,
}

#[derive(Debug, Default, Deserialize)]
struct WikidataDataValue {
    #[serde(default)]
    value: Option<Value>,
}

/// Only recognised settlement/administrative/street entities become
/// suggestions.
const WIKIDATA_SETTLEMENT_TYPES: [&str; 10] = [
    "Q515",     // city
    "Q3957",    // town
    "Q532",     // village
    "Q486972",  // human settlement
    "Q1549591", // big city
    "Q15284",   // municipality
    "Q174844",  // megacity
    "Q200250",  // metropolis
    "Q1637706", // city with millions
    "Q589282",  // commune
];
const WIKIDATA_REGION_TYPES: [&str; 5] = [
    "Q56061",    // administrative territorial entity
    "Q10864048", // first-level administrative division
    "Q35657",    // state
    "Q13220204", // second-level administrative division
    "Q15063159", // district
];
const WIKIDATA_COUNTRY_TYPES: [&str; 2] = ["Q6256", "Q3624078"];
/// Street-like classes. A historical address is often a street, an avenue or a
/// square rather than a settlement; those have their own point, so they are
/// reported as `POINT`, not as the city centroid.
const WIKIDATA_STREET_TYPES: [&str; 10] = [
    "Q79007",     // street / улица
    "Q907698",    // avenue / проспект
    "Q54114",     // boulevard / бульвар
    "Q1251403",   // lane / переулок
    "Q113307036", // passage / проезд
    "Q1418214",   // highway / шоссе
    "Q3840711",   // embankment / набережная
    "Q12731",     // dead end / тупик
    "Q207934",    // alley / аллея
    "Q174782",    // square / площадь
];

fn parse_wikidata_ids(body: &str) -> Result<Vec<String>, serde_json::Error> {
    let parsed: WikidataSearchResponse = serde_json::from_str(body)?;
    let mut seen = std::collections::HashSet::new();
    Ok(parsed
        .search
        .into_iter()
        .filter_map(|hit| hit.id)
        .filter(|id| id.starts_with('Q') && seen.insert(id.clone()))
        .take(MAX_HISTORICAL_SUGGESTIONS)
        .collect())
}

fn parse_wikidata_entities(
    body: &str,
    ids: &[String],
    language: &str,
) -> Result<Vec<PlaceSuggestion>, serde_json::Error> {
    let parsed: WikidataEntitiesResponse = serde_json::from_str(body)?;
    let mut out = Vec::new();
    for id in ids {
        let Some(entity) = parsed.entities.get(id) else {
            continue;
        };
        let Some((lat, lon)) = wikidata_point(entity) else {
            continue;
        };
        let types = wikidata_types(entity);
        if !wikidata_is_place(&types) {
            continue;
        }
        let Some(label) = wikidata_text(&entity.labels, language) else {
            continue;
        };
        let hint = wikidata_text(&entity.descriptions, language).unwrap_or_default();
        let Ok(mut point) =
            PlaceGeo::new(lat, lon, wikidata_precision(&types), PlaceSource::Wikidata)
        else {
            continue;
        };
        point.provider_ref = Some(id.clone());
        point.label = Some(label.clone());
        out.push(PlaceSuggestion {
            label,
            hint,
            source: "wikidata".to_owned(),
            point: Some(point),
            historical: false,
        });
        if out.len() == MAX_HISTORICAL_SUGGESTIONS {
            break;
        }
    }
    Ok(out)
}

fn wikidata_point(entity: &WikidataEntity) -> Option<(f64, f64)> {
    let value = entity
        .claims
        .get("P625")?
        .first()?
        .mainsnak
        .datavalue
        .as_ref()?
        .value
        .as_ref()?;
    Some((
        value.get("latitude")?.as_f64()?,
        value.get("longitude")?.as_f64()?,
    ))
}

fn wikidata_types(entity: &WikidataEntity) -> std::collections::HashSet<&str> {
    entity
        .claims
        .get("P31")
        .into_iter()
        .flatten()
        .filter_map(|claim| {
            claim
                .mainsnak
                .datavalue
                .as_ref()?
                .value
                .as_ref()?
                .get("id")?
                .as_str()
        })
        .collect()
}

fn wikidata_is_place(types: &std::collections::HashSet<&str>) -> bool {
    types.iter().any(|kind| {
        WIKIDATA_SETTLEMENT_TYPES.contains(kind)
            || WIKIDATA_REGION_TYPES.contains(kind)
            || WIKIDATA_COUNTRY_TYPES.contains(kind)
            || WIKIDATA_STREET_TYPES.contains(kind)
    })
}

fn wikidata_precision(types: &std::collections::HashSet<&str>) -> PlacePrecision {
    if types
        .iter()
        .any(|kind| WIKIDATA_COUNTRY_TYPES.contains(kind))
    {
        PlacePrecision::Country
    } else if types
        .iter()
        .any(|kind| WIKIDATA_REGION_TYPES.contains(kind))
    {
        PlacePrecision::Region
    } else if types
        .iter()
        .any(|kind| WIKIDATA_SETTLEMENT_TYPES.contains(kind))
    {
        PlacePrecision::Settlement
    } else if types
        .iter()
        .any(|kind| WIKIDATA_STREET_TYPES.contains(kind))
    {
        PlacePrecision::Point
    } else {
        PlacePrecision::Unknown
    }
}

fn wikidata_text(
    values: &std::collections::HashMap<String, WikidataText>,
    language: &str,
) -> Option<String> {
    for key in [language, "ru", "en"] {
        if let Some(value) = values
            .get(key)
            .and_then(|text| text.value.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_owned());
        }
    }
    None
}

async fn photon(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
) -> Result<Vec<PlaceSuggestion>, ()> {
    // No `lang=ru`: the public Photon instance rejects it with 400 and its
    // default already returns local names.
    let limit = REQUEST_LIMIT.to_string();
    let response = client
        .get(base_url)
        .query(&[("q", query), ("limit", limit.as_str())])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let body = response.text().await.map_err(|_| ())?;
    parse_photon(&body).map_err(|_| ())
}

async fn dadata(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
    query: &str,
) -> Result<Vec<PlaceSuggestion>, ()> {
    let response = client
        .post(base_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Token {key}"))
        .json(&serde_json::json!({ "query": query, "count": REQUEST_LIMIT }))
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let body = response.text().await.map_err(|_| ())?;
    parse_dadata(&body).map_err(|_| ())
}

/// Builds a validated point from provider values. Any unusable value drops the
/// point but never the text suggestion.
fn provider_point(
    lat: Option<f64>,
    lon: Option<f64>,
    precision: PlacePrecision,
    source: PlaceSource,
    provider_ref: Option<String>,
    label: &str,
) -> Option<PlaceGeo> {
    let mut point = PlaceGeo::new(lat?, lon?, precision, source).ok()?;
    point.provider_ref = non_empty(provider_ref.as_deref()).map(str::to_owned);
    point.label = non_empty(Some(label)).map(str::to_owned);
    Some(point)
}

/// `osm_id` is a number in Photon, but a string or a missing value must not
/// fail the whole response.
fn scalar_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => non_empty(Some(text)).map(str::to_owned),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Conservative mapping of a Photon object type to map precision.
fn photon_precision(kind: Option<&str>) -> PlacePrecision {
    match kind.map(str::to_ascii_lowercase).as_deref() {
        Some("house" | "street" | "address" | "venue") => PlacePrecision::Point,
        Some("city" | "town" | "village" | "locality" | "hamlet" | "suburb") => {
            PlacePrecision::Settlement
        }
        Some("district" | "county" | "state") => PlacePrecision::Region,
        Some("country") => PlacePrecision::Country,
        _ => PlacePrecision::Unknown,
    }
}

#[derive(Debug, Default, Deserialize)]
struct PhotonResponse {
    #[serde(default)]
    features: Vec<PhotonFeature>,
}

#[derive(Debug, Default, Deserialize)]
struct PhotonFeature {
    #[serde(default)]
    geometry: PhotonGeometry,
    #[serde(default)]
    properties: PhotonProperties,
}

#[derive(Debug, Default, Deserialize)]
struct PhotonGeometry {
    #[serde(default)]
    coordinates: Vec<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct PhotonProperties {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    street: Option<String>,
    #[serde(default)]
    housenumber: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    district: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    postcode: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    osm_value: Option<String>,
    #[serde(default)]
    osm_id: Option<Value>,
    #[serde(default)]
    osm_type: Option<String>,
    /// Photon's object type (`house`, `city`, `state`, ...).
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Parses a Photon `{"features":[{"properties":{...}}]}` body.
fn parse_photon(body: &str) -> Result<Vec<PlaceSuggestion>, serde_json::Error> {
    let parsed: PhotonResponse = serde_json::from_str(body)?;
    Ok(finish(
        parsed
            .features
            .into_iter()
            .filter_map(photon_suggestion)
            .collect(),
    ))
}

fn photon_suggestion(feature: PhotonFeature) -> Option<PlaceSuggestion> {
    let properties = feature.properties;
    let name = non_empty(properties.name.as_deref());
    let street = non_empty(properties.street.as_deref()).unwrap_or_default();
    let housenumber = non_empty(properties.housenumber.as_deref()).unwrap_or_default();

    let mut parts = Vec::new();
    push_part(&mut parts, name);
    if street.is_empty() {
        push_part(&mut parts, non_empty(Some(housenumber)));
    } else if name.is_some_and(|name| same_text(name, street)) {
        // `name` is the street already; only the house number is new.
        push_part(&mut parts, non_empty(Some(housenumber)));
    } else {
        let combined = if housenumber.is_empty() {
            street.to_owned()
        } else {
            format!("{street} {housenumber}")
        };
        push_part(&mut parts, Some(&combined));
    }
    push_part(&mut parts, non_empty(properties.city.as_deref()));
    push_part(&mut parts, non_empty(properties.district.as_deref()));
    push_part(&mut parts, non_empty(properties.state.as_deref()));
    push_part(&mut parts, non_empty(properties.country.as_deref()));

    if parts.is_empty() {
        return None;
    }
    let label = parts.join(", ");
    let hint = non_empty(properties.postcode.as_deref())
        .or_else(|| non_empty(properties.osm_value.as_deref()))
        .unwrap_or_default();

    // GeoJSON order is [lon, lat].
    let (lon, lat) = match feature.geometry.coordinates.as_slice() {
        [lon, lat, ..] => (Some(*lon), Some(*lat)),
        _ => (None, None),
    };
    let provider_ref = match (
        non_empty(properties.osm_type.as_deref()),
        scalar_text(properties.osm_id.as_ref()),
    ) {
        (Some(kind), Some(id)) => Some(format!("{kind}{id}")),
        (_, Some(id)) => Some(id),
        _ => None,
    };
    let point = provider_point(
        lat,
        lon,
        photon_precision(properties.kind.as_deref()),
        PlaceSource::Photon,
        provider_ref,
        &label,
    );

    Some(PlaceSuggestion {
        label,
        hint: hint.to_owned(),
        source: "photon".to_owned(),
        point,
        historical: false,
    })
}

#[derive(Debug, Default, Deserialize)]
struct DadataResponse {
    #[serde(default)]
    suggestions: Vec<DadataSuggestion>,
}

#[derive(Debug, Default, Deserialize)]
struct DadataSuggestion {
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    unrestricted_value: Option<String>,
    #[serde(default)]
    data: DadataData,
}

#[derive(Debug, Default, Deserialize)]
struct DadataData {
    #[serde(default)]
    postal_code: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    settlement: Option<String>,
    #[serde(default)]
    geo_lat: Option<String>,
    #[serde(default)]
    geo_lon: Option<String>,
    #[serde(default)]
    fias_id: Option<String>,
    #[serde(default)]
    kladr_id: Option<String>,
    /// DaData address quality code; higher means a coarser object.
    #[serde(default)]
    qc_geo: Option<i64>,
}

/// Conservative mapping of DaData's quality code to map precision. A missing
/// code falls back to the most specific populated address part.
fn dadata_precision(data: &DadataData) -> PlacePrecision {
    match data.qc_geo {
        Some(0..=2) => PlacePrecision::Point,
        Some(3 | 4) => PlacePrecision::Settlement,
        Some(5) => PlacePrecision::Region,
        Some(8) => PlacePrecision::Country,
        _ => {
            if data.city.is_some() || data.settlement.is_some() {
                PlacePrecision::Settlement
            } else if data.region.is_some() {
                PlacePrecision::Region
            } else if data.country.is_some() {
                PlacePrecision::Country
            } else {
                PlacePrecision::Unknown
            }
        }
    }
}

/// Parses a DaData `{"suggestions":[...]}` body. Addresses are modern, not
/// historical: a suggestion is never presented as the historical place.
fn parse_dadata(body: &str) -> Result<Vec<PlaceSuggestion>, serde_json::Error> {
    let parsed: DadataResponse = serde_json::from_str(body)?;
    Ok(finish(
        parsed
            .suggestions
            .into_iter()
            .filter_map(dadata_suggestion)
            .collect(),
    ))
}

fn dadata_suggestion(suggestion: DadataSuggestion) -> Option<PlaceSuggestion> {
    let label = non_empty(suggestion.value.as_deref())
        .or_else(|| non_empty(suggestion.unrestricted_value.as_deref()))?;
    let hint = non_empty(suggestion.data.postal_code.as_deref())
        .or_else(|| non_empty(suggestion.data.country.as_deref()))
        .unwrap_or_default();
    let lat = non_empty(suggestion.data.geo_lat.as_deref()).and_then(|value| value.parse().ok());
    let lon = non_empty(suggestion.data.geo_lon.as_deref()).and_then(|value| value.parse().ok());
    let provider_ref = non_empty(suggestion.data.fias_id.as_deref())
        .or_else(|| non_empty(suggestion.data.kladr_id.as_deref()))
        .map(str::to_owned);
    let point = provider_point(
        lat,
        lon,
        dadata_precision(&suggestion.data),
        PlaceSource::Dadata,
        provider_ref,
        label,
    );
    Some(PlaceSuggestion {
        label: label.to_owned(),
        hint: hint.to_owned(),
        source: "dadata".to_owned(),
        point,
        historical: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggestion(label: &str, source: &str) -> PlaceSuggestion {
        PlaceSuggestion {
            label: label.to_owned(),
            hint: String::new(),
            source: source.to_owned(),
            point: None,
            historical: false,
        }
    }

    fn point(lat: f64, lon: f64) -> PlaceGeo {
        PlaceGeo::new(lat, lon, PlacePrecision::Settlement, PlaceSource::Photon)
            .expect("valid point")
    }

    const PHOTON_STREET: &str = r#"{
        "features": [{
            "properties": {
                "name": "Тверская улица",
                "street": "Тверская улица",
                "housenumber": "1",
                "city": "Москва",
                "district": "Тверской",
                "state": "Москва",
                "postcode": "125009",
                "country": "Россия",
                "osm_value": "house"
            }
        }]
    }"#;

    #[test]
    fn photon_builds_a_readable_label_from_unique_parts() {
        let suggestions = parse_photon(PHOTON_STREET).expect("parse photon");

        assert_eq!(suggestions.len(), 1);
        assert_eq!(
            suggestions[0].label,
            "Тверская улица, 1, Москва, Тверской, Россия"
        );
        assert_eq!(suggestions[0].hint, "125009");
        assert_eq!(suggestions[0].source, "photon");
    }

    #[test]
    fn photon_keeps_a_distinct_name_and_street() {
        let body = r#"{"features":[{"properties":{
            "name":"Дом культуры","street":"Тверская улица","housenumber":"7",
            "city":"Москва","country":"Россия"
        }}]}"#;

        let suggestions = parse_photon(body).expect("parse photon");

        assert_eq!(
            suggestions[0].label,
            "Дом культуры, Тверская улица 7, Москва, Россия"
        );
    }

    #[test]
    fn photon_falls_back_to_osm_value_when_there_is_no_postcode() {
        let body = r#"{"features":[{"properties":{
            "name":"Брестская крепость","city":"Брест","country":"Беларусь","osm_value":"castle"
        }}]}"#;

        let suggestions = parse_photon(body).expect("parse photon");

        assert_eq!(suggestions[0].hint, "castle");
    }

    #[test]
    fn photon_ignores_empty_features_and_empty_properties() {
        assert!(parse_photon(r#"{"features":[]}"#)
            .expect("parse")
            .is_empty());
        assert!(parse_photon(r#"{"features":[{"properties":{}}]}"#)
            .expect("parse")
            .is_empty());
        assert!(parse_photon("{}").expect("parse").is_empty());
    }

    const DADATA_RESPONSE: &str = r#"{
        "suggestions": [{
            "value": "г Москва, ул Тверская, д 1",
            "unrestricted_value": "125009, г Москва, ул Тверская, д 1",
            "data": { "postal_code": "125009", "country": "Россия" }
        }]
    }"#;

    #[test]
    fn dadata_prefers_value_and_uses_the_postal_code_as_hint() {
        let suggestions = parse_dadata(DADATA_RESPONSE).expect("parse dadata");

        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].label, "г Москва, ул Тверская, д 1");
        assert_eq!(suggestions[0].hint, "125009");
        assert_eq!(suggestions[0].source, "dadata");
    }

    #[test]
    fn dadata_falls_back_to_unrestricted_value_and_country() {
        let body = r#"{"suggestions":[{
            "value":"",
            "unrestricted_value":"Москва, Россия",
            "data":{"postal_code":"","country":"Россия"}
        }]}"#;

        let suggestions = parse_dadata(body).expect("parse dadata");

        assert_eq!(suggestions[0].label, "Москва, Россия");
        assert_eq!(suggestions[0].hint, "Россия");
    }

    #[test]
    fn dadata_skips_suggestions_without_any_label_and_empty_lists() {
        let body = r#"{"suggestions":[{"value":null,"unrestricted_value":"  ","data":{}}]}"#;
        assert!(parse_dadata(body).expect("parse").is_empty());
        assert!(parse_dadata(r#"{"suggestions":[]}"#)
            .expect("parse")
            .is_empty());
        assert!(parse_dadata("{}").expect("parse").is_empty());
    }

    #[test]
    fn merge_keeps_the_first_provider_order() {
        let merged = merge_suggestions(
            vec![suggestion("Москва, Тверская 1", "dadata")],
            vec![suggestion("Moscow, Tverskaya 1", "photon")],
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].source, "dadata");
        assert_eq!(merged[1].source, "photon");
    }

    #[test]
    fn merge_dedupes_by_normalized_label_and_keeps_the_first_source() {
        let merged = merge_suggestions(
            vec![suggestion("  Тверская   улица, 1 ", "dadata")],
            vec![
                suggestion("тверская улица, 1", "photon"),
                suggestion("Тверская улица, 1 ", "photon"),
            ],
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "dadata");
    }

    #[test]
    fn merge_caps_the_result_at_eight_unique_suggestions() {
        let first: Vec<_> = (0..6)
            .map(|index| suggestion(&format!("Город {index}"), "dadata"))
            .collect();
        let second: Vec<_> = (0..6)
            .map(|index| suggestion(&format!("Место {index}"), "photon"))
            .collect();

        let merged = merge_suggestions(first, second);

        assert_eq!(merged.len(), MAX_SUGGESTIONS);
        assert_eq!(merged.last().expect("last").label, "Место 1");
    }

    #[test]
    fn cyrillic_detection_covers_russian_ukrainian_and_belarusian() {
        assert!(has_cyrillic("Москва"));
        assert!(has_cyrillic("Київ"));
        assert!(has_cyrillic("Мінск"));
        assert!(has_cyrillic("вул. Хрещатик 1"));
        assert!(!has_cyrillic("Moscow"));
        assert!(!has_cyrillic("Minsk"));
        assert!(!has_cyrillic("12 Tverskaya St"));
    }

    #[test]
    fn query_normalization_trims_rejects_short_input_and_caps_length() {
        assert_eq!(normalize_query("  Москва  ").as_deref(), Some("Москва"));
        assert_eq!(normalize_query(" ab "), None);
        assert_eq!(normalize_query(""), None);
        assert_eq!(normalize_query("   "), None);

        let long = "я".repeat(MAX_QUERY_CHARS + 50);
        let capped = normalize_query(&long).expect("long query is kept");
        assert_eq!(capped.chars().count(), MAX_QUERY_CHARS);
    }

    #[test]
    fn unavailable_errors_never_echo_the_query_or_the_key() {
        let error = unavailable();

        assert_eq!(error.code, codes::GEOCODER_UNAVAILABLE);
        assert_eq!(error.message, "Address suggestions are unavailable");
        assert!(error.params.is_empty());
        assert!(error.details.is_empty());
        assert!(!error.message.contains("Москва"));
        assert!(!error.message.contains("Token"));
    }

    #[test]
    fn photon_carries_the_point_and_provider_ref() {
        let body = r#"{"features":[{
            "geometry":{"type":"Point","coordinates":[49.1234,57.4321]},
            "properties":{
                "name":"Ивановка","type":"village",
                "city":"Ивановка","country":"Россия",
                "osm_type":"N","osm_id":12345
            }
        }]}"#;

        let suggestions = parse_photon(body).expect("parse photon");
        let point = suggestions[0].point.as_ref().expect("point");

        assert_eq!(point.lat, 57.4321);
        assert_eq!(point.lon, 49.1234);
        assert_eq!(point.precision, PlacePrecision::Settlement);
        assert_eq!(point.source, PlaceSource::Photon);
        assert_eq!(point.provider_ref.as_deref(), Some("N12345"));
        assert_eq!(point.label.as_deref(), Some("Ивановка, Россия"));
    }

    #[test]
    fn photon_without_geometry_keeps_the_text_suggestion() {
        let suggestions = parse_photon(PHOTON_STREET).expect("parse photon");
        assert!(suggestions[0].point.is_none());
        assert!(!suggestions[0].label.is_empty());
    }

    #[test]
    fn photon_out_of_range_coordinates_drop_only_the_point() {
        let body = r#"{"features":[{
            "geometry":{"coordinates":[200.0,95.0]},
            "properties":{"name":"Ивановка","type":"city","country":"Россия"}
        }]}"#;

        let suggestions = parse_photon(body).expect("parse photon");
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].label, "Ивановка, Россия");
        assert!(suggestions[0].point.is_none());
    }

    #[test]
    fn dadata_carries_the_point_and_parses_numeric_strings() {
        let body = r#"{"suggestions":[{
            "value":"Ивановка, Кировская область",
            "unrestricted_value":"Ивановка, Кировская область, Россия",
            "data":{
                "geo_lat":"57.4321","geo_lon":"49.1234",
                "fias_id":"fias-1","qc_geo":3,
                "region":"Кировская область"
            }
        }]}"#;

        let suggestions = parse_dadata(body).expect("parse dadata");
        let point = suggestions[0].point.as_ref().expect("point");

        assert_eq!(point.lat, 57.4321);
        assert_eq!(point.lon, 49.1234);
        assert_eq!(point.precision, PlacePrecision::Settlement);
        assert_eq!(point.source, PlaceSource::Dadata);
        assert_eq!(point.provider_ref.as_deref(), Some("fias-1"));
    }

    #[test]
    fn dadata_bad_coordinates_keep_the_text_suggestion() {
        let body = r#"{"suggestions":[{
            "value":"Ивановка",
            "data":{"geo_lat":"north","geo_lon":"49.1","qc_geo":3}
        }]}"#;

        let suggestions = parse_dadata(body).expect("parse dadata");
        assert_eq!(suggestions.len(), 1);
        assert!(suggestions[0].point.is_none());
    }

    #[test]
    fn merge_fills_a_missing_point_from_a_duplicate() {
        let first = suggestion("Ивановка", "dadata");
        let mut second = suggestion("  ивановка ", "photon");
        second.point = Some(point(57.0, 49.0));

        let merged = merge_suggestions(vec![first], vec![second]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "dadata");
        assert!(merged[0].point.is_some());
    }

    const WIKIDATA_SEARCH: &str = r#"{
        "search": [
            {"id": "Q891"},
            {"id": "Q1517187"},
            {"id": "Q5"},
            {"id": ""}
        ]
    }"#;

    const WIKIDATA_ENTITIES: &str = r#"{
        "entities": {
            "Q891": {
                "labels": {"ru": {"value": "Нижний Новгород"}},
                "descriptions": {"ru": {"value": "город в России"}},
                "claims": {
                    "P625": [{"mainsnak": {"datavalue": {"value": {
                        "latitude": 56.3269, "longitude": 44.0059
                    }}}}],
                    "P31": [{"mainsnak": {"datavalue": {"value": {"id": "Q515"}}}}]
                }
            },
            "Q1517187": {
                "labels": {"ru": {"value": "Горький"}},
                "claims": {
                    "P31": [{"mainsnak": {"datavalue": {"value": {"id": "Q5"}}}}]
                }
            },
            "Q5": {
                "labels": {"ru": {"value": "человек"}}
            }
        }
    }"#;

    #[test]
    fn wikidata_resolves_a_historical_name_to_the_modern_place() {
        let ids = parse_wikidata_ids(WIKIDATA_SEARCH).expect("ids");
        assert_eq!(ids, vec!["Q891", "Q1517187", "Q5"]);

        let suggestions = parse_wikidata_entities(WIKIDATA_ENTITIES, &ids, "ru").expect("entities");
        assert_eq!(suggestions.len(), 1);
        let suggestion = &suggestions[0];
        assert_eq!(suggestion.label, "Нижний Новгород");
        assert_eq!(suggestion.hint, "город в России");
        assert_eq!(suggestion.source, "wikidata");
        let point = suggestion.point.as_ref().expect("point");
        assert_eq!(point.source, PlaceSource::Wikidata);
        assert_eq!(point.precision, PlacePrecision::Settlement);
        assert_eq!(point.provider_ref.as_deref(), Some("Q891"));
        assert_eq!(point.label.as_deref(), Some("Нижний Новгород"));
        assert!((point.lat - 56.3269).abs() < f64::EPSILON);
    }

    #[test]
    fn contextual_modern_results_come_before_the_original_query() {
        let mut contextual = suggestion("улица Максима Горького, Нижний Новгород", "photon");
        contextual.historical = true;
        let original = suggestion("улица Горького, Казань", "photon");

        let merged =
            merge_contextual_modern(Some(vec![original]), Some(vec![contextual])).expect("merged");

        assert_eq!(merged[0].label, "улица Максима Горького, Нижний Новгород");
        assert!(merged[0].historical);
        assert_eq!(merged[1].label, "улица Горького, Казань");
    }

    #[test]
    fn leading_place_splits_a_historical_city_from_the_address() {
        assert_eq!(
            leading_place("Горький улица Горького"),
            Some(("Горький".to_owned(), "улица Горького".to_owned()))
        );
        assert_eq!(
            leading_place("гор. Горький, ул. Горького"),
            Some(("Горький".to_owned(), "ул. Горького".to_owned()))
        );
        assert_eq!(
            leading_place("Нижний Новгород, проспект Ленина"),
            Some(("Нижний Новгород".to_owned(), "проспект Ленина".to_owned()))
        );
    }

    #[test]
    fn leading_place_ignores_queries_without_a_city_or_remainder() {
        assert_eq!(leading_place("Горький"), None);
        assert_eq!(leading_place("проспект Ленина"), None);
        assert_eq!(leading_place("улица Горького, Казань"), None);
        assert_eq!(leading_place("  "), None);
    }

    #[test]
    fn wikidata_resolves_streets_and_avenues_as_points() {
        let body = r#"{"entities":{
            "Q4471947":{
                "labels":{"ru":{"value":"Улица Горького"}},
                "descriptions":{"ru":{"value":"улица в Казани"}},
                "claims":{
                    "P625":[{"mainsnak":{"datavalue":{"value":{"latitude":55.79,"longitude":49.12}}}}],
                    "P31":[{"mainsnak":{"datavalue":{"value":{"id":"Q79007"}}}}]
                }
            },
            "Q2138098":{
                "labels":{"ru":{"value":"Проспект Ленина"}},
                "descriptions":{"ru":{"value":"улица в Екатеринбурге"}},
                "claims":{
                    "P625":[{"mainsnak":{"datavalue":{"value":{"latitude":56.84,"longitude":60.61}}}}],
                    "P31":[{"mainsnak":{"datavalue":{"value":{"id":"Q907698"}}}}]
                }
            }
        }}"#;

        let suggestions =
            parse_wikidata_entities(body, &["Q4471947".to_owned(), "Q2138098".to_owned()], "ru")
                .expect("entities");

        assert_eq!(suggestions.len(), 2);
        for suggestion in &suggestions {
            let point = suggestion.point.as_ref().expect("point");
            assert_eq!(point.precision, PlacePrecision::Point);
            assert_eq!(point.source, PlaceSource::Wikidata);
        }
    }

    #[test]
    fn wikidata_skips_non_places_and_missing_coordinates() {
        let ids = vec!["Q1517187".to_owned(), "Q5".to_owned()];
        assert!(parse_wikidata_entities(WIKIDATA_ENTITIES, &ids, "ru")
            .expect("entities")
            .is_empty());
    }

    #[test]
    fn wikidata_labels_fall_back_to_russian_then_english() {
        let body = r#"{"entities":{"Q1":{
            "labels":{"en":{"value":"Nizhny Novgorod"}},
            "descriptions":{"en":{"value":"city in Russia"}},
            "claims":{
                "P625":[{"mainsnak":{"datavalue":{"value":{"latitude":56.3,"longitude":44.0}}}}],
                "P31":[{"mainsnak":{"datavalue":{"value":{"id":"Q515"}}}}]
            }
        }}}"#;
        let suggestions =
            parse_wikidata_entities(body, &["Q1".to_owned()], "de").expect("entities");
        assert_eq!(suggestions[0].label, "Nizhny Novgorod");
        assert_eq!(suggestions[0].hint, "city in Russia");
    }

    #[test]
    fn wikidata_rejects_malformed_bodies() {
        assert!(parse_wikidata_ids("not json").is_err());
        assert!(parse_wikidata_entities("not json", &[], "ru").is_err());
    }

    #[test]
    fn suggestions_fall_back_between_modern_and_historical() {
        let modern = vec![suggestion("Нижний Новгород, Россия", "photon")];
        let historical = vec![suggestion("Нижний Новгород", "wikidata")];

        assert_eq!(
            combine_suggestions(None, None)
                .expect_err("both failed")
                .code,
            codes::GEOCODER_UNAVAILABLE
        );
        assert_eq!(
            combine_suggestions(Some(modern.clone()), None)
                .expect("modern")
                .len(),
            1
        );
        assert_eq!(
            combine_suggestions(None, Some(historical.clone()))
                .expect("historical")
                .len(),
            1
        );
        let merged = combine_suggestions(Some(modern), Some(historical)).expect("both");
        assert_eq!(merged[0].source, "wikidata");
        assert_eq!(merged[1].source, "photon");
    }
}
