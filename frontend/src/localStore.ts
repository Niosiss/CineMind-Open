/**
 * Browser-only CineMind store.
 *
 * This module replaces the old HTTP API client. It keeps the same async
 * method names and DTO shapes, but all state lives in versioned localStorage
 * and all ranking/training/genre work is delegated to the generated
 * wasm-bindgen web bindings. No fetch, axios, backend proxy or external
 * provider logic is used here.
 */

import init, {
  genres_json,
  rank_json,
  train_json,
} from './generated/cinemind_engine'
import type {
  CatalogDetails,
  CatalogItem,
  CatalogResponse,
  DetailFact,
  DetailSource,
  GenreCatalogItem,
  GenresResponse,
  Kind,
  LibraryEntry,
  LibraryResponse,
  Mood,
  Profile,
  RatingEntry,
  Recommendation,
  RecommendationsResponse,
} from './types'

export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const PREF_MAX = 2000
const IMPORT_MAX_BYTES = 2 * 1024 * 1024
const IMPORT_MAX_ITEMS = 2000
const CATALOG_PAGE_SIZE = 20
const RECOMMENDATION_PAGE_SIZE = 12

const MAX_ID = 200
const MAX_TITLE = 300
const MAX_DESCRIPTION = 5000
const MAX_GENRE = 80
const MAX_GENRES = 40
const MAX_URL = 2048
const MAX_SOURCE = 120
const MAX_REASON = 500

/**
 * Safe catalog id: no whitespace, path separators, control characters or
 * HTML-significant characters. Common provider ids such as `tt0111161`,
 * `kitsu:123` and `the-matrix` remain valid.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SAFE_ASSET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const STORAGE_NAMESPACE = 'cinemind:localStore:v1'
const STORAGE_KEYS = {
  profile: `${STORAGE_NAMESPACE}:profile`,
  catalog: `${STORAGE_NAMESPACE}:catalog`,
  library: `${STORAGE_NAMESPACE}:library`,
  model: `${STORAGE_NAMESPACE}:model`,
} as const

const KIND_LABELS: Record<Kind, string> = {
  movie: 'Film',
  series: 'Dizi',
  anime: 'Anime',
}

const DEFAULT_PROFILE: Profile = { name: '', genres: [], preferences: '' }

interface ModelState {
  weights: number[]
  feedbackCount: number
}

interface RankPayload {
  items: CatalogItem[]
  profile: Profile
  mood: Mood
  kind: Kind
  weights: number[]
  feedbackCount: number
  requestText: string
}

/* ------------------------------------------------------------------ */
/* Small validation helpers                                           */
/* ------------------------------------------------------------------ */

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return undefined
  return trimmed
}

function cleanOptionalBody(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > max) return undefined
  return trimmed
}

function cleanYear(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value === 0) return 0
  const maxYear = new Date().getFullYear() + 10
  if (value < 1800 || value > maxYear) return undefined
  return value
}

function cleanTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_GENRES) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') return undefined
    const tag = raw.trim()
    if (tag === '' || tag.length > MAX_GENRE) return undefined
    const key = tag.toLocaleLowerCase('tr-TR')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

function normalizeSourceKey(source?: string): string {
  return typeof source === 'string'
    ? source.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : ''
}

export function isImdbSource(source?: string): boolean {
  return normalizeSourceKey(source) === 'imdb'
}

export function isKitsuSource(source?: string): boolean {
  return normalizeSourceKey(source).includes('kitsu')
}

export function isMyAnimeListSource(source?: string): boolean {
  const key = normalizeSourceKey(source)
  if (key === 'mal' || key === 'myanimelist' || key === 'jikan') return true
  if (key.includes('myanime') || key.includes('jikan')) return true
  return false
}

export function isAnimeRatingSource(source?: string): boolean {
  return isKitsuSource(source) || isMyAnimeListSource(source)
}

function normalizeSearch(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                    */
/* ------------------------------------------------------------------ */

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function readValue<T>(key: string, fallback: T): T {
  const raw = readRaw(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeRaw(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    )
  }
  return error instanceof Error && /quota/i.test(`${error.name} ${error.message}`)
}

function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, value)
  } catch (error) {
    if (isQuotaError(error)) {
      throw new ApiError('Local storage is full; changes were not saved.')
    }
    throw new ApiError('Could not write to local storage.')
  }
}

