//! Offline recommendation engine exposed to the browser through wasm-bindgen.
//!
//! There is no HTTP server, no network client, no provider list, and no
//! bundled catalog in this crate. The JavaScript adapter owns the local
//! catalog, browser state, library, and exclusion ids, then sends plain JSON
//! here for ranking or one training step.

#![forbid(unsafe_code)]

mod model;
mod ranking;
mod tastes;
mod taxonomy;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use model::{normalize_preferences, CatalogItem, Kind, Mood, Profile};
use taxonomy::GenreOption;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankInput {
    items: Vec<CatalogItem>,
    profile: Profile,
    mood: Mood,
    kind: Kind,
    #[serde(default)]
    weights: Vec<f64>,
    #[serde(default)]
    feedback_count: u64,
    #[serde(default)]
    request_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainInput {
    item: CatalogItem,
    mood: Mood,
    #[serde(default)]
    weights: Vec<f64>,
    liked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenresResponse {
    items: Vec<GenreOption>,
    source: &'static str,
}

fn json_error(context: &str, error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{context}: {error}"))
}

/// Rank every eligible catalog item for one request.
///
/// Input (camelCase JSON):
/// `{items, profile, mood, kind, weights, feedbackCount, requestText?}`.
///
/// The returned JSON is the complete ranked array for the available items.
/// The engine applies no page cap; the browser handles pagination.
#[wasm_bindgen]
pub fn rank_json(input: &str) -> Result<String, JsValue> {
    let input: RankInput =
        serde_json::from_str(input).map_err(|error| json_error("invalid rank input", error))?;

    // There is deliberately no fixed 12-item ceiling here. Passing the full
    // available count keeps every eligible item in the response.
    let limit = input.items.len().max(1);
    let request_text = input
        .request_text
        .as_deref()
        .map(normalize_preferences)
        .filter(|text| !text.is_empty());

    let ranked = ranking::recommend_with_request(
        &input.items,
        &input.profile,
        input.mood,
        input.kind,
        &input.weights,
        input.feedback_count,
        limit,
        request_text.as_deref(),
    );

    serde_json::to_string(&ranked).map_err(|error| json_error("could not serialize ranking", error))
}

/// Apply one regularized online training step and return the full weights.
///
/// Input (camelCase JSON): `{item, mood, weights, liked}`.
/// An empty or stale weight vector is resized to the current feature length.
#[wasm_bindgen]
pub fn train_json(input: &str) -> Result<String, JsValue> {
    let input: TrainInput =
        serde_json::from_str(input).map_err(|error| json_error("invalid train input", error))?;

    let features = ranking::item_features(&input.item, input.mood);
    let mut weights = input.weights;
    if weights.len() != ranking::FEATURE_LEN {
        weights.resize(ranking::FEATURE_LEN, 0.0);
    }
    ranking::train(&mut weights, &features, input.liked);

    serde_json::to_string(&weights).map_err(|error| json_error("could not serialize weights", error))
}

/// Return the static, bundled English genre choices.
///
/// The response is `{items: GenreOption[], source: "bundled"}`. `GenreOption`
/// keeps the existing fields, including `kinds`.
#[wasm_bindgen]
pub fn genres_json() -> Result<String, JsValue> {
    let response = GenresResponse {
        items: taxonomy::bundled_options(),
        source: "bundled",
    };
    serde_json::to_string(&response).map_err(|error| json_error("could not serialize genres", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn item(id: &str, kind: &str, genres: &[&str]) -> Value {
        json!({
            "id": id,
            "title": format!("Example {id}"),
            "kind": kind,
            "year": 2022,
            "genres": genres,
            "description": "",
            "sourceUrl": ""
        })
    }

    #[test]
    fn rank_json_returns_every_available_item_without_a_twelve_cap() {
        let items = (0..15)
            .map(|index| item(&format!("example-{index:02}"), "movie", &["drama"]))
            .collect::<Vec<_>>();
        let input = json!({
            "items": items,
            "profile": { "name": "Ada", "genres": [], "preferences": "" },
            "mood": "feel",
            "kind": "movie",
            "weights": [],
            "feedbackCount": 0
        });

        let output = rank_json(&input.to_string()).expect("rank");
        let ranked: Vec<Value> = serde_json::from_str(&output).expect("json array");
        assert_eq!(ranked.len(), 15);
        assert!(ranked.iter().all(|row| row["kind"] == "movie"));
    }

    #[test]
    fn rank_json_uses_english_reasons_and_request_cues() {
        let input = json!({
            "items": [
                item("both", "anime", &["drama", "romance"]),
                item("drama-only", "anime", &["drama"]),
                item("horror", "anime", &["horror"]),
            ],
            "profile": { "name": "Ada", "genres": [], "preferences": "" },
            "mood": "feel",
            "kind": "anime",
            "weights": [],
            "feedbackCount": 0,
            "requestText": "emotional, romantic"
        });

        let output = rank_json(&input.to_string()).expect("rank");
        let ranked: Vec<Value> = serde_json::from_str(&output).expect("json array");
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0]["id"], "both");
        let reason = ranked[0]["reason"].as_str().expect("reason");
        assert!(reason.contains("Drama"));
        assert!(reason.contains("Romance"));
        assert!(reason.contains("request"));
    }

    #[test]
    fn train_json_resizes_empty_weights_and_returns_the_full_vector() {
        let input = json!({
            "item": item("example", "movie", &["action"]),
            "mood": "thrill",
            "weights": [],
            "liked": true
        });

        let output = train_json(&input.to_string()).expect("train");
        let weights: Vec<f64> = serde_json::from_str(&output).expect("weights");
        assert_eq!(weights.len(), ranking::FEATURE_LEN);
        assert!(weights.iter().any(|weight| *weight != 0.0));
    }

    #[test]
    fn genres_json_is_offline_and_keeps_existing_fields() {
        let output = genres_json().expect("genres");
        let response: Value = serde_json::from_str(&output).expect("json object");
        assert_eq!(response["source"], "bundled");
        let items = response["items"].as_array().expect("items");
        assert!(!items.is_empty());
        assert!(items.iter().all(|row| {
            row.get("id").is_some()
                && row.get("label").is_some()
                && row.get("originalLabel").is_some()
                && row.get("group").is_some()
                && row.get("kinds").is_some()
                && row.get("sources").is_some()
        }));
        assert!(items.iter().all(|row| row["sources"] == json!(["bundled"])));
    }
}
