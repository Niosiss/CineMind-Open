//! Local, interpretable interpretation of free-text preferences.
//!
//! The profile text never leaves this engine and is never sent anywhere.
//! Instead it is normalized locally and turned into positive/negative genre
//! cues plus a small set of meaningful theme terms. Those signals feed the
//! existing ranking model and the user-facing reason strings.
//!
//! The parser is finite and bilingual: English and Turkish surface forms are
//! both understood, with Turkish diacritics folded for matching. Polarity comes
//! from the nearest polarity marker inside one clause chunk (split on commas,
//! sentence punctuation, and contrast words such as "ama"/"fakat"/"but").
//! Postnominal Turkish nonexistence modifiers ("olmayan", "icermeyen",
//! "sevilmeyen") bind only the preceding noun/list, never a later affirmative
//! phrase in the same chunk. Genre cues are suppressed in two narrow
//! qualified/theme contexts described below ("kalitesiz dram ..." and
//! "aşk üçgeni"/"love triangle") so a quality or trope preference does not
//! hard-ban an entire genre. Theme matching is evidence-only: a term matches
//! only when the catalog title or synopsis contains that token. Subjective
//! quality (whether a drama is "good"/"bad" in practice) cannot be measured
//! from a synopsis, so a "kalitesiz dram" preference is recorded as a soft term
//! and is rarely evidenced in metadata; it must not be read as a genre ban or
//! as a quality verdict on any specific title.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::model::{CatalogItem, Kind};
use crate::taxonomy;

const MAX_SCOPE: usize = 10;
const MAX_POSITIVE_TERMS: usize = 24;
const MAX_NEGATIVE_TERMS: usize = 16;

const POSITIVE_GENRE_WEIGHT: f64 = 1.25;
const POSITIVE_TERM_WEIGHT: f64 = 0.55;
const NEGATIVE_GENRE_WEIGHT: f64 = 2.10;
const NEGATIVE_TERM_WEIGHT: f64 = 1.40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TasteTerm {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Default)]
pub struct TasteProfile {
    positive_genres: Vec<String>,
    negative_genres: Vec<String>,
    positive_terms: Vec<TasteTerm>,
    negative_terms: Vec<TasteTerm>,
    negative_themes: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TasteMatch {
    pub positive_genres: Vec<String>,
    pub negative_genres: Vec<String>,
    pub positive_terms: Vec<TasteTerm>,
    pub negative_terms: Vec<TasteTerm>,
    pub score: f64,
}

impl TasteMatch {
    /// A clearly disliked genre is a hard constraint, not just a small penalty.
    pub fn is_hard_negative(&self) -> bool {
        !self.negative_genres.is_empty()
    }
}

impl TasteProfile {
    pub fn parse(text: &str) -> Self {
        let tokens = tokenize(text);
        if tokens.is_empty() {
            return Self::default();
        }

        let markers = tokens
            .iter()
            .enumerate()
            .filter_map(|(index, token)| marker_polarity(&token.key).map(|polarity| (index, polarity)))
            .collect::<Vec<_>>();

        let mut consumed = vec![false; tokens.len()];
        let mut positive_genres = Vec::new();
        let mut negative_genres = Vec::new();
        let mut negative_themes: Vec<String> = Vec::new();

        let mut index = 0;
        while index < tokens.len() {
            if let Some(hit) = find_cue(&tokens, index) {
                let end = index + hit.span_len - 1;
                for consumed_slot in consumed.iter_mut().take(end + 1).skip(index) {
                    *consumed_slot = true;
                }

                // Narrow qualified/theme suppression: the genre token is
                // consumed but emits no genre at all. The remaining qualifier
                // or trope token ("kalitesiz" / "ucgeni") is still captured as
                // a soft term by the term loop below, so the preference
                // stays visible without hard-banning the whole genre.
                if is_suppressed_qualified_genre(&tokens, index, end, &hit.genre) {
                    // Explicit negative review of a qualified trope
                    // ("aşk üçgeni ..." / "harem teması ...") is capped
                    // as a separate theme exclusion, not a genre ban.
                    // Use the full phrase span (cue + trope token) for
                    // polarity so "olmasın/olmayan/istemiyorum" after
                    // the phrase negates only that theme in the clause.
                    if let Some(theme) = theme_id_for_suppressed(&tokens, index, end, &hit.genre) {
                        let phrase_end = end + 1;
                        if nearest_marker(&tokens, index, phrase_end, &markers) == Some(-1)
                            && !negative_themes.iter().any(|existing| existing == theme)
                        {
                            negative_themes.push(theme.to_string());
                        }
                    }
                    if hit.genre == "harem"
                        || (hit.genre == "adventure"
                            && index > 0
                            && tokens[index - 1].key == "zaman")
                    {
                        // "harem teması" / "zaman yolculuğu" are themes:
                        // release the genre tokens so they flow to the
                        // term loop as soft theme terms.
                        for consumed_slot in consumed.iter_mut().take(end + 1).skip(index) {
                            *consumed_slot = false;
                        }
                    }
                    index = end + 1;
                    continue;
                }

                let negative = hit.negative_suffix
                    || nearest_marker(&tokens, index, end, &markers) == Some(-1);
                let target = if negative {
                    &mut negative_genres
                } else {
                    &mut positive_genres
                };
                if !target.iter().any(|genre| genre == &hit.genre) {
                    target.push(hit.genre.to_string());
                }
                index = end + 1;
            } else {
                index += 1;
            }
        }

        // Explicit dislike wins when the same genre appears in both groups.
        positive_genres.retain(|genre| !negative_genres.iter().any(|other| other == genre));

        let mut positive_terms: Vec<TasteTerm> = Vec::new();
        let mut negative_terms: Vec<TasteTerm> = Vec::new();

        for (index, token) in tokens.iter().enumerate() {
            if consumed[index] {
                continue;
            }
            if marker_polarity(&token.key).is_some() || is_stopword(&token.key) {
                continue;
            }
            if token.key.chars().count() < 3 || token.key.chars().all(|ch| ch.is_ascii_digit()) {
                continue;
            }

            let negative = nearest_marker(&tokens, index, index, &markers) == Some(-1);
            let term = TasteTerm {
                key: token.key.clone(),
                label: token.display.clone(),
            };
            let target = if negative {
                &mut negative_terms
            } else {
                &mut positive_terms
            };
            if !target.iter().any(|existing| existing.key == term.key) {
                target.push(term);
            }
        }

        let negative_keys = negative_terms
            .iter()
            .map(|term| term.key.clone())
            .collect::<HashSet<_>>();
        positive_terms.retain(|term| !negative_keys.contains(&term.key));

        positive_terms.truncate(MAX_POSITIVE_TERMS);
        negative_terms.truncate(MAX_NEGATIVE_TERMS);

        Self {
            positive_genres,
            negative_genres,
            positive_terms,
            negative_terms,
            negative_themes,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.positive_genres.is_empty()
            && self.negative_genres.is_empty()
            && self.positive_terms.is_empty()
            && self.negative_terms.is_empty()
            && self.negative_themes.is_empty()
    }

    pub fn positive_genres(&self) -> &[String] {
        &self.positive_genres
    }

    pub fn negative_genres(&self) -> &[String] {
        &self.negative_genres
    }

    pub fn positive_terms(&self) -> &[TasteTerm] {
        &self.positive_terms
    }

    pub fn negative_terms(&self) -> &[TasteTerm] {
        &self.negative_terms
    }

    pub fn negative_themes(&self) -> &[String] {
        &self.negative_themes
    }

    /// Hard, anime-only exclusion shared by session and saved-profile
    /// paths, driven solely by explicit catalog tag evidence.
    ///
    /// - `"love-triangle"` theme excludes anime items tagged
    ///   `love-polygon` or `love-triangle`.
    /// - `"harem"` theme (explicit `"harem teması ..."`) excludes
    ///   anime items tagged `harem`. For consistency a bare
    ///   explicitly negated `harem` genre in a saved profile (i.e.
    ///   `negative_genres` contains `harem`) counts as the same tag
    ///   exclusion here; bare session `harem` stays an existing
    ///   genre exclusion and yields the same tag outcome.
    ///
    /// Titles/descriptions are never consulted. Items with no tag
    /// metadata cannot be excluded, and non-anime items are never
    /// excluded by a theme. Romance/drama soft terms never reach
    /// this predicate.
    pub fn is_theme_excluded(&self, item: &CatalogItem) -> bool {
        if Kind::from_catalog(&item.kind) != Some(Kind::Anime) {
            return false;
        }
        if item.genres.is_empty() {
            return false;
        }
        if self
            .negative_themes
            .iter()
            .any(|theme| theme == "love-triangle")
            && item
                .genres
                .iter()
                .any(|genre| genre == "love-polygon" || genre == "love-triangle")
        {
            return true;
        }
        let harem_negated = self.negative_themes.iter().any(|theme| theme == "harem")
            || self.negative_genres.iter().any(|genre| genre == "harem");
        harem_negated && item.genres.iter().any(|genre| genre == "harem")
    }

    /// True when the parse produced at least one explicit genre cue
    /// (positive or negative). Session ranking treats only this as
    /// usable request intent; free theme terms alone (including
    /// unknown words) stay on the old behaviour path.
    pub fn has_genre_intent(&self) -> bool {
        !self.positive_genres.is_empty() || !self.negative_genres.is_empty()
    }

    pub fn match_item(&self, item: &CatalogItem) -> TasteMatch {
        let mut matched_positive_genres = Vec::new();
        let mut matched_negative_genres = Vec::new();

        for genre in &item.genres {
            if self.positive_genres.iter().any(|candidate| candidate == genre) {
                matched_positive_genres.push(genre.clone());
            }
            if self.negative_genres.iter().any(|candidate| candidate == genre) {
                matched_negative_genres.push(genre.clone());
            }
        }

        // A genre explicitly marked as disliked is never presented as positive
        // evidence, even if the user also expressed mixed feelings.
        matched_positive_genres.retain(|genre| !matched_negative_genres.contains(genre));

        let item_tokens = item_text_tokens(item);

        let matched_positive_terms = self
            .positive_terms
            .iter()
            .filter(|term| term_matches(&term.key, &item_tokens))
            .cloned()
            .collect::<Vec<_>>();
        let matched_negative_terms = self
            .negative_terms
            .iter()
            .filter(|term| term_matches(&term.key, &item_tokens))
            .cloned()
            .collect::<Vec<_>>();

        let positive = POSITIVE_GENRE_WEIGHT * matched_positive_genres.len().min(2) as f64
            + POSITIVE_TERM_WEIGHT * matched_positive_terms.len().min(4) as f64;
        let negative = NEGATIVE_GENRE_WEIGHT * matched_negative_genres.len().min(2) as f64
            + NEGATIVE_TERM_WEIGHT * matched_negative_terms.len().min(3) as f64;

        TasteMatch {
            positive_genres: matched_positive_genres,
            negative_genres: matched_negative_genres,
            positive_terms: matched_positive_terms,
            negative_terms: matched_negative_terms,
            score: positive - negative,
        }
    }
}

/// Normalization shared with catalog search. It lowercases Turkish text,
/// folds diacritics and collapses punctuation into single spaces.
pub fn normalize_for_search(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut pending_space = false;

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !output.is_empty() {
                output.push(' ');
            }
            pending_space = false;
            output.push(fold_char(lower_char(ch)));
        } else {
            pending_space = true;
        }
    }