function restoreRaw(key: string, raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(key)
    else localStorage.setItem(key, raw)
  } catch {
    /* best effort rollback */
  }
}

function canUseStorage(): boolean {
  try {
    const probe = '__cinemind_storage_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* URL / local asset helpers                                          */
/* ------------------------------------------------------------------ */

function baseUrl(): string {
  const meta = import.meta as ImportMeta & { env?: { BASE_URL?: string } }
  const value = meta.env?.BASE_URL
  if (typeof value !== 'string' || value === '') return '/'
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * Normalizes a user-supplied poster path to a safe relative path under
 * `local-assets/`. Remote URLs, absolute paths, traversal segments and
 * unsafe characters are rejected. The returned path is stored as-is and
 * resolved against `import.meta.env.BASE_URL` only when shown to the UI.
 */
function cleanLocalAssetPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let path = value.trim()
  if (path === '' || path.length > MAX_URL || path.includes('\\')) {
    return undefined
  }
  const base = baseUrl()
  if (base !== '/' && path.startsWith(base)) {
    path = path.slice(base.length)
  } else if (path.startsWith('/')) {
    path = path.slice(1)
  }
  if (path.startsWith('./')) path = path.slice(2)
  const parts = path.split('/')
  if (parts[0] !== 'local-assets' || parts.length < 2) return undefined
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return undefined
    if (!SAFE_ASSET_SEGMENT.test(part)) return undefined
  }
  const lastPart = parts[parts.length - 1]
  const dotIndex = lastPart.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === lastPart.length - 1) return undefined
  const extension = lastPart.slice(dotIndex + 1).toLowerCase()
  const rasterExtensions = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'bmp',
    'tiff',
    'tif',
    'ico',
  ])
  if (!rasterExtensions.has(extension)) return undefined
  return parts.join('/')
}

function resolveLocalAssetPath(path: string): string {
  return `${baseUrl()}${path}`
}

/**
 * User-provided source links are only clickable when they are real
 * http/https URLs. Relative/other schemes are discarded rather than
 * rendered as links.
 */
function cleanSourceUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed.length > MAX_URL) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Rating helpers                                                     */
/* ------------------------------------------------------------------ */

function sanitizeRatingEntry(value: unknown): RatingEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const source = cleanText(raw.source, MAX_SOURCE)
  if (source === undefined) return undefined
  const scale = raw.scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    return undefined
  }
  const ratingValue = raw.value
  if (
    typeof ratingValue !== 'number' ||
    !Number.isFinite(ratingValue) ||
    ratingValue < 0 ||
    ratingValue > scale
  ) {
    return undefined
  }
  const votesRaw = raw.votes
  const votes =
    typeof votesRaw === 'number' && Number.isFinite(votesRaw) && votesRaw >= 0
      ? Math.round(votesRaw)
      : undefined
  return votes !== undefined
    ? { source, value: ratingValue, scale, votes }
    : { source, value: ratingValue, scale }
}

function sanitizeRatings(value: unknown): RatingEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: RatingEntry[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const rating = sanitizeRatingEntry(entry)
    if (rating === undefined) continue
    const key = normalizeSourceKey(rating.source)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rating)
  }
  return out
}

function sanitizePrimaryRating(
  raw: Record<string, unknown>,
): { rating: number; ratingSource: string; ratingCount?: number } | undefined {
  const ratingSource = cleanText(raw.ratingSource, MAX_SOURCE)
  if (ratingSource === undefined) return undefined
  const rating = raw.rating
  if (
    typeof rating !== 'number' ||
    !Number.isFinite(rating) ||
    rating < 0 ||
    rating > 10
  ) {
    return undefined
  }
  const countRaw = raw.ratingCount
  const ratingCount =
    typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw >= 0
      ? Math.round(countRaw)
      : undefined
  return ratingCount !== undefined
    ? { rating, ratingSource, ratingCount }
    : { rating, ratingSource }
}

/* ------------------------------------------------------------------ */
/* Catalog item sanitization                                          */
/* ------------------------------------------------------------------ */

