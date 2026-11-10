use std::collections::HashMap;

use crate::model::{CatalogItem, Kind, Mood, Profile, Recommendation, GENRES};
use crate::tastes::{normalize_for_search, TasteMatch, TasteProfile};
use crate::taxonomy;

const GENRE_COUNT: usize = GENRES.len();
const MOOD_COUNT: usize = 5;
const KIND_COUNT: usize = 3;
const ERA_COUNT: usize = 6;

const GENRE_START: usize = 1;
const MOOD_GENRE_START: usize = GENRE_START + GENRE_COUNT;
const KIND_START: usize = MOOD_GENRE_START + MOOD_COUNT * GENRE_COUNT;
const ERA_START: usize = KIND_START + KIND_COUNT;

pub const FEATURE_LEN: usize = ERA_START + ERA_COUNT;

const LEARNING_RATE: f64 = 0.22;
const L2_REGULARIZATION: f64 = 0.008;
const LEARNED_WEIGHT: f64 = 0.85;
const DIVERSITY_GENRE_PENALTY: f64 = 0.18;
const DIVERSITY_PRIMARY_PENALTY: f64 = 0.12;

/// How strongly stated preferences (free-text tastes) move the final score.
const TASTE_WEIGHT: f64 = 0.30;
/// A genre the user explicitly disliked is a hard constraint: matched items are
/// pushed down far enough to rarely surface unless nothing else is available.
const HARD_NEGATIVE_PENALTY: f64 = 1.00;

/// Session-first blend (usable request intent only). Both channels are
/// normalized and bounded to 0..1 so learned weights can never grow
/// without bound. `final = 0.85 * session + 0.15 * baseline`.
const SESSION_WEIGHT: f64 = 0.85;
const BASELINE_WEIGHT: f64 = 0.15;
/// Inside the session channel: genre coverage dominates theme terms.
/// Term evidence can never let a partial-genre item overtake full
/// coverage, and a request need not match all subjective terms.
const SESSION_GENRE_WEIGHT: f64 = 0.85;
const SESSION_TERM_WEIGHT: f64 = 0.15;
/// Diversity in session mode is a tie-breaker inside a relevance tier,
/// not a re-ranker across tiers. It is scaled down so a pure-unrelated
/// genre (session 0) cannot displace a matching item via penalties.
const SESSION_DIVERSITY_SCALE: f64 = 0.20;

/// Hand-written mood/genre affinity used before (and alongside) learned
/// preference weights. This is the cold-start signal: no external model, no
/// network, deterministic and inspectable.
const MOOD_GENRE_AFFINITY: [[f64; GENRE_COUNT]; MOOD_COUNT] = [
    // action, comedy, drama, romance, thriller, mystery, fantasy, sci-fi, animation, adventure, horror
    [
        0.20, 0.95, 0.35, 0.55, 0.05, 0.25, 0.55, 0.20, 0.80, 0.50, 0.00,
    ], // relax
    [
        0.55, 1.00, 0.25, 0.50, 0.20, 0.10, 0.65, 0.25, 0.75, 0.70, 0.00,
    ], // uplift
    [
        0.20, 0.25, 0.70, 0.30, 0.60, 1.00, 0.45, 0.95, 0.25, 0.30, 0.10,
    ], // think
    [
        1.00, 0.10, 0.25, 0.05, 1.00, 0.75, 0.35, 0.55, 0.10, 0.60, 0.95,
    ], // thrill
    [
        0.15, 0.40, 1.00, 0.95, 0.15, 0.25, 0.45, 0.25, 0.60, 0.35, 0.00,
    ], // feel
];

fn genre_index(genre: &str) -> Option<usize> {
    GENRES.iter().position(|candidate| *candidate == genre)
}

fn era_index(year: i32) -> usize {
    match year {
        0 => 0,
        1..=1989 => 1,
        1990..=1999 => 2,
        2000..=2009 => 3,
        2010..=2019 => 4,
        _ => 5,
    }
}

/// Content feature vector for one item in the context of a requested mood.
pub fn item_features(item: &CatalogItem, mood: Mood) -> Vec<f64> {
    let mut features = vec![0.0; FEATURE_LEN];
    features[0] = 1.0;

    let mood_index = mood.index();
    for genre in &item.genres {
        if let Some(genre_index) = genre_index(genre) {
            features[GENRE_START + genre_index] = 1.0;
            features[MOOD_GENRE_START + mood_index * GENRE_COUNT + genre_index] = 1.0;
        }
    }

    if let Some(kind) = Kind::from_catalog(&item.kind) {
        features[KIND_START + kind.index()] = 1.0;
    }
    features[ERA_START + era_index(item.year)] = 1.0;

    features
}

pub fn dot(weights: &[f64], features: &[f64]) -> f64 {
    weights
        .iter()
        .zip(features.iter())
        .map(|(weight, feature)| weight * feature)
        .sum()
}

fn sigmoid(value: f64) -> f64 {
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let exponential = value.exp();
        exponential / (1.0 + exponential)
    }
}

/// One regularized online logistic-gradient step from explicit feedback.
/// `liked = true` moves the representation toward the item, `false` moves it
/// away. The L2 term is what keeps the model bounded over a long local history.
pub fn train(weights: &mut [f64], features: &[f64], liked: bool) {
    let prediction = sigmoid(dot(weights, features));
    let target = if liked { 1.0 } else { 0.0 };
    let error = target - prediction;

    for (index, weight) in weights.iter_mut().enumerate() {
        let feature = features.get(index).copied().unwrap_or(0.0);
        let gradient = error * feature - L2_REGULARIZATION * *weight;
        *weight += LEARNING_RATE * gradient;
    }
}

pub fn confidence(feedback_count: u64) -> f64 {
    1.0 - (-(feedback_count as f64) / 5.0).exp()
}

pub fn blended_score(cold: f64, logit: f64, feedback_count: u64) -> f64 {
    cold + LEARNED_WEIGHT * confidence(feedback_count) * logit
}

pub fn cold_score(item: &CatalogItem, mood: Mood, profile: &Profile) -> f64 {
    if item.genres.is_empty() {
        return 0.10 + recency_boost(item.year);
    }

    let affinity_row = &MOOD_GENRE_AFFINITY[mood.index()];
    let mut maximum = 0.0_f64;
    let mut sum = 0.0_f64;
    let mut counted = 0_usize;

    for genre in &item.genres {
        if let Some(index) = genre_index(genre) {
            let affinity = affinity_row[index];
            maximum = maximum.max(affinity);
            sum += affinity;
            counted += 1;
        }
    }

    let content = if counted == 0 {
        // New (non-ML-axis) genres only: neutral mood signal. The item
        // is not ignored and does not panic; profile/taste matches still
        // lift it via the boost below and TasteMatch.
        0.35
    } else {
        0.65 * maximum + 0.20 * (sum / counted as f64)
    };

    let profile_matches = item
        .genres
        .iter()
        .filter(|genre| profile.genres.iter().any(|preferred| preferred == *genre))
        .count();
    let profile_boost = (0.55 * profile_matches.min(2) as f64).min(0.90);

    0.10 + content + profile_boost + recency_boost(item.year)
}

fn recency_boost(year: i32) -> f64 {
    if year <= 0 {
        return 0.0;
    }
    (((year as f64 - 1980.0) / 50.0).clamp(0.0, 1.0)) * 0.08
}