    output
}

#[derive(Debug, Clone)]
struct Token {
    key: String,
    display: String,
    clause: usize,
}

struct CueHit {
    span_len: usize,
    alias_len: usize,
    genre: String,
    negative_suffix: bool,
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut key = String::new();
    let mut display = String::new();
    let mut clause = 0;

    for ch in text.chars() {
        if ch.is_alphanumeric() {
            key.push(fold_char(lower_char(ch)));
            display.push(ch);
        } else {
            flush_token(&mut tokens, &mut key, &mut display, &mut clause);
            if is_clause_break(ch) {
                clause += 1;
            }
        }
    }
    flush_token(&mut tokens, &mut key, &mut display, &mut clause);

    tokens
}

fn flush_token(
    tokens: &mut Vec<Token>,
    key: &mut String,
    display: &mut String,
    clause: &mut usize,
) {
    if key.is_empty() {
        return;
    }

    let normalized = std::mem::take(key);
    let original = std::mem::take(display);

    if is_contrast(&normalized) {
        // "ama", "fakat", ... delimit the scope of a negation.
        *clause += 1;
        return;
    }

    tokens.push(Token {
        key: normalized,
        display: original,
        clause: *clause,
    });
}

fn is_clause_break(ch: char) -> bool {
    matches!(
        ch,
        ',' | '.' | '!' | '?' | ';' | ':' | '\n' | '\r' | '(' | ')' | '[' | ']' | '{' | '}'
    )
}

fn is_contrast(token: &str) -> bool {
    matches!(
        token,
        "ama"
            | "fakat"
            | "ancak"
            | "lakin"
            | "oysa"
            | "halbuki"
            | "yanliz"
            | "yalniz"
            | "but"
            | "however"
            | "though"
            | "although"
            | "yet"
    )
}

fn lower_char(ch: char) -> char {
    match ch {
        'I' => 'i',
        'İ' => 'i',
        _ => ch.to_lowercase().next().unwrap_or(ch),
    }
}

fn fold_char(ch: char) -> char {
    match ch {
        'ç' => 'c',
        'ğ' => 'g',
        'ı' | 'î' | 'í' | 'ì' | 'ï' => 'i',
        'ö' => 'o',
        'ş' => 's',
        'ü' | 'û' | 'ù' | 'ú' => 'u',
        'â' | 'á' | 'à' | 'ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'ñ' => 'n',
        other => other,
    }
}