function parseCatalogItem(value: unknown): CatalogItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const id = cleanText(raw.id, MAX_ID)
  if (id === undefined || !SAFE_ID.test(id)) return undefined
  // Reject ids that collide with Object.prototype own properties, because
  // App keeps a plain object map keyed by catalog id.
  if (Object.prototype.hasOwnProperty.call(Object.prototype, id)) return undefined
  const title = cleanText(raw.title, MAX_TITLE)
  if (title === undefined) return undefined
  const kindRaw = cleanText(raw.kind, 20)
  if (kindRaw !== 'movie' && kindRaw !== 'series' && kindRaw !== 'anime') {
    return undefined
  }
  const year = cleanYear(raw.year)
  if (year === undefined) return undefined
  const genres = cleanTags(raw.genres)
  if (genres === undefined) return undefined
  const description = cleanOptionalBody(raw.description, MAX_DESCRIPTION)
  if (description === undefined) return undefined
  const sourceUrl = cleanSourceUrl(raw.sourceUrl) ?? ''
  const posterPath = cleanLocalAssetPath(raw.posterUrl)

  const item: CatalogItem = {
    id,
    title,
    kind: kindRaw,
    year,
    genres,
    description,
    sourceUrl,
  }
  if (posterPath !== undefined) item.posterUrl = posterPath

  const primary = sanitizePrimaryRating(raw)
  if (primary !== undefined) {
    item.rating = primary.rating
    item.ratingSource = primary.ratingSource
    if (primary.ratingCount !== undefined) item.ratingCount = primary.ratingCount
  }
  const ratings = sanitizeRatings(raw.ratings)
  if (ratings !== undefined && ratings.length > 0) item.ratings = ratings
  return item
}

function publicCatalogItem(item: CatalogItem): CatalogItem {
  const copy: CatalogItem = { ...item }
  if (copy.posterUrl !== undefined) {
    const path = cleanLocalAssetPath(copy.posterUrl)
    if (path === undefined) delete copy.posterUrl
    else copy.posterUrl = resolveLocalAssetPath(path)
  }
  return copy
}

/* ------------------------------------------------------------------ */
/* Persisted state                                                    */
/* ------------------------------------------------------------------ */

function sanitizeProfile(value: unknown): Profile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PROFILE }
  }
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_TITLE) : ''
  const genres: string[] = []
  const seenGenres = new Set<string>()
  if (Array.isArray(raw.genres)) {
    for (const entry of raw.genres) {
      if (typeof entry !== 'string') continue
      const genre = entry.trim()
      if (genre === '') continue
      if (seenGenres.has(genre)) continue
      seenGenres.add(genre)
      genres.push(genre)
    }
  }
  const preferences =
    typeof raw.preferences === 'string' ? raw.preferences.slice(0, PREF_MAX) : ''
  return { name, genres, preferences }
}

function loadProfile(): Profile {
  return sanitizeProfile(readValue<unknown>(STORAGE_KEYS.profile, null))
}

function loadCatalog(): CatalogItem[] {
  const raw = readValue<unknown>(STORAGE_KEYS.catalog, [])
  if (!Array.isArray(raw)) return []
  const items: CatalogItem[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item = parseCatalogItem(entry)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return items
}

function loadLibrary(): Record<string, LibraryEntry> {
  const raw = readValue<unknown>(STORAGE_KEYS.library, {})
  const out = Object.create(null) as Record<string, LibraryEntry>
  let entries: unknown[] = []
  if (Array.isArray(raw)) entries = raw
  else if (raw && typeof raw === 'object') entries = Object.values(raw)
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entryRaw = value as Record<string, unknown>
    const item = parseCatalogItem(entryRaw.item)
    if (item === undefined) continue
    const watched = entryRaw.watched === true
    const disliked = entryRaw.disliked === true
    if (!watched && !disliked) continue
    out[item.id] = { item, watched, disliked }
  }
  return out
}

function sanitizeWeights(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is number =>
      typeof entry === 'number' && Number.isFinite(entry),
  )
}

function loadModel(): ModelState {
  const raw = readValue<unknown>(STORAGE_KEYS.model, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { weights: [], feedbackCount: 0 }
  }
  const obj = raw as Record<string, unknown>
  const feedbackCount =
    typeof obj.feedbackCount === 'number' &&
    Number.isFinite(obj.feedbackCount) &&
    obj.feedbackCount >= 0
      ? Math.floor(obj.feedbackCount)
      : 0
  return { weights: sanitizeWeights(obj.weights), feedbackCount }
}

