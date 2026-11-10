//! Self-contained English genre and theme taxonomy.
//!
//! The list is intentionally small and curated. It is not derived from any
//! outside service or bundled media catalog, and it contains no provider
//! names. `GenreOption` keeps the existing wire fields (`id`, `label`,
//! `originalLabel`, `group`, `kinds`, `sources`); `sources` is always the
//! offline marker `bundled`.
//!
//! `canonical_slug` is a pure sanitiser plus a small alias table. It never
//! parses the option registry, so `model::normalize_genre` can delegate to it
//! without recursion.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub const MAX_SLUG_LEN: usize = 64;

/// One selectable taxonomy option returned by `genres_json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreOption {
    pub id: String,
    pub label: String,
    pub original_label: String,
    pub group: String,
    pub kinds: Vec<String>,
    pub sources: Vec<String>,
}

fn fold_turkish_char(c: char) -> char {
    match c {
        'ç' | 'Ç' => 'c',
        'ğ' | 'Ğ' => 'g',
        'ı' | 'I' | 'İ' | 'î' | 'Î' | 'í' | 'Í' | 'ì' | 'Ì' | 'ï' | 'Ï' => 'i',
        'ö' | 'Ö' => 'o',
        'ş' | 'Ş' => 's',
        'ü' | 'Ü' | 'û' | 'Û' | 'ù' | 'Ù' | 'ú' | 'Ú' => 'u',
        'â' | 'Â' | 'á' | 'Á' | 'à' | 'À' | 'ä' | 'Ä' => 'a',
        'é' | 'É' | 'è' | 'È' | 'ê' | 'Ê' | 'ë' | 'Ë' => 'e',
        'ñ' | 'Ñ' => 'n',
        other => other,
    }
}

/// Sanitise and canonicalise a user or catalog genre spelling.
///
/// Steps: trim, split camelCase (`SliceOfLife` -> `slice-of-life`), lowercase
/// and fold Turkish diacritics, collapse every run of non-alphanumeric
/// characters to `-`, trim dashes, reject empty/garbage/sentinel/over-long
/// values, then apply the true-alias table.
///
/// Well-formed unknown slugs such as `cyberpunk` or `neo-western` are retained
/// so future descriptive metadata survives without a provider registry.
pub fn canonical_slug(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    // CamelCase split before lowercasing: SliceOfLife -> Slice-Of-Life.
    let mut camel = String::with_capacity(trimmed.len() + 4);
    let chars: Vec<char> = trimmed.chars().collect();
    for (index, &ch) in chars.iter().enumerate() {
        if index > 0 && ch.is_uppercase() && chars[index - 1].is_lowercase() {
            camel.push('-');
        }
        camel.push(ch);
    }

    let lowered = camel.to_lowercase();
    let mut slug = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        let folded = fold_turkish_char(ch);
        if folded.is_ascii_alphanumeric() || folded == '-' {
            slug.push(folded);
        } else {
            slug.push('-');
        }
    }

    let mut collapsed = String::with_capacity(slug.len());
    let mut previous_dash = false;
    for ch in slug.chars() {
        if ch == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
            collapsed.push(ch);
        } else {
            previous_dash = false;
            collapsed.push(ch);
        }
    }

    let slug = collapsed.trim_matches('-').to_string();
    if slug.len() < 2 || slug.len() > MAX_SLUG_LEN {
        return None;
    }
    if !slug.chars().any(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    if !slug.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric())
        || !slug.chars().last().is_some_and(|ch| ch.is_ascii_alphanumeric())
    {
        return None;
    }

    match slug.as_str() {
        "unknown" | "none" | "null" | "undefined" | "n-a" | "na" | "tbd" | "empty" => {
            return None;
        }
        _ => {}
    }

    let canonical = match slug.as_str() {
        // Plain descriptive aliases only.
        "science-fiction" | "sciencefiction" | "scifi" | "bilim-kurgu" | "bilimkurgu" => "sci-fi",
        "sport" => "sports",
        "reality" | "realitytv" => "reality-tv",
        "children" => "kids",
        "talk" | "talkshow" => "talk-show",
        "romantic" | "romantik" => "romance",
        "aksiyon" => "action",
        "komedi" => "comedy",
        "dram" => "drama",
        "gerilim" => "thriller",
        "gizem" => "mystery",
        "fantastik" => "fantasy",
        "animasyon" => "animation",
        "macera" => "adventure",
        "korku" => "horror",
        "belgesel" => "documentary",
        "suc" => "crime",
        "aile" => "family",
        "tarih" => "history",
        "muzik" => "music",
        "savas" => "war",
        "spor" => "sports",
        other => other,
    };
    Some(canonical.to_string())
}

/// Humanised fallback for a slug without a curated label.
fn humanize_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// English display label for a canonical slug.
///
/// Unknown well-formed slugs are humanised (`neo-western` -> `Neo Western`).
pub fn label(slug: &str) -> String {
    if let Some(canonical) = canonical_slug(slug) {
        if let Some(option) = bundled_options().iter().find(|option| option.id == canonical) {
            return option.label.clone();
        }
        return humanize_slug(&canonical);
    }
    slug.trim().to_string()
}

// --- Curated offline registry -----------------------------------------

const ALL_KINDS: &[&str] = &["movie", "series", "anime"];

struct OptionSpec {
    id: &'static str,
    label: &'static str,
    group: &'static str,
}