fn find_cue(tokens: &[Token], index: usize) -> Option<CueHit> {
    let lexicon = genre_lexicon();
    let mut best: Option<CueHit> = None;

    for entry in lexicon {
        let parts = &entry.parts;
        if parts.is_empty() || index + parts.len() - 1 >= tokens.len() {
            continue;
        }
        if index + parts.len() > tokens.len() {
            continue;
        }

        let first_parts_match = parts
            .iter()
            .take(parts.len().saturating_sub(1))
            .enumerate()
            .all(|(offset, part)| tokens[index + offset].key == *part);
        if !first_parts_match {
            continue;
        }

        let last_offset = index + parts.len() - 1;
        let last_token = &tokens[last_offset].key;
        let last_part = parts[parts.len() - 1].as_str();

        let (matched, negative_suffix) = if last_token == last_part {
            (true, false)
        } else if let Some(negative) = negative_suffix_form(last_token, last_part) {
            (true, negative)
        } else if last_part.chars().count() >= 4 && last_token.starts_with(last_part) {
            let rest = &last_token[last_part.len()..];
            let rest_len = rest.chars().count();
            (rest_len <= 6, false)
        } else {
            (false, false)
        };

        if !matched {
            continue;
        }

        let hit = CueHit {
            span_len: parts.len(),
            alias_len: entry.alias_len,
            genre: entry.genre.clone(),
            negative_suffix,
        };
        let better = match best.as_ref() {
            None => true,
            Some(current) => {
                hit.span_len > current.span_len
                    || (hit.span_len == current.span_len && hit.alias_len > current.alias_len)
            }
        };
        if better {
            best = Some(hit);
        }
    }

    best
}

fn negative_suffix_form(token: &str, stem: &str) -> Option<bool> {
    let rest = token.strip_prefix(stem)?;
    if rest.is_empty() {
        return None;
    }
    if rest == "siz" || rest == "suz" || rest == "sizlik" || rest == "suzluk" {
        return Some(true);
    }
    None
}

/// Finite qualified/theme suppression for genre cues (same-clause only).
///
/// Returns true when a genre cue must not become a genre signal:
///
/// - `kalitesiz <genre>` (e.g. "kalitesiz dram"): the user is qualifying
///   quality, not banning the genre. Only the immediately preceding token
///   in the same clause chunk counts. Other quality words and word orders
///   are intentionally not handled (documented limit).
/// - `aşk üçgeni` (love triangle): "<ask-variant> + ucgeni" names a trope,
///   not the romance genre. Only the same-clause immediate follow is
///   suppressed, so standalone "aşk"/"romantik" still maps to romance.
///
/// `end` is the last token of the cue span; the trope token, when present,
/// is at `end + 1`.
fn is_suppressed_qualified_genre(
    tokens: &[Token],
    index: usize,
    end: usize,
    genre: &str,
) -> bool {
    if index > 0
        && tokens[index - 1].clause == tokens[index].clause
        && tokens[index - 1].key == "kalitesiz"
    {
        return true;
    }
    if theme_id_for_suppressed(tokens, index, end, genre).is_some() {
        return true;
    }
    // "zaman yolculuğu" / "time travel": the bundled `time-travel`
    // theme stays a free-text theme, never a hard metadata genre. The
    // `yolculuk` / `travel` piece must not become the `adventure` hard
    // genre here.
    if genre == "adventure" && index > 0 && tokens[index - 1].clause == tokens[index].clause
        && matches!(tokens[index - 1].key.as_str(), "zaman" | "time")
    {
        return true;
    }
    false
}

/// Canonical negative-theme id for the two qualified tropes that can
/// become hard, tag-only exclusions, or `None` for any other
/// suppressed cue. Shared with [`is_suppressed_qualified_genre`];
/// no new synonyms are added.
fn theme_id_for_suppressed(
    tokens: &[Token],
    index: usize,
    end: usize,
    genre: &str,
) -> Option<&'static str> {
    if genre == "romance" {
        let first = tokens[index].key.as_str();
        let turkish_love = matches!(first, "ask" | "aski" | "askin" | "aska");
        if turkish_love || first == "love" {
            if end + 1 < tokens.len()
                && tokens[end + 1].clause == tokens[index].clause
                && matches!(
                    tokens[end + 1].key.as_str(),
                    "ucgeni" | "ucgen" | "triangle" | "triangles"
                )
            {
                return Some("love-triangle");
            }
        }
    }
    if genre == "harem" {
        if end + 1 < tokens.len()
            && tokens[end + 1].clause == tokens[index].clause
            && matches!(
                tokens[end + 1].key.as_str(),
                "temasi"
                    | "temali"
                    | "temasiz"
                    | "temada"
                    | "temadan"
                    | "theme"
                    | "themes"
                    | "trope"
                    | "tropes"
                    | "element"
                    | "elements"
            )
        {
            return Some("harem");
        }
    }
    None
}

/// Finite postnominal nonexistence modifiers.
///
/// Turkish `-mayan/-meyen` participles follow the noun phrase they
/// negate: "Harem olmayan ...", "harem teması olmayan ...",
/// "kalitesiz dram içermeyen ...". They bind only the immediately
/// preceding noun/list (within `MAX_SCOPE` tokens), never a later
/// affirmative genre or term in the same clause. Verbal markers
/// ("istemiyorum", "sevmem", "severim") keep the historical symmetric
/// nearest-marker behaviour so coordinated negatives
/// ("korku ve komedi istemiyorum") and contrast pairs
/// ("korku sevmem aksiyon severim") are preserved.
fn is_postnominal_negative(token: &str) -> bool {
    matches!(token, "olmayan" | "icermeyen" | "sevilmeyen")
}

fn nearest_marker(
    tokens: &[Token],
    start: usize,
    end: usize,
    markers: &[(usize, i8)],
) -> Option<i8> {
    let clause = tokens[start].clause;
    let mut best: Option<(usize, bool, i8)> = None;

    for (marker_index, polarity) in markers {
        if tokens[*marker_index].clause != clause {
            continue;
        }
        if *polarity < 0
            && is_postnominal_negative(&tokens[*marker_index].key)
            && *marker_index < start
        {
            // Postnominal "olmayan"/"icermeyen" binds the preceding
            // noun/list only. It must not spill onto later genres
            // or terms in the same clause (e.g. the fantasy/action/
            // mystery in "Harem olmayan fantastik aksiyon gizem").
            continue;
        }
        let distance = if *marker_index < start {
            start - *marker_index
        } else if *marker_index > end {
            *marker_index - end
        } else {
            0
        };
        if distance > MAX_SCOPE {
            continue;
        }

        let after = *marker_index >= start;
        let replace = match best {
            None => true,
            Some((best_distance, best_after, _)) => {
                distance < best_distance || (distance == best_distance && after && !best_after)
            }
        };
        if replace {
            best = Some((distance, after, *polarity));
        }
    }

    best.map(|(_, _, polarity)| polarity)
}

fn marker_polarity(token: &str) -> Option<i8> {
    if NEGATIVE_MARKERS.contains(&token) {
        Some(-1)
    } else if POSITIVE_MARKERS.contains(&token) {
        Some(1)
    } else {
        None
    }
}

fn is_stopword(token: &str) -> bool {
    STOPWORDS.contains(&token)
}

/// Lexicon entry: normalized alias token sequence -> canonical genre slug.
struct LexiconEntry {
    parts: Vec<String>,
    alias_len: usize,
    genre: String,
}