function extractWeights(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return sanitizeWeights(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (Array.isArray(obj.weights)) return sanitizeWeights(obj.weights)
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Genres                                                             */
/* ------------------------------------------------------------------ */

function sanitizeGenreItem(value: unknown): GenreCatalogItem | undefined {
  if (typeof value === 'string') {
    const id = cleanText(value, MAX_ID)
    if (id === undefined) return undefined
    return {
      id,
      label: id,
      originalLabel: id,
      group: 'genre',
      kinds: ['movie', 'series', 'anime'],
      sources: [],
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const id = cleanText(raw.id, MAX_ID)
  if (id === undefined) return undefined
  const label = cleanText(raw.label, MAX_TITLE)
  const originalLabel = cleanText(raw.originalLabel, MAX_TITLE)
  const groupRaw = cleanText(raw.group, 40)
  const group =
    groupRaw === 'theme'
      ? 'theme'
      : groupRaw === 'genre'
        ? 'genre'
        : (groupRaw ?? 'genre')

  const kinds: GenreCatalogItem['kinds'] = []
  const seenKinds = new Set<string>()
  if (Array.isArray(raw.kinds)) {
    for (const entry of raw.kinds) {
      const kind = cleanText(entry, 20)
      if (kind !== 'movie' && kind !== 'series' && kind !== 'anime') continue
      if (seenKinds.has(kind)) continue
      seenKinds.add(kind)
      kinds.push(kind)
    }
  }

  const sources: string[] = []
  const seenSources = new Set<string>()
  if (Array.isArray(raw.sources)) {
    for (const entry of raw.sources) {
      const source = cleanText(entry, MAX_SOURCE)
      if (source === undefined || seenSources.has(source)) continue
      seenSources.add(source)
      sources.push(source)
    }
  }

  return {
    id,
    label: label ?? originalLabel ?? id,
    originalLabel: originalLabel ?? label ?? id,
    group,
    kinds,
    sources,
  }
}

function sanitizeGenres(payload: unknown): GenresResponse {
  let rawItems: unknown[] = []
  let source: GenresResponse['source'] = 'bundled'
  let notice: string | undefined
  if (Array.isArray(payload)) {
    rawItems = payload
  } else if (payload && typeof payload === 'object') {
    const raw = payload as Record<string, unknown>
    rawItems = Array.isArray(raw.items) ? raw.items : []
    const sourceRaw = cleanText(raw.source, 40)
    if (
      sourceRaw === 'live' ||
      sourceRaw === 'cache' ||
      sourceRaw === 'bundled'
    ) {
      source = sourceRaw
    }
    notice = cleanText(raw.notice, MAX_REASON)
  }

  const items: GenreCatalogItem[] = []
  const seen = new Set<string>()
  for (const entry of rawItems) {
    const item = sanitizeGenreItem(entry)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  if (items.length === 0) throw new ApiError('Could not load genre list.')
  return notice !== undefined ? { items, source, notice } : { items, source }
}

/* ------------------------------------------------------------------ */
/* wasm-bindgen bridge                                                */
/* ------------------------------------------------------------------ */

let wasmReady: Promise<void> | null = null

function ensureWasm(): Promise<void> {
  if (wasmReady === null) {
    wasmReady = (async () => {
      try {
        await init()
      } catch {
        wasmReady = null
        throw new ApiError('Local engine could not be started.')
      }
    })()
  }
  return wasmReady
}

function parseWasmJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ApiError('Local engine returned an invalid response.')
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (Array.isArray(obj.items)) return obj.items
    if (Array.isArray(obj.results)) return obj.results
  }
  return []
}

async function callRank(payload: RankPayload): Promise<unknown> {
  await ensureWasm()
  try {
    const raw = await rank_json(JSON.stringify(payload))
    return parseWasmJson(raw)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('Could not compute recommendations.')
  }
}

async function callTrain(payload: {
  item: CatalogItem
  mood: Mood
  weights: number[]
  liked: boolean
}): Promise<unknown> {
  await ensureWasm()
  try {
    const raw = await train_json(JSON.stringify(payload))
    return parseWasmJson(raw)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('Could not process preference.')
  }
}

let genresCache: GenresResponse | null = null

async function getGenres(): Promise<GenresResponse> {
  if (genresCache !== null) return genresCache
  await ensureWasm()
  let raw: unknown
  try {
    raw = await genres_json()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('Could not load genre list.')
  }
  const response = sanitizeGenres(parseWasmJson(raw))
  genresCache = response
  return response
}

/* ------------------------------------------------------------------ */
/* Recommendation helpers                                             */
/* ------------------------------------------------------------------ */

function positivePage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : 1
}

function defaultReason(item: CatalogItem, profile: Profile): string {
  const hits = item.genres.filter((genre) =>
    profile.genres.some(
      (preference) => normalizeSearch(preference) === normalizeSearch(genre),
    ),
  )
  if (hits.length > 0) {
    return `Matches the ${hits.slice(0, 2).join(', ')} genres in your profile.`
  }
  return 'Selected from the local catalog based on your mood and format.'
}

function normalizeRecommendation(
  value: unknown,
  kind: Kind,
  catalogById: Map<string, CatalogItem>,
  profile: Profile,
): Recommendation | undefined {
  if (typeof value === 'string') {
    const item = catalogById.get(value)
    if (item === undefined || item.kind !== kind) return undefined
    return {
      ...publicCatalogItem(item),
      reason: defaultReason(item, profile),
      score: 0,
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const nested =
    raw.item && typeof raw.item === 'object' && !Array.isArray(raw.item)
      ? (raw.item as Record<string, unknown>)
      : null
  const rawId =
    typeof raw.id === 'string'
      ? raw.id
      : nested !== null && typeof nested.id === 'string'
        ? nested.id
        : undefined
  const existing = rawId !== undefined ? catalogById.get(rawId) : undefined
  const item = existing ?? parseCatalogItem(nested ?? raw)
  if (item === undefined || item.kind !== kind) return undefined

  // Rust returns the reordered tags in raw.genres, not matchedGenres.
  // Retain Rust genre order, validated against catalog tags.
  const rawMatchedCandidates = [
    raw.genres,
    nested !== null ? nested.genres : undefined,
  ]
  const rawMatched = (rawMatchedCandidates.find(Array.isArray) as unknown[]) ?? []
  const matched: string[] = []
  const matchedSeen = new Set<string>()
  for (const entry of rawMatched) {
    if (typeof entry !== 'string') continue
    const catalogTag = item.genres.find(
      (genre) => normalizeSearch(genre) === normalizeSearch(entry),
    )
    if (catalogTag === undefined) continue
    const key = normalizeSearch(catalogTag)
    if (matchedSeen.has(key)) continue
    matchedSeen.add(key)
    matched.push(catalogTag)
  }
  const finalItem: CatalogItem =
    matched.length > 0
      ? {
          ...item,
          genres: [
            ...matched,
            ...item.genres.filter(
              (genre) =>
                !matched.some(
                  (matchedGenre) =>
                    normalizeSearch(matchedGenre) === normalizeSearch(genre),
                ),
            ),
          ],
        }
      : item

  const reason =
    cleanText(raw.reason, MAX_REASON) ??
    (nested !== null ? cleanText(nested.reason, MAX_REASON) : undefined) ??
    (matched.length > 0
      ? `Matches the ${matched.slice(0, 2).join(', ')} genres in your profile.`
      : defaultReason(finalItem, profile))
  const scoreRaw =
    typeof raw.score === 'number'
      ? raw.score
      : nested !== null && typeof nested.score === 'number'
        ? nested.score
        : undefined
  const score =
    typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : 0

  return { ...publicCatalogItem(finalItem), reason, score }
}

/* ------------------------------------------------------------------ */
/* Detail helpers                                                     */
/* ------------------------------------------------------------------ */

function similarByTags(base: CatalogItem, catalog: CatalogItem[]): CatalogItem[] {
  const tags = new Set(base.genres.map((genre) => normalizeSearch(genre)))
  if (tags.size === 0) return []
  return catalog
    .filter((item) => item.id !== base.id && item.kind === base.kind)
    .map((item) => ({
      item,
      score: item.genres.reduce(
        (total, genre) => total + (tags.has(normalizeSearch(genre)) ? 1 : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.item.title.localeCompare(b.item.title, 'tr'),
    )
    .slice(0, 8)
    .map((entry) => entry.item)
}

function buildFacts(item: CatalogItem): DetailFact[] {
  const facts: DetailFact[] = [
    { label: 'Format', value: KIND_LABELS[item.kind] },
  ]
  if (item.year > 0) facts.push({ label: 'Yıl', value: String(item.year) })
  return facts
}

function collectRatings(item: CatalogItem): RatingEntry[] {
  if (Array.isArray(item.ratings) && item.ratings.length > 0) {
    return item.ratings.map((rating) => ({ ...rating }))
  }
  if (
    typeof item.rating === 'number' &&
    typeof item.ratingSource === 'string'
  ) {
    const entry: RatingEntry = {
      source: item.ratingSource,
      value: item.rating,
      scale: 10,
    }
    if (typeof item.ratingCount === 'number') entry.votes = item.ratingCount
    return [entry]
  }
  return []
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new ApiError('Request was cancelled.')
    error.name = 'AbortError'
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* Core operations                                                    */
/* ------------------------------------------------------------------ */

async function getProfile(): Promise<Profile> {
  return loadProfile()
}

async function saveProfile(profile: Profile): Promise<Profile> {
  const saved = sanitizeProfile(profile)
  saved.preferences = saved.preferences.slice(0, PREF_MAX)
  writeJson(STORAGE_KEYS.profile, saved)
  return saved
}

async function getCatalog(
  kind: Kind,
  page: number,
  q: string,
): Promise<CatalogResponse> {
  const catalog = loadCatalog()
  const query = typeof q === 'string' ? q.trim().slice(0, 120) : ''
  const needle = normalizeSearch(query)
  const filtered = catalog.filter((item) => {
    if (item.kind !== kind) return false
    if (needle === '') return true
    if (normalizeSearch(item.title).includes(needle)) return true
    return item.genres.some((genre) =>
      normalizeSearch(genre).includes(needle),
    )
  })
  const pageNum = positivePage(page)
  const start = (pageNum - 1) * CATALOG_PAGE_SIZE
  const items = filtered
    .slice(start, start + CATALOG_PAGE_SIZE)
    .map(publicCatalogItem)
  return {
    items,
    page: pageNum,
    hasMore: start + items.length < filtered.length,
    source: 'local',
  }
}

async function getCatalogItem(id: string): Promise<CatalogItem> {
  const cleanId = typeof id === 'string' ? id.trim() : ''
  const catalog = loadCatalog()
  const item =
    catalog.find((entry) => entry.id === cleanId) ??
    loadLibrary()[cleanId]?.item
  if (item === undefined) throw new ApiError('Requested content not found.')
  return publicCatalogItem(item)
}

async function getCatalogDetails(
  id: string,
  options?: { kind?: Kind; signal?: AbortSignal } | Kind,
): Promise<CatalogDetails> {
  const normalized = typeof options === 'string' ? { kind: options } : options
  throwIfAborted(normalized?.signal)

  const cleanId = typeof id === 'string' ? id.trim() : ''
  const catalog = loadCatalog()
  const item =
    catalog.find((entry) => entry.id === cleanId) ??
    loadLibrary()[cleanId]?.item
  if (item === undefined) throw new ApiError('Requested content not found.')

  const similar = similarByTags(item, catalog).map(publicCatalogItem)
  const sources: DetailSource[] = []
  const sourceUrl = cleanSourceUrl(item.sourceUrl)
  if (sourceUrl !== undefined && sourceUrl !== '') {
    sources.push({ name: 'Kaynak', url: sourceUrl })
  }

  return {
    id: item.id,
    cast: [],
    related: [],
    similar,
    facts: buildFacts(item),
    ratings: collectRatings(item),
    sources,
  }
}

async function getDetailExtras(
  id: string,
  options?: { kind?: Kind; signal?: AbortSignal } | Kind,
): Promise<CatalogDetails> {
  return getCatalogDetails(id, options)
}

async function getRecommendations(
  mood: Mood,
  kind: Kind,
  options?: { requestText?: string; page?: number; excludeIds?: string[] },
): Promise<RecommendationsResponse> {
  const page = positivePage(options?.page)
  const catalog = loadCatalog()
  if (catalog.length === 0) {
    return {
      items: [],
      source: 'local',
      notice: 'Local catalog is empty. Import a JSON catalog to get started.',
      page,
      hasMore: false,
      nextPage: page,
    }
  }

  const profile = loadProfile()
  const library = loadLibrary()
  const model = loadModel()
  const requestText =
    typeof options?.requestText === 'string'
      ? options.requestText.slice(0, PREF_MAX).trim()
      : ''
  const excludeIds = Array.isArray(options?.excludeIds)
    ? [
        ...new Set(
          options.excludeIds.filter(
            (entry): entry is string =>
              typeof entry === 'string' && entry !== '',
          ),
        ),
      ]
    : []
  const excludeSet = new Set(excludeIds)

  const hidden = new Set<string>()
  for (const entry of Object.values(library)) {
    if (entry.watched || entry.disliked) hidden.add(entry.item.id)
  }

  const rankedRaw = await callRank({
    items: catalog,
    profile,
    mood,
    kind,
    weights: model.weights,
    feedbackCount: model.feedbackCount,
    requestText,
  })

  const catalogById = new Map(catalog.map((item) => [item.id, item]))
  const ranked: Recommendation[] = []
  const seen = new Set<string>()
  for (const entry of asArray(rankedRaw)) {
    const recommendation = normalizeRecommendation(
      entry,
      kind,
      catalogById,
      profile,
    )
    if (recommendation === undefined) continue
    if (seen.has(recommendation.id)) continue
    seen.add(recommendation.id)
    if (hidden.has(recommendation.id) || excludeSet.has(recommendation.id)) {
      continue
    }
    ranked.push(recommendation)
  }

  // When excludeIds are supplied, they are the cursor: do not also skip by
  // page number, otherwise a later page would drop unseen results.
  const useExcludeCursor = excludeIds.length > 0
  const start = useExcludeCursor
    ? 0
    : (page - 1) * RECOMMENDATION_PAGE_SIZE
  const items = ranked.slice(start, start + RECOMMENDATION_PAGE_SIZE)
  const hasMore = start + items.length < ranked.length
  return {
    items,
    source: 'local',
    page,
    hasMore,
    nextPage: hasMore ? page + 1 : page,
  }
}

async function sendFeedback(
  id: string,
  mood: Mood,
  liked: boolean,
  item?: CatalogItem,
): Promise<{ ok: boolean }> {
  const catalog = loadCatalog()
  const libraryBefore = loadLibrary()
  const target =
    item ??
    catalog.find((entry) => entry.id === id) ??
    libraryBefore[id]?.item
  if (target === undefined) return { ok: true }

  const cleanItem = parseCatalogItem(target) ?? target
  const modelBefore = loadModel()
  const result = await callTrain({
    item: cleanItem,
    mood,
    weights: modelBefore.weights,
    liked,
  })

  // Fresh state after wasm init to avoid lost updates.
  const freshLibrary = loadLibrary()
  const freshModel = loadModel()
  const existing = freshLibrary[cleanItem.id]
  const watched = existing?.watched === true
  const disliked = !liked
  if (!watched && !disliked) {
    delete freshLibrary[cleanItem.id]
  } else {
    freshLibrary[cleanItem.id] = { item: cleanItem, watched, disliked }
  }

  const extracted = extractWeights(result)
  const weights = extracted ?? freshModel.weights
  const feedbackCount = freshModel.feedbackCount + 1

  const previousLibraryRaw = readRaw(STORAGE_KEYS.library)
  const previousModelRaw = readRaw(STORAGE_KEYS.model)
  try {
    writeRaw(STORAGE_KEYS.library, freshLibrary)
    writeRaw(STORAGE_KEYS.model, { weights, feedbackCount })
  } catch (error) {
    restoreRaw(STORAGE_KEYS.library, previousLibraryRaw)
    restoreRaw(STORAGE_KEYS.model, previousModelRaw)
    if (isQuotaError(error)) {
      throw new ApiError('Local storage is full; feedback could not be saved.')
    }
    throw new ApiError('Could not save feedback.')
  }
  return { ok: true }
}

async function getLibrary(): Promise<LibraryResponse> {
  const library = loadLibrary()
  return {
    items: Object.values(library).map((entry) => ({
      item: publicCatalogItem(entry.item),
      watched: entry.watched,
      disliked: entry.disliked,
    })),
  }
}

async function updateLibrary(
  item: CatalogItem,
  patch: { watched?: boolean; disliked?: boolean },
): Promise<{ ok: boolean }> {
  const cleanItem = parseCatalogItem(item)
  if (cleanItem === undefined) throw new ApiError('Content could not be saved.')
  const library = loadLibrary()
  const existing = library[cleanItem.id]
  const watched =
    typeof patch.watched === 'boolean'
      ? patch.watched
      : (existing?.watched ?? false)
  const disliked =
    typeof patch.disliked === 'boolean'
      ? patch.disliked
      : (existing?.disliked ?? false)
  if (!watched && !disliked) delete library[cleanItem.id]
  else library[cleanItem.id] = { item: cleanItem, watched, disliked }
  writeJson(STORAGE_KEYS.library, library)
  return { ok: true }
}

async function importCatalog(file: File): Promise<number> {
  if (!file || typeof file.text !== 'function') {
    throw new ApiError('Invalid file.')
  }
  if (typeof file.size === 'number' && file.size > IMPORT_MAX_BYTES) {
    throw new ApiError('File exceeds the 2 MB limit.')
  }
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new ApiError('Could not read file.')
  }
  if (text.length > IMPORT_MAX_BYTES) {
    throw new ApiError('File exceeds the 2 MB limit.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new ApiError('File is not valid JSON.')
  }
  if (!Array.isArray(parsed)) {
    throw new ApiError('Catalog file must be a JSON array.')
  }
  if (parsed.length > IMPORT_MAX_ITEMS) {
    throw new ApiError('Catalog can contain at most 2000 entries.')
  }

  // Validate the complete file before touching storage.
  const nextCatalog: CatalogItem[] = []
  const seen = new Set<string>()
  for (let index = 0; index < parsed.length; index += 1) {
    const item = parseCatalogItem(parsed[index])
    if (item === undefined) {
      throw new ApiError(
        `Entry ${index + 1} is invalid or contains an unsafe field.`,
      )
    }
    if (seen.has(item.id)) {
      throw new ApiError(
        `Entry ${index + 1} has a duplicate id: ${item.id}`,
      )
    }
    seen.add(item.id)
    nextCatalog.push(item)
  }

  // Preserve user library by id; refresh item snapshots for ids still present.
  const library = loadLibrary()
  const nextLibrary = Object.create(null) as Record<string, LibraryEntry>
  for (const [id, entry] of Object.entries(library)) {
    const updated = nextCatalog.find((item) => item.id === id)
    nextLibrary[id] =
      updated !== undefined
        ? { item: updated, watched: entry.watched, disliked: entry.disliked }
        : entry
  }

  const previousCatalog = readRaw(STORAGE_KEYS.catalog)
  const previousLibrary = readRaw(STORAGE_KEYS.library)
  try {
    writeRaw(STORAGE_KEYS.catalog, nextCatalog)
    writeRaw(STORAGE_KEYS.library, nextLibrary)
  } catch (error) {
    restoreRaw(STORAGE_KEYS.catalog, previousCatalog)
    restoreRaw(STORAGE_KEYS.library, previousLibrary)
    if (isQuotaError(error)) {
      throw new ApiError('Local storage is full; catalog could not be imported.')
    }
    throw new ApiError('Catalog could not be saved.')
  }
  return nextCatalog.length
}

/* ------------------------------------------------------------------ */
/* Public store                                                       */
/* ------------------------------------------------------------------ */

export const localStore = {
  health: async (): Promise<{ ok: boolean }> => ({ ok: canUseStorage() }),

  getGenres,

  getProfile,

  saveProfile,

  getCatalog,

  getCatalogItem,

  getCatalogDetails,

  getDetailExtras,

  getRecommendations,

  sendFeedback,

  getLibrary,

  updateLibrary,

  importCatalog,
}

/** Compatibility alias for code that still imports the old `api` name. */
export const api = localStore

export function isDefaultProfile(p: Profile): boolean {
  return (
    p.name.trim() === '' &&
    p.genres.length === 0 &&
    p.preferences.trim() === ''
  )
}