fn round_score(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// English reason label for any canonical genre slug.
/// Delegates to the bundled taxonomy so descriptive genres (e.g. `crime`,
/// `documentary`, `sports`, `psychological`, `slice-of-life`) get honest
/// labels instead of a generic fallback or the raw slug.
fn genre_label(genre: &str) -> String {
    taxonomy::label(genre)
}

fn genre_summary(item: &CatalogItem) -> Option<String> {
    let labels = item
        .genres
        .iter()
        .take(2)
        .map(|genre| genre_label(genre))
        .collect::<Vec<_>>();
    if labels.is_empty() {
        None
    } else {
        Some(labels.join(", "))
    }
}

fn build_reason(
    item: &CatalogItem,
    mood: Mood,
    profile: &Profile,
    taste: &TasteMatch,
    learned_contribution: f64,
    feedback_count: u64,
) -> String {
    // 1. Evidence stated in the user's free-text preferences (matched genres).
    if !taste.positive_genres.is_empty() {
        let labels = taste
            .positive_genres
            .iter()
            .take(2)
            .map(|genre| genre_label(genre))
            .collect::<Vec<_>>();
        return format!("Matches your interests: {}.", labels.join(", "));
    }

    // 2. Theme terms the user mentioned, evidenced in the title or synopsis.
    if !taste.positive_terms.is_empty() {
        let terms = taste
            .positive_terms
            .iter()
            .take(2)
            .map(|term| term.label.as_str())
            .collect::<Vec<_>>();
        return format!("A good fit for your interests: {}.", terms.join(", "));
    }

    // 3. Normalized profile genres.
    let profile_labels = item
        .genres
        .iter()
        .filter(|genre| profile.genres.iter().any(|preferred| preferred == *genre))
        .take(2)
        .map(|genre| genre_label(genre))
        .collect::<Vec<_>>();
    if !profile_labels.is_empty() {
        return format!("Fits your profile: {}.", profile_labels.join(", "));
    }

    let summary = genre_summary(item);
    if feedback_count > 0 && learned_contribution > 0.18 {
        return match summary {
            Some(genres) => format!("Close to what you liked before: {genres}."),
            None => "Surfaced from your previous likes.".to_string(),
        };
    }

    match (mood, summary) {
        (Mood::Relax, Some(genres)) => format!("A calm evening pick: {genres}."),
        (Mood::Relax, None) => "A balanced pick for a calm evening.".to_string(),
        (Mood::Uplift, Some(genres)) => format!("An uplifting pick: {genres}."),
        (Mood::Uplift, None) => "A pick to lift your mood.".to_string(),
        (Mood::Think, Some(genres)) => format!("A thought-provoking pick: {genres}."),
        (Mood::Think, None) => "A story to get your mind working.".to_string(),
        (Mood::Thrill, Some(genres)) => format!("A high-thrill pick: {genres}."),
        (Mood::Thrill, None) => "A pick that will keep you on the edge of your seat.".to_string(),
        (Mood::Feel, Some(genres)) => format!("An emotionally rich pick: {genres}."),
        (Mood::Feel, None) => "A story that will move you.".to_string(),
    }
}

#[derive(Clone)]
struct Ranked<'a> {
    item: &'a CatalogItem,
    score: f64,
    learned_contribution: f64,
    taste_match: TasteMatch,
}

/// Running counts of already-selected items per genre and per primary
/// genre. The greedy loops used to rescan the whole selection for
/// every remaining candidate on every iteration (cubic in catalog
/// size); each selection now updates these counters once and the
/// penalty lookup is a hash lookup per candidate genre.
///
/// Counts match the old `.any` scan exactly: a selected item
/// contributes at most once to a given genre, even if that genre is
/// repeated in its own metadata, and a candidate's repeated genre is
/// still charged once per occurrence as before.
#[derive(Default)]
struct DiversityCounts<'a> {
    genre: HashMap<&'a str, usize>,
    primary: HashMap<&'a str, usize>,
    selected: usize,
}

impl<'a> DiversityCounts<'a> {
    fn is_empty(&self) -> bool {
        self.selected == 0
    }

    /// Record one newly selected item. Call once per greedy pick.
    fn record(&mut self, ranked: &Ranked<'a>) {
        let item = ranked.item;
        self.selected += 1;
        for (index, genre) in item.genres.iter().enumerate() {
            if item.genres[..index].contains(genre) {
                continue;
            }
            *self.genre.entry(genre.as_str()).or_insert(0) += 1;
        }
        if let Some(primary) = item.genres.first() {
            *self.primary.entry(primary.as_str()).or_insert(0) += 1;
        }
    }
}

fn diversity_penalty(genres: &[String], counts: &DiversityCounts<'_>) -> f64 {
    if counts.is_empty() {
        return 0.0;
    }

    let mut penalty = 0.0_f64;
    for genre in genres {
        let repeats = counts.genre.get(genre.as_str()).copied().unwrap_or(0);
        penalty += DIVERSITY_GENRE_PENALTY * repeats as f64;
    }

    if let Some(primary) = genres.first() {
        let primary_repeats = counts
            .primary
            .get(primary.as_str())
            .copied()
            .unwrap_or(0);
        penalty += DIVERSITY_PRIMARY_PENALTY * primary_repeats as f64;
    }

    penalty.min(0.90)
}

/// True only when the clause contains a standalone Turkish OR
/// connector (`veya`, `yahut`, or `ya da`). Substrings inside other
/// words (e.g. in "yabancı") do not count.
fn has_or_connector(text: &str) -> bool {
    let tokens = normalize_for_search(text)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    tokens.iter().any(|token| token == "veya" || token == "yahut" || token == "or")
        || tokens
            .windows(2)
            .any(|window| window[0] == "ya" && window[1] == "da")
}