/// Genre-recognition lexicon derived from the bundled taxonomy.
///
/// Primary source: `taxonomy::bundled_options()` filtered to genre-group
/// options only. Each option contributes three alias surfaces:
/// `id` (canonical slug, e.g. `slice-of-life`), `original_label`
/// (English source name, e.g. `Slice of Life`) and `label` (Turkish
/// label, e.g. `Gündelik Yaşam`). All surfaces are normalized via
/// `normalize_for_search` so Turkish diacritics fold and punctuation
/// (`-`, `_`) splits into word boundaries. A category/theme option
/// (`group` not containing `genre`, e.g. `time-travel`) is deliberately
/// excluded so descriptive phrases like `zaman yolculuğu` keep
/// free-theme (term) matching and never become hard metadata genres.
///
/// Legacy synonyms (`CUE_ALIASES`) are added afterwards only when their
/// normalized alias is not already provided by the taxonomy, so the
/// 11 original genres keep exact behaviour and taxonomy-canonical
/// meanings win ties (e.g. `buyu` -> `magic` distinct from `fantasy`,
/// `savas` -> `war`, `uzay` -> `space`).
fn genre_lexicon() -> &'static Vec<LexiconEntry> {
    static LEXICON: OnceLock<Vec<LexiconEntry>> = OnceLock::new();
    LEXICON.get_or_init(|| {
        let mut lexicon: Vec<LexiconEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        let push_alias = |lexicon: &mut Vec<LexiconEntry>,
                          seen: &mut std::collections::HashSet<String>,
                          raw_alias: &str,
                          canonical: &str| {
            // `anime` kept as the legacy `animation` cue for the 11
            // ML axes (see loop below). The taxonomy `anime` id is
            // remapped so bare "anime" / "animeleri" preserve the
            // historical `animation` behaviour and SessionIntent
            // stripping, while metadata `anime` still survives.
            let canonical = if canonical == "anime" { "animation" } else { canonical };
            let normalized = normalize_for_search(raw_alias);
            if normalized.is_empty() {
                return;
            }
            // Multiword phrases are kept whole: "gundelik yasam" /
            // "slice of life" are never split into single cues.
            if !seen.insert(normalized.clone()) {
                return;
            }
            let parts = normalized.split_whitespace().map(str::to_string).collect::<Vec<_>>();
            if parts.is_empty() {
                return;
            }
            lexicon.push(LexiconEntry {
                alias_len: normalized.len(),
                parts,
                genre: canonical.to_string(),
            });
        };

        for option in taxonomy::bundled_options() {
            // Only hard genre options become genre cues. Categories /
            // themes stay free-text terms.
            if !option.group.to_lowercase().contains("genre") {
                continue;
            }
            let canonical = taxonomy::canonical_slug(&option.id)
                .unwrap_or_else(|| option.id.clone());
            push_alias(&mut lexicon, &mut seen, &option.id.replace('-', " "), &canonical);
            push_alias(&mut lexicon, &mut seen, &option.id, &canonical);
            push_alias(&mut lexicon, &mut seen, &option.original_label, &canonical);
            push_alias(&mut lexicon, &mut seen, &option.label, &canonical);
        }

        // Legacy synonyms for the original 11 + explicit short-stem aids.
        // Taxonomy-covered aliases are skipped (dedup above), so legacy
        // never overrides a taxonomy-canonical meaning.
        for (alias, genre) in CUE_ALIASES {
            push_alias(&mut lexicon, &mut seen, alias, genre);
        }

        // `slice-of-life` Turkish surface: the bundled label is
        // "Gündelik Hayat (Slice of Life)" (6 tokens), but users write
        // "gündelik yaşam". Add the short, explicit surfaces whole.
        push_alias(&mut lexicon, &mut seen, "gündelik yaşam", "slice-of-life");
        push_alias(&mut lexicon, &mut seen, "gündelik hayat", "slice-of-life");

        // Sort longest-first so multiword phrases win deterministically
        // even before the longest-span tie-break in `find_cue`.
        // Tie-break on alias character length so an exact long alias
        // (e.g. `polisiye` -> mystery, 8) wins over a prefix match on a
        // shorter alias (e.g. `polis` -> police, 5).
        lexicon.sort_by(|a, b| {
            b.parts
                .len()
                .cmp(&a.parts.len())
                .then_with(|| b.alias_len.cmp(&a.alias_len))
        });
        lexicon
    })
}

fn item_text_tokens(item: &CatalogItem) -> Vec<String> {
    let mut tokens = Vec::new();
    for text in [item.title.as_str(), item.description.as_str()] {
        for token in normalize_for_search(text).split_whitespace() {
            if token.chars().count() >= 3 {
                tokens.push(token.to_string());
            }
        }
    }
    tokens
}

fn term_matches(term: &str, item_tokens: &[String]) -> bool {
    let term_len = term.chars().count();
    item_tokens.iter().any(|token| {
        token == term
            || (term_len >= 4 && token.starts_with(term))
            || (token.chars().count() >= 4 && term.starts_with(token.as_str()))
    })
}

const CUE_ALIASES: &[(&str, &str)] = &[
    // English descriptive cue surfaces. The curated taxonomy supplies the
    // canonical id and label for each genre; these add common plain-English
    // ways of asking for the same idea.
    ("emotional", "drama"),
    ("emotion", "drama"),
    ("romantic", "romance"),
    ("love", "romance"),
    ("funny", "comedy"),
    ("humor", "comedy"),
    ("humour", "comedy"),
    ("scary", "horror"),
    ("frightening", "horror"),
    ("terrifying", "horror"),
    ("detective", "mystery"),
    ("space", "sci-fi"),
    ("spaceship", "sci-fi"),
    ("alien", "sci-fi"),
    ("aliens", "sci-fi"),
    ("robot", "sci-fi"),
    ("robots", "sci-fi"),
    ("dragon", "fantasy"),
    ("dragons", "fantasy"),
    ("sport", "sports"),
    ("spor", "sports"),
    ("criminal", "crime"),
    ("suç", "crime"),
    ("historical", "history"),
    ("tarih", "history"),
    ("müzik", "music"),
    ("savaş", "war"),
    ("belgesel", "documentary"),
    ("aile", "family"),
    ("psikolojik", "psychological"),
    ("büyü", "magic"),
    ("doğaüstü", "supernatural"),
    ("okul", "school"),
    ("battle", "war"),
    // Legacy synonyms for the original 11 genres. Taxonomy-covered
    // aliases (same normalized alias) are skipped in `genre_lexicon`,
    // so the bundled taxonomy always wins ties.
    // Keep these for Turkish input compatibility.
    // action
    ("aksiyon", "action"),
    ("dovus", "action"),
    ("super kahraman", "action"),
    ("mafya", "action"),
    // comedy
    ("komedi", "comedy"),
    ("komik", "comedy"),
    ("gulduru", "comedy"),
    ("mizah", "comedy"),
    ("eglenceli", "comedy"),
    // drama
    ("dram", "drama"),
    ("huzunlu", "drama"),
    ("duygusal", "drama"),
    // romance
    ("romantik", "romance"),
    ("romantizm", "romance"),
    ("ask", "romance"),
    ("aski", "romance"),
    ("askin", "romance"),
    ("aska", "romance"),
    // thriller
    ("gerilim", "thriller"),
    ("heyecan", "thriller"),
    // mystery
    ("gizem", "mystery"),
    ("polisiye", "mystery"),
    ("dedektif", "mystery"),
    ("sir", "mystery"),
    ("siri", "mystery"),
    ("sirri", "mystery"),
    // fantasy
    ("fantastik", "fantasy"),
    ("fantezi", "fantasy"),
    ("ejderha", "fantasy"),
    ("masal", "fantasy"),
    // sci-fi
    ("bilim kurgu", "sci-fi"),
    ("bilimkurgu", "sci-fi"),
    ("sci fi", "sci-fi"),
    ("scifi", "sci-fi"),
    ("uzay", "sci-fi"),
    ("uzayli", "sci-fi"),
    ("robot", "sci-fi"),
    ("kiyamet", "sci-fi"),
    ("distopya", "sci-fi"),
    ("yapay zeka", "sci-fi"),
    // animation
    ("animasyon", "animation"),
    ("anime", "animation"),
    ("cizgi film", "animation"),
    ("cizgi", "animation"),
    // adventure
    ("macera", "adventure"),
    ("yolculuk", "adventure"),
    ("kesif", "adventure"),
    ("hazine", "adventure"),
    // horror
    ("korku", "horror"),
    ("dehset", "horror"),
    ("kanli", "horror"),
    ("zombi", "horror"),
    ("vampir", "horror"),
    ("canavar", "horror"),
    // Explicit short-stem aids that prefix matching cannot cover
    // (`suc` is 3 chars, so `suclu` needs its own exact alias).
    ("suclu", "crime"),
];

