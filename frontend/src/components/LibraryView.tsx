import { useMemo, useState, type MouseEvent } from 'react'
import { kindLabel, KIND_OPTIONS } from '../i18n'
import { normalizeForSearch } from '../genres'
import type { CatalogItem, Kind, LibraryEntry } from '../types'
import { detailHref } from '../navigation'
import { Poster } from './Poster'
import { RatingBadges } from './RatingPill'
import { CloseIcon, SearchIcon, UndoIcon } from './icons'

type LibraryTab = 'watched' | 'disliked'
type KindFilter = Kind | 'all'

interface LibraryViewProps {
  entries: LibraryEntry[]
  loading: boolean
  onOpenDetail: (item: CatalogItem) => void
  onUndo: (entry: LibraryEntry, kind: 'watched' | 'disliked') => void
  isBusy: (id: string) => boolean
}

/** Only an unmodified primary click is intercepted; modifiers and middle click stay native. */
function openOnPlainClick(onOpen: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onOpen()
  }
}

/**
 * Library: watched + disliked items, local title search, format filter,
 * and undo. Filter state survives route changes because the component
 * stays mounted while hidden.
 */
export function LibraryView({ entries, loading, onOpenDetail, onUndo, isBusy }: LibraryViewProps) {
  const [tab, setTab] = useState<LibraryTab>('watched')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [searchInput, setSearchInput] = useState('')

  const watchedCount = useMemo(() => entries.filter((e) => e.watched).length, [entries])
  const dislikedCount = useMemo(() => entries.filter((e) => e.disliked).length, [entries])

  const visible = useMemo(() => {
    const base = entries.filter((e) => (tab === 'watched' ? e.watched : e.disliked))
    const byKind = base.filter((e) => kindFilter === 'all' || e.item.kind === kindFilter)
    const q = normalizeForSearch(searchInput.trim())
    if (q === '') return byKind
    return byKind.filter((e) => normalizeForSearch(e.item.title).includes(q))
  }, [entries, tab, kindFilter, searchInput])

  return (
    <section className="library" aria-label="Library">
      <header className="section-head">
        <div>
          <h2 className="section-title">Library</h2>
          <p className="muted section-sub">Manage what you've watched and disliked.</p>
        </div>
        <div className="library-counts" aria-label="Counts">
          <span className="library-count">{watchedCount} watched</span>
          <span className="library-count-text muted">{dislikedCount} disliked</span>
        </div>
      </header>

      <div className="library-filters">
        <div className="searchbar library-search" role="search">
          <span className="search-icon" aria-hidden="true"><SearchIcon size={18} /></span>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search the library"
            aria-label="Search the library by title"
            autoComplete="off"
          />
          {searchInput ? (
            <button
              type="button"
              className="icon-btn search-clear"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
            >
              <CloseIcon size={14} />
            </button>
          ) : null}
        </div>

        <div className="segmented" role="group" aria-label="Choose list">
          <button
            type="button"
            className={`segment${tab === 'watched' ? ' segment-selected' : ''}`}
            aria-pressed={tab === 'watched'}
            onClick={() => setTab('watched')}
          >
            Watched
          </button>
          <button
            type="button"
            className={`segment${tab === 'disliked' ? ' segment-selected' : ''}`}
            aria-pressed={tab === 'disliked'}
            onClick={() => setTab('disliked')}
          >
            Disliked
          </button>
        </div>

        <div className="segmented library-kind-filter" role="group" aria-label="Filter by format">
          <button
            type="button"
            className={`segment${kindFilter === 'all' ? ' segment-selected' : ''}`}
            aria-pressed={kindFilter === 'all'}
            onClick={() => setKindFilter('all')}
          >
            All
          </button>
          {KIND_OPTIONS.map((k) => (
            <button
              key={k.value}
              type="button"
              className={`segment${kindFilter === k.value ? ' segment-selected' : ''}`}
              aria-pressed={kindFilter === k.value}
              onClick={() => setKindFilter(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <>
          <p className="status-line muted" aria-live="polite">Loading library…</p>
          <div className="library-grid" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="catalog-card skeleton-card">
                <div className="skeleton skeleton-poster" />
                <div className="skeleton-lines">
                  <div className="skeleton line w-70" />
                  <div className="skeleton line w-40" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : visible.length === 0 ? (
        <div className="splash">
          <h3>{tab === 'watched' ? 'Nothing watched yet' : 'Your disliked list is empty'}</h3>
          <p className="muted">
            {searchInput.trim() !== ''
              ? `No matches for “${searchInput.trim()}”.`
              : tab === 'watched'
                ? 'Mark something as watched from Discover or Recommendations.'
                : 'Items you dislike will show up here.'}
          </p>
        </div>
      ) : (
        <>
          <div className="results-head">
            <p className="count-line muted">{visible.length} titles</p>
          </div>
          <div className="library-grid">
            {visible.map((entry, i) => {
              const item = entry.item
              const busy = isBusy(item.id)
              const href = detailHref(item.id)
              const open = openOnPlainClick(() => onOpenDetail(item))
              return (
                <article
                  key={item.id}
                  className="catalog-card lib-card"
                  data-index={Math.min(i, 8)}
                >
                  <a
                    className="catalog-poster"
                    href={href}
                    onClick={open}
                    aria-label={`Open details for ${item.title}`}
                    title={item.title}
                  >
                    <Poster src={item.posterUrl} title={item.title} />
                  </a>
                  <div className="catalog-body">
                    <div className="catalog-meta">
                      <span className="badge">{kindLabel(item.kind)}</span>
                      {item.year ? <span className="rec-year">{item.year}</span> : null}
                    </div>
                    <h3 className="catalog-title">
                      <a
                        className="catalog-title-link"
                        href={href}
                        onClick={open}
                        aria-label={item.title}
                        title={item.title}
                        data-work-id={item.id}
                      >
                        {item.title}
                      </a>
                    </h3>
                    <RatingBadges
                      ratings={item.ratings}
                      rating={item.rating}
                      ratingSource={item.ratingSource}
                      ratingCount={item.ratingCount}
                    />
                    <p className="card-status">
                      {entry.watched ? 'Watched' : ''}{entry.watched && entry.disliked ? ' • ' : ''}{entry.disliked ? 'Disliked' : ''}
                    </p>
                    <div className="catalog-foot">
                      <button
                        type="button"
                        className="work-btn work-btn-undo"
                        disabled={busy}
                        onClick={() => onUndo(entry, tab)}
                        aria-label={`Undo ${tab === 'watched' ? 'watched' : 'disliked'} status for ${item.title}`}
                      >
                        <UndoIcon size={15} />
                        <span>Undo</span>
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