/// Split for OR scoping on sentence/semicolon boundaries (comma
/// positives stay combined), plus contrast tokens (`ama`/`fakat`/…)
/// when practical. This keeps a negative OR clause such as
/// "komedi veya korku istemiyorum" from relaxing the positive
/// request in another sentence.
fn split_or_clauses(text: &str) -> Vec<String> {
    const CONTRAST: &[&str] = &[
        "ama",
        "fakat",
        "ancak",
        "lakin",
        "oysa",
        "halbuki",
        "yanliz",
        "yalniz",
        "but",
        "however",
        "though",
        "although",
        "yet",
    ];
    let mut fragments = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if matches!(ch, '.' | '!' | '?' | ';' | '\n' | '\r') {
            fragments.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fragments.push(current);
    let mut out = Vec::new();
    for fragment in fragments {
        let mut buffer: Vec<String> = Vec::new();
        for token in fragment.split_whitespace() {
            if CONTRAST.contains(&normalize_for_search(token).as_str()) {
                if !buffer.is_empty() {
                    out.push(buffer.join(" "));
                    buffer = Vec::new();
                }
            } else {
                buffer.push(token.to_string());
            }
        }
        if !buffer.is_empty() {
            out.push(buffer.join(" "));
        }
    }
    out
}

/// Scoped ANY check: an OR-containing clause enables ANY only when
/// its local parse keeps >=2 of the global positive genres and has
/// no negative genres. Ambiguous mixed clauses stay ALL.
fn clause_enables_any(text: &str, positive: &[String], negative: &[String], kind: Kind) -> bool {
    for clause in split_or_clauses(text) {
        if !has_or_connector(&clause) {
            continue;
        }
        let local = TasteProfile::parse(&clause);
        let mut local_positive = local.positive_genres().to_vec();
        let local_negative = local.negative_genres().to_vec();
        if kind == Kind::Anime {
            local_positive.retain(|genre| genre != "animation");
        }
        if !local_negative.is_empty() {
            continue;
        }
        if local_positive.iter().any(|genre| negative.contains(genre)) {
            continue;
        }
        let distinct = positive
            .iter()
            .filter(|genre| local_positive.contains(*genre))
            .count();
        if distinct >= 2 {
            return true;
        }
    }
    false
}

/// Separately parsed session-only intent from `requestText`.
///
/// The session text is never concatenated into the persisted profile
/// for ranking and never sent upstream. Generic kind words ("anime")
/// carry no discriminative signal when the request kind already
/// filters to that kind, so an `animation` cue is dropped for
/// `Kind::Anime`: bare "anime" alone is not usable intent and does
/// not match every anime item.
///
/// Multi-positive-genre relevance is ALL genres by default: the user
/// said the full mixture, so only items evidencing every requested
/// genre return. A standalone OR connector (`veya` / `ya da` /
/// `yahut`) inside a clause with >=2 global positive genres and no
/// negative genres opts that request into ANY instead, with coverage
/// priority still preserved during selection.
#[derive(Debug, Clone)]
pub struct SessionIntent {
    profile: TasteProfile,
    positive_genres: Vec<String>,
    negative_genres: Vec<String>,
    usable: bool,
    allow_any: bool,
}

impl SessionIntent {
    pub fn parse(text: &str, kind: Kind) -> Self {
        let profile = TasteProfile::parse(text);
        let mut positive = profile.positive_genres().to_vec();
        let mut negative = profile.negative_genres().to_vec();
        if kind == Kind::Anime {
            positive.retain(|genre| genre != "animation");
            negative.retain(|genre| genre != "animation");
        }
        let usable = !positive.is_empty()
            || !negative.is_empty()
            || (kind == Kind::Anime && !profile.negative_themes().is_empty());
        let allow_any = clause_enables_any(text, &positive, &negative, kind);
        Self {
            profile,
            positive_genres: positive,
            negative_genres: negative,
            usable,
            allow_any,
        }
    }

    pub fn is_usable(&self) -> bool {
        self.usable
    }

    /// Whether the request asked for alternatives (ANY) instead of
    /// the full mixture (ALL).
    pub fn allows_any(&self) -> bool {
        self.allow_any
    }

    /// A negative current-request genre excludes an item whenever the
    /// item's metadata evidences it. This is strict: a mixed
    /// romance+comedy item is excluded when comedy is explicitly
    /// negated, even if romance is positively requested. Explicit
    /// negative-theme phrases use the same shared tag-only predicate
    /// so scan and final ranking agree.
    pub fn is_excluded(&self, item: &CatalogItem) -> bool {
        if !self.usable {
            return false;
        }
        if self.profile.is_theme_excluded(item) {
            return true;
        }
        self.negative_genres
            .iter()
            .any(|genre| item.genres.iter().any(|item_genre| item_genre == genre))
    }

    /// Normalized bounded session channel in 0..1. Genre coverage
    /// dominates (`0.85 * coverage + 0.15 * term evidence`). Full
    /// requested coverage is therefore always stronger than single
    /// coverage, and no item is required to match every subjective
    /// theme term. When there are no theme terms the channel is
    /// exactly the coverage fraction.
    pub fn channel(&self, item: &CatalogItem) -> f64 {
        if !self.usable || self.is_excluded(item) {
            return 0.0;
        }
        if self.positive_genres.is_empty() {
            // Negative-only intent: every survivor satisfies it.
            return 1.0;
        }
        let matched = self
            .positive_genres
            .iter()
            .filter(|genre| item.genres.iter().any(|item_genre| item_genre == *genre))
            .count();
        let coverage = matched as f64 / self.positive_genres.len() as f64;
        let session_match = self.profile.match_item(item);
        let term_evidence = if self.profile.positive_terms().is_empty() {
            coverage
        } else {
            let denom = self.profile.positive_terms().len().min(4) as f64;
            if denom <= 0.0 {
                coverage
            } else {
                (session_match.positive_terms.len().min(4) as f64 / denom).clamp(0.0, 1.0)
            }
        };
        let mut channel = SESSION_GENRE_WEIGHT * coverage + SESSION_TERM_WEIGHT * term_evidence;
        if !session_match.negative_terms.is_empty() {
            channel -= 0.10 * (session_match.negative_terms.len().min(2) as f64 / 2.0);
        }
        channel.clamp(0.0, 1.0)
    }

    /// Requested-genre coverage fraction in 0..1 (full strongest).
    /// This is the relevance tier preserved during greedy selection,
    /// separate from the blended channel which soft terms and the
    /// baseline can pull together for 3+ genres.
    pub fn coverage(&self, item: &CatalogItem) -> f64 {
        if !self.usable || self.is_excluded(item) {
            return 0.0;
        }
        if self.positive_genres.is_empty() {
            return 1.0;
        }
        let matched = self
            .positive_genres
            .iter()
            .filter(|genre| item.genres.iter().any(|item_genre| item_genre == *genre))
            .count();
        matched as f64 / self.positive_genres.len() as f64
    }

    /// High relevance for scanning: every positively requested genre
    /// is evidenced. For negative-only intent every survivor counts,
    /// so scanning can stop once `limit` survivors exist.
    pub fn is_high_relevance(&self, item: &CatalogItem) -> bool {
        if !self.usable || self.is_excluded(item) {
            return false;
        }
        if self.positive_genres.is_empty() {
            return true;
        }
        self.positive_genres
            .iter()
            .all(|genre| item.genres.iter().any(|item_genre| item_genre == genre))
    }

    /// Relevant for the final list. By default ALL positively
    /// requested genres must be evidenced (full mixture); partial
    /// matches never fill the list. Only an explicit standalone OR
    /// connector relaxes this to ANY. Negative-only survivors are
    /// relevant. Pure-unrelated items are never relevant.
    pub fn is_relevant(&self, item: &CatalogItem) -> bool {
        if !self.usable || self.is_excluded(item) {
            return false;
        }
        if self.positive_genres.is_empty() {
            return true;
        }
        if self.allow_any {
            self.positive_genres
                .iter()
                .any(|genre| item.genres.iter().any(|item_genre| item_genre == genre))
        } else {
            self.positive_genres
                .iter()
                .all(|genre| item.genres.iter().any(|item_genre| item_genre == genre))
        }
    }
}

/// Convenience for the API scan loop and tests.
pub fn session_intent_usable(text: &str, kind: Kind) -> bool {
    SessionIntent::parse(text, kind).is_usable()
}

/// Normalized bounded baseline channel in 0..1: cold (mood + profile
/// genres) + persisted taste + learned logit, squashed through a
/// sigmoid so learned influence is strictly capped at the `0.15`
/// blend weight and saturates instead of growing with history.
fn baseline_channel(
    item: &CatalogItem,
    mood: Mood,
    profile: &Profile,
    baseline_match: &TasteMatch,
    weights: &[f64],
    learned_confidence: f64,
) -> f64 {
    let learned_contribution =
        LEARNED_WEIGHT * learned_confidence * dot(weights, &item_features(item, mood));
    let raw = cold_score(item, mood, profile)
        + learned_contribution
        + TASTE_WEIGHT * baseline_match.score;
    sigmoid(raw - 1.0).clamp(0.0, 1.0)
}

/// Session-only response ordering: requested positives first (in
/// request order), remaining original genres appended unchanged.
/// The baseline path keeps the original order verbatim.
fn ordered_session_genres(item: &CatalogItem, session: &SessionIntent) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::new();
    for genre in &session.positive_genres {
        if item.genres.iter().any(|item_genre| item_genre == genre)
            && !ordered.contains(genre)
        {
            ordered.push(genre.clone());
        }
    }
    for genre in &item.genres {
        if !ordered.contains(genre) {
            ordered.push(genre.clone());
        }
    }
    ordered
}

/// Honest session reason: names the request genres actually evidenced.
/// Never claims feel/romance suitability for a non-match.
fn build_session_reason(
    item: &CatalogItem,
    _mood: Mood,
    profile: &Profile,
    session: &SessionIntent,
    baseline_match: &TasteMatch,
    learned_contribution: f64,
    feedback_count: u64,
) -> String {
    let session_match = session.profile.match_item(item);
    // Matched request genres (effective set), in request order.
    // All matched requested positive genres are listed; the request
    // genres are already deduplicated in request order by the parser.
    let matched_labels = session
        .positive_genres
        .iter()
        .filter(|genre| item.genres.iter().any(|item_genre| item_genre == *genre))
        .map(|genre| genre_label(genre))
        .collect::<Vec<_>>();
    if !matched_labels.is_empty() {
        return format!("Matches your request: {}.", matched_labels.join(", "));
    }
    if !session_match.positive_terms.is_empty() {
        let terms = session_match
            .positive_terms
            .iter()
            .take(2)
            .map(|term| term.label.as_str())
            .collect::<Vec<_>>();
        return format!("A good fit for your request: {}.", terms.join(", "));
    }
    // No request match: do not claim feel/romance suitability. Fall
    // back to profile/learned evidence, or a neutral genre summary.
    let profile_labels = item
        .genres
        .iter()
        .filter(|genre| profile.genres.iter().any(|preferred| preferred == *genre))
        .take(2)
        .map(|genre| genre_label(genre))
        .collect::<Vec<_>>();
    if !profile_labels.is_empty() {
        return format!("Fits your profile: {}.", profile_labels.join(", "));
    }
    let _ = baseline_match;
    let _ = learned_contribution;
    let _ = feedback_count;
    let summary = genre_summary(item);
    match summary {
        Some(genres) if session.positive_genres.is_empty() => {
            // Negative-only intent: survivors satisfy the exclusion.
            format!("Compatible with your request: {genres}.")
        }
        Some(genres) => format!("A balanced pick: {genres}."),
        None => "A balanced pick.".to_string(),
    }
}