const NEGATIVE_MARKERS: &[&str] = &[
    // English polarity markers.
    "no",
    "not",
    "nor",
    "without",
    "never",
    "dislike",
    "dislikes",
    "disliked",
    "hate",
    "hates",
    "hated",
    "avoid",
    "avoids",
    "avoiding",
    "exclude",
    "excludes",
    "excluding",
    "except",
    "minus",
    "anti",
    "nothing",
    // Turkish polarity markers.
    "sevmiyorum",
    "sevmiyor",
    "sevmem",
    "sevmez",
    "sevmedim",
    "sevmedigim",
    "sevmiyordum",
    "sevmeyecegim",
    "sevilmeyen",
    "begenmiyorum",
    "begenmem",
    "begenmedim",
    "begenmedigim",
    "hoslanmiyorum",
    "hoslanmam",
    "hoslanmadim",
    "hoslanmadigim",
    "istemiyorum",
    "istemem",
    "istemedim",
    "istemedigim",
    "nefret",
    "tiksiniyorum",
    "tiksinirim",
    "katlanamiyorum",
    "katlanamam",
    "cekemiyorum",
    "cekemem",
    "sikici",
    "sikildim",
    "bayiyor",
    "baydim",
    "bunaltiyor",
    "olmasin",
    "olmayan",
    "olmayacak",
    "olmaz",
    // "içermeyen" = "without containing" (post-nominal, clause-scoped).
    "icermeyen",
    "degil",
    "degilim",
    "degildir",
    "yok",
    "asla",
    "hayir",
    "hic",
    "uzak",
    "dusman",
    "dusmani",
    "rahatsiz",
    "korkutuyor",
];

const POSITIVE_MARKERS: &[&str] = &[
    // English polarity markers. "love" is deliberately a romance cue instead,
    // so "no love triangles" is not read as a positive romance signal.
    "like",
    "likes",
    "liked",
    "enjoy",
    "enjoys",
    "enjoyed",
    "prefer",
    "prefers",
    "preferred",
    "want",
    "wants",
    "wanted",
    "favorite",
    "favourite",
    "favorites",
    "favourites",
    "adore",
    "adores",
    "good",
    "great",
    "amazing",
    "excellent",
    "fun",
    // Turkish polarity markers.
    "seviyorum",
    "severim",
    "sevdim",
    "sevdigim",
    "sevdigimiz",
    "seviyor",
    "sevmek",
    "sevilen",
    "begeniyorum",
    "begenirim",
    "begendim",
    "begendigim",
    "begeniyor",
    "hoslaniyorum",
    "hoslanirim",
    "hoslandim",
    "hosuma",
    "istiyorum",
    "isterim",
    "istedigim",
    "tercih",
    "tercihim",
    "bayiliyorum",
    "bayildim",
    "favori",
    "favorim",
    "favorilerim",
    "ilgimi",
    "cekiyor",
    "merakliyim",
    "merak",
    "hayranim",
    "hayran",
    "guzel",
    "iyi",
    "harika",
    "mukemmel",
    "eglenceli",
    "keyifli",
    "keyif",
    "surukleyici",
    "akici",
    "etkileyici",
    "basarili",
    "kaliteli",
    "olsun",
    "olsa",
];

