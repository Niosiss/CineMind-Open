import type { CatalogSource, Kind, Mood, Preference } from './types'

/**
 * Fallback genre list used while a catalog is unavailable.
 * The full list comes from the local store's genre catalog; this
 * intentionally stays a small set and does not lock the type to it.
 */
export const GENRES: readonly string[] = [
  'action',
  'comedy',
  'drama',
  'romance',
  'thriller',
  'mystery',
  'fantasy',
  'sci-fi',
  'animation',
  'adventure',
  'horror',
]

export const GENRE_LABELS: Record<string, string> = {
  action: 'Action',
  comedy: 'Comedy',
  drama: 'Drama',
  romance: 'Romance',
  thriller: 'Thriller',
  mystery: 'Mystery',
  fantasy: 'Fantasy',
  'sci-fi': 'Sci-Fi',
  animation: 'Animation',
  adventure: 'Adventure',
  horror: 'Horror',
}

/** Plain fallback label; the genre catalog hook is preferred when available. */
export const genreLabel = (slug: string): string => GENRE_LABELS[slug] ?? slug

export const MOOD_OPTIONS: { value: Mood; label: string; hint: string }[] = [
  { value: 'relax', label: 'Relax', hint: 'Gentle, comforting stories that feel easy to sink into' },
  { value: 'uplift', label: 'Uplift', hint: 'Energetic stories with a hopeful spark' },
  { value: 'think', label: 'Think', hint: 'Layered stories that give your mind something to chew on' },
  { value: 'thrill', label: 'Thrill', hint: 'Fast-paced picks that keep you on the edge of your seat' },
  { value: 'feel', label: 'Feel', hint: 'Tender stories that hit close to the heart' },
]

export const moodLabel = (mood: Mood): string =>
  MOOD_OPTIONS.find((m) => m.value === mood)?.label ?? mood

export const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: 'movie', label: 'Movie' },
  { value: 'series', label: 'Series' },
  { value: 'anime', label: 'Anime' },
]

export const kindLabel = (kind: Kind): string =>
  KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind

export const preferenceLabel = (p: Preference): string =>
  p === 'liked' ? 'Liked' : 'Disliked'

/** Rating source labels; known identifiers get a clean display name. */
const RATING_SOURCE_LABELS: Record<string, string> = {
  imdb: 'IMDb',
  tmdb: 'TMDB',
  tvmaze: 'TVmaze',
  mal: 'MyAnimeList',
  myanimelist: 'MyAnimeList',
  'my anime list': 'MyAnimeList',
  'my-anime-list': 'MyAnimeList',
  'my_anime_list': 'MyAnimeList',
  jikan: 'Jikan (MyAnimeList)',
  tomatoes: 'Rotten Tomatoes',
  'rotten tomatoes': 'Rotten Tomatoes',
  'rotten-tomatoes': 'Rotten Tomatoes',
  rt: 'Rotten Tomatoes',
  popcorn: 'Rotten Tomatoes Audience',
  popcornometer: 'Rotten Tomatoes Audience',
  audience: 'Rotten Tomatoes Audience',
  'audience score': 'Rotten Tomatoes Audience',
  'rotten tomatoes audience': 'Rotten Tomatoes Audience',
  letterboxd: 'Letterboxd',
  mdblist: 'MDBList',
  'mdb list': 'MDBList',
  'mdb-list': 'MDBList',
  kitsu: 'Kitsu',
  trakt: 'Trakt',
  metacritic: 'Metacritic',
  rogerebert: 'Roger Ebert',
  'roger ebert': 'Roger Ebert',
  'roger-ebert': 'Roger Ebert',
  'roger_ebert': 'Roger Ebert',
}

export function ratingSourceLabel(source?: string): string {
  if (!source) return ''
  const key = source.trim().toLowerCase()
  if (RATING_SOURCE_LABELS[key]) return RATING_SOURCE_LABELS[key]
  // Flexible matching for common variants such as "Popcornometer".
  if (key.includes('popcorn') || key.includes('audience')) return 'Rotten Tomatoes Audience'
  if (key.includes('roger') || key.includes('ebert')) return 'Roger Ebert'
  if (key.includes('tomato') || key.includes('rotten')) return 'Rotten Tomatoes'
  if (key.includes('metacritic') || key.includes('metascore')) return 'Metacritic'
  if (key.includes('letterboxd')) return 'Letterboxd'
  if (key.includes('kitsu')) return 'Kitsu'
  if (key.includes('myanime') || key.includes('my anime') || key.includes('my-anime')) return 'MyAnimeList'
  if (key.includes('jikan')) return 'Jikan (MyAnimeList)'
  const compact = key.replace(/[\s_-]+/g, '')
  if (compact === 'mal') return 'MyAnimeList'
  if (compact === 'myanimelist') return 'MyAnimeList'
  return source.trim()
}

/** Neutral catalog source labels; no vendor-specific claims. */
export const CATALOG_SOURCE_INFO: Record<CatalogSource, { label: string; hint: string }> = {
  live: {
    label: 'Catalog data',
    hint: 'Titles come from the catalog you imported.',
  },
  local: {
    label: 'Local catalog',
    hint: 'Titles come from the catalog stored in this browser.',
  },
}