/// Underlying baseline (old) ranking: cold + learned + persisted
/// taste, then greedy diversity. Preserved exactly for no usable
/// session intent.
fn recommend_baseline(
    items: &[CatalogItem],
    profile: &Profile,
    mood: Mood,
    kind: Kind,
    weights: &[f64],
    feedback_count: u64,
    limit: usize,
) -> Vec<Recommendation> {
    let learned_confidence = confidence(feedback_count);

    // Stated free-text preferences scored against the item's title, synopsis
    // and genres. Positive cues lift the score; explicit dislikes pull it down.
    let taste_profile = TasteProfile::parse(&profile.preferences);

    let mut candidates = items
        .iter()
        .filter(|item| item.kind == kind.as_str())
        .filter(|item| !taste_profile.is_theme_excluded(item))
        .map(|item| {
            let features = item_features(item, mood);
            let logit = dot(weights, &features);
            let learned_contribution = LEARNED_WEIGHT * learned_confidence * logit;
            let taste = taste_profile.match_item(item);
            let mut score = cold_score(item, mood, profile)
                + learned_contribution
                + TASTE_WEIGHT * taste.score;
            if taste.is_hard_negative() {
                score -= HARD_NEGATIVE_PENALTY;
            }
            Ranked {
                item,
                score: round_score(score),
                learned_contribution,
                taste_match: taste,
            }
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.item.id.cmp(&right.item.id))
    });

    let target = limit.min(candidates.len());
    let mut remaining = candidates;
    let mut selected: Vec<Ranked<'_>> = Vec::with_capacity(target);
    let mut counts = DiversityCounts::default();

    while selected.len() < target && !remaining.is_empty() {
        let mut best_index = 0;
        let mut best_adjusted = f64::NEG_INFINITY;

        for (index, candidate) in remaining.iter().enumerate() {
            let adjusted = candidate.score - diversity_penalty(&candidate.item.genres, &counts);
            let better_score = adjusted > best_adjusted + 1e-9;
            let same_score_but_lower_id = (adjusted - best_adjusted).abs() <= 1e-9
                && candidate.item.id < remaining[best_index].item.id;

            if better_score || same_score_but_lower_id {
                best_index = index;
                best_adjusted = adjusted;
            }
        }

        let chosen = remaining.remove(best_index);
        counts.record(&chosen);
        selected.push(chosen);
    }

    selected
        .into_iter()
        .map(|ranked| Recommendation {
            id: ranked.item.id.clone(),
            title: ranked.item.title.clone(),
            kind: ranked.item.kind.clone(),
            year: ranked.item.year,
            genres: ranked.item.genres.clone(),
            description: ranked.item.description.clone(),
            reason: build_reason(
                ranked.item,
                mood,
                profile,
                &ranked.taste_match,
                ranked.learned_contribution,
                feedback_count,
            ),
            source_url: ranked.item.source_url.clone(),
            score: ranked.score,
            poster_url: ranked.item.poster_url.clone(),
            rating: ranked.item.rating,
            rating_source: ranked.item.rating_source.clone(),
            rating_count: ranked.item.rating_count,
            ratings: ranked.item.ratings.clone(),
        })
        .collect()
}

/// Ranks by personalized score, then greedily injects genre diversity while
/// keeping ordering fully deterministic (score, then id as tie-breaker).
pub fn recommend(
    items: &[CatalogItem],
    profile: &Profile,
    mood: Mood,
    kind: Kind,
    weights: &[f64],
    feedback_count: u64,
    limit: usize,
) -> Vec<Recommendation> {
    recommend_with_request(items, profile, mood, kind, weights, feedback_count, limit, None)
}

/// Session-first ranking. When `request_text` parses to usable intent
/// (explicit genre cues, excluding generic kind words), candidates
/// are scored `0.85 * session_channel + 0.15 * baseline_channel`
/// with both channels normalized to 0..1. Session negatives strictly
/// exclude evidenced items, the persisted profile stays a soft
/// baseline only, watched/disliked stay with the API exclusions,
/// requested coverage tier (full strongest) is preserved during
/// greedy selection with 85/15+diversity applied within the tier,
/// and pure-unrelated items never pad the list (fewer results
/// instead). Blank/unknown text delegates to the old baseline
/// behaviour exactly.
pub fn recommend_with_request(
    items: &[CatalogItem],
    profile: &Profile,
    mood: Mood,
    kind: Kind,
    weights: &[f64],
    feedback_count: u64,
    limit: usize,
    request_text: Option<&str>,
) -> Vec<Recommendation> {
    let limit = if limit == 0 { items.len() } else { limit };

    let Some(raw_text) = request_text else {
        return recommend_baseline(items, profile, mood, kind, weights, feedback_count, limit);
    };
    if raw_text.trim().is_empty() {
        return recommend_baseline(items, profile, mood, kind, weights, feedback_count, limit);
    }
    let session = SessionIntent::parse(raw_text, kind);
    if !session.is_usable() {
        return recommend_baseline(items, profile, mood, kind, weights, feedback_count, limit);
    }

    let learned_confidence = confidence(feedback_count);
    let baseline_profile = TasteProfile::parse(&profile.preferences);

    // Strict session-negative exclusion + relevance trimming first:
    // unrelated items never enter the ranked pool. Saved-profile
    // theme exclusions apply here too via the same shared predicate.
    let mut candidates = items
        .iter()
        .filter(|item| item.kind == kind.as_str())
        .filter(|item| !session.is_excluded(item))
        .filter(|item| !baseline_profile.is_theme_excluded(item))
        .filter(|item| session.is_relevant(item))
        .map(|item| {
            let features = item_features(item, mood);
            let logit = dot(weights, &features);
            let learned_contribution = LEARNED_WEIGHT * learned_confidence * logit;
            let baseline_match = baseline_profile.match_item(item);
            let session_channel = session.channel(item);
            let baseline = baseline_channel(
                item,
                mood,
                profile,
                &baseline_match,
                weights,
                learned_confidence,
            );
            // Literal 85/15 blend of the two bounded 0..1 channels.
            let score = SESSION_WEIGHT * session_channel + BASELINE_WEIGHT * baseline;
            Ranked {
                item,
                score: round_score(score),
                learned_contribution,
                taste_match: baseline_match,
            }
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.item.id.cmp(&right.item.id))
    });

    let target = limit.min(candidates.len());
    let mut remaining = candidates;
    let mut selected: Vec<Ranked<'_>> = Vec::with_capacity(target);
    let mut counts = DiversityCounts::default();

    while selected.len() < target && !remaining.is_empty() {
        // Preserve requested coverage tier during greedy selection:
        // consider only candidates at the highest remaining coverage
        // (full coverage is strongest), then apply the 85/15 blend
        // score plus scaled diversity within that tier. A partial
        // item can therefore never overtake a full one via soft
        // terms, extreme baseline, or diversity penalties.
        let best_coverage = remaining
            .iter()
            .map(|candidate| session.coverage(candidate.item))
            .fold(f64::NEG_INFINITY, f64::max);
        let mut best_index: Option<usize> = None;
        let mut best_adjusted = f64::NEG_INFINITY;

        for (index, candidate) in remaining.iter().enumerate() {
            if (session.coverage(candidate.item) - best_coverage).abs() > 1e-9 {
                continue;
            }
            let adjusted = candidate.score
                - SESSION_DIVERSITY_SCALE * diversity_penalty(&candidate.item.genres, &counts);
            let is_first = best_index.is_none();
            let better = is_first
                || adjusted > best_adjusted + 1e-9
                || ((adjusted - best_adjusted).abs() <= 1e-9
                    && matches!(best_index, Some(previous) if candidate.item.id < remaining[previous].item.id));
            if better {
                best_index = Some(index);
                best_adjusted = adjusted;
            }
        }

        let chosen = remaining.remove(best_index.expect("max tier candidate"));
        counts.record(&chosen);
        selected.push(chosen);
    }

    selected
        .into_iter()
        .map(|ranked| Recommendation {
            id: ranked.item.id.clone(),
            title: ranked.item.title.clone(),
            kind: ranked.item.kind.clone(),
            year: ranked.item.year,
            genres: ordered_session_genres(ranked.item, &session),
            description: ranked.item.description.clone(),
            reason: build_session_reason(
                ranked.item,
                mood,
                profile,
                &session,
                &ranked.taste_match,
                ranked.learned_contribution,
                feedback_count,
            ),
            source_url: ranked.item.source_url.clone(),
            score: ranked.score,
            poster_url: ranked.item.poster_url.clone(),
            rating: ranked.item.rating,
            rating_source: ranked.item.rating_source.clone(),
            rating_count: ranked.item.rating_count,
            ratings: ranked.item.ratings.clone(),
        })
        .collect()
}

fn blend_with_learned(cold: f64, learned_contribution: f64) -> f64 {
    cold + learned_contribution
}

