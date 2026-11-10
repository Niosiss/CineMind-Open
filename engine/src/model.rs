use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Stable lowercase English genre slugs used by the ranking feature axes.
///
/// The engine intentionally keeps this list small and fixed: ranking weights
/// are positional, so adding or reordering an axis would change learned model
/// meaning. Extra descriptive metadata genres are still retained on items and
/// profiles, but they do not become ML features.
pub const GENRES: [&str; 11] = [
    "action",
    "comedy",
    "drama",
    "romance",
    "thriller",
    "mystery",
    "fantasy",
    "sci-fi",
    "animation",
    "adventure",
    "horror",
];

/// Normalizes any user or catalog genre spelling to a canonical slug.
///
/// Unknown but well-formed slugs are retained so descriptive metadata such as
/// `crime`, `sports`, `slice-of-life`, or `psychological` survives. Empty,
/// garbage, and sentinel values are rejected.
pub fn normalize_genre(value: &str) -> Option<String> {
    crate::taxonomy::canonical_slug(value)
}

/// Normalizes, filters, and de-duplicates a genre list while preserving the
/// caller's order.
pub fn normalize_genres(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        if let Some(genre) = normalize_genre(value) {
            if seen.insert(genre.clone()) {
                out.push(genre);
            }
        }
    }
    out
}

/// Free-text preferences are bounded in Unicode scalar values (characters),
/// not bytes, so Turkish and other non-ASCII input counts predictably.
pub const MAX_PREFERENCES_CHARS: usize = 2000;

pub fn normalize_preferences(value: &str) -> String {
    value
        .trim()
        .chars()
        .take(MAX_PREFERENCES_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Ratings are optional metadata. Values outside 0..=10 are clamped, and
/// non-finite values are discarded rather than invented.
pub fn sanitize_rating(rating: Option<f64>) -> Option<f64> {
    rating
        .filter(|value| value.is_finite())
        .map(|value| (value.clamp(0.0, 10.0) * 10.0).round() / 10.0)
}

/// One rating in its original scale.
///
/// `value` and `scale` are the source's native units, e.g. 8.4/10 or 4.2/5.
/// `votes` is the source's vote count when known. The engine does not map,
/// validate, or fetch ratings from any outside service; the browser supplies
/// this metadata verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRating {
    pub source: String,
    pub value: f64,
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub votes: Option<u64>,
}

impl ExternalRating {
    /// Generic native-scale to 0..=10 conversion. Returns `None` for invalid
    /// or non-positive scales and for non-finite values.
    pub fn normalized_rating(&self) -> Option<f64> {
        if !self.value.is_finite() || !self.scale.is_finite() || self.scale <= 0.0 {
            return None;
        }
        sanitize_rating(Some(self.value / self.scale * 10.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Relax,
    Uplift,
    Think,
    Thrill,
    Feel,
}

impl Mood {
    pub const ALL: [Mood; 5] = [
        Mood::Relax,
        Mood::Uplift,
        Mood::Think,
        Mood::Thrill,
        Mood::Feel,
    ];

    pub fn index(self) -> usize {
        match self {
            Mood::Relax => 0,
            Mood::Uplift => 1,
            Mood::Think => 2,
            Mood::Thrill => 3,
            Mood::Feel => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mood::Relax => "relax",
            Mood::Uplift => "uplift",
            Mood::Think => "think",
            Mood::Thrill => "thrill",
            Mood::Feel => "feel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Movie,
    Series,
    Anime,
}

impl Kind {
    pub fn index(self) -> usize {
        match self {
            Kind::Movie => 0,
            Kind::Series => 1,
            Kind::Anime => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Movie => "movie",
            Kind::Series => "series",
            Kind::Anime => "anime",
        }
    }

    pub fn from_catalog(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "movie" | "movies" | "film" | "films" | "filmler" => Some(Kind::Movie),
            "series" | "show" | "shows" | "tv" | "dizi" | "diziler" => Some(Kind::Series),
            "anime" | "animation-series" | "animeler" => Some(Kind::Anime),
            _ => None,
        }
    }
}

/// One catalog row supplied by the browser adapter.
///
/// The wire shape is camelCase. `sourceUrl`, `posterUrl`, and `ratings` are
/// carried through unchanged as local metadata; the engine never fetches them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub year: i32,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub poster_url: Option<String>,
    #[serde(default)]
    pub rating: Option<f64>,
    #[serde(default)]
    pub rating_source: Option<String>,
    #[serde(default)]
    pub rating_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratings: Vec<ExternalRating>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub genres: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub preferences: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub year: i32,
    pub genres: Vec<String>,
    pub description: String,
    pub reason: String,
    pub source_url: String,
    pub score: f64,
    pub poster_url: Option<String>,
    pub rating: Option<f64>,
    pub rating_source: Option<String>,
    pub rating_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratings: Vec<ExternalRating>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn genre_normalization_keeps_known_aliases_and_unknown_metadata() {
        assert_eq!(normalize_genre("Science Fiction").as_deref(), Some("sci-fi"));
        assert_eq!(normalize_genre("romantic").as_deref(), Some("romance"));
        assert_eq!(normalize_genre("Komedi").as_deref(), Some("comedy"));
        assert_eq!(normalize_genre("cyberpunk").as_deref(), Some("cyberpunk"));
        assert_eq!(normalize_genre("unknown"), None);
        assert_eq!(
            normalize_genres(&[
                "Drama".to_string(),
                "drama".to_string(),
                "Sci Fi".to_string(),
                "unknown".to_string(),
            ]),
            vec!["drama".to_string(), "sci-fi".to_string()]
        );
    }

    #[test]
    fn ratings_are_clamped_or_dropped_never_invented() {
        assert_eq!(sanitize_rating(Some(f64::NAN)), None);
        assert_eq!(sanitize_rating(Some(f64::INFINITY)), None);
        assert_eq!(sanitize_rating(Some(-2.0)), Some(0.0));
        assert_eq!(sanitize_rating(Some(12.0)), Some(10.0));
        assert_eq!(sanitize_rating(Some(7.46)), Some(7.5));

        let rating = ExternalRating {
            source: "sample".to_string(),
            value: 8.4,
            scale: 10.0,
            votes: Some(10),
        };
        assert_eq!(rating.normalized_rating(), Some(8.4));
        let invalid = ExternalRating {
            source: "sample".to_string(),
            value: 8.4,
            scale: 0.0,
            votes: None,
        };
        assert_eq!(invalid.normalized_rating(), None);
    }

    #[test]
    fn catalog_item_serde_uses_camel_case_and_skips_empty_ratings() {
        let value = json!({
            "id": "example-1",
            "title": "Example Story",
            "kind": "movie",
            "year": 2020,
            "genres": ["drama"],
            "description": "",
            "sourceUrl": ""
        });
        let item: CatalogItem = serde_json::from_value(value).expect("deserialize");
        assert!(item.ratings.is_empty());
        let serialized = serde_json::to_value(&item).expect("serialize");
        assert!(serialized.get("ratings").is_none());
        assert!(serialized.get("sourceUrl").is_some());
    }

    #[test]
    fn mood_and_kind_wire_values_stay_lowercase() {
        let mood: Mood = serde_json::from_value(json!("thrill")).expect("mood");
        assert_eq!(mood, Mood::Thrill);
        let kind: Kind = serde_json::from_value(json!("series")).expect("kind");
        assert_eq!(kind, Kind::Series);
        assert_eq!(Kind::from_catalog("tv"), Some(Kind::Series));
        assert_eq!(Kind::from_catalog("dizi"), Some(Kind::Series));
    }
}