const STOPWORDS: &[&str] = &[
    // English function words.
    "a",
    "an",
    "and",
    "or",
    "the",
    "this",
    "that",
    "these",
    "those",
    "with",
    "of",
    "in",
    "on",
    "for",
    "to",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "its",
    "as",
    "at",
    "by",
    "from",
    "into",
    "about",
    "around",
    "but",
    "however",
    "though",
    "although",
    "yet",
    "very",
    "really",
    "just",
    "also",
    "some",
    "any",
    "all",
    "more",
    "most",
    "much",
    "many",
    "few",
    "less",
    "least",
    "new",
    "old",
    "classic",
    "modern",
    "movie",
    "movies",
    "film",
    "films",
    "series",
    "show",
    "shows",
    "tv",
    "anime",
    "watch",
    "watching",
    "something",
    "anything",
    "thing",
    "things",
    "stuff",
    "would",
    "could",
    "should",
    "can",
    "cannot",
    "cant",
    "dont",
    "doesnt",
    "i",
    "im",
    "ive",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "they",
    "them",
    "their",
    // Turkish function words.
    "bir",
    "bu",
    "su",
    "o",
    "ve",
    "ile",
    "veya",
    "yahut",
    "ya",
    "da",
    "de",
    "ki",
    "cok",
    "az",
    "daha",
    "en",
    "gibi",
    "icin",
    "olan",
    "olarak",
    "olur",
    "olursa",
    "film",
    "filmler",
    "filmi",
    "filmleri",
    "filminde",
    "filmlerinde",
    "dizi",
    "diziler",
    "dizisi",
    "dizileri",
    "bolum",
    "bolumler",
    "anime",
    "animeler",
    "izlemek",
    "izlemeyi",
    "izlerim",
    "izledim",
    "izlemis",
    "seyretmek",
    "seyrettim",
    "bakmak",
    "tur",
    "turler",
    "tarz",
    "tarzi",
    "tarzinda",
    "tarzindaki",
    "cesit",
    "cesitli",
    "sey",
    "seyler",
    "bana",
    "ben",
    "benim",
    "sen",
    "senin",
    "onun",
    "biz",
    "siz",
    "onlar",
    "var",
    "mi",
    "mu",
    "midir",
    "misin",
    "olabilir",
    "guzel",
    "iyi",
    "kotu",
    "harika",
    "mukemmel",
    "favori",
    "keyifli",
    "eglenceli",
    "surukleyici",
    "akici",
    "etkileyici",
    "basarili",
    "kaliteli",
    "yeni",
    "eski",
    "klasik",
    "modern",
    "turk",
    "turkce",
    "yerli",
    "yabanci",
    "dublaj",
    "dublajli",
    "altyazili",
    "altyazi",
    "puan",
    "yuksek",
    "dusuk",
    "sure",
    "uzun",
    "kisa",
    "yavas",
    "hizli",
    "ruh",
    "hali",
    "mod",
    "mood",
    "atmosfer",
    "enerji",
    "hikaye",
    "hikayesi",
    "hikayeler",
    "hikayeleri",
    "konu",
    "konusu",
    "senaryo",
    "oyunculuk",
    "muzik",
    "gorsel",
    "efekt",
    "efektler",
    "sahne",
    "sahneler",
    "insan",
    "kisi",
    "karakter",
    "karakterler",
    "hayat",
    "yasam",
    "dunya",
    "zaman",
    "her",
    "hep",
    "bazen",
    "biraz",
    "fazla",
    "baska",
    "bazi",
    "tum",
    "butun",
    "kadar",
    "sonra",
    "once",
    "simdi",
    "artik",
    "yine",
    "ozellikle",
    "genellikle",
    "mesela",
    "ornegin",
    "benzer",
    "tema",
    "temasi",
    "temasini",
    "temali",
    "temasiz",
    "konulu",
    "hakkindaki",
    "hakkinda",
    "dair",
    "ilgili",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, genres: &[&str], description: &str) -> CatalogItem {
        CatalogItem {
            id: id.to_string(),
            title: id.to_string(),
            kind: kind.to_string(),
            year: 2022,
            genres: genres.iter().map(|genre| genre.to_string()).collect(),
            description: description.to_string(),
            source_url: String::new(),
            poster_url: None,
            rating: None,
            rating_source: None,
            rating_count: None,
            ratings: Vec::new(),
        }
    }

    #[test]
    fn turkish_normalization_folds_diacritics_and_case() {
        assert_eq!(normalize_for_search("Karanlık Şehir, IŞIK!"), "karanlik sehir isik");
        assert_eq!(normalize_for_search("BİLİM KURGU"), "bilim kurgu");
    }

    #[test]
    fn positive_and_negative_genre_cues_are_interpreted() {
        let taste = TasteProfile::parse("Korku ve gerilim sevmiyorum, komedi seviyorum.");
        let comedy = item("c", "movie", &["comedy"], "");
        let horror = item("h", "movie", &["horror"], "");

        assert!(taste.match_item(&comedy).positive_genres.contains(&"comedy".to_string()));
        assert!(taste.match_item(&horror).negative_genres.contains(&"horror".to_string()));
        assert!(taste.match_item(&horror).is_hard_negative());
    }

    #[test]
    fn explicit_dislike_and_negation_suffixes_are_understood() {
        let taste = TasteProfile::parse("Korkusuz filmler istiyorum; aksiyon istemiyorum.");
        let horror = item("h", "movie", &["horror"], "");
        let action = item("a", "movie", &["action"], "");

        assert!(taste.match_item(&horror).negative_genres.contains(&"horror".to_string()));
        assert!(taste.match_item(&action).negative_genres.contains(&"action".to_string()));
    }

    #[test]
    fn synonym_forms_and_multiword_cues_match() {
        let taste = TasteProfile::parse("Bilim kurgu ve polisiye severim.");
        let scifi = item("s", "movie", &["sci-fi"], "");
        let mystery = item("m", "movie", &["mystery"], "");

        assert!(taste.match_item(&scifi).positive_genres.contains(&"sci-fi".to_string()));
        assert!(taste.match_item(&mystery).positive_genres.contains(&"mystery".to_string()));
    }

    #[test]
    fn custom_theme_terms_match_title_and_synopsis() {
        let taste = TasteProfile::parse("Denizaltı ve satranç temalı hikâyeler severim.");
        let matching = item(
            "d",
            "movie",
            &["thriller"],
            "Bir denizaltında geçen satranç turnuvası.",
        );
        let other = item("o", "movie", &["comedy"], "Bir düğün hikâyesi.");

        let matching_match = taste.match_item(&matching);
        assert!(matching_match
            .positive_terms
            .iter()
            .any(|term| term.key == "denizalti"));
        assert!(matching_match.score > 0.0);
        assert_eq!(taste.match_item(&other).positive_terms.len(), 0);
    }

    #[test]
    fn contrast_clauses_do_not_bleed_negation() {
        let taste = TasteProfile::parse("Korku sevmiyorum ama komedi seviyorum.");
        let comedy = item("c", "movie", &["comedy"], "");
        let horror = item("h", "movie", &["horror"], "");

        assert!(taste.match_item(&comedy).positive_genres.contains(&"comedy".to_string()));
        assert!(!taste.match_item(&comedy).is_hard_negative());
        assert!(taste.match_item(&horror).is_hard_negative());
    }

    // Regression: exact sample BEFORE/AFTER (diagnostic run pre-fix).
    //
    // BEFORE:
    //   positive_genres=["animation"]
    //   negative_genres=["drama", "romance", "fantasy", "horror"]
    //   positive_terms=[gecen, evren, kurgusu, karakterleri, isleyen]
    //   negative_terms=[sakin, kalitesiz, icermeyen, kliselerden,
    //     sakinlestirici, ucgeni, harem, evrenlerde, iceren, ... (16 cap)]
    //   -> fantasy/romance/drama wrongly hard-banned; "sakin" and
    //   "sakinlestirici" wrongly negative ("uzak"/"olmayan" bled across
    //   commas into later chunks).
    //
    // AFTER (asserted below):
    //   positive_genres contains fantasy + animation
    //   negative_genres contains horror only (no drama/romance/fantasy)
    //   positive_terms contains sakin + sakinlestirici + evren terms
    //   negative_terms contains kalitesiz + ucgeni + harem + kliselerden
    //
    // Limits: finite parser. "kalitesiz dram" is a soft term, not a quality
    // verdict on any title; synopses almost never state quality, so that
    // term rarely matches. Worldbuilding / character-development are plain
    // token evidence ("evren", "kurgusu", ...) only when stated explicitly.
    #[test]
    fn exact_sample_does_not_ban_fantasy_romance_or_drama() {
        let sample = "Sakin, kalitesiz dram içermeyen, klişelerden uzak, sakinleştirici, aşk üçgeni ve harem teması olmayan, fantastik evrenlerde geçen, evren kurgusu iyi olan ve karakterleri iyi işleyen animeleri severim; kalitesiz dram içeren, saçma sapan yerlerde klişeler patlatan veya ana karakterin hiç işlenmeden \"ben galiba en güçlüyüm\" tavrıyla evreni ve herkesi domine ettiği tarzları sevmem. korku sevmem";
        let taste = TasteProfile::parse(sample);

        assert!(taste
            .positive_genres
            .iter()
            .any(|genre| genre == "fantasy"));
        assert!(taste
            .positive_genres
            .iter()
            .any(|genre| genre == "animation"));
        assert!(taste
            .negative_genres
            .iter()
            .any(|genre| genre == "horror"));
        assert!(!taste
            .negative_genres
            .iter()
            .any(|genre| genre == "drama"));
        assert!(!taste
            .negative_genres
            .iter()
            .any(|genre| genre == "romance"));
        assert!(!taste
            .negative_genres
            .iter()
            .any(|genre| genre == "fantasy"));

        let positive_keys = taste
            .positive_terms
            .iter()
            .map(|term| term.key.as_str())
            .collect::<Vec<_>>();
        let negative_keys = taste
            .negative_terms
            .iter()
            .map(|term| term.key.as_str())
            .collect::<Vec<_>>();
        assert!(positive_keys.contains(&"sakin"));
        assert!(positive_keys.contains(&"sakinlestirici"));
        assert!(positive_keys.contains(&"evren"));
        assert!(!negative_keys.contains(&"sakin"));
        assert!(!negative_keys.contains(&"sakinlestirici"));
        assert!(negative_keys.contains(&"kalitesiz"));
        assert!(negative_keys.contains(&"kliselerden"));
        assert!(negative_keys.contains(&"ucgeni"));
        assert!(negative_keys.contains(&"harem"));

        let drama = item("d", "anime", &["drama"], "");
        let romance = item("r", "anime", &["romance"], "");
        let fantasy = item("f", "anime", &["fantasy"], "");
        let horror = item("h", "anime", &["horror"], "");
        assert!(!taste.match_item(&drama).is_hard_negative());
        assert!(!taste.match_item(&romance).is_hard_negative());
        assert!(taste
            .match_item(&fantasy)
            .positive_genres
            .contains(&"fantasy".to_string()));
        assert!(!taste.match_item(&fantasy).is_hard_negative());
        assert!(taste.match_item(&horror).is_hard_negative());

        // Theme evidence is explicit-only: a calm fantasy synopsis that
        // states calm wording scores positively; an empty synopsis is not
        // claimed to be calm.
        let calm = item(
            "c",
            "anime",
            &["fantasy"],
            "Sakin ve sakinleştirici bir evren kurgusu hikayesi.",
        );
        let calm_match = taste.match_item(&calm);
        assert!(calm_match.score > 0.0);
        assert!(!taste
            .match_item(&fantasy)
            .positive_terms
            .iter()
            .any(|term| term.key == "sakin"));

        // Love-triangle / harem exclusions are soft theme penalties on
        // explicit wording, not a hard romance/fantasy ban.
        let triangle = item(
            "t",
            "anime",
            &["romance"],
            "Bir aşk üçgeni ve harem temalı hikaye.",
        );
        let triangle_match = taste.match_item(&triangle);
        assert!(triangle_match.score < 0.0);
        assert!(!triangle_match.is_hard_negative());
        assert!(triangle_match
            .negative_terms
            .iter()
            .any(|term| term.key == "ucgeni"));
        assert!(triangle_match
            .negative_terms
            .iter()
            .any(|term| term.key == "harem"));

        // Candid limit: no quality verdict is invented. A neutral drama
        // synopsis gets no low-quality penalty without explicit wording.
        let neutral_drama = item("n", "anime", &["drama"], "Aile içi bir hikaye.");
        let neutral_match = taste.match_item(&neutral_drama);
        assert!(!neutral_match.is_hard_negative());
        assert!(neutral_match.negative_terms.is_empty());
    }

    #[test]
    fn qualified_low_quality_drama_does_not_ban_drama_genre() {
        for phrase in [
            "kalitesiz dram içermeyen",
            "kalitesiz dram istemiyorum",
            "kalitesiz dram içeren tarzları sevmem",
        ] {
            let taste = TasteProfile::parse(phrase);
            assert!(
                !taste
                    .negative_genres
                    .iter()
                    .any(|genre| genre == "drama"),
                "phrase {phrase:?} must not ban drama: {taste:?}"
            );
            assert!(
                !taste
                    .positive_genres
                    .iter()
                    .any(|genre| genre == "drama"),
                "phrase {phrase:?} must not promote drama: {taste:?}"
            );
            assert!(
                taste
                    .negative_terms
                    .iter()
                    .any(|term| term.key == "kalitesiz"),
                "phrase {phrase:?} should keep a kalitesiz theme term: {taste:?}"
            );
            let drama = item("d", "anime", &["drama"], "");
            assert!(!taste.match_item(&drama).is_hard_negative());
        }

        // Unqualified drama keeps the old genre behaviour.
        let dislike = TasteProfile::parse("dram istemiyorum");
        assert!(dislike
            .negative_genres
            .iter()
            .any(|genre| genre == "drama"));
        let like = TasteProfile::parse("dram severim");
        assert!(like
            .positive_genres
            .iter()
            .any(|genre| genre == "drama"));
    }

    #[test]
    fn love_triangle_and_harem_do_not_ban_romance() {
        for phrase in [
            "aşk üçgeni ve harem teması olmayan",
            "aşk üçgeni olmayan",
        ] {
            let taste = TasteProfile::parse(phrase);
            assert!(
                !taste
                    .negative_genres
                    .iter()
                    .any(|genre| genre == "romance"),
                "phrase {phrase:?} must not ban romance: {taste:?}"
            );
            assert!(
                !taste
                    .negative_genres
                    .iter()
                    .any(|genre| genre == "fantasy"),
                "phrase {phrase:?} must not ban fantasy: {taste:?}"
            );
            assert!(
                taste
                    .negative_terms
                    .iter()
                    .any(|term| term.key == "ucgeni"),
                "phrase {phrase:?} should keep a ucgeni theme term: {taste:?}"
            );
            let romance = item("r", "anime", &["romance"], "");
            assert!(!taste.match_item(&romance).is_hard_negative());
        }

        let harem = TasteProfile::parse("harem teması olmayan");
        assert!(harem
            .negative_terms
            .iter()
            .any(|term| term.key == "harem"));
        assert!(!harem
            .negative_genres
            .iter()
            .any(|genre| genre == "romance"));

        // Standalone romance/fantasy cues are unaffected.
        let romance = TasteProfile::parse("romantik severim");
        assert!(romance
            .positive_genres
            .iter()
            .any(|genre| genre == "romance"));
        let fantasy = TasteProfile::parse("fantastik severim");
        assert!(fantasy
            .positive_genres
            .iter()
            .any(|genre| genre == "fantasy"));
    }

    #[test]
    fn comma_semicolon_and_contrast_scope_isolation() {
        let taste = TasteProfile::parse("fantastik severim, korku sevmiyorum");
        assert!(taste
            .positive_genres
            .iter()
            .any(|genre| genre == "fantasy"));
        assert!(taste
            .negative_genres
            .iter()
            .any(|genre| genre == "horror"));
        assert!(!taste
            .negative_genres
            .iter()
            .any(|genre| genre == "fantasy"));

        let taste = TasteProfile::parse("korku sevmiyorum; komedi seviyorum");
        assert!(taste
            .positive_genres
            .iter()
            .any(|genre| genre == "comedy"));
        assert!(taste
            .negative_genres
            .iter()
            .any(|genre| genre == "horror"));
        assert!(!taste
            .negative_genres
            .iter()
            .any(|genre| genre == "comedy"));

        // Calm terms stay positive across a comma before a horror dislike.
        let taste = TasteProfile::parse("sakin, sakinleştirici severim, korku sevmem");
        assert!(taste
            .positive_terms
            .iter()
            .any(|term| term.key == "sakin"));
        assert!(!taste
            .negative_terms
            .iter()
            .any(|term| term.key == "sakin"));
        assert!(taste
            .negative_genres
            .iter()
            .any(|genre| genre == "horror"));
    }

    #[test]
    fn example_full_list_is_recognizable() {
        let taste = TasteProfile::parse(
            "suç belgesel spor psikolojik gündelik yaşam isekai mecha müzik tarih savaş western büyü doğaüstü harem okul",
        );
        for expected in [
            "crime",
            "documentary",
            "sports",
            "psychological",
            "slice-of-life",
            "isekai",
            "mecha",
            "music",
            "history",
            "war",
            "western",
            "magic",
            "supernatural",
            "harem",
            "school",
        ] {
            assert!(
                taste
                    .positive_genres
                    .iter()
                    .any(|genre| genre == expected),
                "missing {expected} in {:?}",
                taste.positive_genres()
            );
        }
    }

    #[test]
    fn compound_psychological_and_daily_life_recognized() {
        let taste = TasteProfile::parse("psikolojik ve gündelik yaşam severim");
        assert!(taste.positive_genres().contains(&"psychological".to_string()));
        assert!(taste
            .positive_genres()
            .contains(&"slice-of-life".to_string()));
        // Whole phrase never splits into meaningless cues.
        assert!(!taste.positive_genres().iter().any(|g| g == "life"));
        // English whole phrase as well.
        assert!(TasteProfile::parse("slice of life severim")
            .positive_genres()
            .contains(&"slice-of-life".to_string()));
    }

    #[test]
    fn gibberish_creates_no_genre() {
        let taste = TasteProfile::parse("zxqv blorp qwerty");
        assert!(taste.positive_genres().is_empty());
        assert!(taste.negative_genres().is_empty());
    }

    #[test]
    fn magic_and_supernatural_distinct_from_fantasy() {
        assert!(TasteProfile::parse("büyü severim")
            .positive_genres()
            .contains(&"magic".to_string()));
        assert!(TasteProfile::parse("doğaüstü severim")
            .positive_genres()
            .contains(&"supernatural".to_string()));
        let pure = TasteProfile::parse("büyü severim");
        assert!(!pure.positive_genres().contains(&"fantasy".to_string()));
    }

    #[test]
    fn time_travel_stays_free_theme_not_hard_genre() {
        let taste = TasteProfile::parse("zaman yolculuğu severim");
        // Theme option must not become a hard metadata genre.
        assert!(!taste.positive_genres().contains(&"time-travel".to_string()));
        // Free-theme evidence still matches synopsis wording.
        let with_travel = item(
            "t",
            "movie",
            &["sci-fi"],
            "Bir zaman yolculuğu hikayesi.",
        );
        assert!(taste.match_item(&with_travel).score > 0.0);
    }

    #[test]
    fn bare_harem_negative_is_genre_but_harem_theme_stays_term() {
        let bare = TasteProfile::parse("Harem istemiyorum");
        assert!(bare.negative_genres().contains(&"harem".to_string()));
        let themed = TasteProfile::parse("harem teması olmayan");
        assert!(themed.negative_terms.iter().any(|t| t.key == "harem"));
        assert!(!themed.negative_genres().contains(&"romance".to_string()));
    }

    #[test]
    fn harem_olmayan_does_not_ban_later_fantasy_action_mystery() {
        // Regression: postnominal "olmayan" binds only the preceding
        // "Harem" noun. It must not spill forward onto the later
        // affirmative genres inside the same clause, with or without
        // intervening filler/quality adjectives and with or without
        // clause punctuation.
        for phrase in [
            "Harem olmayan iyi işlenmiş bir fantastik bir evrende geçen aksiyon gizem türünde.",
            "Harem olmayan fantastik aksiyon gizem",
            "Harem olmayan, fantastik aksiyon gizem.",
            "Harem olmayan fantastik, aksiyon gizem!",
            "Harem olmayan; fantastik aksiyon gizem",
            "Harem olmayan iyi işlenmiş fantastik aksiyon gizem severim",
        ] {
            let taste = TasteProfile::parse(phrase);
            assert!(
                taste
                    .positive_genres()
                    .contains(&"fantasy".to_string()),
                "phrase {phrase:?} should keep fantasy positive: {taste:?}"
            );
            assert!(
                taste
                    .positive_genres()
                    .contains(&"action".to_string()),
                "phrase {phrase:?} should keep action positive: {taste:?}"
            );
            assert!(
                taste
                    .positive_genres()
                    .contains(&"mystery".to_string()),
                "phrase {phrase:?} should keep mystery positive: {taste:?}"
            );
            assert!(
                taste.negative_genres().contains(&"harem".to_string()),
                "phrase {phrase:?} should ban harem: {taste:?}"
            );
            assert!(
                !taste.negative_genres().contains(&"fantasy".to_string()),
                "phrase {phrase:?} must not ban fantasy: {taste:?}"
            );
            assert!(
                !taste.negative_genres().contains(&"action".to_string()),
                "phrase {phrase:?} must not ban action: {taste:?}"
            );
            assert!(
                !taste.negative_genres().contains(&"mystery".to_string()),
                "phrase {phrase:?} must not ban mystery: {taste:?}"
            );
            assert_eq!(
                taste.negative_genres().len(),
                1,
                "phrase {phrase:?} should have negative harem ONLY: {taste:?}"
            );

            let full = item("full", "anime", &["fantasy", "action", "mystery"], "");
            let full_match = taste.match_item(&full);
            assert_eq!(
                full_match.positive_genres.len(),
                3,
                "phrase {phrase:?} full fixture must match all 3: {full_match:?}"
            );
            assert!(!full_match.is_hard_negative());

            let forbidden = item(
                "bad",
                "anime",
                &["fantasy", "action", "mystery", "harem"],
                "",
            );
            assert!(taste.match_item(&forbidden).is_hard_negative());
            assert!(taste
                .match_item(&forbidden)
                .negative_genres
                .contains(&"harem".to_string()));
        }
    }

    #[test]
    fn postnominal_icermeyen_does_not_ban_later_genres() {
        for phrase in [
            "kalitesiz dram içermeyen fantastik severim",
            "harem içermeyen fantastik aksiyon gizem",
            "aşk üçgeni ve harem teması olmayan fantastik severim",
        ] {
            let taste = TasteProfile::parse(phrase);
            assert!(
                !taste.negative_genres().contains(&"fantasy".to_string()),
                "phrase {phrase:?} must not ban fantasy: {taste:?}"
            );
            assert!(
                taste.positive_genres().contains(&"fantasy".to_string()),
                "phrase {phrase:?} should keep fantasy positive: {taste:?}"
            );
        }
    }

    #[test]
    fn coordinated_verbal_negatives_still_apply_to_both_nouns() {
        // Verbal markers keep the symmetric nearest behaviour.
        let both = TasteProfile::parse("korku ve komedi istemiyorum");
        assert!(both.negative_genres().contains(&"horror".to_string()));
        assert!(both.negative_genres().contains(&"comedy".to_string()));
        assert!(!both
            .positive_genres()
            .contains(&"horror".to_string()));
        assert!(!both
            .positive_genres()
            .contains(&"comedy".to_string()));

        let contrast = TasteProfile::parse("korku sevmem aksiyon severim");
        assert!(contrast.negative_genres().contains(&"horror".to_string()));
        assert!(contrast.positive_genres().contains(&"action".to_string()));
        assert!(!contrast.negative_genres().contains(&"action".to_string()));
        assert!(!contrast.positive_genres().contains(&"horror".to_string()));
    }
}