// Keeps the old name available to any caller while the implementation remains
// a simple, testable blend.
pub fn blend(cold: f64, logit: f64, feedback_count: u64) -> f64 {
    blended_score(cold, logit, feedback_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, genres: &[&str]) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            title: id.to_string(),
            kind: kind.to_string(),
            year: 2022,
            genres: genres.iter().map(|genre| genre.to_string()).collect(),
            description: String::new(),
            source_url: String::new(),
            poster_url: None,
            rating: None,
            rating_source: None,
            rating_count: None,
            ratings: Vec::new(),
        }
    }

    #[test]
    fn feature_layout_is_stable() {
        let movie = item("m", "movie", &["action", "thriller"]);
        let features = item_features(&movie, Mood::Thrill);
        assert_eq!(features.len(), FEATURE_LEN);
        assert_eq!(features.iter().sum::<f64>(), 7.0);
        assert_eq!(features[GENRE_START + 0], 1.0);
        assert_eq!(
            features[MOOD_GENRE_START + Mood::Thrill.index() * GENRE_COUNT],
            1.0
        );
    }

    #[test]
    fn stated_tastes_lift_liked_genres_and_penalize_disliked() {
        let comedy = item("c", "movie", &["comedy"]);
        let horror = item("h", "movie", &["horror"]);
        let profile = Profile {
            name: "Ada".to_string(),
            genres: Vec::new(),
            preferences: "komedi seviyorum, korku sevmiyorum.".to_string(),
        };

        let result = recommend(
            &[comedy, horror],
            &profile,
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            2,
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "c");
        assert_eq!(result[1].id, "h");
        assert!(result[0].score > result[1].score);
        assert!(!result[0].reason.is_empty());
    }

    #[test]
    fn cold_start_reacts_to_mood_and_profile() {
        let thriller = item("t", "movie", &["thriller"]);
        let romance = item("r", "movie", &["romance"]);
        let comedy = item("c", "movie", &["comedy"]);
        let horror = item("h", "movie", &["horror"]);
        let animation = item("a", "anime", &["animation"]);
        let empty_profile = Profile::default();

        assert!(
            cold_score(&thriller, Mood::Thrill, &empty_profile)
                > cold_score(&romance, Mood::Thrill, &empty_profile)
        );
        assert!(
            cold_score(&comedy, Mood::Relax, &empty_profile)
                > cold_score(&horror, Mood::Relax, &empty_profile)
        );

        let profile = Profile {
            name: "Ada".to_string(),
            genres: vec!["animation".to_string()],
            preferences: String::new(),
        };
        assert!(
            cold_score(&animation, Mood::Relax, &profile)
                > cold_score(&animation, Mood::Relax, &empty_profile)
        );
    }

    #[test]
    fn online_logistic_update_moves_toward_liked_features() {
        let action = item("a", "movie", &["action"]);
        let drama = item("d", "movie", &["drama"]);
        let action_features = item_features(&action, Mood::Thrill);
        let drama_features = item_features(&drama, Mood::Thrill);

        let mut weights = vec![0.0; FEATURE_LEN];
        for _ in 0..8 {
            train(&mut weights, &action_features, true);
        }

        assert!(dot(&weights, &action_features) > dot(&weights, &drama_features));
        assert!(blend(1.0, dot(&weights, &action_features), 8) > blend(1.0, 0.0, 8));
    }

    #[test]
    fn dislike_pushes_the_item_down() {
        let horror = item("h", "movie", &["horror"]);
        let features = item_features(&horror, Mood::Thrill);
        let mut weights = vec![0.0; FEATURE_LEN];

        for _ in 0..10 {
            train(&mut weights, &features, false);
        }

        assert!(dot(&weights, &features) < 0.0);
    }

    #[test]
    fn ranking_is_deterministic_and_diverse_when_practical() {
        let candidates = vec![
            item("a", "movie", &["comedy", "adventure"]),
            item("b", "movie", &["comedy", "drama"]),
            item("c", "movie", &["animation", "fantasy"]),
            item("d", "movie", &["thriller", "mystery"]),
        ];

        let first = recommend(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            3,
        );
        let second = recommend(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            3,
        );

        let first_ids = first
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        let second_ids = second
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(first_ids, second_ids);
        assert_eq!(first_ids[0], "a");
        assert_eq!(
            first_ids[1], "c",
            "the close-scoring comedy alternative should yield to genre diversity"
        );
        assert!(first.iter().all(|item| item.kind == "movie"));
        assert!(first.iter().all(|item| !item.reason.is_empty()));
    }

    #[test]
    fn kind_filter_is_respected() {
        let candidates = vec![
            item("m", "movie", &["action"]),
            item("s", "series", &["action"]),
            item("a", "anime", &["action"]),
        ];
        let result = recommend(
            &candidates,
            &Profile::default(),
            Mood::Thrill,
            Kind::Series,
            &[],
            0,
            12,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "s");
    }

    #[test]
    fn session_drama_romance_overrides_conflicting_profile_and_high_learned_weights() {
        // 10 full-coverage + 2 partial + 2 unrelated, like the
        // Feel/anime "Duygusal, Romantik" case. The persisted
        // profile loves comedy/action and learned weights strongly
        // favour them, yet combined drama+romance must win.
        let mut candidates = Vec::new();
        for index in 1..=10_usize {
            candidates.push(item(&format!("dr{index:02}"), "anime", &["drama", "romance"]));
        }
        candidates.push(item("d-only", "anime", &["drama"]));
        candidates.push(item("rc-mixed", "anime", &["romance", "comedy"]));
        candidates.push(item("c-pure", "anime", &["comedy"]));
        candidates.push(item("a-pure", "anime", &["action"]));

        let profile = Profile {
            name: "Ada".to_string(),
            genres: vec!["comedy".to_string(), "action".to_string()],
            preferences: "komedi ve aksiyon severim".to_string(),
        };
        let mut weights = vec![0.0; FEATURE_LEN];
        // action is GENRES[0], comedy is GENRES[1].
        weights[GENRE_START] = 6.0;
        weights[GENRE_START + 1] = 6.0;

        let result = recommend_with_request(
            &candidates,
            &profile,
            Mood::Feel,
            Kind::Anime,
            &weights,
            20,
            12,
            Some("Duygusal, Romantik"),
        );
        let ids = result.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert!(result.len() > 8, "expected >8 results, got {ids:?}");
        // Strict ALL: 10 full mixture only, not 12 with partials.
        assert_eq!(result.len(), 10);
        // Every returned item evidences both requested genres.
        for item in &result {
            assert!(
                item.genres.iter().any(|genre| genre == "drama")
                    && item.genres.iter().any(|genre| genre == "romance"),
                "every result must have drama+romance: id={} genres={:?}",
                item.id,
                item.genres
            );
        }
        // First eight (in fact all ten) are combined drama+romance.
        for id in ids.iter().take(8) {
            assert!(id.starts_with("dr"), "combined coverage must lead, got {ids:?}");
        }
        // Partial matches (either genre alone) never fill the list.
        assert!(!ids.contains(&"d-only"), "drama-only must not pad: {ids:?}");
        assert!(!ids.contains(&"rc-mixed"), "romance+comedy missing drama must not pad: {ids:?}");
        // Pure unrelated genres are trimmed, never used to pad.
        assert!(!ids.contains(&"c-pure"), "pure comedy must not pad: {ids:?}");
        assert!(!ids.contains(&"a-pure"), "pure action must not pad: {ids:?}");
        // Reasons honestly name both requested genres on full matches.
        for item in result.iter().take(2) {
            assert!(
                item.reason.contains("Drama") && item.reason.contains("Romance"),
                "full match reason must name Drama+Romance: {}",
                item.reason
            );
        }
        // Scores are the bounded 85/15 blend (0..1 range).
        for item in &result {
            assert!(
                (0.0..=1.0).contains(&item.score),
                "session score must stay bounded 0..1: {}",
                item.score
            );
        }
        // Blended order is deterministic.
        let again = recommend_with_request(
            &candidates,
            &profile,
            Mood::Feel,
            Kind::Anime,
            &weights,
            20,
            12,
            Some("Duygusal, Romantik"),
        );
        assert_eq!(
            ids,
            again.iter().map(|item| item.id.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn session_negative_excludes_even_mixed_and_positive_allows_mixed() {
        let candidates = vec![
            item("r-only", "anime", &["romance"]),
            item("dr-mix", "anime", &["drama", "romance"]),
            item("rc-mix", "anime", &["romance", "comedy"]),
            item("c-pure", "anime", &["comedy"]),
            item("d-only", "anime", &["drama"]),
        ];
        let profile = Profile::default();

        // Negative comedy excludes any evidenced comedy, including
        // the mixed romance+comedy item.
        let excluded = recommend_with_request(
            &candidates,
            &profile,
            Mood::Feel,
            Kind::Anime,
            &[],
            0,
            12,
            Some("komedi sevmiyorum, romantik seviyorum."),
        );
        let excluded_ids = excluded.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert!(excluded_ids.contains(&"r-only"), "got {excluded_ids:?}");
        assert!(excluded_ids.contains(&"dr-mix"), "got {excluded_ids:?}");
        assert!(
            !excluded_ids.contains(&"rc-mix"),
            "explicit comedy exclusion must drop mixed item: {excluded_ids:?}"
        );
        assert!(!excluded_ids.contains(&"c-pure"), "got {excluded_ids:?}");
        assert!(!excluded_ids.contains(&"d-only"), "got {excluded_ids:?}");

        // Positive romantic alone allows the mixed item.
        let allowed = recommend_with_request(
            &candidates,
            &profile,
            Mood::Feel,
            Kind::Anime,
            &[],
            0,
            12,
            Some("romantik seviyorum"),
        );
        let allowed_ids = allowed.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert!(
            allowed_ids.contains(&"rc-mix"),
            "positive-only romantic must allow mixed: {allowed_ids:?}"
        );
        assert!(!allowed_ids.contains(&"c-pure"), "pure comedy must not pad: {allowed_ids:?}");
    }

    #[test]
    fn blank_unknown_and_generic_anime_preserve_old_behaviour() {
        let candidates = vec![
            item("a", "movie", &["comedy", "adventure"]),
            item("b", "movie", &["comedy", "drama"]),
            item("c", "movie", &["animation", "fantasy"]),
            item("d", "movie", &["thriller", "mystery"]),
        ];
        let profile = Profile {
            name: "Ada".to_string(),
            genres: Vec::new(),
            preferences: "komedi seviyorum".to_string(),
        };
        let baseline = recommend(
            &candidates,
            &profile,
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            4,
        );
        let baseline_ids = baseline.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        for text in [None, Some(""), Some("   "), Some("zxqv blorp")] {
            let result = recommend_with_request(
                &candidates,
                &profile,
                Mood::Relax,
                Kind::Movie,
                &[],
                0,
                4,
                text,
            );
            assert_eq!(
                baseline_ids,
                result.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
                "text {text:?} must preserve old behaviour"
            );
        }
        // Bare "anime" is not usable intent for Kind::Anime.
        assert!(!SessionIntent::parse("anime", Kind::Anime).is_usable());
        assert!(!session_intent_usable("anime", Kind::Anime));
        assert!(SessionIntent::parse("Duygusal, Romantik", Kind::Anime).is_usable());
        // Generic kind word alone must not be stored; old order holds.
        let anime_items = vec![
            item("x", "anime", &["animation", "fantasy"]),
            item("y", "anime", &["comedy"]),
        ];
        let anime_profile = Profile::default();
        let anime_baseline = recommend(&anime_items, &anime_profile, Mood::Relax, Kind::Anime, &[], 0, 2);
        let anime_session = recommend_with_request(
            &anime_items,
            &anime_profile,
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            2,
            Some("anime"),
        );
        assert_eq!(
            anime_baseline.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            anime_session.iter().map(|item| item.id.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn session_preserves_full_coverage_tier_for_three_genres_with_terms() {
        // Adversarial OR request (veya): 3 requested genres + an
        // evidenced soft term on partials + a strong learned/profile
        // conflict favouring the partials. Blended scores alone
        // would rank a 2/3 partial above a full item, but greedy
        // selection preserves the coverage tier (full strongest),
        // so all full items stay ahead even after 8 selections and
        // diversity penalties. Under OR, ANY partials are allowed
        // only after every full item.
        let mut candidates = Vec::new();
        for index in 1..=10_usize {
            candidates.push(item(&format!("f{index:02}"), "anime", &["drama", "romance", "fantasy"]));
        }
        for index in 1..=4_usize {
            let mut partial = item(&format!("p{index:02}"), "anime", &["drama", "romance", "comedy"]);
            partial.description = "Bir denizaltı hikayesi.".to_string();
            candidates.push(partial);
        }
        let profile = Profile {
            name: "Ada".to_string(),
            genres: vec!["comedy".to_string()],
            preferences: "komedi severim".to_string(),
        };
        let mut weights = vec![0.0; FEATURE_LEN];
        // action=0, comedy=1, drama=2, romance=3, fantasy=6 in GENRES.
        weights[GENRE_START + 1] = 6.0; // comedy boosts partials
        weights[GENRE_START + 6] = -6.0; // fantasy suppresses fulls
        let result = recommend_with_request(
            &candidates,
            &profile,
            Mood::Feel,
            Kind::Anime,
            &weights,
            20,
            12,
            Some("Duygusal, Romantik veya Fantastik, denizaltı severim"),
        );
        assert!(SessionIntent::parse(
            "Duygusal, Romantik veya Fantastik, denizaltı severim",
            Kind::Anime
        )
        .allows_any());
        let ids = result.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
        assert_eq!(result.len(), 12, "got {ids:?}");
        // First eight (in fact all ten) selections are full coverage.
        for id in ids.iter().take(8) {
            assert!(id.starts_with('f'), "full tier must lead after 8 picks: {ids:?}");
        }
        for id in ids.iter().take(10) {
            assert!(id.starts_with('f'), "all full must precede partials: {ids:?}");
        }
        let first_partial = ids
            .iter()
            .position(|id| id.starts_with('p'))
            .expect("partials present after fulls");
        assert_eq!(first_partial, 10, "partials only after all fulls: {ids:?}");
        // Sanity: tier predicate itself separates the groups.
        let session = SessionIntent::parse(
            "Duygusal, Romantik veya Fantastik, denizaltı severim",
            Kind::Anime,
        );
        let full_item = item("full", "anime", &["drama", "romance", "fantasy"]);
        let mut partial_item = item("partial", "anime", &["drama", "romance", "comedy"]);
        partial_item.description = "Bir denizaltı hikayesi.".to_string();
        assert_eq!(session.coverage(&full_item), 1.0);
        assert!((session.coverage(&partial_item) - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn session_keeps_all_high_relevance_above_partial_via_coverage() {
        // Full coverage channel exceeds partial, bounded 0..1.
        // Default is ALL: partial is not relevant.
        let session = SessionIntent::parse("Duygusal, Romantik", Kind::Anime);
        assert!(session.is_usable());
        assert!(!session.allows_any());
        let full = item("full", "anime", &["drama", "romance"]);
        let partial = item("partial", "anime", &["drama"]);
        let none = item("none", "anime", &["comedy"]);
        assert!(session.is_high_relevance(&full));
        assert!(!session.is_high_relevance(&partial));
        assert!(!session.is_relevant(&partial));
        assert!(session.is_relevant(&full));
        assert!(!session.is_relevant(&none));
        // OR variant makes the partial relevant again.
        let or_session = SessionIntent::parse("Duygusal veya Romantik", Kind::Anime);
        assert!(or_session.allows_any());
        assert!(or_session.is_relevant(&partial));
        assert!((0.0..=1.0).contains(&session.channel(&full)));
        assert!(session.channel(&full) > session.channel(&partial));
        assert!(session.channel(&partial) > session.channel(&none));
        assert_eq!(session.channel(&none), 0.0);
    }

    #[test]
    fn session_exact_duygusal_romantik_requires_both_and_blocks_pads() {
        // Live-QA shape: 3 full searches must not pad with drama-only
        // or romance-only items. Comedy only rides along when both
        // requested genres are also present.
        let candidates = vec![
            item("both-1", "anime", &["drama", "romance"]),
            // Fictional example: requested genres buried after comedy/fantasy.
            item("both-2", "anime", &["comedy", "fantasy", "drama", "romance"]),
            item("both-3", "anime", &["romance", "drama"]),
            item("drama-only", "anime", &["drama"]),
            item("romance-only", "anime", &["romance"]),
            item("drama-comedy", "anime", &["drama", "comedy"]),
            item("romance-comedy", "anime", &["romance", "comedy"]),
            item("action-only", "anime", &["action"]),
            item("comedy-only", "anime", &["comedy"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Feel,
            Kind::Anime,
            &[],
            0,
            12,
            Some("Duygusal, Romantik"),
        );
        let ids = result.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids.len(), 3, "only full mixtures, no pad to 12: {ids:?}");
        assert!(ids.contains(&"both-1".to_string()), "got {ids:?}");
        assert!(ids.contains(&"both-2".to_string()), "both+comedy is allowed: {ids:?}");
        assert!(ids.contains(&"both-3".to_string()), "got {ids:?}");
        for entry in &result {
            assert!(
                entry.genres.iter().any(|genre| genre == "drama")
                    && entry.genres.iter().any(|genre| genre == "romance"),
                "every result must have both drama and romance: {} {:?}",
                entry.id,
                entry.genres
            );
        }
        // Session-only genre ordering: requested first in request
        // order, remaining original genres appended unchanged, so
        // the first 3 always carry Drama+Romance.
        let mixed = result
            .iter()
            .find(|entry| entry.id == "both-2")
            .expect("mixed row");
        assert_eq!(
            mixed.genres,
            vec![
                "drama".to_string(),
                "romance".to_string(),
                "comedy".to_string(),
                "fantasy".to_string()
            ],
            "requested genres must lead in request order: {:?}",
            mixed.genres
        );
        assert_eq!(mixed.genres[0], "drama");
        assert_eq!(mixed.genres[1], "romance");
        assert_eq!(mixed.title, "both-2", "stable id/title unchanged");
        let reordered = result
            .iter()
            .find(|entry| entry.id == "both-3")
            .expect("reordered row");
        assert_eq!(
            reordered.genres,
            vec!["drama".to_string(), "romance".to_string()],
            "request order wins over metadata order: {:?}",
            reordered.genres
        );
        assert!(!ids.contains(&"drama-only".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"romance-only".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"drama-comedy".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"romance-comedy".to_string()), "got {ids:?}");

        // Negative comedy removes the both+comedy item even though
        // both requested genres are present.
        let denied = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Feel,
            Kind::Anime,
            &[],
            0,
            12,
            Some("komedi sevmiyorum, Duygusal, Romantik"),
        );
        let denied_ids = denied.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
        assert_eq!(denied_ids.len(), 2, "both+comedy must drop: {denied_ids:?}");
        assert!(denied_ids.contains(&"both-1".to_string()), "got {denied_ids:?}");
        assert!(denied_ids.contains(&"both-3".to_string()), "got {denied_ids:?}");
        assert!(!denied_ids.contains(&"both-2".to_string()), "got {denied_ids:?}");
    }

    #[test]
    fn session_or_connector_allows_any_with_coverage_priority() {
        let candidates = vec![
            item("both", "anime", &["drama", "romance"]),
            item("drama-only", "anime", &["drama"]),
            item("romance-only", "anime", &["romance"]),
            item("none", "anime", &["comedy"]),
        ];
        for text in [
            "Duygusal veya Romantik",
            "Duygusal ya da Romantik",
            "Duygusal yahut Romantik",
        ] {
            assert!(
                SessionIntent::parse(text, Kind::Anime).allows_any(),
                "text {text:?} must be OR"
            );
            let result = recommend_with_request(
                &candidates,
                &Profile::default(),
                Mood::Feel,
                Kind::Anime,
                &[],
                0,
                12,
                Some(text),
            );
            let ids = result.iter().map(|item| item.id.clone()).collect::<Vec<_>>();
            assert_eq!(ids.len(), 3, "OR must allow singles: text {text:?} got {ids:?}");
            assert_eq!(ids[0], "both", "full coverage first under OR: {ids:?}");
            assert!(ids.contains(&"drama-only".to_string()), "got {ids:?}");
            assert!(ids.contains(&"romance-only".to_string()), "got {ids:?}");
            assert!(!ids.contains(&"none".to_string()), "got {ids:?}");
        }
        // Substring "ya" inside a larger word is not standalone OR.
        let not_or = SessionIntent::parse("Duygusal, Romantik yabancı", Kind::Anime);
        assert!(!not_or.allows_any());
        assert!(!not_or.is_relevant(&item("p", "anime", &["drama"])));
        assert!(not_or.is_relevant(&item("f", "anime", &["drama", "romance"])));
        // Comma list without any connector stays ALL.
        assert!(!SessionIntent::parse("Duygusal, Romantik", Kind::Anime).allows_any());
    }

    #[test]
    fn session_clause_scoped_or_stays_all_for_negative_or() {
        // OR inside the negative sentence must not relax the
        // positive full-mixture (ALL). Pure positive OR stays ANY.
        let mixed = "Duygusal romantik istiyorum; komedi veya korku istemiyorum";
        assert!(!SessionIntent::parse(mixed, Kind::Anime).allows_any());
        assert!(SessionIntent::parse("Duygusal veya Romantik", Kind::Anime).allows_any());
        // Contrast splitting: OR before 'ama' still enables ANY.
        assert!(SessionIntent::parse(
            "Duygusal veya Romantik seviyorum ama komedi sevmiyorum",
            Kind::Anime
        )
        .allows_any());
        // Comma positives may combine: no sentence boundary here,
        // the OR clause still carries 3 global positives.
        assert!(SessionIntent::parse(
            "Duygusal, Romantik veya Fantastik, denizaltı severim",
            Kind::Anime
        )
        .allows_any());

        let candidates = vec![
            item("both", "anime", &["drama", "romance"]),
            item("both-comedy", "anime", &["drama", "romance", "comedy"]),
            item("both-horror", "anime", &["drama", "romance", "horror"]),
            item("drama-only", "anime", &["drama"]),
            item("romance-only", "anime", &["romance"]),
            item("comedy", "anime", &["comedy"]),
            item("horror", "anime", &["horror"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Feel,
            Kind::Anime,
            &[],
            0,
            12,
            Some(mixed),
        );
        let ids = result.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids.len(), 1, "ALL + negatives: only clean full mixture: {ids:?}");
        assert_eq!(ids[0], "both");
    }

    #[test]
    fn session_exact_fantastik_komedili_romantizm_lists_all_matched_genres() {
        // Exact request shape: all three genres must be named in the
        // reason, and an unmatched genre must never be claimed.
        let request = "fantastik evrende geçen komedili sakin bir romantizm";
        let session = SessionIntent::parse(request, Kind::Movie);
        assert!(session.is_usable(), "exact request must be usable");
        let candidates = vec![
            item("full-fcr", "movie", &["fantasy", "comedy", "romance"]),
            item(
                "full-plus-horror",
                "movie",
                &["fantasy", "comedy", "romance", "horror"],
            ),
            item("fantasy-romance", "movie", &["fantasy", "romance"]),
            item("fantasy-comedy", "movie", &["fantasy", "comedy"]),
            item("comedy-romance", "movie", &["comedy", "romance"]),
            item("horror-only", "movie", &["horror"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            12,
            Some(request),
        );
        let ids = result.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>();
        // Only full fantasy+comedy+romance fixtures survive; partials
        // prove komedili/romantizm/fantastik are all recognised as positives.
        assert_eq!(ids.len(), 2, "only full fixtures: {ids:?}");
        assert!(ids.contains(&"full-fcr".to_string()), "got {ids:?}");
        assert!(
            ids.contains(&"full-plus-horror".to_string()),
            "got {ids:?}"
        );
        assert!(!ids.contains(&"fantasy-romance".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"fantasy-comedy".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"comedy-romance".to_string()), "got {ids:?}");
        assert!(!ids.contains(&"horror-only".to_string()), "got {ids:?}");
        for entry in &result {
            assert!(
                entry.reason.contains("Fantasy")
                    && entry.reason.contains("Comedy")
                    && entry.reason.contains("Romance"),
                "reason must list all three matched genres: {}",
                entry.reason
            );
            // Unmatched horror is never claimed even when present in metadata.
            assert!(
                !entry.reason.contains("Horror"),
                "unmatched horror must not be claimed: {}",
                entry.reason
            );
            // Soft theme (calming) carries no evidence in the fixture.
            assert!(
                !entry.reason.contains("Calming"),
                "calming must not be claimed: {}",
                entry.reason
            );
        }
    }

    #[test]
    fn ratings_propagate_to_recommendations() {
        let mut rated = item("m", "movie", &["action"]);
        rated.ratings = vec![crate::model::ExternalRating {
            source: "sample".to_string(),
            value: 9.2,
            scale: 10.0,
            votes: Some(42),
        }];
        rated.rating = Some(9.2);
        rated.rating_source = Some("sample".to_string());
        rated.rating_count = Some(42);
        let result = recommend(
            &[rated],
            &Profile::default(),
            Mood::Thrill,
            Kind::Movie,
            &[],
            0,
            12,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].ratings.len(), 1);
        assert_eq!(result[0].ratings[0].source, "sample");
        assert_eq!(result[0].ratings[0].value, 9.2);
        assert_eq!(result[0].rating, Some(9.2));
    }

    #[test]
    fn ml_axes_stable_for_new_genres() {
        // GENRES stays exactly the original 11 ML axes, in order.
        assert_eq!(GENRES, [
            "action", "comedy", "drama", "romance", "thriller", "mystery", "fantasy",
            "sci-fi", "animation", "adventure", "horror"
        ]);
        assert_eq!(FEATURE_LEN, 1 + 11 + 5 * 11 + 3 + 6);
        assert_eq!(genre_index("action"), Some(0));
        assert_eq!(genre_index("horror"), Some(10));
        assert_eq!(genre_index("crime"), None);
        // New-genre item adds no ML feature (no new weights claimed).
        let sports = item("s", "movie", &["sports"]);
        let feats = item_features(&sports, Mood::Relax);
        assert_eq!(feats.len(), FEATURE_LEN);
        assert_eq!(feats.iter().sum::<f64>(), 3.0); // bias + kind + era only
    }

    #[test]
    fn new_genre_profile_match_lifts_score() {
        let sports = item("s", "movie", &["sports"]);
        let empty = Profile::default();
        let with = Profile {
            name: "Ada".to_string(),
            genres: vec!["sports".to_string()],
            preferences: String::new(),
        };
        assert!(
            cold_score(&sports, Mood::Relax, &with)
                > cold_score(&sports, Mood::Relax, &empty),
            "generic new genre profile match must lift cold score"
        );
        // Neutral mood signal: sports-only cold score is above ignored 0.10 base.
        assert!(cold_score(&sports, Mood::Relax, &empty) > 0.10 + 0.10);
    }

    #[test]
    fn spor_request_filters_sports_metadata() {
        let candidates = vec![
            item("s", "movie", &["sports"]),
            item("c", "movie", &["comedy"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            12,
            Some("spor"),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "s");
    }

    #[test]
    fn psikolojik_and_gundelik_yasam_compound_recognized() {
        assert!(SessionIntent::parse(
            "psikolojik ve gündelik yaşam",
            Kind::Movie
        )
        .is_usable());
        let candidates = vec![
            item("both", "movie", &["psychological", "slice-of-life"]),
            item("psy", "movie", &["psychological"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            12,
            Some("psikolojik ve gündelik yaşam"),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "both");
    }

    #[test]
    fn harem_negative_excludes_harem_category() {
        let candidates = vec![
            item("h", "anime", &["harem"]),
            item("c", "anime", &["comedy"]),
        ];
        let result = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            Some("Harem istemiyorum"),
        );
        assert!(!result.iter().any(|r| r.id == "h"));
        assert!(result.iter().any(|r| r.id == "c"));
    }

    #[test]
    fn harem_olmayan_fantastik_aksiyon_gizem_ranks_all_three_excluding_harem() {
        let candidates = vec![
            item("full-1", "anime", &["fantasy", "action", "mystery"]),
            item("full-2", "anime", &["fantasy", "action", "mystery", "comedy"]),
            item("full-harem", "anime", &["fantasy", "action", "mystery", "harem"]),
            item("harem-only", "anime", &["harem"]),
            item("partial", "anime", &["fantasy", "action"]),
            item("unrelated", "anime", &["comedy"]),
        ];
        for text in [
            "Harem olmayan iyi işlenmiş bir fantastik bir evrende geçen aksiyon gizem türünde.",
            "Harem olmayan fantastik aksiyon gizem",
            "Harem olmayan, fantastik, aksiyon, gizem.",
        ] {
            let session = SessionIntent::parse(text, Kind::Anime);
            assert!(session.is_usable(), "text {text:?} must be usable");
            assert!(!session.allows_any(), "no OR connector: {text:?}");
            assert!(
                session.is_relevant(&item("full", "anime", &["fantasy", "action", "mystery"])),
                "full must be relevant: {text:?}"
            );
            assert!(
                session.is_excluded(&item(
                    "bad",
                    "anime",
                    &["fantasy", "action", "mystery", "harem"]
                )),
                "harem mix must be excluded: {text:?}"
            );
            assert!(
                !session.is_relevant(&item("p", "anime", &["fantasy", "action"])),
                "partial must not pad: {text:?}"
            );

            let result = recommend_with_request(
                &candidates,
                &Profile::default(),
                Mood::Thrill,
                Kind::Anime,
                &[],
                0,
                12,
                Some(text),
            );
            let ids = result.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>();
            assert_eq!(ids.len(), 2, "strict ALL 3, harem excluded: text {text:?} got {ids:?}");
            assert!(ids.contains(&"full-1"), "got {ids:?}");
            assert!(ids.contains(&"full-2"), "got {ids:?}");
            assert!(!ids.contains(&"full-harem"), "forbidden harem must not fill: {ids:?}");
            assert!(!ids.contains(&"harem-only"), "got {ids:?}");
            assert!(!ids.contains(&"partial"), "got {ids:?}");
            assert!(!ids.contains(&"unrelated"), "got {ids:?}");
            for entry in &result {
                assert!(
                    (0.0..=1.0).contains(&entry.score),
                    "bounded 85/15 score: {}",
                    entry.score
                );
                assert!(
                    entry.genres.iter().any(|g| g == "fantasy")
                        && entry.genres.iter().any(|g| g == "action")
                        && entry.genres.iter().any(|g| g == "mystery"),
                    "every result must evidence all 3: {} {:?}",
                    entry.id,
                    entry.genres
                );
                assert!(
                    !entry.genres.iter().any(|g| g == "harem"),
                    "harem must never be recommended: {}",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn crime_documentary_new_labels_are_honest() {
        let candidates = vec![
            item("crime", "movie", &["crime"]),
            item("doc", "movie", &["documentary"]),
            item("c", "movie", &["comedy"]),
        ];
        // ALL semantics: only the item evidencing both survives; use OR
        // variant to see honest per-item labels.
        let either = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Movie,
            &[],
            0,
            12,
            Some("suç veya belgesel"),
        );
        assert!(either.len() >= 2);
        let crime = either.iter().find(|r| r.id == "crime").expect("crime");
        assert!(
            crime.reason.contains(&crate::taxonomy::label("crime")),
            "reason must use the taxonomy label: {}",
            crime.reason
        );
        assert!(!crime.reason.contains("Other"));
        let doc = either.iter().find(|r| r.id == "doc").expect("doc");
        assert!(
            doc.reason.contains(&crate::taxonomy::label("documentary")),
            "reason must use the taxonomy label: {}",
            doc.reason
        );
        assert!(!doc.reason.contains("Other"));
    }

    #[test]
    fn session_theme_exclusions_drop_love_polygon_and_harem_but_keep_plain_romantic_fantasy() {
        let candidates = vec![
            item("staging-tri-001", "anime", &["fantasy", "romance", "love-polygon"]),
            item("staging-har-002", "anime", &["fantasy", "romance", "harem"]),
            item("staging-tri-003", "anime", &["fantasy", "romance", "love-triangle"]),
            item("staging-rom-004", "anime", &["fantasy", "romance"]),
            item("staging-rom-005", "anime", &["romance"]),
        ];
        let ids = |results: Vec<Recommendation>| {
            let mut ids = results.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>();
            ids.sort();
            ids
        };
        // Theme-only (no horror): olmasın/istemiyorum phrases mark
        // usable negative-only intent; plain romantic fantasy and
        // genre-only plain romance survive.
        let theme_only = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            Some("Aşk üçgeni olmasın, harem teması istemiyorum"),
        );
        assert_eq!(ids(theme_only), vec!["staging-rom-004", "staging-rom-005"]);
        // Theme-only intent is anime-only: film/series fall back.
        assert!(SessionIntent::parse(
            "Aşk üçgeni olmasın, harem teması istemiyorum",
            Kind::Anime
        )
        .is_usable());
        assert!(!SessionIntent::parse(
            "Aşk üçgeni olmasın, harem teması istemiyorum",
            Kind::Movie
        )
        .is_usable());
        assert!(!SessionIntent::parse(
            "Aşk üçgeni olmasın, harem teması istemiyorum",
            Kind::Series
        )
        .is_usable());
        // Combined session alongside theme-only: fantasy positive +
        // horror negative, tagged items still excluded.
        let combined = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            Some(
                "Aşk üçgeni ve harem teması olmayan fantastik animeleri severim; korku sevmem.",
            ),
        );
        assert_eq!(ids(combined), vec!["staging-rom-004"]);
        // Genre-only control without any exclusion: all fantasy
        // items stay rankable, including tagged ones.
        let genre_only = recommend_with_request(
            &candidates,
            &Profile::default(),
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            Some("Fantastik severim"),
        );
        assert_eq!(
            ids(genre_only),
            vec![
                "staging-har-002",
                "staging-rom-004",
                "staging-tri-001",
                "staging-tri-003"
            ]
        );
        // Saved-profile theme exclusion, no session.
        let saved = Profile {
            name: String::new(),
            genres: Vec::new(),
            preferences: "Aşk üçgeni ve harem teması olmayan".to_string(),
        };
        let saved_no_session = recommend_with_request(
            &candidates,
            &saved,
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            None,
        );
        assert_eq!(
            ids(saved_no_session),
            vec!["staging-rom-004", "staging-rom-005"]
        );
        // Saved-profile theme exclusion with a genre-only session.
        let saved_with_session = recommend_with_request(
            &candidates,
            &saved,
            Mood::Relax,
            Kind::Anime,
            &[],
            0,
            12,
            Some("Fantastik severim"),
        );
        assert_eq!(ids(saved_with_session), vec!["staging-rom-004"]);
    }
}
