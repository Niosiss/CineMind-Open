import { useId, useMemo, useState } from 'react'
import { normalizeForSearch, useGenreCatalog } from '../genres'
import { kindLabel } from '../i18n'
import type { Kind } from '../types'
import { CloseIcon } from './icons'

type FormatFilter = 'all' | Kind
type GroupFilter = 'all' | 'genre' | 'theme'

interface SearchableGenrePickerProps {
  value: string[]
  onChange: (next: string[]) => void
}

const FORMAT_OPTIONS: { value: FormatFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movie' },
  { value: 'series', label: 'Series' },
  { value: 'anime', label: 'Anime' },
]

const GROUP_OPTIONS: { value: GroupFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'genre', label: 'Genres' },
  { value: 'theme', label: 'Themes' },
]

/**
 * Shared searchable chip picker for genres and themes.
 * The catalog loads once; search and filtering are fully local.
 */
export function SearchableGenrePicker({ value, onChange }: SearchableGenrePickerProps) {
  const { items, isFallback, status, notice, retry, labelFor } = useGenreCatalog()
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const searchId = `genre-search-${reactId}`
  const countId = `genre-count-${reactId}`
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState<FormatFilter>('all')
  const [group, setGroup] = useState<GroupFilter>('all')

  const selected = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of value) {
      if (typeof id !== 'string' || id === '') continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }, [value])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (id: string) => {
    const next = selectedSet.has(id)
      ? selected.filter((s) => s !== id)
      : [...selected, id]
    onChange(next)
  }

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query.trim())
    return items.filter((item) => {
      if (format !== 'all' && !item.kinds.includes(format)) return false
      if (group !== 'all' && item.group !== group) return false
      if (q !== '') {
        const hay = normalizeForSearch(`${item.label} ${item.originalLabel} ${item.id}`)
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [items, query, format, group])

  const clearFilters = () => {
    setQuery('')
    setFormat('all')
    setGroup('all')
  }

  const hasActiveFilter = query.trim() !== '' || format !== 'all' || group !== 'all'

  return (
    <div className="field genre-picker">
      <div className="genre-picker-head">
        <span className="genre-picker-title" id={`genre-picker-title-${reactId}`}>
          Genres and themes <span className="muted">(optional)</span>
        </span>
        <span className="genre-picker-count muted" aria-live="polite">
          {selected.length} selected
        </span>
      </div>

      <div className="genre-selected" aria-label="Selected genres">
        {selected.length === 0 ? (
          <p className="field-hint muted">Nothing selected yet — search below and your picks will appear here.</p>
        ) : (
          <ul className="chip-row genre-selected-row">
            {selected.map((id) => {
              const label = labelFor(id)
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="chip chip-selected genre-selected-chip"
                    onClick={() => toggle(id)}
                    aria-label={`Remove ${label}`}
                    title={`${label} — click to remove`}
                  >
                    <span>{label}</span>
                    <span className="genre-chip-x" aria-hidden="true"><CloseIcon size={12} /></span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="genre-search-row">
        <label className="visually-hidden" htmlFor={searchId}>Search genres</label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search genres: e.g. sports, psychological…"
          autoComplete="off"
          aria-describedby={countId}
        />
        {query ? (
          <button type="button" className="icon-btn genre-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <CloseIcon size={14} />
          </button>
        ) : null}
      </div>

      <div className="genre-filters">
        <div className="segmented genre-filter" role="group" aria-label="Filter by format">
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`segment${format === opt.value ? ' segment-selected' : ''}`}
              aria-pressed={format === opt.value}
              onClick={() => setFormat(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="segmented genre-filter" role="group" aria-label="Filter by group">
          {GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`segment${group === opt.value ? ' segment-selected' : ''}`}
              aria-pressed={group === opt.value}
              onClick={() => setGroup(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <p id={countId} className="count-line muted genre-count" aria-live="polite">
        {filtered.length} results
        <span className="genre-count-total"> · {items.length} genres/themes</span>
        {format !== 'all' ? ` · ${kindLabel(format)}` : ''}
        {group !== 'all' ? ` · ${group === 'genre' ? 'Genres' : 'Themes'}` : ''}
      </p>

      {status === 'loading' && isFallback ? (
        <p className="field-hint muted genre-status" role="status">Loading genres… the basics are ready.</p>
      ) : null}

      {status === 'error' ? (
        <div className="genre-unavailable" role="alert">
          <p>The genre list couldn't be loaded. Showing the basic genres for now.</p>
          <button type="button" className="btn btn-ghost" onClick={retry}>Try again</button>
        </div>
      ) : null}

      {status === 'ready' && notice ? (
        <p className="field-hint muted genre-status">{notice}</p>
      ) : null}

      {filtered.length === 0 ? (
        <div className="genre-empty">
          <p className="muted">No results.</p>
          {hasActiveFilter ? (
            <button type="button" className="link-btn" onClick={clearFilters}>Clear search and filters</button>
          ) : null}
        </div>
      ) : (
        <div className="genre-options" role="group" aria-label="Genre options">
          <div className="chip-row genre-options-row">
            {filtered.map((item) => {
              const isSelected = selectedSet.has(item.id)
              const groupText = item.group === 'theme' ? 'Theme' : 'Genre'
              const kindsText = item.kinds.length > 0 && item.kinds.length < 3
                ? item.kinds.map((k) => kindLabel(k as Kind)).join(' · ')
                : null
              const showOriginal =
                item.originalLabel !== '' &&
                normalizeForSearch(item.originalLabel) !== normalizeForSearch(item.label) &&
                item.originalLabel !== item.label
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`chip genre-option${isSelected ? ' chip-selected' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => toggle(item.id)}
                  title={`${item.label}${showOriginal ? ` (${item.originalLabel})` : ''}`}
                >
                  <span className="genre-option-label">{item.label}</span>
                  {showOriginal ? <span className="genre-option-original">{item.originalLabel}</span> : null}
                  <span className="genre-option-meta">
                    {groupText}{kindsText ? ` · ${kindsText}` : ''}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
