import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, localStore } from './localStore'
import { GENRES, GENRE_LABELS, genreLabel } from './i18n'
import type { GenresResponse, GenreCatalogItem } from './types'

export type GenreCatalogStatus = 'loading' | 'ready' | 'error'

export interface GenreCatalogValue {
  /** Effective items: the full catalog when ready, otherwise the small fallback list. */
  items: GenreCatalogItem[]
  /** Whether the fallback list is in use (loading or failed). */
  isFallback: boolean
  status: GenreCatalogStatus
  source?: GenresResponse['source']
  notice?: string
  error?: string
  retry: () => void
  labelFor: (id: string) => string
  itemFor: (id: string) => GenreCatalogItem | undefined
}

/**
 * Search normalization: lowercase, strip accents and separators.
 * "SliceOfLife", "slice-of-life", and "Slice of Life" all resolve to
 * the same key.
 */
export function normalizeForSearch(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^0-9a-z]/g, '')
}

const FALLBACK_ITEMS: GenreCatalogItem[] = GENRES.map((id) => ({
  id,
  label: GENRE_LABELS[id] ?? id,
  originalLabel: id,
  group: 'genre',
  kinds: ['movie', 'series', 'anime'],
  sources: [],
}))

function buildIndex(items: GenreCatalogItem[]) {
  const byId = new Map<string, GenreCatalogItem>()
  const byNorm = new Map<string, GenreCatalogItem>()
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item)
    const keys = [item.id, item.originalLabel, item.label]
    for (const key of keys) {
      const norm = normalizeForSearch(key)
      if (norm !== '' && !byNorm.has(norm)) byNorm.set(norm, item)
    }
  }
  // The fallback dictionary feeds the same normalized lookup.
  for (const [slug, label] of Object.entries(GENRE_LABELS)) {
    const norm = normalizeForSearch(slug)
    if (norm !== '' && !byNorm.has(norm)) {
      byNorm.set(norm, {
        id: slug,
        label,
        originalLabel: slug,
        group: 'genre',
        kinds: ['movie', 'series', 'anime'],
        sources: [],
      })
    }
  }
  return { byId, byNorm }
}

function resolveLabel(id: string, byId: Map<string, GenreCatalogItem>, byNorm: Map<string, GenreCatalogItem>): string {
  if (typeof id !== 'string' || id === '') return ''
  const exact = byId.get(id)
  if (exact) return exact.label
  const norm = normalizeForSearch(id)
  if (norm !== '') {
    const hit = byNorm.get(norm)
    if (hit) return hit.label
  }
  return genreLabel(id)
}

function resolveItem(id: string, byId: Map<string, GenreCatalogItem>, byNorm: Map<string, GenreCatalogItem>): GenreCatalogItem | undefined {
  if (typeof id !== 'string' || id === '') return undefined
  const exact = byId.get(id)
  if (exact) return exact
  const norm = normalizeForSearch(id)
  return norm !== '' ? byNorm.get(norm) : undefined
}

/* ---- Fetch once for the app's lifetime; cache the result and retry on error. ---- */

let cachedGenres: GenresResponse | null = null
let inflightGenres: Promise<GenresResponse> | null = null

function fetchGenresOnce(): Promise<GenresResponse> {
  if (cachedGenres) return Promise.resolve(cachedGenres)
  if (inflightGenres) return inflightGenres
  inflightGenres = (async (): Promise<GenresResponse> => {
    try {
      const res = await localStore.getGenres()
      // Do not cache an empty validated catalog; show the fallback and retry.
      if (!res || !Array.isArray(res.items) || res.items.length === 0) {
        throw new ApiError('The genre list could not be loaded.')
      }
      cachedGenres = res
      return res
    } finally {
      inflightGenres = null
    }
  })()
  return inflightGenres
}

const GenreCatalogContext = createContext<GenreCatalogValue | null>(null)

export function GenreCatalogProvider({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<GenreCatalogStatus>(cachedGenres ? 'ready' : 'loading')
  const [response, setResponse] = useState<GenresResponse | null>(cachedGenres)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (cachedGenres) {
      setResponse(cachedGenres)
      setStatus('ready')
      setError(undefined)
      return
    }
    let cancelled = false
    setStatus('loading')
    setError(undefined)
    void fetchGenresOnce().then(
      (res) => {
        if (cancelled) return
        setResponse(res)
        setStatus('ready')
        setError(undefined)
      },
      (e) => {
        if (cancelled) return
        setResponse(null)
        setStatus('error')
        setError(e instanceof ApiError ? e.message : 'The genre list could not be loaded.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = useCallback(() => {
    if (cachedGenres) return
    setAttempt((n) => n + 1)
  }, [])

  const value = useMemo<GenreCatalogValue>(() => {
    const items = response && response.items.length > 0 ? response.items : FALLBACK_ITEMS
    const isFallback = !response || response.items.length === 0
    const { byId, byNorm } = buildIndex(isFallback ? FALLBACK_ITEMS : items)
    const labelFor = (id: string) => resolveLabel(id, byId, byNorm)
    const itemFor = (id: string) => resolveItem(id, byId, byNorm)
    return {
      items,
      isFallback,
      status,
      source: response?.source,
      notice: response?.notice,
      error,
      retry,
      labelFor,
      itemFor,
    }
  }, [response, status, error, retry])

  return <GenreCatalogContext.Provider value={value}>{children}</GenreCatalogContext.Provider>
}

export function useGenreCatalog(): GenreCatalogValue {
  const ctx = useContext(GenreCatalogContext)
  if (!ctx) {
    // Outside the provider, use the fallback list without fetching.
    const { byId, byNorm } = buildIndex(FALLBACK_ITEMS)
    return {
      items: FALLBACK_ITEMS,
      isFallback: true,
      status: 'error' as const,
      error: 'The genre list could not be loaded.',
      retry: () => {},
      labelFor: (id: string) => resolveLabel(id, byId, byNorm),
      itemFor: (id: string) => resolveItem(id, byId, byNorm),
    }
  }
  return ctx
}

/** Catalog-aware label resolver for cards, details, library, and onboarding. */
export function useGenreLabel(): (id: string) => string {
  return useGenreCatalog().labelFor
}