const OPTION_SPECS: &[OptionSpec] = &[
    OptionSpec { id: "action", label: "Action", group: "genre" },
    OptionSpec { id: "adventure", label: "Adventure", group: "genre" },
    OptionSpec { id: "animation", label: "Animation", group: "genre" },
    OptionSpec { id: "comedy", label: "Comedy", group: "genre" },
    OptionSpec { id: "crime", label: "Crime", group: "genre" },
    OptionSpec { id: "documentary", label: "Documentary", group: "genre" },
    OptionSpec { id: "drama", label: "Drama", group: "genre" },
    OptionSpec { id: "family", label: "Family", group: "genre" },
    OptionSpec { id: "fantasy", label: "Fantasy", group: "genre" },
    OptionSpec { id: "history", label: "History", group: "genre" },
    OptionSpec { id: "horror", label: "Horror", group: "genre" },
    OptionSpec { id: "music", label: "Music", group: "genre" },
    OptionSpec { id: "mystery", label: "Mystery", group: "genre" },
    OptionSpec { id: "romance", label: "Romance", group: "genre" },
    OptionSpec { id: "sci-fi", label: "Sci-Fi", group: "genre" },
    OptionSpec { id: "sports", label: "Sports", group: "genre" },
    OptionSpec { id: "thriller", label: "Thriller", group: "genre" },
    OptionSpec { id: "war", label: "War", group: "genre" },
    OptionSpec { id: "western", label: "Western", group: "genre" },
    OptionSpec { id: "psychological", label: "Psychological", group: "genre" },
    OptionSpec { id: "slice-of-life", label: "Slice of Life", group: "genre" },
    OptionSpec { id: "isekai", label: "Isekai", group: "genre" },
    OptionSpec { id: "mecha", label: "Mecha", group: "genre" },
    OptionSpec { id: "school", label: "School", group: "genre" },
    OptionSpec { id: "supernatural", label: "Supernatural", group: "genre" },
    OptionSpec { id: "magic", label: "Magic", group: "genre" },
    OptionSpec { id: "harem", label: "Harem", group: "genre" },
    OptionSpec { id: "kids", label: "Kids", group: "genre" },
    OptionSpec { id: "reality-tv", label: "Reality TV", group: "genre" },
    OptionSpec { id: "talk-show", label: "Talk Show", group: "genre" },
    OptionSpec { id: "time-travel", label: "Time Travel", group: "theme" },
    OptionSpec { id: "love-triangle", label: "Love Triangle", group: "theme" },
    OptionSpec { id: "love-polygon", label: "Love Polygon", group: "theme" },
    OptionSpec { id: "coming-of-age", label: "Coming of Age", group: "theme" },
];

fn build_bundled() -> Vec<GenreOption> {
    let mut options = OPTION_SPECS
        .iter()
        .map(|spec| GenreOption {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            original_label: spec.label.to_string(),
            group: spec.group.to_string(),
            kinds: ALL_KINDS.iter().map(|kind| (*kind).to_string()).collect(),
            sources: vec!["bundled".to_string()],
        })
        .collect::<Vec<_>>();

    options.sort_by(|a, b| {
        let rank = |group: &str| if group == "genre" { 0 } else { 1 };
        rank(&a.group)
            .cmp(&rank(&b.group))
            .then_with(|| a.id.cmp(&b.id))
    });
    options
}

/// All bundled options. Memoised and deterministic.
pub fn bundled_options() -> Vec<GenreOption> {
    static OPTIONS: OnceLock<Vec<GenreOption>> = OnceLock::new();
    OPTIONS.get_or_init(build_bundled).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_aliases_collapse_and_unknown_slugs_survive() {
        assert_eq!(canonical_slug("Science Fiction").as_deref(), Some("sci-fi"));
        assert_eq!(canonical_slug("sci-fi").as_deref(), Some("sci-fi"));
        assert_eq!(canonical_slug("sci_fi").as_deref(), Some("sci-fi"));
        assert_eq!(canonical_slug("Sport").as_deref(), Some("sports"));
        assert_eq!(canonical_slug("Children").as_deref(), Some("kids"));
        assert_eq!(canonical_slug("Romantic").as_deref(), Some("romance"));
        assert_eq!(canonical_slug("Komedi").as_deref(), Some("comedy"));
        assert_eq!(canonical_slug("SliceOfLife").as_deref(), Some("slice-of-life"));
        assert_eq!(canonical_slug("Slice of Life").as_deref(), Some("slice-of-life"));
        assert_eq!(canonical_slug("Cyberpunk").as_deref(), Some("cyberpunk"));
        assert_eq!(canonical_slug("Neo-Western").as_deref(), Some("neo-western"));
        assert_eq!(canonical_slug("!!!"), None);
        assert_eq!(canonical_slug("unknown"), None);
    }

    #[test]
    fn curated_options_are_english_offline_and_include_core_axes() {
        let options = bundled_options();
        for core in [
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
        ] {
            let option = options.iter().find(|option| option.id == core).expect(core);
            assert_eq!(option.label, label(core));
            assert!(!option.label.trim().is_empty());
        }
        assert_eq!(label("sci-fi"), "Sci-Fi");
        assert_eq!(label("slice-of-life"), "Slice of Life");
        assert_eq!(label("neo-western"), "Neo Western");
        for option in &options {
            assert_eq!(option.sources, vec!["bundled".to_string()]);
            assert_eq!(option.kinds, vec!["movie", "series", "anime"]);
            assert!(option.group == "genre" || option.group == "theme");
            assert!(!option.original_label.trim().is_empty());
        }
    }

    #[test]
    fn genre_and_theme_groups_are_separated() {
        let options = bundled_options();
        let by_id = |id: &str| options.iter().find(|option| option.id == id).expect(id);
        assert_eq!(by_id("harem").group, "genre");
        assert_eq!(by_id("isekai").group, "genre");
        assert_eq!(by_id("time-travel").group, "theme");
        assert_eq!(by_id("love-triangle").group, "theme");
    }
}
